// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ID20Consumer, ID20Coordinator} from "./ID20Coordinator.sol";
import {IRandomnessConsumer, IRandomnessSource} from "./IRandomnessSource.sol";

/// @title D20DAO VRF, behind the raffle's own randomness interface
/// @notice Translates between `IRandomnessSource`, which the raffle contract
///         speaks, and the D20DAO coordinator, which speaks something else
///         (Section 11.1). Swapped in with `StubbyRaffle.setRandomnessSource`,
///         and swappable out again the same way.
///
/// @dev Three things this has to reconcile:
///
///      1. **Who owns the request id.** The raffle hands us an id so it can
///         record a request before making any external call. The coordinator
///         mints its own. So this contract keeps a map between them.
///      2. **Who pays.** The coordinator takes its fee as `msg.value` at request
///         time, in Arc's native 18-decimal view of USDC. The raffle does not
///         forward value, so this contract holds a float and pays from it. Top it
///         up by sending USDC to this address; Section 13.6's "low
///         randomness-fee balance" alert watches `feeBalance()`.
///      3. **A failed request must not be fatal.** If the float runs dry or the
///         coordinator reverts, `requestRandomness` reverts — and the raffle's
///         `startDraw` is a separate permissionless call, so the raffle simply
///         stays ready and anyone retries once this is funded again.
contract D20RandomnessAdapter is IRandomnessSource, ID20Consumer, Ownable2Step, ReentrancyGuard {
    /// @notice The D20DAO coordinator. Immutable: point the raffle at a new
    ///         adapter rather than repointing this one.
    ID20Coordinator public immutable COORDINATOR;

    /// @notice The only contract allowed to request through this adapter.
    address public immutable RAFFLE;

    /// @notice Gas forwarded to our callback.
    /// @dev `StubbyRaffle.fulfillRandomness` measured about 100k: a binary search
    ///      over the entry segments plus the accounting writes. The default
    ///      leaves room for a raffle with many segments.
    uint32 public callbackGas = 250_000;

    /// @notice The least callback gas the owner may set.
    /// @dev Takes effect at once, unlike a source change. Without a floor, one
    ///      owner call (`setCallbackGas(1)`) made every answer run out of gas,
    ///      so every draw went stale, and once a scheduled source took effect
    ///      the re-requests all went to it: the one-hour notice bypassed
    ///      (internal review R-3). The callback measured about 100k.
    uint32 public constant MIN_CALLBACK_GAS = 150_000;

    /// @dev The coordinator's id to ours. Cleared on fulfilment, so a replayed
    ///      or unknown id finds nothing and is ignored.
    mapping(uint256 d20RequestId => uint256 raffleRequestId) public requestIdOf;

    event RandomnessRequested(
        uint256 indexed raffleId, uint256 indexed raffleRequestId, uint256 d20RequestId, uint256 fee
    );
    event RandomnessDelivered(uint256 indexed raffleRequestId, uint256 d20RequestId);
    event UnknownFulfilmentIgnored(uint256 d20RequestId);
    event CallbackGasChanged(uint32 callbackGas);
    event FloatToppedUp(address indexed from, uint256 amount);
    event FloatWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error OnlyRaffle(address caller);
    error OnlyCoordinator(address caller);
    error FloatTooLow(uint256 needed, uint256 available);
    error NothingToWithdraw();
    error WithdrawFailed();
    error InvalidCallbackGas();

    constructor(ID20Coordinator coordinator, address raffle, address owner_) Ownable(owner_) {
        if (address(coordinator) == address(0) || raffle == address(0)) revert ZeroAddress();
        COORDINATOR = coordinator;
        RAFFLE = raffle;
    }

    /// @inheritdoc IRandomnessSource
    /// @dev The raffle has already recorded this request before calling, so a
    ///      revert here leaves it ready to retry rather than stuck.
    function requestRandomness(uint256 raffleId, uint256 requestId) external nonReentrant {
        if (msg.sender != RAFFLE) revert OnlyRaffle(msg.sender);

        uint32 gas = callbackGas;
        uint256 fee = COORDINATOR.quoteFee(gas);
        uint256 float_ = address(this).balance;
        if (float_ < fee) revert FloatTooLow(fee, float_);

        // Bind the seed to this raffle, this request and this adapter, so it
        // cannot be replayed from another deployment or another raffle.
        bytes32 seed = keccak256(abi.encode(block.chainid, address(this), raffleId, requestId));

        // The coordinator mints the id, so the map can only be written after the
        // call returns. Guarded by nonReentrant, and a reentrant callback would
        // find no mapping and be ignored rather than misrouted.
        uint256 d20Id = COORDINATOR.requestRandomness{value: fee}(seed, gas, address(this));

        // The id only exists once the call returns, so this write and the event
        // cannot precede it. nonReentrant holds for the duration, and a
        // reentrant callback would find no mapping and be ignored.
        requestIdOf[d20Id] = requestId;
        // forge-lint: disable-next-line(reentrancy-events)
        emit RandomnessRequested(raffleId, requestId, d20Id, fee);
    }

    /// @inheritdoc IRandomnessSource
    function requestFee() external view returns (uint256) {
        return COORDINATOR.quoteFee(callbackGas);
    }

    /// @inheritdoc ID20Consumer
    /// @dev Ignores an id it does not recognise instead of reverting: a
    ///      coordinator that gets a revert may retry forever, and a fulfilment
    ///      for a request the raffle has already superseded is not an error.
    function rawFulfillRandomness(uint256 id, bytes32 word) external nonReentrant {
        if (msg.sender != address(COORDINATOR)) revert OnlyCoordinator(msg.sender);

        uint256 requestId = requestIdOf[id];
        if (requestId == 0) {
            emit UnknownFulfilmentIgnored(id);
            return;
        }

        delete requestIdOf[id];
        emit RandomnessDelivered(requestId, id);

        // Mapping cleared and event emitted above, so nothing is written after
        // this call. The guard holds for its duration.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        IRandomnessConsumer(RAFFLE).fulfillRandomness(requestId, uint256(word));
    }

    /// @notice The float available to pay request fees, in native units.
    /// @dev What Section 13.6's low-balance alert should watch.
    function feeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice How many requests the current float can pay for.
    function requestsAffordable() external view returns (uint256) {
        uint256 fee = COORDINATOR.quoteFee(callbackGas);
        return fee == 0 ? type(uint256).max : address(this).balance / fee;
    }

    function setCallbackGas(uint32 gas) external onlyOwner {
        if (gas < MIN_CALLBACK_GAS) revert InvalidCallbackGas();
        callbackGas = gas;
        emit CallbackGasChanged(gas);
    }

    function withdrawFloat(address payable to, uint256 amount) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > address(this).balance) revert NothingToWithdraw();

        emit FloatWithdrawn(to, amount);

        // Owner-only and nonReentrant; a reentrant call would re-check the
        // balance and fail. Not a pull-payment pool, just a fee float.
        // forge-lint: disable-next-line(reentrancy-eth)
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @notice Top up the fee float by sending native USDC here.
    receive() external payable {
        emit FloatToppedUp(msg.sender, msg.value);
    }
}
