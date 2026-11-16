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
  encodeDeployData,
  getAddress,
  maxUint256,
  size,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupOn, type AssetConfig, type ChainSetup, type SavedAsset, type SetupStepState } from "@/lib/assets";
import { ARC_TESTNET, BASE_SEPOLIA, type Chain, type ChainId } from "@/lib/chains";
import { crossChainTokenServiceAbi } from "./abis";
import { communityTokenAbi, communityTokenBytecode, rwaTokenAbi, rwaTokenBytecode } from "./artifacts";
import { CROSS_CHAIN_TOKEN_SERVICE } from "./config";
import {
  decodeSent,
  fakeChains,
  revertWith,
  walletOn,
  type ContractCall,
  type FakeNode,
  type SentTransaction,
} from "./fake-chain";
import { findTokenManager } from "./service";
import { computeCrossChainId, continueSetup, estimateSetupCost, sendSetupStep } from "./setup";
import { publicFor, walletFor } from "./wallet";

vi.mock("./wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wallet")>()),
  walletFor: vi.fn(),
}));

const ISSUER: Address = "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c";
const TOKEN: Address = "0xcb33f3ddee40e4fcbccdfa67cd821e8ee346050c";
const TOKEN_MANAGER = getAddress("0x046e0672bebdf0b4c7c62504d162b58ecc705007");
const CROSS_CHAIN_ID: Hex = "0x532ac314e8a331188800dfbe333ac4b7ec8be2384311ed534390ff4823d3e93b";
const SALT: Hex = `0x${"5a".repeat(32)}`;
const DEPLOY_SALT: Hex = `0x${"de".repeat(32)}`;
const DEPLOY_HASH: Hash = `0x${"d1".repeat(32)}`;
const SENT_HASH: Hash = `0x${"e2".repeat(32)}`;
const REGISTER_HASH: Hash = `0x${"f3".repeat(32)}`;
const GRANT_HASH: Hash = `0x${"b5".repeat(32)}`;
const RESENT_HASH: Hash = `0x${"c6".repeat(32)}`;
const SPED_UP_HASH: Hash = `0x${"a4".repeat(32)}`;
const BASE_TOKEN: Address = "0x5d2b7c4e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c";
const BASE_DEPLOY_HASH: Hash = `0x${"9b".repeat(32)}`;

const COMMUNITY: AssetConfig = { type: "community", name: "Meme", symbol: "MEME", description: "A test token", decimals: 6 };

type Progress = Pick<SavedAsset, "setups" | "deployments">;

// One chain's saved setup.
function setupsOn(chain: Chain, transactions: Hash[], sent: ChainSetup["sent"] = null): Progress["setups"] {
  return { [chain.id]: { transactions, sent } };
}

function arcSetup(asset: SavedAsset) {
  return setupOn(asset, ARC_TESTNET.id);
}

const NOT_DEPLOYED: Progress = { setups: {}, deployments: [] };
const DEPLOYED: Progress = {
  setups: setupsOn(ARC_TESTNET, [DEPLOY_HASH]),
  deployments: [{ chainId: ARC_TESTNET.id, tokenAddress: TOKEN }],
};
// Only the rate limit is left.
const BRIDGED: Progress = { ...DEPLOYED, setups: setupsOn(ARC_TESTNET, [DEPLOY_HASH, REGISTER_HASH, GRANT_HASH]) };
// Arc is done, so other networks can be enabled.
const ARC_ENABLED: Progress = { ...DEPLOYED, setups: setupsOn(ARC_TESTNET, [DEPLOY_HASH, REGISTER_HASH, GRANT_HASH, SENT_HASH]) };
// Arc is done and the token is deployed on Base Sepolia.
const BASE_DEPLOYED: Progress = {
  setups: { ...ARC_ENABLED.setups, ...setupsOn(BASE_SEPOLIA, [BASE_DEPLOY_HASH]) },
  deployments: [...ARC_ENABLED.deployments, { chainId: BASE_SEPOLIA.id, tokenAddress: BASE_TOKEN }],
};

