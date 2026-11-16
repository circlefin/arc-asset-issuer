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

import { Activity as ActivityIcon, Refresh } from "iconoir-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ACTIVITY_KIND_LABELS,
  isSetupActivity,
  MINT_STATE_LABELS,
  TRANSFER_STATE_LABELS,
  type Activity,
  type IssuerMintActivity,
  type TransferActivity,
} from "@/lib/activity";
import { isChainEnabled, setupOn, setupStepsOn, type ListedAsset } from "@/lib/assets";
import { ARC_TESTNET, findChain, transactionUrl } from "@/lib/chains";
import { formatAssetAmount, formatDate, shortenHex } from "@/lib/format";
import { AssetAvatar } from "../asset-avatar";
import { setupKey, useActivity, useAssetStore } from "../asset-store";
import { ExplorerLink } from "../explorer-link";
import { LoadingSkeleton } from "../loading-skeleton";
import { assetPath } from "../nav-items";
import { PageHeader } from "../page-header";
import { TransferProgressDialog } from "../transfer-dialog";
import { RetryDeliveryButton, useHeldBurn } from "../transfer-progress";
import { useWallet } from "../wallet";
import { WalletRequired } from "../wallet-required";

export function ActivityTable() {
  const { address } = useWallet();

  return (
    <>
      <PageHeader
        title="Activity"
        description="Launches, mints and transfers, with their progress. All on testnet."
      />
      {address ? (
        <WalletActivity wallet={address} />
      ) : (
        <WalletRequired description="Activity is the history of this wallet and its assets." />
      )}
    </>
  );
}

