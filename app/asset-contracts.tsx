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

import { ARC_TESTNET, addressUrl, findChain } from "@/lib/chains";
import type { SavedAsset } from "@/lib/assets";
import { shortenHex } from "@/lib/format";
import { CopyButton } from "./copy-button";
import { DetailList, DetailRow } from "./details";
import { ExplorerLink } from "./explorer-link";

// Where the token lives on each chain, and the ID CCTP knows it by everywhere.
export function AssetContracts({ asset }: { asset: SavedAsset }) {
  return (
    <DetailList>
      {asset.deployments.map((deployment) => {
        const chain = findChain(deployment.chainId);
        return (
          <DetailRow key={chain.id} label={`Token on ${chain.name}`}>
            <ExplorerLink
              href={addressUrl(chain, deployment.tokenAddress)}
              value={deployment.tokenAddress}
            />
          </DetailRow>
        );
      })}
      <DetailRow label="Cross-chain ID">
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-xs" title={asset.crossChainId}>
            {shortenHex(asset.crossChainId)}
          </span>
          <CopyButton value={asset.crossChainId} label="Copy ID" />
        </span>
      </DetailRow>
      <DetailRow label="Issuer">
        <ExplorerLink href={addressUrl(ARC_TESTNET, asset.issuer)} value={asset.issuer} />
      </DetailRow>
    </DetailList>
  );
}
