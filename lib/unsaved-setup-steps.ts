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

// Setup steps the wallet sent that Supabase hasn't saved yet. Kept in localStorage, so a reload
// before the save goes through can't lose a sent step and let it be sent again.

import { isHash, type Hash } from "viem";
import { ARC_TESTNET, CHAINS, type ChainId } from "./chains";
import { storedField } from "./stored";

const STORAGE_KEY = "unsaved-setup-steps";

// Keyed by chain too: step 1 on Arc and step 1 on another network are different transactions.
type UnsavedStep = { assetId: string; chainId: ChainId; step: number; transactionHash: Hash };

function toChainId(value: unknown): ChainId {
  // Held before setup ran on more than one network, when every step was Arc's.
  if (value === undefined) return ARC_TESTNET.id;
  const chain = CHAINS.find((candidate) => candidate.id === value);
  if (!chain) throw new Error(`A saved unsent setup step is on an unknown network: ${String(value)}`);
  return chain.id;
}

function toUnsavedStep(entry: unknown): UnsavedStep {
  const assetId = storedField(entry, "assetId");
  const step = storedField(entry, "step");
  const transactionHash = storedField(entry, "transactionHash");
  if (typeof assetId !== "string" || typeof step !== "number") {
    throw new Error("A saved unsent setup step is missing its asset or step");
  }
  if (typeof transactionHash !== "string" || !isHash(transactionHash)) {
    throw new Error(`A saved unsent setup step has a bad hash: ${String(transactionHash)}`);
  }
  return { assetId, chainId: toChainId(storedField(entry, "chainId")), step, transactionHash };
}

function readAll(): UnsavedStep[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return [];
  const entries: unknown = JSON.parse(stored);
  if (!Array.isArray(entries)) throw new Error("Saved unsent setup steps aren't a list");
  return entries.map(toUnsavedStep);
}

function isOther(saved: UnsavedStep, assetId: string, chainId: ChainId, step: number) {
  return saved.assetId !== assetId || saved.chainId !== chainId || saved.step !== step;
}

export function findUnsavedStep(assetId: string, chainId: ChainId, step: number) {
  return readAll().find((saved) => !isOther(saved, assetId, chainId, step))?.transactionHash ?? null;
}

export function rememberUnsavedStep(assetId: string, chainId: ChainId, step: number, transactionHash: Hash) {
  const others = readAll().filter((saved) => isOther(saved, assetId, chainId, step));
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...others, { assetId, chainId, step, transactionHash }]));
}

export function forgetUnsavedStep(assetId: string, chainId: ChainId, step: number) {
  const others = readAll().filter((saved) => isOther(saved, assetId, chainId, step));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(others));
}
