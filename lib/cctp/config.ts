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

import { maxUint256 } from "viem";

// Circle's entry point for non-USDC CCTP. The same address on every testnet.
export const CROSS_CHAIN_TOKEN_SERVICE = "0x63753E722bd2C2A5DF6EE19C5106662208B81077";

// CCTP's MessageTransmitterV2, which delivers attested messages. The same address on every testnet.
export const MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

// TokenManagerType.BURN_MINT: the TokenManager burns on the source and mints on the destination.
export const BURN_MINT = 1;

// Every TokenManager starts at a zero rate limit, which blocks all transfers.
export const DEFAULT_RATE_LIMIT_WHOLE_TOKENS = BigInt(1_000_000);

// No cap on a single transfer. Circle's docs disagree on what 0 means, so it's never used.
export const NO_TRANSFER_CAP = maxUint256;

// CCTP's standard finality. Custom tokens have no fast transfer, so it's the only threshold used.
export const STANDARD_FINALITY = 2000;

// Circle's attestation and fee-quote API for testnet. It allows cross-origin calls, so the browser
// talks to it directly.
export const IRIS_URL = "https://iris-api-sandbox.circle.com";
