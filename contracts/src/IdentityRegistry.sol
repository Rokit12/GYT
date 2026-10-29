// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title IdentityRegistry
/// @notice Maps investor wallets to verified off-chain identities (KYC done by a provider).
///         No personal data is stored on-chain: only a verification flag, ISO 3166 numeric
///         country code, investor category, expiry, and a hash reference to the KYC record.
contract IdentityRegistry is AccessControl {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    struct Identity {
        bool verified;
        uint16 country; // ISO 3166-1 numeric, e.g. 404 = Kenya, 784 = UAE
        bool professional; // professional / accredited investor
        uint64 expiresAt; // KYC must be refreshed after this time
        bytes32 kycRef; // hash of provider record id; never the documents
    }

    mapping(address => Identity) private _ids;

    event IdentityRegistered(
        address indexed wallet, uint16 country, bool professional, uint64 expiresAt, bytes32 kycRef
    );
    event IdentityRevoked(address indexed wallet);

    error ZeroAddress();
    error ExpiryInPast();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    function register(address wallet, uint16 country, bool professional, uint64 expiresAt, bytes32 kycRef)
        external
        onlyRole(AGENT_ROLE)
    {
        if (wallet == address(0)) revert ZeroAddress();
        if (expiresAt <= block.timestamp) revert ExpiryInPast();
        _ids[wallet] = Identity(true, country, professional, expiresAt, kycRef);
        emit IdentityRegistered(wallet, country, professional, expiresAt, kycRef);
    }

    function revoke(address wallet) external onlyRole(AGENT_ROLE) {
        delete _ids[wallet];
        emit IdentityRevoked(wallet);
    }

    function isVerified(address wallet) public view returns (bool) {
        Identity memory i = _ids[wallet];
        return i.verified && i.expiresAt > block.timestamp;
    }

    function identity(address wallet) external view returns (Identity memory) {
        return _ids[wallet];
    }
}
