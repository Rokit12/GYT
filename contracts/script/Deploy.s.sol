// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {Compliance} from "../src/Compliance.sol";
import {YachtUnits} from "../src/YachtUnits.sol";
import {YachtTwin} from "../src/YachtTwin.sol";
import {ProofRegistry} from "../src/ProofRegistry.sol";
import {ArrivalEscrow} from "../src/ArrivalEscrow.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";

/// Local / testnet deployment of the full GYT contract set plus one sample yacht SPV.
/// forge script script/Deploy.s.sol --rpc-url $CHAIN_RPC --private-key $DEPLOYER_KEY --broadcast
contract Deploy is Script {
    function run() external {
        address admin = vm.envOr("ADMIN_ADDRESS", msg.sender);
        vm.startBroadcast();

        IdentityRegistry reg = new IdentityRegistry(admin);
        YachtTwin twin = new YachtTwin(admin, vm.envOr("TWIN_BASE_URI", string("http://localhost:8000/twins/")));
        ProofRegistry proofs = new ProofRegistry(admin);
        address payToken = vm.envOr("PAY_TOKEN", address(0));
        if (payToken == address(0)) payToken = address(new MockUSD());
        ArrivalEscrow escrow = new ArrivalEscrow(MockUSD(payToken), proofs, admin);

        // Sample SPV: Azure Meridian, 20,000 units, UAE + Kenya investors allowed.
        uint256 twinId = twin.mint(admin, "YACHT-000001", sha256("KY|741234"), bytes32(0));
        Compliance comp = new Compliance(reg, admin);
        YachtUnits units = new YachtUnits("Azure Meridian Units", "AZM", twinId, 20_000, comp, admin);
        comp.bindToken(address(units));
        comp.setCountry(784, true);
        comp.setCountry(404, true);

        vm.stopBroadcast();

        console2.log("IDENTITY_REGISTRY=%s", address(reg));
        console2.log("YACHT_TWIN=%s", address(twin));
        console2.log("PROOF_REGISTRY=%s", address(proofs));
        console2.log("ARRIVAL_ESCROW=%s", address(escrow));
        console2.log("PAY_TOKEN=%s", payToken);
        console2.log("SAMPLE_COMPLIANCE=%s", address(comp));
        console2.log("SAMPLE_UNITS=%s", address(units));
    }
}
