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

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {BridgeableToken} from "./BridgeableToken.sol";

contract TestToken is BridgeableToken {
    constructor(uint8 decimals_, address issuer, uint256 homeChainId)
        BridgeableToken("Test", "TST", decimals_, issuer, homeChainId)
    {}
}

contract BridgeableTokenTest is Test {
    uint256 constant ARC_TESTNET = 5042002;
    uint256 constant BASE_SEPOLIA = 84532;

    address issuer = makeAddr("issuer");
    address holder = makeAddr("holder");
    address stranger = makeAddr("stranger");
    address bridge = makeAddr("bridge");
    TestToken token;

    event Minted(address indexed to, uint256 amount, BridgeableToken.MintKind kind);
    event BridgeSet(address indexed bridge);

    function setUp() public {
        vm.chainId(ARC_TESTNET);
        token = new TestToken(6, issuer, ARC_TESTNET);
    }

    function setBridge() internal {
        vm.prank(issuer);
        token.setBridge(bridge);
    }

    function test_StartsWithZeroSupply() public view {
        assertEq(token.totalSupply(), 0);
        assertEq(token.issuedSupply(), 0);
    }

    function test_IssuerMintsOnHomeChain() public {
        vm.expectEmit(address(token));
        emit Minted(holder, 100, BridgeableToken.MintKind.Issuer);
        vm.prank(issuer);
        token.mint(holder, 100);
        assertEq(token.balanceOf(holder), 100);
        assertEq(token.issuedSupply(), 100);
    }

    function test_IssuerCannotMintOffHomeChain() public {
        vm.chainId(BASE_SEPOLIA);
        vm.expectRevert(abi.encodeWithSelector(BridgeableToken.MintNotAllowed.selector, issuer));
        vm.prank(issuer);
        token.mint(holder, 100);
    }

    function test_StrangerCannotMint() public {
        vm.expectRevert(abi.encodeWithSelector(BridgeableToken.MintNotAllowed.selector, stranger));
        vm.prank(stranger);
        token.mint(holder, 100);
    }

    function test_BridgeMintDoesNotChangeIssued() public {
        setBridge();
        vm.chainId(BASE_SEPOLIA);
        vm.expectEmit(address(token));
        emit Minted(holder, 50, BridgeableToken.MintKind.Bridge);
        vm.prank(bridge);
        token.mint(holder, 50);
        assertEq(token.balanceOf(holder), 50);
        assertEq(token.issuedSupply(), 0);
    }

    function test_HolderCannotBurn() public {
        vm.prank(issuer);
        token.mint(holder, 100);
        vm.expectRevert(abi.encodeWithSelector(BridgeableToken.BurnNotAllowed.selector, holder));
        vm.prank(holder);
        token.burn(10);
    }

    function test_BridgeIsSetOnlyOnce() public {
        setBridge();
        vm.expectRevert(BridgeableToken.BridgeAlreadySet.selector);
        vm.prank(issuer);
        token.setBridge(stranger);
        assertEq(token.bridge(), bridge);
    }

    function test_OnlyAdminSetsBridge() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, token.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        token.setBridge(stranger);
    }

    function test_BridgeBurnsOwnBalance() public {
        setBridge();
        vm.prank(issuer);
        token.mint(bridge, 100);
        vm.prank(bridge);
        token.burn(40);
        assertEq(token.balanceOf(bridge), 60);
        assertEq(token.totalSupply(), 60);
    }

    function test_SetBridgeEmitsBridgeSet() public {
        vm.expectEmit(address(token));
        emit BridgeSet(bridge);
        vm.prank(issuer);
        token.setBridge(bridge);
    }

    function test_IssuerAndStrangerCannotBurn() public {
        setBridge();
        vm.startPrank(issuer);
        token.mint(issuer, 100);
        vm.expectRevert(abi.encodeWithSelector(BridgeableToken.BurnNotAllowed.selector, issuer));
        token.burn(10);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(BridgeableToken.BurnNotAllowed.selector, stranger));
        vm.prank(stranger);
        token.burn(10);
        assertEq(token.totalSupply(), 100);
    }

    // The exact calls Circle's TokenManager makes: transferFrom(user, manager, amount) then
    // burn(amount) on its own balance, and a plain mint(recipient, amount) on the way in.
    function test_TokenManagerFlow() public {
        setBridge();
        vm.prank(issuer);
        token.mint(holder, 100);

        vm.prank(holder);
        token.approve(bridge, 40);

        vm.startPrank(bridge);
        token.transferFrom(holder, bridge, 40);
        assertEq(token.balanceOf(bridge), 40);
        token.burn(40);
        vm.stopPrank();

        assertEq(token.balanceOf(holder), 60);
        assertEq(token.balanceOf(bridge), 0);
        assertEq(token.totalSupply(), 60);
        assertEq(token.issuedSupply(), 100);

        // Arriving from another chain: minted straight to the recipient, issuedSupply untouched.
        vm.chainId(BASE_SEPOLIA);
        vm.expectEmit(address(token));
        emit Minted(stranger, 40, BridgeableToken.MintKind.Bridge);
        vm.prank(bridge);
        token.mint(stranger, 40);
        assertEq(token.balanceOf(stranger), 40);
        assertEq(token.totalSupply(), 100);
        assertEq(token.issuedSupply(), 100);
    }

    function test_DecimalsConfigurable() public {
        assertEq(new TestToken(0, issuer, ARC_TESTNET).decimals(), 0);
        assertEq(new TestToken(6, issuer, ARC_TESTNET).decimals(), 6);
        assertEq(new TestToken(18, issuer, ARC_TESTNET).decimals(), 18);
    }
}