function makeAsset(progress: Progress = NOT_DEPLOYED, config: AssetConfig = COMMUNITY): SavedAsset {
  return {
    ...config,
    id: "7d4c8a52-3f0e-4b1a-9a8e-1c2d3e4f5a6b",
    issuer: ISSUER,
    imageUrl: "https://example.com/meme.png",
    createdAt: new Date("2026-10-21T00:00:00Z"),
    crossChainId: CROSS_CHAIN_ID,
    salt: SALT,
    ...progress,
  };
}

type ChainState = { registered: boolean; registeredToken: Address; bridgeSet: boolean; rateLimit: bigint };

// Answers the reads and simulations setup makes, from the token's setup state on the chain.
function answerSetupReads(node: FakeNode, state: () => ChainState) {
  node.read.mockImplementation(({ functionName, args }: ContractCall) => {
    if (functionName === "customTokenDeploySalt") return DEPLOY_SALT;
    if (functionName === "crossChainTokenId") return args[1] === DEPLOY_SALT ? CROSS_CHAIN_ID : SALT;
    if (functionName === "resolveTokenManager") {
      if (state().registered) return TOKEN_MANAGER;
      throw revertWith(crossChainTokenServiceAbi, "TokenNotRegistered", [CROSS_CHAIN_ID]);
    }
    if (functionName === "resolveTokenAddress") return state().registeredToken;
    if (functionName === "bridge") return state().bridgeSet ? TOKEN_MANAGER : zeroAddress;
    if (functionName === "rateLimit") return state().rateLimit;
    if (functionName === "registerCustomToken") return CROSS_CHAIN_ID;
    if (functionName === "setBridge" || functionName === "setRateLimit") return undefined;
    throw new Error(`Unexpected read ${functionName}`);
  });
}

let chains: ReturnType<typeof fakeChains>;
let arc: FakeNode;
let base: FakeNode;

