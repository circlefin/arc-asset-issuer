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
import type { ChainId } from "./chains";
import type { Database } from "./database.types";

// The transfer states the PDD names, in order. A failed delivery sits between Delivering and Complete.
// A failed burn ends the transfer at Source submitted.
export const TRANSFER_STATES = [
  "approval-required",
  "source-submitted",
  "awaiting-attestation",
  "delivering",
  "complete",
] as const satisfies readonly TransferState[];

export type TransferState = Database["public"]["Enums"]["transfer_state"];

export const TRANSFER_STATE_LABELS: Record<TransferState, string> = {
  "approval-required": "Approval required",
  "source-submitted": "Source submitted",
  "awaiting-attestation": "Awaiting attestation",
  delivering: "Delivering",
  complete: "Complete",
  "delivery-failed": "Delivery failed",
  "burn-failed": "Burn failed",
};

// The burn was cancelled, replaced or reverted, so the sender's tokens never left.
export const BURN_FAILED_MESSAGE = "The burn didn't go through. Nothing left your wallet.";

// Saving a burn hash another transfer's row already holds. One burn backs one transfer.
export class BurnRecordedError extends Error {
  constructor(cause: unknown) {
    super("This burn is already recorded by another transfer.", { cause });
  }
}

// Saving a delivery hash another transfer's row already holds. One delivery completes one transfer.
export class DeliveryRecordedError extends Error {
  constructor(cause: unknown) {
    super(
      "This transfer's delivery is already recorded by another transfer, so it can't be marked complete. " +
        "Its tokens were delivered. Contact support with this transfer's delivery transaction.",
      { cause },
    );
  }
}

export type MintState = Database["public"]["Enums"]["mint_state"];

export const MINT_STATE_LABELS: Record<MintState, string> = {
  pending: "Confirming",
  confirmed: "Complete",
  // Reverted onchain, or cancelled or replaced in the wallet. Either way nothing was minted.
  reverted: "Failed",
};

type ActivityBase = { id: string; assetId: string; createdAt: Date };

// A setup's status lives on its asset, so the entry only points at it: the launch on Arc, or a
// network the issuer enabled after.
export type SetupActivity = ActivityBase & { kind: "setup" | "network-setup"; chainId: ChainId };

export type IssuerMintActivity = ActivityBase & {
  kind: "issuer-mint";
  amount: bigint;
  recipient: Address;
  // Saved as soon as the wallet sends it, so it's known before it lands.
  transactionHash: Hash;
  state: MintState;
};

export type TransferActivity = ActivityBase & {
  kind: "transfer";
  sender: Address;
  amount: bigint;
  recipient: Address;
  sourceChainId: ChainId;
  destinationChainId: ChainId;
  // CCTP's fee, paid in the source chain's gas token, in its base units.
  crossChainFee: bigint;
  state: TransferState;
  // The burn on the source, once submitted.
  sourceTransactionHash: Hash | null;
  // The bridge mint on the destination, once delivered.
  destinationTransactionHash: Hash | null;
};

export type Activity = SetupActivity | IssuerMintActivity | TransferActivity;

export function isSetupActivity(entry: Activity): entry is SetupActivity {
  return entry.kind === "setup" || entry.kind === "network-setup";
}

export const ACTIVITY_KIND_LABELS: Record<Activity["kind"], string> = {
  setup: "Launch",
  "network-setup": "Network setup",
  "issuer-mint": "Issuer mint",
  transfer: "Transfer",
};
