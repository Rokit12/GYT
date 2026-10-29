// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Compliance} from "./Compliance.sol";

/// @title YachtUnits
/// @notice Permissioned economic units of one yacht SPV. Every mint and transfer is checked
///         by the Compliance contract before balances change. Units are whole numbers
///         (decimals = 0). Agents can pause, and can force a transfer for court orders or
///         lost-wallet recovery, as ERC-3643 allows.
contract YachtUnits is ERC20, AccessControl, Pausable {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    Compliance public immutable compliance;
    uint256 public immutable twinId; // YachtTwin token id of the underlying vessel
    uint256 public immutable maxSupply;

    bool private _forced;

    event ForcedTransfer(address indexed from, address indexed to, uint256 amount, bytes32 reasonRef);

    error TransferNotCompliant(string reason);
    error MaxSupplyExceeded();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 twinId_,
        uint256 maxSupply_,
        Compliance compliance_,
        address admin
    ) ERC20(name_, symbol_) {
        twinId = twinId_;
        maxSupply = maxSupply_;
        compliance = compliance_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external onlyRole(AGENT_ROLE) {
        if (totalSupply() + amount > maxSupply) revert MaxSupplyExceeded();
        _mint(to, amount);
    }

    function forcedTransfer(address from, address to, uint256 amount, bytes32 reasonRef)
        external
        onlyRole(AGENT_ROLE)
    {
        _forced = true;
        _transfer(from, to, amount);
        _forced = false;
        emit ForcedTransfer(from, to, amount, reasonRef);
    }

    function pause() external onlyRole(AGENT_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(AGENT_ROLE) {
        _unpause();
    }

    /// @notice Dry-run used by the API before a user signs anything.
    function checkTransfer(address from, address to, uint256 amount)
        external
        view
        returns (bool ok, string memory reason)
    {
        if (paused()) return (false, "PAUSED");
        if (balanceOf(from) < amount) return (false, "INSUFFICIENT_BALANCE");
        return compliance.canTransfer(from, to, amount, balanceOf(to) + amount, totalSupply());
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!_forced) {
            _requireNotPaused();
            uint256 toAfter = to == address(0) ? 0 : balanceOf(to) + value;
            uint256 supplyAfter = from == address(0) ? totalSupply() + value : totalSupply();
            if (to == address(0)) supplyAfter = totalSupply() - value;
            (bool ok, string memory reason) = compliance.canTransfer(from, to, value, toAfter, supplyAfter);
            if (!ok) revert TransferNotCompliant(reason);
        }
        super._update(from, to, value);
    }
}
