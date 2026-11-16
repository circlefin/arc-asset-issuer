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

import type { Address } from "viem";
import { ARC_TESTNET, type Chain } from "@/lib/chains";
import { shortenHex } from "@/lib/format";
import { DetailList, DetailRow } from "./details";

type MintingPermissionsProps = {
  issuer: Address;
  // The networks the asset is enabled on besides Arc, where only CCTP mints.
  networks: Chain[];
};

// Issuer minting creates supply, on Arc only. Bridge minting only replaces what was burned elsewhere.
export function MintingPermissions({ issuer, networks }: MintingPermissionsProps) {
  return (
    <DetailList>
      <DetailRow label={`Issuer mint on ${ARC_TESTNET.name}`}>
        Only <span className="font-mono">{shortenHex(issuer)}</span>. Creates new supply.
      </DetailRow>
      {[ARC_TESTNET, ...networks].map((chain) => (
        <DetailRow key={chain.id} label={`Bridge mint on ${chain.name}`}>
          Only CCTP. Replaces tokens burned on another chain.
        </DetailRow>
      ))}
    </DetailList>
  );
}