// A chain where the token is deployed and, unless told otherwise, nothing else has happened.
function setUpChain(state: Partial<ChainState> = {}, node: FakeNode = arc) {
  answerSetupReads(node, () => ({
    registered: false,
    registeredToken: node === base ? BASE_TOKEN : TOKEN,
    bridgeSet: false,
    rateLimit: BigInt(0),
    ...state,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  chains = fakeChains();
  arc = chains.arc;
  base = chains.base;
  arc.nextHash.mockReturnValue(SENT_HASH);
  arc.receipt.contractAddress = TOKEN;
  base.nextHash.mockReturnValue(SENT_HASH);
  base.receipt.contractAddress = BASE_TOKEN;
  // The wallet signs on whichever chain it's asked for.
  vi.mocked(walletFor).mockImplementation(async (_config, chain) =>
    walletOn(chain.id === BASE_SEPOLIA.id ? base : arc, ISSUER),
  );
});

afterEach(() => vi.useRealTimers());

function arcClient() {
  return publicFor(chains.wagmiConfig, ARC_TESTNET);
}

// The one transaction the wallet sent, decoded.
function onlySent() {
  expect(arc.sent).toHaveLength(1);
  return { to: arc.sent[0].to, ...decodeSent(arc.sent[0]) };
}

describe("findTokenManager", () => {
  it("is null when the token isn't registered on the chain", async () => {
    setUpChain({ registered: false });
    await expect(findTokenManager(arcClient(), CROSS_CHAIN_ID)).resolves.toBeNull();
  });

  it("rethrows a failed read instead of reporting the token as unregistered", async () => {
    arc.read.mockImplementation(() => {
      throw new Error("fetch failed");
    });
    await expect(findTokenManager(arcClient(), CROSS_CHAIN_ID)).rejects.toThrow("fetch failed");
  });
});

describe("computeCrossChainId", () => {
  it("derives the ID from the custom-token deploy salt, not the raw salt", async () => {
    setUpChain();
    await expect(computeCrossChainId(arcClient(), ISSUER, SALT)).resolves.toBe(CROSS_CHAIN_ID);
  });
});

describe("sendSetupStep", () => {
  it("deploys a community token with Arc as its home chain and returns the hash it sent", async () => {
    setUpChain();
    const result = await sendSetupStep(makeAsset(), ARC_TESTNET, 0, chains.wagmiConfig);
    expect(arc.sent).toEqual([{
      from: ISSUER,
      to: undefined,
      value: BigInt(0),
      data: encodeDeployData({
        abi: communityTokenAbi,
        bytecode: communityTokenBytecode,
        args: ["Meme", "MEME", 6, ISSUER, BigInt(ARC_TESTNET.network.id)],
      }),
    }]);
    expect(result).toBe(SENT_HASH);
  });

  it("deploys a real-world asset token with its asset details", async () => {
    setUpChain();
    const realWorld: AssetConfig = {
      ...COMMUNITY,
      type: "real-world",
      realWorld: {
        issuerName: "Demo Treasury LLC",
        category: "Treasury bills",
        underlyingDescription: "Simulated T-bills",
        documentUrl: null,
      },
    };
    await sendSetupStep(makeAsset(NOT_DEPLOYED, realWorld), ARC_TESTNET, 0, chains.wagmiConfig);
    const info = {
      issuerName: "Demo Treasury LLC",
      category: "Treasury bills",
      underlyingDescription: "Simulated T-bills",
      documentUrl: "",
    };
    expect(arc.sent[0].data).toBe(
      encodeDeployData({
        abi: rwaTokenAbi,
        bytecode: rwaTokenBytecode,
        args: ["Meme", "MEME", 6, ISSUER, BigInt(ARC_TESTNET.network.id), info],
      }),
    );
  });

  it("registers as a custom BURN_MINT token owned by the issuer, with no transfer cap", async () => {
    setUpChain();
    await sendSetupStep(makeAsset(DEPLOYED), ARC_TESTNET, 1, chains.wagmiConfig);
    const sent = onlySent();
    expect(sent.to).toBe(CROSS_CHAIN_TOKEN_SERVICE);
    if (sent.functionName !== "registerCustomToken") throw new Error(`Sent ${sent.functionName}`);
    const [salt, token, params] = sent.args;
    expect(salt).toBe(SALT);
    expect(token).toBe(getAddress(TOKEN));
    expect(params.tokenManagerType).toBe(1);
    expect(size(params.tokenManagerOwner)).toBe(20);
    expect(params.tokenManagerOperator).toBe(params.tokenManagerOwner);
    expect(params.tokenManagerSettings).toEqual({ rateLimit: BigInt(0), maxTransferAmount: maxUint256 });
  });

  it("signs each write with the connected wallet's own account", async () => {
    setUpChain({ registered: true });
    for (const step of [1, 2, 3]) await sendSetupStep(makeAsset(DEPLOYED), ARC_TESTNET, step, chains.wagmiConfig);
    expect(arc.sent.map((transaction) => transaction.from)).toEqual([ISSUER, ISSUER, ISSUER]);
  });

  it("refuses to set up another network before Arc is enabled, before asking the wallet", async () => {
    setUpChain({}, base);
    await expect(sendSetupStep(makeAsset(DEPLOYED), BASE_SEPOLIA, 0, chains.wagmiConfig)).rejects.toThrow(
      "Finish setting MEME up on Arc Testnet",
    );
    expect(walletFor).not.toHaveBeenCalled();
    expect(base.sent).toHaveLength(0);
  });

  it("deploys on another network with Arc still the home chain", async () => {
    setUpChain({}, base);
    await sendSetupStep(makeAsset(ARC_ENABLED), BASE_SEPOLIA, 0, chains.wagmiConfig);
    expect(arc.sent).toHaveLength(0);
    expect(base.sent[0].data).toBe(
      encodeDeployData({
        abi: communityTokenAbi,
        bytecode: communityTokenBytecode,
        args: ["Meme", "MEME", 6, ISSUER, BigInt(ARC_TESTNET.network.id)],
      }),
    );
  });

  it("refuses to sign with a wallet account other than the issuer", async () => {
    setUpChain({ registered: true });
    vi.mocked(walletFor).mockResolvedValue(walletOn(arc, "0x1111111111111111111111111111111111111111"));
    await expect(sendSetupStep(makeAsset(DEPLOYED), ARC_TESTNET, 1, chains.wagmiConfig)).rejects.toThrow(
      `Switch your wallet to the issuer account ${ISSUER}`,
    );
    expect(arc.sent).toHaveLength(0);
  });

  it("sets the TokenManager as the token's one bridge", async () => {
    setUpChain({ registered: true });
    await sendSetupStep(makeAsset(DEPLOYED), ARC_TESTNET, 2, chains.wagmiConfig);
    const sent = onlySent();
    expect(sent.to).toBe(TOKEN);
    if (sent.functionName !== "setBridge") throw new Error(`Sent ${sent.functionName}`);
    expect(sent.args[0]).toBe(TOKEN_MANAGER);
  });

  it("sets a rate limit of a million whole tokens", async () => {
    setUpChain({ registered: true });
    await sendSetupStep(makeAsset(DEPLOYED), ARC_TESTNET, 3, chains.wagmiConfig);
    const sent = onlySent();
    expect(sent.to).toBe(TOKEN_MANAGER);
    if (sent.functionName !== "setRateLimit") throw new Error(`Sent ${sent.functionName}`);
    expect(sent.args[0]).toBe(BigInt(1_000_000) * BigInt(10) ** BigInt(6));
  });

  // Steps 2 and 3 give the TokenManager rights, so neither runs for another token's ID.
  it.each([2, 3])("refuses step %i when the cross-chain ID is registered to another token", async (step) => {
    setUpChain({ registered: true, registeredToken: "0x1111111111111111111111111111111111111111" });
    await expect(sendSetupStep(makeAsset(DEPLOYED), ARC_TESTNET, step, chains.wagmiConfig)).rejects.toThrow(
      "registered to another token",
    );
    expect(arc.sent).toHaveLength(0);
  });

});

describe("continueSetup", () => {
  // Where a held step sits: by chain and step, as localStorage keeps them.
  function heldKey(chainId: ChainId, step: number) {
    return `${chainId}:${step}`;
  }

  // Stands in for localStorage: steps sent but not yet saved, by chain and step.
  function memoryUnsaved(held: Partial<Record<string, Hash>>) {
    const steps = { ...held };
    return {
      steps,
      findUnsaved: (_assetId: string, chainId: ChainId, step: number) => steps[heldKey(chainId, step)] ?? null,
      rememberUnsaved: (_assetId: string, chainId: ChainId, step: number, hash: Hash) => {
        steps[heldKey(chainId, step)] = hash;
      },
      forgetUnsaved: (_assetId: string, chainId: ChainId, step: number) => {
        delete steps[heldKey(chainId, step)];
      },
    };
  }

  // Stands in for Supabase: the asset and its saved steps on each chain, in memory.
  function records(asset: SavedAsset, held: Partial<Record<string, Hash>> = {}) {
    let current = asset;
    function setOn(chainId: ChainId, transactions: Hash[], sent: ChainSetup["sent"]) {
      current = { ...current, setups: { ...current.setups, [chainId]: { transactions, sent } } };
    }
    const saveSent = vi.fn(async (_assetId: string, chainId: ChainId, _step: number, hash: Hash) => {
      setOn(chainId, setupOn(current, chainId).transactions, { transactionHash: hash, state: "pending" });
    });
    const saveProgress = vi.fn(
      async (
        _assetId: string,
        chainId: ChainId,
        _step: number,
        state: SetupStepState,
        hash: Hash,
        tokenAddress: Address | null,
      ) => {
        const { transactions } = setupOn(current, chainId);
        if (state !== "confirmed") {
          setOn(chainId, transactions, { transactionHash: hash, state });
          return;
        }
        setOn(chainId, [...transactions, hash], null);
        if (tokenAddress) current = { ...current, deployments: [...current.deployments, { chainId, tokenAddress }] };
      },
    );
    return {
      current: () => current,
      fetchAsset: vi.fn(async () => current),
      saveSent,
      saveProgress,
      ...memoryUnsaved(held),
    };
  }

  // The register transaction, logged by the service for this token.
  function registerLog() {
    return { transactionHash: REGISTER_HASH, topics: [`0x${"00".repeat(32)}`, CROSS_CHAIN_ID] satisfies Hex[], data: "0x" as const };
  }

  // The next send fails, which stops the loop there.
  function stopAtNextSend() {
    arc.nextHash.mockImplementation(() => {
      throw new Error("stop");
    });
  }

  const ASSET_ID = makeAsset().id;

  it("runs every step in order, saving each as sent and then as confirmed", async () => {
    const store = records(makeAsset());
    // Each write lands, so the next step's read sees it.
    answerSetupReads(arc, () => ({
      registered: arcSetup(store.current()).transactions.length >= 2,
      registeredToken: TOKEN,
      bridgeSet: arcSetup(store.current()).transactions.length >= 3,
      rateLimit: BigInt(0),
    }));
    await continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store);
    expect(store.saveSent.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [ARC_TESTNET.id, 0],
      [ARC_TESTNET.id, 1],
      [ARC_TESTNET.id, 2],
      [ARC_TESTNET.id, 3],
    ]);
    expect(store.saveProgress.mock.calls.map((call) => [call[2], call[3], call[5]])).toEqual([
      [0, "confirmed", TOKEN],
      [1, "confirmed", null],
      [2, "confirmed", null],
      [3, "confirmed", null],
    ]);
  });

  it("saves a step as pending the moment it's sent, before it lands", async () => {
    setUpChain();
    arc.receipt.error = new Error("fetch failed");
    const store = records(makeAsset());
    // viem keeps retrying a failed lookup for several seconds before it gives up.
    vi.useFakeTimers();
    const waiting = expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("fetch failed");
    await vi.runAllTimersAsync();
    await waiting;
    expect(store.saveSent).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 0, SENT_HASH);
    expect(store.saveProgress).not.toHaveBeenCalled();
  });

  it("waits for a step sent before a refresh instead of sending it again", async () => {
    setUpChain({ registered: true });
    stopAtNextSend();
    const store = records(makeAsset({ ...DEPLOYED, setups: setupsOn(ARC_TESTNET, [DEPLOY_HASH], { transactionHash: REGISTER_HASH, state: "pending" }) }));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("stop");
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 1, "confirmed", REGISTER_HASH, null);
    expect(store.saveSent).not.toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 1, expect.anything());
    expect(onlySent().functionName).toBe("setBridge");
  });

  it("saves the new hash of a step the wallet sped up", async () => {
    setUpChain({ registered: true, bridgeSet: true });
    arc.replace.mockImplementation((sent: SentTransaction) => ({ hash: SPED_UP_HASH, to: sent.to ?? null, data: sent.data, value: BigInt(0) }));
    const store = records(makeAsset(BRIDGED));
    await continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store);
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 3, "confirmed", SPED_UP_HASH, null);
  });

  it("saves the token of a deploy the wallet sped up", async () => {
    setUpChain();
    arc.replace.mockImplementation((sent: SentTransaction) => ({ hash: SPED_UP_HASH, to: null, data: sent.data, value: BigInt(0) }));
    stopAtNextSend();
    arc.nextHash.mockReturnValueOnce(SENT_HASH);
    const store = records(makeAsset());
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("stop");
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 0, "confirmed", SPED_UP_HASH, TOKEN);
  });

  it("saves a step the wallet cancelled as reverted, and sends it again on resume", async () => {
    setUpChain({ registered: true, bridgeSet: true });
    arc.replace.mockImplementation((sent: SentTransaction) => ({ hash: SPED_UP_HASH, to: sent.from, data: "0x", value: BigInt(0) }));
    const store = records(makeAsset(BRIDGED));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("cancelled in the wallet");
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 3, "reverted", SENT_HASH, null);

    arc.replace.mockReturnValue(null);
    arc.nextHash.mockReturnValue(RESENT_HASH);
    await continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store);
    expect(store.saveProgress.mock.calls.slice(1).map((call) => [call[3], call[4]])).toEqual([
      ["pending", RESENT_HASH],
      ["confirmed", RESENT_HASH],
    ]);
    expect(store.saveSent).toHaveBeenCalledTimes(1);
  });

  it("saves a step that reverted onchain as reverted, and stops", async () => {
    setUpChain();
    arc.receipt.status = "reverted";
    const store = records(makeAsset(DEPLOYED));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("reverted");
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 1, "reverted", SENT_HASH, null);
  });

  it("holds a sent step until it's saved, so a resume saves it instead of sending it again", async () => {
    setUpChain();
    const store = records(makeAsset());
    store.saveSent.mockRejectedValueOnce(new Error("offline"));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("offline");
    expect(store.steps[heldKey(ARC_TESTNET.id, 0)]).toBe(SENT_HASH);

    stopAtNextSend();
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("stop");
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 0, "confirmed", SENT_HASH, TOKEN);
    expect(store.steps[heldKey(ARC_TESTNET.id, 0)]).toBeUndefined();
    // The deploy, then the register that stopped the loop. The deploy was never sent again.
    expect(arc.sent.map((transaction) => transaction.to)).toEqual([undefined, CROSS_CHAIN_TOKEN_SERVICE]);
  });

  it("ignores a held step that's already saved as reverted, and sends it again", async () => {
    setUpChain({ registered: true, bridgeSet: true });
    arc.nextHash.mockReturnValue(RESENT_HASH);
    const reverted: Progress = {
      ...BRIDGED,
      setups: setupsOn(ARC_TESTNET, [DEPLOY_HASH, REGISTER_HASH, GRANT_HASH], { transactionHash: SENT_HASH, state: "reverted" }),
    };
    const store = records(makeAsset(reverted), { [heldKey(ARC_TESTNET.id, 3)]: SENT_HASH });
    await continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store);
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 3, "pending", RESENT_HASH, null);
    expect(arc.sent).toHaveLength(1);
  });

  it("saves a step that landed onchain but wasn't saved, without sending it again", async () => {
    setUpChain({ registered: true });
    arc.logs.mockReturnValue([registerLog()]);
    stopAtNextSend();
    const store = records(makeAsset(DEPLOYED));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("stop");
    expect(store.saveSent).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 1, REGISTER_HASH);
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 1, "confirmed", REGISTER_HASH, null);
    expect(arc.logs).toHaveBeenCalledWith(
      expect.objectContaining({ address: CROSS_CHAIN_TOKEN_SERVICE, topics: [expect.any(String), CROSS_CHAIN_ID] }),
    );
    expect(onlySent().functionName).toBe("setBridge");
  });

  it("searches for a landed step in windows the RPC accepts, however long ago it was", async () => {
    setUpChain({ registered: true });
    // Deployed at block 100, resumed 25,000 blocks later; the register landed at block 21,000.
    arc.blockNumber = BigInt(25_100);
    arc.logs.mockImplementation(({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock >= BigInt(10_000)) throw new Error("requested range too large");
      return fromBlock <= BigInt(21_000) && BigInt(21_000) <= toBlock ? [registerLog()] : [];
    });
    stopAtNextSend();
    const store = records(makeAsset(DEPLOYED));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("stop");
    expect(store.saveSent).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 1, REGISTER_HASH);
  });

  // A cached block number can be older than a step that just landed, so the search would miss it.
  it("searches up to the chain's current block, not a cached one", async () => {
    setUpChain({ registered: true });
    await arcClient().getBlockNumber();
    arc.blockNumber = BigInt(25_100);
    arc.logs.mockImplementation(({ fromBlock, toBlock }) =>
      fromBlock <= BigInt(21_000) && BigInt(21_000) <= toBlock ? [registerLog()] : [],
    );
    stopAtNextSend();
    const store = records(makeAsset(DEPLOYED));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("stop");
    expect(store.saveSent).toHaveBeenCalledWith(ASSET_ID, ARC_TESTNET.id, 1, REGISTER_HASH);
  });

  it("stops with a clear message when a landed step's transaction can't be found", async () => {
    setUpChain({ registered: true });
    const store = records(makeAsset(DEPLOYED));
    await expect(continueSetup("asset", ARC_TESTNET, chains.wagmiConfig, store)).rejects.toThrow("couldn't find its transaction");
    expect(store.saveSent).not.toHaveBeenCalled();
  });

  it("runs another network's four steps on that network, and sends nothing on Arc", async () => {
    const store = records(makeAsset(ARC_ENABLED));
    const baseDone = () => setupOn(store.current(), BASE_SEPOLIA.id).transactions.length;
    answerSetupReads(base, () => ({
      registered: baseDone() >= 2,
      registeredToken: BASE_TOKEN,
      bridgeSet: baseDone() >= 3,
      rateLimit: BigInt(0),
    }));
    await continueSetup("asset", BASE_SEPOLIA, chains.wagmiConfig, store);
    expect(arc.sent).toHaveLength(0);
    expect(base.sent.map((transaction) => transaction.to)).toEqual([
      undefined,
      CROSS_CHAIN_TOKEN_SERVICE,
      BASE_TOKEN,
      TOKEN_MANAGER,
    ]);
    expect(store.saveSent.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [BASE_SEPOLIA.id, 0],
      [BASE_SEPOLIA.id, 1],
      [BASE_SEPOLIA.id, 2],
      [BASE_SEPOLIA.id, 3],
    ]);
    expect(store.saveProgress).toHaveBeenCalledWith(ASSET_ID, BASE_SEPOLIA.id, 0, "confirmed", SENT_HASH, BASE_TOKEN);
    expect(setupOn(store.current(), ARC_TESTNET.id)).toEqual(setupOn(makeAsset(ARC_ENABLED), ARC_TESTNET.id));
  });

  it("refuses to enable another network before Arc is enabled, before any signature", async () => {
    setUpChain({}, base);
    const store = records(makeAsset(DEPLOYED));
    await expect(continueSetup("asset", BASE_SEPOLIA, chains.wagmiConfig, store)).rejects.toThrow(
      "Finish setting MEME up on Arc Testnet",
    );
    expect(walletFor).not.toHaveBeenCalled();
    expect(arc.sent).toHaveLength(0);
    expect(base.sent).toHaveLength(0);
    expect(store.saveSent).not.toHaveBeenCalled();
  });

  it("finds another network's landed step in that network's logs, from its own deploy block", async () => {
    setUpChain({ registered: true }, base);
    // Base's deploy landed at block 5,000, far from Arc's.
    base.receipt.blockNumber = BigInt(5_000);
    base.blockNumber = BigInt(5_200);
    base.logs.mockReturnValue([registerLog()]);
    base.nextHash.mockImplementation(() => {
      throw new Error("stop");
    });
    const store = records(makeAsset(BASE_DEPLOYED));
    await expect(continueSetup("asset", BASE_SEPOLIA, chains.wagmiConfig, store)).rejects.toThrow("stop");
    expect(base.logs).toHaveBeenCalledWith(
      expect.objectContaining({ address: CROSS_CHAIN_TOKEN_SERVICE, fromBlock: BigInt(5_000) }),
    );
    expect(arc.logs).not.toHaveBeenCalled();
    expect(store.saveSent).toHaveBeenCalledWith(ASSET_ID, BASE_SEPOLIA.id, 1, REGISTER_HASH);
  });

  it("holds each network's sent step apart, so Arc's held step is never taken for Base's", async () => {
    setUpChain({}, base);
    base.nextHash.mockReturnValue(RESENT_HASH);
    const store = records(makeAsset(ARC_ENABLED), { [heldKey(ARC_TESTNET.id, 0)]: DEPLOY_HASH });
    store.saveSent.mockRejectedValueOnce(new Error("offline"));
    await expect(continueSetup("asset", BASE_SEPOLIA, chains.wagmiConfig, store)).rejects.toThrow("offline");
    expect(base.sent).toHaveLength(1);
    expect(store.steps[heldKey(BASE_SEPOLIA.id, 0)]).toBe(RESENT_HASH);
    expect(store.steps[heldKey(ARC_TESTNET.id, 0)]).toBe(DEPLOY_HASH);
  });
});

describe("estimateSetupCost", () => {
  it("prices the deploy by estimate and the CCTP steps by measured gas, at the max fee", async () => {
    arc.gas = BigInt(1_500_000);
    arc.tip = BigInt(20_000_000_000);
    const cost = await estimateSetupCost(ISSUER, COMMUNITY, ARC_TESTNET, chains.wagmiConfig);
    // 1.5M to deploy, then 500k register, 60k grant and 70k rate limit.
    expect(cost).toBe(BigInt(2_130_000) * BigInt(20_000_000_000));
  });

  it("prices another network from that network's own gas estimate and fees", async () => {
    arc.gas = BigInt(9_000_000);
    arc.tip = BigInt(99);
    base.gas = BigInt(1_000_000);
    base.tip = BigInt(3_000_000);
    const cost = await estimateSetupCost(ISSUER, COMMUNITY, BASE_SEPOLIA, chains.wagmiConfig);
    // Base's measured steps: 500k register, 50k grant, 70k rate limit.
    expect(cost).toBe(BigInt(1_620_000) * BigInt(3_000_000));
  });
});
