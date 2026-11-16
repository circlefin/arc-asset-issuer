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

// Reads and writes the saved assets and their progress. Checks every row on the way in.

import type { QueryData } from "@supabase/supabase-js";
import { getAddress, isAddressEqual, isHex, size, type Address, type Hash, type Hex } from "viem";
import {
  BurnRecordedError,
  DeliveryRecordedError,
  type Activity,
  type IssuerMintActivity,
  type MintState,
  type SetupActivity,
  type TransferActivity,
  type TransferState,
} from "./activity";
import type {
  Asset,
  AssetConfig,
  ChainSetup,
  DeployedToken,
  ListedAsset,
  SavedAsset,
  SentSetupStep,
  SetupStepState,
} from "./assets";
import { IN_FLIGHT_STATES, readHoldings } from "./cctp/holdings";
import { ARC_TESTNET, DESTINATION_CHAINS, type ChainId } from "./chains";
import type { Database } from "./database.types";
import { supabase } from "./supabase";
import { wagmiConfig } from "./wagmi";

const ASSET_IMAGES_BUCKET = "asset-images";
const BYTES32_SIZE = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres and Storage codes for a row or file that's already there.
const POSTGRES_UNIQUE_VIOLATION = "23505";
const STORAGE_ALREADY_EXISTS = "409";
// Postgres's names for the unique constraints on transfers' burn and delivery hashes.
const SOURCE_HASH_CONSTRAINT = "transfers_source_transaction_hash_key";
const DESTINATION_HASH_CONSTRAINT = "transfers_destination_transaction_hash_key";

// Amounts come back as text, since a JSON number can't hold every uint256 exactly. One list for
// a transfer, read with its asset or on its own, so both read the same row.
const TRANSFER_COLUMNS = `
  id, sender, recipient, source_chain, destination_chain, amount::text, cross_chain_fee::text,
  state, source_transaction_hash, destination_transaction_hash, created_at
`;
const ASSET_COLUMNS = `
  id, issuer, type, name, symbol, description, decimals, cross_chain_id, salt,
  issuer_name, category, underlying_description, document_url, created_at,
  setup_transactions (chain, step, transaction_hash, token_address, state, created_at),
  issuer_mints (id, recipient, amount::text, transaction_hash, state, created_at),
  transfers (${TRANSFER_COLUMNS})
` as const;

function selectAssets() {
  return supabase.from("assets").select(ASSET_COLUMNS);
}

type AssetRow = QueryData<ReturnType<typeof selectAssets>>[number];
type SetupRow = AssetRow["setup_transactions"][number];
type MintRow = AssetRow["issuer_mints"][number];
type TransferRow = AssetRow["transfers"][number];

// An asset with the setups, mints and transfers it was rebuilt from.
export type AssetRecord<RecordAsset extends ListedAsset = Asset> = {
  asset: RecordAsset;
  setups: SetupActivity[];
  mints: IssuerMintActivity[];
  transfers: TransferActivity[];
};

// A record in a list, where an asset whose balances can't be read still shows, saying so.
export type ListedRecord = AssetRecord<ListedAsset>;

function toBytes32(value: string): Hex {
  if (!isHex(value, { strict: true }) || size(value) !== BYTES32_SIZE) {
    throw new Error(`Expected 32 bytes of hex, got ${value}`);
  }
  return value;
}

function toHash(value: string): Hash {
  return toBytes32(value);
}

function toOptionalHash(value: string | null) {
  return value === null ? null : toHash(value);
}

function required<Value>(value: Value | null, column: string): Value {
  if (value === null) throw new Error(`A real-world asset is missing its ${column}`);
  return value;
}

// Storage and the database both key wallets in lowercase.
function walletKey(wallet: Address) {
  return wallet.toLowerCase();
}

function imagePath(issuer: Address, assetId: string) {
  return `${walletKey(issuer)}/${assetId}`;
}

function imageUrl(issuer: Address, assetId: string) {
  return supabase.storage.from(ASSET_IMAGES_BUCKET).getPublicUrl(imagePath(issuer, assetId))
    .data.publicUrl;
}

function toConfig(row: AssetRow): AssetConfig {
  const details = {
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    decimals: row.decimals,
  };
  if (row.type === "community") return { ...details, type: "community" };
  return {
    ...details,
    type: "real-world",
    realWorld: {
      issuerName: required(row.issuer_name, "issuer name"),
      category: required(row.category, "category"),
      underlyingDescription: required(row.underlying_description, "underlying description"),
      documentUrl: row.document_url,
    },
  };
}

