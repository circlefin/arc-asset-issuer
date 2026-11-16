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

import { describe, expect, it, vi } from "vitest";
import { blockAtOrBefore, logWindows } from "./blocks";

// Block n landed at 1000 + 12n seconds, as on a chain with 12-second blocks.
async function twelveSecondBlocks(block: bigint) {
  return BigInt(1000) + BigInt(12) * block;
}

describe("blockAtOrBefore", () => {
  it("finds the block that landed at the time", async () => {
    await expect(blockAtOrBefore(BigInt(1000 + 12 * 777), BigInt(10_000), twelveSecondBlocks)).resolves.toBe(BigInt(777));
  });

  it("finds the last block before a time between blocks", async () => {
    await expect(blockAtOrBefore(BigInt(1000 + 12 * 777 + 5), BigInt(10_000), twelveSecondBlocks)).resolves.toBe(BigInt(777));
  });

  it("is the latest block for a time after it", async () => {
    await expect(blockAtOrBefore(BigInt(10 ** 9), BigInt(10_000), twelveSecondBlocks)).resolves.toBe(BigInt(10_000));
  });

  it("is block 0 for a time before every block", async () => {
    await expect(blockAtOrBefore(BigInt(1), BigInt(10_000), twelveSecondBlocks)).resolves.toBe(BigInt(0));
  });

  it("takes the last of several blocks with the same timestamp", async () => {
    // Blocks 0 to 9 at 0 seconds, 10 to 19 at 10, and so on.
    const sameSecond = async (block: bigint) => (block / BigInt(10)) * BigInt(10);
    await expect(blockAtOrBefore(BigInt(50), BigInt(99), sameSecond)).resolves.toBe(BigInt(59));
  });

  it("reads a few dozen blocks, not every one, on a long chain", async () => {
    const timestampOf = vi.fn(twelveSecondBlocks);
    await blockAtOrBefore(BigInt(1000 + 12 * 12_345_678), BigInt(30_000_000), timestampOf);
    expect(timestampOf.mock.calls.length).toBeLessThan(60);
  });

  it("reads no block far older than the time, which an RPC may have pruned", async () => {
    // Like Base Sepolia's RPC: nothing before block 46,500,000 of 51,400,000.
    const pruned = vi.fn(async (block: bigint) => {
      if (block < BigInt(46_500_000)) throw new Error("pruned history unavailable");
      return twelveSecondBlocks(block);
    });
    const time = BigInt(1000 + 12 * 51_399_000);
    await expect(blockAtOrBefore(time, BigInt(51_400_000), pruned)).resolves.toBe(BigInt(51_399_000));
    const oldest = pruned.mock.calls.map(([block]) => block).reduce((least, block) => (block < least ? block : least));
    expect(oldest).toBeGreaterThanOrEqual(BigInt(51_400_000 - 2 * 1_000));
  });

  it("is the block before the latest when the latest is the first later one", async () => {
    await expect(blockAtOrBefore(BigInt(1000 + 12 * 9_999), BigInt(10_000), twelveSecondBlocks)).resolves.toBe(BigInt(9_999));
  });

  it("throws when a timestamp can't be read, instead of guessing a block", async () => {
    const failing = async () => {
      throw new Error("fetch failed");
    };
    await expect(blockAtOrBefore(BigInt(1), BigInt(10), failing)).rejects.toThrow("fetch failed");
  });
});

describe("logWindows", () => {
  const windows = (from: number, last: number, size: number) =>
    Array.from(logWindows(BigInt(from), BigInt(last), BigInt(size)), (window) => [Number(window.from), Number(window.to)]);

  it("covers every block once, each window at most the size", () => {
    expect(windows(5_000, 7_500, 1_000)).toEqual([
      [5_000, 5_999],
      [6_000, 6_999],
      [7_000, 7_500],
    ]);
  });

  it("spans 9,999 blocks a window at Arc's size", () => {
    expect(windows(0, 25_000, 10_000)).toEqual([
      [0, 9_999],
      [10_000, 19_999],
      [20_000, 25_000],
    ]);
  });

  it("is one window of one block when the range is one block", () => {
    expect(windows(42, 42, 1_000)).toEqual([[42, 42]]);
  });

  it("is no window when the range starts after it ends", () => {
    expect(windows(43, 42, 1_000)).toEqual([]);
  });

  it("refuses a window of no blocks, which would never end", () => {
    expect(() => windows(0, 10, 0)).toThrow("at least one block");
  });
});
