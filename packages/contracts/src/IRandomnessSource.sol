// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title Randomness provider seam
/// @notice Section 11.1: Arc has no native randomness, so the draw depends on an
///         external verifiable source. D20DAO VRF is the provider at launch, but
///         it sits behind this interface so it can be replaced — by Chainlink VRF
///         if that reaches Arc, or by the ArcDraw fallback — without redeploying
///         the raffle contract or disturbing raffles already in flight.
interface IRandomnessSource {
    /// @notice Request one random word for a raffle.
    /// @param raffleId The raffle the request belongs to.
    /// @param requestId Correlation id chosen by the caller, quoted back on fulfilment.
    /// @dev The caller supplies the id rather than receiving one so it can record
    ///      the request *before* making this call, keeping
    ///      checks-effects-interactions strict (Section 13.3). An adapter in front
    ///      of a provider that mints its own ids is responsible for mapping
    ///      between the two.
    function requestRandomness(uint256 raffleId, uint256 requestId) external;

    /// @notice What a request costs, in USDC. Around 0.08 for D20DAO VRF.
    /// @dev The raffle contract does not spend this itself; it is surfaced so the
    ///      owner and the monitoring in Section 13.6 can watch the balance.
    function requestFee() external view returns (uint256);
}

/// @title The callback a randomness source calls back into
interface IRandomnessConsumer {
    /// @notice Deliver the random word for an earlier request.
    /// @dev Implementations must reject any caller that is not the source which
    ///      made this particular request, and must ignore a fulfilment for a
    ///      request that has been superseded.
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external;
}
