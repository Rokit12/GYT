// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ProofRegistry
/// @notice Append-only registry of Merkle roots. Each root commits to a batch of yacht and
///         marina events (positions, check-ins, inspections, documents) hashed off-chain.
///
///         Tree rules (must match api/app/proof.py and web/lib/merkle.ts):
///           leaf   = sha256(event bytes)
///           parent = sha256(left || right)          (ordered, not sorted)
///           an odd node at the end of a level is paired with itself
contract ProofRegistry is AccessControl {
    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");

    struct Anchor {
        bytes32 root;
        uint32 leafCount;
        uint64 fromTs; // first event timestamp in the batch
        uint64 toTs; // last event timestamp in the batch
        uint64 anchoredAt;
    }

    Anchor[] private _anchors;
    mapping(bytes32 => uint256) public indexOfRootPlusOne;

    event Anchored(uint256 indexed index, bytes32 indexed root, uint32 leafCount, uint64 fromTs, uint64 toTs);

    error EmptyRoot();
    error EmptyBatch();
    error AlreadyAnchored();
    error BadRange();
    error UnknownAnchor();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHOR_ROLE, admin);
    }

    function anchor(bytes32 root, uint32 leafCount, uint64 fromTs, uint64 toTs)
        external
        onlyRole(ANCHOR_ROLE)
        returns (uint256 index)
    {
        if (root == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert EmptyBatch();
        if (fromTs > toTs) revert BadRange();
        if (indexOfRootPlusOne[root] != 0) revert AlreadyAnchored();
        index = _anchors.length;
        _anchors.push(Anchor(root, leafCount, fromTs, toTs, uint64(block.timestamp)));
        indexOfRootPlusOne[root] = index + 1;
        emit Anchored(index, root, leafCount, fromTs, toTs);
    }

    function anchorCount() external view returns (uint256) {
        return _anchors.length;
    }

    function getAnchor(uint256 index) external view returns (Anchor memory) {
        if (index >= _anchors.length) revert UnknownAnchor();
        return _anchors[index];
    }

    /// @param leaf the event hash
    /// @param proof sibling hashes from the leaf level upwards
    /// @param leafIndex position of the leaf in the batch (bit i chooses left/right at level i)
    /// @param anchorIndex which anchored batch to check against
    function verify(bytes32 leaf, bytes32[] calldata proof, uint256 leafIndex, uint256 anchorIndex)
        public
        view
        returns (bool)
    {
        if (anchorIndex >= _anchors.length) return false;
        Anchor memory a = _anchors[anchorIndex];
        if (leafIndex >= a.leafCount) return false;
        return computeRoot(leaf, proof, leafIndex) == a.root;
    }

    function computeRoot(bytes32 leaf, bytes32[] calldata proof, uint256 leafIndex)
        public
        pure
        returns (bytes32 h)
    {
        h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            h = (leafIndex & 1) == 1 ? sha256(abi.encodePacked(proof[i], h)) : sha256(abi.encodePacked(h, proof[i]));
            leafIndex >>= 1;
        }
    }
}
