// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ProofRegistry} from "./ProofRegistry.sol";

/// @title ArrivalEscrow
/// @notice Holds payment for a berth booking or a Use-or-Earn credit stay until the yacht's
///         arrival is proven. The fusion service (AIS + signed GPS + satellite SAR) writes an
///         arrival leaf into an anchored batch; release() checks that exact leaf against the
///         ProofRegistry and pays out the agreed split. If no proof arrives before the
///         deadline, the payer can take the money back.
///
///         Arrival leaf = sha256(bookingRef || twinId || marinaId || fusionDigest)
///         fusionDigest = sha256 of the fused AIS/GPS/SAR observation record (kept off-chain)
contract ArrivalEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    uint16 internal constant BPS = 10_000;
    uint256 public constant MAX_SPLITS = 8;

    enum Status {
        None,
        Funded,
        Released,
        Refunded
    }

    struct Split {
        address to;
        uint16 bps;
    }

    struct Booking {
        address payer;
        uint256 amount;
        uint256 twinId;
        bytes32 marinaId;
        uint64 refundAfter;
        Status status;
        bytes32 arrivalLeaf;
    }

    IERC20 public immutable payToken;
    ProofRegistry public immutable proofs;

    mapping(bytes32 => Booking) public bookings;
    mapping(bytes32 => Split[]) private _splits;

    event Funded(bytes32 indexed ref, address indexed payer, uint256 amount, uint256 twinId, bytes32 marinaId);
    event Released(bytes32 indexed ref, bytes32 arrivalLeaf, uint256 anchorIndex);
    event Refunded(bytes32 indexed ref, address indexed payer, uint256 amount);

    error BookingExists();
    error NotFunded();
    error BadSplits();
    error ZeroAmount();
    error ProofInvalid();
    error TooEarly();
    error NotPayer();

    constructor(IERC20 payToken_, ProofRegistry proofs_, address admin) {
        payToken = payToken_;
        proofs = proofs_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, admin);
    }

    function fund(
        bytes32 ref,
        uint256 amount,
        uint256 twinId,
        bytes32 marinaId,
        uint64 refundAfter,
        Split[] calldata splits
    ) external nonReentrant {
        if (bookings[ref].status != Status.None) revert BookingExists();
        if (amount == 0) revert ZeroAmount();
        if (splits.length == 0 || splits.length > MAX_SPLITS) revert BadSplits();
        uint256 total;
        for (uint256 i = 0; i < splits.length; i++) {
            if (splits[i].to == address(0)) revert BadSplits();
            total += splits[i].bps;
            _splits[ref].push(splits[i]);
        }
        if (total != BPS) revert BadSplits();

        bookings[ref] = Booking(msg.sender, amount, twinId, marinaId, refundAfter, Status.Funded, bytes32(0));
        payToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(ref, msg.sender, amount, twinId, marinaId);
    }

    function arrivalLeaf(bytes32 ref, uint256 twinId, bytes32 marinaId, bytes32 fusionDigest)
        public
        pure
        returns (bytes32)
    {
        return sha256(abi.encodePacked(ref, twinId, marinaId, fusionDigest));
    }

    function release(
        bytes32 ref,
        bytes32 fusionDigest,
        bytes32[] calldata proof,
        uint256 leafIndex,
        uint256 anchorIndex
    ) external onlyRole(ORACLE_ROLE) nonReentrant {
        Booking storage b = bookings[ref];
        if (b.status != Status.Funded) revert NotFunded();
        bytes32 leaf = arrivalLeaf(ref, b.twinId, b.marinaId, fusionDigest);
        if (!proofs.verify(leaf, proof, leafIndex, anchorIndex)) revert ProofInvalid();

        b.status = Status.Released;
        b.arrivalLeaf = leaf;

        Split[] storage s = _splits[ref];
        uint256 paid;
        for (uint256 i = 0; i < s.length; i++) {
            uint256 part = i == s.length - 1 ? b.amount - paid : (b.amount * s[i].bps) / BPS;
            paid += part;
            payToken.safeTransfer(s[i].to, part);
        }
        emit Released(ref, leaf, anchorIndex);
    }

    function refund(bytes32 ref) external nonReentrant {
        Booking storage b = bookings[ref];
        if (b.status != Status.Funded) revert NotFunded();
        if (block.timestamp <= b.refundAfter) revert TooEarly();
        if (msg.sender != b.payer && !hasRole(ORACLE_ROLE, msg.sender)) revert NotPayer();
        b.status = Status.Refunded;
        payToken.safeTransfer(b.payer, b.amount);
        emit Refunded(ref, b.payer, b.amount);
    }

    function splitsOf(bytes32 ref) external view returns (Split[] memory) {
        return _splits[ref];
    }
}
