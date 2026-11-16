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

import type { Hash } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_TESTNET, BASE_SEPOLIA } from "./chains";
import { findUnsavedStep, forgetUnsavedStep, rememberUnsavedStep } from "./unsaved-setup-steps";

const ASSET_ID = "7d4c8a52-3f0e-4b1a-9a8e-1c2d3e4f5a6b";
const HASH: Hash = `0x${"ab".repeat(32)}`;
const OTHER_HASH: Hash = `0x${"cd".repeat(32)}`;

// Stands in for the browser's localStorage, which Node doesn't have.
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("unsaved setup steps", () => {
  it("keeps a sent step until it's forgotten", () => {
    rememberUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1, HASH);
    expect(findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1)).toBe(HASH);
    forgetUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1);
    expect(findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1)).toBeNull();
  });

  it("keeps each asset's steps apart", () => {
    rememberUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1, HASH);
    expect(findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 2)).toBeNull();
    expect(findUnsavedStep("another-asset", ARC_TESTNET.id, 1)).toBeNull();
  });

  it("keeps the same step on different networks apart", () => {
    rememberUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1, HASH);
    rememberUnsavedStep(ASSET_ID, BASE_SEPOLIA.id, 1, OTHER_HASH);
    expect(findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1)).toBe(HASH);
    expect(findUnsavedStep(ASSET_ID, BASE_SEPOLIA.id, 1)).toBe(OTHER_HASH);
    forgetUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1);
    expect(findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1)).toBeNull();
    expect(findUnsavedStep(ASSET_ID, BASE_SEPOLIA.id, 1)).toBe(OTHER_HASH);
  });

  // Saved before setup ran on more than one network, so it can only be Arc's.
  it("reads a step held without a network as Arc's", () => {
    localStorage.setItem("unsaved-setup-steps", JSON.stringify([{ assetId: ASSET_ID, step: 1, transactionHash: HASH }]));
    expect(findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1)).toBe(HASH);
    expect(findUnsavedStep(ASSET_ID, BASE_SEPOLIA.id, 1)).toBeNull();
  });

  it("throws on a stored step it can't read, instead of dropping it", () => {
    localStorage.setItem("unsaved-setup-steps", JSON.stringify([{ assetId: ASSET_ID, step: 1, transactionHash: "0x12" }]));
    expect(() => findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1)).toThrow("bad hash");
  });

  it("throws on a stored step on a network it doesn't know", () => {
    localStorage.setItem(
      "unsaved-setup-steps",
      JSON.stringify([{ assetId: ASSET_ID, chainId: "mainnet", step: 1, transactionHash: HASH }]),
    );
    expect(() => findUnsavedStep(ASSET_ID, ARC_TESTNET.id, 1)).toThrow("unknown network");
  });
});
