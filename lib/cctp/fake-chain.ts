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

// Shared by the *.test.ts files: fake JSON-RPC nodes behind a real wagmi config. The app's own
// clients talk to them, so tests check what goes over the wire instead of mocking viem.

import {
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  isHex,
  toHex,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { createConfig } from "wagmi";
import { vi } from "vitest";
import { ARBITRUM_SEPOLIA, ARC_TESTNET, BASE_SEPOLIA, type Chain } from "@/lib/chains";
import { crossChainTokenServiceAbi, messageTransmitterAbi, tokenManagerAbi } from "./abis";
import { communityTokenAbi } from "./artifacts";

// Every contract function the app calls. Their selectors don't clash, so one ABI decodes them all.
const CONTRACTS_ABI = [...communityTokenAbi, ...crossChainTokenServiceAbi, ...tokenManagerAbi, ...messageTransmitterAbi];
// Widened, so the node can answer any of those functions by name.
const ANY_CONTRACT_ABI: Abi = CONTRACTS_ABI;

const EMPTY_HASH: Hash = `0x${"00".repeat(32)}`;
const EMPTY_BLOOM: Hex = `0x${"00".repeat(256)}`;
const SENT_NONCE = 7;

// The block is a number when the call pins one, otherwise a tag such as "latest".
export type ContractCall = {
  to: Address;
  from: Address | undefined;
  functionName: string;
  args: readonly unknown[];
  block: bigint | string;
};

export type SentTransaction = { from: Address; to: Address | undefined; data: Hex; value: bigint };

export type LogFilter = { address: Address; topics: (Hex | null)[]; fromBlock: bigint; toBlock: bigint };

// The transaction that emitted a log, as eth_getTransactionByHash returns it once the log is served.
export type LoggedTransaction = { from: Address; to: Address; data: Hex };

// `address` and `removed` default to the queried contract and false; set them to model an RPC that
// ignores the filter or reports a reorged log.
export type FakeLog = {
  transactionHash: Hash;
  topics: Hex[];
  data: Hex;
  transaction?: LoggedTransaction;
  address?: Address;
  removed?: boolean;
};

// What landed at the same nonce in place of a sent transaction, as when the wallet speeds one
// up or cancels it. The sent one then never lands.
export type Replacement = { hash: Hash; to: Address | null; data: Hex; value: bigint };

type FakeReceipt = {
  status: "success" | "reverted";
  contractAddress: Address | null;
  blockNumber: bigint;
  // Fails the receipt and transaction lookups, as a dropped connection would.
  error: Error | null;
  // Fails only the receipt lookup, with the sent transaction found still waiting, so viem's wait
  // gets past its transaction lookup and meets the error.
  errorWhilePending: Error | null;
};

class Revert extends Error {
  constructor(readonly data: Hex) {
    super("execution reverted");
  }
}

// Thrown from a read handler, the call reverts with this custom error, as a contract would.
export function revertWith(abi: Abi, errorName: string, args: readonly unknown[]) {
  return new Revert(encodeErrorResult({ abi, errorName, args }));
}

function asHex(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value)) throw new Error(`Expected hex, got ${String(value)}`);
  return value;
}

function asAddress(value: unknown): Address {
  return asHex(value);
}

