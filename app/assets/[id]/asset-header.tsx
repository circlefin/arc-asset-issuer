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

import type { ListedAsset } from "@/lib/assets";
import { AssetAvatar } from "../../asset-avatar";
import { AssetBadges } from "../../asset-badges";
import { PageHeader } from "../../page-header";

type AssetHeaderProps = {
  asset: ListedAsset;
  title: string;
  children?: React.ReactNode;
};

// The asset's face on its own pages: image, symbol and status above the page's title.
export function AssetHeader({ asset, title, children }: AssetHeaderProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <AssetAvatar imageUrl={asset.imageUrl} symbol={asset.symbol} className="size-10" />
        <div className="flex flex-col gap-1">
          <span className="kicker text-xs text-muted-foreground">{asset.symbol}</span>
          <AssetBadges asset={asset} />
        </div>
      </div>
      <PageHeader title={title}>{children}</PageHeader>
    </div>
  );
}
