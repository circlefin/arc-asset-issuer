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

"use client";

import { useQuery } from "@tanstack/react-query";
import { Refresh, WarningTriangle } from "iconoir-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { isAddressEqual } from "viem";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  BURN_FAILED_MESSAGE,
  TRANSFER_STATE_LABELS,
  TRANSFER_STATES,
  type TransferActivity,
  type TransferState,
} from "@/lib/activity";
import { balanceOn, hasHoldings, type Asset, type ListedAsset } from "@/lib/assets";
import { findChain, transactionUrl } from "@/lib/chains";
import { describeError, formatAssetAmount, formatDate, formatTokenAmount, shortenHex } from "@/lib/format";
import { checkHeldBurn, progressAction, type RecordedBurn } from "@/lib/transfer-progress";
import { findUnsavedTransferIn, storedUnsavedTransfers, UNSAVED_TRANSFERS_KEY } from "@/lib/unsaved-transfers";
import { useAssetStore, type TransferQuote } from "./asset-store";
import { DetailList, DetailRow } from "./details";
import { HoldingsUnreadAlert } from "./error-alert";
import { ExplorerLink } from "./explorer-link";
import { ACTIVITY_PATH } from "./nav-items";
import { StepList, statusAt, type StepStatus } from "./step-list";
import { useWallet } from "./wallet";

const DELIVERING_INDEX = TRANSFER_STATES.indexOf("delivering");
const BURN_INDEX = TRANSFER_STATES.indexOf("source-submitted");

function stepStatus(state: TransferState, index: number, running: boolean): StepStatus {
  if (state === "complete") return "done";
  if (state === "burn-failed") {
    if (index === BURN_INDEX) return "failed";
    return index < BURN_INDEX ? "done" : "pending";
  }
  if (state === "delivery-failed") {
    if (index === DELIVERING_INDEX) return "failed";
    return index < DELIVERING_INDEX ? "done" : "pending";
  }
  return statusAt(index, TRANSFER_STATES.indexOf(state), running);
}

// Only the sender's session can move a transfer on.
function useIsSender(transfer: TransferActivity) {
  const { address } = useWallet();
  return address !== null && isAddressEqual(address, transfer.sender);
}

// Delivery only. The source burn already happened, so it is never sent again.
export function RetryDeliveryButton({ transfer }: { transfer: TransferActivity }) {
  const { continueTransfer, runningTransfers } = useAssetStore();
  if (!useIsSender(transfer)) return null;

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={runningTransfers.includes(transfer.id)}
      onClick={() => continueTransfer(transfer)}
    >
      <Refresh data-icon="inline-start" />
      Retry delivery
    </Button>
  );
}

// Storage events only come from other tabs. A write in this tab shows on the next render, since
// the stored text is read on every render.
function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

// What this browser holds for the transfer: nothing, a burn (and the other transfer that saved it,
// if any), or held burns it can't read. Another browser can't tell. Nothing is held on the server
// render. Read as text, so an unreadable entry, or storage the browser refuses, blocks this
// transfer instead of crashing the page.
export function useHeldBurn<Transfer extends TransferActivity>(
  transfer: Pick<TransferActivity, "id" | "state" | "sender">,
  transfers: Transfer[],
) {
  const stored = useSyncExternalStore(subscribeToStorage, storedUnsavedTransfers, () => null);
  return checkHeldBurn(
    transfer,
    () => findUnsavedTransferIn(stored, transfer.id)?.transactionHash ?? null,
    transfers,
  );
}

type BurnRecordedAlertProps = { asset: ListedAsset; recordedBy: RecordedBurn<TransferActivity> };

// The burn went out once and another transfer saved it, as this browser's held copy shows. Another
// browser doesn't hold the copy, so it can't tell.
export function BurnRecordedAlert({ asset, recordedBy }: BurnRecordedAlertProps) {
  return recordedBy.bySender ? (
    <RecordedBySenderAlert asset={asset} recording={recordedBy.transfer} />
  ) : (
    <RecordedByOtherWalletAlert recording={recordedBy.transfer} />
  );
}

type RecordingProps = { recording: TransferActivity };

