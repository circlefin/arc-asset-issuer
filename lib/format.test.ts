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

import { ContractFunctionExecutionError, HttpRequestError, RpcRequestError, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { describeError } from "./format";

describe("describeError", () => {
  it("reads the message of an error Supabase returns as a plain object", () => {
    expect(describeError({ code: "42501", message: "new row violates row-level security policy" })).toBe(
      "new row violates row-level security policy",
    );
  });

  it("says the server couldn't be reached when Supabase's fetch got no answer", () => {
    expect(describeError({ message: "TypeError: Failed to fetch", details: "", hint: "", code: "" })).toBe(
      "Couldn't reach the server. Check your connection and try again.",
    );
  });

  it("names the RPC and its reason for a refused request, however deep it sits", () => {
    const refused = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32614, message: "eth_getLogs is limited to a 200 range" },
      url: "https://sepolia.base.org/",
    });
    const read = new ContractFunctionExecutionError(refused, {
      abi: parseAbi(["function totalSupply() view returns (uint256)"]),
      functionName: "totalSupply",
    });
    expect(describeError(read)).toBe("sepolia.base.org refused a request: eth_getLogs is limited to a 200 range");
  });

  it("names the RPC that couldn't be reached", () => {
    const unreachable = new HttpRequestError({ url: "https://sepolia.base.org/", details: "Failed to fetch" });
    expect(describeError(unreachable)).toBe("Couldn't reach sepolia.base.org. Try again in a moment.");
  });
});
