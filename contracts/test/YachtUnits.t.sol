// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {Compliance} from "../src/Compliance.sol";
import {YachtUnits} from "../src/YachtUnits.sol";
import {YachtTwin} from "../src/YachtTwin.sol";

contract YachtUnitsTest is Test {
    IdentityRegistry reg;
    Compliance comp;
    YachtUnits units;
    YachtTwin twin;

    address admin = address(this);
    address pro = makeAddr("pro"); // UAE professional
    address retail = makeAddr("retail"); // Kenya retail
    address stranger = makeAddr("stranger"); // not verified
    address blocked = makeAddr("blocked"); // verified, country not allowed

    uint16 constant UAE = 784;
    uint16 constant KENYA = 404;
    uint16 constant OTHER = 999;

    function setUp() public {
        vm.warp(1_790_000_000);
        reg = new IdentityRegistry(admin);
        comp = new Compliance(reg, admin);
        twin = new YachtTwin(admin, "https://api.gyt.example/twins/");
        uint256 tid = twin.mint(admin, "YACHT-000001", keccak256("KY:741234"), bytes32(0));
        units = new YachtUnits("Azure Meridian Units", "AZM", tid, 20_000, comp, admin);
        comp.bindToken(address(units));
        comp.setCountry(UAE, true);
        comp.setCountry(KENYA, true);

        uint64 exp = uint64(block.timestamp + 365 days);
        reg.register(pro, UAE, true, exp, keccak256("kyc-pro"));
        reg.register(retail, KENYA, false, exp, keccak256("kyc-retail"));
        reg.register(blocked, OTHER, true, exp, keccak256("kyc-blocked"));
        reg.register(admin, UAE, true, exp, keccak256("kyc-admin"));
        comp.setCaps(10_000, 200); // admin/issuer may hold the full float before distribution
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function test_mintToVerifiedPro() public {
        units.mint(pro, 5_000);
        assertEq(units.balanceOf(pro), 5_000);
        assertEq(units.decimals(), 0);
    }

    function test_mintToUnverifiedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(YachtUnits.TransferNotCompliant.selector, "RECEIVER_NOT_VERIFIED"));
        units.mint(stranger, 10);
    }

    function test_countryNotAllowed() public {
        vm.expectRevert(abi.encodeWithSelector(YachtUnits.TransferNotCompliant.selector, "COUNTRY_NOT_ALLOWED"));
        units.mint(blocked, 10);
    }

    function test_retailHoldingCap() public {
        units.mint(admin, 19_000);
        vm.expectRevert(abi.encodeWithSelector(YachtUnits.TransferNotCompliant.selector, "HOLDING_CAP"));
        units.mint(retail, 400); // 400 / 19_400 = 2.06% > 2%
    }

    function test_retailCapReverts() public {
        units.mint(admin, 19_000);
        vm.expectRevert(abi.encodeWithSelector(YachtUnits.TransferNotCompliant.selector, "HOLDING_CAP"));
        units.transfer(retail, 401); // 401 / 19_000 > 2%
    }

    function test_retailWithinCap() public {
        units.mint(admin, 20_000);
        units.transfer(retail, 400); // exactly 2%
        assertEq(units.balanceOf(retail), 400);
    }

    function test_lockupBlocksSecondary() public {
        units.mint(pro, 1_000);
        comp.setLockup(uint64(block.timestamp + 30 days));
        vm.prank(pro);
        vm.expectRevert(abi.encodeWithSelector(YachtUnits.TransferNotCompliant.selector, "LOCKUP"));
        units.transfer(admin, 10);
        vm.warp(block.timestamp + 31 days);
        vm.prank(pro);
        units.transfer(admin, 10);
        assertEq(units.balanceOf(pro), 990);
    }

    function test_frozenSender() public {
        units.mint(pro, 1_000);
        comp.setFrozen(pro, true);
        vm.prank(pro);
        vm.expectRevert(abi.encodeWithSelector(YachtUnits.TransferNotCompliant.selector, "SENDER_FROZEN"));
        units.transfer(admin, 1);
    }

    function test_expiredKycBlocksReceive() public {
        vm.warp(block.timestamp + 366 days);
        vm.expectRevert(abi.encodeWithSelector(YachtUnits.TransferNotCompliant.selector, "RECEIVER_NOT_VERIFIED"));
        units.mint(pro, 1);
    }

    function test_forcedTransferBypassesRules() public {
        units.mint(pro, 1_000);
        comp.setFrozen(pro, true);
        units.forcedTransfer(pro, admin, 1_000, keccak256("court-order-17"));
        assertEq(units.balanceOf(admin), 1_000);
    }

    function test_onlyAgentCanForce() public {
        units.mint(pro, 1_000);
        vm.prank(pro);
        vm.expectRevert();
        units.forcedTransfer(pro, pro, 1, bytes32(0));
    }

    function test_pause() public {
        units.mint(pro, 100);
        units.pause();
        vm.prank(pro);
        vm.expectRevert();
        units.transfer(admin, 1);
    }

    function test_maxSupply() public {
        units.mint(admin, 20_000);
        vm.expectRevert(YachtUnits.MaxSupplyExceeded.selector);
        units.mint(admin, 1);
    }

    function test_checkTransferDryRun() public {
        units.mint(admin, 20_000);
        (bool ok, string memory reason) = units.checkTransfer(admin, stranger, 1);
        assertFalse(ok);
        assertEq(reason, "RECEIVER_NOT_VERIFIED");
        (ok,) = units.checkTransfer(admin, retail, 400);
        assertTrue(ok);
    }

    function test_twinIsRegistrarOnlyTransfer() public {
        address owner2 = makeAddr("owner2");
        uint256 id = twin.mint(owner2, "YACHT-000002", keccak256("MT:12"), bytes32(0));
        vm.prank(owner2);
        vm.expectRevert(YachtTwin.TransferRestricted.selector);
        twin.transferFrom(owner2, stranger, id);
        vm.prank(owner2);
        twin.approve(admin, id);
        twin.transferFrom(owner2, stranger, id); // registrar may move it
        assertEq(twin.ownerOf(id), stranger);
    }

    function test_twinRejectsDuplicateYacht() public {
        vm.expectRevert(YachtTwin.DuplicateYacht.selector);
        twin.mint(admin, "YACHT-000001", bytes32(0), bytes32(0));
    }
}