// The sender's own other transfer saved it, so that one is the one to follow.
function RecordedBySenderAlert({ asset, recording }: RecordingProps & { asset: ListedAsset }) {
  const source = findChain(recording.sourceChainId);
  return (
    <Alert variant="destructive">
      <WarningTriangle />
      <AlertTitle>Burn recorded by another transfer</AlertTitle>
      <AlertDescription>
        <p>
          This transfer&apos;s burn is saved on your transfer of {formatAssetAmount(recording.amount, asset)} from{" "}
          {source.name} to {findChain(recording.destinationChainId).name}, started{" "}
          {formatDate(recording.createdAt)}, as this browser&apos;s record shows. Follow that transfer in
          Activity. Don&apos;t resume this one from another browser or device: they don&apos;t have this
          record, and could burn your tokens again.
        </p>
        <RecordingBurnLink recording={recording} />
      </AlertDescription>
      <AlertAction>
        <Link href={ACTIVITY_PATH} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Open Activity
        </Link>
      </AlertAction>
    </Alert>
  );
}

// Another wallet's row holds this burn's hash. It isn't the sender's transfer to follow, but the
// burn still went out once, so it's never sent again from here.
function RecordedByOtherWalletAlert({ recording }: RecordingProps) {
  return (
    <Alert variant="destructive">
      <WarningTriangle />
      <AlertTitle>Burn recorded by another wallet</AlertTitle>
      <AlertDescription>
        <p>
          Your burn for this transfer went out, but a transfer from another wallet,{" "}
          <span className="font-mono">{shortenHex(recording.sender)}</span>, recorded it first. It won&apos;t
          be sent again from this browser. Contact support with the burn below. Don&apos;t resume this
          transfer from another browser or device: they don&apos;t have this browser&apos;s record, and
          could burn your tokens again.
        </p>
        <RecordingBurnLink recording={recording} />
      </AlertDescription>
    </Alert>
  );
}

function RecordingBurnLink({ recording }: RecordingProps) {
  if (!recording.sourceTransactionHash) return null;
  return (
    <ExplorerLink
      href={transactionUrl(findChain(recording.sourceChainId), recording.sourceTransactionHash)}
      value={recording.sourceTransactionHash}
    />
  );
}

// The held burns can't be read, so this transfer may have a burn among them. It's blocked until
// they're cleared, and the send path refuses too.
export function HeldBurnUnreadableAlert({ error }: { error: unknown }) {
  return (
    <Alert variant="destructive">
      <WarningTriangle />
      <AlertTitle>Can&apos;t read this browser&apos;s unsaved burns</AlertTitle>
      <AlertDescription>
        <p>{describeError(error)}</p>
        <p>
          This transfer is blocked so it can&apos;t pay twice: one of its burns may be in there. To unblock
          it, open your browser&apos;s developer tools, delete the &ldquo;{UNSAVED_TRANSFERS_KEY}&rdquo; entry
          from this site&apos;s local storage, and reload. Resuming then searches onchain for any burn that
          landed before sending one.
        </p>
      </AlertDescription>
    </Alert>
  );
}

// Iris is asked again while it hasn't attested, every 5 seconds, slowing to once a minute.
const FORWARDING_POLL_MS = 5_000;
const FORWARDING_BACKOFF = 1.5;
const MAX_FORWARDING_POLL_MS = 60_000;

// Whether Circle delivers it, asked of Iris once the transfer is delivering.
function useForwarding(transfer: TransferActivity) {
  const { findForwarding } = useAssetStore();
  return useQuery({
    queryKey: ["transfer-forwarding", transfer.id],
    queryFn: () => findForwarding(transfer),
    enabled: transfer.state === "delivering",
    // Kept once known: it doesn't change after attestation.
    staleTime: (query) => (query.state.data === null ? 0 : Infinity),
    // Null means Iris hasn't attested yet, or was busy, so it's asked again.
    refetchInterval: (query) =>
      query.state.data === null
        ? Math.min(FORWARDING_POLL_MS * FORWARDING_BACKOFF ** (query.state.dataUpdateCount - 1), MAX_FORWARDING_POLL_MS)
        : false,
    // Shown inline: only the action's label depends on it.
    throwOnError: false,
  });
}

