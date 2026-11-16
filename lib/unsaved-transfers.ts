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

// Transactions for a transfer that Supabase hasn't saved yet: its burn, sent by the wallet or found
// onchain, and its delivery on the destination. Kept in localStorage, so a reload before the save
// goes through can't lose a sent transaction and let it be sent again.

import { isHash, type Hash } from "viem";
import { readableText, storageSnapshot, storedField, type StoredText } from "./stored";

// Where a held burn's hash came from: this transfer's wallet, or a search onchain.
export type BurnSource = "wallet" | "search";
export type HeldBurn = { transactionHash: Hash; source: BurnSource };

type Unsaved<Held> = { transferId: string; held: Held };

function hashOf(entry: unknown, label: string): Hash {
  const transactionHash = storedField(entry, "transactionHash");
  if (typeof transactionHash !== "string" || !isHash(transactionHash)) {
    throw new Error(`A saved unsent ${label} has a bad hash: ${String(transactionHash)}`);
  }
  return transactionHash;
}

// One list per kind of transaction, each under its own key. Each entry is stored flat, as
// { transferId, ...held }.
function unsavedList<Held extends object>(storageKey: string, label: string, toHeld: (entry: unknown) => Held) {
  function toUnsaved(entry: unknown): Unsaved<Held> {
    const transferId = storedField(entry, "transferId");
    if (typeof transferId !== "string") throw new Error(`A saved unsent ${label} is missing its transfer`);
    return { transferId, held: toHeld(entry) };
  }

  // From the stored text, so a page can read it as a snapshot of storage. A refused read throws.
  function parse(stored: StoredText): Unsaved<Held>[] {
    const text = readableText(stored);
    if (text === null) return [];
    const entries: unknown = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error(`Saved unsent ${label}s aren't a list`);
    return entries.map(toUnsaved);
  }

  const stored = () => localStorage.getItem(storageKey);
  const findIn = (storedText: StoredText, transferId: string) =>
    parse(storedText).find((saved) => saved.transferId === transferId)?.held ?? null;
  const readAll = () => parse(stored());

  function writeAll(transfers: Unsaved<Held>[]) {
    localStorage.setItem(storageKey, JSON.stringify(transfers.map(({ transferId, held }) => ({ transferId, ...held }))));
  }

  return {
    stored,
    findIn,
    find: (transferId: string) => findIn(stored(), transferId),
    remember: (transferId: string, held: Held) => {
      writeAll([...readAll().filter((saved) => saved.transferId !== transferId), { transferId, held }]);
    },
    forget: (transferId: string) => writeAll(readAll().filter((saved) => saved.transferId !== transferId)),
  };
}

// An entry with no source was written before sources were kept, when only the wallet's burns were
// held. Reading it as the wallet's means it's never sent again. Any other source is unreadable and
// throws, so nothing is sent on a guess.
function toHeldBurn(entry: unknown): HeldBurn {
  const transactionHash = hashOf(entry, "burn");
  const source = storedField(entry, "source");
  if (source === undefined) return { transactionHash, source: "wallet" };
  if (source !== "wallet" && source !== "search") throw new Error(`A saved unsent burn has a bad source: ${String(source)}`);
  return { transactionHash, source };
}

// Named to the sender when an entry can't be read, so they can clear it.
export const UNSAVED_TRANSFERS_KEY = "unsaved-transfers";

const burns = unsavedList(UNSAVED_TRANSFERS_KEY, "burn", toHeldBurn);
const deliveries = unsavedList("unsaved-deliveries", "delivery", (entry) => ({ transactionHash: hashOf(entry, "delivery") }));

export const findUnsavedTransfer = burns.find;
// The held burns' stored text, for a page to watch, and one transfer's burn in it. Storage the
// browser refuses comes back as unreadable instead of throwing in the render. Finding throws on it,
// or on an unreadable entry, like findUnsavedTransfer.
export const storedUnsavedTransfers = storageSnapshot(burns.stored);
export const findUnsavedTransferIn = burns.findIn;
export const rememberUnsavedTransfer = burns.remember;
export const forgetUnsavedTransfer = burns.forget;

export const findUnsavedDelivery = (transferId: string) => deliveries.find(transferId)?.transactionHash ?? null;
export const rememberUnsavedDelivery = (transferId: string, transactionHash: Hash) =>
  deliveries.remember(transferId, { transactionHash });
export const forgetUnsavedDelivery = deliveries.forget;
