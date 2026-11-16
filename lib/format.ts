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

import {
  BaseError,
  formatUnits,
  HttpRequestError,
  isAddress,
  isAddressEqual,
  parseUnits,
  RpcRequestError,
  zeroAddress,
  type Address,
} from "viem";

// "0x" and four hex digits at the front, four at the back.
const ADDRESS_START_LENGTH = 6;
const ADDRESS_END_LENGTH = 4;

// Digits, one optional point, and no more decimals than the token has.
export function toAmountPattern(decimals: number) {
  return new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`);
}

// A positive amount in base units, or null when the text isn't one.
export function parseAmount(value: string, decimals: number) {
  if (!toAmountPattern(decimals).test(value) || value === "" || value === ".") return null;
  const amount = parseUnits(value, decimals);
  return amount > BigInt(0) ? amount : null;
}

export const INVALID_RECIPIENT_MESSAGE =
  "Enter a valid wallet address. The zero address can't receive tokens.";

// A wallet that can hold tokens, or null when the text isn't one.
export function parseRecipient(value: string): Address | null {
  if (!isAddress(value) || isAddressEqual(value, zeroAddress)) return null;
  return value;
}

const WHOLE_NUMBER_FORMAT = new Intl.NumberFormat("en-US");

// Every decimal, never rounded, so what you sign is exactly what you see.
export function formatTokenAmount(amount: bigint, decimals: number) {
  const [whole, fraction] = formatUnits(amount, decimals).split(".");
  const grouped = WHOLE_NUMBER_FORMAT.format(BigInt(whole));
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function shortenHex(value: string) {
  return `${value.slice(0, ADDRESS_START_LENGTH)}…${value.slice(-ADDRESS_END_LENGTH)}`;
}

// UTC, so the server and the browser render the same text.
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatDate(date: Date) {
  return `${DATE_FORMAT.format(date)} UTC`;
}

export function formatAssetAmount(
  amount: bigint,
  asset: { decimals: number; symbol: string },
) {
  return `${formatTokenAmount(amount, asset.decimals)} ${asset.symbol}`;
}

// A fetch that got no answer, as browsers word it (Chrome, Firefox, Safari). Supabase passes it on
// as "TypeError: Failed to fetch".
const NO_ANSWER_PATTERN = /Failed to fetch|NetworkError when attempting to fetch|Load failed/;
const NO_ANSWER_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

// viem's "HTTP request failed." and "RPC Request failed." say neither which RPC nor why.
function describeRequestError(error: HttpRequestError | RpcRequestError) {
  const host = new URL(error.url).host;
  if (error instanceof RpcRequestError) return `${host} refused a request: ${error.details}`;
  return `Couldn't reach ${host}. Try again in a moment.`;
}

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message;
  // Supabase returns its errors as plain objects, not Error instances.
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

// What went wrong, in one line. Wallet errors carry a long technical tail after the short message.
export function describeError(error: unknown) {
  if (error instanceof BaseError) {
    const request = error.walk((cause) => cause instanceof HttpRequestError || cause instanceof RpcRequestError);
    // Only when the request's failure is the whole story, not a revert it carried.
    if ((request instanceof HttpRequestError || request instanceof RpcRequestError) && request.shortMessage === error.shortMessage) {
      return describeRequestError(request);
    }
    return error.shortMessage;
  }
  const message = messageOf(error);
  return NO_ANSWER_PATTERN.test(message) ? NO_ANSWER_MESSAGE : message;
}
