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
import { balanceOf, enabledChains, type Asset } from "../assets";
import { ARC_TESTNET, DESTINATION_CHAINS, type Chain, type ChainId } from "../chains";

// Arc is the hub, so a route always has Arc on exactly one side.
export type Route = { source: Chain; destination: Chain };

// Arc to each enabled network, then back to Arc from each enabled network the holder holds on.
export function transferRoutes(enabled: ChainId[], heldOn: ChainId[]): Route[] {
  const networks = DESTINATION_CHAINS.filter((chain) => enabled.includes(chain.id));
  const outbound = networks.map((chain) => ({ source: ARC_TESTNET, destination: chain }));
  const inbound = networks
    .filter((chain) => heldOn.includes(chain.id))
    .map((chain) => ({ source: chain, destination: ARC_TESTNET }));
  return [...outbound, ...inbound];
}

// The "To" options for a holder: "From" follows from the route. Without a wallet there's nothing
// held, so only Arc's routes. A balance that wasn't read throws, so a failed read never hides a route.
export function holderRoutes(asset: Pick<Asset, "setups" | "deployments">, holder: Address | null) {
  const heldOn = holder
    ? asset.deployments
        .filter((deployment) => balanceOf(deployment, holder) > BigInt(0))
        .map((deployment) => deployment.chainId)
    : [];
  return transferRoutes(enabledChains(asset), heldOn);
}

export function routeLabel(route: Route) {
  return route.source.id === ARC_TESTNET.id
    ? route.destination.name
    : `${route.destination.name} · from ${route.source.name}`;
}

export function isRoute(source: Chain, destination: Chain) {
  return (source.id === ARC_TESTNET.id) !== (destination.id === ARC_TESTNET.id);
}
