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

// Reads from Circle's CCTP contracts and the app's token contracts.

import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { crossChainTokenServiceAbi, tokenManagerAbi } from "./abis";
import { communityTokenAbi } from "./artifacts";
import { CROSS_CHAIN_TOKEN_SERVICE } from "./config";

// A contract revert, or, given a name, only that custom error.
export function isRevert(error: unknown, errorName?: string): error is BaseError {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError && (errorName === undefined || revert.data?.errorName === errorName);
}

// The token's CCTP TokenManager on this chain, or null when it isn't registered here yet.
// Any other failure is thrown, so a dropped connection never reads as "not registered".
export async function findTokenManager(client: PublicClient, crossChainId: Hex): Promise<Address | null> {
  try {
    return await client.readContract({
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: crossChainTokenServiceAbi,
      functionName: "resolveTokenManager",
      args: [crossChainId],
    });
  } catch (error) {
    if (isRevert(error, "TokenNotRegistered")) return null;
    throw error;
  }
}

// The token registered under the cross-chain ID on this chain. Reverts when none is.
export function readRegisteredToken(client: PublicClient, crossChainId: Hex) {
  return client.readContract({
    address: CROSS_CHAIN_TOKEN_SERVICE,
    abi: crossChainTokenServiceAbi,
    functionName: "resolveTokenAddress",
    args: [crossChainId],
  });
}

export function readRateLimit(client: PublicClient, tokenManager: Address) {
  return client.readContract({ address: tokenManager, abi: tokenManagerAbi, functionName: "rateLimit" });
}

// The one address the token lets mint and burn for CCTP, or the zero address before it's set.
export function readBridge(client: PublicClient, token: Address) {
  return client.readContract({ address: token, abi: communityTokenAbi, functionName: "bridge" });
}
