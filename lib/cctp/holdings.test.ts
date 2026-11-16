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

import { readFileSync } from "node:fs";
import { getAddress, numberToHex, pad, type Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { ARBITRUM_SEPOLIA, ARC_TESTNET, BASE_SEPOLIA } from "@/lib/chains";
import { Constants } from "@/lib/database.types";
import { fakeChains, type FakeNode } from "./fake-chain";
import {
  holdersToRead,
  IN_FLIGHT_STATES,
  inFlightTransfersSentBy,
  MAX_HOLDERS_READ,
  readHoldings,
  reconcileSupply,
} from "./holdings";

const ARC_TOKEN: Address = "0x9b2eb67a98df1938fcc91aca53bb1f0d2024eca8";
const BASE_TOKEN: Address = "0x320f4e6ee054723acf45392fd545fa35c042e8a1";
const ARBITRUM_TOKEN: Address = "0x5c2a7f1e3b0d4a6e8f9c1b2d3e4f5a6b7c8d9e0f";
const ISSUER: Address = "0x2f12bd0f9de5b3490e77bf1871f736954610b78c";
const HOLDER: Address = "0x1111111111111111111111111111111111111111";
const OTHER_SENDER: Address = "0x2222222222222222222222222222222222222222";
// The migration whose public.in_flight_transfer_totals sums the in-flight states.
const IN_FLIGHT_TOTALS_MIGRATION = new URL(
  "../../supabase/migrations/20261027210000_in_flight_transfer_totals.sql",
  import.meta.url,
);

type TokenState = { supply: bigint; issued?: bigint; balances: Partial<Record<Address, bigint>> };

// Answers for the token deployed on the node's chain.
function deployToken(node: FakeNode, token: TokenState) {
  node.read.mockImplementation(({ functionName, args }) => {
    if (functionName === "totalSupply") return token.supply;
    if (functionName === "issuedSupply") return token.issued;
    const [holder] = args;
    if (functionName === "balanceOf" && typeof holder === "string") return token.balances[getAddress(holder)] ?? BigInt(0);
    throw new Error(`Unexpected read ${functionName}`);
  });
}

let chains: ReturnType<typeof fakeChains>;

beforeEach(() => {
  chains = fakeChains();
});

describe("holdersToRead", () => {
  it("reads each holder once, whatever the address's case", () => {
    const upperCase: Address = `0x${ISSUER.slice(2).toUpperCase()}`;
    expect(holdersToRead([HOLDER, ISSUER, getAddress(ISSUER), upperCase])).toEqual([
      getAddress(HOLDER),
      getAddress(ISSUER),
    ]);
  });

  it("refuses more holders than the cap, instead of reading some of them", () => {
    const many = Array.from({ length: MAX_HOLDERS_READ + 1 }, (_, index) => numberToAddress(index + 1));
    expect(holdersToRead(many.slice(0, MAX_HOLDERS_READ))).toHaveLength(MAX_HOLDERS_READ);
    expect(() => holdersToRead(many)).toThrow(`more than the ${MAX_HOLDERS_READ} this page reads`);
  });
});

function numberToAddress(value: number): Address {
  return getAddress(pad(numberToHex(value), { size: 20 }));
}

describe("readHoldings", () => {
  it("fails, reading nothing, above the holder cap", async () => {
    const many = Array.from({ length: MAX_HOLDERS_READ + 1 }, (_, index) => numberToAddress(index + 1));
    await expect(
      readHoldings([{ chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN }], many, chains.wagmiConfig),
    ).rejects.toThrow("Balances and supply can't be shown");
    expect(chains.arc.read).not.toHaveBeenCalled();
  });


  it("reads supply and balances on Arc, with nothing in transit", async () => {
    deployToken(chains.arc, { supply: BigInt(100), issued: BigInt(100), balances: { [getAddress(HOLDER)]: BigInt(100) } });
    const holdings = await readHoldings([{ chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN }], [ISSUER, HOLDER], chains.wagmiConfig);
    expect(holdings).toEqual({
      deployments: [{
        chainId: ARC_TESTNET.id,
        tokenAddress: ARC_TOKEN,
        supply: BigInt(100),
        balances: { [getAddress(ISSUER)]: BigInt(0), [getAddress(HOLDER)]: BigInt(100) },
      }],
      inTransit: BigInt(0),
    });
  });

  it("counts what was issued but isn't on any chain as in transit", async () => {
    deployToken(chains.arc, { supply: BigInt(70), issued: BigInt(100), balances: {} });
    deployToken(chains.base, { supply: BigInt(20), balances: {} });
    const holdings = await readHoldings(
      [
        { chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN },
        { chainId: BASE_SEPOLIA.id, tokenAddress: BASE_TOKEN },
      ],
      [HOLDER],
      chains.wagmiConfig,
    );
    expect(holdings.inTransit).toBe(BigInt(10));
  });

  it("reads every network's token, counting the rest of what was issued as in transit", async () => {
    deployToken(chains.arc, { supply: BigInt(50), issued: BigInt(100), balances: {} });
    deployToken(chains.base, { supply: BigInt(20), balances: {} });
    deployToken(chains.arbitrum, { supply: BigInt(10), balances: {} });
    const holdings = await readHoldings(
      [
        { chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN },
        { chainId: BASE_SEPOLIA.id, tokenAddress: BASE_TOKEN },
        { chainId: ARBITRUM_SEPOLIA.id, tokenAddress: ARBITRUM_TOKEN },
      ],
      [HOLDER],
      chains.wagmiConfig,
    );
    expect(holdings.deployments.map((deployment) => [deployment.chainId, deployment.supply])).toEqual([
      [ARC_TESTNET.id, BigInt(50)],
      [BASE_SEPOLIA.id, BigInt(20)],
      [ARBITRUM_SEPOLIA.id, BigInt(10)],
    ]);
    expect(holdings.inTransit).toBe(BigInt(20));
  });

  it("fails as a whole when one network's read fails, instead of leaving it out", async () => {
    deployToken(chains.arc, { supply: BigInt(50), issued: BigInt(100), balances: {} });
    deployToken(chains.base, { supply: BigInt(20), balances: {} });
    chains.arbitrum.read.mockImplementation(() => {
      throw new Error("fetch failed");
    });
    await expect(
      readHoldings(
        [
          { chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN },
          { chainId: BASE_SEPOLIA.id, tokenAddress: BASE_TOKEN },
          { chainId: ARBITRUM_SEPOLIA.id, tokenAddress: ARBITRUM_TOKEN },
        ],
        [HOLDER],
        chains.wagmiConfig,
      ),
    ).rejects.toThrow("fetch failed");
  });

  it("fails as a whole when any read fails, instead of showing a partial balance", async () => {
    chains.arc.read.mockImplementation(({ functionName }) => {
      if (functionName === "balanceOf") throw new Error("fetch failed");
      return BigInt(100);
    });
    await expect(
      readHoldings([{ chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN }], [HOLDER], chains.wagmiConfig),
    ).rejects.toThrow("fetch failed");
  });

  it("reads issued supply and Arc's supply at the same Arc block", async () => {
    deployToken(chains.arc, { supply: BigInt(80), issued: BigInt(100), balances: {} });
    deployToken(chains.base, { supply: BigInt(20), balances: {} });
    chains.arc.blockNumber = BigInt(4242);
    await readHoldings(
      [
        { chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN },
        { chainId: BASE_SEPOLIA.id, tokenAddress: BASE_TOKEN },
      ],
      [HOLDER],
      chains.wagmiConfig,
    );
    const blockOf = (functionName: string) =>
      chains.arc.read.mock.calls.find(([call]) => call.functionName === functionName)?.[0].block;
    expect(blockOf("issuedSupply")).toBe(BigInt(4242));
    expect(blockOf("totalSupply")).toBe(BigInt(4242));
  });

  describe("when the networks seem to hold more than Arc issued", () => {
    const tokens = [
      { chainId: ARC_TESTNET.id, tokenAddress: ARC_TOKEN },
      { chainId: BASE_SEPOLIA.id, tokenAddress: BASE_TOKEN },
    ];
    const issuedReads = () =>
      chains.arc.read.mock.calls.filter(([call]) => call.functionName === "issuedSupply").length;

    it("reads once more, and shows the second read, when a transfer was counted on both chains", async () => {
      deployToken(chains.arc, { supply: BigInt(80), issued: BigInt(100), balances: {} });
      // Base's mint was read before Arc's newer block showed the burn. Read again, Arc shows it.
      const arcSupplies = [BigInt(80), BigInt(70)];
      const arcRead = chains.arc.read.getMockImplementation();
      chains.arc.read.mockImplementation((call) =>
        call.functionName === "totalSupply" ? (arcSupplies.shift() ?? BigInt(70)) : arcRead?.(call),
      );
      deployToken(chains.base, { supply: BigInt(30), balances: {} });
      const holdings = await readHoldings(tokens, [HOLDER], chains.wagmiConfig);
      expect(holdings.inTransit).toBe(BigInt(0));
      expect(holdings.deployments.map((deployment) => deployment.supply)).toEqual([BigInt(70), BigInt(30)]);
      expect(issuedReads()).toBe(2);
      expect(reconcileSupply({ inTransit: holdings.inTransit, inTransitKnown: BigInt(0) })).toEqual({ kind: "reconciled" });
    });

    it("flags it when the second read still shows more than was issued", async () => {
      deployToken(chains.arc, { supply: BigInt(80), issued: BigInt(100), balances: {} });
      deployToken(chains.base, { supply: BigInt(30), balances: {} });
      const holdings = await readHoldings(tokens, [HOLDER], chains.wagmiConfig);
      expect(holdings.inTransit).toBe(BigInt(-10));
      expect(issuedReads()).toBe(2);
      expect(reconcileSupply({ inTransit: holdings.inTransit, inTransitKnown: BigInt(0) })).toEqual({
        kind: "supply-above-issued",
        excess: BigInt(10),
      });
    });

    it("reads only once when nothing reads negative", async () => {
      deployToken(chains.arc, { supply: BigInt(80), issued: BigInt(100), balances: {} });
      deployToken(chains.base, { supply: BigInt(20), balances: {} });
      await readHoldings(tokens, [HOLDER], chains.wagmiConfig);
      expect(issuedReads()).toBe(1);
    });
  });

  it("reads nothing before the token is deployed", async () => {
    await expect(readHoldings([], [ISSUER], chains.wagmiConfig)).resolves.toEqual({ deployments: [], inTransit: BigInt(0) });
    expect(chains.arc.read).not.toHaveBeenCalled();
  });
});

describe("IN_FLIGHT_STATES", () => {
  it("is exactly the transfers burned on the source and not yet delivered", () => {
    const counted = Constants.public.Enums.transfer_state.filter((state) => IN_FLIGHT_STATES.includes(state));
    expect(counted.toSorted()).toEqual(
      ["awaiting-attestation", "delivering", "delivery-failed", "source-submitted"].toSorted(),
    );
  });

  it("matches the states the database sums", () => {
    const migration = readFileSync(IN_FLIGHT_TOTALS_MIGRATION, "utf8");
    const states = migration.match(/transfer\.state in \(([^)]*)\)/)?.[1];
    expect(states?.split(",").map((state) => state.trim().replace(/^'|'$/g, "")).toSorted()).toEqual(
      IN_FLIGHT_STATES.toSorted(),
    );
  });
});

