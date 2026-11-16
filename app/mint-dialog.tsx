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
import { ArrowLeft, CheckCircle, Lock } from "iconoir-react";
import { useState } from "react";
import { formatUnits, isAddressEqual, type Address, type Hash } from "viem";
import { useConfig } from "wagmi";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { balanceOf, findDeployment, hasHoldings, totalSupply, type Asset, type ListedAsset } from "@/lib/assets";
import { ARC_TESTNET, addressUrl, transactionUrl } from "@/lib/chains";
import {
  formatAssetAmount,
  formatTokenAmount,
  INVALID_RECIPIENT_MESSAGE,
  parseAmount,
  parseRecipient,
  shortenHex,
} from "@/lib/format";
import { estimateMintCost, MintSentError } from "@/lib/cctp/mint";
import { useAssetStore, type MintOrder } from "./asset-store";
import { CopyButton } from "./copy-button";
import { DetailList, DetailRow } from "./details";
import { ErrorAlert, HoldingsUnreadAlert } from "./error-alert";
import { ExplorerLink } from "./explorer-link";
import { useWallet } from "./wallet";
import { WalletRequired } from "./wallet-required";

type Order = { recipient: Address; amount: bigint };

type Receipt = { order: MintOrder; transactionHash: Hash };

type Step =
  | { name: "form"; order: Order | null }
  | { name: "review"; order: MintOrder }
  | { name: "done"; receipt: Receipt };

const FORM_STEP: Step = { name: "form", order: null };

const MINT_FORM_ID = "mint-form";

type MintDialogProps = {
  asset: ListedAsset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Closing keeps the form, so a stray click outside loses nothing. After a mint, the next one starts fresh.
export function MintDialog({ asset, open, onOpenChange }: MintDialogProps) {
  const [step, setStep] = useState(FORM_STEP);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen && step.name === "done") setStep(FORM_STEP);
      }}
    >
      <DialogContent>
        <MintSteps asset={asset} step={step} onStepChange={setStep} />
      </DialogContent>
    </Dialog>
  );
}

type MintStepsProps = {
  asset: ListedAsset;
  step: Step;
  onStepChange: (step: Step) => void;
};

function MintSteps({ asset, step, onStepChange }: MintStepsProps) {
  const { address } = useWallet();
  if (!address || !isAddressEqual(address, asset.issuer)) {
    return <IssuerRequired asset={asset} connected={address !== null} />;
  }

  if (step.name === "done") {
    return (
      <MintReceipt
        asset={asset}
        receipt={step.receipt}
        onMintMore={() => onStepChange(FORM_STEP)}
      />
    );
  }
  if (step.name === "review") {
    return (
      <MintReview
        asset={asset}
        order={step.order}
        onEdit={() => onStepChange({ name: "form", order: step.order })}
        onMinted={(receipt) => onStepChange({ name: "done", receipt })}
      />
    );
  }

  return (
    <MintForm
      asset={asset}
      initialOrder={step.order}
      onReview={(order) =>
        onStepChange({
          name: "review",
          order: { ...order, id: crypto.randomUUID(), assetId: asset.id },
        })
      }
    />
  );
}

type IssuerRequiredProps = { asset: ListedAsset; connected: boolean };

function IssuerRequired({ asset, connected }: IssuerRequiredProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Mint tokens</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {connected ? (
          <Alert variant="destructive">
            <Lock />
            <AlertTitle>Only the issuer can mint</AlertTitle>
            <AlertDescription>
              This wallet didn&apos;t launch {asset.symbol}, so it can&apos;t create new supply.
            </AlertDescription>
          </Alert>
        ) : (
          <WalletRequired description="Only the issuer wallet can mint." />
        )}
      </DialogBody>
    </>
  );
}

type MintFormProps = {
  asset: ListedAsset;
  initialOrder: Order | null;
  onReview: (order: Order) => void;
};

function MintForm({ asset, initialOrder, onReview }: MintFormProps) {
  const [recipientText, setRecipientText] = useState(initialOrder?.recipient ?? "");
  const [amountText, setAmountText] = useState(
    initialOrder ? formatUnits(initialOrder.amount, asset.decimals) : "",
  );
  const [showErrors, setShowErrors] = useState(false);
  const recipient = parseRecipient(recipientText);
  const amount = parseAmount(amountText, asset.decimals);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Mint tokens</DialogTitle>
        <DialogDescription>
          Creates new {asset.symbol} on {ARC_TESTNET.name}.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form
          id={MINT_FORM_ID}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (recipient === null || amount === null) {
              setShowErrors(true);
              return;
            }
            onReview({ recipient, amount });
          }}
        >
          <FieldGroup>
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
            <Field data-invalid={showErrors && amount === null}>
              <FieldLabel htmlFor="amount">Amount</FieldLabel>
              <Input
                id="amount"
                inputMode="decimal"
                placeholder={`0 ${asset.symbol}`}
                value={amountText}
                aria-invalid={showErrors && amount === null}
                onChange={(event) => setAmountText(event.target.value.trim())}
              />
              {showErrors && amount === null && (
                <FieldError>
                  Enter an amount above zero, with up to {asset.decimals} decimals.
                </FieldError>
              )}
            </Field>
          </FieldGroup>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button type="submit" form={MINT_FORM_ID}>
          Review
        </Button>
      </DialogFooter>
    </>
  );
}

