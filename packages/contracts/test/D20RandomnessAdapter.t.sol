// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {D20RandomnessAdapter} from "../src/D20RandomnessAdapter.sol";
import {ID20Coordinator} from "../src/ID20Coordinator.sol";
import {IRandomnessSource} from "../src/IRandomnessSource.sol";
import {StubbyRaffle} from "../src/StubbyRaffle.sol";
import {MockD20Coordinator, MockUsdc} from "./Mocks.sol";

contract D20RandomnessAdapterTest is Test {
    MockUsdc internal usdc;
    MockD20Coordinator internal coordinator;
    StubbyRaffle internal raffle;
    D20RandomnessAdapter internal adapter;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");

    uint256 internal constant PRIZE = 50e6;
    uint256 internal constant ENTRY = 1e6;
    uint32 internal constant TOTAL = 70;
    uint64 internal constant WINDOW = 7 days;
    uint256 internal constant FEE = 0.08e18; // native 18-decimal view

    function setUp() public {
        usdc = new MockUsdc();
        coordinator = new MockD20Coordinator();
        // The raffle starts on the coordinator directly, as a real deployment
        // would before the adapter exists, then gets pointed at the adapter.
        raffle = new StubbyRaffle(usdc, IRandomnessSource(address(coordinator)), treasury, owner);
        adapter =
            new D20RandomnessAdapter(ID20Coordinator(address(coordinator)), address(raffle), owner);

        vm.prank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(adapter)));

        vm.deal(address(adapter), 10e18); // fee float
        vm.deal(owner, 10e18);

        for (uint160 i = 1; i <= 20; ++i) {
            address wallet = address(uint160(0x2000) + i);
            usdc.mint(wallet, 1_000e6);
            vm.prank(wallet);
            usdc.approve(address(raffle), type(uint256).max);
        }
    }

    function _create() internal returns (uint256 id) {
        vm.prank(owner);
        id = raffle.createRaffle(PRIZE, ENTRY, TOTAL, WINDOW);
    }

    function _fill(uint256 id) internal {
        uint160 seed = 0x2000 + 1;
        while (raffle.getRaffle(id).entriesSold < TOTAL) {
            uint32 left = TOTAL - raffle.getRaffle(id).entriesSold;
            uint8 take = left > 5 ? 5 : uint8(left);
            vm.prank(address(seed));
            raffle.enter(id, take);
            ++seed;
        }
    }

    // --------------------------------------------------------- the happy path

    function test_endToEnd_aDrawSettlesThroughTheAdapter() public {
        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);

        // The raffle thinks it is talking to its own interface.
        uint256 raffleRequestId = raffle.getRaffle(id).requestId;
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Drawing));

        // The adapter has translated it into a coordinator request.
        uint256 d20Id = coordinator.lastId();
        assertEq(adapter.requestIdOf(d20Id), raffleRequestId, "ids not mapped");
        assertEq(coordinator.lastCallbackGas(), adapter.callbackGas());
        assertEq(coordinator.lastRefundAddress(), address(adapter), "refunds go to the float");

        // The keeper delivers a word, and the raffle settles.
        coordinator.fulfil(d20Id, bytes32(uint256(36)));

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Completed));
        assertEq(r.winningEntry, 36, "36 = 36 % 70");
        assertTrue(r.winner != address(0));
        assertEq(adapter.requestIdOf(d20Id), 0, "mapping cleared after delivery");
    }

    function test_theSeedIsBoundToThisAdapterAndThisRequest() public {
        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);

        uint256 requestId = raffle.getRaffle(id).requestId;
        bytes32 expected = keccak256(abi.encode(block.chainid, address(adapter), id, requestId));
        assertEq(coordinator.lastSeed(), expected, "seed must not be replayable");
    }

    function test_feeIsPaidFromTheFloat() public {
        uint256 before = address(adapter).balance;

        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);

        assertEq(before - address(adapter).balance, FEE, "exactly one fee");
    }

    // ------------------------------------------------------------ access

    function test_onlyTheRaffleMayRequest() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(D20RandomnessAdapter.OnlyRaffle.selector, alice));
        adapter.requestRandomness(1, 1);
    }

    function test_onlyTheCoordinatorMayFulfil() public {
        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);
        uint256 d20Id = coordinator.lastId();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(D20RandomnessAdapter.OnlyCoordinator.selector, alice)
        );
        adapter.rawFulfillRandomness(d20Id, bytes32(uint256(1)));

        // And the draw is untouched by the attempt.
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Drawing));
    }

    /// @dev A coordinator that gets a revert may retry forever, and a fulfilment
    ///      for a superseded request is not an error, so unknown ids are ignored.
    function test_anUnknownFulfilmentIsIgnoredNotReverted() public {
        coordinator.fulfilAsStranger(address(adapter), 999, bytes32(uint256(1)));
        // Nothing to assert beyond not reverting; no raffle was affected.
        assertEq(adapter.requestIdOf(999), 0);
    }

    function test_aDeliveredWordCannotBeReplayed() public {
        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);
        uint256 d20Id = coordinator.lastId();

        coordinator.fulfil(d20Id, bytes32(uint256(5)));
        uint32 firstWinner = raffle.getRaffle(id).winningEntry;

        // Replaying finds no mapping and changes nothing.
        coordinator.fulfil(d20Id, bytes32(uint256(9)));
        assertEq(raffle.getRaffle(id).winningEntry, firstWinner, "the first word stands");
    }

    // --------------------------------------------- the float, and running dry

    /// @dev The reason Section 13.6 alerts on this balance.
    function test_anEmptyFloatBlocksTheDrawButNotTheRaffle() public {
        uint256 id = _create();
        _fill(id);

        // Drain the float.
        vm.prank(owner);
        adapter.withdrawFloat(payable(owner), address(adapter).balance);
        assertEq(adapter.feeBalance(), 0);
        assertEq(adapter.requestsAffordable(), 0);

        // The raffle filled fine and stays ready; only starting the draw fails.
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.ReadyToDraw));
        vm.expectRevert(abi.encodeWithSelector(D20RandomnessAdapter.FloatTooLow.selector, FEE, 0));
        raffle.startDraw(id);

        // Top up and anyone can start it.
        (bool ok,) = address(adapter).call{value: 1e18}("");
        assertTrue(ok, "top-up should be accepted");
        assertEq(adapter.requestsAffordable(), 12);

        vm.prank(alice);
        raffle.startDraw(id);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Drawing));
    }

    function test_aBrokenCoordinatorBlocksTheDrawButNotTheRaffle() public {
        uint256 id = _create();
        _fill(id);
        coordinator.setRevertOnRequest(true);

        vm.expectRevert();
        raffle.startDraw(id);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.ReadyToDraw));

        coordinator.setRevertOnRequest(false);
        raffle.startDraw(id);
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Drawing));
    }

    function test_aFeeRiseIsPickedUpWithoutRedeploying() public {
        assertEq(adapter.requestFee(), FEE);
        coordinator.setFee(0.2e18);
        assertEq(adapter.requestFee(), 0.2e18, "the quote is read per request");

        uint256 id = _create();
        _fill(id);
        uint256 before = address(adapter).balance;
        raffle.startDraw(id);
        assertEq(before - address(adapter).balance, 0.2e18);
    }

    // --------------------------------------------------------------- settings

    function test_callbackGasIsConfigurable() public {
        vm.prank(owner);
        adapter.setCallbackGas(400_000);
        assertEq(adapter.callbackGas(), 400_000);

        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);
        assertEq(coordinator.lastCallbackGas(), 400_000);
    }

    function test_settingsAreOwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert();
        adapter.setCallbackGas(1);
        vm.expectRevert();
        adapter.withdrawFloat(payable(alice), 1);
        vm.stopPrank();
    }

    function test_settingsRejectNonsense() public {
        vm.startPrank(owner);
        vm.expectRevert(D20RandomnessAdapter.InvalidCallbackGas.selector);
        adapter.setCallbackGas(0);
        // Internal review R-3: too little gas would starve every answer.
        uint32 floor = adapter.MIN_CALLBACK_GAS();
        vm.expectRevert(D20RandomnessAdapter.InvalidCallbackGas.selector);
        adapter.setCallbackGas(floor - 1);
        adapter.setCallbackGas(floor);
        vm.expectRevert(D20RandomnessAdapter.ZeroAddress.selector);
        adapter.withdrawFloat(payable(address(0)), 1);
        vm.expectRevert(D20RandomnessAdapter.NothingToWithdraw.selector);
        adapter.withdrawFloat(payable(owner), 0);
        vm.expectRevert(D20RandomnessAdapter.NothingToWithdraw.selector);
        adapter.withdrawFloat(payable(owner), 100e18);
        vm.stopPrank();
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(D20RandomnessAdapter.ZeroAddress.selector);
        new D20RandomnessAdapter(ID20Coordinator(address(0)), address(raffle), owner);

        vm.expectRevert(D20RandomnessAdapter.ZeroAddress.selector);
        new D20RandomnessAdapter(ID20Coordinator(address(coordinator)), address(0), owner);
    }

    function test_ownershipTransferIsTwoStep() public {
        vm.prank(owner);
        adapter.transferOwnership(alice);
        assertEq(adapter.owner(), owner);

        vm.prank(alice);
        adapter.acceptOwnership();
        assertEq(adapter.owner(), alice);
    }

    // -------------------------------------------------------- swapping it out

    /// @dev Section 11.1: the provider can be replaced without disturbing a
    ///      raffle already in flight, because the raffle pins the source per draw.
    function test_swappingTheAdapterDoesNotStrandARaffleInFlight() public {
        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);
        uint256 d20Id = coordinator.lastId();

        D20RandomnessAdapter replacement =
            new D20RandomnessAdapter(ID20Coordinator(address(coordinator)), address(raffle), owner);
        vm.deal(address(replacement), 1e18);
        vm.prank(owner);
        raffle.setRandomnessSource(IRandomnessSource(address(replacement)));
        vm.warp(vm.getBlockTimestamp() + raffle.RANDOMNESS_SOURCE_DELAY());
        raffle.activateRandomnessSource();

        // The old adapter still settles the draw it requested.
        coordinator.fulfil(d20Id, bytes32(uint256(11)));
        assertEq(uint8(raffle.getRaffle(id).status), uint8(StubbyRaffle.Status.Completed));
    }

    // -------------------------------------------------------------------- fuzz

    function testFuzz_anyWordProducesAValidWinner(uint256 word) public {
        uint256 id = _create();
        _fill(id);
        raffle.startDraw(id);
        coordinator.fulfil(coordinator.lastId(), bytes32(word));

        StubbyRaffle.Raffle memory r = raffle.getRaffle(id);
        assertEq(uint8(r.status), uint8(StubbyRaffle.Status.Completed));
        assertLt(r.winningEntry, TOTAL);
        assertEq(raffle.buyerOfEntry(id, r.winningEntry), r.winner);
        assertEq(r.prizeOwed + r.commissionOwed, uint256(TOTAL) * ENTRY);
    }
}
