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

import type { Address, Hash } from "viem";
import { describe, expect, it } from "vitest";
import type { Asset } from "../assets";
import { ARBITRUM_SEPOLIA, ARC_TESTNET, BASE_SEPOLIA, ETHEREUM_SEPOLIA, type ChainId } from "../chains";
import { holderRoutes, isRoute, routeLabel, transferRoutes } from "./routes";

describe("transferRoutes", () => {
  it("has no routes when only Arc is enabled", () => {
    expect(transferRoutes([ARC_TESTNET.id], [ARC_TESTNET.id, BASE_SEPOLIA.id])).toEqual([]);
  });

  // Networks follow the order of the chain list, whatever order they were enabled in.
  it("goes from Arc to each enabled network", () => {
    const routes = transferRoutes(
      [ARC_TESTNET.id, BASE_SEPOLIA.id, ARBITRUM_SEPOLIA.id],
      [ARC_TESTNET.id],
    );
    expect(routes).toEqual([
      { source: ARC_TESTNET, destination: ARBITRUM_SEPOLIA },
      { source: ARC_TESTNET, destination: BASE_SEPOLIA },
    ]);
    expect(routes.map(routeLabel)).toEqual(["Arbitrum Sepolia", "Base Sepolia"]);
  });

  it("adds a route back to Arc from an enabled network the holder holds on", () => {
    const routes = transferRoutes(
      [ARC_TESTNET.id, BASE_SEPOLIA.id, ARBITRUM_SEPOLIA.id],
      [BASE_SEPOLIA.id],
    );
    expect(routes.at(-1)).toEqual({ source: BASE_SEPOLIA, destination: ARC_TESTNET });
    expect(routes.map(routeLabel)).toEqual([
      "Arbitrum Sepolia",
      "Base Sepolia",
      "Arc Testnet · from Base Sepolia",
    ]);
  });

  it("never routes from a network the holder holds on but isn't enabled", () => {
    expect(transferRoutes([ARC_TESTNET.id, BASE_SEPOLIA.id], [ARBITRUM_SEPOLIA.id])).toEqual([
      { source: ARC_TESTNET, destination: BASE_SEPOLIA },
    ]);
  });

  it("never routes between two networks", () => {
    const routes = transferRoutes(
      [ARC_TESTNET.id, BASE_SEPOLIA.id, ARBITRUM_SEPOLIA.id],
      [ARC_TESTNET.id, BASE_SEPOLIA.id, ARBITRUM_SEPOLIA.id],
    );
    for (const route of routes) {
      expect([route.source.id, route.destination.id]).toContain(ARC_TESTNET.id);
    }
  });

  it("never makes a network that isn't enabled a destination", () => {
    const routes = transferRoutes([ARC_TESTNET.id, BASE_SEPOLIA.id], [ARC_TESTNET.id]);
    expect(routes.map((route) => route.destination.id)).not.toContain(ARBITRUM_SEPOLIA.id);
  });
});

describe("routeLabel", () => {
  it("names the way back to Arc after the network it leaves", () => {
    expect(routeLabel({ source: ETHEREUM_SEPOLIA, destination: ARC_TESTNET })).toBe(
      "Arc Testnet · from Ethereum Sepolia",
    );
    expect(routeLabel({ source: ARC_TESTNET, destination: ETHEREUM_SEPOLIA })).toBe(
      "Ethereum Sepolia",
    );
  });
});

describe("isRoute", () => {
  it("is true when exactly one side is Arc", () => {
    expect(isRoute(ARC_TESTNET, BASE_SEPOLIA)).toBe(true);
    expect(isRoute(BASE_SEPOLIA, ARC_TESTNET)).toBe(true);
  });

  it("is false between two networks or from Arc to itself", () => {
    expect(isRoute(BASE_SEPOLIA, ARBITRUM_SEPOLIA)).toBe(false);
    expect(isRoute(ARC_TESTNET, ARC_TESTNET)).toBe(false);
  });
});

describe("holderRoutes", () => {
  const HOLDER: Address = "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c";
  const HASH: Hash = `0x${"ab".repeat(32)}`;
  const SET_UP = { transactions: [HASH, HASH, HASH, HASH], sent: null };

  function deployment(chainId: ChainId, balance: bigint | undefined) {
    return {
      chainId,
      tokenAddress: "0x9b2eb67a98df1938fcc91aca53bb1f0d2024eca8",
      supply: BigInt(100),
      balances: balance === undefined ? {} : { [HOLDER]: balance },
    } as const;
  }

  function assetHolding(arc: bigint | undefined, base: bigint | undefined): Pick<Asset, "setups" | "deployments"> {
    return {
      setups: { [ARC_TESTNET.id]: SET_UP, [BASE_SEPOLIA.id]: SET_UP },
      deployments: [deployment(ARC_TESTNET.id, arc), deployment(BASE_SEPOLIA.id, base)],
    };
  }

  it("adds the way back from a network only while the holder holds there", () => {
    expect(holderRoutes(assetHolding(BigInt(5), BigInt(3)), HOLDER).map(routeLabel)).toEqual([
      "Base Sepolia",
      "Arc Testnet · from Base Sepolia",
    ]);
    expect(holderRoutes(assetHolding(BigInt(5), BigInt(0)), HOLDER).map(routeLabel)).toEqual(["Base Sepolia"]);
  });

  it("offers Arc's routes without a wallet", () => {
    expect(holderRoutes(assetHolding(undefined, undefined), null).map(routeLabel)).toEqual(["Base Sepolia"]);
  });

  it("has no routes before the issuer enables a network", () => {
    const asset = { setups: { [ARC_TESTNET.id]: SET_UP }, deployments: [deployment(ARC_TESTNET.id, BigInt(5))] };
    expect(holderRoutes(asset, HOLDER)).toEqual([]);
  });

  it("throws when a balance wasn't read, instead of hiding the route", () => {
    expect(() => holderRoutes(assetHolding(BigInt(5), undefined), HOLDER)).toThrow("wasn't read");
  });
});