function WalletActivity({ wallet }: { wallet: Address }) {
  const { data } = useActivity(wallet);
  // Once per load, not once per row.
  const transfersByAsset = useMemo(() => data && groupTransfers(data.activity, data.assets), [data]);
  if (!data || !transfersByAsset) return <LoadingSkeleton />;
  const { activity, assets } = data;
  if (activity.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>No activity yet</EmptyTitle>
          <EmptyDescription>
            Launches, mints and transfers for this wallet will show up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Card>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Activity</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activity.map((entry) => {
              const asset = assets.find((candidate) => candidate.id === entry.assetId);
              const transfers = transfersByAsset.get(entry.assetId);
              if (!asset || !transfers) throw new Error(`Activity ${entry.id} points at a missing asset`);
              return <ActivityRow key={entry.id} entry={entry} asset={asset} transfers={transfers} />;
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// The wallet's transfers of each asset, where one transfer's burn may be saved on another's row.
function groupTransfers(activity: Activity[], assets: ListedAsset[]) {
  const byAsset = new Map<string, TransferActivity[]>(assets.map((asset) => [asset.id, []]));
  for (const entry of activity) {
    if (entry.kind === "transfer") byAsset.get(entry.assetId)?.push(entry);
  }
  return byAsset;
}

type ActivityRowProps = { entry: Activity; asset: ListedAsset; transfers: TransferActivity[] };

function ActivityRow({ entry, asset, transfers }: ActivityRowProps) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          {ACTIVITY_KIND_LABELS[entry.kind]}
          <span className="text-xs text-muted-foreground">{formatDate(entry.createdAt)}</span>
        </div>
      </TableCell>
      <TableCell>
        <Link
          href={assetPath(asset.id)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <AssetAvatar imageUrl={asset.imageUrl} symbol={asset.symbol} className="size-5" />
          {asset.symbol}
        </Link>
      </TableCell>
      <ActivityCells entry={entry} asset={asset} transfers={transfers} />
    </TableRow>
  );
}

// Details, status and transaction, which differ by kind.
function ActivityCells({ entry, asset, transfers }: ActivityRowProps) {
  const { runningSetups } = useAssetStore();

  if (isSetupActivity(entry)) {
    const chain = findChain(entry.chainId);
    const { transactions } = setupOn(asset, chain.id);
    const [deployment] = transactions;
    return (
      <>
        <TableCell>
          {transactions.length} of {setupStepsOn(chain).length} setup transactions on {chain.name}
        </TableCell>
        <TableCell>
          {isChainEnabled(asset, chain.id) ? (
            <Badge variant="success">Complete</Badge>
          ) : runningSetups.includes(setupKey(asset.id, chain.id)) ? (
            <Badge variant="outline">Setting up</Badge>
          ) : (
            <Link
              href={assetPath(asset.id)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Resume setup
            </Link>
          )}
        </TableCell>
        <TableCell>
          {deployment ? (
            <ExplorerLink
              href={transactionUrl(chain, deployment)}
              value={deployment}
            />
          ) : (
            <span className="text-muted-foreground">Not yet</span>
          )}
        </TableCell>
      </>
    );
  }

  if (entry.kind === "issuer-mint") {
    return (
      <>
        <TableCell>
          {formatAssetAmount(entry.amount, asset)} to{" "}
          <span className="font-mono">{shortenHex(entry.recipient)}</span>
        </TableCell>
        <TableCell>
          <MintStatus mint={entry} asset={asset} />
        </TableCell>
        <TableCell>
          <ExplorerLink
            href={transactionUrl(ARC_TESTNET, entry.transactionHash)}
            value={entry.transactionHash}
          />
        </TableCell>
      </>
    );
  }

  const source = findChain(entry.sourceChainId);
  return (
    <>
      <TableCell>
        <div className="flex flex-col">
          {formatAssetAmount(entry.amount, asset)}
          <span className="text-xs text-muted-foreground">
            {source.name} to {findChain(entry.destinationChainId).name}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <TransferStatus transfer={entry} asset={asset} transfers={transfers} />
      </TableCell>
      <TableCell>
        {entry.sourceTransactionHash ? (
          <ExplorerLink
            href={transactionUrl(source, entry.sourceTransactionHash)}
            value={entry.sourceTransactionHash}
          />
        ) : (
          <span className="text-muted-foreground">Not yet</span>
        )}
      </TableCell>
    </>
  );
}

const MINT_BADGE_VARIANTS = {
  pending: "outline",
  confirmed: "success",
  reverted: "destructive",
} as const;

function MintStatus({ mint, asset }: { mint: IssuerMintActivity; asset: ListedAsset }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={MINT_BADGE_VARIANTS[mint.state]}>{MINT_STATE_LABELS[mint.state]}</Badge>
      {mint.state === "pending" && <FinishMint mint={mint} asset={asset} />}
    </div>
  );
}

// A mint sent before a refresh is checked on as soon as the issuer sees it. Only the issuer can
// save how it ended, so anyone else sees it confirming until then.
function FinishMint({ mint, asset }: { mint: IssuerMintActivity; asset: ListedAsset }) {
  const { finishMint, runningMints, failures } = useAssetStore();
  const { address } = useWallet();
  const isIssuer = address !== null && isAddressEqual(address, asset.issuer);
  // Checked once on its own. After a failure, only the button checks again.
  const checked = useRef(false);
  useEffect(() => {
    if (!isIssuer || checked.current) return;
    checked.current = true;
    finishMint(mint);
  }, [isIssuer, finishMint, mint]);

  const failure = failures[mint.id];
  if (!isIssuer || runningMints.includes(mint.id) || !failure) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => finishMint(mint)}>
        <Refresh data-icon="inline-start" />
        Check again
      </Button>
      <span className="max-w-64 text-xs whitespace-normal text-destructive">{failure}</span>
    </>
  );
}

type TransferStatusProps = { asset: ListedAsset; transfer: TransferActivity; transfers: TransferActivity[] };

function TransferStatus({ asset, transfer, transfers }: TransferStatusProps) {
  const held = useHeldBurn(transfer, transfers);
  const recordedBy = held.status === "held" ? held.recordedBy : null;

  return (
    <div className="flex flex-col items-start gap-1">
      {held.status === "unreadable" ? (
        <>
          <Badge variant="destructive">Blocked</Badge>
          {/* Never resumed on a guess: a burn of this transfer's may be among the unreadable ones. */}
          <span className="max-w-64 text-xs whitespace-normal text-destructive">
            This browser&apos;s unsaved burns can&apos;t be read, so this transfer won&apos;t resume and pay twice.
            View progress to clear them.
          </span>
        </>
      ) : recordedBy ? (
        <>
          <Badge variant="destructive">Burn recorded elsewhere</Badge>
          {/* Never resumed: the burn went out once, on the transfer named here. */}
          <span className="max-w-64 text-xs whitespace-normal text-muted-foreground">
            {recordedBy.bySender
              ? `Its burn is saved on your transfer from ${formatDate(recordedBy.transfer.createdAt)}. Follow that one.`
              : "Another wallet's transfer recorded its burn. It won't be sent again. View progress for what to do."}
          </span>
        </>
      ) : transfer.state === "delivery-failed" ? (
        <>
          <Badge variant="destructive">{TRANSFER_STATE_LABELS[transfer.state]}</Badge>
          <RetryDeliveryButton transfer={transfer} />
        </>
      ) : transfer.state === "burn-failed" ? (
        <Badge variant="destructive">{TRANSFER_STATE_LABELS[transfer.state]}</Badge>
      ) : (
        <Badge variant={transfer.state === "complete" ? "success" : "outline"}>
          {TRANSFER_STATE_LABELS[transfer.state]}
        </Badge>
      )}
      <ViewTransferProgress asset={asset} transfer={transfer} transfers={transfers} />
    </div>
  );
}

function ViewTransferProgress({ asset, transfer, transfers }: TransferStatusProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="link" size="xs" className="px-0" onClick={() => setOpen(true)}>
        View progress
      </Button>
      <TransferProgressDialog
        asset={asset}
        transfer={transfer}
        transfers={transfers}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