type SectionProps = {
  title: string;
  children: React.ReactNode;
};

function Section({ title, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="font-heading text-base leading-subhead">{title}</h3>
      {children}
    </section>
  );
}

type TransferProgressProps = {
  asset: ListedAsset;
  transfer: TransferActivity;
  // The asset's other transfers, to point at one that saved this transfer's burn.
  transfers: TransferActivity[];
};

export function TransferProgress({ asset, transfer, transfers }: TransferProgressProps) {
  const source = findChain(transfer.sourceChainId);
  const destination = findChain(transfer.destinationChainId);

  return (
    <>
      <Section title="Progress">
        <TransferSteps asset={asset} transfer={transfer} transfers={transfers} />
      </Section>
      <Separator />
      <Section title="Transactions and balances">
        <DetailList>
          <DetailRow label={`Burn on ${source.name}`}>
            {transfer.sourceTransactionHash ? (
              <ExplorerLink
                href={transactionUrl(source, transfer.sourceTransactionHash)}
                value={transfer.sourceTransactionHash}
              />
            ) : (
              "Not yet"
            )}
          </DetailRow>
          <DetailRow label={`Bridge mint on ${destination.name}`}>
            {transfer.destinationTransactionHash ? (
              <ExplorerLink
                href={transactionUrl(destination, transfer.destinationTransactionHash)}
                value={transfer.destinationTransactionHash}
              />
            ) : (
              "Not yet"
            )}
          </DetailRow>
          <DetailRow label="Cross-chain fee">
            {formatTokenAmount(transfer.crossChainFee, source.gasDecimals)} {source.gasSymbol}
          </DetailRow>
          {hasHoldings(asset) && <TransferBalances asset={asset} transfer={transfer} />}
        </DetailList>
        {!hasHoldings(asset) && <HoldingsUnreadAlert error={asset.holdingsError} />}
      </Section>
    </>
  );
}

function TransferBalances({ asset, transfer }: { asset: Asset; transfer: TransferActivity }) {
  const source = findChain(transfer.sourceChainId);
  const destination = findChain(transfer.destinationChainId);

  return (
    <>
      <DetailRow label={`Sender's balance on ${source.name}`}>
        {formatAssetAmount(balanceOn(asset, source.id, transfer.sender), asset)}
      </DetailRow>
      <DetailRow label={`Recipient's balance on ${destination.name}`}>
        {formatAssetAmount(balanceOn(asset, destination.id, transfer.recipient), asset)}
      </DetailRow>
      <DetailRow label="In transit">{formatAssetAmount(asset.inTransit, asset)}</DetailRow>
    </>
  );
}

// The PDD's states in order, the current one running while a run is going.
export function TransferStateSteps({ state, running }: { state: TransferState; running: boolean }) {
  return (
    <StepList
      steps={TRANSFER_STATES.map((step, index) => ({
        label: TRANSFER_STATE_LABELS[step],
        status: stepStatus(state, index, running),
      }))}
    />
  );
}

type TransferStepsProps = { asset: ListedAsset; transfer: TransferActivity; transfers: TransferActivity[] };