type MintReviewProps = {
  asset: ListedAsset;
  order: MintOrder;
  onEdit: () => void;
  onMinted: (receipt: Receipt) => void;
};

function MintReview({ asset, order, onEdit, onMinted }: MintReviewProps) {
  const { mint } = useAssetStore();
  const wagmiConfig = useConfig();
  const fee = useQuery({
    queryKey: ["mint-cost", asset.id],
    queryFn: () => estimateMintCost(asset, wagmiConfig),
    // Shown inline, so a failed estimate doesn't replace the page.
    throwOnError: false,
  });
  const minting = useMutation({
    mutationFn: () => mint(order),
    onSuccess: (transactionHash) => onMinted({ order, transactionHash }),
  });
  // Once sent, retrying only checks on the mint, so there's nothing to sign.
  const mintLabel = minting.error instanceof MintSentError ? "Check again" : "Sign and mint";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Review</DialogTitle>
        <DialogDescription>Check everything before you sign.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <DetailList>
          <DetailRow label="Network">{ARC_TESTNET.name}</DetailRow>
          <DetailRow label="Recipient">
            <span className="inline-flex items-center gap-1">
              <span className="font-mono">{shortenHex(order.recipient)}</span>
              <CopyButton value={order.recipient} label="Copy address" />
            </span>
          </DetailRow>
          <DetailRow label="Amount">{formatAssetAmount(order.amount, asset)}</DetailRow>
          <DetailRow label="Kind">Issuer mint. Creates new supply.</DetailRow>
          <DetailRow label="Estimated fee">
            {fee.data === undefined ? (
              <Spinner />
            ) : (
              `~${formatTokenAmount(fee.data, ARC_TESTNET.gasDecimals)} ${ARC_TESTNET.gasSymbol}`
            )}
          </DetailRow>
        </DetailList>
        {fee.error && <ErrorAlert error={fee.error} />}
        {minting.error && <ErrorAlert error={minting.error} />}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" disabled={minting.isPending} onClick={onEdit}>
          <ArrowLeft data-icon="inline-start" />
          Edit
        </Button>
        <Button disabled={minting.isPending} onClick={() => minting.mutate()}>
          {minting.isPending && <Spinner data-icon="inline-start" />}
          {minting.isPending ? "Confirming…" : mintLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

type MintReceiptProps = {
  asset: ListedAsset;
  receipt: Receipt;
  onMintMore: () => void;
};

function MintReceipt({ asset, receipt, onMintMore }: MintReceiptProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle className="text-success" />
          Minted
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <DetailList>
          <DetailRow label="Amount minted">{formatAssetAmount(receipt.order.amount, asset)}</DetailRow>
          <DetailRow label="Recipient">
            <ExplorerLink href={addressUrl(ARC_TESTNET, receipt.order.recipient)} value={receipt.order.recipient} />
          </DetailRow>
          {hasHoldings(asset) && <MintedHoldings asset={asset} recipient={receipt.order.recipient} />}
          <DetailRow label="Transaction">
            <ExplorerLink
              href={transactionUrl(ARC_TESTNET, receipt.transactionHash)}
              value={receipt.transactionHash}
            />
          </DetailRow>
        </DetailList>
        {!hasHoldings(asset) && <HoldingsUnreadAlert error={asset.holdingsError} />}
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        <Button onClick={onMintMore}>Mint more</Button>
      </DialogFooter>
    </>
  );
}

// The recipient's balance and the supply after the mint, read from the chain.
function MintedHoldings({ asset, recipient }: { asset: Asset; recipient: Address }) {
  const arc = findDeployment(asset, ARC_TESTNET.id);
  if (!arc) throw new Error(`${asset.symbol} has no deployment on ${ARC_TESTNET.name}`);
  return (
    <>
      <DetailRow label={`Recipient's balance on ${ARC_TESTNET.name}`}>
        {formatAssetAmount(balanceOf(arc, recipient), asset)}
      </DetailRow>
      <DetailRow label="Total supply">{formatAssetAmount(totalSupply(asset), asset)}</DetailRow>
    </>
  );
}
