// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IRandomnessSource} from "../src/IRandomnessSource.sol";
import {StubbyRaffle} from "../src/StubbyRaffle.sol";
import {DevRandomness, DevUsdc} from "./dev/DevContracts.sol";

/// @title The local stack (Section 13.5)
/// @notice Deploys mock USDC, a hand-driven randomness source, the raffle
///         contract and one open raffle, then funds Anvil's default accounts so
///         there is something to click on immediately.
/// @dev Local chains only. It refuses to run anywhere else, because both mock
///      contracts are unsafe by design: anyone can mint the token and the
///      "randomness" is whatever the caller passes in.
///
///     anvil &
///     forge script script/DeployLocal.s.sol:DeployLocal \
///       --rpc-url http://127.0.0.1:8545 --broadcast \
///       --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployLocal is Script {
    /// @dev Anvil's first ten accounts derive from a fixed mnemonic.
    uint256 private constant ANVIL_ACCOUNTS = 10;
    uint256 private constant FAUCET = 10_000e6;

    // The brief's running example: 50 USDC prize, 1 per entry, 70 entries.
    uint256 private constant PRIZE = 50e6;
    uint256 private constant ENTRY_PRICE = 1e6;
    uint32 private constant TOTAL_ENTRIES = 70;
    uint64 private constant WINDOW = 7 days;

    error NotALocalChain(uint256 chainId);

    function run()
        external
        returns (DevUsdc usdc, DevRandomness randomness, StubbyRaffle raffle, uint256 raffleId)
    {
        // Anvil is 31337, Hardhat 1337. Nothing else may run this.
        if (block.chainid != 31_337 && block.chainid != 1337) {
            revert NotALocalChain(block.chainid);
        }

        address deployer = msg.sender;

        vm.startBroadcast();

        usdc = new DevUsdc();

        // The randomness source needs the raffle's address and the raffle needs
        // the source's, so compute the raffle address first.
        address raffleAddress = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        randomness = new DevRandomness(raffleAddress);
        raffle = new StubbyRaffle(usdc, IRandomnessSource(address(randomness)), deployer, deployer);
        require(address(raffle) == raffleAddress, "address prediction failed");

        // Fund Anvil's default accounts and let them spend.
        for (uint32 i; i < ANVIL_ACCOUNTS; ++i) {
            (address account,) =
                deriveRememberKey("test test test test test test test test test test test junk", i);
            usdc.mint(account, FAUCET);
        }

        raffleId = raffle.createRaffle(PRIZE, ENTRY_PRICE, TOTAL_ENTRIES, WINDOW);

        vm.stopBroadcast();

        console2.log("DevUsdc        ", address(usdc));
        console2.log("DevRandomness  ", address(randomness));
        console2.log("StubbyRaffle   ", address(raffle));
        console2.log("open raffle id ", raffleId);
        console2.log("each Anvil account funded with (USDC base units)", FAUCET);
        console2.log("");
        console2.log("Approve, then enter:");
        console2.log("  cast send <usdc> 'approve(address,uint256)' <raffle> <amount>");
        console2.log("  cast send <raffle> 'enter(uint256,uint8)' 1 5");
        console2.log("Fill it to 70 entries and the draw fires. Then settle it:");
        console2.log("  cast send <randomness> 'fulfilLatest()'");
    }
}
