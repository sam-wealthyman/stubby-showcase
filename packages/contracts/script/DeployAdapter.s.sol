// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {D20RandomnessAdapter} from "../src/D20RandomnessAdapter.sol";
import {ID20Coordinator} from "../src/ID20Coordinator.sol";
import {IRandomnessSource} from "../src/IRandomnessSource.sol";
import {StubbyRaffle} from "../src/StubbyRaffle.sol";

/// @title Deploy the D20DAO randomness adapter and point the raffle at it
/// @notice Deploys the adapter, funds its fee float, and — if the caller owns
///         the raffle — calls `setRandomnessSource`. Draws cannot work until
///         all three have happened.
/// @dev Checks the coordinator responds to the interface we expect *before*
///      deploying, because two documented signatures for it turned out to be
///      wrong (brief Section 11.1) and a silent mismatch here means a raffle
///      that fills and can never draw.
///
///     forge script script/DeployAdapter.s.sol:DeployAdapter \
///       --rpc-url arc_testnet --broadcast
contract DeployAdapter is Script {
    error MissingConfig(string name);
    error NotAContract(string name, address value);
    error CoordinatorDoesNotAnswer(address coordinator);

    function run() external returns (D20RandomnessAdapter adapter) {
        address coordinator = _requireContract("VRF_COORDINATOR_ADDRESS");
        address raffleAddress = _requireContract("RAFFLE_CONTRACT_ADDRESS");
        address owner = _requireAddress("OWNER_ADDRESS");
        // Native 18-decimal units. One request costs about 0.08 USDC, so the
        // default buys roughly 25 draws.
        uint256 float_ = vm.envOr("ADAPTER_FLOAT_WEI", uint256(2e18));

        // Fail here, loudly, rather than after deploying something inert.
        uint256 fee;
        try ID20Coordinator(coordinator).quoteFee(250_000) returns (uint256 quoted) {
            fee = quoted;
        } catch {
            revert CoordinatorDoesNotAnswer(coordinator);
        }

        console2.log("chain id    ", block.chainid);
        console2.log("coordinator ", coordinator);
        console2.log("raffle      ", raffleAddress);
        console2.log("owner       ", owner);
        console2.log("fee quote (native wei)", fee);
        console2.log("float     (native wei)", float_);

        vm.startBroadcast();

        adapter = new D20RandomnessAdapter(ID20Coordinator(coordinator), raffleAddress, owner);

        if (float_ > 0) {
            (bool funded,) = payable(address(adapter)).call{value: float_}("");
            require(funded, "float transfer failed");
        }

        StubbyRaffle raffle = StubbyRaffle(raffleAddress);
        bool wired = false;
        if (raffle.owner() == msg.sender) {
            raffle.setRandomnessSource(IRandomnessSource(address(adapter)));
            wired = true;
        }

        vm.stopBroadcast();

        console2.log("D20RandomnessAdapter", address(adapter));
        console2.log("requests affordable ", adapter.requestsAffordable());
        if (wired && address(raffle.randomness()) == address(adapter)) {
            console2.log("raffle now points at the adapter");
        } else if (wired) {
            // A raffle exists, so the swap waits RANDOMNESS_SOURCE_DELAY in public.
            console2.log("scheduled: anyone may call activateRandomnessSource() on the raffle at");
            console2.log(raffle.pendingRandomnessAt());
        } else {
            console2.log("NOT wired: the raffle is owned by someone else. The owner must call");
            console2.log("setRandomnessSource with the adapter address above.");
        }
    }

    function _requireAddress(string memory name) private view returns (address value) {
        value = vm.envOr(name, address(0));
        if (value == address(0)) revert MissingConfig(name);
    }

    function _requireContract(string memory name) private view returns (address value) {
        value = _requireAddress(name);
        if (value.code.length == 0) revert NotAContract(name, value);
    }
}