function TransferSteps({ asset, transfer, transfers }: TransferStepsProps) {
  const { runningTransfers, failures, continueTransfer } = useAssetStore();
  const isSender = useIsSender(transfer);
  const held = useHeldBurn(transfer, transfers);
  const recordedBy = held.status === "held" ? held.recordedBy : null;
  const forwarding = useForwarding(transfer);
  const running = runningTransfers.includes(transfer.id);
  const failure = failures[transfer.id];
  const destination = findChain(transfer.destinationChainId);
  // No burn saved or held here, so resuming may sign one.
  const mayBurn = transfer.state === "approval-required" && held.status === "none";
  const action = progressAction({
    state: transfer.state,
    running,
    isSender,
    forwarding: forwarding.data ?? null,
    burnRecordedElsewhere: recordedBy !== null,
    heldBurnUnreadable: held.status === "unreadable",
  });

  return (
    <>
      <TransferStateSteps state={transfer.state} running={running} />
      {/* Circle doesn't deliver it, so the run asks the wallet to, on the destination. */}
      {running && transfer.state === "delivering" && forwarding.data === false && (
        <p className="text-sm text-muted-foreground">
          Confirm the delivery on {destination.name} in your wallet.
        </p>
      )}
      {forwarding.error && (
        <p className="text-sm text-destructive">
          Couldn&apos;t check whether Circle delivers this transfer: {describeError(forwarding.error)}
        </p>
      )}
      {recordedBy && <BurnRecordedAlert asset={asset} recordedBy={recordedBy} />}
      {held.status === "unreadable" && <HeldBurnUnreadableAlert error={held.error} />}
      {transfer.state === "delivery-failed" && (
        <Alert variant="destructive">
          <WarningTriangle />
          <AlertTitle>Delivery failed</AlertTitle>
          <AlertDescription>
            {/* The reason lives with the run that failed; a reload keeps only the state. */}
            {failure && <p>{failure}</p>}
            {isSender && <p>Retrying finishes this transfer. Your tokens won&apos;t be burned again.</p>}
          </AlertDescription>
          {action === "retry-delivery" && (
            <AlertAction>
              <RetryDeliveryButton transfer={transfer} />
            </AlertAction>
          )}
        </Alert>
      )}
      {transfer.state === "burn-failed" && (
        <Alert variant="destructive">
          <WarningTriangle />
          <AlertTitle>Burn failed</AlertTitle>
          <AlertDescription>
            {BURN_FAILED_MESSAGE} You can start a new transfer.
          </AlertDescription>
        </Alert>
      )}
      {action === "complete-on-destination" && (
        <Alert variant={failure ? "destructive" : "default"}>
          <WarningTriangle />
          <AlertTitle>Waiting for you on {destination.name}</AlertTitle>
          <AlertDescription>
            {failure ??
              `Circle doesn't deliver this transfer. Your wallet sends it on ${destination.name}, paid in ${destination.gasSymbol}.`}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => continueTransfer(transfer)}>
              Complete on {destination.name}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {action === "resume" && mayBurn && <ResumeFees transfer={transfer} />}
      {action === "resume" && <ResumeTransfer transfer={transfer} failure={failure} mayBurn={mayBurn} />}
    </>
  );
}

// Before its burn, resuming may sign it, so its fees show first, as on the review. A burn that
// already went out can make the quote fail, so resuming never waits on it.
function ResumeFees({ transfer }: { transfer: TransferActivity }) {
  const { quoteTransfer } = useAssetStore();
  const quote = useQuery({
    queryKey: ["transfer-quote", transfer.id, transfer.sender],
    queryFn: () => quoteTransfer(transfer, transfer.sender),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    throwOnError: false,
  });
  const source = findChain(transfer.sourceChainId);
  const estimate = (amount: (fees: TransferQuote) => bigint) =>
    quote.data
      ? `~${formatTokenAmount(amount(quote.data), source.gasDecimals)} ${source.gasSymbol}`
      : quote.isPending
        ? "Estimating…"
        : "Couldn't estimate";

  return (
    <DetailList>
      <DetailRow label="Estimated transaction fee">{estimate((fees) => fees.gas)}</DetailRow>
      <DetailRow label="Estimated cross-chain fee">{estimate((fees) => fees.crossChainFee)}</DetailRow>
    </DetailList>
  );
}

type ResumeTransferProps = { transfer: TransferActivity; failure: string | undefined; mayBurn: boolean };

// Tracking stopped, from a refresh or an error. Picks up from the saved state.
function ResumeTransfer({ transfer, failure, mayBurn }: ResumeTransferProps) {
  const { continueTransfer } = useAssetStore();

  return (
    <Alert variant={failure ? "destructive" : "default"}>
      <WarningTriangle />
      <AlertTitle>{failure ? "Tracking stopped" : "Not being tracked"}</AlertTitle>
      <AlertDescription>
        {failure ?? "This page stopped following the transfer, such as after a refresh."}
        {mayBurn && " Resuming signs the burn if it hasn't gone out yet."}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={() => continueTransfer(transfer)}>
          <Refresh data-icon="inline-start" />
          Resume
        </Button>
      </AlertAction>
    </Alert>
  );
}
