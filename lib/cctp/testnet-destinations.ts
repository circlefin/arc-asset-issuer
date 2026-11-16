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

import { DESTINATION_CHAINS, ETHEREUM_SEPOLIA, type Chain } from "@/lib/chains";

// The destinations a run covers, from TESTNET_DESTINATIONS: a comma-separated list of chain IDs.
// Ethereum Sepolia when unset or empty, the only one the dev wallet is funded on.
export function parseTestnetDestinations(value: string | undefined): Chain[] {
  const names = (value || ETHEREUM_SEPOLIA.id).split(",").map((name) => name.trim());
  return names.map((name) => {
    const destination = DESTINATION_CHAINS.find((chain) => chain.id === name);
    if (!destination) {
      const known = DESTINATION_CHAINS.map((chain) => chain.id).join(", ");
      throw new Error(`TESTNET_DESTINATIONS has ${name}, which isn't one of ${known}`);
    }
    return destination;
  });
}
