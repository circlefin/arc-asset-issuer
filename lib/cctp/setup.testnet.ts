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

// Launches real tokens on Arc Testnet, and enables Ethereum Sepolia, through the same code the app runs.

import { isAddressEqual } from "viem";
import { describe, expect, it, vi } from "vitest";
import { setupOn, setupStepsOn } from "@/lib/assets";
import { ARC_TESTNET, ETHEREUM_SEPOLIA } from "@/lib/chains";
import { crossChainTokenServiceAbi, tokenManagerAbi } from "./abis";
import { communityTokenAbi, rwaTokenAbi } from "./artifacts";
import { CROSS_CHAIN_TOKEN_SERVICE } from "./config";
import { newSalt } from "./encoding";
import { findTokenManager } from "./service";
import { computeCrossChainId, continueSetup } from "./setup";
import { account, launch, launchOn, memoryRecords, newAsset, publicClient, sepoliaClient, wagmiConfig } from "./testnet-support";

const ARC_SETUP_STEPS = setupStepsOn(ARC_TESTNET);

vi.mock("./wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wallet")>()),
  walletFor: vi.fn(),
}));

describe("launch on Arc Testnet", () => {
  it("sets up a community token as a custom BURN_MINT CCTP token", async () => {
    const asset = await launch({ type: "community", name: "Spike Meme", symbol: "SPKM", description: "Testnet check", decimals: 6 });
    expect(setupOn(asset, ARC_TESTNET.id).transactions).toHaveLength(ARC_SETUP_STEPS.length);
    const token = asset.deployments[0].tokenAddress;

    const tokenManager = await findTokenManager(publicClient, asset.crossChainId);
    if (!tokenManager) throw new Error("The token isn't registered with CCTP");
    const resolved = await publicClient.readContract({
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: crossChainTokenServiceAbi,
      functionName: "resolveTokenAddress",
      args: [asset.crossChainId],
    });
    expect(isAddressEqual(resolved, token)).toBe(true);
    expect(await publicClient.readContract({ address: token, abi: communityTokenAbi, functionName: "bridge" })).toBe(tokenManager);
    expect(await publicClient.readContract({ address: tokenManager, abi: tokenManagerAbi, functionName: "rateLimit" })).toBe(BigInt(1_000_000) * BigInt(10) ** BigInt(6));
    expect(await publicClient.readContract({ address: token, abi: communityTokenAbi, functionName: "totalSupply" })).toBe(BigInt(0));
  });

  it("deploys a real-world asset token with its details onchain", async () => {
    const asset = await launch({
      type: "real-world",
      name: "Spike Bill",
      symbol: "SPKB",
      description: "Testnet check",
      decimals: 18,
      realWorld: { issuerName: "Demo Treasury LLC", category: "Treasury bills", underlyingDescription: "Simulated T-bills", documentUrl: null },
    });
    const token = asset.deployments[0].tokenAddress;
    const info = await publicClient.readContract({ address: token, abi: rwaTokenAbi, functionName: "rwaInfo" });
    expect(info.issuerName).toBe("Demo Treasury LLC");
    expect(info.documentUrl).toBe("");
    expect(await publicClient.readContract({ address: token, abi: rwaTokenAbi, functionName: "SIMULATED_BACKING" })).toBe(true);
  });

  // Steps 1 to 3 are each found onchain from a different event.
  it.each([1, 2, 3])("saves step %i when it landed but wasn't saved, without sending it again", async (lostStep) => {
    const salt = newSalt();
    const config = { type: "community", name: "Spike Resume", symbol: "SPKR", description: "Testnet check", decimals: 6 } as const;
    const records = memoryRecords(newAsset(config, salt, await computeCrossChainId(publicClient, account.address, salt)), lostStep);
    await expect(continueSetup("asset", ARC_TESTNET, wagmiConfig, records)).rejects.toThrow("page closed");
    expect(setupOn(records.current(), ARC_TESTNET.id).transactions).toHaveLength(lostStep);

    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });
    await continueSetup("asset", ARC_TESTNET, wagmiConfig, records);
    const saved = setupOn(records.current(), ARC_TESTNET.id).transactions;
    expect(saved).toHaveLength(ARC_SETUP_STEPS.length);
    // The lost step's saved hash is a real call to the contract that step targets.
    const tokenManager = await findTokenManager(publicClient, records.current().crossChainId);
    const targets = [CROSS_CHAIN_TOKEN_SERVICE, records.current().deployments[0].tokenAddress, tokenManager];
    const lost = await publicClient.getTransaction({ hash: saved[lostStep] });
    expect(lost.to?.toLowerCase()).toBe(targets[lostStep - 1]?.toLowerCase());
    // Only the steps after the lost one were sent on resume.
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonceBefore + ARC_SETUP_STEPS.length - 1 - lostStep);
  });
});

// Spends Sepolia ETH, which is scarce: run it alone with -t "Ethereum Sepolia".
describe("enable Ethereum Sepolia", () => {
  it("deploys, registers with the same salt, sets the bridge and the rate limit", { timeout: 600_000 }, async () => {
    const config = { type: "community", name: "Spike Network", symbol: "SPKN", description: "Testnet check", decimals: 6 } as const;
    const asset = (await launchOn(config, [ETHEREUM_SEPOLIA])).current();
    expect(setupOn(asset, ETHEREUM_SEPOLIA.id).transactions).toHaveLength(setupStepsOn(ETHEREUM_SEPOLIA).length);
    const token = asset.deployments.find((deployment) => deployment.chainId === ETHEREUM_SEPOLIA.id)?.tokenAddress;
    if (!token) throw new Error("No token was saved on Ethereum Sepolia");

    // Same issuer and salt, so CCTP knows the Sepolia token by Arc's cross-chain ID.
    expect(await computeCrossChainId(sepoliaClient, account.address, asset.salt)).toBe(asset.crossChainId);
    const resolved = await sepoliaClient.readContract({
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: crossChainTokenServiceAbi,
      functionName: "resolveTokenAddress",
      args: [asset.crossChainId],
    });
    expect(isAddressEqual(resolved, token)).toBe(true);
    const tokenManager = await findTokenManager(sepoliaClient, asset.crossChainId);
    if (!tokenManager) throw new Error("The token isn't registered with CCTP on Ethereum Sepolia");
    expect(await sepoliaClient.readContract({ address: token, abi: communityTokenAbi, functionName: "bridge" })).toBe(tokenManager);
    expect(await sepoliaClient.readContract({ address: tokenManager, abi: tokenManagerAbi, functionName: "rateLimit" })).toBeGreaterThan(BigInt(0));
  });
});
