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

// Searching a chain's history: log queries in windows the RPCs accept, and finding the block at a time.

import type { Hash, PublicClient } from "viem";
import type { Chain } from "@/lib/chains";

// The block ranges from fromBlock to lastBlock, both included, each at most windowBlocks long.
export function* logWindows(fromBlock: bigint, lastBlock: bigint, windowBlocks: bigint) {
  if (windowBlocks <= BigInt(0)) throw new Error(`A log window must hold at least one block, not ${windowBlocks}`);
  for (let from = fromBlock; from <= lastBlock; from += windowBlocks) {
    const end = from + windowBlocks - BigInt(1);
    yield { from, to: end < lastBlock ? end : lastBlock };
  }
}

// The first matching transaction from fromBlock to toBlock (the latest block when left out),
// searched one window at a time, each within the chain's RPC limit.
export async function findInWindows(
  client: PublicClient,
  chain: Pick<Chain, "logWindowBlocks">,
  fromBlock: bigint,
  search: (from: bigint, to: bigint) => Promise<(Hash | null)[]>,
  toBlock?: bigint,
) {
  // Uncached: a cached block number can predate a transaction that just landed, and miss it.
  const lastBlock = toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  for (const { from, to } of logWindows(fromBlock, lastBlock, chain.logWindowBlocks)) {
    const found = (await search(from, to)).find((hash) => hash !== null);
    if (found) return found;
  }
  return null;
}

// The last block at or before the time (in seconds). Block 0 when every block is later.
// Timestamps only grow, so the search holds. It steps back from the latest block, twice as far
// each time, then searches between the last two steps, so it reads no block much older than the
// time: RPCs prune old history (Base Sepolia's has none before block 46,500,000).
export async function blockAtOrBefore(
  time: bigint,
  latest: bigint,
  timestampOf: (block: bigint) => Promise<bigint>,
) {
  if ((await timestampOf(latest)) <= time) return latest;
  let high = latest - BigInt(1);
  let distance = BigInt(1);
  let low = high > BigInt(0) ? high : BigInt(0);
  while (low > BigInt(0) && (await timestampOf(low)) > time) {
    high = low - BigInt(1);
    distance *= BigInt(2);
    low = latest > distance ? latest - distance : BigInt(0);
  }
  while (low < high) {
    // Rounds up, so low always moves and the loop ends.
    const middle = (low + high + BigInt(1)) / BigInt(2);
    if ((await timestampOf(middle)) <= time) low = middle;
    else high = middle - BigInt(1);
  }
  return low;
}
