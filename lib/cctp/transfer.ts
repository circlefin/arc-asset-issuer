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

// Starts a cross-chain transfer: checks, approves the TokenManager, quotes, saves the row, then
// burns. The burn is held in the browser the moment the wallet returns it, and a row left in
// approval-required is searched onchain before anything is sent again, so no burn is sent twice.
// Then tracks the attestation and delivers the mint, which never burns again.

import {
  BaseError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  hexToBigInt,
  isAddressEqual,
  size,
  slice,
  toHex,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { Config } from "wagmi";
import { BURN_FAILED_MESSAGE, BurnRecordedError, type TransferActivity, type TransferState } from "@/lib/activity";
import { isChainEnabled, type SavedAsset } from "@/lib/assets";
import { findChain, type Chain } from "@/lib/chains";
import { formatAssetAmount, formatTokenAmount } from "@/lib/format";
import type { HeldBurn } from "@/lib/unsaved-transfers";
import {
  crossChainTokenServiceAbi,
  CROSS_CHAIN_TRANSFER_TOPIC,
  MESSAGE_RECEIVED_TOPIC,
  messageTransmitterAbi,
  tokenManagerAbi,
} from "./abis";
import { communityTokenAbi } from "./artifacts";
import { blockAtOrBefore, findInWindows } from "./blocks";
import { CROSS_CHAIN_TOKEN_SERVICE, MESSAGE_TRANSMITTER, STANDARD_FINALITY } from "./config";
import { packAddress } from "./encoding";
import { measuredGas } from "./gas";
import type { createIris, FoundMessage, Quote } from "./iris";
import { isRoute, type Route } from "./routes";
import { isRevert, readRateLimit } from "./service";
import { tokenManagerOn, tokenOn } from "./setup";
import { publicFor, ReplacedError, waitForSent, walletFor } from "./wallet";

// The row's time comes from Supabase's clock and blocks carry the chain's, so the search for a
// landed burn starts this much earlier, in case the two disagree.
const CLOCK_SKEW_SECONDS = BigInt(600);

const MILLISECONDS_PER_SECOND = 1000;

// The service event's data: an offset word, then the amount.
const AMOUNT_WORD_START = 32;
const AMOUNT_WORD_END = 64;
// The same data decoded: the mint recipient's bytes, the amount, then two words not yet identified.
const BURN_EVENT_DATA = [{ type: "bytes" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] as const;

export type Iris = Pick<ReturnType<typeof createIris>, "quote">;

// One transfer as the sender asked for it. The ID is made before signing, so a retry is the same transfer.
export type TransferOrder = Pick<
  TransferActivity,
  "id" | "assetId" | "sender" | "recipient" | "amount" | "sourceChainId" | "destinationChainId"
>;

// The sender's transfers of one asset, which bound where one of them can find its burn.
export type SenderTransfer = Pick<TransferActivity, "id" | "createdAt" | "sourceTransactionHash">;

// One transfer's saved row and its held burn, read and written by sendTransfer.
export type TransferRecords = {
  // Null when the row isn't saved yet.
  fetchSaved: () => Promise<TransferActivity | null>;
  // Read fresh each search, so a transfer started since is counted.
  fetchSenderTransfers: () => Promise<SenderTransfer[]>;
  // Inserts the row in approval-required. Leaves a row that's already there as it is.
  saveNew: (crossChainFee: bigint) => Promise<void>;
  // Replaces the fee of a row still in approval-required, so it's the fee the burn pays.
  saveFee: (crossChainFee: bigint) => Promise<void>;
  saveSubmitted: (sourceTransactionHash: Hash) => Promise<void>;
  // Holds the burn and where it came from until it's saved, in storage that outlives a reload.
  unsaved: { read: () => HeldBurn | null; write: (held: HeldBurn) => void; clear: () => void };
};

// The burn was sent, but saving it failed. Retrying the same transfer saves it, and sends nothing.
export class TransferSentError extends Error {
  constructor(cause: unknown) {
    super("The transfer was sent but isn't saved yet. Try again to save it. A new transfer would burn twice.", {
      cause,
    });
  }
}

export type CheckedTransfer = {
  source: Chain;
  destination: Chain;
  token: Address;
  tokenManager: Address;
  needsApproval: boolean;
  quote: Quote;
  // The source's gas for the approve, if needed, and the burn, at today's max fee.
  gasCost: bigint;
};

async function readGasCost(client: PublicClient, chain: Chain, needsApproval: boolean) {
  const gas = measuredGas(chain);
  const units = needsApproval ? gas.approve + gas.crossChainTransfer : gas.crossChainTransfer;
  const fees = await client.estimateFeesPerGas();
  return units * fees.maxFeePerGas;
}

// CCTP's fee and the gas are both paid in the source's native token.
async function checkNativeBalance(client: PublicClient, chain: Chain, sender: Address, needed: bigint) {
  const balance = await client.getBalance({ address: sender });
  if (balance < needed) {
    throw new Error(
      `You need ${formatTokenAmount(needed, chain.gasDecimals)} ${chain.gasSymbol} on ${chain.name} for the cross-chain fee and gas, ` +
        `and hold ${formatTokenAmount(balance, chain.gasDecimals)}. Get ${chain.gasSymbol} at ${chain.faucetUrl}.`,
    );
  }
}

function isTrustedDomain(client: PublicClient, domain: number) {
  return client.readContract({
    address: CROSS_CHAIN_TOKEN_SERVICE,
    abi: crossChainTokenServiceAbi,
    functionName: "isTrustedDomain",
    args: [domain],
  });
}

function readMaxTransferAmount(client: PublicClient, tokenManager: Address) {
  return client.readContract({ address: tokenManager, abi: tokenManagerAbi, functionName: "maxTransferAmount" });
}

async function readLimits(client: PublicClient, tokenManager: Address) {
  const [maxTransferAmount, rateLimit] = await Promise.all([
    readMaxTransferAmount(client, tokenManager),
    readRateLimit(client, tokenManager),
  ]);
  return { maxTransferAmount, rateLimit };
}

// A TokenManager's limits apply to the burn on the source and the mint on the destination.
function checkLimits(
  { maxTransferAmount, rateLimit }: Awaited<ReturnType<typeof readLimits>>,
  asset: SavedAsset,
  amount: bigint,
  where: string,
  chain: Chain,
) {
  if (amount > maxTransferAmount) {
    throw new Error(`${asset.symbol} caps a single transfer ${where} at ${formatAssetAmount(maxTransferAmount, asset)}`);
  }
  if (rateLimit === BigInt(0)) {
    throw new Error(`${asset.symbol} transfers are paused on ${chain.name}: its rate limit is zero. The issuer can raise it.`);
  }
}

// Everything the transfer needs onchain, read without asking the wallet for anything. Reads that
// don't depend on each other go out together, and the rules are checked in a fixed order after,
// each throwing its own message, so the sender knows what to fix.
export async function checkTransfer(
  order: Omit<TransferOrder, "id" | "assetId">,
  asset: SavedAsset,
  wagmiConfig: Config,
  iris: Iris,
): Promise<CheckedTransfer> {
  const source = findChain(order.sourceChainId);
  const destination = findChain(order.destinationChainId);
  if (!isRoute(source, destination)) {
    throw new Error(`Transfers from ${source.name} to ${destination.name} aren't supported`);
  }
  for (const chain of [source, destination]) {
    if (!isChainEnabled(asset, chain.id)) throw new Error(`${asset.symbol} isn't set up on ${chain.name} yet`);
  }
  if (order.amount <= BigInt(0)) throw new Error("Enter an amount above zero");

  const sourceClient = publicFor(wagmiConfig, source);
  const destinationClient = publicFor(wagmiConfig, destination);
  const [sourceTrusts, destinationTrusts] = await Promise.all([
    isTrustedDomain(sourceClient, destination.cctpDomain),
    isTrustedDomain(destinationClient, source.cctpDomain),
  ]);
  if (!sourceTrusts) throw new Error(`CCTP on ${source.name} doesn't accept transfers to ${destination.name}`);
  if (!destinationTrusts) throw new Error(`CCTP on ${destination.name} doesn't accept transfers from ${source.name}`);

  // Both ends: a token registered elsewhere on the destination would get the mint.
  const [tokenManager, destinationTokenManager] = await Promise.all([
    tokenManagerOn(sourceClient, asset, source),
    tokenManagerOn(destinationClient, asset, destination),
  ]);

  const token = tokenOn(asset, source);
  const [balance, sourceLimits, destinationLimits, allowance] = await Promise.all([
    sourceClient.readContract({ address: token, abi: communityTokenAbi, functionName: "balanceOf", args: [order.sender] }),
    readLimits(sourceClient, tokenManager),
    readLimits(destinationClient, destinationTokenManager),
    // The TokenManager pulls the tokens before it burns them.
    sourceClient.readContract({
      address: token,
      abi: communityTokenAbi,
      functionName: "allowance",
      args: [order.sender, tokenManager],
    }),
  ]);
  if (balance < order.amount) {
    throw new Error(
      `You hold ${formatAssetAmount(balance, asset)} on ${source.name}, less than ${formatAssetAmount(order.amount, asset)}`,
    );
  }
  checkLimits(sourceLimits, asset, order.amount, `from ${source.name}`, source);
  checkLimits(destinationLimits, asset, order.amount, `to ${destination.name}`, destination);

  const needsApproval = allowance < order.amount;
  const [quote, gasCost] = await Promise.all([
    iris.quote({
      crossChainId: asset.crossChainId,
      source,
      destination,
      amount: order.amount,
      recipient: order.recipient,
    }),
    readGasCost(sourceClient, source, needsApproval),
  ]);
  await checkNativeBalance(sourceClient, source, order.sender, quote.feeTotal + gasCost);
  return { source, destination, token, tokenManager, needsApproval, quote, gasCost };
}

// What the review screen shows. Throws what would stop the transfer, before anything is signed.
export async function quoteTransfer(
  asset: SavedAsset,
  route: Route,
  sender: Address,
  recipient: Address,
  amount: bigint,
  wagmiConfig: Config,
  iris: Iris,
) {
  const checked = await checkTransfer(
    { sender, recipient, amount, sourceChainId: route.source.id, destinationChainId: route.destination.id },
    asset,
    wagmiConfig,
    iris,
  );
  return {
    crossChainFee: checked.quote.feeTotal,
    gas: checked.gasCost,
    needsApproval: checked.needsApproval,
    forwarded: checked.quote.forwarded,
  };
}

function secondsOf(time: Date) {
  return BigInt(Math.floor(time.getTime() / MILLISECONDS_PER_SECOND));
}

// When the sender saved their next transfer of the asset after this one, if they did.
function nextSavedAt(transfer: Pick<SenderTransfer, "id" | "createdAt">, senderTransfers: SenderTransfer[]) {
  const later = senderTransfers
    .filter((other) => other.id !== transfer.id && other.createdAt > transfer.createdAt)
    .map((other) => other.createdAt.getTime());
  return later.length > 0 ? new Date(Math.min(...later)) : null;
}

// The recipient the burn's service event carries in its bytes field (a testnet round trip showed
// it's the recipient, not the sender), or null when the data isn't shaped that way.
function eventRecipient(data: Hex) {
  try {
    const [destinationAddress] = decodeAbiParameters(BURN_EVENT_DATA, data);
    return destinationAddress;
  } catch (error) {
    if (error instanceof BaseError) return null;
    throw error;
  }
}

// The recipient of a burn sent straight to the service, read from its crossChainTransfer call.
// Null when the call can't be read that way.
function calldataRecipient(transaction: { to: Address | null; input: Hex }) {
  if (!transaction.to || !isAddressEqual(transaction.to, CROSS_CHAIN_TOKEN_SERVICE)) return null;
  let call;
  try {
    call = decodeFunctionData({ abi: crossChainTokenServiceAbi, data: transaction.input });
  } catch (error) {
    // Calldata that isn't one of the service's calls has no recipient to read.
    if (error instanceof BaseError) return null;
    throw error;
  }
  if (call.functionName !== "crossChainTransfer") return null;
  const [, , , destinationAddress] = call.args;
  return destinationAddress;
}

// Whether a burn mints to the recipient: read from its crossChainTransfer call, or, for a burn
// sent through a smart account, an EntryPoint or a 7702 wallet, from the event's bytes field. A
// burn whose recipient can't be read either way isn't this transfer's. A failed read throws.
async function burnsTo(client: PublicClient, log: { transactionHash: Hash; data: Hex }, recipient: Address) {
  const transaction = await client.getTransaction({ hash: log.transactionHash });
  const destinationAddress = calldataRecipient(transaction) ?? eventRecipient(log.data);
  return destinationAddress !== null && destinationAddress.toLowerCase() === packAddress(recipient).toLowerCase();
}

type LandedBurnTransfer = Pick<
  TransferActivity,
  "id" | "sender" | "recipient" | "amount" | "sourceChainId" | "destinationChainId" | "createdAt"
>;

// The blocks a search for a landed burn covered, both included.
type SearchedBlocks = { from: bigint; to: bigint };

// A search for a landed burn: the burn, or null and the blocks it searched.
type BurnSearch = { burn: Hash; searched?: never } | { burn: null; searched: SearchedBlocks };

// Where a search picks up after an earlier one: a margin before the block it ended at, since an
// RPC whose logs index trailed the latest block could have answered the newest ones as empty.
// Never before the earlier search's start, where the burn can't be.
export function resumeBlock(earlier: SearchedBlocks, lagMarginBlocks: bigint) {
  const resumeFrom = earlier.to - lagMarginBlocks;
  return resumeFrom > earlier.from ? resumeFrom : earlier.from;
}

// findLandedBurn, telling which blocks it searched. Resumed after an earlier search, it skips
// the blocks that one covered, all but the newest few.
async function searchLandedBurn(
  transfer: LandedBurnTransfer,
  asset: Pick<SavedAsset, "crossChainId">,
  wagmiConfig: Config,
  senderTransfers: SenderTransfer[],
  endMarginSeconds: bigint,
  earlier?: SearchedBlocks,
): Promise<BurnSearch> {
  const source = findChain(transfer.sourceChainId);
  const destination = findChain(transfer.destinationChainId);
  const client = publicFor(wagmiConfig, source);
  const timestampOf = async (blockNumber: bigint) => (await client.getBlock({ blockNumber })).timestamp;
  // The row is saved before the burn is signed, so the burn can't be in an earlier block.
  const savedAt = secondsOf(transfer.createdAt) - CLOCK_SKEW_SECONDS;
  // Uncached: a cached block number can predate a burn that just landed, and miss it.
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const fromBlock = earlier
    ? resumeBlock(earlier, source.logLagMarginBlocks)
    : await blockAtOrBefore(savedAt, latest, timestampOf);
  // Nor in the second the next row was saved, or later: that's the next transfer's. Between this
  // burn and the next row, the sender reviewed and signed a new transfer. Before a send, a burn
  // missed to clock skew would be paid twice, so the caller can widen the end by a margin.
  const next = nextSavedAt(transfer, senderTransfers);
  const toBlock = next
    ? await blockAtOrBefore(secondsOf(next) - BigInt(1) + endMarginSeconds, latest, timestampOf)
    : latest;
  const claimed = new Set(
    senderTransfers
      .filter((other) => other.id !== transfer.id)
      .flatMap((other) => (other.sourceTransactionHash ? [other.sourceTransactionHash.toLowerCase()] : [])),
  );
  const topics: Hex[] = [
    CROSS_CHAIN_TRANSFER_TOPIC,
    asset.crossChainId,
    encodeAbiParameters([{ type: "address" }], [transfer.sender]),
    encodeAbiParameters([{ type: "uint32" }], [destination.cctpDomain]),
  ];
  const burn = await findInWindows(client, source, fromBlock, async (from, to) => {
    const logs = await client.request({
      method: "eth_getLogs",
      params: [{ address: CROSS_CHAIN_TOKEN_SERVICE, topics, fromBlock: toHex(from), toBlock: toHex(to) }],
    });
    const candidates = logs
      .filter((log) => size(log.data) >= AMOUNT_WORD_END)
      .filter((log) => hexToBigInt(slice(log.data, AMOUNT_WORD_START, AMOUNT_WORD_END)) === transfer.amount)
      .flatMap(({ transactionHash, data }) => (transactionHash ? [{ transactionHash, data }] : []))
      .filter(({ transactionHash }) => !claimed.has(transactionHash.toLowerCase()));
    // One at a time, so the search reads no more transactions than it needs.
    for (const candidate of candidates) {
      if (await burnsTo(client, candidate, transfer.recipient)) return [candidate.transactionHash];
    }
    return [];
  }, toBlock);
  // Resumed, the blocks searched start where the earlier search did.
  return burn ? { burn } : { burn: null, searched: { from: earlier ? earlier.from : fromBlock, to: toBlock } };
}

// The burn of a transfer whose row was saved but whose burn wasn't, found from the service's
// event. Null when it didn't land. A read that fails throws, so it never reads as "no burn".
// A burn to another recipient is skipped, and so is one the sender's other transfers can claim:
// one they saved, or one after the next was saved.
export async function findLandedBurn(
  transfer: LandedBurnTransfer,
  asset: Pick<SavedAsset, "crossChainId">,
  wagmiConfig: Config,
  senderTransfers: SenderTransfer[],
  endMarginSeconds = BigInt(0),
): Promise<Hash | null> {
  return (await searchLandedBurn(transfer, asset, wagmiConfig, senderTransfers, endMarginSeconds)).burn;
}

// Saves the burn. It's held first and let go once saved, so a failed save leaves it held for the
// retry, found ones too: a stale node's search could miss it and burn again.
async function saveBurn(burn: HeldBurn, records: TransferRecords) {
  const { transactionHash, source } = burn;
  try {
    records.unsaved.write(burn);
  } catch (holdError) {
    return saveUnheldBurn(burn, holdError, records);
  }
  try {
    await records.saveSubmitted(transactionHash);
  } catch (error) {
    if (!(error instanceof BurnRecordedError)) throw new TransferSentError(error);
    // The wallet's burn stays held, so this transfer never burns again.
    if (source === "wallet") {
      throw new Error(
        "This transfer's burn is already recorded by another transfer, so it won't be sent again. " +
          "Follow that transfer in your activity.",
        { cause: error },
      );
    }
    // Let go, so the next try searches again and skips the burn the other transfer saved.
    records.unsaved.clear();
    throw new Error(
      "The burn found for this transfer is already recorded by another transfer. Try again to look for this one's own burn.",
      { cause: error },
    );
  }
  records.unsaved.clear();
  return transactionHash;
}

// This browser couldn't hold the burn, as when storage is full or blocked. Saving it is all that
// keeps a retry from burning again, so it's still tried. Saved, the burn is safe and the transfer
// goes on: nothing was held, so nothing is let go. Not saved, the error says what to do, with the
// hash, and keeps both causes.
async function saveUnheldBurn(burn: HeldBurn, holdError: unknown, records: TransferRecords) {
  try {
    await records.saveSubmitted(burn.transactionHash);
  } catch (saveError) {
    throw new BurnNotHeldError(burn, holdError, saveError);
  }
  return burn.transactionHash;
}

function burnNotHeldMessage({ transactionHash, source }: HeldBurn, saveError: unknown) {
  const sent = `Your burn was sent (${transactionHash}), but this browser couldn't keep a record of it`;
  if (!(saveError instanceof BurnRecordedError)) {
    return (
      `${sent} and saving it failed. Don't start a new transfer. Wait a few minutes for the burn to land, then ` +
      "try again: the retry looks for it onchain before sending anything. If it still fails, contact support with this hash."
    );
  }
  // A retry's search skips burns other rows saved, so it would miss this one and could burn again.
  if (source === "wallet") {
    return (
      `${sent}, and another transfer already recorded it. Don't retry this transfer or start a new one: a retry ` +
      "can't tell this burn is its own and could burn again. Contact support with this hash."
    );
  }
  return "The burn found for this transfer is already recorded by another transfer. Try again to look for this one's own burn.";
}

// The burn was sent, or found, but this browser couldn't hold it and the database didn't save it.
export class BurnNotHeldError extends Error {
  constructor(burn: HeldBurn, holdError: unknown, saveError: unknown) {
    super(burnNotHeldMessage(burn, saveError), {
      cause: new AggregateError([holdError, saveError], "Holding and saving the burn both failed"),
    });
  }
}

// A burn still waiting in the mempool isn't in the logs yet, so a search now could miss it.
async function checkNothingPending(wagmiConfig: Config, source: Chain, sender: Address) {
  const client = publicFor(wagmiConfig, source);
  const [landed, pending] = await Promise.all([
    client.getTransactionCount({ address: sender, blockTag: "latest" }),
    client.getTransactionCount({ address: sender, blockTag: "pending" }),
  ]);
  if (pending > landed) {
    throw new Error(
      `A transaction from your wallet is still pending on ${source.name}, and it may be this transfer. Wait for it to land, then try again.`,
    );
  }
}

// A burn sent for a row that wasn't saved as submitted: held here, or landed onchain. With none,
// the blocks searched, so a later search can resume after them.
type UnsavedBurnSearch = { burn: HeldBurn; searched?: never } | { burn: null; searched: SearchedBlocks };

async function findUnsavedBurn(
  saved: TransferActivity,
  asset: SavedAsset,
  records: TransferRecords,
  wagmiConfig: Config,
  earlier?: SearchedBlocks,
): Promise<UnsavedBurnSearch> {
  const held = records.unsaved.read();
  if (held) return { burn: held };
  // Sending while one is pending could burn twice.
  await checkNothingPending(wagmiConfig, findChain(saved.sourceChainId), saved.sender);
  // Taking a later transfer's unsaved burn costs no tokens; missing this one would burn twice.
  const search = await searchLandedBurn(
    saved,
    asset,
    wagmiConfig,
    await records.fetchSenderTransfers(),
    CLOCK_SKEW_SECONDS,
    earlier,
  );
  return search.burn ? { burn: { transactionHash: search.burn, source: "search" } } : search;
}

async function approve(checked: CheckedTransfer, order: TransferOrder, wagmiConfig: Config) {
  const client = publicFor(wagmiConfig, checked.source);
  const wallet = await walletFor(wagmiConfig, checked.source);
  const { request } = await client.simulateContract({
    account: wallet.account,
    address: checked.token,
    abi: communityTokenAbi,
    functionName: "approve",
    // Exactly the amount, so the TokenManager can never pull more than this transfer.
    args: [checked.tokenManager, order.amount],
  });
  const transactionHash = await wallet.writeContract(request);
  let receipt;
  try {
    receipt = await waitForSent(client, transactionHash);
  } catch (error) {
    if (error instanceof ReplacedError) throw new Error(`${error.message} Nothing was approved or burned.`, { cause: error });
    throw error;
  }
  if (receipt.status !== "success") throw new Error("The approval reverted, so nothing was burned.");
}

// Sends the transfer's burn once, however often it's retried or the page reloads, and saves it
// as source-submitted. Returns the burn's hash.
export async function sendTransfer(
  order: TransferOrder,
  asset: SavedAsset,
  wagmiConfig: Config,
  iris: Iris,
  records: TransferRecords,
): Promise<Hash> {
  const saved = await records.fetchSaved();
  if (saved?.sourceTransactionHash) {
    // Saved after all. Only a held copy of that same burn is let go.
    if (records.unsaved.read()?.transactionHash === saved.sourceTransactionHash) records.unsaved.clear();
    return saved.sourceTransactionHash;
  }
  // A row without a burn may still have one: held since a failed save, or landed unrecorded.
  let searched: SearchedBlocks | undefined;
  if (saved) {
    const unsaved = await findUnsavedBurn(saved, asset, records, wagmiConfig);
    if (unsaved.burn) return saveBurn(unsaved.burn, records);
    searched = unsaved.searched;
  } else {
    const held = records.unsaved.read();
    if (held) return saveBurn(held, records);
  }

  const checked = await checkTransfer(order, asset, wagmiConfig, iris);
  const { source, destination } = checked;
  const client = publicFor(wagmiConfig, source);
  const wallet = await walletFor(wagmiConfig, source);
  // The row and the burn are the sender's. Another account would burn its own tokens under them.
  if (!isAddressEqual(wallet.account.address, order.sender)) {
    throw new Error(`Switch your wallet to ${order.sender} to send this transfer`);
  }
  if (checked.needsApproval) await approve(checked, order, wagmiConfig);

  // Arc's quotes expire in about two minutes, and the approve can take that long.
  const quote = await iris.quote({
    crossChainId: asset.crossChainId,
    source,
    destination,
    amount: order.amount,
    recipient: order.recipient,
  });
  await checkNativeBalance(client, source, order.sender, quote.feeTotal + (await readGasCost(client, source, false)));
  if (saved) {
    // An earlier burn may have landed while the checks and the approve ran. It paid the fee
    // already saved, so this looks before the fee changes. It skips what the first search covered,
    // except the newest blocks, which a lagging logs index may have answered as empty.
    const landed = await findUnsavedBurn(saved, asset, records, wagmiConfig, searched);
    if (landed.burn) return saveBurn(landed.burn, records);
    await records.saveFee(quote.feeTotal);
  } else {
    // Saved before the burn is signed, so a burn always has a row to be found from.
    await records.saveNew(quote.feeTotal);
  }

  let transactionHash: Hash;
  try {
    const { request } = await client.simulateContract({
      account: wallet.account,
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: crossChainTokenServiceAbi,
      functionName: "crossChainTransfer",
      args: [
        asset.crossChainId,
        order.amount,
        destination.cctpDomain,
        packAddress(order.recipient),
        // Anyone may deliver it, so Circle can forward it.
        zeroHash,
        STANDARD_FINALITY,
        { signedQuote: quote.signedQuote, refundAddress: order.sender },
        false,
        "0x",
      ],
      value: quote.feeTotal,
    });
    // With the whole ABI: the simulation keeps only the function, and the errors the estimate
    // before signing may raise would show as bare selectors.
    transactionHash = await wallet.writeContract({ ...request, abi: crossChainTokenServiceAbi });
  } catch (error) {
    // Refused before signing, so nothing was burned. The row stays approval-required, and the
    // retry reads the allowance again, approving only if it's still short.
    if (isStaleAllowance(error)) {
      throw new Error(
        `${source.name} hasn't caught up with your approval yet. Wait a moment and try again. Nothing was burned.`,
        { cause: error },
      );
    }
    throw error;
  }
  return saveBurn({ transactionHash, source: "wallet" }, records);
}

// Iris checks every 5 seconds while it attests, slowing down to every 30 while it stays pending.
const POLL_INTERVAL_MS = 5_000;
const POLL_BACKOFF = 1.5;
const MAX_POLL_INTERVAL_MS = 30_000;
// Circle's forwarder minted in about 16 seconds in the first testnet runs. After this, the sender delivers it.
const FORWARD_TIMEOUT_MS = 10 * 60 * 1000;
// viem's own default. A sent transaction no node knows by then was dropped, or replaced before a reload.
const RECEIPT_TIMEOUT_MS = 180_000;
// Iris's forward states. Circle's GET /v2/messages reference documents PENDING ("still pending")
// and COMPLETE ("the mint is observed on the destination chain"), and no list. Only COMPLETE is
// trusted without a receipt. CONFIRMED isn't documented for Iris, SENT is Circle's "in the
// mempool", and PENDING and any other state may not have minted, so they keep the receipt check.
// FAILED means Circle gave up. Seen in the testnet runs: SENT, CONFIRMED and
// COMPLETE, all on delivered transfers.
const FORWARD_COMPLETE = "COMPLETE";
const FORWARD_FAILED = "FAILED";

// Whether Iris says Circle's forward transaction has minted on the destination.
export function isForwardDelivered(forwardState: string | null) {
  return forwardState === FORWARD_COMPLETE;
}

type AttestedMessage = Extract<FoundMessage, { state: "attested" }>;

// Circle delivers it, unless the route can't forward or Circle gave up. Otherwise the sender does.
export function isForwarding(message: Pick<AttestedMessage, "forwarded" | "forwardState">) {
  return message.forwarded && message.forwardState !== FORWARD_FAILED;
}

export type DeliveryIris = Pick<ReturnType<typeof createIris>, "findMessage">;

export type DeliveryProgress = { state: TransferState; destinationTransactionHash?: Hash };

// One transfer's progress after its burn, and its held delivery, written by advanceTransfer.
export type DeliveryRecords = {
  saveProgress: (progress: DeliveryProgress) => Promise<void>;
  fetchSenderTransfers: () => Promise<SenderTransfer[]>;
  // Holds the receiveMessage until it's saved, in storage that outlives a reload.
  unsaved: { read: () => Hash | null; write: (transactionHash: Hash) => void; clear: () => void };
};

export type AdvanceOptions = { forwardTimeoutMs?: number; pollIntervalMs?: number; receiptTimeoutMs?: number };

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// What became of a sent transaction: its receipt, replaced in the wallet (seen onchain at its
// nonce), or unknown to the node by the timeout. Any other failure throws.
type Followed = { outcome: "landed"; receipt: TransactionReceipt } | { outcome: "replaced" } | { outcome: "unknown" };

async function followSent(client: PublicClient, hash: Hash, timeout: number): Promise<Followed> {
  try {
    return { outcome: "landed", receipt: await waitForSent(client, hash, timeout) };
  } catch (error) {
    if (error instanceof ReplacedError) return { outcome: "replaced" };
    if (error instanceof WaitForTransactionReceiptTimeoutError) return { outcome: "unknown" };
    throw error;
  }
}

// A transaction's receipt if it landed, else null. Read once, without waiting; a failed read throws.
async function findReceipt(client: PublicClient, hash: Hash) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  }
}

