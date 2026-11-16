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

// The parts of Circle's CCTP contracts this app calls. Checked against Arc Testnet on 2026-10-21.

export const crossChainTokenServiceAbi = [
  {
    type: "function",
    name: "customTokenDeploySalt",
    stateMutability: "pure",
    inputs: [
      { name: "deployer", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "deploySalt", type: "bytes32" }],
  },
  {
    type: "function",
    name: "crossChainTokenId",
    stateMutability: "pure",
    inputs: [
      { name: "deployer", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "tokenId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "resolveTokenManager",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }],
    outputs: [{ name: "tokenManager", type: "address" }],
  },
  {
    type: "function",
    name: "resolveTokenAddress",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }],
    outputs: [{ name: "token", type: "address" }],
  },
  // The live tuple has no initialSupply, unlike Circle's docs. Encoding one makes the call revert.
  {
    type: "function",
    name: "registerCustomToken",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "tokenAddress", type: "address" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenManagerType", type: "uint8" },
          { name: "tokenManagerOwner", type: "bytes" },
          { name: "tokenManagerOperator", type: "bytes" },
          { name: "tokenOwner", type: "bytes" },
          { name: "tokenMinter", type: "bytes" },
          {
            name: "tokenManagerSettings",
            type: "tuple",
            components: [
              { name: "rateLimit", type: "uint256" },
              { name: "maxTransferAmount", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "tokenId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "isTrustedDomain",
    stateMutability: "view",
    inputs: [{ name: "domain", type: "uint32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  // Burns on this chain and sends a CCTP message to mint on the destination. Checked against the
  // Testnet burns on Arc and Sepolia. Its return value isn't used, so it isn't declared.
  {
    type: "function",
    name: "crossChainTransfer",
    stateMutability: "payable",
    inputs: [
      { name: "tokenId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "destinationAddress", type: "bytes" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "minFinalityThreshold", type: "uint32" },
      {
        name: "claim",
        type: "tuple",
        components: [
          { name: "signedQuote", type: "bytes" },
          { name: "refundAddress", type: "address" },
        ],
      },
      { name: "autoExecuteHookData", type: "bool" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "error",
    name: "TokenNotRegistered",
    inputs: [{ name: "tokenId", type: "bytes32" }],
  },
  // The token's (OpenZeppelin ERC20), passed up through crossChainTransfer when the TokenManager
  // can't pull the amount. Declared here so viem names it instead of showing 0xfb8f41b2.
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
] as const;

// Emitted by the service when registerCustomToken runs, with the token ID as the first indexed topic.
// Circle hasn't published its name, so it's matched by topic.
export const CUSTOM_TOKEN_REGISTERED_TOPIC =
  "0xf6d20b0d669ca25f63eea76efedd4771e2b789f88ef94de6b1a71fc2621db640";

// Emitted by the service on every crossChainTransfer burn. Topics: token ID, sender, destination
// domain, each padded to 32 bytes. The second data word is the amount. Matched by topic, like above.
export const CROSS_CHAIN_TRANSFER_TOPIC =
  "0x9003c1284d3c991786f6aacd68abf9063ca9e8efb694a4a96ed8ee984b591531";

export const tokenManagerAbi = [
  {
    type: "function",
    name: "rateLimit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxTransferAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setRateLimit",
    stateMutability: "nonpayable",
    inputs: [{ name: "rateLimit", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "RateLimitSet",
    inputs: [{ name: "rateLimit", type: "uint256", indexed: false }],
  },
] as const;

// MessageTransmitterV2's MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed
// nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody), emitted when a
// message is delivered. The nonce is the second topic, as seen on Arc and Ethereum Sepolia.
export const MESSAGE_RECEIVED_TOPIC =
  "0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c";

// CCTP's MessageTransmitterV2: delivers an attested message, and remembers each nonce it used.
export const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
