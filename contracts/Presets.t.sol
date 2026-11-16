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
import {CommunityToken} from "./CommunityToken.sol";
import {RwaToken} from "./RwaToken.sol";

contract PresetsTest is Test {
    uint256 constant ARC_TESTNET = 5042002;
    address issuer = makeAddr("issuer");

    function rwaInfo(string memory documentUrl) internal pure returns (RwaToken.RwaInfo memory) {
        return RwaToken.RwaInfo({
            issuerName: "Demo Treasury LLC",
            category: "Treasury bills",
            underlyingDescription: "Simulated 3-month T-bills",
            documentUrl: documentUrl
        });
    }

    function test_CommunityTokenStartsEmpty() public {
        CommunityToken token = new CommunityToken("Meme", "MEME", 18, issuer, ARC_TESTNET);
        assertEq(token.name(), "Meme");
        assertEq(token.symbol(), "MEME");
        assertEq(token.totalSupply(), 0);
        assertTrue(token.hasRole(token.ISSUER_ROLE(), issuer));
    }

    function test_RwaInfoRoundTrips() public {
        RwaToken token = new RwaToken("Bill", "BILL", 6, issuer, ARC_TESTNET, rwaInfo("https://example.com/doc.pdf"));
        RwaToken.RwaInfo memory info = token.rwaInfo();
        assertEq(info.issuerName, "Demo Treasury LLC");
        assertEq(info.category, "Treasury bills");
        assertEq(info.underlyingDescription, "Simulated 3-month T-bills");
        assertEq(info.documentUrl, "https://example.com/doc.pdf");
        assertEq(token.totalSupply(), 0);
    }

    function test_RwaAllowsEmptyDocumentUrl() public {
        RwaToken token = new RwaToken("Bill", "BILL", 6, issuer, ARC_TESTNET, rwaInfo(""));
        assertEq(token.rwaInfo().documentUrl, "");
    }

    function test_RwaIsMarkedSimulated() public {
        RwaToken token = new RwaToken("Bill", "BILL", 6, issuer, ARC_TESTNET, rwaInfo(""));
        assertTrue(token.SIMULATED_BACKING());
    }
}