// Polls until Iris has attested the burn. Pending, including Iris being busy, is never a failure;
// anything Iris throws stops the run with the transfer left where it was.
async function waitForAttestation(iris: DeliveryIris, route: Route, burnHash: Hash, pollIntervalMs: number) {
  let interval = pollIntervalMs;
  for (;;) {
    const found = await iris.findMessage(route, burnHash);
    if (found.state === "attested") return found;
    await sleep(interval);
    interval = Math.min(interval * POLL_BACKOFF, Math.max(MAX_POLL_INTERVAL_MS, pollIntervalMs));
  }
}

function isNonceUsed(client: PublicClient, nonce: Hex) {
  return client
    .readContract({ address: MESSAGE_TRANSMITTER, abi: messageTransmitterAbi, functionName: "usedNonces", args: [nonce] })
    .then((used) => used !== BigInt(0));
}

// The destination transaction that delivered the message, found from MessageTransmitterV2's event
// by its nonce, which only that one delivery can carry. Null when it isn't found. A read that fails throws.
async function findDelivery(transfer: TransferActivity, nonce: Hex, wagmiConfig: Config, burn: TransactionReceipt) {
  const source = findChain(transfer.sourceChainId);
  const destination = findChain(transfer.destinationChainId);
  const client = publicFor(wagmiConfig, destination);
  // Delivered after the burn, so the search starts at the burn's time, less the skew margin.
  const burnBlock = await publicFor(wagmiConfig, source).getBlock({ blockNumber: burn.blockNumber });
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const fromBlock = await blockAtOrBefore(burnBlock.timestamp - CLOCK_SKEW_SECONDS, latest, async (blockNumber) => {
    return (await client.getBlock({ blockNumber })).timestamp;
  });
  return findInWindows(client, destination, fromBlock, async (from, to) => {
    const logs = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: MESSAGE_TRANSMITTER,
          topics: [MESSAGE_RECEIVED_TOPIC, null, nonce],
          fromBlock: toHex(from),
          toBlock: toHex(to),
        },
      ],
    });
    // Not trusting the RPC to have applied the filter: the contract, event and nonce are checked too.
    return logs
      .filter(
        (log) =>
          !log.removed &&
          isAddressEqual(log.address, MESSAGE_TRANSMITTER) &&
          log.topics[0]?.toLowerCase() === MESSAGE_RECEIVED_TOPIC.toLowerCase() &&
          log.topics[2]?.toLowerCase() === nonce.toLowerCase(),
      )
      .map((log) => log.transactionHash);
  });
}

