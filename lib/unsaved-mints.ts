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

// Mints the wallet sent that Supabase hasn't saved yet. Kept in localStorage, so a reload before
// the save goes through can't lose a sent mint and let it be sent again.

import { getAddress, isHash, type Address, type Hash } from "viem";
import { describeError } from "./format";
import { storedField } from "./stored";

const STORAGE_KEY = "unsaved-mints";

export type UnsavedMint = {
  id: string;
  assetId: string;
  issuer: Address;
  recipient: Address;
  amount: bigint;
  transactionHash: Hash;
};

// A held mint that Supabase wouldn't save. Carries the mint, so it can be shown and dropped.
export class UnsavedMintError extends Error {
  constructor(readonly mint: UnsavedMint, cause: unknown) {
    super(describeError(cause), { cause });
  }
}

type StoredMint = Omit<UnsavedMint, "amount"> & { amount: string };

function text(entry: unknown, key: string) {
  const value = storedField(entry, key);
  if (typeof value !== "string") throw new Error(`A saved unsent mint is missing its ${key}`);
  return value;
}

function toUnsavedMint(entry: unknown): UnsavedMint {
  const transactionHash = text(entry, "transactionHash");
  if (!isHash(transactionHash)) throw new Error(`A saved unsent mint has a bad hash: ${transactionHash}`);
  return {
    id: text(entry, "id"),
    assetId: text(entry, "assetId"),
    issuer: getAddress(text(entry, "issuer")),
    recipient: getAddress(text(entry, "recipient")),
    amount: BigInt(text(entry, "amount")),
    transactionHash,
  };
}

function readAll(): UnsavedMint[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return [];
  const entries: unknown = JSON.parse(stored);
  if (!Array.isArray(entries)) throw new Error("Saved unsent mints aren't a list");
  return entries.map(toUnsavedMint);
}

function writeAll(mints: UnsavedMint[]) {
  const stored: StoredMint[] = mints.map((mint) => ({ ...mint, amount: mint.amount.toString() }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export function findUnsavedMint(mintId: string) {
  return readAll().find((mint) => mint.id === mintId)?.transactionHash ?? null;
}

export function rememberUnsavedMint(mint: UnsavedMint) {
  writeAll([...readAll().filter((saved) => saved.id !== mint.id), mint]);
}

export function forgetUnsavedMint(mintId: string) {
  writeAll(readAll().filter((mint) => mint.id !== mintId));
}

export function unsavedMintsOf(issuer: Address) {
  return readAll().filter((mint) => mint.issuer === getAddress(issuer));
}
