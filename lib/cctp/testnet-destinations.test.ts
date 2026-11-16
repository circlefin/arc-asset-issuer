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

import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA } from "@/lib/chains";
import { parseTestnetDestinations } from "./testnet-destinations";

describe("parseTestnetDestinations", () => {
  it("is Ethereum Sepolia when unset or empty", () => {
    expect(parseTestnetDestinations(undefined)).toEqual([ETHEREUM_SEPOLIA]);
    expect(parseTestnetDestinations("")).toEqual([ETHEREUM_SEPOLIA]);
  });

  it("reads a comma-separated list, ignoring spaces around each ID", () => {
    expect(parseTestnetDestinations("ethereum-sepolia , base-sepolia")).toEqual([ETHEREUM_SEPOLIA, BASE_SEPOLIA]);
  });

  it("throws for an unknown entry, naming it and the known ones", () => {
    expect(() => parseTestnetDestinations("ethereum-sepolia,mars")).toThrow(/has mars, which isn't one of .*base-sepolia/);
  });

  it("throws for the hub, which isn't a destination", () => {
    expect(() => parseTestnetDestinations("arc-testnet")).toThrow(/arc-testnet/);
  });

  it("throws for a blank entry", () => {
    expect(() => parseTestnetDestinations("ethereum-sepolia,")).toThrow(/isn't one of/);
    expect(() => parseTestnetDestinations(" , base-sepolia")).toThrow(/isn't one of/);
  });
});
