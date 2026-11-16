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

import { describe, expect, it } from "vitest";
import {
  ARBITRUM_SEPOLIA,
  ARC_TESTNET,
  AVALANCHE_FUJI,
  BASE_SEPOLIA,
  CHAINS,
  DESTINATION_CHAINS,
  ETHEREUM_SEPOLIA,
  OP_SEPOLIA,
  POLYGON_AMOY,
  findChain,
  type ChainId,
} from "./chains";

// CCTP domains from Circle's supported-chains table.
const DOMAINS: [ChainId, number][] = [
  ["ethereum-sepolia", 0],
  ["avalanche-fuji", 1],
  ["op-sepolia", 2],
  ["arbitrum-sepolia", 3],
  ["base-sepolia", 6],
  ["polygon-amoy", 7],
  ["arc-testnet", 26],
];

describe("chains", () => {
  it("lists Arc first, then every destination", () => {
    expect(CHAINS.map((chain) => chain.id)).toEqual([
      ARC_TESTNET.id,
      ETHEREUM_SEPOLIA.id,
      AVALANCHE_FUJI.id,
      OP_SEPOLIA.id,
      ARBITRUM_SEPOLIA.id,
      BASE_SEPOLIA.id,
      POLYGON_AMOY.id,
    ]);
    expect(DESTINATION_CHAINS).toEqual(CHAINS.slice(1));
  });

  it.each(DOMAINS)("gives %s CCTP domain %i", (id, domain) => {
    expect(findChain(id).cctpDomain).toBe(domain);
  });

  it("names each chain the way the app shows it", () => {
    expect(CHAINS.map((chain) => chain.name)).toEqual([
      "Arc Testnet",
      "Ethereum Sepolia",
      "Avalanche Fuji",
      "OP Sepolia",
      "Arbitrum Sepolia",
      "Base Sepolia",
      "Polygon PoS Amoy",
    ]);
  });

  it("marks only Arc, Ethereum Sepolia and Base Sepolia as tested onchain", () => {
    expect(CHAINS.filter((chain) => chain.testedOnchain).map((chain) => chain.id)).toEqual([
      ARC_TESTNET.id,
      ETHEREUM_SEPOLIA.id,
      BASE_SEPOLIA.id,
    ]);
  });

  it("finds each chain by its ID", () => {
    for (const chain of CHAINS) expect(findChain(chain.id)).toBe(chain);
  });

  it("throws on an unknown ID", () => {
    // @ts-expect-error The ID isn't one of the seven.
    expect(() => findChain("solana-devnet")).toThrow("solana-devnet");
  });

  it("searches each chain's logs in windows its default RPC accepts", () => {
    expect(Object.fromEntries(CHAINS.map((chain) => [chain.id, chain.logWindowBlocks]))).toEqual({
      "arc-testnet": BigInt(10_000),
      "ethereum-sepolia": BigInt(1_000),
      "avalanche-fuji": BigInt(100),
      "op-sepolia": BigInt(1_000),
      "arbitrum-sepolia": BigInt(1_000),
      "base-sepolia": BigInt(200),
      "polygon-amoy": BigInt(100),
    });
  });

  it("re-reads at least a minute of each chain's newest blocks when a log search resumes", () => {
    expect(Object.fromEntries(CHAINS.map((chain) => [chain.id, chain.logLagMarginBlocks]))).toEqual({
      "arc-testnet": BigInt(256),
      "ethereum-sepolia": BigInt(16),
      "avalanche-fuji": BigInt(64),
      "op-sepolia": BigInt(64),
      "arbitrum-sepolia": BigInt(256),
      "base-sepolia": BigInt(64),
      "polygon-amoy": BigInt(64),
    });
  });

  it("defaults Ethereum Sepolia to publicnode's RPC", () => {
    // Unless NEXT_PUBLIC_RPC_ETHEREUM_SEPOLIA replaces it, as the test environment doesn't.
    expect(ETHEREUM_SEPOLIA.network.rpcUrls.default.http).toEqual([
      process.env.NEXT_PUBLIC_RPC_ETHEREUM_SEPOLIA || "https://ethereum-sepolia-rpc.publicnode.com",
    ]);
  });

  it("gives every chain an explorer and a faucet", () => {
    for (const chain of CHAINS) {
      expect(chain.explorerUrl).toMatch(/^https:\/\//);
      expect(chain.faucetUrl).toMatch(/^https:\/\//);
    }
  });
});
