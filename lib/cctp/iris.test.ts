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

import { concat, numberToHex, pad, zeroAddress, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_TESTNET, BASE_SEPOLIA, ETHEREUM_SEPOLIA } from "../chains";
import { messageNonce } from "./encoding";
import { createIris, IrisBusyError } from "./iris";

const UNREACHABLE = "Couldn't reach Circle's attestation service";
const CROSS_CHAIN_ID: Hex = `0x${"36".repeat(32)}`;
const RECIPIENT = "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c";
const BURN_HASH: Hash = `0x${"ab".repeat(32)}`;
const FORWARD_HASH: Hash = `0x${"cd".repeat(32)}`;

type Call = { url: string; init: RequestInit | undefined };

// A fake fetch that answers from a queue and records what was asked.
function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error("No response queued");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetcher, calls };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function quoteBody(forwarded: boolean) {
  const items = forwarded
    ? [
        { type: "FORWARD", amount: "300", args: {}, argsHash: "0x01" },
        { type: "PROTOCOL", amount: "700", args: {}, argsHash: "0x02" },
      ]
    : [{ type: "PROTOCOL", amount: "700", args: {}, argsHash: "0x02" }];
  return {
    signedQuote: "0xdeadbeef",
    issuedAt: 1,
    expiry: { mode: "TIMESTAMP", expiresAt: 2 },
    feeTotalAmount: forwarded ? "1000" : "700",
    feeToken: zeroAddress,
    items,
    nonce: "0x01",
  };
}

const quoteInput = {
  crossChainId: CROSS_CHAIN_ID,
  source: ARC_TESTNET,
  destination: ETHEREUM_SEPOLIA,
  amount: BigInt(5_000_000),
  recipient: RECIPIENT,
} as const;

function requestBody(call: Call) {
  if (typeof call.init?.body !== "string") throw new Error("The request had no JSON body");
  return JSON.parse(call.init.body);
}

