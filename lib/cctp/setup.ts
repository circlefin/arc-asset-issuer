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

// Sets a token up as a custom BURN_MINT CCTP token, one signed transaction per step in
// setupStepsOn(chain). A step is held in the browser the moment it's sent, then saved as pending, and
// a step that landed with no record is found onchain, so no step is sent twice.

import {
  encodeDeployData,
  getAbiItem,
  isAddressEqual,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import type { Config } from "wagmi";
import {
  findDeployment,
  isChainEnabled,
  setupOn,
  setupStepsOn,
  type AssetConfig,
  type SavedAsset,
  type SetupStep,
  type SetupStepState,
} from "@/lib/assets";
import { ARC_TESTNET, type Chain, type ChainId } from "@/lib/chains";
import { crossChainTokenServiceAbi, CUSTOM_TOKEN_REGISTERED_TOPIC, tokenManagerAbi } from "./abis";
import {
  communityTokenAbi,
  communityTokenBytecode,
  rwaTokenAbi,
  rwaTokenBytecode,
} from "./artifacts";
import {
  BURN_MINT,
  CROSS_CHAIN_TOKEN_SERVICE,
  DEFAULT_RATE_LIMIT_WHOLE_TOKENS,
  NO_TRANSFER_CAP,
} from "./config";
import { findInWindows } from "./blocks";
import { measuredGas } from "./gas";
import { packAddress } from "./encoding";
import { findTokenManager, readBridge, readRateLimit, readRegisteredToken } from "./service";
import { publicFor, ReplacedError, waitForSent, walletFor } from "./wallet";

export type SetupRecords = {
  fetchAsset: (assetId: string) => Promise<SavedAsset | null>;
  saveSent: (assetId: string, chainId: ChainId, step: number, transactionHash: Hash) => Promise<void>;
  saveProgress: (
    assetId: string,
    chainId: ChainId,
    step: number,
    state: SetupStepState,
    transactionHash: Hash,
    tokenAddress: Address | null,
  ) => Promise<void>;
  // Hold a sent step until it's saved, in storage that outlives a reload.
  findUnsaved: (assetId: string, chainId: ChainId, step: number) => Hash | null;
  rememberUnsaved: (assetId: string, chainId: ChainId, step: number, transactionHash: Hash) => void;
  forgetUnsaved: (assetId: string, chainId: ChainId, step: number) => void;
};

// The CCTP token ID. The same issuer and salt give the same ID on every chain.
export async function computeCrossChainId(client: PublicClient, issuer: Address, salt: Hex) {
  const deploySalt = await client.readContract({
    address: CROSS_CHAIN_TOKEN_SERVICE,
    abi: crossChainTokenServiceAbi,
    functionName: "customTokenDeploySalt",
    args: [issuer, salt],
  });
  return client.readContract({
    address: CROSS_CHAIN_TOKEN_SERVICE,
    abi: crossChainTokenServiceAbi,
    functionName: "crossChainTokenId",
    args: [issuer, deploySalt],
  });
}

// The deploy transaction's data. Every chain's token names Arc as home, so new supply is
// only ever issued there.
export function deployData(config: AssetConfig, issuer: Address): Hex {
  const details = [config.name, config.symbol, config.decimals, issuer, BigInt(ARC_TESTNET.network.id)] as const;
  if (config.type === "community") {
    return encodeDeployData({ abi: communityTokenAbi, bytecode: communityTokenBytecode, args: details });
  }
  const { issuerName, category, underlyingDescription, documentUrl } = config.realWorld;
  const info = { issuerName, category, underlyingDescription, documentUrl: documentUrl ?? "" };
  return encodeDeployData({ abi: rwaTokenAbi, bytecode: rwaTokenBytecode, args: [...details, info] });
}

export function tokenOn(asset: SavedAsset, chain: Chain) {
  const deployment = findDeployment(asset, chain.id);
  if (!deployment) throw new Error(`${asset.symbol} isn't deployed on ${chain.name} yet`);
  return deployment.tokenAddress;
}

// Checks the cross-chain ID is registered to this token, so CCTP never gets rights for another one.
export async function tokenManagerOn(client: PublicClient, asset: SavedAsset, chain: Chain) {
  const tokenManager = await findTokenManager(client, asset.crossChainId);
  if (!tokenManager) throw new Error(`${asset.symbol} isn't registered with CCTP on ${chain.name} yet`);
  const registered = await readRegisteredToken(client, asset.crossChainId);
  if (!isAddressEqual(registered, tokenOn(asset, chain))) {
    throw new Error(`${asset.symbol}'s cross-chain ID is registered to another token on ${chain.name}: ${registered}`);
  }
  return tokenManager;
}

// Tokens only move through Arc, and only Arc issues new supply, so every other network waits
// for Arc to be set up.
function checkCanSetUp(asset: SavedAsset, chain: Chain) {
  if (chain.id !== ARC_TESTNET.id && !isChainEnabled(asset, ARC_TESTNET.id)) {
    throw new Error(`Finish setting ${asset.symbol} up on ${ARC_TESTNET.name} before enabling ${chain.name}`);
  }
}

// Signs and sends one step, and returns its hash without waiting for it to land.
export async function sendSetupStep(
  asset: SavedAsset,
  chain: Chain,
  stepIndex: number,
  wagmiConfig: Config,
): Promise<Hash> {
  checkCanSetUp(asset, chain);
  const step = setupStepsOn(chain)[stepIndex];
  const client = publicFor(wagmiConfig, step.chain);
  const wallet = await walletFor(wagmiConfig, step.chain);
  // The cross-chain ID comes from the issuer's address, and the token's roles go to the issuer.
  // Another account would pay for steps that register a different token, or none.
  if (!isAddressEqual(wallet.account.address, asset.issuer)) {
    throw new Error(`Switch your wallet to the issuer account ${asset.issuer} to continue setup`);
  }

  if (step.kind === "deploy") return wallet.sendTransaction({ data: deployData(asset, asset.issuer) });

  const token = tokenOn(asset, step.chain);
  if (step.kind === "register") {
    const issuer = packAddress(asset.issuer);
    const { request } = await client.simulateContract({
      account: wallet.account,
      address: CROSS_CHAIN_TOKEN_SERVICE,
      abi: crossChainTokenServiceAbi,
      functionName: "registerCustomToken",
      args: [
        asset.salt,
        token,
        {
          tokenManagerType: BURN_MINT,
          tokenManagerOwner: issuer,
          tokenManagerOperator: issuer,
          // Empty for an existing token: the token's own roles decide who mints.
          tokenOwner: "0x",
          tokenMinter: "0x",
          // The rate limit is its own step, so a failed launch shows where it stopped.
          tokenManagerSettings: { rateLimit: BigInt(0), maxTransferAmount: NO_TRANSFER_CAP },
        },
      ],
    });
    return wallet.writeContract(request);
  }
  if (step.kind === "grant-bridge") {
    const tokenManager = await tokenManagerOn(client, asset, step.chain);
    const { request } = await client.simulateContract({
      account: wallet.account,
      address: token,
      abi: communityTokenAbi,
      functionName: "setBridge",
      args: [tokenManager],
    });
    return wallet.writeContract(request);
  }
  const tokenManager = await tokenManagerOn(client, asset, step.chain);
  const { request } = await client.simulateContract({
    account: wallet.account,
    address: tokenManager,
    abi: tokenManagerAbi,
    functionName: "setRateLimit",
    args: [DEFAULT_RATE_LIMIT_WHOLE_TOKENS * BigInt(10) ** BigInt(asset.decimals)],
  });
  return wallet.writeContract(request);
}

// Whether a step after the deploy already happened onchain, saved or not.
async function isStepDone(asset: SavedAsset, step: SetupStep, client: PublicClient) {
  if (step.kind === "register") return (await findTokenManager(client, asset.crossChainId)) !== null;
  const tokenManager = await findTokenManager(client, asset.crossChainId);
  if (!tokenManager) return false;
  if (step.kind === "grant-bridge") {
    return isAddressEqual(await readBridge(client, tokenOn(asset, step.chain)), tokenManager);
  }
  return (await readRateLimit(client, tokenManager)) > BigInt(0);
}

// The block the chain's token was deployed in. Every later step happened after it.
async function deployBlock(asset: SavedAsset, chain: Chain, client: PublicClient) {
  const deployIndex = setupStepsOn(chain).findIndex((step) => step.kind === "deploy");
  const deployHash = setupOn(asset, chain.id).transactions[deployIndex];
  if (!deployHash) throw new Error(`${asset.symbol} isn't deployed on ${chain.name} yet`);
  return (await client.getTransactionReceipt({ hash: deployHash })).blockNumber;
}

// The transaction of a step that landed onchain but was never saved, found from its event.
async function findStepTransaction(asset: SavedAsset, step: SetupStep, client: PublicClient): Promise<Hash | null> {
  const fromBlock = await deployBlock(asset, step.chain, client);
  if (step.kind === "register") {
    return findInWindows(client, step.chain, fromBlock, async (from, to) => {
      const logs = await client.request({
        method: "eth_getLogs",
        params: [{
          address: CROSS_CHAIN_TOKEN_SERVICE,
          topics: [CUSTOM_TOKEN_REGISTERED_TOPIC, asset.crossChainId],
          fromBlock: toHex(from),
          toBlock: toHex(to),
        }],
      });
      return logs.map((log) => log.transactionHash);
    });
  }
  const tokenManager = await tokenManagerOn(client, asset, step.chain);
  if (step.kind === "grant-bridge") {
    const token = tokenOn(asset, step.chain);
    return findInWindows(client, step.chain, fromBlock, async (from, to) => {
      const logs = await client.getLogs({
        address: token,
        event: getAbiItem({ abi: communityTokenAbi, name: "BridgeSet" }),
        args: { bridge: tokenManager },
        fromBlock: from,
        toBlock: to,
      });
      return logs.map((log) => log.transactionHash);
    });
  }
  return findInWindows(client, step.chain, fromBlock, async (from, to) => {
    const logs = await client.getLogs({
      address: tokenManager,
      event: getAbiItem({ abi: tokenManagerAbi, name: "RateLimitSet" }),
      fromBlock: from,
      toBlock: to,
    });
    // Registering logs a zero rate limit first. The step is the one that set a real one.
    return logs.filter((log) => (log.args.rateLimit ?? BigInt(0)) > BigInt(0)).map((log) => log.transactionHash);
  });
}

// Waits for a sent step to land, and saves how it ended. A step that didn't happen is saved as
// reverted, so it can be sent again.
async function finishSetupStep(
  asset: SavedAsset,
  chain: Chain,
  stepIndex: number,
  transactionHash: Hash,
  client: PublicClient,
  records: SetupRecords,
) {
  const step = setupStepsOn(chain)[stepIndex];
  let receipt;
  try {
    receipt = await waitForSent(client, transactionHash);
  } catch (error) {
    if (!(error instanceof ReplacedError)) throw error;
    await records.saveProgress(asset.id, step.chain.id, stepIndex, "reverted", transactionHash, null);
    throw new Error(`${error.message} You can try ${step.label} again.`, { cause: error });
  }
  if (receipt.status !== "success") {
    await records.saveProgress(asset.id, step.chain.id, stepIndex, "reverted", receipt.transactionHash, null);
    throw new Error(`${step.label} on ${step.chain.name} reverted, so you can try again.`);
  }
  let tokenAddress: Address | null = null;
  if (step.kind === "deploy") {
    if (!receipt.contractAddress) throw new Error(`${step.label} on ${step.chain.name} created no contract`);
    tokenAddress = receipt.contractAddress;
  }
  await records.saveProgress(asset.id, step.chain.id, stepIndex, "confirmed", receipt.transactionHash, tokenAddress);
}

// The transaction of a step that landed onchain but was never saved, even locally. Null when
// it didn't land.
async function findLandedStep(asset: SavedAsset, step: SetupStep, client: PublicClient) {
  // A deploy that landed with no record anywhere can't be told apart from no deploy, so it
  // runs again. That leaves an unused contract, but never a broken token.
  if (step.kind === "deploy" || !(await isStepDone(asset, step, client))) return null;
  const hash = await findStepTransaction(asset, step, client);
  if (!hash) {
    throw new Error(
      `${step.label} on ${step.chain.name} is done onchain, but we couldn't find its transaction to save. Try again in a minute.`,
    );
  }
  return hash;
}

// A step sent before a reload cut off its save. Not the reverted one already saved, which a
// reload can leave behind after its save.
function unsavedStepOf(asset: SavedAsset, chain: Chain, stepIndex: number, records: SetupRecords) {
  const unsaved = records.findUnsaved(asset.id, chain.id, stepIndex);
  return unsaved === setupOn(asset, chain.id).sent?.transactionHash ? null : unsaved;
}

// Sends the next step, or finds it if it was sent unsaved, and saves it as sent. The step is
// held until it's saved, so a reload before the save can't send it again.
async function startSetupStep(
  asset: SavedAsset,
  chain: Chain,
  stepIndex: number,
  wagmiConfig: Config,
  records: SetupRecords,
) {
  const step = setupStepsOn(chain)[stepIndex];
  const client = publicFor(wagmiConfig, chain);
  const transactionHash =
    unsavedStepOf(asset, chain, stepIndex, records) ??
    (await findLandedStep(asset, step, client)) ??
    (await sendSetupStep(asset, chain, stepIndex, wagmiConfig));
  records.rememberUnsaved(asset.id, chain.id, stepIndex, transactionHash);
  // A reverted step did nothing, so it's sent again under a new transaction.
  if (setupOn(asset, chain.id).sent) {
    await records.saveProgress(asset.id, chain.id, stepIndex, "pending", transactionHash, null);
  } else {
    await records.saveSent(asset.id, chain.id, stepIndex, transactionHash);
  }
  records.forgetUnsaved(asset.id, chain.id, stepIndex);
  return transactionHash;
}

// Runs the chain's remaining setup steps in order. Each is saved the moment it's sent, so a
// refresh waits for that transaction instead of sending the step again. Safe to call again after
// any interruption.
export async function continueSetup(assetId: string, chain: Chain, wagmiConfig: Config, records: SetupRecords) {
  const steps = setupStepsOn(chain);
  for (;;) {
    const asset = await records.fetchAsset(assetId);
    if (!asset) throw new Error(`Asset ${assetId} wasn't found`);
    checkCanSetUp(asset, chain);
    const { transactions, sent } = setupOn(asset, chain.id);
    const stepIndex = transactions.length;
    if (stepIndex >= steps.length) return;

    const client = publicFor(wagmiConfig, chain);
    const transactionHash =
      sent?.state === "pending"
        ? sent.transactionHash
        : await startSetupStep(asset, chain, stepIndex, wagmiConfig, records);
    await finishSetupStep(asset, chain, stepIndex, transactionHash, client, records);
  }
}

// What setting the token up on the chain costs, in that chain's gas token, at today's max fee.
export async function estimateSetupCost(
  issuer: Address,
  config: AssetConfig,
  chain: Chain,
  wagmiConfig: Config,
): Promise<bigint> {
  const client = publicFor(wagmiConfig, chain);
  const [deployGas, fees] = await Promise.all([
    client.estimateGas({ account: issuer, data: deployData(config, issuer) }),
    client.estimateFeesPerGas(),
  ]);
  const stepGas = measuredGas(chain);
  return (deployGas + stepGas.register + stepGas.grantBridge + stepGas.rateLimit) * fees.maxFeePerGas;
}