function paramsOf(params: unknown): unknown[] {
  if (!Array.isArray(params)) throw new Error("Expected JSON-RPC params to be a list");
  return params;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function fakeNode(chain: Chain) {
  const sent: SentTransaction[] = [];
  // The transactions behind every log served, so the node knows them as a real one would.
  const logged = new Map<Hash, LoggedTransaction>();
  const receiptState: FakeReceipt = {
    status: "success",
    contractAddress: null,
    blockNumber: BigInt(100),
    error: null,
    errorWhilePending: null,
  };
  const node = {
    chain,
    // Answers eth_call: return the function's result, or throw revertWith(...).
    read: vi.fn<(call: ContractCall) => unknown>((call) => {
      throw new Error(`Unexpected read ${call.functionName}`);
    }),
    sent,
    nextHash: vi.fn<() => Hash>(() => `0x${"e2".repeat(32)}`),
    receipt: receiptState,
    blockNumber: BigInt(150),
    logs: vi.fn<(filter: LogFilter) => FakeLog[]>(() => []),
    // Null when the last sent transaction lands as sent.
    replace: vi.fn<(sent: SentTransaction) => Replacement | null>(() => null),
    // False for a hash the node never saw, as when the wallet dropped it, or replaced it before a reload.
    knows: vi.fn<(hash: Hash) => boolean>(() => true),
    gas: BigInt(21_000),
    // Estimates a transaction to this address, as eth_estimateGas and a wallet about to sign do:
    // returns, or throws revertWith(...) as a node behind the last block may. Nothing is sent then.
    estimate: vi.fn<(to: Address | undefined) => void>(() => undefined),
    // The account's native balance, for every account.
    nativeBalance: BigInt(0),
    // The account's next nonce, counting only landed transactions, and counting pending ones too.
    nonces: { latest: SENT_NONCE, pending: SENT_NONCE },
    // A block's timestamp, in seconds.
    timestampOf: vi.fn<(block: bigint) => bigint>(() => BigInt(0)),
    // No base fee, so a transaction's max fee per gas is just this tip.
    tip: BigInt(1),
    request,
  };

  function contractCall(transaction: unknown, block: unknown): ContractCall {
    const { functionName, args } = decodeFunctionData({ abi: ANY_CONTRACT_ABI, data: asHex(field(transaction, "data")) });
    const from = field(transaction, "from");
    if (typeof block !== "string") throw new Error(`Expected a block number or tag, got ${String(block)}`);
    return {
      to: asAddress(field(transaction, "to")),
      from: from === undefined ? undefined : asAddress(from),
      functionName,
      args: args ?? [],
      block: isHex(block) ? BigInt(block) : block,
    };
  }

  function call(transaction: unknown, block: unknown) {
    const decoded = contractCall(transaction, block);
    const result = node.read(decoded);
    return encodeFunctionResult({ abi: ANY_CONTRACT_ABI, functionName: decoded.functionName, result });
  }

  function receipt(hash: Hash) {
    if (node.receipt.error) throw node.receipt.error;
    return {
      transactionHash: hash,
      blockHash: EMPTY_HASH,
      blockNumber: toHex(node.receipt.blockNumber),
      contractAddress: node.receipt.contractAddress,
      cumulativeGasUsed: toHex(node.gas),
      effectiveGasPrice: toHex(node.tip),
      from: node.sent.at(-1)?.from ?? null,
      gasUsed: toHex(node.gas),
      logs: [],
      logsBloom: EMPTY_BLOOM,
      status: node.receipt.status === "success" ? "0x1" : "0x0",
      to: null,
      transactionIndex: "0x0",
      type: "0x2",
    };
  }

  function replacement() {
    const sent = node.sent.at(-1);
    return sent ? node.replace(sent) : null;
  }

  // A transaction as eth_getTransactionByHash and eth_getBlockByNumber return it.
  function rpcTransaction(hash: Hash, from: Address, to: Address | null, data: Hex, value: bigint) {
    return {
      hash,
      from,
      to,
      input: data,
      value: toHex(value),
      nonce: toHex(SENT_NONCE),
      gas: toHex(node.gas),
      maxFeePerGas: toHex(node.tip),
      maxPriorityFeePerGas: toHex(node.tip),
      type: "0x2",
      chainId: toHex(chain.network.id),
      accessList: [],
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      v: "0x0",
      r: EMPTY_HASH,
      s: EMPTY_HASH,
    };
  }

  // The sent transaction, still waiting, if it was replaced or its receipt fails. Otherwise nothing is looked up.
  function getTransaction(hash: Hash) {
    const sent = node.sent.at(-1);
    if (!sent || !(replacement() || node.receipt.errorWhilePending)) throw new Error("Unexpected transaction lookup");
    return rpcTransaction(hash, sent.from, sent.to ?? null, sent.data, sent.value);
  }

  // The latest block unless a number is asked for.
  function getBlock(blockTag: unknown, withTransactions: unknown) {
    const sent = node.sent.at(-1);
    const replaced = replacement();
    const transactions = withTransactions === true && sent && replaced
      ? [rpcTransaction(replaced.hash, sent.from, replaced.to, replaced.data, replaced.value)]
      : [];
    const number = typeof blockTag === "string" && isHex(blockTag) ? BigInt(blockTag) : node.blockNumber;
    return {
      number: toHex(number),
      hash: EMPTY_HASH,
      baseFeePerGas: "0x0",
      timestamp: toHex(node.timestampOf(number)),
      transactions,
    };
  }

  function getLogs(filter: unknown) {
    const topics = field(filter, "topics");
    const logs = node.logs({
      address: asAddress(field(filter, "address")),
      topics: Array.isArray(topics) ? topics.map((topic) => (topic === null ? null : asHex(topic))) : [],
      fromBlock: BigInt(asHex(field(filter, "fromBlock"))),
      toBlock: BigInt(asHex(field(filter, "toBlock"))),
    });
    return logs.map(({ transaction, ...log }, index) => {
      if (transaction) logged.set(log.transactionHash, transaction);
      return {
        ...log,
        address: log.address ?? field(filter, "address"),
        blockHash: EMPTY_HASH,
        blockNumber: toHex(node.receipt.blockNumber),
        logIndex: toHex(index),
        transactionIndex: "0x0",
        removed: log.removed ?? false,
      };
    });
  }

  // A revert shaped like a node's, so viem decodes the custom error.
  function asNodeRevert(answer: () => unknown) {
    try {
      return answer();
    } catch (error) {
      if (error instanceof Revert) throw Object.assign(new Error(error.message), { code: 3, data: error.data });
      throw error;
    }
  }

  async function request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    if (method === "eth_chainId") return toHex(chain.network.id);
    if (method === "eth_blockNumber") return toHex(node.blockNumber);
    if (method === "eth_call") return asNodeRevert(() => call(paramsOf(params)[0], paramsOf(params)[1]));
    if (method === "eth_estimateGas") {
      return asNodeRevert(() => {
        const to = field(paramsOf(params)[0], "to");
        node.estimate(typeof to === "string" ? asAddress(to) : undefined);
        return toHex(node.gas);
      });
    }
    if (method === "eth_maxPriorityFeePerGas") return toHex(node.tip);
    if (method === "eth_getBlockByNumber") return getBlock(paramsOf(params)[0], paramsOf(params)[1]);
    if (method === "eth_getBalance") return toHex(node.nativeBalance);
    if (method === "eth_getTransactionCount") {
      return toHex(paramsOf(params)[1] === "pending" ? node.nonces.pending : node.nonces.latest);
    }
    if (method === "eth_sendTransaction") {
      const transaction = paramsOf(params)[0];
      const to = field(transaction, "to");
      asNodeRevert(() => node.estimate(typeof to === "string" ? asAddress(to) : undefined));
      const value = field(transaction, "value");
      node.sent.push({
        from: asAddress(field(transaction, "from")),
        to: to === undefined || to === null ? undefined : asAddress(to),
        data: asHex(field(transaction, "data")),
        value: value === undefined ? BigInt(0) : BigInt(asHex(value)),
      });
      return node.nextHash();
    }
    if (method === "eth_getTransactionReceipt") {
      const hash = asHex(paramsOf(params)[0]);
      if (node.receipt.error) throw node.receipt.error;
      if (node.receipt.errorWhilePending) throw node.receipt.errorWhilePending;
      if (!node.knows(hash)) return null;
      const replaced = replacement();
      // The replaced transaction never lands, so it has no receipt.
      if (replaced && replaced.hash !== hash) return null;
      return receipt(hash);
    }
    if (method === "eth_getTransactionByHash" && node.receipt.error) throw node.receipt.error;
    if (method === "eth_getTransactionByHash") {
      const hash = asHex(paramsOf(params)[0]);
      if (!node.knows(hash)) return null;
      const landed = logged.get(hash);
      return landed ? rpcTransaction(hash, landed.from, landed.to, landed.data, BigInt(0)) : getTransaction(hash);
    }
    if (method === "eth_getLogs") return getLogs(paramsOf(params)[0]);
    throw new Error(`Unexpected RPC method ${method}`);
  }

  return node;
}

