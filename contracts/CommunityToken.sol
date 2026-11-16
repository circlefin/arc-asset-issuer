// Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.24;

import {BridgeableToken} from "./BridgeableToken.sol";

/// A community token or meme coin. Its description and image live with the app, not onchain.
contract CommunityToken is BridgeableToken {
    constructor(string memory name, string memory symbol, uint8 decimals_, address issuer, uint256 homeChainId)
        BridgeableToken(name, symbol, decimals_, issuer, homeChainId)
    {}
}
