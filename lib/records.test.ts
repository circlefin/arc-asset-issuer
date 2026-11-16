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

import { PostgrestError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BurnRecordedError, DeliveryRecordedError } from "./activity";
import { hasHoldings } from "./assets";
import { readHoldings } from "./cctp/holdings";
import {
  isDestinationHashTaken,
  isSourceHashTaken,
  toDeployments,
  toInFlightTotals,
  toListedRecords,
  toProgressError,
  toSetups,
} from "./records";
import { supabase } from "./supabase";

// The rows are converted without touching Supabase or a chain: the in-flight sums and the chain
// reads are stand-ins each test sets.
vi.mock("./supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://example.com/image" } }) }) },
  },
}));
vi.mock("./wagmi", () => ({ wagmiConfig: {} }));
vi.mock("./cctp/holdings", () => ({ readHoldings: vi.fn() }));

const ARC_DEPLOY = `0x${"a0".repeat(32)}`;
const ARC_REGISTER = `0x${"a1".repeat(32)}`;
const BASE_DEPLOY = `0x${"b0".repeat(32)}`;
const BASE_RESENT = `0x${"b1".repeat(32)}`;
const ARC_TOKEN = `0x${"2".repeat(40)}`;
const ASSET_ID = "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b";
const OTHER_ASSET_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
// The most a uint256 holds, beyond what a JSON number keeps exact.
const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

describe("toSetups", () => {
  it("groups each chain's steps in order, with its sent step", () => {
    const setups = toSetups([
      { chain: "base-sepolia", step: 1, transaction_hash: BASE_RESENT, token_address: null, state: "reverted", created_at: "2026-10-27T12:00:00Z" },
      { chain: "arc-testnet", step: 1, transaction_hash: ARC_REGISTER, token_address: null, state: "confirmed", created_at: "2026-10-27T12:00:00Z" },
      { chain: "base-sepolia", step: 0, transaction_hash: BASE_DEPLOY, token_address: null, state: "pending", created_at: "2026-10-27T12:00:00Z" },
      { chain: "arc-testnet", step: 0, transaction_hash: ARC_DEPLOY, token_address: ARC_TOKEN, state: "confirmed", created_at: "2026-10-27T12:00:00Z" },
    ]);
    expect(setups).toEqual({
      "arc-testnet": { transactions: [ARC_DEPLOY, ARC_REGISTER], sent: null },
      "base-sepolia": { transactions: [], sent: { transactionHash: BASE_DEPLOY, state: "pending" } },
    });
  });

  it("leaves out chains with no saved step", () => {
    expect(toSetups([])).toEqual({});
  });
});

describe("toDeployments", () => {
  it("takes each chain's token from its confirmed deploy", () => {
    expect(
      toDeployments([
        { chain: "arc-testnet", step: 0, transaction_hash: ARC_DEPLOY, token_address: ARC_TOKEN, state: "confirmed", created_at: "2026-10-27T12:00:00Z" },
        { chain: "base-sepolia", step: 0, transaction_hash: BASE_DEPLOY, token_address: null, state: "pending", created_at: "2026-10-27T12:00:00Z" },
      ]),
    ).toEqual([{ chainId: "arc-testnet", tokenAddress: "0x2222222222222222222222222222222222222222" }]);
  });
});

describe("isSourceHashTaken", () => {
  it("is a unique violation on the transfer's burn hash", () => {
    const message = 'duplicate key value violates unique constraint "transfers_source_transaction_hash_key"';
    expect(isSourceHashTaken({ code: "23505", message })).toBe(true);
  });

  it("isn't a unique violation on another column, or another error naming the constraint", () => {
    const other = 'duplicate key value violates unique constraint "transfers_destination_transaction_hash_key"';
    expect(isSourceHashTaken({ code: "23505", message: other })).toBe(false);
    expect(isSourceHashTaken({ code: "23514", message: 'violates "transfers_source_transaction_hash_key"' })).toBe(false);
  });
});

