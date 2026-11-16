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

// Shared by the *.testnet.ts files: a real config for every chain, with a local key standing in for
// the browser wallet, and in-memory stand-ins for Supabase and localStorage. Each test file must
// mock walletFor in "./wallet" before importing this. publicFor stays real, so reads go through
// wagmi as in the app.

import { createWalletClient, http, isHex, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createConfig } from "wagmi";
import { vi } from "vitest";
import {
  BurnRecordedError,
  type IssuerMintActivity,
  type MintState,
  type TransferActivity,
} from "@/lib/activity";
import { setupOn, type AssetConfig, type SavedAsset, type SentSetupStep, type SetupStepState } from "@/lib/assets";
import {
  ARC_TESTNET,
  CHAINS,
  ETHEREUM_SEPOLIA,
  findChain,
  transactionUrl,
  type Chain,
  type ChainId,
} from "@/lib/chains";
import type { HeldBurn } from "@/lib/unsaved-transfers";
import { newSalt } from "./encoding";
import { IN_FLIGHT_STATES } from "./holdings";
import type { MintRecords } from "./mint";
import { computeCrossChainId, continueSetup } from "./setup";
import { parseTestnetDestinations } from "./testnet-destinations";
import type { DeliveryProgress, DeliveryRecords, SenderTransfer, TransferOrder, TransferRecords } from "./transfer";
import { publicFor, walletFor } from "./wallet";

const key = process.env.DEV_PRIVATE_KEY;
if (!key || !isHex(key)) throw new Error("Set DEV_PRIVATE_KEY in .env.local to run the testnet tests");
export const account = privateKeyToAccount(key);

function transportFor(chain: Chain) {
  return http(chain.network.rpcUrls.default.http[0]);
}

export const transport = transportFor(ARC_TESTNET);
const [firstNetwork, ...otherNetworks] = CHAINS.map((chain) => chain.network);
export const wagmiConfig = createConfig({
  chains: [firstNetwork, ...otherNetworks],
  transports: Object.fromEntries(CHAINS.map((chain) => [chain.network.id, transportFor(chain)])),
});
export const publicClient = publicFor(wagmiConfig, ARC_TESTNET);
export const sepoliaClient = publicFor(wagmiConfig, ETHEREUM_SEPOLIA);
// The wallet signs on whichever chain it's asked for, as the browser wallet does once switched.
vi.mocked(walletFor).mockImplementation(async (_config, chain) =>
  createWalletClient({ account, chain: chain.network, transport: transportFor(chain) }),
);

// The destinations a run covers, from the environment.
export function testnetDestinations(): Chain[] {
  return parseTestnetDestinations(process.env.TESTNET_DESTINATIONS);
}

export function newAsset(config: AssetConfig, salt: Hex, crossChainId: Hex): SavedAsset {
  return {
    ...config,
    id: crypto.randomUUID(),
    issuer: account.address,
    imageUrl: "https://example.com/token.png",
    createdAt: new Date(),
    crossChainId,
    salt,
    setups: {},
    deployments: [],
  };
}

// The asset's setups after one more step on the chain is confirmed, or sent.
function withStep(asset: SavedAsset, chainId: ChainId, confirmed: Hash | null, sent: SentSetupStep | null) {
  const { transactions } = setupOn(asset, chainId);
  return { ...asset.setups, [chainId]: { transactions: confirmed ? [...transactions, confirmed] : transactions, sent } };
}

// Stands in for Supabase and localStorage: keeps the asset and its saved steps in memory.
// `loseStep` drops every record of one sent step, as if the page closed after the transaction
// landed and localStorage was lost, so the step can only be found onchain.
export function memoryRecords(initial: SavedAsset, loseStep?: number) {
  let asset = initial;
  let lost = false;
  // Stands in for localStorage. The lost step's page closed, so it holds nothing for it.
  const unsaved: Partial<Record<string, Hash>> = {};
  const heldKey = (chainId: ChainId, step: number) => `${chainId}:${step}`;
  return {
    current: () => asset,
    fetchAsset: async () => asset,
    findUnsaved: (_id: string, chainId: ChainId, step: number) => unsaved[heldKey(chainId, step)] ?? null,
    rememberUnsaved: (_id: string, chainId: ChainId, step: number, transactionHash: Hash) => {
      if (step !== loseStep) unsaved[heldKey(chainId, step)] = transactionHash;
    },
    forgetUnsaved: (_id: string, chainId: ChainId, step: number) => {
      delete unsaved[heldKey(chainId, step)];
    },
    saveSent: async (_id: string, chainId: ChainId, step: number, transactionHash: Hash) => {
      if (step === loseStep && !lost) {
        lost = true;
        await publicFor(wagmiConfig, findChain(chainId)).waitForTransactionReceipt({ hash: transactionHash });
        throw new Error("page closed");
      }
      asset = { ...asset, setups: withStep(asset, chainId, null, { transactionHash, state: "pending" }) };
    },
    saveProgress: async (
      _id: string,
      chainId: ChainId,
      _step: number,
      state: SetupStepState,
      transactionHash: Hash,
      tokenAddress: Address | null,
    ) => {
      if (state !== "confirmed") {
        asset = { ...asset, setups: withStep(asset, chainId, null, { transactionHash, state }) };
        return;
      }
      asset = {
        ...asset,
        setups: withStep(asset, chainId, transactionHash, null),
        deployments: tokenAddress ? [...asset.deployments, { chainId, tokenAddress }] : asset.deployments,
      };
    },
  };
}

