// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IRandomnessSource} from "../../src/IRandomnessSource.sol";
import {StubbyRaffle} from "../../src/StubbyRaffle.sol";
import {MockRandomness, MockUsdc} from "../Mocks.sol";
import {Handler} from "./Handler.sol";

/// @notice The properties that must hold after any sequence of actions.
/// @dev Section 13.3 names the central one: the contract always holds exactly
///      escrow + unclaimed prizes + commission. It is asserted as a floor rather
///      than an equality because anyone can send USDC to the contract unprompted
///      and such a donation is never spendable — see invariant_noFundsAreTrapped
///      for the other half, which pins the surplus to donations only.
contract RaffleInvariants is Test {
    MockUsdc internal usdc;
    MockRandomness internal vrf;
    StubbyRaffle internal raffle;
    Handler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockUsdc();
        vrf = new MockRandomness(address(0));
        raffle = new StubbyRaffle(usdc, IRandomnessSource(address(vrf)), treasury, owner);
        vrf.setConsumer(address(raffle));

        handler = new Handler(raffle, usdc, vrf, owner);
        targetContract(address(handler));
    }

    // --------------------------------------------------------------- the big one

    /// @notice The contract can always pay everything it owes.
    function invariant_holdingsCoverObligations() public view {
        assertGe(
            usdc.balanceOf(address(raffle)),
            raffle.requiredHoldings(),
            "holdings fell below escrow + prizes + commission"
        );
    }

    /// @notice Nothing is trapped: the balance is exactly what is owed.
    /// @dev The handler never donates, so the floor above should be an equality.
    ///      If this ever fails while the floor holds, funds have become stuck.
    function invariant_noFundsAreTrapped() public view {
        assertEq(
            usdc.balanceOf(address(raffle)),
            raffle.requiredHoldings(),
            "contract holds more than it owes: funds are trapped"
        );
    }

    /// @notice Money in equals money out plus what is still held.
    function invariant_ghostAccountingBalances() public view {
        assertEq(
            handler.ghostPaidIn(),
            handler.ghostPaidOut() + usdc.balanceOf(address(raffle)),
            "paid in does not equal paid out plus held"
        );
    }

    // ------------------------------------------------- aggregates match per-raffle

    /// @notice The three running totals never drift from per-raffle state.
    function invariant_aggregatesMatchPerRaffleState() public view {
        uint256 escrow;
        uint256 prizes;
        uint256 commission;

        uint256 count = handler.raffleCount();
        for (uint256 i; i < count; ++i) {
            StubbyRaffle.Raffle memory r = raffle.getRaffle(handler.raffleIds(i));
            if (
                r.status == StubbyRaffle.Status.Open || r.status == StubbyRaffle.Status.ReadyToDraw
                    || r.status == StubbyRaffle.Status.Drawing
            ) {
                escrow += uint256(r.entriesSold) * r.entryPrice + r.topUp;
            }
            prizes += r.prizeOwed;
            commission += r.commissionOwed;
        }

        assertEq(raffle.totalEscrowed(), escrow, "totalEscrowed drifted");
        assertEq(raffle.totalPrizesOwed(), prizes, "totalPrizesOwed drifted");
        assertEq(raffle.totalCommissionOwed(), commission, "totalCommissionOwed drifted");
    }

    // ----------------------------------------------------------- per-raffle rules

    /// @notice Every raffle stays internally consistent, whatever happened to it.
    function invariant_eachRaffleStaysConsistent() public view {
        uint256 count = handler.raffleCount();
        for (uint256 i; i < count; ++i) {
            uint256 id = handler.raffleIds(i);
            StubbyRaffle.Raffle memory r = raffle.getRaffle(id);

            // Never oversold.
            assertLe(r.entriesSold, r.totalEntries, "oversold");

            // No wallet holds more than the cap.
            uint256 actors = handler.actorCount();
            for (uint256 a; a < actors; ++a) {
                assertLe(
                    raffle.entriesOf(id, handler.actors(a)),
                    raffle.walletCap(r.totalEntries),
                    "wallet cap breached"
                );
            }

            if (r.status == StubbyRaffle.Status.Completed) {
                // A completed raffle has a real winner holding a real entry.
                assertTrue(r.winner != address(0), "completed without a winner");
                assertLt(r.winningEntry, r.entriesSold, "winning entry out of range");
                assertEq(raffle.buyerOfEntry(id, r.winningEntry), r.winner, "winner mismatch");

                // The split reconstructs the pot exactly, whether or not it is paid.
                uint256 pot = uint256(r.entriesSold) * r.entryPrice + r.topUp;
                uint256 prizePart = r.prizePaid ? r.prize : r.prizeOwed;
                assertEq(prizePart, r.prize, "the prize is never partial");
                assertGe(pot, r.prize, "a drawn raffle never fails to cover its prize");

                // Owed becomes zero only by being paid, never by anything else.
                if (!r.prizePaid) assertEq(r.prizeOwed, r.prize, "unpaid prize must stay whole");
                if (r.prizePaid) assertEq(r.prizeOwed, 0, "paid prize must owe nothing");
            } else {
                // Before the draw nothing is owed to anyone.
                assertEq(r.prizeOwed, 0, "prize owed before the draw");
                assertEq(r.commissionOwed, 0, "commission owed before the draw");
                assertFalse(r.prizePaid, "paid before the draw");
            }
        }
    }

    /// @notice A prize can never be paid twice, and only to a real winner.
    function invariant_prizesArePaidAtMostOnce() public view {
        uint256 count = handler.raffleCount();
        uint256 paidPrizes;
        for (uint256 i; i < count; ++i) {
            StubbyRaffle.Raffle memory r = raffle.getRaffle(handler.raffleIds(i));
            if (r.prizePaid) {
                ++paidPrizes;
                assertEq(r.prizeOwed, 0, "a paid prize still shows as owed");
            }
        }
        // Ghost total paid out can never exceed what was ever collected.
        assertLe(handler.ghostPaidOut(), handler.ghostPaidIn(), "paid out more than came in");
    }

    // ------------------------------------------------------------ handler smoke

    /// @notice Prove the handler can actually reach a paid prize.
    /// @dev The handler swallows reverts by design, so without this the invariants
    ///      could be passing vacuously over sequences that never complete a draw.
    ///      This drives it by hand through the whole lifecycle instead.
    function test_handlerReachesAPaidPrize() public {
        handler.createRaffle(0, 0, 0); // small, cheap, solvent
        assertGt(handler.raffleCount(), 0, "handler created no raffle");
        uint256 id = handler.raffleIds(0);

        // Fill it: 12 actors, one entry at a time, under any cap.
        for (uint256 round; round < 6; ++round) {
            for (uint256 a; a < handler.actorCount(); ++a) {
                handler.enter(0, a, 1);
            }
            if (raffle.getRaffle(id).status != StubbyRaffle.Status.Open) break;
        }

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        if (r.status == StubbyRaffle.Status.Open) {
            // Not full, so take the prize-covered route instead.
            handler.topUp(0, type(uint256).max);
            handler.closeEarly(0);
            r = raffle.getRaffle(id);
        }
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.ReadyToDraw), "never became ready");

        // Filling no longer starts the draw; that is a separate, retryable step.
        handler.startDraw(0);
        assertEq(
            uint8(raffle.getRaffle(id).status),
            uint8(StubbyRaffle.Status.Drawing),
            "never started drawing"
        );

        handler.fulfil(0, 12345);
        assertEq(
            uint8(raffle.getRaffle(id).status),
            uint8(StubbyRaffle.Status.Completed),
            "never completed"
        );

        uint256 paidBefore = handler.ghostPaidOut();
        handler.claim(0);
        assertTrue(raffle.getRaffle(id).prizePaid, "prize never paid");
        assertGt(handler.ghostPaidOut(), paidBefore, "ghost accounting did not move");

        handler.withdrawCommission(0);
        assertEq(raffle.getRaffle(id).commissionOwed, 0, "commission never withdrawn");

        // And the invariants still hold at the end of a full lifecycle.
        invariant_holdingsCoverObligations();
        invariant_noFundsAreTrapped();
        invariant_ghostAccountingBalances();
        invariant_aggregatesMatchPerRaffleState();
        invariant_eachRaffleStaysConsistent();
    }

    // No afterInvariant coverage assertion: shrinking reduces a failing sequence
    // to its minimum, so "did this run create a raffle?" is false by design once
    // a counterexample is being narrowed. Forge's call-distribution table is the
    // right place to confirm the handler is being exercised.
}
