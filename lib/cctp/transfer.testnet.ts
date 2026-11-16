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

// Moves real tokens from Arc Testnet to each destination in TESTNET_DESTINATIONS and back, through
// the same code the app runs. Spends USDC on Arc and the destination's gas token there. A transfer
// from Ethereum Sepolia waits for its finality, about 15 to 20 minutes.

import { decodeAbiParameters, isAddressEqual, type Address, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { balanceOn, setupOn, type AssetConfig, type SavedAsset } from "@/lib/assets";
import { ARC_TESTNET, type Chain } from "@/lib/chains";
import { CROSS_CHAIN_TRANSFER_TOPIC, MESSAGE_RECEIVED_TOPIC } from "./abis";
import { communityTokenAbi } from "./artifacts";
import { CROSS_CHAIN_TOKEN_SERVICE, MESSAGE_TRANSMITTER } from "./config";
import { packAddress } from "./encoding";
import { readHoldings, reconcileSupply } from "./holdings";
import { createIris } from "./iris";
import { mintOnce, sendIssuerMint } from "./mint";
import { advanceTransfer, sendTransfer, TransferSentError, type TransferOrder } from "./transfer";
import {
  account,
  explorerLink,
  launchOn,
  memoryMintRecords,
  memoryTransfers,
  publicClient,
  testnetDestinations,
  wagmiConfig,
} from "./testnet-support";
import { publicFor } from "./wallet";

vi.mock("./wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wallet")>()),
  walletFor: vi.fn(),
}));

const DECIMALS = 6;
const WHOLE_TOKEN = BigInt(10) ** BigInt(DECIMALS);
const tokens = (whole: number) => BigInt(whole) * WHOLE_TOKEN;
// Launch, enable, a mint, two transfers and Ethereum Sepolia's finality on the way back.
const ROUND_TRIP_TIMEOUT_MS = 75 * 60 * 1000;
const RESUME_TIMEOUT_MS = 30 * 60 * 1000;

const iris = createIris();

function log(line: string) {
  console.log(`[testnet] ${line}`);
}

// Launches a community token on Arc, enables the destination, and mints to the dev wallet.
async function launchAndMint(config: AssetConfig, destination: Chain, minted: bigint) {
  const asset = (await launchOn(config, [destination])).current();
  for (const chain of [ARC_TESTNET, destination]) {
    for (const hash of setupOn(asset, chain.id).transactions) log(`setup ${explorerLink(chain, hash)}`);
  }
  const mintRecords = memoryMintRecords();
  const send = () => sendIssuerMint(asset, account.address, minted, wagmiConfig);
  const mintHash = await mintOnce({ read: () => null, write: () => {}, clear: () => {} }, send, mintRecords, wagmiConfig);
  log(`mint ${explorerLink(ARC_TESTNET, mintHash)}`);
  return asset;
}

function orderFor(asset: SavedAsset, source: Chain, destination: Chain, amount: bigint, recipient: Address): TransferOrder {
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    sender: account.address,
    recipient,
    amount,
    sourceChainId: source.id,
    destinationChainId: destination.id,
  };
}

// Tracks a sent transfer to its mint, then checks the mint against what Iris and the destination say.
async function deliver(
  transfers: ReturnType<typeof memoryTransfers>,
  order: TransferOrder,
  asset: SavedAsset,
  source: Chain,
  destination: Chain,
) {
  const state = await advanceTransfer(transfers.row(order.id), asset, wagmiConfig, iris, transfers.deliveryFor(order.id));
  expect(state).toBe("complete");
  const { sourceTransactionHash, destinationTransactionHash } = transfers.row(order.id);
  if (!sourceTransactionHash || !destinationTransactionHash) throw new Error("A complete transfer is missing a hash");
  log(`delivery ${explorerLink(destination, destinationTransactionHash)}`);

  const message = await iris.findMessage({ source, destination }, sourceTransactionHash);
  if (message.state !== "attested") throw new Error("Iris no longer has the delivered message");
  log(`iris forwarded=${message.forwarded} forwardState=${message.forwardState} forwardHash=${message.forwardHash}`);

  // MessageTransmitterV2's MessageReceived carries the message's nonce as its second topic.
  const receipt = await publicFor(wagmiConfig, destination).getTransactionReceipt({ hash: destinationTransactionHash });
  const received = receipt.logs.filter(
    (entry) => isAddressEqual(entry.address, MESSAGE_TRANSMITTER) && entry.topics[0] === MESSAGE_RECEIVED_TOPIC,
  );
  log(`MessageReceived from=${receipt.from} topics=${JSON.stringify(received.map((entry) => entry.topics))}`);
  expect(received).toHaveLength(1);
  expect(received[0].topics[2]).toBe(message.nonce);
}

