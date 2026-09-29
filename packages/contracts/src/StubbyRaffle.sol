// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IRandomnessConsumer, IRandomnessSource} from "./IRandomnessSource.sol";

/// @title Stubby raffles
/// @notice One contract holding every raffle, keyed by id (Section 11.7). Not
///         upgradeable: a new version is a new deployment that takes new
///         raffles, while this one keeps settling the raffles it already holds.
/// @dev The guarantee this contract exists to make (Section 6.1) is that a
///      raffle can never freeze. Three rules carry it:
///
///      1. The draw only *selects* a winner and records what is owed. Payout is
///         a separate call, so nothing about a payout can block a draw.
///      2. A claim marks paid and transfers in one transaction. A failed
///         transfer reverts the whole thing, so the prize stays owed and is
///         retryable forever, with no deadline.
///      3. Commission is owed, never pushed. A broken treasury cannot stop a
///         draw or a winner.
///
///      Amounts are USDC base units in the **6-decimal ERC-20 view**, because
///      that is the interface this contract moves money through. Arc's native
///      gas view of the same balance uses 18 decimals and the two differ by
///      10^12, so never mix them. The arithmetic here is decimal-agnostic: it
///      only multiplies an entry count by an entry price, and the units are
///      whatever the owner configured. They must match the shared TypeScript
///      package, which is the one place the identity
///      totalEntries * entryPrice = prize + ownerRoi is implemented.
contract StubbyRaffle is Ownable2Step, ReentrancyGuard, IRandomnessConsumer {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    enum Status {
        None,
        Open,
        /// @dev Full, or closed early by the owner. Waiting for someone to call
        ///      startDraw. No more entries are accepted.
        ReadyToDraw,
        Drawing,
        Completed,
        /// @dev Withdrawn by the owner before anyone bought an entry. Final.
        Cancelled
    }

    struct Raffle {
        uint256 prize;
        uint256 entryPrice;
        uint256 topUp;
        uint256 prizeOwed;
        uint256 commissionOwed;
        uint256 requestId;
        uint32 totalEntries;
        uint32 entriesSold;
        uint32 winningEntry;
        uint64 windowEnds;
        uint64 windowSeconds;
        uint64 requestedAt;
        address winner;
        /// @dev The source that made the in-flight request. Pinned per raffle so
        ///      swapping the provider cannot strand a draw already under way.
        address source;
        Status status;
        bool prizePaid;
    }

    /// @notice One purchase: `buyer` owns entries up to but excluding `endExclusive`.
    /// @dev Segments rather than one slot per entry, so a purchase costs one
    ///      write regardless of size and the winner is found by binary search.
    struct Segment {
        address buyer;
        uint32 endExclusive;
    }

    // ------------------------------------------------------------ constants

    /// @notice Section 2: a wallet may hold at most 5 entries in one raffle,
    ///         and never more than a quarter of it (see walletCap).
    /// @dev Per wallet, not per person, and deliberately so — see Section 11.3.
    uint8 public constant MAX_ENTRIES_PER_WALLET = 5;

    /// @notice No raffle may offer less than 10 USDC (6-decimal view).
    /// @dev The one soft bound made hard: a script can skip the dashboard.
    uint256 public constant MIN_PRIZE = 10e6;

    // -------------------------------------------------------------- storage

    IERC20 public immutable USDC;

    IRandomnessSource public randomness;

    /// @notice Where commission is withdrawn to (Section 3.1).
    address public treasury;

    /// @notice How long a randomness request may sit before anyone may re-request.
    uint64 public randomnessTimeout = 1 hours;

    /// @notice The shortest re-request timeout the owner may set: long enough
    ///         for any honest provider to answer.
    uint64 public constant MIN_RANDOMNESS_TIMEOUT = 10 minutes;

    /// @notice The longest re-request timeout the owner may set.
    /// @dev Without a ceiling, a timeout near the uint64 maximum makes
    ///      `requestedAt + randomnessTimeout` overflow, so reRequestRandomness
    ///      reverts forever and a draw whose provider never answers can never
    ///      move: a raffle frozen by one owner call (internal review R-1).
    uint64 public constant MAX_RANDOMNESS_TIMEOUT = 1 days;

    /// @notice How long a new randomness source waits, in public, before it
    ///         takes effect, once any raffle exists.
    /// @dev The source decides winners, so an owner who could swap it at once
    ///      could choose one. With the delay the change is announced first
    ///      (RandomnessSourceScheduled): the watcher alerts the owner within a
    ///      minute, and the app stops selling tickets until it has settled.
    ///      An hour, the owner's choice (2026-09-27): short enough that a
    ///      provider outage costs little, long enough to see an announcement
    ///      the owner did not make.
    uint64 public constant RANDOMNESS_SOURCE_DELAY = 1 hours;

    /// @notice A source waiting out RANDOMNESS_SOURCE_DELAY, and when it may
    ///         take effect. Zero when nothing is scheduled.
    address public pendingRandomness;
    uint64 public pendingRandomnessAt;

    /// @notice Blocks new raffles and new entries. Never blocks a draw or a claim.
    bool public entriesPaused;

    uint256 public nextRaffleId = 1;

    /// @dev Correlation ids for randomness requests. Ours, not the provider's,
    ///      so a request is recorded before the source is called.
    uint256 public nextRequestId = 1;

    /// @dev Aggregates backing the holdings invariant: the contract's balance is
    ///      always at least escrow + unclaimed prizes + unwithdrawn commission.
    uint256 public totalEscrowed;
    uint256 public totalPrizesOwed;
    uint256 public totalCommissionOwed;

    mapping(uint256 raffleId => Raffle) private _raffles;
    mapping(uint256 raffleId => Segment[]) private _segments;
    mapping(uint256 raffleId => mapping(address wallet => uint8)) public entriesOf;
    mapping(uint256 requestId => uint256 raffleId) public raffleOfRequest;

    /// @notice The source each request was made to: the only address that may
    ///         answer it.
    /// @dev Per request, not per raffle, because a re-request no longer
    ///      cancels the request before it (see reRequestRandomness).
    mapping(uint256 requestId => address source) public sourceOfRequest;

    // --------------------------------------------------------------- events

    event RaffleCreated(
        uint256 indexed raffleId,
        uint256 prize,
        uint256 entryPrice,
        uint32 totalEntries,
        uint64 windowEnds
    );
    event RaffleUpdated(
        uint256 indexed raffleId,
        uint256 prize,
        uint256 entryPrice,
        uint32 totalEntries,
        uint64 windowEnds
    );
    event RaffleCancelled(uint256 indexed raffleId, uint256 refunded);
    event Entered(uint256 indexed raffleId, address indexed wallet, uint8 count, uint256 paid);
    event WindowExtended(uint256 indexed raffleId, uint64 windowEnds);
    event ReadyToDraw(uint256 indexed raffleId, uint32 entriesSold);
    event ToppedUp(uint256 indexed raffleId, uint256 amount);
    event DrawStarted(uint256 indexed raffleId, uint256 requestId, address source);
    event RandomnessReRequested(
        uint256 indexed raffleId, uint256 oldRequestId, uint256 newRequestId
    );
    event StaleFulfilmentIgnored(uint256 requestId);
    event Drawn(
        uint256 indexed raffleId,
        address indexed winner,
        uint32 winningEntry,
        uint256 prize,
        uint256 commission
    );
    event PrizeClaimed(
        uint256 indexed raffleId, address indexed winner, address indexed recipient, uint256 amount
    );
    event CommissionWithdrawn(address indexed to, uint256 amount);
    event RandomnessSourceChanged(address indexed source);
    event RandomnessSourceScheduled(address indexed source, uint64 activatesAt);
    event TreasuryChanged(address indexed treasury);
    event RandomnessTimeoutChanged(uint64 seconds_);
    event EntriesPausedChanged(bool paused);

    // --------------------------------------------------------------- errors

    error ZeroAddress();
    error EntriesArePaused();
    error InvalidPrize();
    error InvalidEntryPrice();
    error InvalidEntryCount();
    error InvalidWindow();
    error PotCannotCoverPrize(uint256 pot, uint256 prize);
    error NotOpen(uint256 raffleId);
    error NotReadyToDraw(uint256 raffleId);
    error NotDrawing(uint256 raffleId);
    error NotCompleted(uint256 raffleId);
    error WalletCapReached(uint256 raffleId, uint8 held, uint8 wanted);
    error NotEnoughEntriesLeft(uint256 raffleId, uint32 left, uint8 wanted);
    error WindowStillOpen(uint256 raffleId, uint64 windowEnds);
    error NoEntriesYet(uint256 raffleId);
    error NothingScheduled();
    error NotYetActive(uint64 activatesAt);
    error OwnershipCannotBeRenounced();
    error AlreadyStarted(uint256 raffleId, uint32 entriesSold);
    error PrizeNotCovered(uint256 raffleId, uint256 collected, uint256 prize);
    error RequestNotStale(uint256 raffleId, uint64 staleAt);
    error NotTheSource(uint256 raffleId, address caller);
    error NotTheWinner(uint256 raffleId, address caller);
    error PrizeAlreadyPaid(uint256 raffleId);
    error NothingOwed();

    // ---------------------------------------------------------- constructor

    constructor(IERC20 usdc, IRandomnessSource randomness_, address treasury_, address owner_)
        Ownable(owner_)
    {
        if (
            address(usdc) == address(0) || address(randomness_) == address(0)
                || treasury_ == address(0) || owner_ == address(0)
        ) {
            revert ZeroAddress();
        }
        USDC = usdc;
        randomness = randomness_;
        treasury = treasury_;
    }

    // ----------------------------------------------------------- owner: setup

    /// @notice Create a raffle.
    /// @dev The pot a full raffle collects must cover the prize, so the owner's
    ///      take can never be negative, and the prize is at least MIN_PRIZE.
    ///      Section 11.8's other bounds (entry price range, minimum entry
    ///      count) are enforced in the admin dashboard, since the owner may
    ///      reconfigure them.
    function createRaffle(
        uint256 prize,
        uint256 entryPrice,
        uint32 totalEntries,
        uint64 windowSeconds
    ) external onlyOwner returns (uint256 raffleId) {
        if (entriesPaused) revert EntriesArePaused();

        raffleId = nextRaffleId++;
        Raffle storage r = _raffles[raffleId];
        _configure(r, prize, entryPrice, totalEntries, windowSeconds);
        r.status = Status.Open;

        emit RaffleCreated(raffleId, prize, entryPrice, totalEntries, r.windowEnds);
    }

    /// @notice Change a raffle nobody has entered yet. The window restarts.
    /// @dev Once one entry is sold the terms are a promise to that buyer, so
    ///      this refuses from then on. Same rules as createRaffle.
    function updateRaffle(
        uint256 raffleId,
        uint256 prize,
        uint256 entryPrice,
        uint32 totalEntries,
        uint64 windowSeconds
    ) external onlyOwner {
        Raffle storage r = _unstarted(raffleId);
        _configure(r, prize, entryPrice, totalEntries, windowSeconds);
        emit RaffleUpdated(raffleId, prize, entryPrice, totalEntries, r.windowEnds);
    }

    /// @notice Withdraw a raffle nobody has entered yet.
    /// @dev With no entries there is nothing to refund to players; any top-up
    ///      goes back to the owner, who paid it. Cancelled is final.
    function cancelRaffle(uint256 raffleId) external nonReentrant onlyOwner {
        Raffle storage r = _unstarted(raffleId);
        uint256 refund = r.topUp;
        r.topUp = 0;
        r.status = Status.Cancelled;
        totalEscrowed -= refund;

        emit RaffleCancelled(raffleId, refund);

        if (refund != 0) USDC.safeTransfer(msg.sender, refund);
    }

    // -------------------------------------------------------- participant

    /// @notice Buy `count` entries.
    /// @dev The final entry makes the raffle ReadyToDraw; the draw itself is a
    ///      separate call (startDraw), for the reason given below.
    function enter(uint256 raffleId, uint8 count) external nonReentrant {
        if (entriesPaused) revert EntriesArePaused();
        Raffle storage r = _raffles[raffleId];
        if (r.status != Status.Open) revert NotOpen(raffleId);
        if (count == 0) revert InvalidEntryCount();

        uint8 held = entriesOf[raffleId][msg.sender];
        // Widened, so an oversized `count` gets the named error rather than a
        // uint8 overflow panic.
        if (uint256(held) + count > walletCap(r.totalEntries)) {
            revert WalletCapReached(raffleId, held, count);
        }
        uint32 left = r.totalEntries - r.entriesSold;
        if (count > left) revert NotEnoughEntriesLeft(raffleId, left, count);

        uint256 amount = uint256(count) * r.entryPrice;
        uint32 sold = r.entriesSold + count;

        // Effects before the transfer, so a reentrant token cannot see stale state.
        entriesOf[raffleId][msg.sender] = held + count;
        r.entriesSold = sold;
        _segments[raffleId].push(Segment({buyer: msg.sender, endExclusive: sold}));
        totalEscrowed += amount;

        emit Entered(raffleId, msg.sender, count, amount);

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        // Deliberately does NOT start the draw. Requesting randomness is an
        // external call to a third party, and doing it here would mean a broken
        // or incompatible coordinator makes the *final entry* revert — the last
        // buyer cannot buy, through no fault of their own. Filling the raffle
        // and starting the draw are separate steps, and startDraw is
        // permissionless and retryable (Section 6.1).
        if (sold == r.totalEntries) {
            r.status = Status.ReadyToDraw;
            emit ReadyToDraw(raffleId, sold);
        }
    }

    /// @notice Request randomness for a raffle that is full or closed early.
    /// @dev Permissionless and retryable: if the coordinator reverts, anyone can
    ///      call this again once it is healthy, or the owner can point the
    ///      contract at a different source first. Nothing about a failing
    ///      provider can stop entries or trap funds.
    function startDraw(uint256 raffleId) external nonReentrant {
        Raffle storage r = _raffles[raffleId];
        if (r.status != Status.ReadyToDraw) revert NotReadyToDraw(raffleId);
        _startDraw(raffleId, r);
    }

    /// @notice Extend an underfilled raffle by one window (Section 11.5).
    /// @dev Permissionless on purpose: extension must not wait on the owner.
    ///      Entries are never refunded: only a raffle nobody has entered can
    ///      be cancelled.
    function extendWindow(uint256 raffleId) external {
        Raffle storage r = _raffles[raffleId];
        if (r.status != Status.Open) revert NotOpen(raffleId);
        // A validator can nudge the clock by seconds; windows are days long.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < r.windowEnds) revert WindowStillOpen(raffleId, r.windowEnds);

        r.windowEnds = _now() + r.windowSeconds;
        emit WindowExtended(raffleId, r.windowEnds);
    }

    // ------------------------------------------------------- owner: drawing

    /// @notice Close a raffle early once the pot covers the prize (Section 11.5).
    /// @dev Marks it ready; anyone then calls startDraw. The winner still gets
    ///      the full advertised prize, and the owner's take is simply whatever
    ///      was collected above it, which may be nothing.
    function closeEarly(uint256 raffleId) external onlyOwner {
        Raffle storage r = _raffles[raffleId];
        if (r.status != Status.Open) revert NotOpen(raffleId);
        if (r.entriesSold == 0) revert NoEntriesYet(raffleId);

        uint256 pot = _collected(r);
        if (pot < r.prize) revert PrizeNotCovered(raffleId, pot, r.prize);

        r.status = Status.ReadyToDraw;
        emit ReadyToDraw(raffleId, r.entriesSold);
    }

    /// @notice Add USDC to a raffle so it can reach prize-covered status early.
    function topUp(uint256 raffleId, uint256 amount) external nonReentrant onlyOwner {
        Raffle storage r = _raffles[raffleId];
        if (r.status != Status.Open) revert NotOpen(raffleId);
        if (amount == 0) revert NothingOwed();

        r.topUp += amount;
        totalEscrowed += amount;
        emit ToppedUp(raffleId, amount);

        USDC.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Ask the source again when a request has gone stale.
    /// @dev Permissionless, so a draw can never hang (Section 11.1). The old
    ///      request stays answerable: whichever answer arrives first settles
    ///      the draw, and any later one is ignored. Cancelling the old request
    ///      instead let anyone who saw a late answer coming, and disliked it,
    ///      re-request first and have the draw rolled again (internal review
    ///      R-2).
    function reRequestRandomness(uint256 raffleId) external nonReentrant {
        Raffle storage r = _raffles[raffleId];
        if (r.status != Status.Drawing) revert NotDrawing(raffleId);

        uint64 staleAt = r.requestedAt + randomnessTimeout;
        // Same: the timeout is an hour, far beyond any clock nudge.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < staleAt) revert RequestNotStale(raffleId, staleAt);

        uint256 oldRequestId = r.requestId;
        uint256 newRequestId = nextRequestId++;
        IRandomnessSource source = randomness;

        r.requestedAt = _now();
        r.source = address(source);
        r.requestId = newRequestId;
        raffleOfRequest[newRequestId] = raffleId;
        sourceOfRequest[newRequestId] = address(source);

        emit RandomnessReRequested(raffleId, oldRequestId, newRequestId);

        // As in _startDraw: everything is written above, and this function is
        // itself nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        source.requestRandomness(raffleId, newRequestId);
    }

    // ----------------------------------------------------------- randomness

    /// @inheritdoc IRandomnessConsumer
    /// @dev Only the source that made *this* request may fulfil it, so changing
    ///      the provider does not strand a raffle mid-draw. Every request a
    ///      draw has made stays answerable until one answer settles it; an
    ///      answer after that is ignored rather than reverted, so a slow
    ///      provider cannot be made to retry forever.
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external nonReentrant {
        uint256 raffleId = raffleOfRequest[requestId];
        if (raffleId == 0) {
            emit StaleFulfilmentIgnored(requestId);
            return;
        }
        if (msg.sender != sourceOfRequest[requestId]) revert NotTheSource(raffleId, msg.sender);

        // Spent either way, and either way an event follows: Drawn below, or
        // StaleFulfilmentIgnored if another answer settled the draw first.
        delete raffleOfRequest[requestId];
        // forge-lint: disable-next-line(missing-events-access-control)
        delete sourceOfRequest[requestId];

        Raffle storage r = _raffles[raffleId];
        // Another of this draw's requests answered first.
        if (r.status != Status.Drawing) {
            emit StaleFulfilmentIgnored(requestId);
            return;
        }

        // entriesSold is uint32, so the remainder is always in range.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 winningEntry = uint32(randomWord % r.entriesSold);
        address winner = _buyerOfEntry(raffleId, winningEntry);

        uint256 pot = _collected(r);
        uint256 prize = r.prize;
        uint256 commission = pot - prize;

        r.status = Status.Completed;
        r.winner = winner;
        r.winningEntry = winningEntry;
        r.prizeOwed = prize;
        r.commissionOwed = commission;

        // Escrow becomes an owed prize plus owed commission. Nothing moves yet.
        totalEscrowed -= pot;
        totalPrizesOwed += prize;
        totalCommissionOwed += commission;

        emit Drawn(raffleId, winner, winningEntry, prize, commission);
    }

    // ---------------------------------------------------------------- claims

    /// @notice Claim a won prize to the winning wallet.
    function claim(uint256 raffleId) external nonReentrant {
        _claim(raffleId, msg.sender);
    }

    /// @notice Claim a won prize to a different address.
    /// @dev For a winning wallet that cannot receive USDC — a blocklisted
    ///      address, where retrying would never succeed (Section 6.1). Only the
    ///      winning wallet can authorise it, so nobody else can redirect funds.
    function claimTo(uint256 raffleId, address recipient) external nonReentrant {
        _claim(raffleId, recipient);
    }

    function _claim(uint256 raffleId, address recipient) private {
        if (recipient == address(0)) revert ZeroAddress();

        Raffle storage r = _raffles[raffleId];
        if (r.status != Status.Completed) revert NotCompleted(raffleId);
        if (msg.sender != r.winner) revert NotTheWinner(raffleId, msg.sender);
        if (r.prizePaid) revert PrizeAlreadyPaid(raffleId);

        uint256 amount = r.prizeOwed;

        // Mark paid and send in the same transaction. If the transfer reverts,
        // so do these writes: the prize stays owed and stays claimable, with no
        // deadline and no limit on retries.
        r.prizePaid = true;
        r.prizeOwed = 0;
        totalPrizesOwed -= amount;

        emit PrizeClaimed(raffleId, r.winner, recipient, amount);

        USDC.safeTransfer(recipient, amount);
    }

    /// @notice Withdraw commission for one or more raffles.
    /// @dev Pull, not push, so a treasury that cannot receive USDC can never
    ///      block a draw or a winner's claim.
    function withdrawCommission(uint256[] calldata raffleIds) external nonReentrant onlyOwner {
        uint256 total = 0;
        for (uint256 i; i < raffleIds.length; ++i) {
            Raffle storage r = _raffles[raffleIds[i]];
            uint256 owed = r.commissionOwed;
            if (owed != 0) {
                r.commissionOwed = 0;
                total += owed;
            }
        }
        if (total == 0) revert NothingOwed();

        totalCommissionOwed -= total;
        address to = treasury;

        emit CommissionWithdrawn(to, total);

        USDC.safeTransfer(to, total);
    }

    // ------------------------------------------------------ owner: settings

    /// @notice Change the randomness source.
    /// @dev Immediate until the first raffle exists, so a deployment can wire
    ///      its adapter; after that, scheduled for RANDOMNESS_SOURCE_DELAY and
    ///      taken into use by `activateRandomnessSource`. Scheduling again
    ///      replaces the pending source and restarts the delay. In-flight draws
    ///      keep the source they were requested from (Section 11.1).
    function setRandomnessSource(IRandomnessSource source) external onlyOwner {
        if (address(source) == address(0)) revert ZeroAddress();
        if (nextRaffleId == 1) {
            randomness = source;
            delete pendingRandomness;
            delete pendingRandomnessAt;
            emit RandomnessSourceChanged(address(source));
            return;
        }
        uint64 activatesAt = _now() + RANDOMNESS_SOURCE_DELAY;
        pendingRandomness = address(source);
        pendingRandomnessAt = activatesAt;
        emit RandomnessSourceScheduled(address(source), activatesAt);
    }

    /// @notice Take a scheduled source into use once its delay has passed.
    /// @dev Permissionless, so a replacement for a broken provider cannot be
    ///      held back once it is due.
    function activateRandomnessSource() external {
        address source = pendingRandomness;
        if (source == address(0)) revert NothingScheduled();
        // A validator can nudge the clock by seconds; the delay is an hour.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pendingRandomnessAt) revert NotYetActive(pendingRandomnessAt);
        randomness = IRandomnessSource(source);
        delete pendingRandomness;
        delete pendingRandomnessAt;
        emit RandomnessSourceChanged(source);
    }

    /// @notice Withdraw a scheduled source before it takes effect.
    function cancelRandomnessSource() external onlyOwner {
        if (pendingRandomness == address(0)) revert NothingScheduled();
        delete pendingRandomness;
        delete pendingRandomnessAt;
        emit RandomnessSourceScheduled(address(0), 0);
    }

    /// @dev Renouncing would strand commission and every underfilled raffle
    ///      for good, so it is refused. Hand ownership over instead
    ///      (transferOwnership, then acceptOwnership).
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function setRandomnessTimeout(uint64 seconds_) external onlyOwner {
        if (seconds_ < MIN_RANDOMNESS_TIMEOUT || seconds_ > MAX_RANDOMNESS_TIMEOUT) {
            revert InvalidWindow();
        }
        randomnessTimeout = seconds_;
        emit RandomnessTimeoutChanged(seconds_);
    }

    /// @notice Stop new raffles and new entries.
    /// @dev Deliberately does not touch draws, claims or commission: pausing must
    ///      never be able to freeze a raffle or trap a prize (Section 6.1).
    function setEntriesPaused(bool paused) external onlyOwner {
        entriesPaused = paused;
        emit EntriesPausedChanged(paused);
    }

    // ----------------------------------------------------------------- views

    /// @notice The most entries one wallet may hold in a raffle of this size:
    ///         a quarter of it, at least 1 and at most MAX_ENTRIES_PER_WALLET.
    /// @dev So no wallet ever holds more than 25% of a draw's odds, however
    ///      small the draw: 10 entries allow 2 each, 16 allow 4, 20+ allow 5.
    ///      Terms only change before the first entry, so a cap never moves
    ///      under someone who has bought.
    function walletCap(uint32 totalEntries) public pure returns (uint8) {
        uint32 quarter = totalEntries / 4;
        if (quarter >= MAX_ENTRIES_PER_WALLET) return MAX_ENTRIES_PER_WALLET;
        if (quarter == 0) return 1;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(quarter); // below MAX_ENTRIES_PER_WALLET, so it fits
    }

    function getRaffle(uint256 raffleId) external view returns (Raffle memory) {
        return _raffles[raffleId];
    }

    function segmentCount(uint256 raffleId) external view returns (uint256) {
        return _segments[raffleId].length;
    }

    /// @notice What this raffle has taken in, entries plus any owner top-up.
    function collected(uint256 raffleId) external view returns (uint256) {
        return _collected(_raffles[raffleId]);
    }

    /// @notice Section 11.5: has the pot reached the prize?
    function isPrizeCovered(uint256 raffleId) external view returns (bool) {
        Raffle storage r = _raffles[raffleId];
        return _collected(r) >= r.prize;
    }

    /// @notice Which wallet owns a given entry index.
    function buyerOfEntry(uint256 raffleId, uint32 index) external view returns (address) {
        if (index >= _raffles[raffleId].entriesSold) revert InvalidEntryCount();
        return _buyerOfEntry(raffleId, index);
    }

    /// @notice What the contract must be holding at minimum.
    /// @dev The invariant tests assert `USDC.balanceOf(this) >= this`. It is a
    ///      floor rather than an equality because anyone can send USDC to the
    ///      contract unprompted, and such a donation is never spendable.
    function requiredHoldings() external view returns (uint256) {
        return totalEscrowed + totalPrizesOwed + totalCommissionOwed;
    }

    // ------------------------------------------------------------- internals

    /// @dev uint64 holds seconds until year 584942417355, so this cannot truncate.
    function _now() private view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function _configure(
        Raffle storage r,
        uint256 prize,
        uint256 entryPrice,
        uint32 totalEntries,
        uint64 windowSeconds
    ) private {
        if (prize < MIN_PRIZE) revert InvalidPrize();
        if (entryPrice == 0) revert InvalidEntryPrice();
        if (totalEntries == 0) revert InvalidEntryCount();
        if (windowSeconds == 0) revert InvalidWindow();

        uint256 pot = uint256(totalEntries) * entryPrice;
        if (pot < prize) revert PotCannotCoverPrize(pot, prize);

        r.prize = prize;
        r.entryPrice = entryPrice;
        r.totalEntries = totalEntries;
        r.windowSeconds = windowSeconds;
        r.windowEnds = _now() + windowSeconds;
    }

    /// @dev An open raffle with no entries: the only kind that may change.
    function _unstarted(uint256 raffleId) private view returns (Raffle storage r) {
        r = _raffles[raffleId];
        if (r.status != Status.Open) revert NotOpen(raffleId);
        if (r.entriesSold != 0) revert AlreadyStarted(raffleId, r.entriesSold);
    }

    function _collected(Raffle storage r) private view returns (uint256) {
        return uint256(r.entriesSold) * r.entryPrice + r.topUp;
    }

    function _startDraw(uint256 raffleId, Raffle storage r) private {
        address source = address(randomness);
        uint256 requestId = nextRequestId++;

        r.status = Status.Drawing;
        r.requestedAt = _now();
        r.source = source;
        r.requestId = requestId;
        raffleOfRequest[requestId] = raffleId;
        sourceOfRequest[requestId] = source;

        emit DrawStarted(raffleId, requestId, source);

        // Last statement in the function: no state is written after it. Its
        // one caller, startDraw, is nonReentrant, so the guard is held for the
        // duration of this call.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        IRandomnessSource(source).requestRandomness(raffleId, requestId);
    }

    /// @dev Binary search for the segment containing `index`.
    function _buyerOfEntry(uint256 raffleId, uint32 index) private view returns (address) {
        Segment[] storage segs = _segments[raffleId];
        uint256 lo = 0;
        uint256 hi = segs.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            if (segs[mid].endExclusive <= index) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return segs[lo].buyer;
    }
}
