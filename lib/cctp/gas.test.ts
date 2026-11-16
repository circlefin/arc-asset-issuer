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
import { ARC_TESTNET, BASE_SEPOLIA, ETHEREUM_SEPOLIA, OP_SEPOLIA } from "@/lib/chains";
import { measuredGas } from "./gas";

describe("measuredGas", () => {
  it("gives a measured chain its own gas", () => {
    expect(measuredGas(ARC_TESTNET).crossChainTransfer).toBe(BigInt(360_000));
    expect(measuredGas(ETHEREUM_SEPOLIA).register).toBe(BigInt(2_600_000));
    expect(measuredGas(BASE_SEPOLIA).crossChainTransfer).toBe(BigInt(360_000));
  });

  it("gives a chain not measured yet Ethereum Sepolia's, the most expensive", () => {
    expect(measuredGas(OP_SEPOLIA)).toEqual(measuredGas(ETHEREUM_SEPOLIA));
  });
});
