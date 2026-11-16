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

import { Refresh, WarningTriangle } from "iconoir-react";
import { isAddressEqual } from "viem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isChainEnabled, setupOn, setupStepsOn, type SavedAsset } from "@/lib/assets";
import { transactionUrl, type Chain } from "@/lib/chains";
import { isAnySetupRunning, setupKey, useAssetStore } from "./asset-store";
import { ExplorerLink } from "./explorer-link";
import { ConnectWalletButton } from "./connect-wallet";
import { StepList, statusAt } from "./step-list";
import { useWallet } from "./wallet";

// Each deployment and CCTP setup transaction on one network. An interrupted setup resumes from
// the first undone step.
export function SetupProgress({ asset, chain }: { asset: SavedAsset; chain: Chain }) {
  const { runningSetups, failures } = useAssetStore();
  const key = setupKey(asset.id, chain.id);
  const running = runningSetups.includes(key);
  const failure = failures[key];
  const setup = setupOn(asset, chain.id);
  const finished = setup.transactions.length;
  // The next step's transaction, once it's sent and still landing.
  const sent = setup.sent?.state === "pending" ? setup.sent.transactionHash : undefined;

  return (
    <div className="flex flex-col gap-4">
      <StepList
        steps={setupStepsOn(chain).map((step, index) => {
          const transactionHash = index < finished ? setup.transactions[index] : index === finished && sent;
          return {
            label: step.label,
            description: step.chain.name,
            status: statusAt(index, finished, running),
            action: transactionHash && (
              <ExplorerLink href={transactionUrl(step.chain, transactionHash)} value={transactionHash} />
            ),
          };
        })}
      />
      {failure && (
        <Alert variant="destructive">
          <WarningTriangle />
          <AlertTitle>Setup stopped</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {!running && !isChainEnabled(asset, chain.id) && <ResumeSetup asset={asset} chain={chain} />}
    </div>
  );
}

// Only the issuer signs setup, so only the issuer can pick it back up. Waits while another of
// the asset's setups runs, since both would ask the same wallet to sign.
function ResumeSetup({ asset, chain }: { asset: SavedAsset; chain: Chain }) {
  const { resumeSetup, runningSetups } = useAssetStore();
  const { address } = useWallet();

  if (!address) return <ConnectWalletButton className="self-start" />;
  if (!isAddressEqual(address, asset.issuer)) {
    return (
      <p className="text-muted-foreground">Only the issuer wallet can resume setup.</p>
    );
  }
  return (
    <Button
      className="self-start"
      disabled={isAnySetupRunning(runningSetups, asset.id)}
      onClick={() => resumeSetup(asset, chain)}
    >
      <Refresh data-icon="inline-start" />
      Resume setup
    </Button>
  );
}
