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

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Refresh, WarningTriangle } from "iconoir-react";
import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { TransferActivity } from "@/lib/activity";
import { balanceOn, type Asset, type ListedAsset } from "@/lib/assets";
import { holderRoutes, routeLabel } from "@/lib/cctp/routes";
import { findChain, type ChainId } from "@/lib/chains";
import {
  describeError,
  formatAssetAmount,
  formatTokenAmount,
  INVALID_RECIPIENT_MESSAGE,
  parseAmount,
  parseRecipient,
  shortenHex,
} from "@/lib/format";
import { reviewActions, type QuoteStatus, type ReviewActions } from "@/lib/transfer-review";
import { useAssetStore, type TransferQuote, type TransferRequest } from "./asset-store";
import { CopyButton } from "./copy-button";
import { DetailList, DetailRow } from "./details";
import { ErrorAlert } from "./error-alert";
import { LoadingSkeleton } from "./loading-skeleton";
import {
  BurnRecordedAlert,
  HeldBurnUnreadableAlert,
  TransferProgress,
  TransferStateSteps,
  useHeldBurn,
} from "./transfer-progress";
import { useAssetRecord } from "./use-asset";
import { useWallet } from "./wallet";
import { WalletRequired } from "./wallet-required";

const TRANSFER_FORM_ID = "transfer-form";

// What the form collects. The ID is added on review.
type TransferDetails = Omit<TransferRequest, "id">;

type Step =
  | { name: "form"; request: TransferDetails | null }
  | { name: "review"; request: TransferRequest }
  | { name: "progress"; transferId: string };

const FORM_STEP: Step = { name: "form", request: null };

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type TransferDialogProps = DialogProps & { asset: Asset };

// Closing keeps the form, so a stray click outside loses nothing. Once a transfer starts, the next one starts fresh.
export function TransferDialog({ asset, open, onOpenChange }: TransferDialogProps) {
  const [step, setStep] = useState(FORM_STEP);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen && step.name === "progress") setStep(FORM_STEP);
      }}
    >
      <DialogContent>
        <TransferSteps asset={asset} step={step} onStepChange={setStep} />
      </DialogContent>
    </Dialog>
  );
}

type TransferProgressDialogProps = DialogProps & {
  asset: ListedAsset;
  transfer: TransferActivity;
  transfers: TransferActivity[];
};

export function TransferProgressDialog({
  asset,
  transfer,
  transfers,
  open,
  onOpenChange,
}: TransferProgressDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ProgressStep asset={asset} transfer={transfer} transfers={transfers} />
      </DialogContent>
    </Dialog>
  );
}

type TransferStepsProps = {
  asset: Asset;
  step: Step;
  onStepChange: (step: Step) => void;
};

function TransferSteps({ asset, step, onStepChange }: TransferStepsProps) {
  const { address } = useWallet();
  if (step.name === "progress") {
    return <StartedTransfer assetId={asset.id} transferId={step.transferId} />;
  }
  if (!address) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Transfer across chains</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <WalletRequired description="Transfers move tokens this wallet holds." />
        </DialogBody>
      </>
    );
  }

  if (step.name === "review") {
    return (
      <TransferReview
        asset={asset}
        holder={address}
        request={step.request}
        onEdit={() => onStepChange({ name: "form", request: step.request })}
        onStarted={() => onStepChange({ name: "progress", transferId: step.request.id })}
      />
    );
  }

  return (
    <TransferForm
      asset={asset}
      holder={address}
      initialRequest={step.request}
      onReview={(request) =>
        onStepChange({ name: "review", request: { ...request, id: crypto.randomUUID() } })
      }
    />
  );
}

type TransferFormProps = {
  asset: Asset;
  holder: Address;
  initialRequest: TransferDetails | null;
  onReview: (request: TransferDetails) => void;
};

function routeKey(source: ChainId, destination: ChainId) {
  return `${source}>${destination}`;
}

