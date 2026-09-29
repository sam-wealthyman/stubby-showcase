// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title The D20DAO VRF coordinator, as deployed
/// @notice Only the three functions the adapter needs, declared here rather than
///         taken as a dependency. D20DAO ship a `D20VRFConsumer` base contract,
///         but the only thing it provides is the `rawFulfillRandomness`
///         entrypoint and a caller check, both of which are three lines. Writing
///         them keeps an unaudited third-party contract out of the randomness
///         path, which Section 13.3 asks for.
///
/// @dev Every signature here was verified against the deployed contract on Arc
///      testnet rather than taken from documentation, because two separate
///      documented signatures turned out to be wrong (Section 11.1). The
///      selectors were read out of the dispatcher of a live consumer's
///      implementation bytecode and cross-checked against a real transaction:
///
///        requestRandomness(bytes32,uint32,address)  0x9849d1e5
///        quoteFee(uint32)                           0xc9caa0c3
///        rawFulfillRandomness(uint256,bytes32)      0x8ec08178
///
///      If a future version changes these, the adapter stops working loudly —
///      `requestRandomness` reverts — rather than silently drawing wrong.
interface ID20Coordinator {
    /// @notice Request one random word.
    /// @param seed Caller-chosen entropy, mixed with the beacon.
    /// @param callbackGas Gas the coordinator will forward to the callback.
    /// @param refundAddress Where any fee refund is sent.
    /// @return id The coordinator's own request id, quoted back on fulfilment.
    /// @dev The fee is `msg.value`, in Arc's **native 18-decimal view** of USDC.
    ///      Amounts elsewhere in this project are the 6-decimal ERC-20 view.
    function requestRandomness(bytes32 seed, uint32 callbackGas, address refundAddress)
        external
        payable
        returns (uint256 id);

    /// @notice The exact fee for a request with this callback gas, in native units.
    function quoteFee(uint32 callbackGas) external view returns (uint256 fee);
}

/// @title What the coordinator calls back on a consumer
/// @dev The name matters: the coordinator calls this exact selector. Verified as
///      `0x8ec08178` in the dispatcher of a deployed D20DAO consumer.
interface ID20Consumer {
    function rawFulfillRandomness(uint256 id, bytes32 word) external;
}
