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

import type { Hash, PublicClient, ReplacementReason } from "viem";
import type { Config } from "wagmi";
import { getPublicClient, getWalletClient, switchChain } from "wagmi/actions";
import type { Chain } from "@/lib/chains";

function switchMessage(chain: Chain) {
  return `Switch your wallet to ${chain.name} to continue`;
}

// The connected wallet, on the given chain. Asks the wallet to switch first, and refuses to
// hand back a wallet that's still somewhere else, so nothing is ever signed on the wrong chain.
export async function walletFor(config: Config, chain: Chain) {
  const chainId = chain.network.id;
  try {
    await switchChain(config, { chainId });
  } catch (error) {
    throw new Error(switchMessage(chain), { cause: error });
  }
  const wallet = await getWalletClient(config, { chainId });
  if (wallet.chain.id !== chainId) throw new Error(switchMessage(chain));
  return wallet;
}

export function publicFor(config: Config, chain: Chain) {
  const client = getPublicClient(config, { chainId: chain.network.id });
  if (!client) throw new Error(`${chain.name} isn't configured in wagmi`);
  return client;
}

// The wallet sent another transaction in place of the signed one, so the signed one never ran.
export class ReplacedError extends Error {
  constructor(readonly reason: Exclude<ReplacementReason, "repriced">) {
    super(
      reason === "cancelled"
        ? "The transaction was cancelled in the wallet, so it never ran."
        : "The transaction was replaced in the wallet, so it never ran.",
    );
  }
}

// The receipt of a transaction the wallet sent. A sped-up one still runs what was signed, so
// it's followed to its new hash. A cancelled or replaced one throws ReplacedError. Past the
// timeout (viem's 180 s unless given) it throws viem's WaitForTransactionReceiptTimeoutError.
export async function waitForSent(client: PublicClient, hash: Hash, timeout?: number) {
  const replacement: { reason?: ReplacementReason } = {};
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout,
    onReplaced: ({ reason }) => {
      replacement.reason = reason;
    },
  });
  if (replacement.reason && replacement.reason !== "repriced") throw new ReplacedError(replacement.reason);
  return receipt;
}
