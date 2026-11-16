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
import type { Hash } from "viem";
import { balanceOf, balanceOn, enabledChains, isChainEnabled, isSetupComplete, setupStepsOn, type Asset } from "./assets";
import { ARBITRUM_SEPOLIA, ARC_TESTNET, BASE_SEPOLIA } from "./chains";

const HASH: Hash = `0x${"ab".repeat(32)}`;
const SET_UP = { transactions: [HASH, HASH, HASH, HASH], sent: null };

describe("isChainEnabled", () => {
  it("is true once every step on that chain is confirmed", () => {
    const asset = {
      setups: {
        [ARC_TESTNET.id]: SET_UP,
        [BASE_SEPOLIA.id]: { transactions: [HASH], sent: { transactionHash: HASH, state: "pending" } },
      },
    } as const;
    expect(isChainEnabled(asset, ARC_TESTNET.id)).toBe(true);
    expect(isChainEnabled(asset, BASE_SEPOLIA.id)).toBe(false);
    // No saved step at all.
    expect(isChainEnabled(asset, ARBITRUM_SEPOLIA.id)).toBe(false);
  });
});

describe("enabledChains", () => {
  it("lists only the fully set-up chains", () => {
    const asset = { setups: { [ARC_TESTNET.id]: SET_UP, [BASE_SEPOLIA.id]: SET_UP, [ARBITRUM_SEPOLIA.id]: { transactions: [HASH], sent: null } } };
    expect(enabledChains(asset)).toEqual([ARC_TESTNET.id, BASE_SEPOLIA.id]);
  });
});

describe("isSetupComplete", () => {
  it("depends on Arc only, since minting happens there", () => {
    expect(isSetupComplete({ setups: { [ARC_TESTNET.id]: SET_UP } })).toBe(true);
    expect(isSetupComplete({ setups: { [BASE_SEPOLIA.id]: SET_UP } })).toBe(false);
  });
});

describe("setupStepsOn", () => {
  it("gives every chain the same four steps", () => {
    expect(setupStepsOn(BASE_SEPOLIA).map((step) => [step.chain.id, step.kind])).toEqual([
      [BASE_SEPOLIA.id, "deploy"],
      [BASE_SEPOLIA.id, "register"],
      [BASE_SEPOLIA.id, "grant-bridge"],
      [BASE_SEPOLIA.id, "rate-limit"],
    ]);
  });
});

describe("balanceOf", () => {
  it("throws for a holder whose balance wasn't read, instead of showing zero", () => {
    const deployment = {
      chainId: ARC_TESTNET.id,
      tokenAddress: "0x9b2eb67a98df1938fcc91aca53bb1f0d2024eca8",
      supply: BigInt(5),
      balances: { "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c": BigInt(5) },
    } as const;
    expect(balanceOf(deployment, "0x2f12bd0f9de5b3490e77bf1871f736954610b78c")).toBe(BigInt(5));
    expect(() => balanceOf(deployment, "0x1111111111111111111111111111111111111111")).toThrow("wasn't read");
  });
});

describe("balanceOn", () => {
  const asset: Pick<Asset, "deployments" | "symbol"> = {
    symbol: "MEME",
    deployments: [
      {
        chainId: BASE_SEPOLIA.id,
        tokenAddress: "0x9b2eb67a98df1938fcc91aca53bb1f0d2024eca8",
        supply: BigInt(7),
        balances: { "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c": BigInt(7) },
      },
    ],
  };

  it("reads the holder's balance on that chain", () => {
    expect(balanceOn(asset, BASE_SEPOLIA.id, "0x2f12bd0f9de5b3490e77bf1871f736954610b78c")).toBe(BigInt(7));
  });

  it("throws for a chain the asset isn't on, instead of showing zero", () => {
    expect(() => balanceOn(asset, ARC_TESTNET.id, "0x2f12bd0f9de5b3490e77bf1871f736954610b78c")).toThrow(
      "MEME has no deployment on Arc Testnet",
    );
  });

  it("throws for a balance that wasn't read", () => {
    expect(() => balanceOn(asset, BASE_SEPOLIA.id, "0x1111111111111111111111111111111111111111")).toThrow("wasn't read");
  });
});