describe("quote", () => {
  it("asks for a forwarded transfer and parses the fee into a bigint", async () => {
    const { fetcher, calls } = fakeFetch(json(quoteBody(true)));
    const quote = await createIris(fetcher).quote(quoteInput);

    expect(quote).toEqual({
      signedQuote: "0xdeadbeef",
      feeTotal: BigInt(1000),
      forwarded: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://iris-api-sandbox.circle.com/v2/quote/cctpx/${CROSS_CHAIN_ID}/26/0`,
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = requestBody(calls[0]);
    expect(body).toEqual({
      amount: "5000000",
      feeToken: zeroAddress,
      requests: [
        {
          type: "FORWARD",
          params: { msgType: "TransferMessage", destinationAddress: RECIPIENT },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("PRE_FINALITY");
  });

  it("takes the domains from the chains", async () => {
    const { fetcher, calls } = fakeFetch(json(quoteBody(true)));
    await createIris(fetcher).quote({
      ...quoteInput,
      source: ETHEREUM_SEPOLIA,
      destination: BASE_SEPOLIA,
    });
    expect(
      calls[0].url.endsWith(`/${ETHEREUM_SEPOLIA.cctpDomain}/${BASE_SEPOLIA.cctpDomain}`),
    ).toBe(true);
  });

  it("reports forwarded from the response, not from the request", async () => {
    const { fetcher } = fakeFetch(json(quoteBody(false)));
    const quote = await createIris(fetcher).quote(quoteInput);
    expect(quote.forwarded).toBe(false);
    expect(quote.feeTotal).toBe(BigInt(700));
  });

  it("retries once without FORWARD when Iris rejects forwarding on the route", async () => {
    const { fetcher, calls } = fakeFetch(
      json(
        {
          errorCode: "FORWARD_NOT_SUPPORTED",
          error: "Forwarding is not available",
        },
        400,
      ),
      json(quoteBody(false)),
    );
    const quote = await createIris(fetcher).quote(quoteInput);

    expect(quote.forwarded).toBe(false);
    expect(calls).toHaveLength(2);
    expect(requestBody(calls[1]).requests).toEqual([]);
    expect(JSON.stringify(requestBody(calls[1]))).not.toContain("PRE_FINALITY");
  });

  it("retries when only the message mentions FORWARD", async () => {
    const { fetcher, calls } = fakeFetch(
      json(
        {
          errorCode: "BAD_REQUEST",
          error: "Request type FORWARD is not supported",
        },
        400,
      ),
      json(quoteBody(false)),
    );
    await createIris(fetcher).quote(quoteInput);
    expect(calls).toHaveLength(2);
  });

  it("does not retry when the token is not on the route, and surfaces the error", async () => {
    const { fetcher, calls } = fakeFetch(
      json(
        {
          errorCode: "TOKEN_NOT_SUPPORTED_ON_ROUTE",
          error: "Token is not supported on route",
        },
        400,
      ),
    );
    await expect(createIris(fetcher).quote(quoteInput)).rejects.toThrow(
      "TOKEN_NOT_SUPPORTED_ON_ROUTE",
    );
    expect(calls).toHaveLength(1);
  });

  it("does not retry on an unrelated 4xx", async () => {
    const { fetcher, calls } = fakeFetch(json({ errorCode: "INVALID_AMOUNT", error: "Bad" }, 400));
    await expect(createIris(fetcher).quote(quoteInput)).rejects.toThrow("INVALID_AMOUNT");
    expect(calls).toHaveLength(1);
  });

  it.each([429, 503])("throws a retryable busy error on a %i, not a rejection", async (status) => {
    const { fetcher, calls } = fakeFetch(json({ error: "Slow down" }, status));
    const error = await createIris(fetcher)
      .quote(quoteInput)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IrisBusyError);
    expect(error instanceof Error && error.message).toBe(
      "Circle is busy right now. Try again in a moment.",
    );
    expect(error instanceof Error && error.cause).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("throws the busy error when the retry without FORWARD is rate limited", async () => {
    const { fetcher } = fakeFetch(
      json({ errorCode: "FORWARD_NOT_SUPPORTED", error: "no" }, 400),
      json({ error: "Slow down" }, 429),
    );
    await expect(createIris(fetcher).quote(quoteInput)).rejects.toBeInstanceOf(IrisBusyError);
  });

  it("throws if the retry without FORWARD fails too", async () => {
    const { fetcher, calls } = fakeFetch(
      json({ errorCode: "FORWARD_NOT_SUPPORTED", error: "no" }, 400),
      json({ error: "down" }, 500),
    );
    await expect(createIris(fetcher).quote(quoteInput)).rejects.toThrow(UNREACHABLE);
    expect(calls).toHaveLength(2);
  });

  it("throws, keeping the cause, on a 5xx", async () => {
    const { fetcher } = fakeFetch(json({ error: "boom" }, 500));
    const error = await createIris(fetcher)
      .quote(quoteInput)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.message).toBe(UNREACHABLE);
    expect(error instanceof Error && error.cause).toBeDefined();
  });

  it("throws when the network call fails", async () => {
    const { fetcher } = fakeFetch(new TypeError("fetch failed"));
    await expect(createIris(fetcher).quote(quoteInput)).rejects.toThrow(UNREACHABLE);
  });

  it("names the domain a message for another destination goes to", async () => {
    const { fetcher } = fakeFetch(
      json(completeMessage({ message: buildMessage(ARC_TESTNET.cctpDomain, BASE_SEPOLIA.cctpDomain) })),
    );
    const failure = await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH).catch((error: unknown) => error);
    expect(failure).toHaveProperty("cause.message", "The message goes to domain 6, not 0");
  });

  it("throws on a body that is not JSON", async () => {
    const { fetcher } = fakeFetch(new Response("<html>", { status: 200 }));
    await expect(createIris(fetcher).quote(quoteInput)).rejects.toThrow(UNREACHABLE);
  });

  it.each([
    ["a signed quote that is not hex", { signedQuote: "nope" }],
    ["a fee that is not a whole number", { feeTotalAmount: "1.5" }],
    ["a missing fee", { feeTotalAmount: undefined }],
    ["no items", { items: undefined }],
  ])("throws on %s", async (_name, patch) => {
    const { fetcher } = fakeFetch(json({ ...quoteBody(true), ...patch }));
    await expect(createIris(fetcher).quote(quoteInput)).rejects.toThrow(UNREACHABLE);
  });
});

const NONCE = pad("0xabc123", { size: 32 });
// MessageV2: 148-byte header (version, domains, nonce, sender, recipient, caller, finality) + body.
function buildMessage(sourceDomain: number, destinationDomain = ETHEREUM_SEPOLIA.cctpDomain): Hex {
  return concat([
    numberToHex(1, { size: 4 }),
    numberToHex(sourceDomain, { size: 4 }),
    numberToHex(destinationDomain, { size: 4 }),
    NONCE,
    pad("0x01", { size: 104 }),
  ]);
}

const MESSAGE = buildMessage(ARC_TESTNET.cctpDomain);
// The route buildMessage's messages travel: from the domain given, to Ethereum Sepolia's (0).
const ARC_TO_ETHEREUM = { source: ARC_TESTNET, destination: ETHEREUM_SEPOLIA };

function completeMessage(extra: Record<string, unknown> = {}) {
  return {
    messages: [
      {
        attestation: "0xa77e57",
        message: MESSAGE,
        eventNonce: "999",
        status: "complete",
        decodedMessage: {},
        ...extra,
      },
    ],
  };
}

describe("findMessage", () => {
  it("asks by the burn transaction on the source domain", async () => {
    const { fetcher, calls } = fakeFetch(json(completeMessage()));
    await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH);
    expect(calls[0].url).toBe(
      `https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${BURN_HASH}`,
    );
  });

  it("is pending when Iris has not indexed the burn yet (404)", async () => {
    const { fetcher } = fakeFetch(
      json({ error: "Message not found for provided parameters" }, 404),
    );
    expect(await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).toEqual({
      state: "pending",
    });
  });

  it("is pending while the attestation is PENDING", async () => {
    const { fetcher } = fakeFetch(
      json({
        messages: [
          {
            attestation: "PENDING",
            message: null,
            eventNonce: "999",
            status: "pending_confirmations",
          },
        ],
      }),
    );
    expect(await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).toEqual({
      state: "pending",
    });
  });

  it("is pending when the list is empty", async () => {
    const { fetcher } = fakeFetch(json({ messages: [] }));
    expect(await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).toEqual({
      state: "pending",
    });
  });

  it("returns the attested message with the nonce read from the message", async () => {
    const { fetcher } = fakeFetch(json(completeMessage()));
    const found = await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH);
    expect(found).toEqual({
      state: "attested",
      message: MESSAGE,
      attestation: "0xa77e57",
      nonce: messageNonce(MESSAGE),
      forwardHash: null,
      forwarded: false,
      forwardState: null,
    });
  });

  it("is forwarded while Circle is still delivering, before there's a forward transaction", async () => {
    const { fetcher } = fakeFetch(json(completeMessage({ forwardState: "PENDING", forwardTxHash: null })));
    const found = await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH);
    expect(found).toMatchObject({ state: "attested", forwarded: true, forwardHash: null, forwardState: "PENDING" });
  });

  it("isn't forwarded when the message has no forward state", async () => {
    const { fetcher } = fakeFetch(json(completeMessage({ forwardTxHash: FORWARD_HASH })));
    const found = await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH);
    expect(found).toMatchObject({ state: "attested", forwarded: false });
  });

  it("isn't forwarded when the message's forward state is null", async () => {
    const { fetcher } = fakeFetch(json(completeMessage({ forwardState: null, forwardTxHash: null })));
    const found = await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH);
    expect(found).toMatchObject({ state: "attested", forwarded: false, forwardState: null });
  });

  it("returns the forward transaction when Circle delivered the transfer", async () => {
    const { fetcher } = fakeFetch(
      json(
        completeMessage({
          forwardState: "CONFIRMED",
          forwardTxHash: FORWARD_HASH,
          destinationMintTxHash: FORWARD_HASH,
        }),
      ),
    );
    const found = await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH);
    expect(found).toMatchObject({
      state: "attested",
      forwardHash: FORWARD_HASH,
      forwarded: true,
      forwardState: "CONFIRMED",
    });
  });

  it.each([429, 502, 503, 504])("keeps waiting on a transient %i", async (status) => {
    const { fetcher } = fakeFetch(json({ error: "try later" }, status));
    expect(await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).toEqual({
      state: "pending",
    });
  });

  it("throws on a 500", async () => {
    const { fetcher } = fakeFetch(json({ error: "boom" }, 500));
    await expect(createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).rejects.toThrow(
      UNREACHABLE,
    );
  });

  it("is pending while confirmations are outstanding, whatever the attestation field says", async () => {
    for (const entry of [
      { status: "pending_confirmations", eventNonce: "1" },
      { status: "pending_confirmations", attestation: null, message: null },
    ]) {
      const { fetcher } = fakeFetch(json({ messages: [entry] }));
      expect(await createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).toEqual({
        state: "pending",
      });
    }
  });

  it("throws when the network call fails", async () => {
    const { fetcher } = fakeFetch(new TypeError("fetch failed"));
    await expect(createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).rejects.toThrow(
      UNREACHABLE,
    );
  });

  it("throws on a body that is not JSON", async () => {
    const { fetcher } = fakeFetch(new Response("gateway timeout", { status: 200 }));
    await expect(createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).rejects.toThrow(
      UNREACHABLE,
    );
  });

  it("throws on a 404 whose body is not Iris's not-found answer", async () => {
    const { fetcher } = fakeFetch(new Response("<html>not found</html>", { status: 404 }));
    await expect(createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).rejects.toThrow(
      UNREACHABLE,
    );
  });

  it.each([
    ["a complete message with a non-hex attestation", completeMessage({ attestation: "nope" })],
    ["a complete message with no message bytes", completeMessage({ message: null })],
    ["a message too short to hold a nonce", completeMessage({ message: "0x01" })],
    ["an empty attestation", completeMessage({ attestation: "0x" })],
    ["an odd-length attestation", completeMessage({ attestation: "0xabc" })],
    ["an empty message", completeMessage({ message: "0x" })],
    ["an odd-length message", completeMessage({ message: `${MESSAGE}0` })],
    [
      "a 44-byte blob that is not a MessageV2",
      completeMessage({ message: concat(["0x000000010000001a00000000", NONCE]) }),
    ],
    [
      "a message from a different source domain",
      completeMessage({ message: buildMessage(BASE_SEPOLIA.cctpDomain) }),
    ],
    [
      "a message to a different destination domain",
      completeMessage({ message: buildMessage(ARC_TESTNET.cctpDomain, BASE_SEPOLIA.cctpDomain) }),
    ],
    ["a body with no messages list", { something: "else" }],
    ["an unknown status", completeMessage({ status: "weird" })],
  ])("throws on %s", async (_name, body) => {
    const { fetcher } = fakeFetch(json(body));
    await expect(createIris(fetcher).findMessage(ARC_TO_ETHEREUM, BURN_HASH)).rejects.toThrow(
      UNREACHABLE,
    );
  });
});