function toMint(assetId: string, row: MintRow): IssuerMintActivity {
  return {
    id: row.id,
    kind: "issuer-mint",
    assetId,
    createdAt: new Date(row.created_at),
    recipient: getAddress(row.recipient),
    amount: BigInt(row.amount),
    transactionHash: toHash(row.transaction_hash),
    state: row.state,
  };
}

function toTransfer(assetId: string, row: TransferRow): TransferActivity {
  return {
    id: row.id,
    kind: "transfer",
    assetId,
    createdAt: new Date(row.created_at),
    sender: getAddress(row.sender),
    recipient: getAddress(row.recipient),
    sourceChainId: row.source_chain,
    destinationChainId: row.destination_chain,
    amount: BigInt(row.amount),
    crossChainFee: BigInt(row.cross_chain_fee),
    state: row.state,
    sourceTransactionHash: toOptionalHash(row.source_transaction_hash),
    destinationTransactionHash: toOptionalHash(row.destination_transaction_hash),
  };
}

// Everyone whose balance the asset's pages show: the issuer, anyone minted to or moving it,
// and the wallet looking, which may hold tokens sent to it outside the app. readHoldings reads
// each once, up to its cap.
function holdersOf(
  issuer: Address,
  mints: IssuerMintActivity[],
  transfers: TransferActivity[],
  viewer: Address | null,
) {
  return [
    issuer,
    ...(viewer ? [viewer] : []),
    ...mints.map((mint) => mint.recipient),
    ...transfers.flatMap((transfer) => [transfer.sender, transfer.recipient]),
  ];
}

// The step after the last confirmed one, if it was sent.
function toSentStep(setup: SetupRow[]): SentSetupStep | null {
  for (const transaction of setup) {
    if (transaction.state !== "confirmed") {
      return { transactionHash: toHash(transaction.transaction_hash), state: transaction.state };
    }
  }
  return null;
}

// Each chain's steps in order, keyed by the chain.
export function toSetups(rows: SetupRow[]) {
  const setups: Partial<Record<ChainId, ChainSetup>> = {};
  const sorted = rows.toSorted((first, second) => first.step - second.step);
  for (const chainId of new Set(sorted.map((transaction) => transaction.chain))) {
    const setup = sorted.filter((transaction) => transaction.chain === chainId);
    setups[chainId] = {
      transactions: setup
        .filter((transaction) => transaction.state === "confirmed")
        .map((transaction) => toHash(transaction.transaction_hash)),
      sent: toSentStep(setup),
    };
  }
  return setups;
}

// The token address is saved on each chain's confirmed deploy.
export function toDeployments(rows: SetupRow[]): DeployedToken[] {
  return rows.flatMap((transaction) =>
    transaction.state === "confirmed" && transaction.token_address
      ? [{ chainId: transaction.chain, tokenAddress: getAddress(transaction.token_address) }]
      : [],
  );
}

function toSavedAsset(row: AssetRow): SavedAsset {
  const issuer = getAddress(row.issuer);
  return {
    ...toConfig(row),
    id: row.id,
    issuer,
    imageUrl: imageUrl(issuer, row.id),
    createdAt: new Date(row.created_at),
    crossChainId: toBytes32(row.cross_chain_id),
    salt: toBytes32(row.salt),
    setups: toSetups(row.setup_transactions),
    deployments: toDeployments(row.setup_transactions),
  };
}

type InFlightTotalRow = Database["public"]["Functions"]["in_flight_transfer_totals"]["Returns"][number];

// Looks up each asset's sum. Throws for an asset the rows leave out, so it never shows as zero.
export function toInFlightTotals(rows: InFlightTotalRow[]) {
  const totals = new Map(rows.map((row) => [row.asset_id, BigInt(row.amount)]));
  return (assetId: string) => {
    const total = totals.get(assetId);
    if (total === undefined) throw new Error(`The transfers in flight of asset ${assetId} weren't read`);
    return total;
  };
}

// What each asset's saved transfers have in flight, summed by the database so no row cap cuts
// it short. A failed read throws instead of counting zero.
async function fetchInFlightTotals(assetIds: string[]) {
  const { data, error } = await supabase.rpc("in_flight_transfer_totals", { asset_ids: assetIds });
  if (error) throw error;
  return toInFlightTotals(data);
}

