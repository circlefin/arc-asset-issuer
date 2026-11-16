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

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, DataTransferBoth, InfoCircle, Plus, Refresh, WarningTriangle } from "iconoir-react";
import Link from "next/link";
import { useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ASSET_TYPE_LABELS,
  balanceOf,
  hasHoldings,
  isChainEnabled,
  isSetupComplete,
  supplyOnNetworks,
  totalBalance,
  totalSupply,
  type Asset,
} from "@/lib/assets";
import type { TransferActivity } from "@/lib/activity";
import { inFlightTransfersSentBy, reconcileSupply, type SupplyReconciliation } from "@/lib/cctp/holdings";
import { holderRoutes } from "@/lib/cctp/routes";
import { ARC_TESTNET, DESTINATION_CHAINS, findChain } from "@/lib/chains";
import { formatAssetAmount } from "@/lib/format";
import { AssetContracts } from "../../asset-contracts";
import { ASSETS_QUERY_KEY } from "../../asset-store";
import { AssetNetworks } from "../../asset-networks";
import { DetailList, DetailRow } from "../../details";
import { HoldingsUnreadAlert } from "../../error-alert";
import { LoadingSkeleton } from "../../loading-skeleton";
import { MintingPermissions } from "../../minting-permissions";
import { MintDialog } from "../../mint-dialog";
import { RealWorldDetailsList } from "../../real-world-details";
import { SetupProgress } from "../../setup-progress";
import { ACTIVITY_PATH } from "../../nav-items";
import { TransferDialog } from "../../transfer-dialog";
import { useAssetRecord } from "../../use-asset";
import { useWallet } from "../../wallet";
import { AssetHeader } from "./asset-header";

export function AssetDetails({ assetId }: { assetId: string }) {
  const record = useAssetRecord(assetId);
  const { address } = useWallet();
  const [minting, setMinting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  if (!record) return <LoadingSkeleton />;
  const { asset, transfers } = record;
  const complete = isSetupComplete(asset);
  const isIssuer = address !== null && isAddressEqual(address, asset.issuer);
  const canTransfer = complete && hasHoldings(asset);
  // There's somewhere to send only once the issuer enables a network.
  const noRoutes = canTransfer && holderRoutes(asset, address).length === 0;

  return (
    <>
      <AssetHeader asset={asset} title={asset.name}>
        {complete && isIssuer && (
          <Button onClick={() => setMinting(true)}>
            <Plus data-icon="inline-start" />
            Mint tokens
          </Button>
        )}
        {canTransfer && (
          <Button
            variant="outline"
            disabled={noRoutes}
            onClick={() => setTransferring(true)}
          >
            <DataTransferBoth data-icon="inline-start" />
            Transfer across chains
          </Button>
        )}
      </AssetHeader>
      <MintDialog asset={asset} open={minting} onOpenChange={setMinting} />
      {hasHoldings(asset) && <TransferDialog asset={asset} open={transferring} onOpenChange={setTransferring} />}

      <div className="grid gap-6 md:grid-cols-2">
        {!complete && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Setup</CardTitle>
            </CardHeader>
            <CardContent>
              <SetupProgress asset={asset} chain={ARC_TESTNET} />
            </CardContent>
          </Card>
        )}
        {noRoutes && <TransfersOffAlert isIssuer={isIssuer} />}
        {hasHoldings(asset) ? (
          <SupplyCard asset={asset} transfers={transfers} viewer={address} />
        ) : (
          <UnreadSupplyCard error={asset.holdingsError} />
        )}
        {address && hasHoldings(asset) && <BalancesCard asset={asset} holder={address} />}
        <Card>
          <CardHeader>
            <CardTitle>Contracts</CardTitle>
          </CardHeader>
          <CardContent>
            <AssetContracts asset={asset} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Minting permissions</CardTitle>
          </CardHeader>
          <CardContent>
            <MintingPermissions
              issuer={asset.issuer}
              networks={DESTINATION_CHAINS.filter((chain) => isChainEnabled(asset, chain.id))}
            />
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DetailList>
              <DetailRow label="Type">{ASSET_TYPE_LABELS[asset.type]}</DetailRow>
              <DetailRow label="Description">{asset.description}</DetailRow>
              <DetailRow label="Decimals">{asset.decimals}</DetailRow>
            </DetailList>
            {asset.type === "real-world" && (
              <RealWorldDetailsList details={asset.realWorld} />
            )}
          </CardContent>
        </Card>
        {complete && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Networks</CardTitle>
            </CardHeader>
            <CardContent>
              <AssetNetworks asset={asset} />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

// Why Transfer across chains is disabled, and who can turn it on.
function TransfersOffAlert({ isIssuer }: { isIssuer: boolean }) {
  return (
    <Alert variant="warning" className="md:col-span-2">
      <WarningTriangle />
      <AlertTitle>Transfers are off</AlertTitle>
      <AlertDescription>
        {isIssuer
          ? "No network is enabled yet. Enable one in Networks below."
          : "No network is enabled yet. Only the issuer can enable one."}
      </AlertDescription>
    </Alert>
  );
}

type SupplyCardProps = { asset: Asset; transfers: TransferActivity[]; viewer: Address | null };

function SupplyCard({ asset, transfers, viewer }: SupplyCardProps) {
  const format = (amount: bigint) => formatAssetAmount(amount, asset);
  const deployed = asset.deployments.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Supply</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <DetailList>
          {asset.deployments.map((deployment) => (
            <DetailRow key={deployment.chainId} label={findChain(deployment.chainId).name}>
              {format(deployment.supply)}
            </DetailRow>
          ))}
          <DetailRow label="In transit between chains">{format(asset.inTransit)}</DetailRow>
          {deployed && <DetailRow label="In transfers made here">{format(asset.inTransitKnown)}</DetailRow>}
          <DetailRow label="Total supply">{format(totalSupply(asset))}</DetailRow>
        </DetailList>
        {deployed && <Reconciliation asset={asset} transfers={transfers} viewer={viewer} />}
        <p className="text-muted-foreground">
          New supply is only minted on {ARC_TESTNET.name}.
        </p>
      </CardContent>
    </Card>
  );
}

// A network's read failed, so no number is shown rather than some of them. The rest of the page
// doesn't need them, and checking again reads them all.
function UnreadSupplyCard({ error }: { error: unknown }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Supply</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <HoldingsUnreadAlert error={error} />
        <div>
          <CheckAgainButton />
        </div>
        <p className="text-muted-foreground">
          New supply is only minted on {ARC_TESTNET.name}.
        </p>
      </CardContent>
    </Card>
  );
}

// Every number in the card comes from one read, so checking again reads them all at once.
function CheckAgainButton() {
  const queryClient = useQueryClient();
  const checking = useIsFetching({ queryKey: ASSETS_QUERY_KEY }) > 0;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={checking}
      onClick={() => void queryClient.invalidateQueries({ queryKey: ASSETS_QUERY_KEY })}
    >
      <Refresh data-icon="inline-start" />
      Check again
    </Button>
  );
}

