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

// Balances and supply, read from each chain's token. Replaces rebuilding them from saved rows.

import { getAddress, isAddressEqual, type Address } from "viem";
import type { Config } from "wagmi";
import type { TransferActivity, TransferState } from "@/lib/activity";
import { supplyOnNetworks, type Asset, type DeployedToken, type Deployment } from "@/lib/assets";
import { ARC_TESTNET, findChain } from "@/lib/chains";
import { communityTokenAbi } from "./artifacts";
import { publicFor } from "./wallet";

// Each holder costs one balance read per network, all at once. Transfer rows that any signed-in
// wallet can write add holders, so the count is capped. Above it nothing is shown, rather than
// some balances shown as if they were all.
export const MAX_HOLDERS_READ = 100;

// Each holder once, whatever the address's case.
export function holdersToRead(holders: Address[]): Address[] {
  const unique = [...new Set(holders.map((holder) => getAddress(holder)))];
  if (unique.length > MAX_HOLDERS_READ) {
    throw new Error(
      `This asset has ${unique.length} wallets to read balances for, more than the ${MAX_HOLDERS_READ} this page reads. ` +
        "Balances and supply can't be shown.",
    );
  }
  return unique;
}

// A block number reads every value as of that block. Without one, each read takes the latest.
async function readDeployment(
  token: DeployedToken,
  holders: Address[],
  wagmiConfig: Config,
  blockNumber: bigint | undefined,
): Promise<Deployment> {
  const client = publicFor(wagmiConfig, findChain(token.chainId));
  const read = { address: token.tokenAddress, abi: communityTokenAbi, blockNumber } as const;
  const [supply, ...amounts] = await Promise.all([
    client.readContract({ ...read, functionName: "totalSupply" }),
    ...holders.map((holder) => client.readContract({ ...read, functionName: "balanceOf", args: [holder] })),
  ]);
  const balances: Deployment["balances"] = {};
  holders.forEach((holder, index) => {
    balances[getAddress(holder)] = amounts[index];
  });
  return { ...token, supply, balances };
}

// Issued supply and Arc's supply from one Arc block, so a mint landing between the two reads
// can't look like more supply than was issued. The other networks read their latest block.
async function readHoldingsOnce(
  arcToken: DeployedToken,
  tokens: DeployedToken[],
  holders: Address[],
  wagmiConfig: Config,
): Promise<Pick<Asset, "deployments" | "inTransit">> {
  const arc = publicFor(wagmiConfig, ARC_TESTNET);
  // Uncached, so a re-read sees a newer block than the read before it.
  const arcBlock = await arc.getBlockNumber({ cacheTime: 0 });
  const [issued, deployments] = await Promise.all([
    arc.readContract({
      address: arcToken.tokenAddress,
      abi: communityTokenAbi,
      functionName: "issuedSupply",
      blockNumber: arcBlock,
    }),
    Promise.all(
      tokens.map((token) =>
        readDeployment(token, holders, wagmiConfig, token.chainId === ARC_TESTNET.id ? arcBlock : undefined),
      ),
    ),
  ]);
  return { deployments, inTransit: issued - supplyOnNetworks({ deployments }) };
}

// Every read must succeed, so a dropped connection shows as an error, never as a zero balance.
// In transit is what the issuer minted on Arc that no chain holds right now: burned on one
// chain and not yet minted on the other.
// The chains aren't read at one moment, so a transfer that burns and mints between their reads
// is counted on both, and in transit reads negative. That's read once more before it's shown:
// still negative then, the networks really hold more than Arc issued.
export async function readHoldings(
  tokens: DeployedToken[],
  holders: Address[],
  wagmiConfig: Config,
): Promise<Pick<Asset, "deployments" | "inTransit">> {
  const holdersRead = holdersToRead(holders);
  const arcToken = tokens.find((token) => token.chainId === ARC_TESTNET.id);
  if (!arcToken) return { deployments: [], inTransit: BigInt(0) };
  const first = await readHoldingsOnce(arcToken, tokens, holdersRead, wagmiConfig);
  if (first.inTransit >= BigInt(0)) return first;
  return readHoldingsOnce(arcToken, tokens, holdersRead, wagmiConfig);
}

// Burned on the source and not yet minted on the destination. A transfer waiting for approval
// hasn't burned, a failed burn left nothing, and a complete one is minted. The database sums the
// same states in public.in_flight_transfer_totals, and a test checks the two lists match.
export const IN_FLIGHT_STATES: readonly TransferState[] = [
  "source-submitted",
  "awaiting-attestation",
  "delivering",
  "delivery-failed",
];

// The sender's transfers that are still saved as in flight, which only the sender can move on.
export function inFlightTransfersSentBy<Transfer extends Pick<TransferActivity, "state" | "sender">>(
  transfers: Transfer[],
  sender: Address,
) {
  return transfers.filter(
    (transfer) => IN_FLIGHT_STATES.includes(transfer.state) && isAddressEqual(transfer.sender, sender),
  );
}

export type SupplyReconciliation =
  | { kind: "reconciled" }
  // The networks hold more than Arc ever issued. Read only from the chains, so it can't be forged.
  | { kind: "supply-above-issued"; excess: bigint }
  // The saved transfers in flight add up to more than is missing from the networks. Those rows
  // aren't checked onchain, and a transfer Circle delivered stays in flight until its sender
  // reopens it, so this is a notice, not a fault.
  | { kind: "transfers-exceed-in-transit"; unaccounted: bigint };

// Issued supply always equals what the networks hold plus what's in transit, since in transit is
// the difference. So the checks are that the difference isn't negative and that it covers every
// transfer the app knows is in flight. More in transit than that is fine: a transfer made outside the app.
export function reconcileSupply({
  inTransit,
  inTransitKnown,
}: Pick<Asset, "inTransit" | "inTransitKnown">): SupplyReconciliation {
  if (inTransit < BigInt(0)) return { kind: "supply-above-issued", excess: -inTransit };
  if (inTransitKnown > inTransit) {
    return { kind: "transfers-exceed-in-transit", unaccounted: inTransitKnown - inTransit };
  }
  return { kind: "reconciled" };
}