// The launch, from when the asset was saved, and each network the issuer enabled after, from its
// first saved step.
function toSetupActivities(row: AssetRow): SetupActivity[] {
  const launch: SetupActivity = {
    id: row.id,
    kind: "setup",
    assetId: row.id,
    chainId: ARC_TESTNET.id,
    createdAt: new Date(row.created_at),
  };
  const networks = DESTINATION_CHAINS.flatMap((chain): SetupActivity[] => {
    const started = row.setup_transactions
      .filter((transaction) => transaction.chain === chain.id)
      .map((transaction) => new Date(transaction.created_at).getTime());
    if (started.length === 0) return [];
    return [
      {
        id: `${row.id}-${chain.id}`,
        kind: "network-setup",
        assetId: row.id,
        chainId: chain.id,
        createdAt: new Date(Math.min(...started)),
      },
    ];
  });
  return [launch, ...networks];
}

function toRecordParts(row: AssetRow, viewer: Address | null) {
  const saved = toSavedAsset(row);
  const setups = toSetupActivities(row);
  const mints = row.issuer_mints.map((mint) => toMint(row.id, mint));
  const transfers = row.transfers.map((transfer) => toTransfer(row.id, transfer));
  return { saved, setups, mints, transfers, holders: holdersOf(saved.issuer, mints, transfers, viewer) };
}

// Balances and supply come from the chain, so they're right even if a save was missed. An asset
// whose balances can't be read, as when one of its networks is down or its saved rows name more
// holders than readHoldings reads, keeps the error in its place instead of failing its page or list.
async function toRecord(
  row: AssetRow,
  viewer: Address | null,
  inFlightTotals: ReturnType<typeof fetchInFlightTotals>,
): Promise<ListedRecord> {
  const { saved, setups, mints, transfers, holders } = toRecordParts(row, viewer);
  const holdings = readHoldings(saved.deployments, holders, wagmiConfig).then(
    (read) => ({ read }),
    (holdingsError: unknown) => ({ holdingsError }),
  );
  const [result, inFlightOf] = await Promise.all([holdings, inFlightTotals]);
  if ("holdingsError" in result) {
    // The page shows the message on the asset. The full error is kept here for debugging.
    console.error(result.holdingsError);
    return { asset: { ...saved, holdingsError: result.holdingsError }, setups, mints, transfers };
  }
  return { asset: { ...saved, ...result.read, inTransitKnown: inFlightOf(row.id) }, setups, mints, transfers };
}

// One sum read for every asset, alongside the chain reads. A failed sum fails the list; a failed
// chain read fails only its asset.
export function toListedRecords(rows: AssetRow[], viewer: Address | null): Promise<ListedRecord[]> {
  if (rows.length === 0) return Promise.resolve([]);
  const inFlightTotals = fetchInFlightTotals(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => toRecord(row, viewer, inFlightTotals)));
}

// Null when there's no such asset, including when the ID isn't one.
async function fetchAssetRow(assetId: string) {
  if (!UUID_PATTERN.test(assetId)) return null;
  const { data, error } = await selectAssets().eq("id", assetId).maybeSingle();
  if (error) throw error;
  return data;
}

// The viewer is the signed-in wallet, if any, so its own balances are read too.
export async function fetchAsset(assetId: string, viewer: Address | null): Promise<ListedRecord | null> {
  const row = await fetchAssetRow(assetId);
  if (!row) return null;
  return toRecord(row, viewer, fetchInFlightTotals([row.id]));
}

// Without reading the chain, so a slow or failed balance read can't stop setup or a mint.
export async function fetchSavedAsset(assetId: string): Promise<SavedAsset | null> {
  const row = await fetchAssetRow(assetId);
  return row && toSavedAsset(row);
}

async function fetchAssets(assetIds: string[], viewer: Address) {
  const { data, error } = await selectAssets()
    .in("id", assetIds)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return toListedRecords(data, viewer);
}

export async function fetchIssuedAssets(issuer: Address) {
  const { data, error } = await selectAssets()
    .eq("issuer", walletKey(issuer))
    .order("created_at", { ascending: false });
  if (error) throw error;
  return toListedRecords(data, issuer);
}

// Assets the wallet issued, was minted, or sent or received across chains.
async function fetchAssetIdsInvolving(wallet: Address) {
  const key = walletKey(wallet);
  const [issued, minted, moved] = await Promise.all([
    supabase.from("assets").select("id").eq("issuer", key),
    supabase.from("issuer_mints").select("asset_id").eq("recipient", key),
    supabase.from("transfers").select("asset_id").or(`sender.eq.${key},recipient.eq.${key}`),
  ]);
  for (const { error } of [issued, minted, moved]) if (error) throw error;
  return [
    ...new Set([
      ...(issued.data ?? []).map((row) => row.id),
      ...(minted.data ?? []).map((row) => row.asset_id),
      ...(moved.data ?? []).map((row) => row.asset_id),
    ]),
  ];
}

