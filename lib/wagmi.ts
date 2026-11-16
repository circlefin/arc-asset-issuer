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

import { createConfig, http } from "wagmi";
import { ARC_TESTNET, CHAINS, DESTINATION_CHAINS } from "./chains";

// No connectors listed: browser wallets announce themselves over EIP-6963.
export const wagmiConfig = createConfig({
  chains: [ARC_TESTNET.network, ...DESTINATION_CHAINS.map((chain) => chain.network)],
  transports: Object.fromEntries(CHAINS.map((chain) => [chain.network.id, http()])),
  // Pages render on the server first, where there's no wallet.
  ssr: true,
});
