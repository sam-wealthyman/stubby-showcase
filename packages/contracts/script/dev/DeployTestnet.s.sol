// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {D20RandomnessAdapter} from "../../src/D20RandomnessAdapter.sol";
import {ID20Coordinator} from "../../src/ID20Coordinator.sol";
import {IRandomnessSource} from "../../src/IRandomnessSource.sol";
import {StubbyRaffle} from "../../src/StubbyRaffle.sol";

/**
 * A complete testnet deployment in one run, signed by `DEV_PRIVATE_KEY`:
 * the raffle, its D20 adapter (wired and given a float, or the float of an
 * earlier adapter via `OLD_ADAPTER`), one starter draw,
 * and — when `NEW_OWNER` is set — a nomination of that address as owner, who
 * then accepts from the control room.
 *
 * **Testnet only.** It refuses any other chain. The key is read from the
 * environment, never passed as an argument (CLAUDE.md).
 *
 *   DEV_PRIVATE_KEY=… TREASURY_ADDRESS=0x… NEW_OWNER=0x… \
 *     forge script script/dev/DeployTestnet.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployTestnet is Script {
    uint256 private constant ARC_TESTNET = 5042002;

    function run() external {
        require(block.chainid == ARC_TESTNET, "testnet only");

        uint256 signer = vm.envUint("DEV_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address coordinator = vm.envAddress("VRF_COORDINATOR_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address newOwner = vm.envOr("NEW_OWNER", address(0));
        uint256 float_ = vm.envOr("ADAPTER_FLOAT_WEI", uint256(0.15e18));
        // A previous adapter the dev key still owns: its float moves across.
        address oldAdapter = vm.envOr("OLD_ADAPTER", address(0));
        address dev = vm.addr(signer);

        vm.startBroadcast(signer);

        // The dev key owns both at first, so it can wire them and open a draw.
        StubbyRaffle raffle =
            new StubbyRaffle(IERC20(usdc), IRandomnessSource(coordinator), treasury, dev);
        D20RandomnessAdapter adapter =
            new D20RandomnessAdapter(ID20Coordinator(coordinator), address(raffle), dev);
        if (float_ != 0) {
            (bool funded,) = payable(address(adapter)).call{value: float_}("");
            require(funded, "float transfer failed");
        }
        if (oldAdapter != address(0) && oldAdapter.balance != 0) {
            D20RandomnessAdapter(payable(oldAdapter))
                .withdrawFloat(payable(address(adapter)), oldAdapter.balance);
        }
        raffle.setRandomnessSource(IRandomnessSource(address(adapter)));

        uint256 starter = raffle.createRaffle(50e6, 1e6, 70, 7 days);

        if (newOwner != address(0)) {
            raffle.transferOwnership(newOwner);
            adapter.transferOwnership(newOwner);
        }

        vm.stopBroadcast();

        console2.log("StubbyRaffle        ", address(raffle));
        console2.log("D20RandomnessAdapter", address(adapter));
        console2.log("starter draw        ", starter);
        console2.log("deployed at block   ", block.number);
        console2.log("nominated owner     ", newOwner);
    }
}
