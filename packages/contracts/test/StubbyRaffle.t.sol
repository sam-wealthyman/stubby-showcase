// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {IRandomnessSource} from "../src/IRandomnessSource.sol";
import {StubbyRaffle} from "../src/StubbyRaffle.sol";
import {MockRandomness, MockUsdc, RejectingTreasury} from "./Mocks.sol";

contract StubbyRaffleTest is Test {
    MockUsdc internal usdc;
    MockRandomness internal vrf;
    StubbyRaffle internal raffle;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // The brief's running example: 50 USDC prize, 1 per entry, 70 entries.
    uint256 internal constant PRIZE = 50e6;
    uint256 internal constant ENTRY = 1e6;
    uint32 internal constant TOTAL = 70;
    uint64 internal constant WINDOW = 7 days;

    function setUp() public {
        usdc = new MockUsdc();
        vrf = new MockRandomness(address(0));
        raffle = new StubbyRaffle(usdc, IRandomnessSource(address(vrf)), treasury, owner);
        vrf.setConsumer(address(raffle));

        for (uint160 i = 1; i <= 40; ++i) {
            address wallet = address(i + 0x1000);
            usdc.mint(wallet, 1_000e6);
            vm.prank(wallet);
            usdc.approve(address(raffle), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) {
            address wallet = [alice, bob, carol][i];
            usdc.mint(wallet, 1_000e6);
            vm.prank(wallet);
            usdc.approve(address(raffle), type(uint256).max);
        }
        usdc.mint(owner, 1_000e6);
        vm.prank(owner);
        usdc.approve(address(raffle), type(uint256).max);
    }

    // ------------------------------------------------------------- helpers

    function _create() internal returns (uint256 id) {
        vm.prank(owner);
        id = raffle.createRaffle(PRIZE, ENTRY, TOTAL, WINDOW);
    }

    function _enter(uint256 id, address wallet, uint8 count) internal {
        vm.prank(wallet);
        raffle.enter(id, count);
    }

    /// @dev Fill a raffle to `target` entries using fresh wallets, 5 at a time.
    function _fillTo(uint256 id, uint32 target) internal {
        uint160 seed = 0x1000 + 1;
        while (raffle.getRaffle(id).entriesSold < target) {
            uint32 left = target - raffle.getRaffle(id).entriesSold;
            uint8 take = left > 5 ? 5 : uint8(left);
            _enter(id, address(seed), take);
            ++seed;
        }
    }

    /// @dev Filling no longer starts the draw, so most tests want both steps.
    function _fillAndStartDraw(uint256 id) internal {
        _fillTo(id, TOTAL);
        raffle.startDraw(id);
    }

    function _assertHoldings() internal view {
        assertGe(
            usdc.balanceOf(address(raffle)),
            raffle.requiredHoldings(),
            "contract holds less than escrow + prizes + commission"
        );
    }

    // ------------------------------------------------------------- creation

    function test_create_setsUpTheRaffle() public {
        uint256 id = _create();
        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);

        assertEq(r.prize, PRIZE);
        assertEq(r.entryPrice, ENTRY);
        assertEq(r.totalEntries, TOTAL);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Open));
        assertEq(r.windowEnds, uint64(block.timestamp) + WINDOW);
    }

    function test_create_rejectsAPotThatCannotCoverThePrize() public {
        // 40 entries at 1 USDC cannot pay a 50 USDC prize.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StubbyRaffle.PotCannotCoverPrize.selector, 40e6, PRIZE)
        );
        raffle.createRaffle(PRIZE, ENTRY, 40, WINDOW);
    }

    function test_create_refusesAPrizeUnderTenUsdc() public {
        vm.prank(owner);
        vm.expectRevert(StubbyRaffle.InvalidPrize.selector);
        raffle.createRaffle(10e6 - 1, ENTRY, TOTAL, WINDOW);

        vm.prank(owner);
        raffle.createRaffle(10e6, ENTRY, TOTAL, WINDOW);
    }

    function test_update_refusesAPrizeUnderTenUsdc() public {
        uint256 id = _create();
        vm.prank(owner);
        vm.expectRevert(StubbyRaffle.InvalidPrize.selector);
        raffle.updateRaffle(id, 5e6, ENTRY, TOTAL, WINDOW);
    }

    function test_walletCap_isAQuarterOfTheDrawAtMostFive() public view {
        assertEq(raffle.walletCap(1), 1);
        assertEq(raffle.walletCap(4), 1);
        assertEq(raffle.walletCap(10), 2);
        assertEq(raffle.walletCap(12), 3);
        assertEq(raffle.walletCap(16), 4);
        assertEq(raffle.walletCap(20), 5);
        assertEq(raffle.walletCap(10_000), 5);
    }

    function test_enter_smallDrawCapsAWalletAtAQuarter() public {
        vm.prank(owner);
        uint256 id = raffle.createRaffle(10e6, ENTRY, 10, WINDOW);
        _enter(id, alice, 2);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.WalletCapReached.selector, id, 2, 1));
        raffle.enter(id, 1);
    }

    function test_create_isOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        raffle.createRaffle(PRIZE, ENTRY, TOTAL, WINDOW);
    }

    function test_create_allowsZeroRoi() public {
        // Exactly covering the prize is legal: Section 11.8 puts the ROI floor at 0.
        vm.prank(owner);
        uint256 id = raffle.createRaffle(PRIZE, ENTRY, 50, WINDOW);
        assertEq(raffle.getRaffle(id).totalEntries, 50);
    }

    // ------------------------------------------------------ edit and cancel

    function test_update_changesTheTermsAndRestartsTheWindow() public {
        uint256 id = _create();
        vm.warp(vm.getBlockTimestamp() + 2 days);

        vm.prank(owner);
        raffle.updateRaffle(id, 20e6, 5e5, 60, 3 days);

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertEq(r.prize, 20e6);
        assertEq(r.entryPrice, 5e5);
        assertEq(r.totalEntries, 60);
        assertEq(r.windowSeconds, 3 days);
        assertEq(r.windowEnds, uint64(vm.getBlockTimestamp()) + 3 days);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Open));
    }

    function test_update_keepsTheSolvencyRule() public {
        uint256 id = _create();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StubbyRaffle.PotCannotCoverPrize.selector, 40e6, PRIZE)
        );
        raffle.updateRaffle(id, PRIZE, ENTRY, 40, WINDOW);
    }

    function test_update_refusesOnceAnEntryIsSold() public {
        uint256 id = _create();
        _enter(id, alice, 1);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.AlreadyStarted.selector, id, 1));
        raffle.updateRaffle(id, PRIZE, ENTRY, TOTAL, WINDOW);
    }

    function test_update_isOwnerOnly() public {
        uint256 id = _create();
        vm.prank(alice);
        vm.expectRevert();
        raffle.updateRaffle(id, PRIZE, ENTRY, TOTAL, WINDOW);
    }

    function test_cancel_endsTheRaffleAndReturnsTheTopUp() public {
        uint256 id = _create();
        vm.prank(owner);
        raffle.topUp(id, 7e6);
        uint256 before = usdc.balanceOf(owner);

        vm.prank(owner);
        raffle.cancelRaffle(id);

        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Cancelled));
        assertEq(raffle.getRaffle(id).topUp, 0);
        assertEq(usdc.balanceOf(owner), before + 7e6);
        assertEq(raffle.totalEscrowed(), 0);
        _assertHoldings();
    }

    function test_cancel_isFinal() public {
        uint256 id = _create();
        vm.prank(owner);
        raffle.cancelRaffle(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotOpen.selector, id));
        raffle.enter(id, 1);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotOpen.selector, id));
        raffle.updateRaffle(id, PRIZE, ENTRY, TOTAL, WINDOW);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotOpen.selector, id));
        raffle.cancelRaffle(id);
        vm.stopPrank();
    }

    function test_cancel_refusesOnceAnEntryIsSold() public {
        uint256 id = _create();
        _enter(id, alice, 2);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.AlreadyStarted.selector, id, 2));
        raffle.cancelRaffle(id);
    }

    function test_cancel_isOwnerOnly() public {
        uint256 id = _create();
        vm.prank(alice);
        vm.expectRevert();
        raffle.cancelRaffle(id);
    }

    // -------------------------------------------------------------- entering

    function test_enter_takesFundsAndRecordsEntries() public {
        uint256 id = _create();
        _enter(id, alice, 2);

        assertEq(raffle.entriesOf(id, alice), 2);
        assertEq(raffle.getRaffle(id).entriesSold, 2);
        assertEq(usdc.balanceOf(address(raffle)), 2e6);
        assertEq(raffle.totalEscrowed(), 2e6);
        _assertHoldings();
    }

    function test_enter_enforcesTheFiveEntryWalletCap() public {
        uint256 id = _create();
        _enter(id, alice, 5);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.WalletCapReached.selector, id, 5, 1));
        raffle.enter(id, 1);
    }

    function test_enter_capIsPerWalletNotPerPerson() public {
        // Section 11.3 accepts this: a second wallet buys more tickets but gains
        // no per-entry advantage, and buying the raffle out costs more than the prize.
        uint256 id = _create();
        _enter(id, alice, 5);
        _enter(id, bob, 5);
        assertEq(raffle.getRaffle(id).entriesSold, 10);
    }

    function test_enter_rejectsMoreThanRemain() public {
        uint256 id = _create();
        _fillTo(id, 68);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(StubbyRaffle.NotEnoughEntriesLeft.selector, id, 2, 3)
        );
        raffle.enter(id, 3);
    }

    function test_enter_rejectsZero() public {
        uint256 id = _create();
        vm.prank(alice);
        vm.expectRevert(StubbyRaffle.InvalidEntryCount.selector);
        raffle.enter(id, 0);
    }

    function test_enter_revertsWithoutApproval() public {
        uint256 id = _create();
        address stranger = makeAddr("stranger");
        usdc.mint(stranger, 10e6);

        vm.prank(stranger);
        vm.expectRevert();
        raffle.enter(id, 1);
    }

    // ------------------------------------------------------------ the draw

    function test_draw_firesWhenTheFinalEntryLands() public {
        uint256 id = _create();
        _fillTo(id, TOTAL);

        // The final entry marks the raffle ready. It does not reach out to the
        // coordinator, so a broken provider cannot make that entry revert.
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.ReadyToDraw));
        assertEq(vrf.requestCount(), 0, "no randomness requested while filling");

        raffle.startDraw(id); // permissionless

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Drawing));
        assertEq(vrf.requestCount(), 1);
        assertEq(raffle.raffleOfRequest(r.requestId), id);
    }

    /// @dev The reason filling and drawing are separate. Found by probing the
    ///      real D20DAO coordinator on Arc testnet, which does not implement
    ///      IRandomnessSource: with the two coupled, the seventieth entry
    ///      reverted and the last buyer simply could not buy.
    function test_draw_abrokenCoordinatorDoesNotBlockTheFinalEntry() public {
        uint256 id = _create();
        vrf.setRevertOnRequest(true);

        // The raffle fills completely, including the final entry.
        _fillTo(id, TOTAL);
        assertEq(raffle.getRaffle(id).entriesSold, TOTAL);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.ReadyToDraw));
        _assertHoldings();

        // Starting the draw is what fails, and it is retryable by anyone.
        vm.expectRevert();
        raffle.startDraw(id);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.ReadyToDraw));

        // Either the provider recovers...
        vrf.setRevertOnRequest(false);
        vm.prank(alice); // not the owner
        raffle.startDraw(id);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Drawing));

        vrf.fulfil(raffle.getRaffle(id).requestId, 36);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Completed));
    }

    /// @dev ...or the owner points the contract at a different source entirely.
    function test_draw_ownerCanSwapAwayFromABrokenCoordinator() public {
        uint256 id = _create();
        vrf.setRevertOnRequest(true);
        _fillTo(id, TOTAL);

        vm.expectRevert();
        raffle.startDraw(id);

        // A raffle exists, so the swap is scheduled, in public, and anyone may
        // take it into use once the delay has passed.
        MockRandomness healthy = new MockRandomness(address(raffle));
        vm.prank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(healthy)));
        vm.warp(vm.getBlockTimestamp() + raffle.RANDOMNESS_SOURCE_DELAY());
        raffle.activateRandomnessSource();

        raffle.startDraw(id);
        healthy.fulfil(raffle.getRaffle(id).requestId, 7);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Completed));
    }

    function test_startDraw_rejectedBeforeTheRaffleIsFull() public {
        uint256 id = _create();
        _enter(id, alice, 1);

        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotReadyToDraw.selector, id));
        raffle.startDraw(id);
    }

    function test_draw_splitsThePotIntoPrizeAndCommission() public {
        uint256 id = _create();
        _fillAndStartDraw(id);
        vrf.fulfil(raffle.getRaffle(id).requestId, 36);

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Completed));
        assertEq(r.winningEntry, 36, "36 = 36 % 70");
        assertEq(r.prizeOwed, PRIZE);
        // 70 collected, 50 to the winner, 20 to the owner — the brief's example.
        assertEq(r.commissionOwed, 20e6);
        assertEq(raffle.totalEscrowed(), 0);
        assertEq(raffle.totalPrizesOwed(), PRIZE);
        assertEq(raffle.totalCommissionOwed(), 20e6);
        _assertHoldings();
    }

    function test_draw_picksTheWalletHoldingTheWinningEntry() public {
        uint256 id = _create();
        _enter(id, alice, 5); // entries 0-4
        _enter(id, bob, 3); // entries 5-7
        _enter(id, carol, 2); // entries 8-9
        _fillAndStartDraw(id);

        assertEq(raffle.buyerOfEntry(id, 0), alice);
        assertEq(raffle.buyerOfEntry(id, 4), alice);
        assertEq(raffle.buyerOfEntry(id, 5), bob);
        assertEq(raffle.buyerOfEntry(id, 7), bob);
        assertEq(raffle.buyerOfEntry(id, 8), carol);
        assertEq(raffle.buyerOfEntry(id, 9), carol);

        vrf.fulfil(raffle.getRaffle(id).requestId, 6);
        assertEq(raffle.getRaffle(id).winner, bob);
    }

    function test_draw_onlyTheSourceThatRequestedMayFulfil() public {
        uint256 id = _create();
        _fillAndStartDraw(id);
        uint256 requestId = raffle.getRaffle(id).requestId;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotTheSource.selector, id, alice));
        raffle.fulfillRandomness(requestId, 1);
    }

    function test_draw_swappingTheSourceDoesNotStrandARaffleInFlight() public {
        uint256 id = _create();
        _fillAndStartDraw(id);

        MockRandomness newVrf = new MockRandomness(address(raffle));
        vm.prank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(newVrf)));
        vm.warp(vm.getBlockTimestamp() + raffle.RANDOMNESS_SOURCE_DELAY());
        raffle.activateRandomnessSource();

        // The old coordinator still settles the draw it was asked about.
        vrf.fulfil(raffle.getRaffle(id).requestId, 11);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Completed));
    }

    function test_draw_isolatedBetweenRaffles() public {
        uint256 first = _create();
        uint256 second = _create();

        _enter(first, alice, 3);
        _fillTo(first, TOTAL);
        vrf.fulfil(raffle.getRaffle(first).requestId, 1);

        // The second raffle is untouched by the first one's draw.
        StubbyRaffle.Raffle memory r = raffle.getRaffle(second);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Open));
        assertEq(r.entriesSold, 0);
        _enter(second, bob, 1);
        assertEq(raffle.getRaffle(second).entriesSold, 1);
    }

    // ------------------------------------------------- stuck and stale draws

    function test_stuckDraw_anyoneMayReRequest() public {
        uint256 id = _create();
        vrf.setStall(true);
        _fillAndStartDraw(id);

        uint256 oldRequestId = raffle.getRaffle(id).requestId;
        vm.warp(vm.getBlockTimestamp() + 2 hours);

        vm.prank(alice); // not the owner
        raffle.reRequestRandomness(id);

        uint256 newRequestId = raffle.getRaffle(id).requestId;
        assertTrue(newRequestId != oldRequestId);
        assertEq(raffle.raffleOfRequest(oldRequestId), id, "old request still answerable");
        assertEq(raffle.raffleOfRequest(newRequestId), id);

        vrf.setStall(false);
        vrf.fulfil(newRequestId, 7);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Completed));
    }

    function test_stuckDraw_cannotReRequestBeforeTheTimeout() public {
        uint256 id = _create();
        vrf.setStall(true);
        _fillAndStartDraw(id);

        uint64 staleAt = raffle.getRaffle(id).requestedAt + raffle.randomnessTimeout();
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.RequestNotStale.selector, id, staleAt));
        raffle.reRequestRandomness(id);
    }

    /// @dev Internal review R-2. Re-requesting used to cancel the old request,
    ///      so anyone who saw a late answer coming, and disliked it, could
    ///      re-request first and have the draw rolled again. Now the late
    ///      answer still lands and settles the draw.
    function test_reRequest_cannotThrowAwayALateAnswer() public {
        uint256 id = _create();
        vrf.setStall(true);
        _fillAndStartDraw(id);
        uint256 oldRequestId = raffle.getRaffle(id).requestId;

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        vm.prank(alice); // a losing buyer, front-running the answer
        raffle.reRequestRandomness(id);

        vrf.setStall(false);
        vrf.fulfil(oldRequestId, 36);
        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Completed));
        assertEq(r.winningEntry, 36, "the late answer decided the draw");

        // The re-request's answer arrives after: ignored, not reverted, or the
        // provider would retry forever.
        vm.expectEmit(address(raffle));
        emit StubbyRaffle.StaleFulfilmentIgnored(r.requestId);
        vrf.fulfil(r.requestId, 7);
        assertEq(raffle.getRaffle(id).winningEntry, 36, "and nothing changed it");
        _assertHoldings();
    }

    function test_reRequest_theNewAnswerMaySettleFirst() public {
        uint256 id = _create();
        vrf.setStall(true);
        _fillAndStartDraw(id);
        uint256 oldRequestId = raffle.getRaffle(id).requestId;

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        raffle.reRequestRandomness(id);

        vrf.setStall(false);
        vrf.fulfil(raffle.getRaffle(id).requestId, 3);
        assertEq(raffle.getRaffle(id).winningEntry, 3);

        vrf.fulfil(oldRequestId, 36); // the old provider wakes up: ignored
        assertEq(raffle.getRaffle(id).winningEntry, 3);
        assertEq(raffle.raffleOfRequest(oldRequestId), 0, "spent");
        _assertHoldings();
    }

    /// @dev Each request is answerable only by the source it was made to, even
    ///      after the raffle's current source has moved on.
    function test_reRequest_eachRequestKeepsItsOwnSource() public {
        uint256 id = _create();
        vrf.setStall(true);
        _fillAndStartDraw(id);
        uint256 oldRequestId = raffle.getRaffle(id).requestId;

        MockRandomness next = new MockRandomness(address(raffle));
        vm.prank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(next)));
        vm.warp(vm.getBlockTimestamp() + raffle.RANDOMNESS_SOURCE_DELAY());
        raffle.activateRandomnessSource();
        raffle.reRequestRandomness(id);
        uint256 newRequestId = raffle.getRaffle(id).requestId;

        vm.expectRevert(
            abi.encodeWithSelector(StubbyRaffle.NotTheSource.selector, id, address(next))
        );
        next.fulfil(oldRequestId, 1);

        vrf.setStall(false);
        vm.expectRevert(
            abi.encodeWithSelector(StubbyRaffle.NotTheSource.selector, id, address(vrf))
        );
        vrf.fulfil(newRequestId, 1);

        vrf.fulfil(oldRequestId, 5); // its own source may
        assertEq(raffle.getRaffle(id).winningEntry, 5);
    }

    // ------------------------------------------------------------- claiming

    function _drawnRaffle(uint256 word) internal returns (uint256 id, address winner) {
        id = _create();
        _fillAndStartDraw(id);
        vrf.fulfil(raffle.getRaffle(id).requestId, word);
        winner = raffle.getRaffle(id).winner;
    }

    function test_claim_paysTheWinner() public {
        (uint256 id, address winner) = _drawnRaffle(36);
        uint256 before = usdc.balanceOf(winner);

        vm.prank(winner);
        raffle.claim(id);

        assertEq(usdc.balanceOf(winner) - before, PRIZE);
        assertTrue(raffle.getRaffle(id).prizePaid);
        assertEq(raffle.totalPrizesOwed(), 0);
        _assertHoldings();
    }

    function test_claim_rejectsEveryoneElse() public {
        (uint256 id, address winner) = _drawnRaffle(36);
        address notWinner = winner == alice ? bob : alice;

        vm.prank(notWinner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotTheWinner.selector, id, notWinner));
        raffle.claim(id);
    }

    function test_claim_cannotBePaidTwice() public {
        (uint256 id, address winner) = _drawnRaffle(36);

        vm.prank(winner);
        raffle.claim(id);

        vm.prank(winner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.PrizeAlreadyPaid.selector, id));
        raffle.claim(id);
    }

    /// @dev The central Section 6.1 guarantee.
    function test_claim_failedTransferLeavesThePrizeOwedAndRetryable() public {
        (uint256 id, address winner) = _drawnRaffle(36);

        usdc.setTransfersFail(true);
        vm.prank(winner);
        vm.expectRevert();
        raffle.claim(id);

        // Nothing was lost and nothing was marked paid.
        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertFalse(r.prizePaid, "prize must not be marked paid");
        assertEq(r.prizeOwed, PRIZE, "prize must still be owed");
        assertEq(raffle.totalPrizesOwed(), PRIZE);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Completed), "raffle stays completed");
        _assertHoldings();

        // And the retry succeeds, with no deadline in the way.
        usdc.setTransfersFail(false);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.prank(winner);
        raffle.claim(id);
        assertEq(usdc.balanceOf(winner), 1_000e6 - 5e6 + PRIZE);
    }

    function test_claimTo_rescuesABlocklistedWinner() public {
        (uint256 id, address winner) = _drawnRaffle(36);
        address rescue = makeAddr("rescue");

        // A winning wallet USDC will never pay out to: retrying is hopeless.
        usdc.setBlocked(winner, true);
        vm.prank(winner);
        vm.expectRevert();
        raffle.claim(id);

        vm.prank(winner);
        raffle.claimTo(id, rescue);

        assertEq(usdc.balanceOf(rescue), PRIZE);
        assertTrue(raffle.getRaffle(id).prizePaid);
        _assertHoldings();
    }

    function test_claimTo_onlyTheWinningWalletMayRedirect() public {
        (uint256 id, address winner) = _drawnRaffle(36);
        address thief = winner == alice ? bob : alice;

        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotTheWinner.selector, id, thief));
        raffle.claimTo(id, thief);
    }

    function test_claimTo_rejectsTheZeroAddress() public {
        (uint256 id, address winner) = _drawnRaffle(36);
        vm.prank(winner);
        vm.expectRevert(StubbyRaffle.ZeroAddress.selector);
        raffle.claimTo(id, address(0));
    }

    function test_claim_rejectedBeforeTheDrawCompletes() public {
        uint256 id = _create();
        _enter(id, alice, 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotCompleted.selector, id));
        raffle.claim(id);
    }

    // ----------------------------------------------------------- commission

    function test_commission_isWithdrawnToTheTreasury() public {
        (uint256 id,) = _drawnRaffle(36);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(owner);
        raffle.withdrawCommission(ids);

        assertEq(usdc.balanceOf(treasury), 20e6);
        assertEq(raffle.totalCommissionOwed(), 0);
        _assertHoldings();
    }

    function test_commission_withdrawsInBulk() public {
        (uint256 a,) = _drawnRaffle(1);
        (uint256 b,) = _drawnRaffle(2);

        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        vm.prank(owner);
        raffle.withdrawCommission(ids);

        assertEq(usdc.balanceOf(treasury), 40e6);
    }

    /// @dev Section 6.1: a treasury that cannot receive must not block anything.
    function test_commission_brokenTreasuryBlocksNeitherDrawNorClaim() public {
        (uint256 id, address winner) = _drawnRaffle(36);
        usdc.setBlocked(treasury, true);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(owner);
        vm.expectRevert();
        raffle.withdrawCommission(ids);

        // The winner is entirely unaffected.
        vm.prank(winner);
        raffle.claim(id);
        assertTrue(raffle.getRaffle(id).prizePaid);

        // And the commission is still owed, withdrawable once the treasury works.
        assertEq(raffle.getRaffle(id).commissionOwed, 20e6);
        usdc.setBlocked(treasury, false);
        vm.prank(owner);
        raffle.withdrawCommission(ids);
        assertEq(usdc.balanceOf(treasury), 20e6);
    }

    function test_commission_isOwnerOnly() public {
        (uint256 id,) = _drawnRaffle(36);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.prank(alice);
        vm.expectRevert();
        raffle.withdrawCommission(ids);
    }

    function test_commission_revertsWhenNothingIsOwed() public {
        uint256 id = _create();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.prank(owner);
        vm.expectRevert(StubbyRaffle.NothingOwed.selector);
        raffle.withdrawCommission(ids);
    }

    // ------------------------------------------------- windows and early draw

    function test_window_extendsWhenUnderfilled() public {
        uint256 id = _create();
        _enter(id, alice, 1);

        vm.warp(vm.getBlockTimestamp() + WINDOW + 1);
        raffle.extendWindow(id); // permissionless

        assertEq(raffle.getRaffle(id).windowEnds, uint64(block.timestamp) + WINDOW);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Open));
    }

    function test_window_cannotExtendEarly() public {
        uint256 id = _create();
        uint64 ends = raffle.getRaffle(id).windowEnds;

        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.WindowStillOpen.selector, id, ends));
        raffle.extendWindow(id);
    }

    function test_earlyDraw_needsThePrizeCovered() public {
        uint256 id = _create();
        _fillTo(id, 49); // 49 USDC against a 50 USDC prize

        assertFalse(raffle.isPrizeCovered(id));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StubbyRaffle.PrizeNotCovered.selector, id, 49e6, PRIZE)
        );
        raffle.closeEarly(id);
    }

    function test_earlyDraw_worksOncePrizeIsCovered() public {
        uint256 id = _create();
        _fillTo(id, 55);
        assertTrue(raffle.isPrizeCovered(id));

        vm.prank(owner);
        raffle.closeEarly(id);
        raffle.startDraw(id);
        vrf.fulfil(raffle.getRaffle(id).requestId, 4);

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        // The winner still gets the full advertised prize; the owner takes the rest.
        assertEq(r.prizeOwed, PRIZE);
        assertEq(r.commissionOwed, 5e6);
        _assertHoldings();
    }

    function test_earlyDraw_ownerCanTopUpTheShortfall() public {
        uint256 id = _create();
        _fillTo(id, 30);
        assertFalse(raffle.isPrizeCovered(id));

        vm.prank(owner);
        raffle.topUp(id, 20e6);
        assertTrue(raffle.isPrizeCovered(id));
        assertEq(raffle.collected(id), PRIZE);

        vm.prank(owner);
        raffle.closeEarly(id);
        raffle.startDraw(id);
        vrf.fulfil(raffle.getRaffle(id).requestId, 9);

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertEq(r.prizeOwed, PRIZE);
        assertEq(r.commissionOwed, 0, "topped-up raffle leaves the owner nothing");
        _assertHoldings();
    }

    function test_earlyDraw_rejectsAnEmptyRaffle() public {
        uint256 id = _create();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NoEntriesYet.selector, id));
        raffle.closeEarly(id);
    }

    // ---------------------------------------------------------------- pausing

    function test_pause_stopsEntriesButNotDrawsOrClaims() public {
        uint256 id = _create();
        _fillAndStartDraw(id);

        vm.prank(owner);
        raffle.setEntriesPaused(true);

        // A draw in flight still settles.
        vrf.fulfil(raffle.getRaffle(id).requestId, 36);
        address winner = raffle.getRaffle(id).winner;

        // And the winner still gets paid.
        vm.prank(winner);
        raffle.claim(id);
        assertTrue(raffle.getRaffle(id).prizePaid);

        // New entries and new raffles are what stop.
        uint256 other = 0;
        vm.prank(owner);
        vm.expectRevert(StubbyRaffle.EntriesArePaused.selector);
        other = raffle.createRaffle(PRIZE, ENTRY, TOTAL, WINDOW);
        assertEq(other, 0);
    }

    function test_pause_blocksNewEntriesOnAnOpenRaffle() public {
        uint256 id = _create();
        vm.prank(owner);
        raffle.setEntriesPaused(true);

        vm.prank(alice);
        vm.expectRevert(StubbyRaffle.EntriesArePaused.selector);
        raffle.enter(id, 1);
    }

    // ------------------------------------------------------------- ownership

    function test_ownership_transferIsTwoStep() public {
        vm.prank(owner);
        raffle.transferOwnership(alice);
        assertEq(raffle.owner(), owner, "not until accepted");

        vm.prank(alice);
        raffle.acceptOwnership();
        assertEq(raffle.owner(), alice);
    }

    function test_settings_rejectZeroAddresses() public {
        vm.startPrank(owner);
        vm.expectRevert(StubbyRaffle.ZeroAddress.selector);
        raffle.setTreasury(address(0));
        vm.expectRevert(StubbyRaffle.ZeroAddress.selector);
        raffle.setRandomnessSource(IRandomnessSource(address(0)));
        vm.expectRevert(StubbyRaffle.InvalidWindow.selector);
        raffle.setRandomnessTimeout(0);
        vm.stopPrank();
    }

    // ------------------------------------------------- the randomness source

    function test_source_isImmediateBeforeTheFirstRaffle() public {
        MockRandomness other = new MockRandomness(address(raffle));
        vm.prank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(other)));
        assertEq(address(raffle.randomness()), address(other));
        assertEq(raffle.pendingRandomness(), address(0));
    }

    /// @dev The fix for the audit pack's issue 1: once a raffle exists, the
    ///      owner cannot choose a winner by swapping in a source they control.
    function test_source_waitsInPublicOnceARaffleExists() public {
        _create();
        MockRandomness other = new MockRandomness(address(raffle));
        uint64 activatesAt = uint64(vm.getBlockTimestamp()) + raffle.RANDOMNESS_SOURCE_DELAY();

        vm.expectEmit(address(raffle));
        emit StubbyRaffle.RandomnessSourceScheduled(address(other), activatesAt);
        vm.prank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(other)));
        assertEq(address(raffle.randomness()), address(vrf), "still the old source");

        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotYetActive.selector, activatesAt));
        raffle.activateRandomnessSource();

        vm.warp(activatesAt);
        vm.prank(alice); // anyone
        raffle.activateRandomnessSource();
        assertEq(address(raffle.randomness()), address(other));
        assertEq(raffle.pendingRandomness(), address(0));
    }

    function test_source_aLiveDrawCannotBeRedirected() public {
        uint256 id = _create();
        _fillAndStartDraw(id);
        MockRandomness rigged = new MockRandomness(address(raffle));

        vm.startPrank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(rigged)));
        raffle.setRandomnessTimeout(raffle.MIN_RANDOMNESS_TIMEOUT());
        vm.stopPrank();

        // Past the timeout, a re-request still goes to the source in use.
        vm.warp(vm.getBlockTimestamp() + raffle.MIN_RANDOMNESS_TIMEOUT());
        raffle.reRequestRandomness(id);
        assertEq(raffle.getRaffle(id).source, address(vrf));
    }

    function test_source_scheduleCanBeWithdrawn() public {
        _create();
        vm.startPrank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(new MockRandomness(address(raffle)))));
        raffle.cancelRandomnessSource();
        vm.stopPrank();
        assertEq(raffle.pendingRandomness(), address(0));
        vm.expectRevert(StubbyRaffle.NothingScheduled.selector);
        raffle.activateRandomnessSource();
    }

    function test_timeout_hasAFloor() public {
        uint64 floor = raffle.MIN_RANDOMNESS_TIMEOUT();
        vm.startPrank(owner);
        vm.expectRevert(StubbyRaffle.InvalidWindow.selector);
        raffle.setRandomnessTimeout(floor - 1);
        raffle.setRandomnessTimeout(floor);
        vm.stopPrank();
        assertEq(raffle.randomnessTimeout(), floor);
    }

    /// @dev Internal review R-1: a timeout near uint64's maximum made every
    ///      re-request overflow, freezing any draw whose provider never answered.
    function test_timeout_hasACeiling() public {
        uint64 ceiling = raffle.MAX_RANDOMNESS_TIMEOUT();
        vm.startPrank(owner);
        vm.expectRevert(StubbyRaffle.InvalidWindow.selector);
        raffle.setRandomnessTimeout(ceiling + 1);
        vm.expectRevert(StubbyRaffle.InvalidWindow.selector);
        raffle.setRandomnessTimeout(type(uint64).max);
        raffle.setRandomnessTimeout(ceiling);
        vm.stopPrank();

        // At the ceiling a stuck draw can still be re-requested.
        uint256 id = _create();
        vrf.setStall(true);
        _fillAndStartDraw(id);
        vm.warp(vm.getBlockTimestamp() + ceiling);
        raffle.reRequestRandomness(id);
    }

    function test_walletCap_anOversizedBuyGetsTheNamedError() public {
        uint256 id = _create();
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.WalletCapReached.selector, id, 0, 255));
        _enter(id, alice, 255);
    }

    /// @dev The fix for the audit pack's issue 8.
    function test_ownership_cannotBeRenounced() public {
        vm.prank(owner);
        vm.expectRevert(StubbyRaffle.OwnershipCannotBeRenounced.selector);
        raffle.renounceOwnership();
        assertEq(raffle.owner(), owner);
    }

    // ----------------------------------------------------------------- fuzz

    /// @dev Whatever word the source returns, the winner is a wallet that holds
    ///      an entry, and the split always reconstructs the pot exactly.
    function testFuzz_drawAlwaysPicksARealHolderAndSplitsExactly(uint256 word) public {
        uint256 id = _create();
        _enter(id, alice, 5);
        _enter(id, bob, 4);
        _fillAndStartDraw(id);

        vrf.fulfil(raffle.getRaffle(id).requestId, word);
        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);

        assertTrue(r.winner != address(0));
        assertLt(r.winningEntry, TOTAL);
        assertEq(raffle.buyerOfEntry(id, r.winningEntry), r.winner);
        assertEq(r.prizeOwed + r.commissionOwed, uint256(TOTAL) * ENTRY);
        _assertHoldings();
    }

    /// @dev No sequence of legal purchases can breach the wallet cap or oversell.
    function testFuzz_entriesNeverExceedTheCapOrTheSupply(uint8 a, uint8 b, uint8 c) public {
        uint256 id = _create();
        a = uint8(bound(a, 1, 5));
        b = uint8(bound(b, 1, 5));
        c = uint8(bound(c, 1, 5));

        _enter(id, alice, a);
        _enter(id, bob, b);
        _enter(id, carol, c);

        assertEq(raffle.entriesOf(id, alice), a);
        assertLe(raffle.entriesOf(id, alice), 5);
        assertEq(raffle.getRaffle(id).entriesSold, uint32(a) + b + c);
        assertLe(raffle.getRaffle(id).entriesSold, TOTAL);
        _assertHoldings();
    }

    // -------------------------------------------- settings and view coverage

    function test_settings_treasuryAndTimeoutTakeEffect() public {
        address newTreasury = makeAddr("newTreasury");

        vm.startPrank(owner);
        raffle.setTreasury(newTreasury);
        raffle.setRandomnessTimeout(30 minutes);
        vm.stopPrank();

        assertEq(raffle.treasury(), newTreasury);
        assertEq(raffle.randomnessTimeout(), 30 minutes);

        // The new timeout is what re-requesting actually honours.
        uint256 id = _create();
        vrf.setStall(true);
        _fillAndStartDraw(id);
        vm.warp(vm.getBlockTimestamp() + 31 minutes);
        raffle.reRequestRandomness(id);
        assertEq(vrf.requestCount(), 2);

        // And commission lands in the new treasury.
        vrf.setStall(false);
        vrf.fulfil(raffle.getRaffle(id).requestId, 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(owner);
        raffle.withdrawCommission(ids);
        assertEq(usdc.balanceOf(newTreasury), 20e6);
    }

    function test_settings_areOwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert();
        raffle.setTreasury(alice);
        vm.expectRevert();
        raffle.setRandomnessTimeout(1 days);
        vm.expectRevert();
        raffle.setEntriesPaused(true);
        vm.stopPrank();
    }

    function test_constructor_rejectsZeroAddresses() public {
        // Ownable's own constructor runs first and rejects a zero owner.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new StubbyRaffle(usdc, IRandomnessSource(address(vrf)), treasury, address(0));

        vm.expectRevert(StubbyRaffle.ZeroAddress.selector);
        new StubbyRaffle(usdc, IRandomnessSource(address(0)), treasury, owner);

        vm.expectRevert(StubbyRaffle.ZeroAddress.selector);
        new StubbyRaffle(usdc, IRandomnessSource(address(vrf)), address(0), owner);
    }

    function test_views_reportSegmentsAndHoldings() public {
        uint256 id = _create();
        assertEq(raffle.segmentCount(id), 0);

        _enter(id, alice, 2);
        _enter(id, bob, 3);
        _enter(id, alice, 1);
        // One segment per purchase, not per entry.
        assertEq(raffle.segmentCount(id), 3);
        assertEq(raffle.collected(id), 6e6);
        assertEq(raffle.requiredHoldings(), 6e6);
    }

    function test_views_buyerOfEntryRejectsAnUnsoldIndex() public {
        uint256 id = _create();
        _enter(id, alice, 2);

        vm.expectRevert(StubbyRaffle.InvalidEntryCount.selector);
        raffle.buyerOfEntry(id, 2);
    }

    function test_create_rejectsZeroArguments() public {
        vm.startPrank(owner);
        vm.expectRevert(StubbyRaffle.InvalidPrize.selector);
        raffle.createRaffle(0, ENTRY, TOTAL, WINDOW);
        vm.expectRevert(StubbyRaffle.InvalidEntryPrice.selector);
        raffle.createRaffle(PRIZE, 0, TOTAL, WINDOW);
        vm.expectRevert(StubbyRaffle.InvalidEntryCount.selector);
        raffle.createRaffle(PRIZE, ENTRY, 0, WINDOW);
        vm.expectRevert(StubbyRaffle.InvalidWindow.selector);
        raffle.createRaffle(PRIZE, ENTRY, TOTAL, 0);
        vm.stopPrank();
    }

    function test_topUp_rejectsZeroAndClosedRaffles() public {
        uint256 id = _create();

        vm.prank(owner);
        vm.expectRevert(StubbyRaffle.NothingOwed.selector);
        raffle.topUp(id, 0);

        _fillTo(id, TOTAL); // now Drawing, not Open
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotOpen.selector, id));
        raffle.topUp(id, 1e6);
    }

    function test_lifecycle_callsAreRejectedInTheWrongState() public {
        uint256 id = _create();

        // Not drawing yet.
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotDrawing.selector, id));
        raffle.reRequestRandomness(id);

        _fillAndStartDraw(id); // Drawing

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotOpen.selector, id));
        raffle.enter(id, 1);

        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotOpen.selector, id));
        raffle.extendWindow(id);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StubbyRaffle.NotOpen.selector, id));
        raffle.closeEarly(id);

        vrf.fulfil(raffle.getRaffle(id).requestId, 1); // Completed

        // A second fulfilment for a settled raffle is refused.
        uint256 requestId = raffle.getRaffle(id).requestId;
        assertEq(raffle.raffleOfRequest(requestId), 0, "request unmapped once settled");
        vrf.fulfil(requestId, 2); // ignored as stale, does not revert
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Completed));
    }

    /// @dev A mapped request always belongs to a raffle that is Drawing: the
    ///      mapping is cleared both when a draw settles and when a request is
    ///      superseded. So the NotDrawing check inside fulfillRandomness is
    ///      defence in depth, unreachable by construction, and a late fulfilment
    ///      is ignored rather than reverted.
    function test_fulfil_aMappedRequestAlwaysMeansDrawing() public {
        uint256 id = _create();
        _fillAndStartDraw(id);
        uint256 requestId = raffle.getRaffle(id).requestId;
        assertEq(raffle.raffleOfRequest(requestId), id);

        vrf.fulfil(requestId, 1);

        assertEq(raffle.raffleOfRequest(requestId), 0, "settling unmaps the request");
        vm.prank(address(vrf));
        raffle.fulfillRandomness(requestId, 2); // ignored, no revert
        assertEq(raffle.getRaffle(id).winningEntry, 1, "the first word stands");
    }
}