// The address the burn's service event carries, decoded from its bytes field.
async function burnEventAddress(source: Chain, burn: Hash) {
  const receipt = await publicFor(wagmiConfig, source).getTransactionReceipt({ hash: burn });
  const event = receipt.logs.find(
    (entry) => isAddressEqual(entry.address, CROSS_CHAIN_TOKEN_SERVICE) && entry.topics[0] === CROSS_CHAIN_TRANSFER_TOPIC,
  );
  if (!event) throw new Error(`The burn ${burn} has no transfer event`);
  const [destinationAddress, amount, firstUnknown, secondUnknown] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    event.data,
  );
  log(`burn event bytes=${destinationAddress} amount=${amount} unknown words=${firstUnknown},${secondUnknown}`);
  return destinationAddress;
}

describe.each(testnetDestinations())("between Arc Testnet and $name", (destination) => {
  it("sends 250 there, 100 back, and the supply reconciles", { timeout: ROUND_TRIP_TIMEOUT_MS }, async () => {
    const asset = await launchAndMint(
      { type: "community", name: "Spike Trip", symbol: "SPKX", description: "Testnet check", decimals: DECIMALS },
      destination,
      tokens(1000),
    );
    const transfers = memoryTransfers();

    const outbound = orderFor(asset, ARC_TESTNET, destination, tokens(250), account.address);
    const outboundBurn = await sendTransfer(outbound, asset, wagmiConfig, iris, transfers.recordsFor(outbound));
    log(`burn ${explorerLink(ARC_TESTNET, outboundBurn)}`);
    await deliver(transfers, outbound, asset, ARC_TESTNET, destination);

    const inbound = orderFor(asset, destination, ARC_TESTNET, tokens(100), account.address);
    const inboundBurn = await sendTransfer(inbound, asset, wagmiConfig, iris, transfers.recordsFor(inbound));
    log(`burn ${explorerLink(destination, inboundBurn)}`);
    await deliver(transfers, inbound, asset, destination, ARC_TESTNET);

    const holdings = await readHoldings(asset.deployments, [account.address], wagmiConfig);
    const read = { ...holdings, symbol: asset.symbol };
    expect(balanceOn(read, ARC_TESTNET.id, account.address)).toBe(tokens(850));
    expect(balanceOn(read, destination.id, account.address)).toBe(tokens(150));
    expect(holdings.deployments.map((deployment) => deployment.supply)).toEqual([tokens(850), tokens(150)]);
    expect(holdings.inTransit).toBe(BigInt(0));
    const issued = await publicClient.readContract({
      address: asset.deployments[0].tokenAddress,
      abi: communityTokenAbi,
      functionName: "issuedSupply",
    });
    expect(issued).toBe(tokens(1000));
    expect(reconcileSupply({ inTransit: holdings.inTransit, inTransitKnown: transfers.inTransitKnown(asset.id) })).toEqual({
      kind: "reconciled",
    });
  });

  it("finds a burn whose save was lost and delivers it, without burning again", { timeout: RESUME_TIMEOUT_MS }, async () => {
    const asset = await launchAndMint(
      { type: "community", name: "Spike Lost", symbol: "SPKL", description: "Testnet check", decimals: DECIMALS },
      destination,
      tokens(10),
    );
    const transfers = memoryTransfers();
    // A fresh recipient, so the burn's event shows whose address it carries.
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const order = orderFor(asset, ARC_TESTNET, destination, tokens(10), recipient);

    const lostRecords = transfers.recordsFor(order, { loseBurn: true });
    await expect(sendTransfer(order, asset, wagmiConfig, iris, lostRecords)).rejects.toThrow(TransferSentError);
    const lostBurn = lostRecords.lostBurn();
    if (!lostBurn) throw new Error("The burn wasn't sent");
    log(`lost burn ${explorerLink(ARC_TESTNET, lostBurn)}`);
    expect(transfers.row(order.id)).toMatchObject({ state: "approval-required", sourceTransactionHash: null });

    // The page reloads with nothing held: the retry finds the burn onchain and sends nothing.
    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });
    const resumed = await sendTransfer(order, asset, wagmiConfig, iris, transfers.recordsFor(order));
    expect(resumed).toBe(lostBurn);
    expect(transfers.row(order.id)).toMatchObject({ state: "source-submitted", sourceTransactionHash: lostBurn });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonceBefore);

    expect((await burnEventAddress(ARC_TESTNET, lostBurn)).toLowerCase()).toBe(packAddress(recipient).toLowerCase());
    await deliver(transfers, order, asset, ARC_TESTNET, destination);
    const holdings = await readHoldings(asset.deployments, [account.address, recipient], wagmiConfig);
    const read = { ...holdings, symbol: asset.symbol };
    expect(balanceOn(read, ARC_TESTNET.id, account.address)).toBe(BigInt(0));
    expect(balanceOn(read, destination.id, recipient)).toBe(tokens(10));
    expect(holdings.inTransit).toBe(BigInt(0));
  });
});
