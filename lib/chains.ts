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

import { defineChain } from "viem";
import {
  arbitrumSepolia,
  arcTestnet,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  polygonAmoy,
  sepolia,
  type Chain as Network,
} from "viem/chains";

export type Chain = {
  id:
    | "arc-testnet"
    | "ethereum-sepolia"
    | "avalanche-fuji"
    | "op-sepolia"
    | "arbitrum-sepolia"
    | "base-sepolia"
    | "polygon-amoy";
  // The wallet's view of the chain: its EVM ID, RPC, explorer and gas token.
  network: Network;
  // What the app shows. The wallet's own name for the chain can differ (viem says "Sepolia").
  name: string;
  explorerUrl: string;
  // Where to get the chain's gas token for testing.
  faucetUrl: string;
  // CCTP's ID for the chain. It isn't the EVM chain ID.
  cctpDomain: number;
  // Gas is paid in the chain's native token.
  gasSymbol: string;
  gasDecimals: number;
  // The most blocks one log query may cover, so searches go in windows the RPC accepts.
  logWindowBlocks: bigint;
  // How many of the newest blocks a log search re-reads when it picks up where an earlier one
  // stopped. An RPC's logs index can trail the node that gave the latest block number, and then
  // answers for the newest blocks come back empty instead of failing.
  logLagMarginBlocks: bigint;
  // Setup and a transfer each way have run onchain here. The others are configured from Circle's
  // docs but never run, so the app marks them "Not yet tested".
  testedOnchain: boolean;
};

export type ChainId = Chain["id"];

type ChainDetails = Pick<
  Chain,
  "id" | "name" | "faucetUrl" | "cctpDomain" | "logWindowBlocks" | "logLagMarginBlocks" | "testedOnchain"
>;

// Public RPCs cap log queries, mostly undocumented. Ethereum Sepolia's former default (thirdweb)
// rejected more than 1,000 blocks; others publish 1,024 (BlockPI). So 1,000 unless a chain is known.
// A NEXT_PUBLIC_RPC_<CHAIN> override must accept the chain's window too, or log searches fail.
const PUBLIC_LOG_WINDOW_BLOCKS = BigInt(1_000);
// Measured against the default RPCs: sepolia.base.org answers "eth_getLogs is limited to a 200
// range", and Avalanche's public RPC and Amoy's (drpc's free tier) reject more than 100 and 101 blocks.
const BASE_SEPOLIA_LOG_WINDOW_BLOCKS = BigInt(200);
const HUNDRED_BLOCK_LOG_WINDOW_BLOCKS = BigInt(100);

// The lag margins aren't measured. Each covers a minute or more of the chain's usual block time,
// far more than an index normally trails, and re-reading it costs at most one more log query.
// Ethereum Sepolia's 12-second blocks: 16 is about three minutes.
const SLOW_BLOCK_LAG_MARGIN = BigInt(16);
// About two seconds a block (OP Sepolia, Base Sepolia, Avalanche Fuji, Polygon Amoy): 64 is about two minutes.
const TWO_SECOND_BLOCK_LAG_MARGIN = BigInt(64);
// Under a second a block (Arc, Arbitrum Sepolia): 256 is a minute or more.
const FAST_BLOCK_LAG_MARGIN = BigInt(256);

function toChain(details: ChainDetails, network: Network): Chain {
  const explorer = network.blockExplorers?.default;
  if (!explorer) throw new Error(`${network.name} has no block explorer`);
  return {
    ...details,
    network,
    explorerUrl: explorer.url,
    gasSymbol: network.nativeCurrency.symbol,
    gasDecimals: network.nativeCurrency.decimals,
  };
}

// An RPC set in the environment replaces the chain's default one. The URL is public.
function withRpcUrl(network: Network, rpcUrl: string | undefined): Network {
  if (!rpcUrl) return network;
  return defineChain({ ...network, rpcUrls: { default: { http: [rpcUrl] } } });
}

// Arc moved to arc.io. Until viem ships the new endpoints, its arcTestnet points at an RPC
// that no longer resolves. See docs.arc.io/arc/references/rpc-endpoints.
const arcTestnetNetwork = defineChain({
  ...arcTestnet,
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"], webSocket: ["wss://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
});

// viem's Ethereum Sepolia RPC (thirdweb) rate-limited a plain send and capped log queries at
// 1,000 blocks in the testnet round trips; publicnode served the whole round trip.
const ethereumSepoliaNetwork = defineChain({
  ...sepolia,
  rpcUrls: { default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] } },
});