function TransferForm({ asset, holder, initialRequest, onReview }: TransferFormProps) {
  // Tokens move from Arc to an enabled network, or back from one the holder holds on. The dialog
  // only opens when there's a route.
  const routes = holderRoutes(asset, holder);
  const [chosenKey, setChosenKey] = useState(
    initialRequest
      ? routeKey(initialRequest.sourceChainId, initialRequest.destinationChainId)
      : undefined,
  );
  const [recipientText, setRecipientText] = useState(initialRequest?.recipient ?? "");
  const [amountText, setAmountText] = useState(
    initialRequest ? formatUnits(initialRequest.amount, asset.decimals) : "",
  );
  const [showErrors, setShowErrors] = useState(false);
  // The first route until one is chosen. A chosen route back to Arc goes once nothing is held
  // there, and then nothing is chosen, rather than quietly switching to another route.
  const route =
    chosenKey === undefined
      ? routes.at(0)
      : routes.find((candidate) => routeKey(candidate.source.id, candidate.destination.id) === chosenKey);
  const available = route ? balanceOn(asset, route.source.id, holder) : null;
  const recipient = parseRecipient(recipientText);
  const amount = parseAmount(amountText, asset.decimals);
  const amountValid = amount !== null && available !== null && amount <= available;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Transfer across chains</DialogTitle>
        <DialogDescription>
          Burns {asset.symbol} on one chain and mints the same amount on the other.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form
          id={TRANSFER_FORM_ID}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!route || recipient === null || !amountValid) {
              setShowErrors(true);
              return;
            }
            onReview({
              assetId: asset.id,
              sourceChainId: route.source.id,
              destinationChainId: route.destination.id,
              recipient,
              amount,
            });
          }}
        >
          <FieldGroup>
            <Field data-invalid={showErrors && !route}>
              <FieldLabel htmlFor="destination">To</FieldLabel>
              <Select
                value={route ? routeKey(route.source.id, route.destination.id) : null}
                onValueChange={(value) => setChosenKey(value ?? undefined)}
              >
                <SelectTrigger id="destination" className="w-full" aria-invalid={showErrors && !route}>
                  <SelectValue>
                    {() => (route ? routeLabel(route) : "Choose a network")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {routes.map((option) => (
                    <SelectItem
                      key={routeKey(option.source.id, option.destination.id)}
                      value={routeKey(option.source.id, option.destination.id)}
                    >
                      {routeLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {showErrors && !route && <FieldError>Choose where to send.</FieldError>}
            </Field>
            <Field data-invalid={showErrors && recipient === null}>
              <FieldLabel htmlFor="recipient">Recipient wallet</FieldLabel>
              <Input
                id="recipient"
                className="font-mono"
                placeholder="0x…"
                value={recipientText}
                aria-invalid={showErrors && recipient === null}
                onChange={(event) => setRecipientText(event.target.value.trim())}
              />
              {showErrors && recipient === null && (
                <FieldError>{INVALID_RECIPIENT_MESSAGE}</FieldError>
              )}
            </Field>
            <Field data-invalid={showErrors && route !== undefined && !amountValid}>
              <FieldLabel htmlFor="amount">Amount</FieldLabel>
              <Input
                id="amount"
                inputMode="decimal"
                placeholder={`0 ${asset.symbol}`}
                value={amountText}
                aria-invalid={showErrors && route !== undefined && !amountValid}
                onChange={(event) => setAmountText(event.target.value.trim())}
              />
              {route && available !== null && (
                <FieldDescription>
                  Available on {route.source.name}: {formatAssetAmount(available, asset)}
                </FieldDescription>
              )}
              {showErrors && route && !amountValid && (
                <FieldError>
                  {amount === null
                    ? `Enter an amount above zero, with up to ${asset.decimals} decimals.`
                    : "That's more than you hold here."}
                </FieldError>
              )}
            </Field>
          </FieldGroup>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button type="submit" form={TRANSFER_FORM_ID}>
          Review
        </Button>
      </DialogFooter>
    </>
  );
}

type TransferReviewProps = {
  asset: Asset;
  holder: Address;
  request: TransferRequest;
  onEdit: () => void;
  onStarted: () => void;
};

function quoteStatus(quote: { isPending: boolean; isError: boolean }): QuoteStatus {
  if (quote.isError) return "failed";
  return quote.isPending ? "pending" : "ready";
}

// What the sender can do about fees that couldn't be read. Nothing while the transfer runs.
function quoteFailedHint(actions: ReviewActions, running: boolean) {
  if (running) return null;
  if (actions.edit) return "Ask again, or edit the transfer.";
  if (actions.needsQuote) return "No burn was sent, so ask again before you retry.";
  return "Retrying looks for this transfer's burn first.";
}

// The saved transfers decide what's safe to offer, so the review waits for them.
function TransferReview(props: TransferReviewProps) {
  const record = useAssetRecord(props.asset.id);
  if (!record) return <LoadingSkeleton />;
  return <LoadedTransferReview {...props} transfers={record.transfers} />;
}

function LoadedTransferReview({
  asset,
  holder,
  request,
  onEdit,
  onStarted,
  transfers,
}: TransferReviewProps & { transfers: TransferActivity[] }) {
  const { quoteTransfer, startTransfer, failures, runningTransfers } = useAssetStore();
  // Read again whenever the review opens: Arc's quotes expire in about two minutes.
  const quote = useQuery({
    // By ID: a review never changes its request, and a bigint can't go in a query key.
    queryKey: ["transfer-quote", request.id, holder],
    queryFn: () => quoteTransfer(request, holder),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    // Shown inline with a way to ask again, so a failed quote doesn't replace the page.
    throwOnError: false,
  });
  const starting = useMutation({
    mutationFn: () => startTransfer(request, holder),
    onSuccess: onStarted,
  });
  // After a failed start or once the row is saved, a burn may have been sent under this ID, so
  // only this transfer can be retried. The store keeps the failure and the running run if the
  // dialog is reopened, when this screen starts over with a fresh mutation.
  const saved = transfers.find((transfer) => transfer.id === request.id);
  // A transfer with no saved row has saved no burn of its own, like one in approval-required.
  const held = useHeldBurn(
    { id: request.id, state: saved ? saved.state : "approval-required", sender: holder },
    transfers,
  );
  const recordedBy = held.status === "held" ? held.recordedBy : null;
  const running = starting.isPending || runningTransfers.includes(request.id);
  const actions = reviewActions({
    attemptFailed: starting.isError || failures[request.id] !== undefined,
    rowSaved: saved !== undefined,
    running,
    quote: quoteStatus(quote),
    burnHeld: held.status === "held",
    burnRecordedElsewhere: recordedBy !== null,
    heldBurnUnreadable: held.status === "unreadable",
  });
  const source = findChain(request.sourceChainId);
  const destination = findChain(request.destinationChainId);
  const estimate = (amount: (fees: TransferQuote) => bigint) =>
    quote.data
      ? `~${formatTokenAmount(amount(quote.data), source.gasDecimals)} ${source.gasSymbol}`
      : quote.isPending
        ? "Estimating…"
        : "Couldn't estimate";
  const delivery = quote.data
    ? quote.data.forwarded
      ? "Automatic"
      : `You'll confirm it on ${destination.name}`
    : quote.isPending
      ? "Checking…"
      : "Couldn't check";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Review</DialogTitle>
        <DialogDescription>Check everything before you sign. All on testnet.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <DetailList>
          <DetailRow label="From">{source.name}</DetailRow>
          <DetailRow label="To">{destination.name}</DetailRow>
          <DetailRow label="Amount">{formatAssetAmount(request.amount, asset)}</DetailRow>
          <DetailRow label="Recipient">
            <span className="inline-flex items-center gap-1">
              <span className="font-mono">{shortenHex(request.recipient)}</span>
              <CopyButton value={request.recipient} label="Copy address" />
            </span>
          </DetailRow>
          <DetailRow label="Estimated transaction fee">{estimate((fees) => fees.gas)}</DetailRow>
          <DetailRow label="Estimated cross-chain fee">
            {estimate((fees) => fees.crossChainFee)}
          </DetailRow>
          {/* Both fees are paid in the source's gas token, so the full amount arrives. */}
          <DetailRow label="Recipient gets">{formatAssetAmount(request.amount, asset)}</DetailRow>
          <DetailRow label="Delivery">{delivery}</DetailRow>
        </DetailList>
        {/* The approve and the burn are signed from here, so their progress shows here too. The row
            is saved once the approve lands, just before the burn. */}
        {running && (
          <TransferStateSteps
            state={saved || quote.data?.needsApproval === false ? "source-submitted" : "approval-required"}
            running
          />
        )}
        {recordedBy && <BurnRecordedAlert asset={asset} recordedBy={recordedBy} />}
        {held.status === "unreadable" && <HeldBurnUnreadableAlert error={held.error} />}
        {quote.error && !recordedBy && (
          <Alert variant="destructive">
            <WarningTriangle />
            <AlertTitle>Couldn&apos;t check this transfer</AlertTitle>
            <AlertDescription>
              {describeError(quote.error)}{" "}
              {quoteFailedHint(actions, running)}
            </AlertDescription>
            {actions.requote && (
              <AlertAction>
                <Button size="sm" variant="outline" disabled={quote.isFetching} onClick={() => void quote.refetch()}>
                  {quote.isFetching ? <Spinner data-icon="inline-start" /> : <Refresh data-icon="inline-start" />}
                  {quote.isFetching ? "Asking…" : "Ask again"}
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        {starting.error && !recordedBy && <ErrorAlert error={starting.error} />}
      </DialogBody>
      <DialogFooter>
        {actions.edit && (
          <Button variant="outline" onClick={onEdit}>
            <ArrowLeft data-icon="inline-start" />
            Edit
          </Button>
        )}
        <Button disabled={!actions.canConfirm} onClick={() => starting.mutate()}>
          {running && <Spinner data-icon="inline-start" />}
          {running ? "Transferring…" : actions.confirm === "sign" ? "Sign and transfer" : "Try this transfer again"}
        </Button>
      </DialogFooter>
    </>
  );
}

type StartedTransferProps = { assetId: string; transferId: string };

// Reads the transfer back from what's saved, so its progress stays current.
function StartedTransfer({ assetId, transferId }: StartedTransferProps) {
  const record = useAssetRecord(assetId);
  if (!record) return <LoadingSkeleton />;
  const transfer = record.transfers.find((entry) => entry.id === transferId);
  if (!transfer) throw new Error(`Transfer ${transferId} wasn't saved`);
  return <ProgressStep asset={record.asset} transfer={transfer} transfers={record.transfers} />;
}

type ProgressStepProps = { asset: ListedAsset; transfer: TransferActivity; transfers: TransferActivity[] };

function ProgressStep({ asset, transfer, transfers }: ProgressStepProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Transfer across chains</DialogTitle>
        <DialogDescription>
          {formatAssetAmount(transfer.amount, asset)} from{" "}
          {findChain(transfer.sourceChainId).name} to{" "}
          {findChain(transfer.destinationChainId).name}.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <TransferProgress asset={asset} transfer={transfer} transfers={transfers} />
      </DialogBody>
    </>
  );
}
