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

// What the transfer review screen lets the sender do.

export type ReviewState = {
  // A start of this transfer ID failed. Its row may be saved and its burn sent, even when the
  // refetch that would show the row failed too.
  attemptFailed: boolean;
  rowSaved: boolean;
  // A start of this transfer ID is still going, maybe from before the dialog was reopened.
  running: boolean;
};

// Editing makes a new transfer ID, so it's only safe before anything could have been sent under
// this one. Retrying the same ID is always safe: it finds a sent burn instead of sending another.
export function canEditTransfer({ attemptFailed, rowSaved, running }: ReviewState) {
  return !attemptFailed && !rowSaved && !running;
}

// Where the review's fee quote stands.
export type QuoteStatus = "pending" | "ready" | "failed";

export type ReviewActions = {
  edit: boolean;
  // Signs a new transfer, or retries this one's start, which finds a sent burn before sending.
  confirm: "sign" | "retry";
  canConfirm: boolean;
  // Confirming waits for the fees, because it would sign a new burn.
  needsQuote: boolean;
  // Asks for the quote again after it failed.
  requote: boolean;
};

type ReviewInput = ReviewState & {
  quote: QuoteStatus;
  // This browser holds a burn sent under this transfer ID that isn't saved yet.
  burnHeld: boolean;
  // This transfer's burn is saved on another transfer's row, so it's never sent again.
  burnRecordedElsewhere: boolean;
  // This browser's held burns can't be read, so one of this transfer's may be among them.
  heldBurnUnreadable: boolean;
};

// A burn is signed only once the sender has seen its fees, so a new transfer waits for the quote.
// A retry waits too, unless a burn may already be out under this ID:
// - Its row is saved. The retry searches onchain for a landed burn before sending, and the quote can
//   fail because of that burn (the balance is gone), so it mustn't wait on the quote.
// - This browser holds its burn. The retry saves that burn and sends nothing.
// A failed start with neither never saved its row, and its burn is signed only after the row is
// saved, so no burn went out and its retry is a fresh start. A failed start doesn't count on its
// own: the rows are read again after every run, and a failed read replaces the page with an error
// instead of showing a list without the row. Until that read lands, the retry waits for it or the fees.
export function reviewActions(input: ReviewInput): ReviewActions {
  const burnMayBeOut = input.rowSaved || input.burnHeld;
  // Editing would leave a held burn behind under the old ID.
  const edit = canEditTransfer(input) && !input.burnHeld;
  const idle = !input.running;
  const needsQuote = !burnMayBeOut;
  return {
    edit,
    confirm: edit ? "sign" : "retry",
    canConfirm:
      idle && !input.burnRecordedElsewhere && !input.heldBurnUnreadable && (!needsQuote || input.quote === "ready"),
    needsQuote,
    // Fees can always be asked for again. They change nothing that's sent.
    requote: idle && input.quote === "failed",
  };
}
