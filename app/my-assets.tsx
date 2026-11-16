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

import { Coins, Plus } from "iconoir-react";
import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { hasHoldings, totalSupply, type ListedAsset } from "@/lib/assets";
import { describeError, formatAssetAmount } from "@/lib/format";
import { AssetAvatar } from "./asset-avatar";
import { AssetBadges } from "./asset-badges";
import { useIssuedAssets } from "./asset-store";
import { CreateAssetDialog } from "./create-asset";
import { LoadingSkeleton } from "./loading-skeleton";
import { assetPath } from "./nav-items";
import { PageHeader } from "./page-header";
import { useWallet } from "./wallet";
import { WalletRequired } from "./wallet-required";

function CreateAssetButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick}>
      <Plus data-icon="inline-start" />
      Create asset
    </Button>
  );
}

export function MyAssets() {
  const { address } = useWallet();
  const [creating, setCreating] = useState(false);
  const startCreating = () => setCreating(true);

  return (
    <>
      <PageHeader title="My assets" description="Assets you launched, and how far their setup got.">
        {address && <CreateAssetButton onClick={startCreating} />}
      </PageHeader>
      {address ? (
        <IssuedAssets issuer={address} onCreate={startCreating} />
      ) : (
        <WalletRequired description="Your assets are the ones this wallet launched." />
      )}
      <CreateAssetDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

type IssuedAssetsProps = { issuer: Address; onCreate: () => void };

function IssuedAssets({ issuer, onCreate }: IssuedAssetsProps) {
  const { data: records } = useIssuedAssets(issuer);
  if (!records) return <LoadingSkeleton />;
  return <AssetGrid assets={records.map((record) => record.asset)} onCreate={onCreate} />;
}

type AssetGridProps = { assets: ListedAsset[]; onCreate: () => void };

function AssetGrid({ assets, onCreate }: AssetGridProps) {
  if (assets.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Coins />
          </EmptyMedia>
          <EmptyTitle>No assets yet</EmptyTitle>
          <EmptyDescription>Launch a community token or a real-world asset on Arc.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <CreateAssetButton onClick={onCreate} />
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {assets.map((asset) => (
        <Link key={asset.id} href={assetPath(asset.id)} className="rounded-xl">
          <Card className="h-full transition-colors hover:bg-muted/50">
            <CardHeader className="flex items-center gap-3">
              <AssetAvatar imageUrl={asset.imageUrl} symbol={asset.symbol} className="size-10" />
              <div className="flex flex-col">
                <CardTitle>{asset.name}</CardTitle>
                <CardDescription className="kicker text-xs">{asset.symbol}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <AssetBadges asset={asset} />
              {hasHoldings(asset) ? (
                <p className="text-muted-foreground">
                  Supply {formatAssetAmount(totalSupply(asset), asset)}
                </p>
              ) : (
                // Only this asset: the rest of the list still loads.
                <p className="text-destructive">Supply can&apos;t be shown. {describeError(asset.holdingsError)}</p>
              )}
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
