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

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findUnsavedMint,
  forgetUnsavedMint,
  rememberUnsavedMint,
  UnsavedMintError,
  unsavedMintsOf,
  type UnsavedMint,
} from "./unsaved-mints";

const MINT: UnsavedMint = {
  id: "order-1",
  assetId: "7d4c8a52-3f0e-4b1a-9a8e-1c2d3e4f5a6b",
  issuer: "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c",
  recipient: "0x1111111111111111111111111111111111111111",
  amount: BigInt("1000000000000000000000000"),
  transactionHash: `0x${"ab".repeat(32)}`,
};

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

describe("unsaved mints", () => {
  it("keeps a sent mint, amount and all, until it's forgotten", () => {
    rememberUnsavedMint(MINT);
    expect(findUnsavedMint(MINT.id)).toBe(MINT.transactionHash);
    expect(unsavedMintsOf("0x2f12bd0f9de5b3490e77bf1871f736954610b78c")).toEqual([MINT]);
    forgetUnsavedMint(MINT.id);
    expect(findUnsavedMint(MINT.id)).toBeNull();
  });

  it("only lists the given issuer's mints", () => {
    rememberUnsavedMint(MINT);
    expect(unsavedMintsOf(MINT.recipient)).toEqual([]);
  });

  it("names the mint that wouldn't save, with why", () => {
    const cause = new Error("asset not found");
    const error = new UnsavedMintError(MINT, cause);
    expect(error.mint).toBe(MINT);
    expect(error.message).toBe("asset not found");
    expect(error.cause).toBe(cause);
  });

  it("throws on a stored mint it can't read, instead of dropping it", () => {
    localStorage.setItem("unsaved-mints", JSON.stringify([{ ...MINT, amount: "1", transactionHash: "0x12" }]));
    expect(() => unsavedMintsOf(MINT.issuer)).toThrow("bad hash");
  });
});
