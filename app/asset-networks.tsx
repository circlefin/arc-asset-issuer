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
import { Network, OpenNewWindow } from "iconoir-react";
import { Fragment } from "react";
import { isAddressEqual } from "viem";
import { useConfig } from "wagmi";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { findDeployment, isChainEnabled, setupOn, setupStepsOn, type SavedAsset } from "@/lib/assets";
import { estimateSetupCost } from "@/lib/cctp/setup";
import { addressUrl, ARC_TESTNET, DESTINATION_CHAINS, type Chain } from "@/lib/chains";
import { formatTokenAmount } from "@/lib/format";
import { isAnySetupRunning, setupKey, useAssetStore } from "./asset-store";
import { DetailList, DetailRow } from "./details";
import { ErrorAlert } from "./error-alert";
import { ExplorerLink } from "./explorer-link";
import { SetupProgress } from "./setup-progress";
import { useWallet } from "./wallet";

type NetworkState = "enabled" | "setting-up" | "not-enabled";

// The networks holders can move the asset to from Arc. The issuer sees every one, to enable it.
export function AssetNetworks({ asset }: { asset: SavedAsset }) {
  const { address } = useWallet();
  if (address === null || !isAddressEqual(address, asset.issuer)) return <EnabledNetworks asset={asset} />;

  return (
    <div className="flex flex-col gap-4">
      {DESTINATION_CHAINS.map((chain, index) => (
        <Fragment key={chain.id}>
          {index > 0 && <Separator />}
          <NetworkRow asset={asset} chain={chain} />
        </Fragment>
      ))}
    </div>
  );
}

function EnabledNetworks({ asset }: { asset: SavedAsset }) {
  const enabled = DESTINATION_CHAINS.filter((chain) => isChainEnabled(asset, chain.id));
  if (enabled.length === 0) {
    return <p className="text-sm text-muted-foreground">Only on {ARC_TESTNET.name} so far.</p>;
  }
  return (
    <DetailList>
      {enabled.map((chain) => (
        <DetailRow key={chain.id} label={chain.name}>
          <TokenLink asset={asset} chain={chain} />
        </DetailRow>
      ))}
    </DetailList>
  );
}

function NetworkRow({ asset, chain }: { asset: SavedAsset; chain: Chain }) {
  const { runningSetups, failures } = useAssetStore();
  const key = setupKey(asset.id, chain.id);
  const state = networkState(asset, chain, runningSetups.includes(key), failures[key] !== undefined);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">{chain.name}</h3>
        <div className="flex items-center gap-2">
          {!chain.testedOnchain && <Badge variant="outline">Not yet tested</Badge>}
          <NetworkBadge state={state} />
        </div>
      </div>
      {state === "enabled" && (
        <DetailList>
          <DetailRow label="Token">
            <TokenLink asset={asset} chain={chain} />
          </DetailRow>
        </DetailList>
      )}
      {state === "setting-up" && (
        <>
          <SetupProgress asset={asset} chain={chain} />
          {/* A setup that stopped for lack of gas resumes once the wallet is topped up. */}
          <SetupCost asset={asset} chain={chain} />
          <FaucetLink chain={chain} />
        </>
      )}
      {state === "not-enabled" && <EnableNetwork asset={asset} chain={chain} />}
    </section>
  );
}

// A network counts as setting up from its first saved step, or from a run that started or
// failed before saving one, so the failure and Resume stay in view.
function networkState(asset: SavedAsset, chain: Chain, running: boolean, failed: boolean): NetworkState {
  if (isChainEnabled(asset, chain.id)) return "enabled";
  const setup = setupOn(asset, chain.id);
  if (running || failed || setup.transactions.length > 0 || setup.sent !== null) return "setting-up";
  return "not-enabled";
}

function NetworkBadge({ state }: { state: NetworkState }) {
  if (state === "enabled") return <Badge variant="success">Enabled</Badge>;
  if (state === "setting-up") return <Badge variant="outline">Setting up</Badge>;
  return <Badge variant="secondary">Not enabled</Badge>;
}

function TokenLink({ asset, chain }: { asset: SavedAsset; chain: Chain }) {
  const deployment = findDeployment(asset, chain.id);
  // Every enabled network has a deploy, so this only shows while the records catch up.
  if (!deployment) return <span className="text-muted-foreground">Not deployed</span>;
  return <ExplorerLink href={addressUrl(chain, deployment.tokenAddress)} value={deployment.tokenAddress} />;
}

// What enabling costs, paid in the network's own gas token.
function SetupCost({ asset, chain }: { asset: SavedAsset; chain: Chain }) {
  const wagmiConfig = useConfig();
  const cost = useQuery({
    queryKey: ["setup-cost", asset.issuer, chain.id, asset.id],
    queryFn: () => estimateSetupCost(asset.issuer, asset, chain, wagmiConfig),
    // Shown in the row, so one network's failed estimate doesn't replace the page.
    throwOnError: false,
  });

  if (cost.error) return <ErrorAlert error={cost.error} />;
  return (
    <DetailList>
      <DetailRow label={`Estimated cost, ${setupStepsOn(chain).length} transactions`}>
        {cost.data === undefined ? (
          <Spinner />
        ) : (
          `~${formatTokenAmount(cost.data, chain.gasDecimals)} ${chain.gasSymbol}`
        )}
      </DetailRow>
    </DetailList>
  );
}

function FaucetLink({ chain }: { chain: Chain }) {
  return (
    <a
      href={chain.faucetUrl}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ variant: "link", size: "sm", className: "self-start" })}
    >
      Get {chain.gasSymbol} from a faucet
      <OpenNewWindow data-icon="inline-end" />
    </a>
  );
}

// What enabling costs and where to get the gas. Waits while any of the asset's setups runs.
function EnableNetwork({ asset, chain }: { asset: SavedAsset; chain: Chain }) {
  const { runningSetups, enableNetwork } = useAssetStore();
  const running = runningSetups.includes(setupKey(asset.id, chain.id));
  const anyRunning = isAnySetupRunning(runningSetups, asset.id);

  return (
    <div className="flex flex-col gap-3">
      <SetupCost asset={asset} chain={chain} />
      {!chain.testedOnchain && (
        <p className="text-sm text-muted-foreground">
          Set up from Circle&apos;s docs, but not yet run onchain by this app. Try a small transfer first.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={anyRunning} onClick={() => enableNetwork(asset, chain)}>
          {running ? <Spinner data-icon="inline-start" /> : <Network data-icon="inline-start" />}
          Enable
        </Button>
        <FaucetLink chain={chain} />
      </div>
    </div>
  );
}
