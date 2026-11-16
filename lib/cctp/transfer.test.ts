/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  maxUint256,
  numberToHex,
  pad,
  TransactionNotFoundError,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BurnRecordedError, type TransferActivity, type TransferState } from "@/lib/activity";
import { setupStepsOn, type SavedAsset } from "@/lib/assets";
import { ARC_TESTNET, BASE_SEPOLIA, type Chain } from "@/lib/chains";
import type { HeldBurn } from "@/lib/unsaved-transfers";
import { crossChainTokenServiceAbi, CROSS_CHAIN_TRANSFER_TOPIC, MESSAGE_RECEIVED_TOPIC } from "./abis";
import { CROSS_CHAIN_TOKEN_SERVICE, MESSAGE_TRANSMITTER, STANDARD_FINALITY } from "./config";
import { packAddress } from "./encoding";
import {
  decodeSent,
  fakeChains,
  revertWith,
  walletOn,
  type FakeLog,
  type FakeNode,
  type LogFilter,
  type SentTransaction,
} from "./fake-chain";
import { IrisBusyError, type FoundMessage, type Quote } from "./iris";
import type { Route } from "./routes";
import {
  advanceTransfer,
  BurnNotHeldError,
  checkTransfer,
  findLandedBurn,
  isForwardDelivered,
  isForwarding,
  quoteTransfer,
  resumeBlock,
  sendTransfer,
  TransferSentError,
  type DeliveryRecords,
  type SenderTransfer,
  type TransferOrder,
  type TransferRecords,
} from "./transfer";
import { walletFor } from "./wallet";

vi.mock("./wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wallet")>()),
  walletFor: vi.fn(),
}));

const ISSUER: Address = "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c";
const SENDER: Address = "0x3333333333333333333333333333333333333333";
const OTHER_WALLET: Address = "0x4444444444444444444444444444444444444444";
const RECIPIENT: Address = "0x1111111111111111111111111111111111111111";
const OTHER_RECIPIENT: Address = "0x7777777777777777777777777777777777777777";
const ARC_TOKEN: Address = "0x9b2eb67a98df1938fcc91aca53bb1f0d2024eca8";
// An EntryPoint or smart account that calls the service on the sender's behalf.
const SMART_ACCOUNT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
// Not MessageTransmitterV2.
const OTHER_CONTRACT: Address = "0x00000000000000000000000000000000000000aa";
const BASE_TOKEN: Address = "0x5555555555555555555555555555555555555555";
const STRANGER_TOKEN: Address = "0x6666666666666666666666666666666666666666";
const TOKEN_MANAGER: Address = "0xc676DB9cfc032029191cfA076eCEb91EfDD96dDb";
const CROSS_CHAIN_ID: Hex = `0x${"5a".repeat(32)}`;
const APPROVE_HASH: Hash = `0x${"a1".repeat(32)}`;
const BURN_HASH: Hash = `0x${"b1".repeat(32)}`;
const LANDED_HASH: Hash = `0x${"c1".repeat(32)}`;
const SETUP_HASH: Hash = `0x${"d1".repeat(32)}`;

const AMOUNT = BigInt(25_000_000);
const FEE = BigInt("200000000000000000");
const FRESH_FEE = BigInt("230000000000000000");
// Every gas unit costs this in the fake nodes, which have no base fee.
const TIP = BigInt(1_000_000_000);
// Gas the transfer budgets for: Arc's measured crossChainTransfer and approve, and Ethereum
// Sepolia's for Base, which isn't measured.
const ARC_TRANSFER_GAS = BigInt(360_000);
const BASE_TRANSFER_GAS = BigInt(360_000);
const APPROVE_GAS = BigInt(60_000);
const PLENTY = BigInt(10) ** BigInt(24);

const QUOTE: Quote = { signedQuote: "0x0102", feeTotal: FEE, forwarded: true };

function enabledOn(chains: Chain[]) {
  return Object.fromEntries(
    chains.map((chain) => [chain.id, { transactions: setupStepsOn(chain).map(() => SETUP_HASH), sent: null }]),
  );
}

const asset: SavedAsset = {
  type: "community",
  name: "Meme",
  symbol: "MEME",
  description: "A test token",
  decimals: 6,
  id: "7d4c8a52-3f0e-4b1a-9a8e-1c2d3e4f5a6b",
  issuer: ISSUER,
  imageUrl: "https://example.com/meme.png",
  createdAt: new Date("2026-10-21T00:00:00Z"),
  crossChainId: CROSS_CHAIN_ID,
  salt: `0x${"5b".repeat(32)}`,
  setups: enabledOn([ARC_TESTNET, BASE_SEPOLIA]),
  deployments: [
    { chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN },
    { chainId: BASE_SEPOLIA.id, tokenAddress: BASE_TOKEN },
  ],
};

const ARC_TO_BASE: TransferOrder = {
  id: "0f6c1c55-8a0e-4c7b-9d1e-2b3c4d5e6f70",
  assetId: asset.id,
  sender: SENDER,
  recipient: RECIPIENT,
  amount: AMOUNT,
  sourceChainId: ARC_TESTNET.id,
  destinationChainId: BASE_SEPOLIA.id,
};

const BASE_TO_ARC: TransferOrder = { ...ARC_TO_BASE, sourceChainId: BASE_SEPOLIA.id, destinationChainId: ARC_TESTNET.id };

// What one chain's contracts answer. Each test changes what its rule needs.
type Contracts = {
  token: Address;
  registeredToken: Address;
  trusts: boolean;
  balance: bigint;
  allowance: bigint;
  maxTransferAmount: bigint;
  rateLimit: bigint;
  // MessageTransmitterV2: 1 once the transfer's nonce is delivered, and what receiveMessage's
  // simulation does.
  usedNonce: bigint;
  receiveRevert: Error | null;
  // What crossChainTransfer's simulation does.
  burnRevert: Error | null;
};

function contractsFor(token: Address): Contracts {
  return {
    token,
    registeredToken: token,
    trusts: true,
    balance: AMOUNT,
    allowance: BigInt(0),
    maxTransferAmount: maxUint256,
    rateLimit: BigInt(10) ** BigInt(12),
    usedNonce: BigInt(0),
    receiveRevert: null,
    burnRevert: null,
  };
}

function serve(node: FakeNode, contracts: Contracts) {
  node.read.mockImplementation((call) => {
    switch (call.functionName) {
      case "isTrustedDomain":
        return contracts.trusts;
      case "resolveTokenManager":
        return TOKEN_MANAGER;
      case "resolveTokenAddress":
        return contracts.registeredToken;
      case "balanceOf":
        return contracts.balance;
      case "allowance":
        return contracts.allowance;
      case "maxTransferAmount":
        return contracts.maxTransferAmount;
      case "rateLimit":
        return contracts.rateLimit;
      case "approve":
        return true;
      case "crossChainTransfer":
        if (contracts.burnRevert) throw contracts.burnRevert;
        return undefined;
      case "usedNonces":
        return contracts.usedNonce;
      case "receiveMessage":
        if (contracts.receiveRevert) throw contracts.receiveRevert;
        return true;
      default:
        throw new Error(`Unexpected read ${call.functionName}`);
    }
  });
}

// Stands in for Supabase and localStorage: the transfer's row, if saved, its held burn, and the
// sender's other transfers of the asset.
function memoryRecords(order: TransferOrder, initial: TransferActivity | null = null, others: SenderTransfer[] = []) {
  let saved = initial;
  let held: HeldBurn | null = null;
  const records = {
    current: () => saved,
    fetchSaved: vi.fn(async () => saved),
    fetchSenderTransfers: vi.fn(async () => (saved ? [saved, ...others] : others)),
    // Like start_transfer: an existing row is left as it is, fee and all.
    saveNew: vi.fn(async (crossChainFee: bigint) => {
      saved ??= {
        ...order,
        kind: "transfer",
        crossChainFee,
        state: "approval-required",
        createdAt: new Date(),
        sourceTransactionHash: null,
        destinationTransactionHash: null,
      };
    }),
    // Like the progress trigger: the fee only changes before the burn is saved.
    saveFee: vi.fn(async (crossChainFee: bigint) => {
      if (saved?.state !== "approval-required") throw new Error("The fee can only change before the burn");
      saved = { ...saved, crossChainFee };
    }),
    saveSubmitted: vi.fn(async (sourceTransactionHash: Hash) => {
      if (!saved) throw new Error("Only the sender can update the transfer");
      saved = { ...saved, state: "source-submitted", sourceTransactionHash };
    }),
    unsaved: {
      read: () => held,
      write: vi.fn((burn: HeldBurn) => {
        held = burn;
      }),
      clear: () => {
        held = null;
      },
    },
  } satisfies TransferRecords & { current: () => TransferActivity | null };
  return records;
}

function savedRow(order: TransferOrder, createdAt = new Date("2026-10-27T12:00:00Z")): TransferActivity {
  return {
    ...order,
    kind: "transfer",
    crossChainFee: FEE,
    state: "approval-required",
    createdAt,
    sourceTransactionHash: null,
    destinationTransactionHash: null,
  };
}

// The service's transfer event, shaped as finding 6 measured it, and the crossChainTransfer
// call that emitted it.
function burnLog(
  transactionHash: Hash,
  amount: bigint,
  sender: Address = SENDER,
  domain = BASE_SEPOLIA.cctpDomain,
  recipient: Address = RECIPIENT,
): FakeLog {
  const words = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [BigInt(0x80), amount, BigInt(0), BigInt(0), BigInt(20)],
  );
  const data = encodeFunctionData({
    abi: crossChainTokenServiceAbi,
    functionName: "crossChainTransfer",
    args: [
      CROSS_CHAIN_ID,
      amount,
      domain,
      packAddress(recipient),
      zeroHash,
      STANDARD_FINALITY,
      { signedQuote: QUOTE.signedQuote, refundAddress: sender },
      false,
      "0x",
    ],
  });
  return {
    transactionHash,
    topics: [
      CROSS_CHAIN_TRANSFER_TOPIC,
      CROSS_CHAIN_ID,
      pad(sender, { size: 32 }),
      pad(`0x${domain.toString(16)}`, { size: 32 }),
    ],
    data: concat([words, pad(recipient, { dir: "right", size: 32 })]),
    transaction: { from: sender, to: CROSS_CHAIN_TOKEN_SERVICE, data },
  };
}

