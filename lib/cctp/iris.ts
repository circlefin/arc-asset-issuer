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

import { isHash, isHex, zeroAddress, type Address, type Hash, type Hex } from "viem";
import type { Chain } from "../chains";
import { IRIS_URL } from "./config";
import { messageDestinationDomain, messageNonce, messageSourceDomain } from "./encoding";
import type { Route } from "./routes";

const UNREACHABLE = "Couldn't reach Circle's attestation service";
const BUSY = "Circle is busy right now. Try again in a moment.";
const NO_FEE_TOKEN = zeroAddress; // Iris takes its fee in the source chain's native token.

export type Quote = { signedQuote: Hex; feeTotal: bigint; forwarded: boolean };

export type FoundMessage =
  | { state: "pending" }
  | {
      state: "attested";
      message: Hex;
      attestation: Hex;
      nonce: Hex;
      // The transaction where Circle delivered the transfer, when it did so for us.
      forwardHash: Hash | null;
      // Circle delivers it. With no forward hash yet, it's still delivering.
      forwarded: boolean;
      // Where Circle's delivery stands, as Iris names it. Circle documents PENDING and COMPLETE;
      // SENT and CONFIRMED were seen too (see isForwardDelivered). Null when Iris gives none.
      forwardState: string | null;
    };

type QuoteInput = {
  crossChainId: Hex;
  source: Chain;
  destination: Chain;
  amount: bigint;
  recipient: Address;
};

// Iris is rate limiting or briefly overloaded: not a rejection, and worth another try.
export class IrisBusyError extends Error {
  constructor(cause: unknown) {
    super(BUSY, { cause });
    this.name = "IrisBusyError";
  }
}

// Statuses that mean "not now" while waiting on an attestation. The poller keeps polling.
const TRANSIENT_STATUSES = [429, 502, 503, 504];
// For a quote, only the statuses Iris uses for load; other 5xx stay an outage.
const BUSY_QUOTE_STATUSES = [429, 503];

// Hex that is real bytes: not "0x", and no half byte.
function isBytes(value: unknown): value is Hex {
  return typeof value === "string" && isHex(value) && value.length > 2 && value.length % 2 === 0;
}

function unreachable(cause: unknown) {
  return new Error(UNREACHABLE, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw unreachable(cause);
  }
}

// Looks at an error body without consuming it. A body that isn't JSON is just null here.
async function peekJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

async function send(fetcher: typeof fetch, url: string, init?: RequestInit) {
  try {
    return await fetcher(url, init);
  } catch (cause) {
    throw unreachable(cause);
  }
}

// Iris answers FORWARD requests on a route it can't forward with a 4xx that names forwarding.
// Keep this narrow: any other 4xx, above all TOKEN_NOT_SUPPORTED_ON_ROUTE (which a plain quote
// gets too), is a real error and retrying without FORWARD would hide it.
function isForwardRejection(status: number, body: unknown) {
  if (status < 400 || status >= 500 || !isRecord(body)) return false;
  if (body.errorCode === "TOKEN_NOT_SUPPORTED_ON_ROUTE") return false;
  const mentionsForward = (text: unknown) => typeof text === "string" && /forward/i.test(text);
  return mentionsForward(body.errorCode) || mentionsForward(body.error);
}

function parseQuote(body: unknown): Quote {
  if (!isRecord(body)) throw unreachable(new Error("The quote was not an object"));
  const { signedQuote, feeTotalAmount, items } = body;
  if (!isHex(signedQuote)) throw unreachable(new Error("The signed quote was not hex"));
  if (typeof feeTotalAmount !== "string" || !/^\d+$/.test(feeTotalAmount)) {
    throw unreachable(new Error("The quote had no whole-number fee"));
  }
  if (!Array.isArray(items)) throw unreachable(new Error("The quote had no fee items"));
  // What Iris will do, not what we asked for.
  const forwarded = items.some((item) => isRecord(item) && item.type === "FORWARD");
  return { signedQuote, feeTotal: BigInt(feeTotalAmount), forwarded };
}