function involves(entry: Activity, wallet: Address) {
  if (entry.kind === "issuer-mint") return isAddressEqual(entry.recipient, wallet);
  if (entry.kind === "transfer") {
    return isAddressEqual(entry.sender, wallet) || isAddressEqual(entry.recipient, wallet);
  }
  return false;
}

// The wallet's history, newest first: everything on assets it issued, and its own mints and transfers on others.
export async function fetchActivity(wallet: Address) {
  const records = await fetchAssets(await fetchAssetIdsInvolving(wallet), wallet);
  const assets = records.map((record) => record.asset);
  const activity = records.flatMap((record): Activity[] => {
    const entries: Activity[] = [...record.mints, ...record.transfers];
    if (!isAddressEqual(record.asset.issuer, wallet)) return entries.filter((entry) => involves(entry, wallet));
    return [...record.setups, ...entries];
  });
  activity.sort((first, second) => second.createdAt.getTime() - first.createdAt.getTime());
  return { assets, activity };
}

function isAlreadySaved(error: { code?: string; statusCode?: string }) {
  return error.code === POSTGRES_UNIQUE_VIOLATION || error.statusCode === STORAGE_ALREADY_EXISTS;
}

// Another transfer's row already holds this burn hash. Postgres names the constraint in the message.
type PostgresError = { code: string; message: string };

function violates(error: PostgresError, constraint: string) {
  return error.code === POSTGRES_UNIQUE_VIOLATION && error.message.includes(constraint);
}

export function isSourceHashTaken(error: PostgresError) {
  return violates(error, SOURCE_HASH_CONSTRAINT);
}

export function isDestinationHashTaken(error: PostgresError) {
  return violates(error, DESTINATION_HASH_CONSTRAINT);
}

// A hash another row already holds, as an error that says so. Anything else as it came.
export function toProgressError(error: PostgresError) {
  if (isSourceHashTaken(error)) return new BurnRecordedError(error);
  if (isDestinationHashTaken(error)) return new DeliveryRecordedError(error);
  return error;
}

export type NewAsset = {
  id: string;
  issuer: Address;
  config: AssetConfig;
  image: File;
  crossChainId: Hex;
  salt: Hex;
};

// Safe to retry with the same asset: an image or row already saved by an earlier try counts as done.
export async function saveNewAsset({ id, issuer, config, image, crossChainId, salt }: NewAsset) {
  const upload = await supabase.storage
    .from(ASSET_IMAGES_BUCKET)
    .upload(imagePath(issuer, id), image, { contentType: image.type });
  if (upload.error && !isAlreadySaved(upload.error)) throw upload.error;

  const realWorld = config.type === "real-world" ? config.realWorld : null;
  const { error } = await supabase.from("assets").insert({
    id,
    issuer: walletKey(issuer),
    type: config.type,
    name: config.name,
    symbol: config.symbol,
    description: config.description,
    decimals: config.decimals,
    cross_chain_id: crossChainId,
    salt,
    issuer_name: realWorld?.issuerName,
    category: realWorld?.category,
    underlying_description: realWorld?.underlyingDescription,
    document_url: realWorld?.documentUrl,
  });
  if (error && !isAlreadySaved(error)) throw error;
}

// Saved as pending the moment the wallet sends it. Safe to retry with the same step.
export async function saveSentSetupStep(
  assetId: string,
  chainId: ChainId,
  step: number,
  transactionHash: Hash,
) {
  const { error } = await supabase
    .from("setup_transactions")
    .insert({ asset_id: assetId, chain: chainId, step, transaction_hash: transactionHash });
  if (error && !isAlreadySaved(error)) throw error;
}

// The database only lets a pending step end, and a reverted one be sent again.
export async function saveSetupStepProgress(
  assetId: string,
  chainId: ChainId,
  step: number,
  state: SetupStepState,
  transactionHash: Hash,
  tokenAddress: Address | null,
) {
  const { data, error } = await supabase
    .from("setup_transactions")
    .update({
      state,
      transaction_hash: transactionHash,
      token_address: tokenAddress === null ? null : walletKey(tokenAddress),
    })
    .eq("asset_id", assetId)
    .eq("chain", chainId)
    .eq("step", step)
    .select("step");
  if (error) throw error;
  if (data.length === 0) {
    throw new Error(`Only the issuer can update setup step ${step} on ${chainId} of asset ${assetId}`);
  }
}