describe("inFlightTransfersSentBy", () => {
  it("picks the sender's transfers still saved as in flight", () => {
    const transfers = [
      { id: "mine-delivering", state: "delivering", sender: HOLDER },
      { id: "mine-complete", state: "complete", sender: HOLDER },
      { id: "mine-waiting", state: "approval-required", sender: HOLDER },
      { id: "theirs-delivering", state: "delivering", sender: OTHER_SENDER },
      { id: "mine-failed", state: "delivery-failed", sender: getAddress(HOLDER) },
    ] as const;
    expect(inFlightTransfersSentBy([...transfers], HOLDER).map((transfer) => transfer.id)).toEqual([
      "mine-delivering",
      "mine-failed",
    ]);
  });
});

describe("reconcileSupply", () => {
  it("reconciles when the transfers in flight explain everything in transit", () => {
    expect(reconcileSupply({ inTransit: BigInt(20), inTransitKnown: BigInt(20) })).toEqual({ kind: "reconciled" });
  });

  it("reconciles when more is in transit than the app's transfers, as from a transfer made elsewhere", () => {
    expect(reconcileSupply({ inTransit: BigInt(20), inTransitKnown: BigInt(5) })).toEqual({ kind: "reconciled" });
  });

  it("flags transfers in flight that add up to more than is in transit", () => {
    expect(reconcileSupply({ inTransit: BigInt(20), inTransitKnown: BigInt(30) })).toEqual({
      kind: "transfers-exceed-in-transit",
      unaccounted: BigInt(10),
    });
  });

  it("flags more supply on the networks than was ever issued", () => {
    expect(reconcileSupply({ inTransit: BigInt(-5), inTransitKnown: BigInt(0) })).toEqual({
      kind: "supply-above-issued",
      excess: BigInt(5),
    });
  });
});
