// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @title MockERC7984
/// @notice A minimal, mintable confidential token used ONLY for local Hardhat
///         mock-mode tests. On Sepolia, Hushpot points at the official cUSDT
///         wrapper instead. This contract is never deployed to production.
contract MockERC7984 is ERC7984, ZamaEthereumConfig {
    constructor(
        string memory name_,
        string memory symbol_,
        string memory uri_
    ) ERC7984(name_, symbol_, uri_) {}

    /// @dev Confidential token decimals. cUSDT uses 6.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint a confidential balance to `to` from an encrypted input.
    /// @dev Test-only faucet. Grants the recipient ACL access to its own balance.
    function mint(address to, externalEuint64 encAmount, bytes calldata proof) external {
        euint64 amount = FHE.fromExternal(encAmount, proof);
        _mint(to, amount);
    }
}
