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

import { concat, numberToHex, pad, size } from "viem";
import { describe, expect, it } from "vitest";
import { messageDestinationDomain, messageNonce, messageSourceDomain, newSalt, packAddress } from "./encoding";

describe("packAddress", () => {
  it("packs an address into its 20 bytes, not a padded 32-byte word", () => {
    const packed = packAddress("0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c");
    expect(size(packed)).toBe(20);
    expect(packed).toBe("0x2f12bd0f9de5b3490e77bf1871f736954610b78c");
  });
});

describe("newSalt", () => {
  it("makes 32 random bytes, different every time", () => {
    const first = newSalt();
    expect(size(first)).toBe(32);
    expect(newSalt()).not.toBe(first);
  });
});

describe("messageNonce", () => {
  const nonce = pad("0xabc123", { size: 32 });
  // MessageV2: version, source domain and destination domain (4 bytes each), then the nonce.
  const message = concat([
    numberToHex(1, { size: 4 }),
    numberToHex(26, { size: 4 }),
    numberToHex(6, { size: 4 }),
    nonce,
    // The rest of the 148-byte header (sender, recipient, caller, finality) and a body.
    pad("0x01", { size: 104 }),
  ]);

  it("reads the nonce from bytes 12 to 44", () => {
    expect(messageNonce(message)).toBe(nonce);
  });

  it("rejects a message too short to hold a nonce", () => {
    expect(() => messageNonce("0x0000000100000001a")).toThrow("too short");
  });

  it("rejects a blob that holds a nonce but is shorter than a MessageV2 header", () => {
    expect(() => messageNonce(concat(["0x000000010000001a00000000", nonce]))).toThrow("too short");
  });

  it("reads the source domain from bytes 4 to 8", () => {
    expect(messageSourceDomain(message)).toBe(26);
  });

  it("reads the destination domain from bytes 8 to 12", () => {
    expect(messageDestinationDomain(message)).toBe(6);
  });
});
