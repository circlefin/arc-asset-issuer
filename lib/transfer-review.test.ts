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
import { canEditTransfer, reviewActions } from "./transfer-review";

describe("canEditTransfer", () => {
  it("allows editing before any attempt", () => {
    expect(canEditTransfer({ attemptFailed: false, rowSaved: false, running: false })).toBe(true);
  });

  it("stops editing once an attempt failed, even when the saved row isn't visible yet", () => {
    // The row may be saved and the burn sent while the refetch that would show it failed.
    expect(canEditTransfer({ attemptFailed: true, rowSaved: false, running: false })).toBe(false);
  });

  it("stops editing once the row is saved", () => {
    expect(canEditTransfer({ attemptFailed: false, rowSaved: true, running: false })).toBe(false);
    expect(canEditTransfer({ attemptFailed: true, rowSaved: true, running: false })).toBe(false);
  });

  it("stops editing while this transfer is running, before anything failed or was saved", () => {
    // A review reopened mid-run has a fresh mutation, and the row is saved only after the approve.
    expect(canEditTransfer({ attemptFailed: false, rowSaved: false, running: true })).toBe(false);
  });

  it("stops editing while this transfer is running, whatever else is true", () => {
    expect(canEditTransfer({ attemptFailed: true, rowSaved: false, running: true })).toBe(false);
    expect(canEditTransfer({ attemptFailed: false, rowSaved: true, running: true })).toBe(false);
  });
});

describe("reviewActions", () => {
  const FRESH = {
    attemptFailed: false,
    rowSaved: false,
    running: false,
    burnHeld: false,
    burnRecordedElsewhere: false,
    heldBurnUnreadable: false,
  };
  const QUOTES = ["pending", "ready", "failed"] as const;

  it("signs a new transfer once its quote is ready", () => {
    expect(reviewActions({ ...FRESH, quote: "ready" })).toEqual({
      edit: true,
      confirm: "sign",
      canConfirm: true,
      needsQuote: true,
      requote: false,
    });
  });

  it("doesn't sign a new transfer before its fees are known", () => {
    expect(reviewActions({ ...FRESH, quote: "pending" }).canConfirm).toBe(false);
  });

  it("doesn't sign a new transfer whose quote failed, and offers to ask again", () => {
    const actions = reviewActions({ ...FRESH, quote: "failed" });
    expect(actions.canConfirm).toBe(false);
    expect(actions.requote).toBe(true);
    expect(actions.edit).toBe(true);
  });

  it("retries a failed start with no saved row only once its fees are known", () => {
    // The row is saved before the burn is signed, so without one nothing was burned and the retry
    // signs a new burn.
    const failed = reviewActions({ ...FRESH, attemptFailed: true, quote: "failed" });
    expect(failed).toEqual({ edit: false, confirm: "retry", canConfirm: false, needsQuote: true, requote: true });
    expect(reviewActions({ ...FRESH, attemptFailed: true, quote: "pending" }).canConfirm).toBe(false);
    expect(reviewActions({ ...FRESH, attemptFailed: true, quote: "ready" }).canConfirm).toBe(true);
  });

  it("retries a failed start whose row is saved whatever the quote, since that retry finds a landed burn", () => {
    // After the burn lands the balance is gone, so the quote fails for the very transfer being retried.
    for (const quote of QUOTES) {
      const actions = reviewActions({ ...FRESH, attemptFailed: true, rowSaved: true, quote });
      expect(actions).toMatchObject({ edit: false, confirm: "retry", canConfirm: true, needsQuote: false });
      expect(actions.requote).toBe(quote === "failed");
    }
  });

  it("retries a saved row whose quote failed when nothing failed in this session, and lets it ask again", () => {
    // After a reload the store has forgotten the failure, but the row is still there.
    expect(reviewActions({ ...FRESH, rowSaved: true, quote: "failed" })).toEqual({
      edit: false,
      confirm: "retry",
      canConfirm: true,
      needsQuote: false,
      requote: true,
    });
  });

  it("retries a transfer whose burn this browser holds whatever the quote, and never edits it", () => {
    // The retry saves the held burn and sends nothing.
    for (const quote of QUOTES) {
      const actions = reviewActions({ ...FRESH, attemptFailed: true, burnHeld: true, quote });
      expect(actions).toMatchObject({ edit: false, confirm: "retry", canConfirm: true, needsQuote: false });
    }
    expect(reviewActions({ ...FRESH, burnHeld: true, quote: "ready" }).edit).toBe(false);
  });

  it("disables confirming and asking again while this transfer runs, whatever the quote", () => {
    for (const quote of QUOTES) {
      for (const rowSaved of [false, true]) {
        const actions = reviewActions({ ...FRESH, running: true, rowSaved, quote });
        expect(actions.canConfirm).toBe(false);
        expect(actions.requote).toBe(false);
      }
    }
  });

  it("never retries a transfer whose burn another transfer recorded", () => {
    const actions = reviewActions({ ...FRESH, attemptFailed: true, rowSaved: true, burnRecordedElsewhere: true, quote: "ready" });
    expect(actions.canConfirm).toBe(false);
    expect(actions.edit).toBe(false);
  });

  it("never confirms while this browser's held burns can't be read", () => {
    for (const rowSaved of [false, true]) {
      expect(reviewActions({ ...FRESH, rowSaved, heldBurnUnreadable: true, quote: "ready" }).canConfirm).toBe(false);
    }
  });
});
