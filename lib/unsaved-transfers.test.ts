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

import type { Hash } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findUnsavedDelivery,
  findUnsavedTransfer,
  forgetUnsavedDelivery,
  findUnsavedTransferIn,
  forgetUnsavedTransfer,
  rememberUnsavedDelivery,
  rememberUnsavedTransfer,
  storedUnsavedTransfers,
  UNSAVED_TRANSFERS_KEY,
  type HeldBurn,
} from "./unsaved-transfers";

const TRANSFER_ID = "0f6c1c55-8a0e-4c7b-9d1e-2b3c4d5e6f70";
const OTHER_TRANSFER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const BURN_HASH: Hash = `0x${"ab".repeat(32)}`;
const OTHER_BURN_HASH: Hash = `0x${"cd".repeat(32)}`;

// Stands in for the browser's localStorage, which Node doesn't have.
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("unsaved transfers", () => {
  it("keeps a sent burn and its source until it's forgotten", () => {
    expect(findUnsavedTransfer(TRANSFER_ID)).toBeNull();
    rememberUnsavedTransfer(TRANSFER_ID, { transactionHash: BURN_HASH, source: "search" });
    expect(findUnsavedTransfer(TRANSFER_ID)).toEqual({ transactionHash: BURN_HASH, source: "search" });
    forgetUnsavedTransfer(TRANSFER_ID);
    expect(findUnsavedTransfer(TRANSFER_ID)).toBeNull();
  });

  it("keeps each transfer's burn apart", () => {
    rememberUnsavedTransfer(TRANSFER_ID, { transactionHash: BURN_HASH, source: "wallet" });
    rememberUnsavedTransfer(OTHER_TRANSFER_ID, { transactionHash: OTHER_BURN_HASH, source: "search" });
    forgetUnsavedTransfer(OTHER_TRANSFER_ID);
    expect(findUnsavedTransfer(TRANSFER_ID)).toEqual({ transactionHash: BURN_HASH, source: "wallet" });
  });

  // Saved before sources were kept, when only the wallet's burns were held.
  it("reads a burn stored without a source as the wallet's, so it's never sent again", () => {
    localStorage.setItem("unsaved-transfers", JSON.stringify([{ transferId: TRANSFER_ID, transactionHash: BURN_HASH }]));
    expect(findUnsavedTransfer(TRANSFER_ID)).toEqual({ transactionHash: BURN_HASH, source: "wallet" });
  });

  it("throws on a stored burn it can't read, instead of dropping it", () => {
    localStorage.setItem("unsaved-transfers", JSON.stringify([{ transferId: TRANSFER_ID, transactionHash: "0x12" }]));
    expect(() => findUnsavedTransfer(TRANSFER_ID)).toThrow("bad hash");
  });

  it("throws on a stored burn with an unknown source, instead of reading it as nothing held", () => {
    localStorage.setItem(
      "unsaved-transfers",
      JSON.stringify([{ transferId: TRANSFER_ID, transactionHash: BURN_HASH, source: "relayer" }]),
    );
    expect(() => findUnsavedTransfer(TRANSFER_ID)).toThrow("bad source: relayer");
  });
});

describe("stored unsaved transfers", () => {
  it("reads a held burn from the stored text, the same as from storage", () => {
    expect(storedUnsavedTransfers()).toBeNull();
    expect(findUnsavedTransferIn(storedUnsavedTransfers(), TRANSFER_ID)).toBeNull();
    rememberUnsavedTransfer(TRANSFER_ID, { transactionHash: BURN_HASH, source: "wallet" });
    expect(storedUnsavedTransfers()).toBe(localStorage.getItem(UNSAVED_TRANSFERS_KEY));
    expect(findUnsavedTransferIn(storedUnsavedTransfers(), TRANSFER_ID)).toEqual({
      transactionHash: BURN_HASH,
      source: "wallet",
    });
  });

  it("throws on stored text it can't read, instead of finding nothing", () => {
    expect(() => findUnsavedTransferIn("not json", TRANSFER_ID)).toThrow();
    expect(() => findUnsavedTransferIn("{}", TRANSFER_ID)).toThrow("aren't a list");
  });

  it("returns storage the browser refuses as unreadable instead of throwing, and finding throws it", () => {
    const refused = new DOMException("The operation is insecure.", "SecurityError");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw refused;
      },
    });
    const stored = storedUnsavedTransfers();
    expect(stored).toEqual({ unreadable: refused });
    expect(() => findUnsavedTransferIn(stored, TRANSFER_ID)).toThrow(refused);
  });
});

describe("unsaved deliveries", () => {
  it("keeps a sent delivery apart from the transfer's burn, until it's forgotten", () => {
    const burn: HeldBurn = { transactionHash: BURN_HASH, source: "wallet" };
    rememberUnsavedTransfer(TRANSFER_ID, burn);
    rememberUnsavedDelivery(TRANSFER_ID, OTHER_BURN_HASH);
    expect(findUnsavedDelivery(TRANSFER_ID)).toBe(OTHER_BURN_HASH);
    expect(findUnsavedTransfer(TRANSFER_ID)).toEqual(burn);
    forgetUnsavedDelivery(TRANSFER_ID);
    expect(findUnsavedDelivery(TRANSFER_ID)).toBeNull();
    expect(findUnsavedTransfer(TRANSFER_ID)).toEqual(burn);
  });

  it("throws on a stored delivery it can't read, instead of dropping it", () => {
    localStorage.setItem("unsaved-deliveries", JSON.stringify([{ transferId: TRANSFER_ID, transactionHash: "0x12" }]));
    expect(() => findUnsavedDelivery(TRANSFER_ID)).toThrow("bad hash");
  });

  it("stores a delivery as before, with no source", () => {
    rememberUnsavedDelivery(TRANSFER_ID, OTHER_BURN_HASH);
    expect(JSON.parse(localStorage.getItem("unsaved-deliveries") ?? "null")).toEqual([
      { transferId: TRANSFER_ID, transactionHash: OTHER_BURN_HASH },
    ]);
  });
});
