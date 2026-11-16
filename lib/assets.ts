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

import { getAddress, type Address, type Hash, type Hex } from "viem";
import { ARC_TESTNET, CHAINS, findChain, type Chain, type ChainId } from "./chains";
import { Constants, type Database } from "./database.types";

type Enums = Database["public"]["Enums"];

export type AssetType = Enums["asset_type"];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  community: "Community token",
  "real-world": "Real-world asset",
};

export const RWA_CATEGORIES = Constants.public.Enums.rwa_category;

export type RwaCategory = Enums["rwa_category"];

export const DEFAULT_DECIMALS = 18;
export const MAX_DECIMALS = 18;

// pump.fun's limits. The assets table checks the same ones.
export const MAX_NAME_LENGTH = 32;
export const MAX_SYMBOL_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 280;

// pump.fun's formats and size, minus SVG. The asset-images bucket allows the same.
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_MEGABYTES = 15;
export const MAX_IMAGE_BYTES = MAX_IMAGE_MEGABYTES * 1024 * 1024;

export type TokenDetails = {
  name: string;
  symbol: string;
  description: string;
  decimals: number;
};

export type RealWorldDetails = {
  issuerName: string;
  category: RwaCategory;
  underlyingDescription: string;
  documentUrl: string | null;
};

export type AssetConfig =
  | (TokenDetails & { type: "community" })
  | (TokenDetails & { type: "real-world"; realWorld: RealWorldDetails });

export type SetupStepKind = "deploy" | "register" | "grant-bridge" | "rate-limit";

export type SetupStep = { chain: Chain; kind: SetupStepKind; label: string };

const STEPS_PER_CHAIN: { kind: SetupStepKind; label: string }[] = [
  { kind: "deploy", label: "Deploy token" },
  { kind: "register", label: "Register with CCTP" },
  { kind: "grant-bridge", label: "Give CCTP mint and burn rights" },
  { kind: "rate-limit", label: "Set transfer rate limits" },
];

// The transactions that set the token up on one chain, in order. The database checks the same count.
export function setupStepsOn(chain: Chain): SetupStep[] {
  return STEPS_PER_CHAIN.map((step) => ({ chain, ...step }));
}

export type DeployedToken = {
  chainId: ChainId;
  tokenAddress: Address;
};

export type Deployment = DeployedToken & {
  supply: bigint;
  // Keyed by checksummed address.
  balances: Partial<Record<Address, bigint>>;
};

export type SetupStepState = Enums["setup_step_state"];

// Saved the moment the wallet sends it. Reverted when it landed without doing the step.
export type SentSetupStep = { transactionHash: Hash; state: Exclude<SetupStepState, "confirmed"> };

export type ChainSetup = {
  // One per finished step, in setupStepsOn(chain) order.
  transactions: Hash[];
  // The next step, if it was sent but hasn't succeeded.
  sent: SentSetupStep | null;
};

// A chain with no saved step hasn't started.
export function setupOn(asset: Pick<AssetBase, "setups">, chainId: ChainId): ChainSetup {
  return asset.setups[chainId] ?? { transactions: [], sent: null };
}

type AssetBase = AssetConfig & {
  id: string;
  issuer: Address;
  imageUrl: string;
  createdAt: Date;
  // The CCTP token ID. Same registration caller and salt, so the same value on every chain.
  crossChainId: Hex;
  // Registered with the cross-chain ID on every chain, so a resumed setup needs it back.
  salt: Hex;
  // Only the chains with a saved step. Arc is set up first, since new supply starts there.
  setups: Partial<Record<ChainId, ChainSetup>>;
};

// An asset as saved, before its supply and balances are read from the chain.
export type SavedAsset = AssetBase & { deployments: DeployedToken[] };

export type Asset = AssetBase & {
  deployments: Deployment[];
  // Burned on one chain and not yet minted on the other.
  inTransit: bigint;
  // The part of that the app's own saved transfers account for.
  inTransitKnown: bigint;
};

// An asset in a list whose supply and balances couldn't be read, with why. Kept in the list, so
// one asset's failed read doesn't hide the others, and that asset says its numbers are missing.
export type UnreadAsset = SavedAsset & { holdingsError: unknown };

export type ListedAsset = Asset | UnreadAsset;

export function hasHoldings(asset: ListedAsset): asset is Asset {
  return !("holdingsError" in asset);
}

// Every step done on the chain, so tokens can move there.
export function isChainEnabled(asset: Pick<AssetBase, "setups">, chainId: ChainId) {
  return setupOn(asset, chainId).transactions.length === STEPS_PER_CHAIN.length;
}

export function enabledChains(asset: Pick<AssetBase, "setups">): ChainId[] {
  return CHAINS.filter((chain) => isChainEnabled(asset, chain.id)).map((chain) => chain.id);
}

// Minting happens on Arc, so a launch is done once Arc is set up.
export function isSetupComplete(asset: Pick<AssetBase, "setups">) {
  return isChainEnabled(asset, ARC_TESTNET.id);
}

export function findDeployment<Token extends DeployedToken>(
  asset: { deployments: Token[] },
  chainId: ChainId,
) {
  return asset.deployments.find((deployment) => deployment.chainId === chainId);
}

export function supplyOnNetworks(asset: Pick<Asset, "deployments">) {
  return asset.deployments.reduce((total, deployment) => total + deployment.supply, BigInt(0));
}

// What Arc issued: everything on the networks plus what's in transit between them.
export function totalSupply(asset: Asset) {
  return supplyOnNetworks(asset) + asset.inTransit;
}

// Throws for a holder whose balance wasn't read, so a missed read never shows as zero.
export function balanceOf(deployment: Deployment, holder: Address) {
  const balance = deployment.balances[getAddress(holder)];
  if (balance === undefined) throw new Error(`The balance of ${holder} wasn't read`);
  return balance;
}

// A holder's balance on one chain. Throws when the asset isn't there or the balance wasn't read.
export function balanceOn(asset: Pick<Asset, "deployments" | "symbol">, chainId: ChainId, holder: Address) {
  const deployment = findDeployment(asset, chainId);
  if (!deployment) throw new Error(`${asset.symbol} has no deployment on ${findChain(chainId).name}`);
  return balanceOf(deployment, holder);
}

export function totalBalance(asset: Asset, holder: Address) {
  return asset.deployments.reduce(
    (total, deployment) => total + balanceOf(deployment, holder),
    BigInt(0),
  );
}
