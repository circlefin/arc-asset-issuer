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

/// A real-world asset token for demonstration. The asset details are stored onchain so
/// anyone can read them, but nothing backs the token: see SIMULATED_BACKING.
contract RwaToken is BridgeableToken {
    struct RwaInfo {
        string issuerName;
        string category;
        string underlyingDescription;
        // Empty when the issuer gave no supporting document.
        string documentUrl;
    }

    /// The backing and documents are demo information. Nothing here is verified.
    bool public constant SIMULATED_BACKING = true;

    RwaInfo private _rwaInfo;

    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_,
        address issuer,
        uint256 homeChainId,
        RwaInfo memory info
    ) BridgeableToken(name, symbol, decimals_, issuer, homeChainId) {
        _rwaInfo = info;
    }

    function rwaInfo() external view returns (RwaInfo memory) {
        return _rwaInfo;
    }
}