// The same burn, sent through a smart account, an EntryPoint or a 7702 wallet: the transaction
// goes to another contract, so only the event says who it mints to.
function throughSmartAccount(transactionHash: Hash, recipient: Address): FakeLog {
  return {
    ...burnLog(transactionHash, AMOUNT, SENDER, BASE_SEPOLIA.cctpDomain, recipient),
    transaction: { from: OTHER_WALLET, to: SMART_ACCOUNT, data: "0x1fad948c" },
  };
}

function burnsSent(node: FakeNode) {
  return node.sent.filter((transaction) => decodeSent(transaction).functionName === "crossChainTransfer");
}

// A second transfer with the same parameters as ARC_TO_BASE, saved after it.
const LATER_ID = "5e8a2b1c-7d4f-4e3a-8b2c-9d0e1f2a3b4c";
const LATER_BURN: Hash = `0x${"b2".repeat(32)}`;
// savedRow's default time: the row that's resumed was saved then.
const SAVED_SECONDS = Date.parse("2026-10-27T12:00:00Z") / 1000;
const SAVED_BLOCK = 5_300;

// Block n landed 2n seconds after block 0, and the resumed row was saved at SAVED_BLOCK's time.
function twoSecondBlocks(node: FakeNode) {
  node.blockNumber = BigInt(25_000);
  node.timestampOf.mockImplementation((block) => BigInt(SAVED_SECONDS) + BigInt(2) * (block - BigInt(SAVED_BLOCK)));
}

function savedAtBlock(block: number) {
  return new Date((SAVED_SECONDS + 2 * (block - SAVED_BLOCK)) * 1000);
}

// The source's burn events, each in its block: a filter sees those in its range. Each goes to
// RECIPIENT unless a recipient is given.
function burnsAt(node: FakeNode, burns: ([Hash, number] | [Hash, number, Address])[]) {
  node.logs.mockImplementation((filter) =>
    burns
      .filter(([, block]) => BigInt(block) >= filter.fromBlock && BigInt(block) <= filter.toBlock)
      .map(([transactionHash, , recipient]) => burnLog(transactionHash, AMOUNT, SENDER, BASE_SEPOLIA.cctpDomain, recipient)),
  );
}

let arc: FakeNode;
let base: FakeNode;
let wagmiConfig: ReturnType<typeof fakeChains>["wagmiConfig"];
let arcContracts: Contracts;
let baseContracts: Contracts;
let iris: { quote: ReturnType<typeof vi.fn<() => Promise<Quote>>> };

beforeEach(() => {
  vi.clearAllMocks();
  ({ arc, base, wagmiConfig } = fakeChains());
  arcContracts = contractsFor(ARC_TOKEN);
  baseContracts = contractsFor(BASE_TOKEN);
  for (const [node, contracts] of [[arc, arcContracts], [base, baseContracts]] as const) {
    serve(node, contracts);
    node.tip = TIP;
    node.nativeBalance = PLENTY;
    node.nextHash.mockReturnValueOnce(APPROVE_HASH).mockReturnValue(BURN_HASH);
  }
  iris = { quote: vi.fn(async () => QUOTE) };
  vi.mocked(walletFor).mockImplementation(async (_config, chain) => walletOn(chain.id === BASE_SEPOLIA.id ? base : arc, SENDER));
});

describe("checkTransfer", () => {
  // Every rule is checked before the wallet is asked to sign anything.
  async function expectRefused(order: TransferOrder, message: string | RegExp, checkedAsset = asset) {
    const records = memoryRecords(order);
    await expect(sendTransfer(order, checkedAsset, wagmiConfig, iris, records)).rejects.toThrow(message);
    expect(arc.sent).toHaveLength(0);
    expect(base.sent).toHaveLength(0);
    expect(records.saveNew).not.toHaveBeenCalled();
  }

  it("refuses a pair of networks that isn't a route", async () => {
    await expectRefused({ ...ARC_TO_BASE, destinationChainId: ARC_TESTNET.id }, "Transfers from Arc Testnet to Arc Testnet aren't supported");
  });

  it("refuses a network the asset isn't set up on", async () => {
    const arcOnly = { ...asset, setups: enabledOn([ARC_TESTNET]) };
    await expectRefused(ARC_TO_BASE, "MEME isn't set up on Base Sepolia yet", arcOnly);
  });

  it("refuses when the source doesn't trust the destination", async () => {
    arcContracts.trusts = false;
    await expectRefused(ARC_TO_BASE, "CCTP on Arc Testnet doesn't accept transfers to Base Sepolia");
  });

  it("refuses when the destination doesn't trust the source", async () => {
    baseContracts.trusts = false;
    await expectRefused(ARC_TO_BASE, "CCTP on Base Sepolia doesn't accept transfers from Arc Testnet");
  });

  it("refuses when the source's registered token isn't the saved one", async () => {
    arcContracts.registeredToken = STRANGER_TOKEN;
    await expectRefused(ARC_TO_BASE, /registered to another token on Arc Testnet/);
  });

  it("refuses when the destination's registered token isn't the saved one, so nothing mints into it", async () => {
    baseContracts.registeredToken = STRANGER_TOKEN;
    await expectRefused(ARC_TO_BASE, /registered to another token on Base Sepolia/);
  });

  it("refuses an amount above the sender's balance", async () => {
    arcContracts.balance = AMOUNT - BigInt(1);
    await expectRefused(ARC_TO_BASE, "You hold 24.999999 MEME on Arc Testnet, less than 25 MEME");
  });

  it("refuses an amount above the TokenManager's cap", async () => {
    arcContracts.maxTransferAmount = AMOUNT - BigInt(1);
    await expectRefused(ARC_TO_BASE, "MEME caps a single transfer from Arc Testnet at 24.999999 MEME");
  });

  it("refuses when the destination's cap is below the amount, since the mint would fail", async () => {
    baseContracts.maxTransferAmount = AMOUNT - BigInt(1);
    await expectRefused(ARC_TO_BASE, "MEME caps a single transfer to Base Sepolia at 24.999999 MEME");
  });

  it("refuses when a rate limit is zero", async () => {
    baseContracts.rateLimit = BigInt(0);
    await expectRefused(ARC_TO_BASE, "MEME transfers are paused on Base Sepolia");
  });

  it("refuses when Arc's gas token can't cover the fee and gas, and links the faucet", async () => {
    arc.nativeBalance = FEE + (APPROVE_GAS + ARC_TRANSFER_GAS) * TIP - BigInt(1);
    await expectRefused(ARC_TO_BASE, /USDC on Arc Testnet.*https:\/\/faucet\.circle\.com/);
  });

  it("names ETH and Base's faucet for a transfer from Base", async () => {
    base.nativeBalance = BigInt(0);
    await expectRefused(BASE_TO_ARC, /ETH on Base Sepolia.*https:\/\/docs\.base\.org\/base-chain\/tools\/network-faucets/);
  });

  it("refuses a wallet that isn't the sender before it signs anything", async () => {
    vi.mocked(walletFor).mockResolvedValue(walletOn(arc, OTHER_WALLET));
    await expectRefused(ARC_TO_BASE, `Switch your wallet to ${SENDER}`);
  });

  it("passes with exactly enough gas token for the fee and gas", async () => {
    arc.nativeBalance = FEE + (APPROVE_GAS + ARC_TRANSFER_GAS) * TIP;
    await expect(checkTransfer(ARC_TO_BASE, asset, wagmiConfig, iris)).resolves.toMatchObject({ needsApproval: true });
  });
});

describe("quoteTransfer", () => {
  it("is Circle's fee and the gas for an approve and the burn, at the max fee", async () => {
    const route = { source: ARC_TESTNET, destination: BASE_SEPOLIA };
    await expect(quoteTransfer(asset, route, SENDER, RECIPIENT, AMOUNT, wagmiConfig, iris)).resolves.toEqual({
      crossChainFee: FEE,
      gas: (APPROVE_GAS + ARC_TRANSFER_GAS) * TIP,
      needsApproval: true,
      forwarded: true,
    });
    expect(iris.quote).toHaveBeenCalledWith({
      crossChainId: CROSS_CHAIN_ID,
      source: ARC_TESTNET,
      destination: BASE_SEPOLIA,
      amount: AMOUNT,
      recipient: RECIPIENT,
    });
  });

  it("budgets only the burn when the allowance already covers the amount, at Base's own gas", async () => {
    baseContracts.allowance = AMOUNT;
    const route = { source: BASE_SEPOLIA, destination: ARC_TESTNET };
    await expect(quoteTransfer(asset, route, SENDER, RECIPIENT, AMOUNT, wagmiConfig, iris)).resolves.toMatchObject({
      gas: BASE_TRANSFER_GAS * TIP,
      needsApproval: false,
    });
  });
});

