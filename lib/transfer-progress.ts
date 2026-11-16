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

// What a transfer's progress offers to whoever looks at it.

import type { Hash } from "viem";
import type { TransferActivity, TransferState } from "./activity";

export type ProgressAction =
  // Delivery only, after the destination refused it. Never burns again.
  | "retry-delivery"
  // The sender delivers it with receiveMessage, since Circle doesn't.
  | "complete-on-destination"
  // Picks a run that stopped back up from the saved state.
  | "resume"
  | "none";

type ProgressInput = {
  state: TransferState;
  running: boolean;
  isSender: boolean;
  // Whether Circle delivers it. Null until known, as before attestation.
  forwarding: boolean | null;
  // This transfer's burn is saved on another transfer's row. Resuming could only fail again, or, in
  // a browser that doesn't hold the burn, search past it and burn twice.
  burnRecordedElsewhere: boolean;
  // This browser's held burns can't be read, so one of this transfer's may be among them.
  heldBurnUnreadable: boolean;
};

// Only the sender's session can move a transfer on, one run at a time.
export function progressAction(input: ProgressInput): ProgressAction {
  const { state, running, isSender, forwarding, burnRecordedElsewhere, heldBurnUnreadable } = input;
  if (!isSender || running || burnRecordedElsewhere || heldBurnUnreadable) return "none";
  if (state === "complete" || state === "burn-failed") return "none";
  if (state === "delivery-failed") return "retry-delivery";
  if (state === "delivering" && forwarding === false) return "complete-on-destination";
  return "resume";
}

// The other row that saved this transfer's held burn, and whether it's the same sender's. Rows are
// written by whoever is signed in, so another wallet's row can hold this burn's hash too: never
// call that one "your transfer".
export type RecordedBurn<Transfer> = { transfer: Transfer; bySender: boolean };

type RecordingRow = Pick<TransferActivity, "id" | "sender" | "sourceTransactionHash">;

// The other transfer whose row saved this one's held burn, if any. Only a transfer that never saved a
// burn of its own can be stuck this way.
export function findRecordingTransfer<Transfer extends RecordingRow>(
  transfer: Pick<TransferActivity, "id" | "state" | "sender">,
  heldBurn: Hash | null,
  transfers: Transfer[],
): RecordedBurn<Transfer> | null {
  if (transfer.state !== "approval-required" || heldBurn === null) return null;
  const recording = transfers.find(
    (other) => other.id !== transfer.id && other.sourceTransactionHash?.toLowerCase() === heldBurn.toLowerCase(),
  );
  if (!recording) return null;
  return { transfer: recording, bySender: recording.sender.toLowerCase() === transfer.sender.toLowerCase() };
}

// What this browser holds for a transfer. Only one in approval-required can hold a burn that hasn't
// been saved on its row, so any other is "none" without reading.
export type HeldBurnCheck<Transfer> =
  | { status: "none" }
  // A burn of this transfer's is held, and recordedBy is the other row that saved it, if any.
  | { status: "held"; recordedBy: RecordedBurn<Transfer> | null }
  // The held burns can't be read. Anything that would send must refuse, so it can't burn twice.
  | { status: "unreadable"; error: unknown };

export function checkHeldBurn<Transfer extends RecordingRow>(
  transfer: Pick<TransferActivity, "id" | "state" | "sender">,
  readHeldBurn: () => Hash | null,
  transfers: Transfer[],
): HeldBurnCheck<Transfer> {
  if (transfer.state !== "approval-required") return { status: "none" };
  let heldBurn: Hash | null;
  try {
    heldBurn = readHeldBurn();
  } catch (error) {
    // Shown on this transfer only, so the rest of the page still renders.
    return { status: "unreadable", error };
  }
  if (heldBurn === null) return { status: "none" };
  return { status: "held", recordedBy: findRecordingTransfer(transfer, heldBurn, transfers) };
}
