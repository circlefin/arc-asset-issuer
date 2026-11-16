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

// Issuer minting: new supply, only ever on Arc. Bridge minting happens inside CCTP transfers.

import type { Address, Hash } from "viem";
import type { Config } from "wagmi";
import type { IssuerMintActivity, MintState } from "@/lib/activity";
import type { SavedAsset } from "@/lib/assets";
import { ARC_TESTNET } from "@/lib/chains";
import { communityTokenAbi } from "./artifacts";
import { isRevert } from "./service";
import { tokenOn } from "./setup";
import { publicFor, ReplacedError, waitForSent, walletFor } from "./wallet";

// Sends the mint and returns its hash without waiting for it to land. Simulates first, so a
// wallet the token won't let mint is stopped before it's asked to sign.
export async function sendIssuerMint(asset: SavedAsset, recipient: Address, amount: bigint, wagmiConfig: Config) {
  const client = publicFor(wagmiConfig, ARC_TESTNET);
  const wallet = await walletFor(wagmiConfig, ARC_TESTNET);
  let request;
  try {
    ({ request } = await client.simulateContract({
      account: wallet.account,
      address: tokenOn(asset, ARC_TESTNET),
      abi: communityTokenAbi,
      functionName: "mint",
      args: [recipient, amount],
    }));
  } catch (error) {
    if (isRevert(error, "MintNotAllowed")) {
      throw new Error(`Only the issuer wallet can mint ${asset.symbol}`, { cause: error });
    }
    throw error;
  }
  return wallet.writeContract(request);
}

// One order's saved mint, read and written by mintOnce and finishMint.
export type MintRecords = {
  // Null when the order's mint was never sent.
  fetchSaved: () => Promise<Pick<IssuerMintActivity, "state" | "transactionHash"> | null>;
  saveSent: (transactionHash: Hash) => Promise<void>;
  saveProgress: (state: MintState, transactionHash: Hash) => Promise<void>;
};

// The mint was sent, but how it ended isn't saved yet. Retrying the same order only checks on it.
export class MintSentError extends Error {
  constructor(cause: unknown) {
    super("The mint was sent but isn't confirmed yet. Check again to finish it. A new mint would mint twice.", {
      cause,
    });
  }
}

async function saveOrThrowSent(save: () => Promise<void>) {
  try {
    await save();
  } catch (error) {
    throw new MintSentError(error);
  }
}

// Waits for a sent mint to land and saves how it ended. Returns the hash that landed, which is
// a new one when the wallet sped the mint up.
export async function finishMint(transactionHash: Hash, records: MintRecords, wagmiConfig: Config) {
  let receipt;
  try {
    receipt = await waitForSent(publicFor(wagmiConfig, ARC_TESTNET), transactionHash);
  } catch (error) {
    if (!(error instanceof ReplacedError)) throw new MintSentError(error);
    await saveOrThrowSent(() => records.saveProgress("reverted", transactionHash));
    throw new Error(`${error.message} Nothing was minted.`, { cause: error });
  }
  const state = receipt.status === "success" ? "confirmed" : "reverted";
  await saveOrThrowSent(() => records.saveProgress(state, receipt.transactionHash));
  if (state === "reverted") throw new Error("The mint reverted, so nothing was minted.");
  return receipt.transactionHash;
}

// Holds one order's sent mint until it's saved. It must outlive a reload, so a failed save is
// retried with the same transaction instead of sending another.
export type UnsavedMintSlot = {
  read: () => Hash | null;
  write: (transactionHash: Hash) => void;
  clear: () => void;
};

// Saves a mint held in its slot since before a reload, unless it was saved after all.
export async function saveUnsavedMint(transactionHash: Hash, records: MintRecords) {
  const saved = await records.fetchSaved();
  if (!saved) {
    await records.saveSent(transactionHash);
  } else if (saved.state === "reverted" && saved.transactionHash !== transactionHash) {
    await records.saveProgress("pending", transactionHash);
  }
}

// Mints once per order, however often it's retried or the page reloads. The mint is saved the
// moment the wallet sends it, so a retry waits for that transaction instead of sending another.
export async function mintOnce(
  unsaved: UnsavedMintSlot,
  send: () => Promise<Hash>,
  records: MintRecords,
  wagmiConfig: Config,
) {
  const saved = await records.fetchSaved();
  if (saved?.state === "confirmed") return saved.transactionHash;
  if (saved?.state === "pending") return finishMint(saved.transactionHash, records, wagmiConfig);

  // Not a held mint already saved as reverted, which a failed save can leave behind.
  const held = unsaved.read();
  const transactionHash = (held === saved?.transactionHash ? null : held) ?? (await send());
  unsaved.write(transactionHash);
  // A reverted mint minted nothing, so the order is sent again under a new transaction.
  await saveOrThrowSent(() =>
    saved ? records.saveProgress("pending", transactionHash) : records.saveSent(transactionHash),
  );
  unsaved.clear();

  return finishMint(transactionHash, records, wagmiConfig);
}

// What a mint costs in Arc's gas token, at today's max fee.
export async function estimateMintCost(asset: SavedAsset, wagmiConfig: Config) {
  const client = publicFor(wagmiConfig, ARC_TESTNET);
  const [gas, fees] = await Promise.all([
    client.estimateContractGas({
      account: asset.issuer,
      address: tokenOn(asset, ARC_TESTNET),
      abi: communityTokenAbi,
      functionName: "mint",
      args: [asset.issuer, BigInt(1)],
    }),
    client.estimateFeesPerGas(),
  ]);
  return gas * fees.maxFeePerGas;
}
