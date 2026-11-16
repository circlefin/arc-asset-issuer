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

// Mints real tokens on Arc Testnet through the same code the app runs.

import { createWalletClient, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { ARC_TESTNET } from "@/lib/chains";
import { communityTokenAbi } from "./artifacts";
import { mintOnce, sendIssuerMint } from "./mint";
import { account, launch, memoryMintRecords, publicClient, transport, wagmiConfig } from "./testnet-support";
import { walletFor } from "./wallet";

vi.mock("./wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wallet")>()),
  walletFor: vi.fn(),
}));

describe("issuer minting on Arc Testnet", () => {
  it("lets the issuer mint new supply and stops any other wallet before it signs", async () => {
    const asset = await launch({ type: "community", name: "Spike Mint", symbol: "SPKT", description: "Testnet check", decimals: 6 });
    const token = asset.deployments[0].tokenAddress;
    const recipient: Address = "0x1111111111111111111111111111111111111111";

    const records = memoryMintRecords();
    const send = () => sendIssuerMint(asset, recipient, BigInt(1000), wagmiConfig);
    const transactionHash = await mintOnce({ read: () => null, write: () => {}, clear: () => {} }, send, records, wagmiConfig);
    expect(records.current()).toEqual({ state: "confirmed", transactionHash });
    expect(await publicClient.readContract({ address: token, abi: communityTokenAbi, functionName: "balanceOf", args: [recipient] })).toBe(BigInt(1000));
    expect(await publicClient.readContract({ address: token, abi: communityTokenAbi, functionName: "issuedSupply" })).toBe(BigInt(1000));

    // A fresh wallet with no gas: the simulation stops it, so it's never asked to sign.
    const stranger = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: ARC_TESTNET.network, transport });
    vi.mocked(walletFor).mockResolvedValueOnce(stranger);
    await expect(sendIssuerMint(asset, recipient, BigInt(1), wagmiConfig)).rejects.toThrow("Only the issuer wallet can mint SPKT");
    expect(account.address).not.toBe(stranger.account.address);
  });
});
