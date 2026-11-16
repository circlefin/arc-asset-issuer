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

import { encodePacked, hexToNumber, size, slice, toHex, type Address, type Hex } from "viem";

const SALT_BYTES = 32;
// MessageV2 starts with the version and the two domains, 4 bytes each, then the 32-byte nonce.
const SOURCE_DOMAIN_START = 4;
const SOURCE_DOMAIN_END = 8;
const DESTINATION_DOMAIN_END = 12;
const NONCE_START = 12;
const NONCE_END = 44;
// The fixed header: the above plus sender, recipient and destination caller (32 bytes each) and
// the two finality thresholds (4 bytes each). Anything shorter isn't a MessageV2.
const MESSAGE_HEADER_BYTES = 148;

// CCTP takes addresses as bytes, so it can carry non-EVM ones. On EVM that's the bare 20 bytes:
// an ABI-encoded 32-byte word decodes as the wrong address.
export function packAddress(address: Address): Hex {
  return encodePacked(["address"], [address]);
}

export function newSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

function assertHeader(message: Hex) {
  if (size(message) < MESSAGE_HEADER_BYTES) {
    throw new Error("The CCTP message is too short to be a MessageV2");
  }
}

// The nonce CCTP marks as used when the message is delivered.
export function messageNonce(message: Hex): Hex {
  assertHeader(message);
  return slice(message, NONCE_START, NONCE_END);
}

// The CCTP domain the message was burned on.
export function messageSourceDomain(message: Hex): number {
  assertHeader(message);
  return hexToNumber(slice(message, SOURCE_DOMAIN_START, SOURCE_DOMAIN_END));
}

// The CCTP domain the message is to be delivered on.
export function messageDestinationDomain(message: Hex): number {
  assertHeader(message);
  return hexToNumber(slice(message, SOURCE_DOMAIN_END, DESTINATION_DOMAIN_END));
}
