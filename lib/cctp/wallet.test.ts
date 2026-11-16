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

import type { Address } from "viem";
import { getWalletClient, switchChain } from "wagmi/actions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_TESTNET } from "@/lib/chains";
import { fakeChains, walletOn } from "./fake-chain";
import { walletFor } from "./wallet";

vi.mock("wagmi/actions", () => ({
  getPublicClient: vi.fn(),
  getWalletClient: vi.fn(),
  switchChain: vi.fn(),
}));

const ACCOUNT: Address = "0x2F12BD0F9dE5B3490e77Bf1871F736954610B78c";

describe("walletFor", () => {
  let chains: ReturnType<typeof fakeChains>;

  beforeEach(() => {
    vi.mocked(switchChain).mockReset();
    vi.mocked(getWalletClient).mockReset();
    chains = fakeChains();
  });

  it("returns the wallet once it's on the asked chain", async () => {
    const wallet = walletOn(chains.arc, ACCOUNT);
    vi.mocked(switchChain).mockResolvedValue(ARC_TESTNET.network);
    vi.mocked(getWalletClient).mockResolvedValue(wallet);
    await expect(walletFor(chains.wagmiConfig, ARC_TESTNET)).resolves.toBe(wallet);
    expect(switchChain).toHaveBeenCalledWith(chains.wagmiConfig, { chainId: ARC_TESTNET.network.id });
  });

  it("names the network when the user rejects the switch", async () => {
    vi.mocked(switchChain).mockRejectedValue(new Error("User rejected the request."));
    await expect(walletFor(chains.wagmiConfig, ARC_TESTNET)).rejects.toThrow(
      `Switch your wallet to ${ARC_TESTNET.name} to continue`,
    );
    expect(getWalletClient).not.toHaveBeenCalled();
  });

  it("refuses a wallet still on another chain", async () => {
    vi.mocked(switchChain).mockResolvedValue(ARC_TESTNET.network);
    vi.mocked(getWalletClient).mockResolvedValue(walletOn(chains.base, ACCOUNT));
    await expect(walletFor(chains.wagmiConfig, ARC_TESTNET)).rejects.toThrow(
      `Switch your wallet to ${ARC_TESTNET.name} to continue`,
    );
  });
});
