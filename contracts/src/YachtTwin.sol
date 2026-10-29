// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title YachtTwin
/// @notice One token per verified physical yacht. The twin points to the official flag
///         registry entry (by hash) and to a Merkle root of its verified documents. It does
///         not replace registration. Only the registrar can move a twin, which happens when
///         the registered owner changes off-chain and has been verified.
contract YachtTwin is ERC721, AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct Twin {
        string yachtId; // canonical platform id, e.g. YACHT-000001
        bytes32 registryRef; // sha256 of flag state + official number
        bytes32 docsRoot; // Merkle root of document hashes
        uint64 updatedAt;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Twin) public twins;
    mapping(bytes32 => uint256) public idByYachtId; // keccak256(yachtId) => tokenId
    string private _base;

    event TwinMinted(uint256 indexed tokenId, string yachtId, bytes32 registryRef, bytes32 docsRoot);
    event DocsUpdated(uint256 indexed tokenId, bytes32 docsRoot);

    error DuplicateYacht();
    error TransferRestricted();

    constructor(address admin, string memory baseURI_) ERC721("GYT Yacht Twin", "GYTT") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        _base = baseURI_;
    }

    function mint(address owner, string calldata yachtId, bytes32 registryRef, bytes32 docsRoot)
        external
        onlyRole(REGISTRAR_ROLE)
        returns (uint256 tokenId)
    {
        bytes32 key = keccak256(bytes(yachtId));
        if (idByYachtId[key] != 0) revert DuplicateYacht();
        tokenId = nextId++;
        twins[tokenId] = Twin(yachtId, registryRef, docsRoot, uint64(block.timestamp));
        idByYachtId[key] = tokenId;
        _safeMint(owner, tokenId);
        emit TwinMinted(tokenId, yachtId, registryRef, docsRoot);
    }

    function updateDocs(uint256 tokenId, bytes32 docsRoot) external onlyRole(REGISTRAR_ROLE) {
        _requireOwned(tokenId);
        twins[tokenId].docsRoot = docsRoot;
        twins[tokenId].updatedAt = uint64(block.timestamp);
        emit DocsUpdated(tokenId, docsRoot);
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && !hasRole(REGISTRAR_ROLE, _msgSender())) {
            revert TransferRestricted();
        }
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