function Reconciliation({ asset, transfers, viewer }: SupplyCardProps) {
  const result = reconcileSupply(asset);
  if (result.kind === "reconciled") {
    return (
      <Badge variant="success">
        <CheckCircle data-icon="inline-start" />
        Reconciled
      </Badge>
    );
  }
  if (result.kind === "supply-above-issued") return <SupplyAboveIssuedAlert asset={asset} excess={result.excess} />;
  return <SavedTransfersNotice asset={asset} result={result} transfers={transfers} viewer={viewer} />;
}

// Read only from the chains, so no saved row can raise it.
function SupplyAboveIssuedAlert({ asset, excess }: { asset: Asset; excess: bigint }) {
  const format = (amount: bigint) => formatAssetAmount(amount, asset);
  return (
    <Alert variant="destructive">
      <WarningTriangle />
      <AlertTitle>Supply doesn&apos;t reconcile</AlertTitle>
      <AlertDescription>
        The networks hold {format(supplyOnNetworks(asset))}, which is {format(excess)} more than the{" "}
        {format(totalSupply(asset))} issued on {ARC_TESTNET.name}.
      </AlertDescription>
      <AlertAction>
        <CheckAgainButton />
      </AlertAction>
    </Alert>
  );
}

type SavedTransfersNoticeProps = SupplyCardProps & {
  result: Extract<SupplyReconciliation, { kind: "transfers-exceed-in-transit" }>;
};

// Any signed-in wallet can save a transfer row, and a transfer Circle delivered stays in flight
// until its sender next opens the app. So this is a notice about the saved rows, not a supply fault.
function SavedTransfersNotice({ asset, result, transfers, viewer }: SavedTransfersNoticeProps) {
  const format = (amount: bigint) => formatAssetAmount(amount, asset);
  const yours = viewer ? inFlightTransfersSentBy(transfers, viewer) : [];
  return (
    <Alert>
      <InfoCircle />
      <AlertTitle>Saved transfers are ahead of the chains</AlertTitle>
      <AlertDescription>
        <p>
          Transfers saved here have {format(asset.inTransitKnown)} in flight, {format(result.unaccounted)} more than
          the {format(asset.inTransit)} missing from the networks. These numbers come from saved transfers, which
          aren&apos;t checked onchain. Circle may already have delivered some of them: a transfer stays in flight
          here until its sender next opens the app, and this clears then.
        </p>
        {yours.length > 0 && (
          <p>
            {yours.length === 1
              ? "You sent one of these transfers. Open it in Activity to finish it."
              : `You sent ${yours.length} of these transfers. Open them in Activity to finish them.`}
          </p>
        )}
      </AlertDescription>
      <AlertAction>
        {yours.length > 0 ? (
          <Link href={ACTIVITY_PATH} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Open Activity
          </Link>
        ) : (
          <CheckAgainButton />
        )}
      </AlertAction>
    </Alert>
  );
}

function BalancesCard({ asset, holder }: { asset: Asset; holder: Address }) {
  const format = (amount: bigint) => formatAssetAmount(amount, asset);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your balances</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailList>
          {asset.deployments.map((deployment) => (
            <DetailRow key={deployment.chainId} label={findChain(deployment.chainId).name}>
              {format(balanceOf(deployment, holder))}
            </DetailRow>
          ))}
          <DetailRow label="Total">{format(totalBalance(asset, holder))}</DetailRow>
        </DetailList>
      </CardContent>
    </Card>
  );
}
