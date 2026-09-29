// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {StubbyRaffle} from "../../src/StubbyRaffle.sol";

/**
 * Open a draw on a test network.
 *
 * For getting a real, enterable raffle in front of the app — the screens that
 * only exist while a draw is open (the hero ticket, the entry dial, the ticket
 * picker) cannot be looked at otherwise, and every visual bug in this project
 * so far was found by looking.
 *
 * **Testnet only.** It signs with `DEV_PRIVATE_KEY`, which owns nothing on
 * mainnet. Mainnet raffles are the platform owner's to create with a hardware
 * wallet or `forge --account`; see docs/mainnet-deploy.md.
 *
 * The key is read from the environment and never passed as an argument, so it
 * is the variable's name that lands in the shell history and in /proc rather
 * than its value (CLAUDE.md).
 *
 * Amounts are the 6-decimal USDC view, like everything else in this project.
 *
 *   PRIZE_USDC=10000000 ENTRY_USDC=1000000 ENTRIES=12 WINDOW_SECONDS=604800 \
 *     forge script script/dev/CreateRaffle.s.sol --rpc-url "$ARC_RPC_URL" --broadcast
 */
contract CreateRaffle is Script {
    function run() external {
        uint256 signer = vm.envUint("DEV_PRIVATE_KEY");
        address raffleAddress = vm.envAddress("EXPO_PUBLIC_RAFFLE_ADDRESS");

        uint256 prize = vm.envOr("PRIZE_USDC", uint256(10_000_000));
        uint256 entryPrice = vm.envOr("ENTRY_USDC", uint256(1_000_000));
        uint32 totalEntries = uint32(vm.envOr("ENTRIES", uint256(12)));
        uint64 windowSeconds = uint64(vm.envOr("WINDOW_SECONDS", uint256(7 days)));

        // The contract enforces this too, and reverts with PotCannotCoverPrize.
        // Saying it here costs nothing and names the two numbers to change.
        uint256 pot = uint256(totalEntries) * entryPrice;
        require(pot >= prize, "entries cannot cover the prize");

        StubbyRaffle raffle = StubbyRaffle(raffleAddress);

        vm.startBroadcast(signer);
        uint256 id = raffle.createRaffle(prize, entryPrice, totalEntries, windowSeconds);
        vm.stopBroadcast();

        console2.log("raffle", id);
        console2.log("  prize (6dp)     ", prize);
        console2.log("  entry (6dp)     ", entryPrice);
        console2.log("  entries         ", totalEntries);
        console2.log("  window (seconds)", windowSeconds);
    }
}
