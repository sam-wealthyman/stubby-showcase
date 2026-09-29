// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IRandomnessSource} from "../src/IRandomnessSource.sol";
import {StubbyRaffle} from "../src/StubbyRaffle.sol";

/// @title Deploy StubbyRaffle against real USDC and a real randomness source
/// @notice Testnet and mainnet. Every address comes from the environment and is
///         checked before anything is broadcast, so a missing variable fails
///         immediately rather than deploying something half-configured
///         (Section 13.4: validated configuration, fail fast).
/// @dev Mainnet deploys only from a tagged, audited release (Section 13.5).
///
///     forge script script/Deploy.s.sol:Deploy \
///       --rpc-url "$ARC_RPC_URL" --broadcast --verify
contract Deploy is Script {
    error MissingConfig(string name);
    error NotAContract(string name, address value);

    function run() external returns (StubbyRaffle raffle) {
        address usdc = _requireContract("USDC_ADDRESS");
        address randomness = _requireContract("VRF_COORDINATOR_ADDRESS");
        address treasury = _requireAddress("TREASURY_ADDRESS");
        address owner = _requireAddress("OWNER_ADDRESS");

        console2.log("chain id     ", block.chainid);
        console2.log("usdc         ", usdc);
        console2.log("randomness   ", randomness);
        console2.log("treasury     ", treasury);
        console2.log("owner        ", owner);

        vm.startBroadcast();
        raffle = new StubbyRaffle(IERC20(usdc), IRandomnessSource(randomness), treasury, owner);
        vm.stopBroadcast();

        console2.log("StubbyRaffle ", address(raffle));

        // Probe, do not assume. A coordinator that does not implement our
        // interface must not take the deployment down with it — and the real
        // D20DAO coordinator does not, which is why an adapter is required.
        try IRandomnessSource(randomness).requestFee() returns (uint256 fee) {
            console2.log("randomness fee (USDC base units)", fee);
        } catch {
            console2.log("WARNING: the randomness source does not implement");
            console2.log("IRandomnessSource. Draws will revert until an adapter");
            console2.log("is deployed and set with setRandomnessSource.");
        }
    }

    function _requireAddress(string memory name) private view returns (address value) {
        value = vm.envOr(name, address(0));
        if (value == address(0)) revert MissingConfig(name);
    }

    /// @dev USDC and the randomness source must already exist on this chain.
    ///      Catches the classic mistake of pointing a testnet deploy at a
    ///      mainnet address, where the call would succeed and the contract
    ///      would be permanently useless.
    function _requireContract(string memory name) private view returns (address value) {
        value = _requireAddress(name);
        if (value.code.length == 0) revert NotAContract(name, value);
    }
}