export type FakeNode = ReturnType<typeof fakeNode>;

// No retries, so a failure the test sets up fails at once.
const transportOptions = { retryCount: 0 };

// The app's chains, each answered by its own fake node. Multicall is off, so each read is its own
// eth_call that a test can answer directly.
export function fakeChains() {
  const arc = fakeNode(ARC_TESTNET);
  const base = fakeNode(BASE_SEPOLIA);
  const arbitrum = fakeNode(ARBITRUM_SEPOLIA);
  const wagmiConfig = createConfig({
    chains: [ARC_TESTNET.network, BASE_SEPOLIA.network, ARBITRUM_SEPOLIA.network],
    transports: {
      [ARC_TESTNET.network.id]: custom(arc, transportOptions),
      [BASE_SEPOLIA.network.id]: custom(base, transportOptions),
      [ARBITRUM_SEPOLIA.network.id]: custom(arbitrum, transportOptions),
    },
    batch: { multicall: false },
  });
  return { arc, base, arbitrum, wagmiConfig };
}

// A wallet on the node's chain, signing as the given account.
export function walletOn(node: FakeNode, account: Address) {
  return createWalletClient({ account, chain: node.chain.network, transport: custom(node, transportOptions) });
}

// The function and arguments of a transaction the wallet sent.
export function decodeSent(transaction: SentTransaction) {
  return decodeFunctionData({ abi: CONTRACTS_ABI, data: transaction.data });
}