// Launches the asset on Arc, then enables each destination in turn, all through the app's setup code.
export async function launchOn(config: AssetConfig, destinations: Chain[] = []) {
  const salt = newSalt();
  const records = memoryRecords(newAsset(config, salt, await computeCrossChainId(publicClient, account.address, salt)));
  for (const chain of [ARC_TESTNET, ...destinations]) await continueSetup("asset", chain, wagmiConfig, records);
  return records;
}

export async function launch(config: AssetConfig) {
  return (await launchOn(config)).current();
}

// Stands in for Supabase: the order's mint row, if saved.
export function memoryMintRecords() {
  let saved: Pick<IssuerMintActivity, "state" | "transactionHash"> | null = null;
  return {
    current: () => saved,
    fetchSaved: async () => saved,
    saveSent: async (transactionHash: Hash) => {
      saved = { state: "pending", transactionHash };
    },
    saveProgress: async (state: MintState, transactionHash: Hash) => {
      saved = { state, transactionHash };
    },
  } satisfies MintRecords & { current: () => typeof saved };
}

// Stands in for Supabase and localStorage across one asset's transfers: their rows and held
// transactions. With `loseBurn`, a transfer's first burn is never held and its save fails once the
// burn has landed, as if the page closed and localStorage was lost, so it can only be found onchain.
export function memoryTransfers() {
  const rows = new Map<string, TransferActivity>();
  const heldBurns = new Map<string, HeldBurn>();
  const heldDeliveries = new Map<string, Hash>();

  function row(id: string) {
    const saved = rows.get(id);
    if (!saved) throw new Error(`Transfer ${id} isn't saved`);
    return saved;
  }

  function update(id: string, changes: Partial<TransferActivity>) {
    rows.set(id, { ...row(id), ...changes });
  }

  const senderTransfers = async (order: Pick<TransferOrder, "assetId" | "sender">): Promise<SenderTransfer[]> =>
    [...rows.values()].filter((other) => other.assetId === order.assetId && other.sender === order.sender);

  function recordsFor(order: TransferOrder, { loseBurn = false } = {}) {
    let lostBurn: Hash | null = null;
    const records: TransferRecords = {
      fetchSaved: async () => rows.get(order.id) ?? null,
      fetchSenderTransfers: () => senderTransfers(order),
      // Like start_transfer: an existing row is left as it is, fee and all.
      saveNew: async (crossChainFee) => {
        if (rows.has(order.id)) return;
        rows.set(order.id, {
          ...order,
          kind: "transfer",
          crossChainFee,
          state: "approval-required",
          createdAt: new Date(),
          sourceTransactionHash: null,
          destinationTransactionHash: null,
        });
      },
      saveFee: async (crossChainFee) => {
        if (row(order.id).state !== "approval-required") throw new Error("The fee can only change before the burn");
        update(order.id, { crossChainFee });
      },
      saveSubmitted: async (sourceTransactionHash) => {
        if (loseBurn && !lostBurn) {
          lostBurn = sourceTransactionHash;
          await publicFor(wagmiConfig, findChain(order.sourceChainId)).waitForTransactionReceipt({ hash: sourceTransactionHash });
          throw new Error("page closed");
        }
        // Like the unique constraint on source_transaction_hash.
        for (const other of rows.values()) {
          if (other.id !== order.id && other.sourceTransactionHash === sourceTransactionHash) {
            throw new BurnRecordedError(other.id);
          }
        }
        update(order.id, { state: "source-submitted", sourceTransactionHash });
      },
      unsaved: {
        read: () => heldBurns.get(order.id) ?? null,
        write: (held) => {
          if (!(loseBurn && lostBurn === null)) heldBurns.set(order.id, held);
        },
        clear: () => {
          heldBurns.delete(order.id);
        },
      },
    };
    return { ...records, lostBurn: () => lostBurn };
  }

  function deliveryFor(id: string): DeliveryRecords {
    return {
      saveProgress: async ({ state, destinationTransactionHash }: DeliveryProgress) => {
        update(id, { state, destinationTransactionHash: destinationTransactionHash ?? row(id).destinationTransactionHash });
      },
      fetchSenderTransfers: () => senderTransfers(row(id)),
      unsaved: {
        read: () => heldDeliveries.get(id) ?? null,
        write: (transactionHash) => {
          heldDeliveries.set(id, transactionHash);
        },
        clear: () => {
          heldDeliveries.delete(id);
        },
      },
    };
  }

  // What the database's in_flight_transfer_totals would sum for the asset.
  function inTransitKnown(assetId: string) {
    return [...rows.values()]
      .filter((transfer) => transfer.assetId === assetId && IN_FLIGHT_STATES.includes(transfer.state))
      .reduce((total, transfer) => total + transfer.amount, BigInt(0));
  }

  return { row, recordsFor, deliveryFor, inTransitKnown };
}

export function explorerLink(chain: Chain, hash: Hash) {
  return `${chain.name}: ${transactionUrl(chain, hash)}`;
}