describe("sendTransfer", () => {
  it("doesn't approve when the allowance already covers the amount", async () => {
    arcContracts.allowance = AMOUNT;
    await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, memoryRecords(ARC_TO_BASE));
    expect(arc.sent.map((transaction) => decodeSent(transaction).functionName)).toEqual(["crossChainTransfer"]);
  });

  it("approves the TokenManager for exactly the amount when the allowance is short", async () => {
    arcContracts.allowance = AMOUNT - BigInt(1);
    await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, memoryRecords(ARC_TO_BASE));
    expect(arc.sent[0].to).toBe(ARC_TOKEN);
    expect(decodeSent(arc.sent[0])).toEqual({ functionName: "approve", args: [TOKEN_MANAGER, AMOUNT] });
    expect(arc.sent[1].to).toBe(CROSS_CHAIN_TOKEN_SERVICE);
  });

  // The token's error, as the TokenManager's transferFrom raises it through the service.
  const shortAllowance = () =>
    revertWith(crossChainTokenServiceAbi, "ERC20InsufficientAllowance", [TOKEN_MANAGER, BigInt(0), AMOUNT]);
  const STALE_ALLOWANCE = /Arc Testnet hasn't caught up with your approval yet\. Wait a moment and try again\. Nothing was burned\./;

  it("explains a burn simulated before the node saw the approve, and burns nothing", async () => {
    arcContracts.allowance = AMOUNT - BigInt(1);
    arcContracts.burnRevert = shortAllowance();
    const records = memoryRecords(ARC_TO_BASE);
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(STALE_ALLOWANCE);
    expect(arc.sent.map((transaction) => decodeSent(transaction).functionName)).toEqual(["approve"]);
    expect(records.current()?.state).toBe("approval-required");
    expect(records.unsaved.read()).toBeNull();
  });

  // As in a testnet round trip: the simulation passed, and the gas estimate before signing didn't.
  it("explains a burn whose gas estimate ran before the node saw the approve, and burns nothing", async () => {
    arcContracts.allowance = AMOUNT - BigInt(1);
    arc.estimate.mockImplementation((to) => {
      if (to === CROSS_CHAIN_TOKEN_SERVICE) throw shortAllowance();
    });
    const records = memoryRecords(ARC_TO_BASE);
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(STALE_ALLOWANCE);
    expect(arc.sent.map((transaction) => decodeSent(transaction).functionName)).toEqual(["approve"]);
  });

  it("burns on the retry without approving again once the node has caught up", async () => {
    arcContracts.allowance = AMOUNT - BigInt(1);
    arcContracts.burnRevert = shortAllowance();
    const records = memoryRecords(ARC_TO_BASE);
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(STALE_ALLOWANCE);
    // The approve has landed and the node now reads it.
    arcContracts.allowance = AMOUNT;
    arcContracts.burnRevert = null;
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
    expect(arc.sent.map((transaction) => decodeSent(transaction).functionName)).toEqual(["approve", "crossChainTransfer"]);
    expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: BURN_HASH });
  });

  it("keeps any other burn revert as it is", async () => {
    arcContracts.allowance = AMOUNT;
    arcContracts.burnRevert = revertWith(crossChainTokenServiceAbi, "TokenNotRegistered", [CROSS_CHAIN_ID]);
    const sent = sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, memoryRecords(ARC_TO_BASE));
    await expect(sent).rejects.toThrow(/TokenNotRegistered/);
    await expect(sent).rejects.not.toThrow(STALE_ALLOWANCE);
  });

  it("burns with the recipient's 20 bytes, the destination's domain, standard finality and Circle's fee", async () => {
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, memoryRecords(ARC_TO_BASE))).resolves.toBe(BURN_HASH);
    const [burn] = burnsSent(arc);
    expect(burn.from).toBe(SENDER);
    expect(burn.to).toBe(CROSS_CHAIN_TOKEN_SERVICE);
    expect(burn.value).toBe(FEE);
    expect(decodeSent(burn).args).toEqual([
      CROSS_CHAIN_ID,
      AMOUNT,
      BASE_SEPOLIA.cctpDomain,
      packAddress(RECIPIENT).toLowerCase(),
      zeroHash,
      2000,
      { signedQuote: QUOTE.signedQuote, refundAddress: SENDER },
      false,
      "0x",
    ]);
  });

  it("saves the row with a fresh quote's fee after approving, and before the burn is signed", async () => {
    iris.quote.mockResolvedValueOnce(QUOTE).mockResolvedValue({ ...QUOTE, feeTotal: FRESH_FEE });
    const records = memoryRecords(ARC_TO_BASE);
    const sentWhenSaved: string[][] = [];
    const saveRow = records.saveNew.getMockImplementation();
    records.saveNew.mockImplementationOnce(async (crossChainFee: bigint) => {
      sentWhenSaved.push(arc.sent.map((transaction) => decodeSent(transaction).functionName));
      await saveRow?.(crossChainFee);
    });
    await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records);
    expect(sentWhenSaved).toEqual([["approve"]]);
    expect(iris.quote).toHaveBeenCalledTimes(2);
    expect(records.saveNew).toHaveBeenCalledWith(FRESH_FEE);
  });

  it("pays the fresh quote's fee as the burn's value", async () => {
    iris.quote.mockResolvedValueOnce(QUOTE).mockResolvedValue({ ...QUOTE, feeTotal: FRESH_FEE });
    await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, memoryRecords(ARC_TO_BASE));
    expect(burnsSent(arc)[0].value).toBe(FRESH_FEE);
  });

  it("saves the burn as source-submitted and lets go of the held hash", async () => {
    const records = memoryRecords(ARC_TO_BASE);
    await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records);
    expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: BURN_HASH, crossChainFee: FEE });
    expect(records.unsaved.read()).toBeNull();
  });

  it("signs a Base to Arc transfer on Base, paying the fee in Base's ETH", async () => {
    arc.nativeBalance = BigInt(0);
    await sendTransfer(BASE_TO_ARC, asset, wagmiConfig, iris, memoryRecords(BASE_TO_ARC));
    expect(walletFor).toHaveBeenCalledWith(wagmiConfig, BASE_SEPOLIA);
    expect(walletFor).not.toHaveBeenCalledWith(wagmiConfig, ARC_TESTNET);
    expect(arc.sent).toHaveLength(0);
    const [burn] = burnsSent(base);
    expect(burn.value).toBe(FEE);
    expect(decodeSent(burn).args[2]).toBe(ARC_TESTNET.cctpDomain);
    expect(base.sent[0].to).toBe(BASE_TOKEN);
  });

  it("stops at a busy Iris with no burn and no row", async () => {
    iris.quote.mockRejectedValue(new IrisBusyError(null));
    const records = memoryRecords(ARC_TO_BASE);
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(IrisBusyError);
    expect(burnsSent(arc)).toHaveLength(0);
    expect(records.saveNew).not.toHaveBeenCalled();
  });

  it("saves a held burn on retry, without sending it again, when saving failed", async () => {
    const records = memoryRecords(ARC_TO_BASE);
    records.saveSubmitted.mockRejectedValueOnce(new Error("Supabase is down"));
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(TransferSentError);
    expect(records.unsaved.read()).toEqual({ transactionHash: BURN_HASH, source: "wallet" });
    expect(records.current()?.state).toBe("approval-required");

    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
    expect(burnsSent(arc)).toHaveLength(1);
    expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: BURN_HASH });
    expect(records.unsaved.read()).toBeNull();
  });

  it("keeps its own burn held and never burns again when another transfer already recorded that burn", async () => {
    const records = memoryRecords(ARC_TO_BASE);
    records.saveSubmitted.mockRejectedValue(new BurnRecordedError(new Error("23505")));
    const recorded = /This transfer's burn is already recorded by another transfer, so it won't be sent again/;
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(recorded);
    expect(records.unsaved.read()).toEqual({ transactionHash: BURN_HASH, source: "wallet" });

    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(recorded);
    expect(burnsSent(arc)).toHaveLength(1);
    expect(records.unsaved.read()).toEqual({ transactionHash: BURN_HASH, source: "wallet" });
    expect(records.current()?.state).toBe("approval-required");
  });

  describe("when this browser can't hold the burn", () => {
    const storageFull = new DOMException("The quota has been exceeded.", "QuotaExceededError");

    it("still saves the wallet's burn, and goes on", async () => {
      const records = memoryRecords(ARC_TO_BASE);
      records.unsaved.write.mockImplementation(() => {
        throw storageFull;
      });
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      expect(burnsSent(arc)).toHaveLength(1);
      expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: BURN_HASH });
    });

    it("throws with the hash and both causes when saving fails too, never sending again", async () => {
      const records = memoryRecords(ARC_TO_BASE);
      records.unsaved.write.mockImplementation(() => {
        throw storageFull;
      });
      const down = new Error("Supabase is down");
      records.saveSubmitted.mockRejectedValueOnce(down);
      const failure = await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BurnNotHeldError);
      expect(failure).toHaveProperty("message", expect.stringContaining(BURN_HASH));
      expect(failure).toHaveProperty("message", expect.stringContaining("Don't start a new transfer"));
      expect(failure).toHaveProperty("cause", expect.objectContaining({ errors: [storageFull, down] }));
      expect(burnsSent(arc)).toHaveLength(1);
      expect(records.current()?.state).toBe("approval-required");
    });

    it("tells the sender not to retry when another transfer recorded the wallet's burn", async () => {
      const records = memoryRecords(ARC_TO_BASE);
      records.unsaved.write.mockImplementation(() => {
        throw storageFull;
      });
      records.saveSubmitted.mockRejectedValue(new BurnRecordedError(new Error("23505")));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(
        /another transfer already recorded it. Don't retry this transfer/,
      );
      expect(burnsSent(arc)).toHaveLength(1);
    });
  });

  it("finds a burn the wallet sent but didn't return, when the same transfer is retried", async () => {
    arcContracts.allowance = AMOUNT;
    arc.nextHash.mockReset().mockImplementation(() => {
      throw new Error("The wallet disconnected");
    });
    const records = memoryRecords(ARC_TO_BASE);
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow();
    expect(burnsSent(arc)).toHaveLength(1);
    expect(records.current()?.state).toBe("approval-required");

    arc.logs.mockReturnValue([burnLog(LANDED_HASH, AMOUNT)]);
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LANDED_HASH);
    expect(burnsSent(arc)).toHaveLength(1);
    expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: LANDED_HASH });
  });

  it("doesn't send again for a transfer already saved as submitted", async () => {
    const records = memoryRecords(ARC_TO_BASE, { ...savedRow(ARC_TO_BASE), state: "source-submitted", sourceTransactionHash: LANDED_HASH });
    await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LANDED_HASH);
    expect(arc.sent).toHaveLength(0);
    expect(records.saveSubmitted).not.toHaveBeenCalled();
  });

  describe("resuming a row in approval-required", () => {
    it("saves a burn held locally, with zero burns sent", async () => {
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      records.unsaved.write({ transactionHash: LANDED_HASH, source: "wallet" });
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LANDED_HASH);
      expect(arc.sent).toHaveLength(0);
      expect(iris.quote).not.toHaveBeenCalled();
      expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: LANDED_HASH });
    });

    it("saves a burn that landed with no record, found onchain, with zero burns sent", async () => {
      arc.logs.mockReturnValue([burnLog(LANDED_HASH, AMOUNT)]);
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LANDED_HASH);
      expect(arc.sent).toHaveLength(0);
      expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: LANDED_HASH });
    });

    it("saves a burn sent through a smart account, read from its event, with zero burns sent", async () => {
      arc.logs.mockReturnValue([throughSmartAccount(LANDED_HASH, RECIPIENT)]);
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LANDED_HASH);
      expect(arc.sent).toHaveLength(0);
      expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: LANDED_HASH });
    });

    it("burns its own when the only smart-account burn found mints to another recipient", async () => {
      arc.logs.mockReturnValue([throughSmartAccount(LATER_BURN, OTHER_RECIPIENT)]);
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      expect(burnsSent(arc)).toHaveLength(1);
    });

    it("keeps a found burn held when saving it fails, and saves it on retry even if the search then misses it", async () => {
      arc.logs.mockReturnValueOnce([burnLog(LANDED_HASH, AMOUNT)]).mockReturnValue([]);
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      records.saveSubmitted.mockRejectedValueOnce(new Error("Supabase is down"));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(TransferSentError);
      expect(records.unsaved.read()).toEqual({ transactionHash: LANDED_HASH, source: "search" });

      // A stale node: the retry's search would find nothing, so only the held copy stops a second burn.
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LANDED_HASH);
      expect(arc.sent).toHaveLength(0);
      expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: LANDED_HASH });
      expect(records.unsaved.read()).toBeNull();
    });

    it("checks, quotes and burns again when no burn landed", async () => {
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      expect(burnsSent(arc)).toHaveLength(1);
      expect(iris.quote).toHaveBeenCalled();
    });

    it("saves the fresh quote's fee, the one the burn pays, over the fee saved before", async () => {
      iris.quote.mockResolvedValue({ ...QUOTE, feeTotal: FRESH_FEE });
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records);
      const [burn] = burnsSent(arc);
      expect(burn.value).toBe(FRESH_FEE);
      expect(records.current()?.crossChainFee).toBe(burn.value);
      expect(records.saveNew).not.toHaveBeenCalled();
    });

    it("searches again right before burning, and saves a burn that landed during the checks", async () => {
      // The first search finds nothing. By the time the approve lands, the earlier burn has.
      arc.logs.mockReturnValueOnce([]).mockReturnValue([burnLog(LANDED_HASH, AMOUNT)]);
      iris.quote.mockResolvedValue({ ...QUOTE, feeTotal: FRESH_FEE });
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LANDED_HASH);
      expect(burnsSent(arc)).toHaveLength(0);
      // The landed burn paid the fee saved with it, so that fee stays.
      expect(records.current()).toMatchObject({ state: "source-submitted", sourceTransactionHash: LANDED_HASH, crossChainFee: FEE });
    });

    it("searches again right before burning only from Arc's lag margin before where the first search ended", async () => {
      twoSecondBlocks(arc);
      const filters: LogFilter[] = [];
      arc.logs.mockImplementation((filter) => {
        filters.push(filter);
        return [];
      });
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      // From block 5,000 (the row's, less the skew) to 25,000 in three windows, then Arc's newest
      // 256 blocks again, in case its logs index trailed the block number.
      expect(filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([
        [BigInt(5_000), BigInt(14_999)],
        [BigInt(15_000), BigInt(24_999)],
        [BigInt(25_000), BigInt(25_000)],
        [BigInt(24_744), BigInt(25_000)],
      ]);
    });

    it("waits while the sender has a transaction pending, which could be the burn", async () => {
      arc.nonces.pending = arc.nonces.latest + 1;
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(/still pending on Arc Testnet/);
      expect(arc.sent).toHaveLength(0);
    });

    // Within ten minutes (300 blocks) of the later row, a burn could be this one's under clock
    // skew. Saving the later transfer's unsaved burn costs no tokens; burning again would.
    it("saves a later same-parameter transfer's unsaved burn within the skew margin, rather than burn twice", async () => {
      twoSecondBlocks(arc);
      burnsAt(arc, [[LATER_BURN, 12_100]]);
      const later = { id: LATER_ID, createdAt: savedAtBlock(12_000), sourceTransactionHash: null };
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE), [later]);
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(LATER_BURN);
      expect(burnsSent(arc)).toHaveLength(0);
    });

    it("burns its own instead of saving a later same-parameter transfer's burn past the skew margin", async () => {
      twoSecondBlocks(arc);
      burnsAt(arc, [[LATER_BURN, 12_400]]);
      const later = { id: LATER_ID, createdAt: savedAtBlock(12_000), sourceTransactionHash: null };
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE), [later]);
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      expect(burnsSent(arc)).toHaveLength(1);
      expect(records.current()?.sourceTransactionHash).toBe(BURN_HASH);
    });

    it("burns its own instead of saving a burn another transfer already saved", async () => {
      arc.logs.mockReturnValue([burnLog(LANDED_HASH, AMOUNT)]);
      const later = { id: LATER_ID, createdAt: new Date("2026-10-27T12:05:00Z"), sourceTransactionHash: LANDED_HASH };
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE), [later]);
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      expect(burnsSent(arc)).toHaveLength(1);
    });

    it("burns its own instead of saving a later transfer's burn to another recipient within the skew margin", async () => {
      twoSecondBlocks(arc);
      burnsAt(arc, [[LATER_BURN, 12_100, OTHER_RECIPIENT]]);
      const later = { id: LATER_ID, createdAt: savedAtBlock(12_000), sourceTransactionHash: null };
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE), [later]);
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      expect(burnsSent(arc)).toHaveLength(1);
      expect(decodeSent(burnsSent(arc)[0]).args?.[3]).toBe(packAddress(RECIPIENT).toLowerCase());
      expect(records.current()?.sourceTransactionHash).toBe(BURN_HASH);
    });

    it("lets go of a found burn another transfer recorded meanwhile, and burns its own on the next try", async () => {
      arc.logs.mockReturnValue([burnLog(LANDED_HASH, AMOUNT)]);
      const others: SenderTransfer[] = [];
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE), others);
      // The other transfer saves the hash between this one's search and its save.
      records.saveSubmitted.mockImplementationOnce(async () => {
        others.push({ id: LATER_ID, createdAt: new Date("2026-10-27T12:05:00Z"), sourceTransactionHash: LANDED_HASH });
        throw new BurnRecordedError(new Error("23505"));
      });
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow(
        /The burn found for this transfer is already recorded by another transfer\. Try again/,
      );
      expect(records.unsaved.read()).toBeNull();
      expect(arc.sent).toHaveLength(0);

      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).resolves.toBe(BURN_HASH);
      expect(burnsSent(arc)).toHaveLength(1);
      expect(records.current()?.sourceTransactionHash).toBe(BURN_HASH);
    });

    it("sends nothing and changes nothing when the sender's transfers can't be read", async () => {
      arc.logs.mockReturnValue([burnLog(LANDED_HASH, AMOUNT)]);
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      records.fetchSenderTransfers.mockRejectedValue(new Error("Supabase is down"));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow("Supabase is down");
      expect(arc.logs).not.toHaveBeenCalled();
      expect(arc.sent).toHaveLength(0);
      expect(iris.quote).not.toHaveBeenCalled();
      expect(records.saveFee).not.toHaveBeenCalled();
      expect(records.saveSubmitted).not.toHaveBeenCalled();
      expect(records.unsaved.read()).toBeNull();
      expect(records.current()).toEqual(savedRow(ARC_TO_BASE));
    });

    it("doesn't send when the search for a landed burn fails", async () => {
      arc.logs.mockImplementation(() => {
        throw new Error("requested range too large");
      });
      const records = memoryRecords(ARC_TO_BASE, savedRow(ARC_TO_BASE));
      await expect(sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records)).rejects.toThrow();
      expect(arc.sent).toHaveLength(0);
    });
  });
});

