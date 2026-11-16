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
import { describe, expect, it } from "vitest";
import type { TransferState } from "./activity";
import { checkHeldBurn, findRecordingTransfer, progressAction } from "./transfer-progress";
import { findUnsavedTransferIn } from "./unsaved-transfers";

describe("progressAction", () => {
  const SENDER = { running: false, isSender: true, forwarding: null, burnRecordedElsewhere: false, heldBurnUnreadable: false };

  it("retries only delivery once the destination refused it", () => {
    expect(progressAction({ ...SENDER, state: "delivery-failed" })).toBe("retry-delivery");
  });

  it("asks the sender to complete it on the destination when Circle doesn't deliver", () => {
    expect(progressAction({ ...SENDER, state: "delivering", forwarding: false })).toBe("complete-on-destination");
  });

  it("resumes delivery that Circle forwards, or whose delivery isn't known yet", () => {
    expect(progressAction({ ...SENDER, state: "delivering", forwarding: true })).toBe("resume");
    expect(progressAction({ ...SENDER, state: "delivering", forwarding: null })).toBe("resume");
  });

  it("resumes a stopped run before delivery", () => {
    const states: TransferState[] = ["approval-required", "source-submitted", "awaiting-attestation"];
    for (const state of states) expect(progressAction({ ...SENDER, state })).toBe("resume");
  });

  it("offers nothing on a finished transfer", () => {
    expect(progressAction({ ...SENDER, state: "complete" })).toBe("none");
    expect(progressAction({ ...SENDER, state: "burn-failed" })).toBe("none");
  });

  it("offers nothing while it runs, so nothing is sent twice", () => {
    expect(progressAction({ ...SENDER, running: true, state: "delivery-failed" })).toBe("none");
    expect(progressAction({ ...SENDER, running: true, state: "delivering", forwarding: false })).toBe("none");
  });

  it("offers nothing to anyone but the sender", () => {
    expect(progressAction({ ...SENDER, isSender: false, state: "delivery-failed" })).toBe("none");
  });

  it("never resumes a transfer whose burn another transfer recorded", () => {
    expect(progressAction({ ...SENDER, burnRecordedElsewhere: true, state: "approval-required" })).toBe("none");
  });

  it("never resumes a transfer while this browser's held burns can't be read", () => {
    expect(progressAction({ ...SENDER, heldBurnUnreadable: true, state: "approval-required" })).toBe("none");
  });
});

const SENDER_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET: Address = "0x2222222222222222222222222222222222222222";

describe("findRecordingTransfer", () => {
  const BURN: Hash = `0x${"ab".repeat(32)}`;
  const OTHER_BURN: Hash = `0x${"cd".repeat(32)}`;
  const stuck = { id: "a", state: "approval-required", sender: SENDER_ADDRESS } as const;
  const other = { id: "b", sender: SENDER_ADDRESS, sourceTransactionHash: BURN };

  it("finds the sender's other transfer that saved the held burn, whatever its case", () => {
    const held: Hash = `0x${"AB".repeat(32)}`;
    const ownRow = { id: "a", sender: SENDER_ADDRESS, sourceTransactionHash: null };
    expect(findRecordingTransfer(stuck, held, [ownRow, other])).toEqual({ transfer: other, bySender: true });
  });

  it("matches the sender whatever the address's case", () => {
    const checksummed = { ...other, sender: getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd") };
    const lower = { ...stuck, sender: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" } as const;
    expect(findRecordingTransfer(lower, BURN, [checksummed])?.bySender).toBe(true);
  });

  it("marks a row another wallet wrote as not the sender's", () => {
    const forged = { ...other, sender: OTHER_WALLET };
    expect(findRecordingTransfer(stuck, BURN, [forged])).toEqual({ transfer: forged, bySender: false });
  });

  it("finds nothing without a held burn, or when no other row saved it", () => {
    expect(findRecordingTransfer(stuck, null, [other])).toBeNull();
    expect(findRecordingTransfer(stuck, OTHER_BURN, [other])).toBeNull();
  });

  it("ignores the transfer's own row", () => {
    expect(findRecordingTransfer({ ...stuck, id: "b" }, BURN, [other])).toBeNull();
  });

  it("only applies before the transfer saved a burn of its own", () => {
    expect(findRecordingTransfer({ ...stuck, state: "source-submitted" }, BURN, [other])).toBeNull();
  });
});

describe("checkHeldBurn", () => {
  const BURN: Hash = `0x${"ab".repeat(32)}`;
  const stuck = { id: "a", state: "approval-required", sender: SENDER_ADDRESS } as const;
  const other = { id: "b", sender: SENDER_ADDRESS, sourceTransactionHash: BURN };

  it("finds nothing held when nothing is", () => {
    expect(checkHeldBurn(stuck, () => null, [other])).toEqual({ status: "none" });
  });

  it("reports a held burn, and the other transfer that saved it", () => {
    expect(checkHeldBurn(stuck, () => BURN, [other])).toEqual({
      status: "held",
      recordedBy: { transfer: other, bySender: true },
    });
    expect(checkHeldBurn(stuck, () => `0x${"cd".repeat(32)}`, [other])).toEqual({ status: "held", recordedBy: null });
  });

  it("reports unreadable held burns instead of throwing, and never as nothing held", () => {
    const error = new Error("A saved unsent burn has a bad hash: 0x12");
    const unreadable = () => {
      throw error;
    };
    expect(checkHeldBurn(stuck, unreadable, [other])).toEqual({ status: "unreadable", error });
  });

  it("reports storage the browser refuses as unreadable, so nothing resends", () => {
    const refused = new DOMException("The operation is insecure.", "SecurityError");
    const read = () => findUnsavedTransferIn({ unreadable: refused }, stuck.id)?.transactionHash ?? null;
    expect(checkHeldBurn(stuck, read, [other])).toEqual({ status: "unreadable", error: refused });
  });

  it("doesn't read for a transfer whose burn is saved on its row", () => {
    const unreadable = () => {
      throw new Error("not read");
    };
    expect(checkHeldBurn({ ...stuck, state: "delivering" }, unreadable, [other])).toEqual({ status: "none" });
  });
});
