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

// Gas budgeted for transactions that can't be estimated ahead, per chain, rounded up from what
// they used onchain. Setup's steps can't be estimated before the token exists, and a transfer's
// before its approval lands.

import type { Chain, ChainId } from "@/lib/chains";

export type MeasuredGas = {
  // Setup. Registering deploys the TokenManager, so it costs the most.
  register: bigint;
  grantBridge: bigint;
  rateLimit: bigint;
  // A transfer, on its source chain.
  approve: bigint;
  crossChainTransfer: bigint;
};

// Measured in the first testnet runs: Sepolia's register used 2,510,587, its setRateLimit
// 146,421 and its crossChainTransfer 435,370; Arc's used about 490k, 63k and 357,983.
const ETHEREUM_SEPOLIA_GAS: MeasuredGas = {
  register: BigInt(2_600_000),
  grantBridge: BigInt(150_000),
  rateLimit: BigInt(150_000),
  approve: BigInt(60_000),
  crossChainTransfer: BigInt(440_000),
};

const MEASURED_GAS: Partial<Record<ChainId, MeasuredGas>> = {
  "arc-testnet": {
    register: BigInt(500_000),
    grantBridge: BigInt(60_000),
    rateLimit: BigInt(70_000),
    approve: BigInt(60_000),
    crossChainTransfer: BigInt(360_000),
  },
  "ethereum-sepolia": ETHEREUM_SEPOLIA_GAS,
  // Base Sepolia's register used 494,353, its grant 47,939 and its setRateLimit 63,301; an approve
  // 46,937 and a crossChainTransfer 356,621. Its L1 data fee was under 50,000 wei a transaction,
  // far less than the rounding up.
  "base-sepolia": {
    register: BigInt(500_000),
    grantBridge: BigInt(50_000),
    rateLimit: BigInt(70_000),
    approve: BigInt(60_000),
    crossChainTransfer: BigInt(360_000),
  },
};

// A chain not measured yet takes Ethereum Sepolia's, the most expensive one measured.
export function measuredGas(chain: Pick<Chain, "id">): MeasuredGas {
  return MEASURED_GAS[chain.id] ?? ETHEREUM_SEPOLIA_GAS;
}