describe("toProgressError", () => {
  const unique = (constraint: string) => ({ code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` });

  it("names a burn hash another transfer holds", () => {
    expect(toProgressError(unique("transfers_source_transaction_hash_key"))).toBeInstanceOf(BurnRecordedError);
  });

  it("names a delivery hash another transfer holds, keeping the database's error", () => {
    const error = unique("transfers_destination_transaction_hash_key");
    expect(isDestinationHashTaken(error)).toBe(true);
    const mapped = toProgressError(error);
    expect(mapped).toBeInstanceOf(DeliveryRecordedError);
    expect(mapped).toHaveProperty("message", expect.stringContaining("delivery is already recorded by another transfer"));
    expect(mapped).toHaveProperty("cause", error);
  });

  it("passes any other error through as it came", () => {
    const error = { code: "42501", message: "permission denied" };
    expect(toProgressError(error)).toBe(error);
  });
});

describe("toInFlightTotals", () => {
  it("reads each asset's sum exactly, past what a JSON number holds", () => {
    const inFlightOf = toInFlightTotals([
      { asset_id: ASSET_ID, amount: MAX_UINT256 },
      { asset_id: OTHER_ASSET_ID, amount: "0" },
    ]);
    expect(inFlightOf(ASSET_ID)).toBe(BigInt(MAX_UINT256));
    expect(inFlightOf(OTHER_ASSET_ID)).toBe(BigInt(0));
  });

  it("throws for an asset the read left out, instead of counting zero", () => {
    const inFlightOf = toInFlightTotals([{ asset_id: ASSET_ID, amount: "5" }]);
    expect(() => inFlightOf(OTHER_ASSET_ID)).toThrow(OTHER_ASSET_ID);
  });

  it("throws for a sum that isn't a whole number", () => {
    expect(() => toInFlightTotals([{ asset_id: ASSET_ID, amount: "1.5" }])).toThrow();
  });
});

describe("toListedRecords", () => {
  const ISSUER = "0x2f12bd0f9de5b3490e77bf1871f736954610b78c";
  const CAPPED = "This asset has 101 wallets to read balances for, more than the 100 this page reads.";

  function assetRow(id: string, name: string): Parameters<typeof toListedRecords>[0][number] {
    return {
      id,
      issuer: ISSUER,
      type: "community",
      name,
      symbol: name.toUpperCase(),
      description: "A test token",
      decimals: 6,
      cross_chain_id: `0x${"5a".repeat(32)}`,
      salt: `0x${"5b".repeat(32)}`,
      issuer_name: null,
      category: null,
      underlying_description: null,
      document_url: null,
      created_at: "2026-10-27T12:00:00Z",
      setup_transactions: [
        { chain: "arc-testnet", step: 0, transaction_hash: ARC_DEPLOY, token_address: ARC_TOKEN, state: "confirmed", created_at: "2026-10-27T12:00:00Z" },
      ],
      issuer_mints: [],
      transfers: [],
    };
  }

  function sumsRead(error: PostgrestError | null = null) {
    vi.mocked(supabase.rpc).mockResolvedValue(
      error
        ? { data: null, error, count: null, status: 500, statusText: "", success: false }
        : {
            data: [{ asset_id: ASSET_ID, amount: "0" }, { asset_id: OTHER_ASSET_ID, amount: "0" }],
            error: null,
            count: null,
            status: 200,
            statusText: "",
            success: true,
          },
    );
  }

  beforeEach(() => {
    vi.mocked(readHoldings).mockReset();
  });

  it("keeps an asset whose balances can't be read in the list, with why, and still loads the others", async () => {
    sumsRead();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(readHoldings)
      .mockRejectedValueOnce(new Error(CAPPED))
      .mockResolvedValue({ deployments: [], inTransit: BigInt(0) });
    const records = await toListedRecords([assetRow(ASSET_ID, "capped"), assetRow(OTHER_ASSET_ID, "fine")], null);
    const [capped, fine] = records.map((record) => record.asset);
    expect(hasHoldings(capped)).toBe(false);
    expect(!hasHoldings(capped) && capped.holdingsError).toEqual(new Error(CAPPED));
    expect(hasHoldings(fine)).toBe(true);
    expect(hasHoldings(fine) && fine.inTransit).toBe(BigInt(0));
    // The raw error is kept for debugging.
    expect(logged).toHaveBeenCalledWith(new Error(CAPPED));
    logged.mockRestore();
  });

  it("lists the launch, then each network whose setup started, from its first saved step", async () => {
    sumsRead();
    vi.mocked(readHoldings).mockResolvedValue({ deployments: [], inTransit: BigInt(0) });
    const row = assetRow(ASSET_ID, "networked");
    row.setup_transactions.push(
      { chain: "base-sepolia", step: 1, transaction_hash: BASE_RESENT, token_address: null, state: "pending", created_at: "2026-10-28T09:05:00Z" },
      { chain: "base-sepolia", step: 0, transaction_hash: BASE_DEPLOY, token_address: null, state: "confirmed", created_at: "2026-10-28T09:00:00Z" },
    );
    const [record] = await toListedRecords([row], null);
    expect(record.setups.map(({ kind, chainId, createdAt }) => ({ kind, chainId, createdAt }))).toEqual([
      { kind: "setup", chainId: "arc-testnet", createdAt: new Date("2026-10-27T12:00:00Z") },
      { kind: "network-setup", chainId: "base-sepolia", createdAt: new Date("2026-10-28T09:00:00Z") },
    ]);
  });

  it("fails the whole list when the in-flight sums can't be read", async () => {
    sumsRead(new PostgrestError({ message: "connection reset", details: "", hint: "", code: "" }));
    vi.mocked(readHoldings).mockResolvedValue({ deployments: [], inTransit: BigInt(0) });
    await expect(toListedRecords([assetRow(ASSET_ID, "fine")], null)).rejects.toThrow("connection reset");
  });
});
