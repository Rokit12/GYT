// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only Merkle builder mirroring api/app/proof.py.
library MerkleHelper {
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory lvl = leaves;
        while (lvl.length > 1) lvl = _next(lvl);
        return lvl[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        uint256 depth;
        for (uint256 n = leaves.length; n > 1; n = (n + 1) / 2) depth++;
        out = new bytes32[](depth);
        bytes32[] memory lvl = leaves;
        for (uint256 d = 0; d < depth; d++) {
            uint256 sib = index ^ 1;
            out[d] = sib < lvl.length ? lvl[sib] : lvl[index];
            lvl = _next(lvl);
            index >>= 1;
        }
    }

    function _next(bytes32[] memory lvl) private pure returns (bytes32[] memory nxt) {
        nxt = new bytes32[]((lvl.length + 1) / 2);
        for (uint256 i = 0; i < lvl.length; i += 2) {
            bytes32 r = i + 1 < lvl.length ? lvl[i + 1] : lvl[i];
            nxt[i / 2] = sha256(abi.encodePacked(lvl[i], r));
        }
    }
}
