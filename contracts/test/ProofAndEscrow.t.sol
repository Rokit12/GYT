// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProofRegistry} from "../src/ProofRegistry.sol";
import {ArrivalEscrow} from "../src/ArrivalEscrow.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MerkleHelper} from "./Helpers.sol";

contract ProofAndEscrowTest is Test {
    ProofRegistry proofs;
    ArrivalEscrow escrow;
    MockUSD usd;

    address charterer = makeAddr("charterer");
    address marina = makeAddr("marina");
    address platform = makeAddr("platform");
    address oracle = makeAddr("oracle");

    bytes32 constant REF = bytes32("BK-4098");
    bytes32 constant MARINA = bytes32("MARINA-DXB-001");
    uint256 constant TWIN = 7;

    function setUp() public {
        vm.warp(1_790_000_000);
        proofs = new ProofRegistry(address(this));
        usd = new MockUSD();
        escrow = new ArrivalEscrow(usd, proofs, address(this));
        escrow.grantRole(escrow.ORACLE_ROLE(), oracle);
        usd.mint(charterer, 1_000_000e6);
        vm.prank(charterer);
        usd.approve(address(escrow), type(uint256).max);
    }

    // ---------- shared vector with api/app/proof.py ----------
    function test_matchesBackendVector() public pure {
        bytes32[] memory leaves = new bytes32[](5);
        for (uint8 i = 0; i < 5; i++) leaves[i] = sha256(abi.encodePacked(i));
        assertEq(MerkleHelper.root(leaves), hex"9674600fd139741c0f7dd7a32d984a0e74401cc90e6e8e5d203ed973d27324fe");
        bytes32[] memory p = MerkleHelper.proof(leaves, 4);
        assertEq(p[0], hex"e52d9c508c502347344d8c07ad91cbd6068afc75ff6292f062a09ca381c89e71");
        assertEq(p[1], hex"0e68f91a160a8a636202faf51d6b64cdc99ab3a1261f61f4556dc481997c66cb");
        assertEq(p[2], hex"9675e04b4ba9dc81b06e81731e2d21caa2c95557a85dcfa3fff70c9ff0f30b2e");
    }

    function test_arrivalLeafMatchesBackend() public view {
        bytes32 leaf = escrow.arrivalLeaf(REF, TWIN, MARINA, sha256("fusion"));
        assertEq(leaf, hex"18684d7cb64c93be014d1f7f75f63f077873c000c2f602b6d380c0db4e5d7060");
    }

    // ---------- registry ----------
    function testFuzz_everyLeafVerifies(uint8 n, uint8 pick) public {
        n = uint8(bound(n, 1, 40));
        pick = uint8(bound(pick, 0, n - 1));
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) leaves[i] = sha256(abi.encodePacked("event", i));
        uint256 idx = proofs.anchor(MerkleHelper.root(leaves), n, 1, 2);
        assertTrue(proofs.verify(leaves[pick], MerkleHelper.proof(leaves, pick), pick, idx));
        assertFalse(proofs.verify(sha256("forged"), MerkleHelper.proof(leaves, pick), pick, idx));
    }

    function test_cannotAnchorTwice() public {
        proofs.anchor(bytes32(uint256(1)), 1, 0, 0);
        vm.expectRevert(ProofRegistry.AlreadyAnchored.selector);
        proofs.anchor(bytes32(uint256(1)), 1, 0, 0);
    }

    function test_onlyAnchorRole() public {
        vm.prank(charterer);
        vm.expectRevert();
        proofs.anchor(bytes32(uint256(2)), 1, 0, 0);
    }

    // ---------- escrow ----------
    function _fund(uint256 amount) internal {
        ArrivalEscrow.Split[] memory s = new ArrivalEscrow.Split[](2);
        s[0] = ArrivalEscrow.Split(marina, 9_000);
        s[1] = ArrivalEscrow.Split(platform, 1_000);
        vm.prank(charterer);
        escrow.fund(REF, amount, TWIN, MARINA, uint64(block.timestamp + 7 days), s);
    }

    function _anchorArrival(bytes32 digest) internal returns (bytes32[] memory proof, uint256 idx, uint256 aIdx) {
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = sha256("position-1");
        leaves[1] = escrow.arrivalLeaf(REF, TWIN, MARINA, digest);
        leaves[2] = sha256("position-2");
        aIdx = proofs.anchor(MerkleHelper.root(leaves), 3, 1, 2);
        proof = MerkleHelper.proof(leaves, 1);
        idx = 1;
    }

    function test_releaseOnProvenArrival() public {
        _fund(12_600e6);
        bytes32 digest = sha256("ais+gps+sar");
        (bytes32[] memory p, uint256 i, uint256 a) = _anchorArrival(digest);
        vm.prank(oracle);
        escrow.release(REF, digest, p, i, a);
        assertEq(usd.balanceOf(marina), 11_340e6);
        assertEq(usd.balanceOf(platform), 1_260e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
        (,,,,, ArrivalEscrow.Status st,) = escrow.bookings(REF);
        assertEq(uint8(st), uint8(ArrivalEscrow.Status.Released));
    }

    function test_releaseRejectsWrongDigest() public {
        _fund(1_000e6);
        (bytes32[] memory p, uint256 i, uint256 a) = _anchorArrival(sha256("real"));
        bytes32 fake = sha256("fake");
        vm.prank(oracle);
        vm.expectRevert(ArrivalEscrow.ProofInvalid.selector);
        escrow.release(REF, fake, p, i, a);
    }

    function test_releaseOnlyOracle() public {
        _fund(1_000e6);
        bytes32 d = sha256("x");
        (bytes32[] memory p, uint256 i, uint256 a) = _anchorArrival(d);
        vm.prank(charterer);
        vm.expectRevert();
        escrow.release(REF, d, p, i, a);
    }

    function test_noDoubleRelease() public {
        _fund(1_000e6);
        bytes32 d = sha256("x");
        (bytes32[] memory p, uint256 i, uint256 a) = _anchorArrival(d);
        vm.startPrank(oracle);
        escrow.release(REF, d, p, i, a);
        vm.expectRevert(ArrivalEscrow.NotFunded.selector);
        escrow.release(REF, d, p, i, a);
        vm.stopPrank();
    }

    function test_refundAfterDeadline() public {
        _fund(5_000e6);
        vm.prank(charterer);
        vm.expectRevert(ArrivalEscrow.TooEarly.selector);
        escrow.refund(REF);
        vm.warp(block.timestamp + 8 days);
        uint256 before = usd.balanceOf(charterer);
        vm.prank(charterer);
        escrow.refund(REF);
        assertEq(usd.balanceOf(charterer) - before, 5_000e6);
    }

    function test_splitsMustSumTo100() public {
        ArrivalEscrow.Split[] memory s = new ArrivalEscrow.Split[](1);
        s[0] = ArrivalEscrow.Split(marina, 9_999);
        vm.prank(charterer);
        vm.expectRevert(ArrivalEscrow.BadSplits.selector);
        escrow.fund(REF, 1e6, TWIN, MARINA, 0, s);
    }

    function test_cannotFundSameRefTwice() public {
        _fund(1e6);
        vm.expectRevert(ArrivalEscrow.BookingExists.selector);
        _fund(1e6);
    }
}
