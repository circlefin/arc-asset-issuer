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

import { getAddress, type Address, type Hash } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuerMintActivity, MintState } from "@/lib/activity";
import type { SavedAsset } from "@/lib/assets";
import { ARC_TESTNET } from "@/lib/chains";
import { communityTokenAbi } from "./artifacts";
import { decodeSent, fakeChains, revertWith, walletOn, type FakeNode, type SentTransaction } from "./fake-chain";
import {
  estimateMintCost,
  mintOnce,
  MintSentError,
  sendIssuerMint,
  type MintRecords,
  type UnsavedMintSlot,
} from "./mint";
import { walletFor } from "./wallet";

vi.mock("./wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wallet")>()),
  walletFor: vi.fn(),
}));

const ISSUER: Address = "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c";
const RECIPIENT: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x9b2eb67a98df1938fcc91aca53bb1f0d2024eca8";
const MINT_HASH: Hash = `0x${"ab".repeat(32)}`;
const RESENT_HASH: Hash = `0x${"cd".repeat(32)}`;
const SPED_UP_HASH: Hash = `0x${"ef".repeat(32)}`;

const asset: SavedAsset = {
  type: "community",
  name: "Meme",
  symbol: "MEME",
  description: "A test token",
  decimals: 6,
  id: "7d4c8a52-3f0e-4b1a-9a8e-1c2d3e4f5a6b",
  issuer: ISSUER,
  imageUrl: "https://example.com/meme.png",
  createdAt: new Date("2026-10-21T00:00:00Z"),
  crossChainId: `0x${"5a".repeat(32)}`,
  salt: `0x${"5b".repeat(32)}`,
  setups: {},
  deployments: [{ chainId: ARC_TESTNET.id, tokenAddress: TOKEN }],
};

let arc: FakeNode;
let wagmiConfig: ReturnType<typeof fakeChains>["wagmiConfig"];

beforeEach(() => {
  vi.clearAllMocks();
  ({ arc, wagmiConfig } = fakeChains());
  arc.nextHash.mockReturnValue(MINT_HASH);
  arc.read.mockImplementation(() => undefined);
  vi.mocked(walletFor).mockResolvedValue(walletOn(arc, ISSUER));
});

afterEach(() => vi.useRealTimers());

describe("sendIssuerMint", () => {
  it("sends a mint on Arc's token from the connected wallet and returns its hash", async () => {
    await expect(sendIssuerMint(asset, RECIPIENT, BigInt(1000), wagmiConfig)).resolves.toBe(MINT_HASH);
    expect(walletFor).toHaveBeenCalledWith(wagmiConfig, ARC_TESTNET);
    expect(arc.sent).toHaveLength(1);
    expect(arc.sent[0].from).toBe(ISSUER);
    expect(arc.sent[0].to).toBe(TOKEN);
    expect(decodeSent(arc.sent[0])).toEqual({ functionName: "mint", args: [RECIPIENT, BigInt(1000)] });
  });

  it("stops a wallet that isn't the issuer before it signs anything", async () => {
    arc.read.mockImplementation((call) => {
      throw revertWith(communityTokenAbi, "MintNotAllowed", [call.from]);
    });
    await expect(sendIssuerMint(asset, RECIPIENT, BigInt(1000), wagmiConfig)).rejects.toThrow(
      "Only the issuer wallet can mint MEME",
    );
    expect(arc.sent).toHaveLength(0);
  });
});

describe("estimateMintCost", () => {
  it("is the mint's estimated gas at the max fee", async () => {
    arc.gas = BigInt(80_000);
    arc.tip = BigInt(20_000_000_000);
    await expect(estimateMintCost(asset, wagmiConfig)).resolves.toBe(BigInt(80_000) * BigInt(20_000_000_000));
  });
});

