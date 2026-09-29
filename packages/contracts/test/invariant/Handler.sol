// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {StubbyRaffle} from "../../src/StubbyRaffle.sol";
import {MockRandomness, MockUsdc} from "../Mocks.sol";

/// @notice Drives the raffle through random but legal-looking sequences.
/// @dev Every action is bounded so the fuzzer spends its runs on interesting
///      orderings rather than on arguments that always revert. Reverts are
///      tolerated (`fail_on_revert = false`): what matters is that no reachable
///      sequence can break the invariants in RaffleInvariants.
contract Handler is CommonBase, StdCheats, StdUtils {
    StubbyRaffle public immutable RAFFLE;
    MockUsdc public immutable USDC;
    MockRandomness public immutable VRF;
    address public immutable OWNER;

    uint256[] public raffleIds;
    address[] public actors;

    /// @dev Ghost accounting, kept independently of the contract so the
    ///      invariants can cross-check rather than restate its own arithmetic.
    uint256 public ghostPaidIn;
    uint256 public ghostPaidOut;

    constructor(StubbyRaffle raffle_, MockUsdc usdc_, MockRandomness vrf_, address owner_) {
        RAFFLE = raffle_;
        USDC = usdc_;
        VRF = vrf_;
        OWNER = owner_;

        for (uint160 i = 1; i <= 12; ++i) {
            address actor = address(uint160(0xA11CE000) + i);
            actors.push(actor);
            usdc_.mint(actor, 100_000e6);
            vm.prank(actor);
            usdc_.approve(address(raffle_), type(uint256).max);
        }
        usdc_.mint(owner_, 1_000_000e6);
        vm.prank(owner_);
        usdc_.approve(address(raffle_), type(uint256).max);
    }

    function raffleCount() external view returns (uint256) {
        return raffleIds.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[bound(seed, 0, actors.length - 1)];
    }

    function _raffle(uint256 seed) internal view returns (uint256) {
        if (raffleIds.length == 0) return 0;
        return raffleIds[bound(seed, 0, raffleIds.length - 1)];
    }

    /// @dev 10 to 200 entries, priced so a full raffle covers the 10 USDC
    ///      minimum prize: small raffles get a higher floor price.
    function _terms(uint256 priceSeed, uint256 entriesSeed)
        internal
        pure
        returns (uint256 entryPrice, uint32 totalEntries)
    {
        totalEntries = uint32(bound(entriesSeed, 10, 200));
        uint256 floor = (10e6 + totalEntries - 1) / totalEntries;
        entryPrice = bound(priceSeed, floor > 5e5 ? floor : 5e5, 100e6);
    }

    // ------------------------------------------------------------- actions

    function createRaffle(uint256 prizeSeed, uint256 priceSeed, uint256 entriesSeed) external {
        // Kept inside Section 11.8's bounds, and always solvent.
        (uint256 entryPrice, uint32 totalEntries) = _terms(priceSeed, entriesSeed);
        uint256 prize = bound(prizeSeed, 10e6, uint256(totalEntries) * entryPrice);

        vm.prank(OWNER);
        try RAFFLE.createRaffle(prize, entryPrice, totalEntries, 7 days) returns (uint256 id) {
            raffleIds.push(id);
        } catch {}
    }

    function enter(uint256 raffleSeed, uint256 actorSeed, uint256 countSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        address actor = _actor(actorSeed);
        uint8 count = uint8(bound(countSeed, 1, 5));

        StubbyRaffle.Raffle memory r = RAFFLE.getRaffle(id);
        uint256 cost = uint256(count) * r.entryPrice;

        vm.prank(actor);
        try RAFFLE.enter(id, count) {
            ghostPaidIn += cost;
        } catch {}
    }

    function topUp(uint256 raffleSeed, uint256 amountSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        uint256 amount = bound(amountSeed, 1e6, 1_000e6);

        vm.prank(OWNER);
        try RAFFLE.topUp(id, amount) {
            ghostPaidIn += amount;
        } catch {}
    }

    function updateRaffle(uint256 raffleSeed, uint256 priceSeed, uint256 entriesSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        (uint256 entryPrice, uint32 totalEntries) = _terms(priceSeed, entriesSeed);
        uint256 prize = bound(priceSeed, 10e6, uint256(totalEntries) * entryPrice);

        vm.prank(OWNER);
        try RAFFLE.updateRaffle(id, prize, entryPrice, totalEntries, 7 days) {} catch {}
    }

    function cancelRaffle(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        uint256 refund = RAFFLE.getRaffle(id).topUp;

        vm.prank(OWNER);
        try RAFFLE.cancelRaffle(id) {
            ghostPaidOut += refund;
        } catch {}
    }

    function extendWindow(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        try RAFFLE.extendWindow(id) {} catch {}
    }

    function closeEarly(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        vm.prank(OWNER);
        try RAFFLE.closeEarly(id) {} catch {}
    }

    function startDraw(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        try RAFFLE.startDraw(id) {} catch {}
    }

    function fulfil(uint256 raffleSeed, uint256 word) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        StubbyRaffle.Raffle memory r = RAFFLE.getRaffle(id);
        if (r.status != StubbyRaffle.Status.Drawing) return;
        try VRF.fulfil(r.requestId, word) {} catch {}
    }

    /// @dev Answer any request ever made: the current one, one a re-request
    ///      superseded (still answerable, internal review R-2), or one already
    ///      spent. However they arrive, a draw must settle exactly once.
    function fulfilAnyRequest(uint256 requestSeed, uint256 word) external {
        uint256 made = RAFFLE.nextRequestId() - 1;
        if (made == 0) return;
        uint256 requestId = bound(requestSeed, 1, made);
        try VRF.fulfil(requestId, word) {} catch {}
    }

    function reRequest(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        try RAFFLE.reRequestRandomness(id) {} catch {}
    }

    function claim(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        StubbyRaffle.Raffle memory r = RAFFLE.getRaffle(id);
        if (r.winner == address(0)) return;
        uint256 owed = r.prizeOwed;

        vm.prank(r.winner);
        try RAFFLE.claim(id) {
            ghostPaidOut += owed;
        } catch {}
    }

    function claimTo(uint256 raffleSeed, uint256 actorSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        StubbyRaffle.Raffle memory r = RAFFLE.getRaffle(id);
        if (r.winner == address(0)) return;
        uint256 owed = r.prizeOwed;

        vm.prank(r.winner);
        try RAFFLE.claimTo(id, _actor(actorSeed)) {
            ghostPaidOut += owed;
        } catch {}
    }

    function withdrawCommission(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        if (id == 0) return;
        uint256 owed = RAFFLE.getRaffle(id).commissionOwed;

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(OWNER);
        try RAFFLE.withdrawCommission(ids) {
            ghostPaidOut += owed;
        } catch {}
    }

    /// @notice Let a claim fail, so the "prize stays owed" path is explored too.
    function breakTransfers(bool value) external {
        USDC.setTransfersFail(value);
    }

    /// @notice Block a random participant, as USDC's blocklist would.
    function blockActor(uint256 actorSeed, bool value) external {
        USDC.setBlocked(_actor(actorSeed), value);
    }

    /// @notice Stall the provider, so stuck draws and re-requests are explored.
    function stallRandomness(bool value) external {
        VRF.setStall(value);
    }

    function pauseEntries(bool value) external {
        vm.prank(OWNER);
        try RAFFLE.setEntriesPaused(value) {} catch {}
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(vm.getBlockTimestamp() + bound(secondsSeed, 1 hours, 30 days));
    }
}