function parseFoundMessage(body: unknown, { source, destination }: Route): FoundMessage {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw unreachable(new Error("The response had no messages list"));
  }
  const [entry] = body.messages;
  if (entry === undefined) return { state: "pending" };
  if (!isRecord(entry)) throw unreachable(new Error("The message entry was not an object"));
  const { attestation, message, status, forwardTxHash } = entry;
  // The attestation field can be the string "PENDING", null or missing while confirming.
  if (attestation === "PENDING" || status === "pending_confirmations") return { state: "pending" };
  if (status !== "complete") throw unreachable(new Error(`Unknown message status: ${status}`));
  // A partial attestation or message must never read as delivered: receiveMessage would burn gas.
  if (!isBytes(attestation) || !isBytes(message)) {
    throw unreachable(new Error("The attested message was not whole bytes"));
  }
  let nonce: Hex;
  try {
    // Also checks the message is at least a MessageV2 header long.
    nonce = messageNonce(message);
    const messageDomain = messageSourceDomain(message);
    if (messageDomain !== source.cctpDomain) {
      throw new Error(`The message came from domain ${messageDomain}, not ${source.cctpDomain}`);
    }
    // A message for another chain can't be this transfer's, and delivering it there would fail.
    const deliveredTo = messageDestinationDomain(message);
    if (deliveredTo !== destination.cctpDomain) {
      throw new Error(`The message goes to domain ${deliveredTo}, not ${destination.cctpDomain}`);
    }
  } catch (cause) {
    throw unreachable(cause);
  }
  // A message without forwarding has no forward transaction.
  const forwardHash =
    typeof forwardTxHash === "string" && isHash(forwardTxHash) ? forwardTxHash : null;
  // Only a message burned with FORWARD has a forward state. A plain one had no such key in the
  // first testnet runs; a null or missing state is read the same way, as not forwarded.
  const forwardState = typeof entry.forwardState === "string" ? entry.forwardState : null;
  const forwarded = forwardState !== null;
  return { state: "attested", message, attestation, nonce, forwardHash, forwarded, forwardState };
}

export function createIris(fetcher: typeof fetch = fetch) {
  async function requestQuote(input: QuoteInput, forward: boolean) {
    const requests = forward
      ? [
          {
            type: "FORWARD",
            params: {
              msgType: "TransferMessage",
              destinationAddress: input.recipient,
            },
          },
        ]
      : [];
    const { crossChainId, source, destination } = input;
    return send(
      fetcher,
      `${IRIS_URL}/v2/quote/cctpx/${crossChainId}/${source.cctpDomain}/${destination.cctpDomain}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Standard finality only: custom tokens have no FX symbol, so PRE_FINALITY never applies.
        body: JSON.stringify({
          amount: input.amount.toString(),
          feeToken: NO_FEE_TOKEN,
          requests,
        }),
      },
    );
  }

  async function busy(response: Response) {
    return new IrisBusyError(await peekJson(response));
  }

  async function quote(input: QuoteInput): Promise<Quote> {
    let response = await requestQuote(input, true);
    if (BUSY_QUOTE_STATUSES.includes(response.status)) throw await busy(response);
    if (!response.ok) {
      const body = await peekJson(response);
      // Some routes can't forward. Ask once more for a quote the user delivers themselves.
      if (isForwardRejection(response.status, body)) response = await requestQuote(input, false);
    }
    if (BUSY_QUOTE_STATUSES.includes(response.status)) throw await busy(response);
    if (!response.ok) {
      const body = await peekJson(response);
      // A 4xx names the problem (a bad amount, a token not on the route); a 5xx is an outage.
      if (response.status >= 400 && response.status < 500 && isRecord(body)) {
        const reason = [body.errorCode, body.error].filter((part) => typeof part === "string");
        throw new Error(`Circle rejected the quote: ${reason.join(": ")}`, {
          cause: body,
        });
      }
      throw unreachable(new Error(`Iris answered ${response.status}`));
    }
    return parseQuote(await readJson(response));
  }

  // Asked on the route's source; the message must also go to the route's destination.
  async function findMessage(route: Route, burnHash: Hash): Promise<FoundMessage> {
    const response = await send(
      fetcher,
      `${IRIS_URL}/v2/messages/${route.source.cctpDomain}?transactionHash=${encodeURIComponent(burnHash)}`,
    );
    if (response.status === 404) {
      // Iris answers 404 until it has indexed the burn. Anything else on a 404 is not Iris.
      const body = await readJson(response);
      if (isRecord(body) && typeof body.error === "string") return { state: "pending" };
      throw unreachable(new Error("Unexpected 404 from Iris"));
    }
    if (TRANSIENT_STATUSES.includes(response.status)) return { state: "pending" };
    if (!response.ok) throw unreachable(new Error(`Iris answered ${response.status}`));
    return parseFoundMessage(await readJson(response), route);
  }

  return { quote, findMessage };
}
