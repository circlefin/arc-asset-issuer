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

import { Badge } from "@/components/ui/badge";
import { ASSET_TYPE_LABELS, isSetupComplete, type ListedAsset } from "@/lib/assets";
import { ARC_TESTNET } from "@/lib/chains";
import { setupKey, useAssetStore } from "./asset-store";

export function AssetBadges({ asset }: { asset: ListedAsset }) {
  const { runningSetups } = useAssetStore();

  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant="secondary">{ASSET_TYPE_LABELS[asset.type]}</Badge>
      {isSetupComplete(asset) ? (
        <Badge variant="success">Live</Badge>
      ) : runningSetups.includes(setupKey(asset.id, ARC_TESTNET.id)) ? (
        <Badge variant="outline">Setting up</Badge>
      ) : (
        <Badge variant="outline" className="text-warning">
          Setup interrupted
        </Badge>
      )}
    </div>
  );
}