describe("resumeBlock", () => {
  it("starts the margin before where the earlier search ended", () => {
    expect(resumeBlock({ from: BigInt(5_000), to: BigInt(25_000) }, BigInt(256))).toBe(BigInt(24_744));
  });

  it("never starts before the earlier search did", () => {
    expect(resumeBlock({ from: BigInt(24_900), to: BigInt(25_000) }, BigInt(256))).toBe(BigInt(24_900));
    expect(resumeBlock({ from: BigInt(150), to: BigInt(150) }, BigInt(16))).toBe(BigInt(150));
  });
});

describe("findLandedBurn", () => {
  // Block n landed 2n seconds after this.
  const GENESIS_SECONDS = 1_000_000;

  beforeEach(() => {
    arc.blockNumber = BigInt(25_000);
    arc.timestampOf.mockImplementation((block) => BigInt(GENESIS_SECONDS) + BigInt(2) * block);
  });

  // Saved at block 5,300's time. The search starts ten minutes (300 blocks) earlier, for clock skew.
  const row = savedRow(ARC_TO_BASE, new Date((GENESIS_SECONDS + 2 * 5_300) * 1000));

  it("finds the sender's burn of this amount to this domain, searching windows from the row's block", async () => {
    const filters: LogFilter[] = [];
    arc.logs.mockImplementation((filter) => {
      filters.push(filter);
      if (filter.fromBlock > BigInt(20_000) || filter.toBlock < BigInt(20_000)) return [];
      return [burnLog(`0x${"e1".repeat(32)}`, AMOUNT + BigInt(1)), burnLog(LANDED_HASH, AMOUNT)];
    });
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBe(LANDED_HASH);
    expect(filters[0].fromBlock).toBe(BigInt(5_000));
    expect(filters.at(-1)?.toBlock).toBeGreaterThanOrEqual(BigInt(20_000));
    for (const filter of filters) {
      expect(filter.address.toLowerCase()).toBe(CROSS_CHAIN_TOKEN_SERVICE.toLowerCase());
      expect(filter.toBlock - filter.fromBlock).toBeLessThanOrEqual(BigInt(9_999));
      expect(filter.topics).toEqual([
        CROSS_CHAIN_TRANSFER_TOPIC,
        CROSS_CHAIN_ID,
        `0x${"0".repeat(24)}${SENDER.slice(2).toLowerCase()}`,
        `0x${"0".repeat(63)}6`,
      ]);
    }
  });

  it("searches up to the latest block and finds nothing when no burn landed", async () => {
    const filters: LogFilter[] = [];
    arc.logs.mockImplementation((filter) => {
      filters.push(filter);
      return [burnLog(LANDED_HASH, AMOUNT - BigInt(1))];
    });
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBeNull();
    expect(filters.at(-1)?.toBlock).toBe(BigInt(25_000));
  });

  it("searches the source chain of a transfer from Base", async () => {
    base.logs.mockReturnValue([burnLog(LANDED_HASH, AMOUNT, SENDER, ARC_TESTNET.cctpDomain)]);
    await expect(findLandedBurn(savedRow(BASE_TO_ARC), asset, wagmiConfig, [])).resolves.toBe(LANDED_HASH);
    expect(base.logs.mock.calls[0][0].topics[3]).toBe(`0x${"0".repeat(62)}1a`);
  });

  it("searches a transfer from Base in windows Base's RPC accepts", async () => {
    twoSecondBlocks(base);
    const filters: LogFilter[] = [];
    base.logs.mockImplementation((filter) => {
      filters.push(filter);
      if (filter.toBlock - filter.fromBlock >= BigInt(1_000)) throw new Error("requested too many blocks");
      if (filter.fromBlock > BigInt(8_000) || filter.toBlock < BigInt(8_000)) return [];
      return [burnLog(LANDED_HASH, AMOUNT, SENDER, ARC_TESTNET.cctpDomain)];
    });
    await expect(findLandedBurn(savedRow(BASE_TO_ARC), asset, wagmiConfig, [])).resolves.toBe(LANDED_HASH);
    expect(filters.length).toBeGreaterThan(1);
  });

  it("throws when the logs can't be read, instead of reporting no burn", async () => {
    arc.logs.mockImplementation(() => {
      throw new Error("fetch failed");
    });
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).rejects.toThrow();
  });

  it("skips a burn to another recipient, and still finds this one's to its recipient", async () => {
    burnsAt(arc, [[LATER_BURN, 6_000, OTHER_RECIPIENT]]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBeNull();
    burnsAt(arc, [[LATER_BURN, 6_000, OTHER_RECIPIENT], [LANDED_HASH, 7_000]]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBe(LANDED_HASH);
  });

  it("reads the recipient from the event when the burn went through a smart account or the calldata can't be read", async () => {
    arc.logs.mockReturnValue([throughSmartAccount(LANDED_HASH, RECIPIENT)]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBe(LANDED_HASH);
    const notATransfer = burnLog(LATER_BURN, AMOUNT);
    arc.logs.mockReturnValue([{ ...notATransfer, transaction: { from: SENDER, to: CROSS_CHAIN_TOKEN_SERVICE, data: "0xdeadbeef" } }]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBe(LATER_BURN);
  });

  it("skips a burn through a smart account whose event names another recipient", async () => {
    arc.logs.mockReturnValue([throughSmartAccount(LATER_BURN, OTHER_RECIPIENT)]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBeNull();
    arc.logs.mockReturnValue([throughSmartAccount(LATER_BURN, OTHER_RECIPIENT), throughSmartAccount(LANDED_HASH, RECIPIENT)]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBe(LANDED_HASH);
  });

  it("trusts the calldata over the event for a burn sent straight to the service", async () => {
    // The call mints to another recipient, whatever the event says.
    const toOther = burnLog(LATER_BURN, AMOUNT, SENDER, BASE_SEPOLIA.cctpDomain, OTHER_RECIPIENT);
    arc.logs.mockReturnValue([{ ...toOther, data: burnLog(LATER_BURN, AMOUNT).data }]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBeNull();
  });

  it("skips a burn through a smart account whose event data has no recipient to read", async () => {
    const burn = throughSmartAccount(LATER_BURN, RECIPIENT);
    // The amount word is there, but the bytes field's offset points past the data.
    arc.logs.mockReturnValue([{ ...burn, data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(0x80), AMOUNT]) }]);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).resolves.toBeNull();
  });

  it("throws when a candidate burn's transaction can't be read, instead of reporting no burn", async () => {
    arc.logs.mockReturnValue([burnLog(LANDED_HASH, AMOUNT)]);
    arc.knows.mockImplementation((hash) => hash !== LANDED_HASH);
    await expect(findLandedBurn(row, asset, wagmiConfig, [row])).rejects.toThrow(TransactionNotFoundError);
  });

  describe("beside a later transfer with the same parameters", () => {
    // Saved at block 12,000's time; its burn landed at 12,100.
    const later = { id: LATER_ID, createdAt: new Date((GENESIS_SECONDS + 2 * 12_000) * 1000), sourceTransactionHash: null };

    it("doesn't take the later transfer's burn, searching only blocks before it was saved", async () => {
      burnsAt(arc, [[LATER_BURN, 12_100]]);
      await expect(findLandedBurn(row, asset, wagmiConfig, [row, later])).resolves.toBeNull();
      expect(arc.logs.mock.calls.at(-1)?.[0].toBlock).toBe(BigInt(11_999));
    });

    it("still finds its own burn, landed before the later transfer was saved", async () => {
      burnsAt(arc, [[LANDED_HASH, 11_999], [LATER_BURN, 12_100]]);
      await expect(findLandedBurn(row, asset, wagmiConfig, [row, later])).resolves.toBe(LANDED_HASH);
    });

    it("skips a burn another transfer saved, and finds its own after it", async () => {
      // The other transfer's saved burn landed first, inside this one's search.
      const saved = { ...later, createdAt: row.createdAt, sourceTransactionHash: LATER_BURN };
      burnsAt(arc, [[LATER_BURN, 6_000]]);
      await expect(findLandedBurn(row, asset, wagmiConfig, [row, saved])).resolves.toBeNull();
      burnsAt(arc, [[LATER_BURN, 6_000], [LANDED_HASH, 7_000]]);
      await expect(findLandedBurn(row, asset, wagmiConfig, [row, saved])).resolves.toBe(LANDED_HASH);
    });
  });
});

describe("advanceTransfer", () => {
  const DELIVERY_HASH: Hash = `0x${"f1".repeat(32)}`;
  const FORWARD_HASH: Hash = `0x${"f2".repeat(32)}`;
  const FOUND_HASH: Hash = `0x${"f3".repeat(32)}`;
  const SPED_UP_HASH: Hash = `0x${"f4".repeat(32)}`;
  const NONCE: Hex = pad("0xabc123", { size: 32 });
  // A MessageV2 burned on Arc: version, source and destination domains, nonce, then the rest.
  const MESSAGE: Hex = concat([
    numberToHex(1, { size: 4 }),
    numberToHex(ARC_TESTNET.cctpDomain, { size: 4 }),
    numberToHex(BASE_SEPOLIA.cctpDomain, { size: 4 }),
    NONCE,
    pad("0x01", { size: 136 }),
  ]);
  const ATTESTATION: Hex = "0xa77e57";
  const ATTESTED: Extract<FoundMessage, { state: "attested" }> = {
    state: "attested",
    message: MESSAGE,
    attestation: ATTESTATION,
    nonce: NONCE,
    forwardHash: null,
    forwarded: false,
    forwardState: null,
  };
  const FORWARDING: FoundMessage = { ...ATTESTED, forwarded: true, forwardState: "PENDING" };
  const FORWARDED: FoundMessage = { ...ATTESTED, forwarded: true, forwardHash: FORWARD_HASH, forwardState: "CONFIRMED" };
  // Fast polling and a short receipt wait, so waiting takes milliseconds.
  const FAST = { pollIntervalMs: 1, receiptTimeoutMs: 50 };
  const BURN_FAILED = "The burn didn't go through. Nothing left your wallet.";

  // The states in the enum's order, like the database. burn-failed only follows source-submitted.
  const ORDER: TransferState[] = [
    "approval-required",
    "source-submitted",
    "awaiting-attestation",
    "delivering",
    "delivery-failed",
    "complete",
  ];

  const ARC_TO_BASE_ROUTE: Route = { source: ARC_TESTNET, destination: BASE_SEPOLIA };

  let findMessage: ReturnType<typeof vi.fn<(route: Route, burnHash: Hash) => Promise<FoundMessage>>>;

  // Stands in for Supabase and localStorage, with the progress trigger's rules.
  function memoryDelivery(initial: TransferActivity, others: SenderTransfer[] = []) {
    let saved = initial;
    let held: Hash | null = null;
    const records = {
      current: () => saved,
      fetchSenderTransfers: vi.fn(async () => [saved, ...others]),
      saveProgress: vi.fn(async (progress: { state: TransferState; destinationTransactionHash?: Hash }) => {
        const from = saved.state;
        const to = progress.state;
        if (from === "complete" || from === "burn-failed") throw new Error(`Transfer is already ${from}`);
        const allowed =
          to === "burn-failed"
            ? from === "source-submitted"
            : ORDER.indexOf(to) >= ORDER.indexOf(from) || (from === "delivery-failed" && to === "delivering");
        if (!allowed) throw new Error(`Transfer can't go from ${from} to ${to}`);
        if (
          saved.destinationTransactionHash &&
          progress.destinationTransactionHash &&
          progress.destinationTransactionHash !== saved.destinationTransactionHash
        ) {
          throw new Error("Transfer already has a destination transaction");
        }
        const destinationTransactionHash = progress.destinationTransactionHash ?? saved.destinationTransactionHash;
        if ((to === "complete") !== (destinationTransactionHash !== null)) {
          throw new Error("Only a complete transfer has a destination transaction");
        }
        saved = { ...saved, state: to, destinationTransactionHash };
      }),
      unsaved: {
        read: () => held,
        write: (transactionHash: Hash) => {
          held = transactionHash;
        },
        clear: () => {
          held = null;
        },
      },
    } satisfies DeliveryRecords & { current: () => TransferActivity };
    return records;
  }

  function row(state: TransferState, sourceTransactionHash: Hash | null = BURN_HASH): TransferActivity {
    return {
      ...savedRow(ARC_TO_BASE),
      state,
      sourceTransactionHash,
      destinationTransactionHash: state === "complete" ? FOUND_HASH : null,
    };
  }

  function advance(records: ReturnType<typeof memoryDelivery>, options: Parameters<typeof advanceTransfer>[5] = FAST) {
    return advanceTransfer(records.current(), asset, wagmiConfig, { findMessage }, records, options);
  }

  function sentNamed(node: FakeNode, functionName: string) {
    return node.sent.filter((transaction) => decodeSent(transaction).functionName === functionName);
  }

  // Never an approve or a burn, on either chain.
  function expectNoApproveOrBurn() {
    for (const node of [arc, base]) {
      expect(sentNamed(node, "approve")).toHaveLength(0);
      expect(sentNamed(node, "crossChainTransfer")).toHaveLength(0);
    }
  }

  // MessageTransmitterV2's MessageReceived, shaped as the testnet round trip saw it: caller, nonce and finality
  // indexed; source domain, sender and the message body in the data.
  function deliveryLog(transactionHash: Hash, nonce: Hex): FakeLog {
    return {
      transactionHash,
      topics: [MESSAGE_RECEIVED_TOPIC, pad(RECIPIENT, { size: 32 }), nonce, pad(numberToHex(STANDARD_FINALITY), { size: 32 })],
      data: encodeAbiParameters(
        [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
        [ARC_TESTNET.cctpDomain, pad(CROSS_CHAIN_TOKEN_SERVICE, { size: 32 }), "0x01"],
      ),
    };
  }

  // Sends the burn for real through the fake wallet, so the source node can replace it.
  async function sentBurn() {
    arcContracts.allowance = AMOUNT;
    const records = memoryRecords(ARC_TO_BASE);
    await sendTransfer(ARC_TO_BASE, asset, wagmiConfig, iris, records);
    const saved = records.current();
    if (!saved) throw new Error("The burn wasn't saved");
    return memoryDelivery(saved);
  }

  beforeEach(() => {
    findMessage = vi.fn(async () => ATTESTED);
    base.nextHash.mockReset().mockReturnValue(DELIVERY_HASH);
  });

  it("throws without a source transaction, and sends nothing", async () => {
    const records = memoryDelivery(row("approval-required", null));
    await expect(advance(records)).rejects.toThrow(/no burn/);
    expect(arc.sent).toHaveLength(0);
    expect(base.sent).toHaveLength(0);
    expect(records.saveProgress).not.toHaveBeenCalled();
  });

  it.each<TransferState>([
    "source-submitted",
    "awaiting-attestation",
    "delivering",
    "delivery-failed",
    "complete",
    "burn-failed",
  ])("never approves or burns from %s", async (state) => {
    const records = memoryDelivery(row(state));
    await expect(advance(records)).resolves.toBe(state === "burn-failed" ? "burn-failed" : "complete");
    expectNoApproveOrBurn();
  });

  it("never approves or burns while delivery fails, the burn fails, or the nonce is used", async () => {
    baseContracts.receiveRevert = revertWith(
      [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      "Error",
      ["Rate limit exceeded"],
    );
    const failing = memoryDelivery(row("delivering"));
    await expect(advance(failing)).rejects.toThrow(/rate limit/i);
    expect(failing.current().state).toBe("delivery-failed");
    baseContracts.receiveRevert = null;
    baseContracts.usedNonce = BigInt(1);
    findMessage.mockResolvedValue(FORWARDED);
    await expect(advance(memoryDelivery(row("delivery-failed")))).resolves.toBe("complete");
    arc.receipt.status = "reverted";
    const burnFailing = memoryDelivery(row("source-submitted"));
    await expect(advance(burnFailing)).rejects.toThrow(BURN_FAILED);
    expect(burnFailing.current().state).toBe("burn-failed");
    expectNoApproveOrBurn();
  });

  it("tracks a burn to delivery, sending one receiveMessage on the destination as the sender", async () => {
    const records = memoryDelivery(row("source-submitted"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(records.saveProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { state: "awaiting-attestation" },
      { state: "delivering" },
      { state: "complete", destinationTransactionHash: DELIVERY_HASH },
    ]);
    expect(findMessage).toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, BURN_HASH);
    expect(walletFor).toHaveBeenCalledWith(wagmiConfig, BASE_SEPOLIA);
    const [delivery] = sentNamed(base, "receiveMessage");
    expect(base.sent).toHaveLength(1);
    expect(delivery.from).toBe(SENDER);
    expect(delivery.to?.toLowerCase()).toBe(MESSAGE_TRANSMITTER.toLowerCase());
    expect(decodeSent(delivery).args).toEqual([MESSAGE, ATTESTATION]);
    expect(records.unsaved.read()).toBeNull();
  });

  it("keeps polling while the attestation is pending, without failing the transfer", async () => {
    findMessage.mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "pending" });
    const records = memoryDelivery(row("awaiting-attestation"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(findMessage).toHaveBeenCalledTimes(3);
    expect(records.saveProgress).not.toHaveBeenCalledWith({ state: "delivery-failed" });
  });

  it("stops with Iris's error and leaves the transfer where it was, so it can resume", async () => {
    findMessage.mockRejectedValue(new Error("Couldn't reach Circle's attestation service"));
    const records = memoryDelivery(row("awaiting-attestation"));
    await expect(advance(records)).rejects.toThrow("Couldn't reach Circle's attestation service");
    expect(records.current().state).toBe("awaiting-attestation");
    expect(base.sent).toHaveLength(0);
  });

  it("completes with the forward hash and zero sends when the nonce is already used", async () => {
    baseContracts.usedNonce = BigInt(1);
    findMessage.mockResolvedValue(FORWARDED);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(base.sent).toHaveLength(0);
    expect(records.current()).toMatchObject({ state: "complete", destinationTransactionHash: FORWARD_HASH });
  });

  it("finds the delivery in the destination's logs by its nonce when the nonce is used and no hash is known", async () => {
    baseContracts.usedNonce = BigInt(1);
    base.blockNumber = BigInt(25_000);
    const filters: LogFilter[] = [];
    base.logs.mockImplementation((filter) => {
      filters.push(filter);
      if (filter.fromBlock > BigInt(20_000) || filter.toBlock < BigInt(20_000)) return [];
      // Another message's delivery, of the same amount to the same recipient, comes first.
      return [deliveryLog(`0x${"e1".repeat(32)}`, pad("0xdef456", { size: 32 })), deliveryLog(FOUND_HASH, NONCE)];
    });
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(base.sent).toHaveLength(0);
    expect(records.current()).toMatchObject({ state: "complete", destinationTransactionHash: FOUND_HASH });
    // Base's public RPC is held to 1,000-block windows, unlike Arc's 10,000.
    expect(filters.length).toBeGreaterThan(1);
    for (const filter of filters) {
      expect(filter.address.toLowerCase()).toBe(MESSAGE_TRANSMITTER.toLowerCase());
      expect(filter.toBlock - filter.fromBlock).toBeLessThanOrEqual(BigInt(999));
      expect(filter.topics).toEqual([MESSAGE_RECEIVED_TOPIC, null, NONCE]);
    }
  });

  it("ignores logs from another contract, another event, or a reorg, even when the RPC returns them unfiltered", async () => {
    baseContracts.usedNonce = BigInt(1);
    const sameNonce = deliveryLog(`0x${"e1".repeat(32)}`, NONCE);
    base.logs.mockReturnValue([
      { ...sameNonce, address: OTHER_CONTRACT },
      { ...sameNonce, topics: [pad("0xbeef", { size: 32 }), ...sameNonce.topics.slice(1)] },
      { ...sameNonce, removed: true },
      deliveryLog(FOUND_HASH, NONCE),
    ]);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(records.current().destinationTransactionHash).toBe(FOUND_HASH);
  });

  it("stays delivering when the only log found is another contract's with the same nonce topic", async () => {
    baseContracts.usedNonce = BigInt(1);
    base.logs.mockReturnValue([{ ...deliveryLog(FOUND_HASH, NONCE), address: OTHER_CONTRACT }]);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).rejects.toThrow(/isn't found yet/);
    expect(records.current().state).toBe("delivering");
    expect(base.sent).toHaveLength(0);
  });

  it("stays delivering when the only delivery found carries another message's nonce", async () => {
    baseContracts.usedNonce = BigInt(1);
    base.logs.mockReturnValue([deliveryLog(FOUND_HASH, pad("0xdef456", { size: 32 }))]);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).rejects.toThrow(/isn't found yet/);
    expect(records.current().state).toBe("delivering");
    expect(base.sent).toHaveLength(0);
  });

  it("stays delivering when the nonce is used but the delivery can't be found yet", async () => {
    baseContracts.usedNonce = BigInt(1);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).rejects.toThrow(/delivered/);
    expect(records.current().state).toBe("delivering");
    expect(base.sent).toHaveLength(0);
  });

  it("goes to delivery-failed with the reason when the destination's rate limit rejects the delivery", async () => {
    baseContracts.receiveRevert = revertWith(
      [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      "Error",
      ["Rate limit exceeded"],
    );
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).rejects.toThrow(/rate limit/i);
    expect(records.current().state).toBe("delivery-failed");
    expect(base.sent).toHaveLength(0);
  });

  it("goes to delivery-failed naming the gas token and faucet when the wallet can't pay destination gas", async () => {
    base.nativeBalance = BigInt(0);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).rejects.toThrow(
      /ETH on Base Sepolia.*https:\/\/docs\.base\.org\/base-chain\/tools\/network-faucets/,
    );
    expect(records.current().state).toBe("delivery-failed");
    expect(base.sent).toHaveLength(0);
  });

  it("completes with zero sends when a retry finds the forwarder already delivered", async () => {
    baseContracts.usedNonce = BigInt(1);
    findMessage.mockResolvedValue(FORWARDED);
    const records = memoryDelivery(row("delivery-failed"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(base.sent).toHaveLength(0);
    expect(records.saveProgress.mock.calls.map(([progress]) => progress.state)).toEqual(["delivering", "complete"]);
    expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
  });

  it("waits for Circle's forwarder before the timeout, and sends nothing when it delivers", async () => {
    findMessage.mockImplementation(async () => {
      // Circle delivers on the third look.
      if (findMessage.mock.calls.length >= 3) {
        baseContracts.usedNonce = BigInt(1);
        return FORWARDED;
      }
      return FORWARDING;
    });
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records, { ...FAST, forwardTimeoutMs: 60_000 })).resolves.toBe("complete");
    expect(base.sent).toHaveLength(0);
    expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
  });

  it("sends exactly one receiveMessage when the forwarder hasn't delivered by the timeout", async () => {
    findMessage.mockResolvedValue(FORWARDING);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records, { ...FAST, forwardTimeoutMs: 20 })).resolves.toBe("complete");
    expect(findMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sentNamed(base, "receiveMessage")).toHaveLength(1);
    expect(records.current().destinationTransactionHash).toBe(DELIVERY_HASH);
  });

  it("saves a held delivery on retry, without sending it again, when saving failed", async () => {
    const records = memoryDelivery(row("delivering"));
    records.saveProgress.mockRejectedValueOnce(new Error("Supabase is down"));
    // The first save is the complete one, after the receiveMessage.
    await expect(advance(records)).rejects.toThrow("Supabase is down");
    expect(records.unsaved.read()).toBe(DELIVERY_HASH);

    baseContracts.usedNonce = BigInt(1);
    await expect(advance(records)).resolves.toBe("complete");
    expect(sentNamed(base, "receiveMessage")).toHaveLength(1);
    expect(records.current().destinationTransactionHash).toBe(DELIVERY_HASH);
    expect(records.unsaved.read()).toBeNull();
  });

  it("goes to delivery-failed after one receiveMessage that reverts onchain, and doesn't send another", async () => {
    base.receipt.status = "reverted";
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).rejects.toThrow(/reverted on Base Sepolia/);
    expect(sentNamed(base, "receiveMessage")).toHaveLength(1);
    expect(records.current().state).toBe("delivery-failed");
    expect(records.unsaved.read()).toBeNull();
  });

  it("completes instead of failing when its receiveMessage reverts because Circle's forwarder used the nonce first", async () => {
    findMessage.mockResolvedValue(FORWARDING);
    base.receipt.status = "reverted";
    // Unused before the send and when the next pass starts. Circle's forward lands while the
    // sender's delivery is waited on, so that one reverts on the used nonce.
    let nonceReads = 0;
    Object.defineProperty(baseContracts, "usedNonce", { get: () => BigInt(++nonceReads > 2 ? 1 : 0) });
    base.logs.mockReturnValue([deliveryLog(FORWARD_HASH, NONCE)]);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records, { ...FAST, forwardTimeoutMs: 0 })).resolves.toBe("complete");
    expect(sentNamed(base, "receiveMessage")).toHaveLength(1);
    expect(records.saveProgress.mock.calls.map(([progress]) => progress.state)).not.toContain("delivery-failed");
    expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
  });

  it("goes to burn-failed when the wallet cancelled the burn, and delivers nothing", async () => {
    const records = await sentBurn();
    arc.replace.mockImplementation((sent: SentTransaction) => ({ hash: SPED_UP_HASH, to: sent.from, data: "0x", value: BigInt(0) }));
    await expect(advance(records)).rejects.toThrow(BURN_FAILED);
    expect(records.current().state).toBe("burn-failed");
    expect(findMessage).not.toHaveBeenCalled();
    expect(base.sent).toHaveLength(0);
    expect(sentNamed(arc, "crossChainTransfer")).toHaveLength(1);
  });

  it("goes to burn-failed when the burn reverted", async () => {
    arc.receipt.status = "reverted";
    const records = memoryDelivery(row("source-submitted"));
    await expect(advance(records)).rejects.toThrow(BURN_FAILED);
    expect(records.current().state).toBe("burn-failed");
    expect(findMessage).not.toHaveBeenCalled();
  });

  it("surfaces an RPC error while waiting for the burn, instead of reading it as unknown", async () => {
    const records = await sentBurn();
    arc.receipt.errorWhilePending = new Error("connection reset");
    // Long enough that a swallowed error would end in the timeout and the log search instead.
    await expect(advance(records, { ...FAST, receiptTimeoutMs: 10_000 })).rejects.toThrow(/connection reset/);
    expect(records.current().state).toBe("source-submitted");
    expect(records.saveProgress).not.toHaveBeenCalled();
    expect(arc.logs).not.toHaveBeenCalled();
    expect(findMessage).not.toHaveBeenCalled();
  });

  it("asks Iris for a sped-up burn by the hash it landed under", async () => {
    const records = await sentBurn();
    expect(burnsSent(arc)[0].value).toBe(FEE);
    arc.replace.mockImplementation((sent: SentTransaction) => ({ hash: SPED_UP_HASH, to: sent.to ?? null, data: sent.data, value: sent.value }));
    await expect(advance(records)).resolves.toBe("complete");
    expect(findMessage).toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, SPED_UP_HASH);
  });

  describe("a burn the source node doesn't know, after it was sped up or cancelled before a reload", () => {
    beforeEach(() => {
      arc.knows.mockImplementation((hash) => hash !== BURN_HASH);
    });

    it("finds the burn that landed in the source's logs and tracks it by that hash", async () => {
      arc.logs.mockReturnValue([burnLog(SPED_UP_HASH, AMOUNT)]);
      const records = memoryDelivery(row("source-submitted"));
      await expect(advance(records)).resolves.toBe("complete");
      expect(findMessage).toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, SPED_UP_HASH);
      expect(findMessage).not.toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, BURN_HASH);
      // The saved hash can't change, so the row keeps the one the wallet first returned.
      expect(records.current()).toMatchObject({ state: "complete", sourceTransactionHash: BURN_HASH });
      expectNoApproveOrBurn();
    });

    it("stops without burn-failed when no burn is found, saying to check the wallet before a new transfer", async () => {
      const records = memoryDelivery(row("source-submitted"));
      await expect(advance(records)).rejects.toThrow(
        /wasn't found on Arc Testnet\. Check your wallet's activity, and start a new transfer only if it shows the burn was cancelled/,
      );
      expect(records.current().state).toBe("source-submitted");
      expect(records.saveProgress).not.toHaveBeenCalled();
      expect(findMessage).not.toHaveBeenCalled();
    });

    it("doesn't take a later same-parameter transfer's burn, and still finds its own", async () => {
      twoSecondBlocks(arc);
      burnsAt(arc, [[LATER_BURN, 12_100]]);
      // The later transfer holds its burn locally, so no row has saved it yet.
      const later = { id: LATER_ID, createdAt: savedAtBlock(12_000), sourceTransactionHash: null };
      const records = memoryDelivery(row("source-submitted"), [later]);
      await expect(advance(records)).rejects.toThrow(/wasn't found on Arc Testnet/);
      expect(records.saveProgress).not.toHaveBeenCalled();
      expect(findMessage).not.toHaveBeenCalled();

      burnsAt(arc, [[SPED_UP_HASH, 8_000], [LATER_BURN, 12_100]]);
      await expect(advance(records)).resolves.toBe("complete");
      expect(findMessage).toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, SPED_UP_HASH);
      expect(findMessage).not.toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, LATER_BURN);
    });

    it("doesn't take a burn to another recipient, and still finds its own", async () => {
      twoSecondBlocks(arc);
      burnsAt(arc, [[LATER_BURN, 8_000, OTHER_RECIPIENT]]);
      const records = memoryDelivery(row("source-submitted"));
      await expect(advance(records)).rejects.toThrow(/wasn't found on Arc Testnet/);
      expect(records.saveProgress).not.toHaveBeenCalled();
      expect(findMessage).not.toHaveBeenCalled();

      burnsAt(arc, [[LATER_BURN, 8_000, OTHER_RECIPIENT], [SPED_UP_HASH, 8_100]]);
      await expect(advance(records)).resolves.toBe("complete");
      expect(findMessage).toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, SPED_UP_HASH);
      expect(findMessage).not.toHaveBeenCalledWith(ARC_TO_BASE_ROUTE, LATER_BURN);
    });

    it("stops with no search, delivery or state change when the sender's transfers can't be read", async () => {
      arc.logs.mockReturnValue([burnLog(SPED_UP_HASH, AMOUNT)]);
      const records = memoryDelivery(row("source-submitted"));
      records.fetchSenderTransfers.mockRejectedValue(new Error("Supabase is down"));
      await expect(advance(records)).rejects.toThrow("Supabase is down");
      expect(arc.logs).not.toHaveBeenCalled();
      expect(findMessage).not.toHaveBeenCalled();
      expect(records.saveProgress).not.toHaveBeenCalled();
      expect(records.current().state).toBe("source-submitted");
      expect(base.sent).toHaveLength(0);
      expectNoApproveOrBurn();
    });

    it("waits while the sender has a transaction pending, which may be the burn", async () => {
      arc.nonces.pending = arc.nonces.latest + 1;
      const records = memoryDelivery(row("source-submitted"));
      await expect(advance(records)).rejects.toThrow(/still pending on Arc Testnet/);
      expect(arc.logs).not.toHaveBeenCalled();
      expect(records.saveProgress).not.toHaveBeenCalled();
    });

    it("goes to burn-failed only when the burn found onchain reverted", async () => {
      arc.logs.mockReturnValue([burnLog(SPED_UP_HASH, AMOUNT)]);
      arc.receipt.status = "reverted";
      const records = memoryDelivery(row("source-submitted"));
      await expect(advance(records)).rejects.toThrow(BURN_FAILED);
      expect(records.current().state).toBe("burn-failed");
    });
  });

  describe("a held delivery the destination node doesn't know", () => {
    function heldUnknown(state: TransferState) {
      const records = memoryDelivery(row(state));
      records.unsaved.write(DELIVERY_HASH);
      base.knows.mockImplementation((hash) => hash !== DELIVERY_HASH);
      return records;
    }

    it("completes with Circle's forward hash when the nonce is used", async () => {
      baseContracts.usedNonce = BigInt(1);
      findMessage.mockResolvedValue(FORWARDED);
      const records = heldUnknown("delivering");
      await expect(advance(records)).resolves.toBe("complete");
      expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
      expect(records.unsaved.read()).toBeNull();
      expect(base.sent).toHaveLength(0);
    });

    it("goes to delivery-failed with the held hash cleared when the nonce is unused", async () => {
      const records = heldUnknown("delivering");
      await expect(advance(records)).rejects.toThrow(/wasn't found on Base Sepolia.*Retry to send it again/);
      expect(records.current().state).toBe("delivery-failed");
      expect(records.unsaved.read()).toBeNull();
      expect(base.sent).toHaveLength(0);
    });

    it("completes instead of failing when the nonce is used while the held delivery is waited on", async () => {
      findMessage.mockResolvedValue(FORWARDED);
      const records = heldUnknown("delivering");
      // Unused at the first check; Circle's forward lands during the wait.
      let nonceChecks = 0;
      base.read.mockImplementation((call) => {
        if (call.functionName !== "usedNonces") throw new Error(`Unexpected read ${call.functionName}`);
        nonceChecks += 1;
        return nonceChecks > 1 ? BigInt(1) : BigInt(0);
      });
      await expect(advance(records)).resolves.toBe("complete");
      expect(records.saveProgress).not.toHaveBeenCalledWith({ state: "delivery-failed" });
      expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
      expect(base.sent).toHaveLength(0);
    });

    it("surfaces a failed receipt read instead of reading it as not landed", async () => {
      baseContracts.usedNonce = BigInt(1);
      findMessage.mockResolvedValue(FORWARDED);
      const records = heldUnknown("delivering");
      base.receipt.error = new Error("connection reset");
      await expect(advance(records)).rejects.toThrow(/connection reset/);
      expect(records.current().state).toBe("delivering");
      expect(records.unsaved.read()).toBe(DELIVERY_HASH);
    });
  });

  it("doesn't trust a forward hash Iris hasn't confirmed and whose receipt reverted, and finds the delivery", async () => {
    baseContracts.usedNonce = BigInt(1);
    base.receipt.status = "reverted";
    findMessage.mockResolvedValue({ ...ATTESTED, forwarded: true, forwardHash: FORWARD_HASH, forwardState: "PENDING" });
    base.logs.mockReturnValue([deliveryLog(FOUND_HASH, NONCE)]);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(records.current().destinationTransactionHash).toBe(FOUND_HASH);
  });

  it("trusts a forward hash Iris calls COMPLETE without reading its receipt", async () => {
    baseContracts.usedNonce = BigInt(1);
    // A reverted receipt would fail the check, so completing with the hash shows none was read.
    base.receipt.status = "reverted";
    findMessage.mockResolvedValue({ ...ATTESTED, forwarded: true, forwardHash: FORWARD_HASH, forwardState: "COMPLETE" });
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
    expect(base.logs).not.toHaveBeenCalled();
  });

  it.each(["CONFIRMED", "SENT"])("checks the receipt of a forward Iris calls %s, which may not have landed", async (forwardState) => {
    baseContracts.usedNonce = BigInt(1);
    base.receipt.status = "reverted";
    findMessage.mockResolvedValue({ ...ATTESTED, forwarded: true, forwardHash: FORWARD_HASH, forwardState });
    base.logs.mockReturnValue([deliveryLog(FOUND_HASH, NONCE)]);
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(records.current().destinationTransactionHash).toBe(FOUND_HASH);
  });

  it("trusts an unconfirmed forward hash whose receipt succeeded", async () => {
    baseContracts.usedNonce = BigInt(1);
    findMessage.mockResolvedValue({ ...ATTESTED, forwarded: true, forwardHash: FORWARD_HASH, forwardState: "PENDING" });
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
    expect(base.logs).not.toHaveBeenCalled();
  });

  it("delivers at once when Circle's forward failed, without waiting out the timeout", async () => {
    findMessage.mockResolvedValue({ ...ATTESTED, forwarded: true, forwardState: "FAILED" });
    const records = memoryDelivery(row("delivering"));
    await expect(advance(records, { ...FAST, forwardTimeoutMs: 60_000 })).resolves.toBe("complete");
    expect(findMessage).toHaveBeenCalledTimes(1);
    expect(sentNamed(base, "receiveMessage")).toHaveLength(1);
  });

  it("delivers at once on a retry from delivery-failed, without waiting for Circle again", async () => {
    findMessage.mockResolvedValue(FORWARDING);
    const records = memoryDelivery(row("delivery-failed"));
    await expect(advance(records, { ...FAST, forwardTimeoutMs: 60_000 })).resolves.toBe("complete");
    expect(findMessage).toHaveBeenCalledTimes(1);
    expect(sentNamed(base, "receiveMessage")).toHaveLength(1);
  });

  it("completes instead of failing when the simulation reverts because Circle just delivered", async () => {
    findMessage.mockResolvedValue(FORWARDED);
    base.read.mockImplementation((call) => {
      if (call.functionName === "usedNonces") return baseContracts.usedNonce;
      if (call.functionName !== "receiveMessage") throw new Error(`Unexpected read ${call.functionName}`);
      // Circle's forward landed between the nonce check and the simulation.
      baseContracts.usedNonce = BigInt(1);
      throw revertWith([{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], "Error", [
        "Nonce already used",
      ]);
    });
    const records = memoryDelivery(row("delivery-failed"));
    await expect(advance(records)).resolves.toBe("complete");
    expect(records.saveProgress).not.toHaveBeenCalledWith({ state: "delivery-failed" });
    expect(records.current().destinationTransactionHash).toBe(FORWARD_HASH);
    expect(base.sent).toHaveLength(0);
  });

  it("does nothing for a transfer that's already complete or whose burn failed", async () => {
    for (const state of ["complete", "burn-failed"] as const) {
      const records = memoryDelivery(row(state));
      await expect(advance(records)).resolves.toBe(state);
      expect(records.saveProgress).not.toHaveBeenCalled();
    }
    expect(findMessage).not.toHaveBeenCalled();
    expect(base.sent).toHaveLength(0);
  });
});

describe("isForwardDelivered", () => {
  it("is delivered when Iris says the forward minted", () => {
    expect(isForwardDelivered("COMPLETE")).toBe(true);
  });

  it("isn't delivered while the forward is pending, sent, confirmed, failed, unknown or unnamed", () => {
    for (const forwardState of ["PENDING", "SENT", "CONFIRMED", "FAILED", "complete", "SOMETHING_NEW", null]) {
      expect(isForwardDelivered(forwardState)).toBe(false);
    }
  });
});

describe("isForwarding", () => {
  it("is Circle's delivery while Circle forwards it", () => {
    expect(isForwarding({ forwarded: true, forwardState: null })).toBe(true);
    expect(isForwarding({ forwarded: true, forwardState: "CONFIRMED" })).toBe(true);
  });

  it("is the sender's delivery when the route didn't forward, or Circle gave up", () => {
    expect(isForwarding({ forwarded: false, forwardState: null })).toBe(false);
    expect(isForwarding({ forwarded: true, forwardState: "FAILED" })).toBe(false);
  });
});