type NewIssuerMint = {
  id: string;
  assetId: string;
  recipient: Address;
  amount: bigint;
  transactionHash: Hash;
};

// Null when the mint was never sent.
export async function fetchMint(mintId: string) {
  const { data, error } = await supabase
    .from("issuer_mints")
    .select("state, transaction_hash")
    .eq("id", mintId)
    .maybeSingle();
  if (error) throw error;
  return data && { state: data.state, transactionHash: toHash(data.transaction_hash) };
}

// Saved as pending the moment the wallet sends it. Safe to retry with the same mint ID.
export async function saveSentMint(mint: NewIssuerMint) {
  const { error } = await supabase.rpc("record_issuer_mint", {
    id: mint.id,
    asset_id: mint.assetId,
    recipient: walletKey(mint.recipient),
    amount: mint.amount.toString(),
    transaction_hash: mint.transactionHash,
  });
  if (error && !isAlreadySaved(error)) throw error;
}

type NewTransfer = {
  id: string;
  assetId: string;
  sender: Address;
  recipient: Address;
  sourceChainId: ChainId;
  destinationChainId: ChainId;
  amount: bigint;
  crossChainFee: bigint;
};

// The database only lets a pending mint end, and a reverted one be sent again.
export async function saveMintProgress(mintId: string, state: MintState, transactionHash: Hash) {
  const { data, error } = await supabase
    .from("issuer_mints")
    .update({ state, transaction_hash: transactionHash })
    .eq("id", mintId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new Error(`Only the issuer can update mint ${mintId}`);
}

// Safe to retry with the same transfer ID.
export async function saveNewTransfer(transfer: NewTransfer) {
  const { error } = await supabase.rpc("start_transfer", {
    id: transfer.id,
    asset_id: transfer.assetId,
    sender: walletKey(transfer.sender),
    recipient: walletKey(transfer.recipient),
    source_chain: transfer.sourceChainId,
    destination_chain: transfer.destinationChainId,
    amount: transfer.amount.toString(),
    cross_chain_fee: transfer.crossChainFee.toString(),
  });
  if (error && !isAlreadySaved(error)) throw error;
}

export type TransferProgress = {
  state: TransferState;
  sourceTransactionHash?: Hash;
  destinationTransactionHash?: Hash;
};

// The database only lets the fee change while the transfer is in approval-required.
export async function saveTransferFee(transferId: string, crossChainFee: bigint) {
  const { error } = await supabase.rpc("save_transfer_fee", {
    id: transferId,
    cross_chain_fee: crossChainFee.toString(),
  });
  if (error) throw error;
}

// The transfer's row, or null when it isn't saved yet.
export async function fetchTransfer(transferId: string): Promise<TransferActivity | null> {
  const { data, error } = await supabase
    .from("transfers")
    .select(`asset_id, ${TRANSFER_COLUMNS}` as const)
    .eq("id", transferId)
    .maybeSingle();
  if (error) throw error;
  return data && toTransfer(data.asset_id, data);
}

// The sender's transfers of the asset, each with when it was saved and the burn it saved, if any.
export async function fetchSenderTransfers(assetId: string, sender: Address) {
  const { data, error } = await supabase
    .from("transfers")
    .select("id, created_at, source_transaction_hash")
    .eq("asset_id", assetId)
    .eq("sender", walletKey(sender));
  if (error) throw error;
  return data.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at),
    sourceTransactionHash: toOptionalHash(row.source_transaction_hash),
  }));
}

// The sender's transfers on every asset whose burn is saved and whose delivery isn't yet.
export async function fetchInFlightTransfersBy(sender: Address) {
  const { data, error } = await supabase
    .from("transfers")
    .select(`asset_id, ${TRANSFER_COLUMNS}`)
    .eq("sender", walletKey(sender))
    .in("state", [...IN_FLIGHT_STATES]);
  if (error) throw error;
  return data.map((row) => toTransfer(row.asset_id, row));
}

// The database only lets a transfer move forward, and never rewrites a recorded burn or mint.
export async function saveTransferProgress(transferId: string, progress: TransferProgress) {
  const { data, error } = await supabase
    .from("transfers")
    .update({
      state: progress.state,
      source_transaction_hash: progress.sourceTransactionHash,
      destination_transaction_hash: progress.destinationTransactionHash,
    })
    .eq("id", transferId)
    .select("id");
  if (error) throw toProgressError(error);
  if (data.length === 0) throw new Error(`Only the sender can update transfer ${transferId}`);
}
