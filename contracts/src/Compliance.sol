// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title Compliance
/// @notice Transfer rules for one YachtUnits token (one yacht SPV). Inspired by ERC-3643
///         modular compliance, reduced to the rules GYT needs on day one:
///         frozen wallets, verified identity, country allowlist, holding caps by investor
///         category, and a lock-up after issuance.
contract Compliance is AccessControl {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    uint16 internal constant BPS = 10_000;

    IdentityRegistry public immutable registry;
    address public token;

    mapping(uint16 => bool) public countryAllowed;
    mapping(address => bool) public frozen;
    uint16 public professionalMaxBps = 2_500; // 25% of supply per professional holder
    uint16 public retailMaxBps = 200; // 2% of supply per retail holder
    uint64 public lockupUntil; // secondary transfers blocked until this time

    event TokenBound(address token);
    event CountrySet(uint16 country, bool allowed);
    event CapsSet(uint16 professionalMaxBps, uint16 retailMaxBps);
    event LockupSet(uint64 until);
    event FrozenSet(address wallet, bool frozen);

    error AlreadyBound();
    error InvalidCaps();

    constructor(IdentityRegistry registry_, address admin) {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    function bindToken(address token_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token != address(0)) revert AlreadyBound();
        token = token_;
        emit TokenBound(token_);
    }

    function setCountry(uint16 country, bool allowed) external onlyRole(AGENT_ROLE) {
        countryAllowed[country] = allowed;
        emit CountrySet(country, allowed);
    }

    function setCaps(uint16 professionalMaxBps_, uint16 retailMaxBps_) external onlyRole(AGENT_ROLE) {
        if (professionalMaxBps_ > BPS || retailMaxBps_ > professionalMaxBps_) revert InvalidCaps();
        professionalMaxBps = professionalMaxBps_;
        retailMaxBps = retailMaxBps_;
        emit CapsSet(professionalMaxBps_, retailMaxBps_);
    }

    function setLockup(uint64 until) external onlyRole(AGENT_ROLE) {
        lockupUntil = until;
        emit LockupSet(until);
    }

    function setFrozen(address wallet, bool isFrozen) external onlyRole(AGENT_ROLE) {
        frozen[wallet] = isFrozen;
        emit FrozenSet(wallet, isFrozen);
    }

    /// @param from sender (zero for mint)
    /// @param to receiver (zero for burn)
    /// @param toBalanceAfter receiver balance after the transfer
    /// @param supplyAfter total supply after the transfer
    /// @return ok whether the transfer is allowed
    /// @return reason short machine-readable reason when not allowed
    function canTransfer(address from, address to, uint256, uint256 toBalanceAfter, uint256 supplyAfter)
        external
        view
        returns (bool ok, string memory reason)
    {
        if (from != address(0)) {
            if (frozen[from]) return (false, "SENDER_FROZEN");
            if (block.timestamp < lockupUntil) return (false, "LOCKUP");
        }
        if (to == address(0)) return (true, "");
        if (frozen[to]) return (false, "RECEIVER_FROZEN");
        if (!registry.isVerified(to)) return (false, "RECEIVER_NOT_VERIFIED");

        IdentityRegistry.Identity memory id = registry.identity(to);
        if (!countryAllowed[id.country]) return (false, "COUNTRY_NOT_ALLOWED");

        uint256 cap = id.professional ? professionalMaxBps : retailMaxBps;
        if (supplyAfter > 0 && toBalanceAfter * BPS > cap * supplyAfter) return (false, "HOLDING_CAP");
        return (true, "");
    }
}
