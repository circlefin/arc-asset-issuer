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

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// An ERC-20 that CCTP can move between chains as a custom BURN_MINT token.
/// New supply is only issued on the home chain. Everywhere else, tokens only
/// appear when the bridge mints what it burned on another chain.
abstract contract BridgeableToken is ERC20, AccessControl {
    /// Mints new supply, on the home chain only.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    enum MintKind {
        Issuer,
        Bridge
    }

    uint256 public immutable HOME_CHAIN_ID;
    uint8 private immutable _decimals;

    /// Everything the issuer ever minted. Since only the bridge burns, this equals the
    /// supply on every chain plus what's in transit between them.
    uint256 public issuedSupply;

    /// The CCTP TokenManager on this chain. Mints and burns tokens moving across chains. Set only
    /// once, so after setup not even the issuer can mint around issuedSupply or off the home chain.
    /// Before setBridge, the issuer chooses where it points.
    address public bridge;

    event Minted(address indexed to, uint256 amount, MintKind kind);
    event BridgeSet(address indexed bridge);

    error MintNotAllowed(address caller);
    error BurnNotAllowed(address caller);
    error BridgeAlreadySet();

    constructor(string memory name, string memory symbol, uint8 decimals_, address issuer, uint256 homeChainId)
        ERC20(name, symbol)
    {
        _decimals = decimals_;
        HOME_CHAIN_ID = homeChainId;
        _grantRole(DEFAULT_ADMIN_ROLE, issuer);
        _grantRole(ISSUER_ROLE, issuer);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function setBridge(address tokenManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bridge != address(0)) revert BridgeAlreadySet();
        bridge = tokenManager;
        emit BridgeSet(tokenManager);
    }

    function mint(address to, uint256 amount) external {
        MintKind kind;
        if (msg.sender == bridge) {
            kind = MintKind.Bridge;
        } else if (hasRole(ISSUER_ROLE, msg.sender) && block.chainid == HOME_CHAIN_ID) {
            kind = MintKind.Issuer;
            issuedSupply += amount;
        } else {
            revert MintNotAllowed(msg.sender);
        }
        _mint(to, amount);
        emit Minted(to, amount, kind);
    }

    /// Only the bridge burns, so supply only shrinks when tokens leave for another chain.
    function burn(uint256 amount) external {
        if (msg.sender != bridge) revert BurnNotAllowed(msg.sender);
        _burn(msg.sender, amount);
    }
}