// Each variable is written out in full, so Next.js inlines it into the browser bundle.
// New supply is only issued here. Other chains only mint through CCTP.
export const ARC_TESTNET = toChain(
  {
    id: "arc-testnet",
    name: "Arc Testnet",
    faucetUrl: "https://faucet.circle.com",
    cctpDomain: 26,
    // Arc's RPC rejects log queries spanning 10,000 blocks or more.
    logWindowBlocks: BigInt(10_000),
    logLagMarginBlocks: FAST_BLOCK_LAG_MARGIN,
    testedOnchain: true,
  },
  withRpcUrl(arcTestnetNetwork, process.env.NEXT_PUBLIC_RPC_ARC_TESTNET),
);

export const ETHEREUM_SEPOLIA = toChain(
  {
    id: "ethereum-sepolia",
    name: "Ethereum Sepolia",
    faucetUrl: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
    cctpDomain: 0,
    logWindowBlocks: PUBLIC_LOG_WINDOW_BLOCKS,
    logLagMarginBlocks: SLOW_BLOCK_LAG_MARGIN,
    testedOnchain: true,
  },
  withRpcUrl(ethereumSepoliaNetwork, process.env.NEXT_PUBLIC_RPC_ETHEREUM_SEPOLIA),
);

export const AVALANCHE_FUJI = toChain(
  {
    id: "avalanche-fuji",
    name: "Avalanche Fuji",
    faucetUrl: "https://core.app/tools/testnet-faucet/?subnet=c&token=c",
    cctpDomain: 1,
    logWindowBlocks: HUNDRED_BLOCK_LOG_WINDOW_BLOCKS,
    logLagMarginBlocks: TWO_SECOND_BLOCK_LAG_MARGIN,
    testedOnchain: false,
  },
  withRpcUrl(avalancheFuji, process.env.NEXT_PUBLIC_RPC_AVALANCHE_FUJI),
);

export const OP_SEPOLIA = toChain(
  {
    id: "op-sepolia",
    name: "OP Sepolia",
    faucetUrl: "https://console.optimism.io/faucet",
    cctpDomain: 2,
    logWindowBlocks: PUBLIC_LOG_WINDOW_BLOCKS,
    logLagMarginBlocks: TWO_SECOND_BLOCK_LAG_MARGIN,
    testedOnchain: false,
  },
  withRpcUrl(optimismSepolia, process.env.NEXT_PUBLIC_RPC_OP_SEPOLIA),
);

export const ARBITRUM_SEPOLIA = toChain(
  {
    id: "arbitrum-sepolia",
    name: "Arbitrum Sepolia",
    faucetUrl: "https://www.alchemy.com/faucets/arbitrum-sepolia",
    cctpDomain: 3,
    logWindowBlocks: PUBLIC_LOG_WINDOW_BLOCKS,
    logLagMarginBlocks: FAST_BLOCK_LAG_MARGIN,
    testedOnchain: false,
  },
  withRpcUrl(arbitrumSepolia, process.env.NEXT_PUBLIC_RPC_ARBITRUM_SEPOLIA),
);

export const BASE_SEPOLIA = toChain(
  {
    id: "base-sepolia",
    name: "Base Sepolia",
    faucetUrl: "https://docs.base.org/base-chain/tools/network-faucets",
    cctpDomain: 6,
    logWindowBlocks: BASE_SEPOLIA_LOG_WINDOW_BLOCKS,
    logLagMarginBlocks: TWO_SECOND_BLOCK_LAG_MARGIN,
    testedOnchain: true,
  },
  withRpcUrl(baseSepolia, process.env.NEXT_PUBLIC_RPC_BASE_SEPOLIA),
);

export const POLYGON_AMOY = toChain(
  {
    id: "polygon-amoy",
    name: "Polygon PoS Amoy",
    faucetUrl: "https://faucet.polygon.technology",
    cctpDomain: 7,
    logWindowBlocks: HUNDRED_BLOCK_LOG_WINDOW_BLOCKS,
    logLagMarginBlocks: TWO_SECOND_BLOCK_LAG_MARGIN,
    testedOnchain: false,
  },
  withRpcUrl(polygonAmoy, process.env.NEXT_PUBLIC_RPC_POLYGON_AMOY),
);

// Arc is the hub: tokens move between it and a destination, never between two destinations.
export const DESTINATION_CHAINS = [
  ETHEREUM_SEPOLIA,
  AVALANCHE_FUJI,
  OP_SEPOLIA,
  ARBITRUM_SEPOLIA,
  BASE_SEPOLIA,
  POLYGON_AMOY,
];

export const CHAINS = [ARC_TESTNET, ...DESTINATION_CHAINS];

export function findChain(id: ChainId) {
  const chain = CHAINS.find((candidate) => candidate.id === id);
  if (!chain) throw new Error(`Unknown chain ${id}`);
  return chain;
}

export function transactionUrl(chain: Chain, hash: string) {
  return `${chain.explorerUrl}/tx/${hash}`;
}

export function addressUrl(chain: Chain, address: string) {
  return `${chain.explorerUrl}/address/${address}`;
}