// What a revert says: the require message, the custom error's name, or viem's summary.
function revertReason(error: BaseError) {
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.reason ?? reverted.data?.errorName ?? reverted.signature ?? reverted.shortMessage;
  }
  return error.shortMessage;
}

// The burn's simulation or gas estimate found the TokenManager's allowance short. The checks read
// it as enough, or the approve just landed, so the node answering is behind: in a testnet round
// trip, Sepolia's RPC estimated against the block before the approve.
function isStaleAllowance(error: unknown) {
  return isRevert(error, "ERC20InsufficientAllowance");
}

// Tracks a transfer from its burn to its mint on the destination, saving each state. It never
// approves or burns: delivery is Circle's forwarder or one receiveMessage, sent only after the
// destination says the nonce is unused. Returns the state it ended in.
export async function advanceTransfer(
  transfer: TransferActivity,
  asset: SavedAsset,
  wagmiConfig: Config,
  iris: DeliveryIris,
  records: DeliveryRecords,
  options: AdvanceOptions = {},
): Promise<TransferState> {
  const { sourceTransactionHash } = transfer;
  if (!sourceTransactionHash) throw new Error("This transfer has no burn yet, so there's nothing to track");
  if (transfer.state === "complete" || transfer.state === "burn-failed") return transfer.state;
  const forwardTimeoutMs = options.forwardTimeoutMs ?? FORWARD_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const receiptTimeoutMs = options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  const source = findChain(transfer.sourceChainId);
  const destination = findChain(transfer.destinationChainId);
  const sourceClient = publicFor(wagmiConfig, source);
  const destinationClient = publicFor(wagmiConfig, destination);
  // Retrying a failed delivery means the sender delivers now, without waiting on Circle again.
  const retrying = transfer.state === "delivery-failed";
  let state: TransferState = transfer.state;

  async function save(progress: DeliveryProgress) {
    await records.saveProgress(progress);
    state = progress.state;
  }

  // The delivery is refused onchain. Retry delivery runs this again, nonce check first.
  async function failDelivery(message: string, cause?: unknown): Promise<never> {
    await save({ state: "delivery-failed" });
    throw new Error(message, { cause });
  }

  async function complete(destinationTransactionHash: Hash): Promise<TransferState> {
    await save({ state: "complete", destinationTransactionHash });
    records.unsaved.clear();
    return state;
  }

  // The burn as it landed, or null when onchain shows it didn't: replaced at its nonce, or reverted.
  async function findBurn(recorded: Hash): Promise<TransactionReceipt | null> {
    // Followed even after it landed: a sped-up burn landed under another hash, the one Iris knows.
    const followed = await followSent(sourceClient, recorded, receiptTimeoutMs);
    if (followed.outcome === "landed") return followed.receipt.status === "success" ? followed.receipt : null;
    if (followed.outcome === "replaced") return null;
    // No node knows the saved hash, as when the wallet sped it up or cancelled it before a reload.
    // The saved hash can't change in the database, so a sped-up burn is found again on every run.
    await checkNothingPending(wagmiConfig, source, transfer.sender);
    const landed = await findLandedBurn(transfer, asset, wagmiConfig, await records.fetchSenderTransfers());
    if (!landed) {
      throw new Error(
        `The burn for this transfer wasn't found on ${source.name}. Check your wallet's activity, ` +
          `and start a new transfer only if it shows the burn was cancelled.`,
      );
    }
    const receipt = await sourceClient.getTransactionReceipt({ hash: landed });
    return receipt.status === "success" ? receipt : null;
  }

  const burn = await findBurn(sourceTransactionHash);
  if (!burn) {
    if (state !== "source-submitted") throw new Error(`The burn for this transfer didn't land, yet it was saved as ${state}`);
    await save({ state: "burn-failed" });
    throw new Error(BURN_FAILED_MESSAGE);
  }
  if (state === "source-submitted") await save({ state: "awaiting-attestation" });

  let message = await waitForAttestation(iris, { source, destination }, burn.transactionHash, pollIntervalMs);
  // Retrying a failed delivery goes back to delivering, the one step back the database allows.
  if (state === "awaiting-attestation" || state === "delivery-failed") await save({ state: "delivering" });

  // Circle's forward transaction, when it's known to have delivered: Iris says it minted, or its receipt does.
  async function confirmedForward(attested: AttestedMessage) {
    const { forwardHash, forwardState } = attested;
    if (!forwardHash) return null;
    if (isForwardDelivered(forwardState)) return forwardHash;
    const receipt = await findReceipt(destinationClient, forwardHash);
    return receipt?.status === "success" ? forwardHash : null;
  }

  const attestedAt = Date.now();
  for (;;) {
    const held = records.unsaved.read();
    if (await isNonceUsed(destinationClient, message.nonce)) {
      // A held delivery that landed is the one that minted. Otherwise Circle's, or the one in the logs.
      // Read once: a held hash the node doesn't know didn't mint, and waiting on it would never end.
      const heldReceipt = held ? await findReceipt(destinationClient, held) : null;
      if (heldReceipt?.status === "success") return complete(heldReceipt.transactionHash);
      const delivery = (await confirmedForward(message)) ?? (await findDelivery(transfer, message.nonce, wagmiConfig, burn));
      if (!delivery) {
        throw new Error(
          `The transfer was delivered on ${destination.name}, but its transaction isn't found yet. Try again in a moment.`,
        );
      }
      return complete(delivery);
    }
    if (held) {
      // Sent before, maybe before a reload: wait for it instead of sending another.
      const followed = await followSent(destinationClient, held, receiptTimeoutMs);
      if (followed.outcome === "landed" && followed.receipt.status === "success") {
        return complete(followed.receipt.transactionHash);
      }
      // The nonce may have been used while the wait ran, as when Circle's forwarder delivered first
      // and the held one reverted on the used nonce. The next pass then completes it.
      if (await isNonceUsed(destinationClient, message.nonce)) continue;
      // A resend can at worst revert on a nonce this one used after all: gas, never a second mint.
      records.unsaved.clear();
      const messages = {
        landed: `The delivery reverted on ${destination.name}. Retry to try again.`,
        replaced: `The delivery was cancelled in the wallet. Retry to send it again.`,
        unknown: `The delivery wasn't found on ${destination.name}, so it didn't go through. Retry to send it again.`,
      };
      await failDelivery(messages[followed.outcome]);
    }
    const waitForCircle = isForwarding(message) && !retrying;
    if (waitForCircle && Date.now() - attestedAt < forwardTimeoutMs) {
      await sleep(pollIntervalMs);
      message = await waitForAttestation(iris, { source, destination }, burn.transactionHash, pollIntervalMs);
      continue;
    }
    // Held once sent, so the next pass waits for it and never sends a second.
    await deliver(message);
  }

  // One receiveMessage from the connected wallet. Anyone may deliver it: the burn left the caller open.
  async function deliver(attested: AttestedMessage) {
    const wallet = await walletFor(wagmiConfig, destination);
    const call = {
      account: wallet.account,
      address: MESSAGE_TRANSMITTER,
      abi: messageTransmitterAbi,
      functionName: "receiveMessage",
      args: [attested.message, attested.attestation],
    } as const;
    let request;
    try {
      ({ request } = await destinationClient.simulateContract(call));
    } catch (error) {
      if (!isRevert(error)) throw error;
      // Circle may have delivered it since the last check. The next pass then completes it.
      if (await isNonceUsed(destinationClient, attested.nonce)) return;
      return failDelivery(`${destination.name} rejected the delivery: ${revertReason(error)}`, error);
    }
    const [gas, fees, balance] = await Promise.all([
      destinationClient.estimateContractGas(call),
      destinationClient.estimateFeesPerGas(),
      destinationClient.getBalance({ address: wallet.account.address }),
    ]);
    const needed = gas * fees.maxFeePerGas;
    if (balance < needed) {
      return failDelivery(
        `Delivering needs ${formatTokenAmount(needed, destination.gasDecimals)} ${destination.gasSymbol} on ${destination.name} for gas, ` +
          `and your wallet holds ${formatTokenAmount(balance, destination.gasDecimals)}. ` +
          `Get ${destination.gasSymbol} at ${destination.faucetUrl}, then retry.`,
      );
    }
    // Held before anything can fail, so a retry waits for this one instead of sending another.
    records.unsaved.write(await wallet.writeContract(request));
  }
}