describe("mintOnce", () => {
  type Saved = Pick<IssuerMintActivity, "state" | "transactionHash">;

  // Stands in for Supabase: the order's mint row, if saved.
  function memoryRecords(initial: Saved | null = null) {
    let saved = initial;
    const records = {
      current: () => saved,
      fetchSaved: vi.fn(async () => saved),
      saveSent: vi.fn(async (transactionHash: Hash) => {
        saved = { state: "pending", transactionHash };
      }),
      saveProgress: vi.fn(async (state: MintState, transactionHash: Hash) => {
        saved = { state, transactionHash };
      }),
    } satisfies MintRecords & { current: () => Saved | null };
    return records;
  }

  function send() {
    return sendIssuerMint(asset, RECIPIENT, BigInt(1000), wagmiConfig);
  }

  // Stands in for localStorage: the order's sent mint, until it's saved.
  function memorySlot() {
    let held: Hash | null = null;
    return {
      read: () => held,
      write: (transactionHash: Hash) => {
        held = transactionHash;
      },
      clear: () => {
        held = null;
      },
    } satisfies UnsavedMintSlot;
  }

  it("saves the mint as soon as it's sent, then saves it as confirmed once it lands", async () => {
    const records = memoryRecords();
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).resolves.toBe(MINT_HASH);
    expect(records.saveSent).toHaveBeenCalledWith(MINT_HASH);
    expect(records.current()).toEqual({ state: "confirmed", transactionHash: MINT_HASH });
  });

  it("waits for a sent mint on retry instead of sending another, when waiting failed", async () => {
    const records = memoryRecords();
    arc.receipt.error = new Error("fetch failed");
    // viem keeps retrying a failed lookup for several seconds before it gives up.
    vi.useFakeTimers();
    const waiting = expect(mintOnce(memorySlot(), send, records, wagmiConfig)).rejects.toThrow(MintSentError);
    await vi.runAllTimersAsync();
    await waiting;
    expect(records.current()).toEqual({ state: "pending", transactionHash: MINT_HASH });

    arc.receipt.error = null;
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).resolves.toBe(MINT_HASH);
    expect(arc.sent).toHaveLength(1);
    expect(records.current()).toEqual({ state: "confirmed", transactionHash: MINT_HASH });
  });

  it("saves a sent mint again on retry, without sending it again, when saving failed", async () => {
    const records = memoryRecords();
    records.saveSent.mockRejectedValueOnce(new Error("Supabase is down"));
    const unsaved = memorySlot();
    await expect(mintOnce(unsaved, send, records, wagmiConfig)).rejects.toThrow(MintSentError);
    expect(unsaved.read()).toBe(MINT_HASH);
    await expect(mintOnce(unsaved, send, records, wagmiConfig)).resolves.toBe(MINT_HASH);
    expect(arc.sent).toHaveLength(1);
    expect(unsaved.read()).toBeNull();
  });

  it("only checks again after saving how a landed mint ended failed", async () => {
    const records = memoryRecords();
    records.saveProgress.mockRejectedValueOnce(new Error("Supabase is down"));
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).rejects.toThrow(MintSentError);
    expect(records.current()).toEqual({ state: "pending", transactionHash: MINT_HASH });
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).resolves.toBe(MINT_HASH);
    expect(arc.sent).toHaveLength(1);
    expect(records.current()).toEqual({ state: "confirmed", transactionHash: MINT_HASH });
  });

  it("doesn't send or wait again for a mint already confirmed", async () => {
    const records = memoryRecords({ state: "confirmed", transactionHash: MINT_HASH });
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).resolves.toBe(MINT_HASH);
    expect(arc.sent).toHaveLength(0);
    expect(records.saveProgress).not.toHaveBeenCalled();
  });

  it("saves a reverted mint as reverted, and sends it again on retry", async () => {
    const records = memoryRecords();
    arc.receipt.status = "reverted";
    const reverted = mintOnce(memorySlot(), send, records, wagmiConfig);
    await expect(reverted).rejects.toThrow("nothing was minted");
    await expect(reverted).rejects.not.toThrow(MintSentError);
    expect(records.current()).toEqual({ state: "reverted", transactionHash: MINT_HASH });

    arc.receipt.status = "success";
    arc.nextHash.mockReturnValue(RESENT_HASH);
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).resolves.toBe(RESENT_HASH);
    expect(arc.sent).toHaveLength(2);
    expect(records.saveProgress).toHaveBeenCalledWith("pending", RESENT_HASH);
    expect(records.current()).toEqual({ state: "confirmed", transactionHash: RESENT_HASH });
  });

  it("ignores a held mint that's already saved as reverted, and sends it again", async () => {
    const records = memoryRecords({ state: "reverted", transactionHash: MINT_HASH });
    const unsaved = memorySlot();
    unsaved.write(MINT_HASH);
    arc.nextHash.mockReturnValue(RESENT_HASH);
    await expect(mintOnce(unsaved, send, records, wagmiConfig)).resolves.toBe(RESENT_HASH);
    expect(arc.sent).toHaveLength(1);
    expect(records.current()).toEqual({ state: "confirmed", transactionHash: RESENT_HASH });
  });

  it("saves a mint the wallet sped up as confirmed, under its new hash", async () => {
    const records = memoryRecords();
    arc.replace.mockImplementation((sent: SentTransaction) => ({ hash: SPED_UP_HASH, to: sent.to ?? null, data: sent.data, value: BigInt(0) }));
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).resolves.toBe(SPED_UP_HASH);
    expect(records.current()).toEqual({ state: "confirmed", transactionHash: SPED_UP_HASH });
  });

  it("saves a mint the wallet cancelled as reverted, since nothing was minted", async () => {
    const records = memoryRecords();
    arc.replace.mockImplementation((sent: SentTransaction) => ({ hash: SPED_UP_HASH, to: sent.from, data: "0x", value: BigInt(0) }));
    await expect(mintOnce(memorySlot(), send, records, wagmiConfig)).rejects.toThrow("Nothing was minted");
    expect(records.current()).toEqual({ state: "reverted", transactionHash: MINT_HASH });
  });

  it("mints again for a different order", async () => {
    await mintOnce(memorySlot(), send, memoryRecords(), wagmiConfig);
    await mintOnce(memorySlot(), send, memoryRecords(), wagmiConfig);
    expect(arc.sent.map((transaction) => getAddress(transaction.from))).toEqual([ISSUER, ISSUER]);
  });
});
