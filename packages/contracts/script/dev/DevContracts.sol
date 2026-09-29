// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IRandomnessConsumer, IRandomnessSource} from "../../src/IRandomnessSource.sol";

/// @title Local-only USDC
/// @notice Stands in for Arc's native USDC on Anvil (Section 13.5). Mirrors the
///         two behaviours that matter: the ERC-20 view's 6 decimals, and reverts on a transfer to
///         the zero address.
/// @dev NEVER DEPLOY THIS ANYWHERE BUT A LOCAL CHAIN. Anyone can mint.
contract DevUsdc is ERC20 {
    constructor() ERC20("Dev USD Coin", "USDC") {}

    /// @dev The ERC-20 interface Arc exposes is 6 decimals; the native gas
    ///      view of the same balance is 18. Contracts use this one.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Unrestricted faucet. The reason this contract is local-only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title Local-only randomness
/// @notice Records requests and settles them when told to, so a developer can
///         step through a draw by hand (Section 13.5).
/// @dev NEVER DEPLOY THIS ANYWHERE BUT A LOCAL CHAIN. The "randomness" is a
///      caller-supplied number, or a hash of chain state that a validator could
///      influence — which is exactly what Section 11.1 rules out for real draws.
contract DevRandomness is IRandomnessSource {
    struct Request {
        uint256 raffleId;
        bool fulfilled;
    }

    address public immutable CONSUMER;
    mapping(uint256 requestId => Request) public requests;
    uint256 public lastRequestId;
    uint256 public requestCount;

    event Requested(uint256 indexed raffleId, uint256 indexed requestId);
    event Fulfilled(uint256 indexed requestId, uint256 randomWord);

    error AlreadyFulfilled(uint256 requestId);
    error UnknownRequest(uint256 requestId);

    constructor(address consumer) {
        CONSUMER = consumer;
    }

    function requestFee() external pure returns (uint256) {
        // Roughly what D20DAO VRF charges, so local numbers look realistic.
        return 0.08e18;
    }

    function requestRandomness(uint256 raffleId, uint256 requestId) external {
        requests[requestId] = Request({raffleId: raffleId, fulfilled: false});
        lastRequestId = requestId;
        ++requestCount;
        emit Requested(raffleId, requestId);
    }

    /// @notice Settle a request with a word you choose, for a repeatable draw.
    function fulfil(uint256 requestId, uint256 randomWord) public {
        Request storage r = requests[requestId];
        if (r.raffleId == 0) revert UnknownRequest(requestId);
        if (r.fulfilled) revert AlreadyFulfilled(requestId);

        r.fulfilled = true;
        emit Fulfilled(requestId, randomWord);

        IRandomnessConsumer(CONSUMER).fulfillRandomness(requestId, randomWord);
    }

    /// @notice Settle the most recent request with a pseudo-random word.
    /// @dev Convenience for local play. Not random in any sense that matters.
    function fulfilLatest() external {
        fulfil(
            lastRequestId,
            uint256(keccak256(abi.encodePacked(block.prevrandao, block.timestamp, lastRequestId)))
        );
    }
}
