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

import { Refresh, Trash, WarningTriangle } from "iconoir-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ARC_TESTNET, transactionUrl } from "@/lib/chains";
import { describeError } from "@/lib/format";
import { UnsavedMintError } from "@/lib/unsaved-mints";
import { useAssetStore } from "./asset-store";
import { ExplorerLink } from "./explorer-link";

// A mint sent before a reload that Supabase wouldn't save. Shown on every page until it's saved
// or discarded.
export function UnsavedMintAlert() {
  const { unsavedMintFailure, retryUnsavedMints, discardUnsavedMint } = useAssetStore();
  if (!unsavedMintFailure) return null;
  const mint = unsavedMintFailure instanceof UnsavedMintError ? unsavedMintFailure.mint : null;

  return (
    <Alert variant="destructive">
      <WarningTriangle />
      <AlertTitle>A mint you sent wasn&apos;t saved</AlertTitle>
      <AlertDescription>
        <p>{describeError(unsavedMintFailure)}</p>
        {mint && (
          <p>
            Discarding keeps the tokens minted, but the mint won&apos;t show in Activity. Transaction{" "}
            <ExplorerLink href={transactionUrl(ARC_TESTNET, mint.transactionHash)} value={mint.transactionHash} />
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={retryUnsavedMints}>
            <Refresh data-icon="inline-start" />
            Try again
          </Button>
          {mint && (
            <Button size="sm" variant="outline" onClick={() => discardUnsavedMint(mint.id)}>
              <Trash data-icon="inline-start" />
              Discard
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
