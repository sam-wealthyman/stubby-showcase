// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ID20Consumer, ID20Coordinator} from "../src/ID20Coordinator.sol";
import {IRandomnessConsumer, IRandomnessSource} from "../src/IRandomnessSource.sol";

/// @notice USDC as Arc's ERC-20 interface has it: 6 decimals, reverts on transfers to the zero
///         address, and with a blocklist so the Section 6.1 paths are reachable.
contract MockUsdc is ERC20 {
    mapping(address => bool) public blocked;
    bool public transfersFail;

    constructor() ERC20("USD Coin", "USDC") {}

    /// @dev The ERC-20 interface Arc exposes is 6 decimals; the native gas
    ///      view of the same balance is 18. Contracts use this one.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Simulate a USDC-blocklisted address, where a transfer always reverts.
    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    /// @notice Make every transfer fail, for the "claim reverts" path.
    function setTransfersFail(bool value) external {
        transfersFail = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!transfersFail, "USDC: transfers disabled");
        require(to != address(0) || from == address(0), "USDC: zero address");
        require(!blocked[from] && !blocked[to], "USDC: blocklisted");
        super._update(from, to, value);
    }
}

/// @notice A randomness source the tests drive by hand.
contract MockRandomness is IRandomnessSource {
    uint256 public lastRequestId;
    uint256 public lastRaffleId;
    uint256 public requestCount;
    bool public stall;
    bool public revertOnRequest;

    address public consumer;

    constructor(address consumer_) {
        consumer = consumer_;
    }

    function setConsumer(address consumer_) external {
        consumer = consumer_;
    }

    /// @notice Accept requests but never call back, for the stuck-draw path.
    function setStall(bool value) external {
        stall = value;
    }

    /// @notice Refuse requests outright, as a coordinator with a different
    ///         interface does — the real D20DAO one reverts on ours.
    function setRevertOnRequest(bool value) external {
        revertOnRequest = value;
    }

    function requestFee() external pure returns (uint256) {
        return 0.08e18;
    }

    function requestRandomness(uint256 raffleId, uint256 requestId) external {
        require(!revertOnRequest, "coordinator: unsupported interface");
        lastRequestId = requestId;
        lastRaffleId = raffleId;
        ++requestCount;
    }

    /// @notice Deliver a word for a request, as the real coordinator would.
    function fulfil(uint256 requestId, uint256 randomWord) external {
        if (stall) return;
        IRandomnessConsumer(consumer).fulfillRandomness(requestId, randomWord);
    }
}

/// @notice A treasury that cannot receive USDC, to prove commission cannot block.
contract RejectingTreasury {}

/// @notice The D20DAO coordinator as deployed, to the extent the adapter uses it.
/// @dev Signatures mirror the verified ones exactly, so a change in either place
///      breaks the build rather than the draw.
contract MockD20Coordinator is ID20Coordinator {
    uint256 public nextId = 1;
    uint256 public lastId;
    bytes32 public lastSeed;
    uint32 public lastCallbackGas;
    address public lastRefundAddress;
    uint256 public feePerRequest = 0.08e18; // native 18-decimal view
    bool public revertOnRequest;

    mapping(uint256 => address) public consumerOf;

    function setFee(uint256 fee) external {
        feePerRequest = fee;
    }

    function setRevertOnRequest(bool value) external {
        revertOnRequest = value;
    }

    function quoteFee(uint32) external view returns (uint256) {
        return feePerRequest;
    }

    function requestRandomness(bytes32 seed, uint32 callbackGas, address refundAddress)
        external
        payable
        returns (uint256 id)
    {
        require(!revertOnRequest, "coordinator down");
        require(msg.value >= feePerRequest, "IncorrectFee");
        id = nextId++;
        lastId = id;
        lastSeed = seed;
        lastCallbackGas = callbackGas;
        lastRefundAddress = refundAddress;
        consumerOf[id] = msg.sender;
    }

    /// @notice Deliver a word, as the keeper would.
    function fulfil(uint256 id, bytes32 word) external {
        ID20Consumer(consumerOf[id]).rawFulfillRandomness(id, word);
    }

    /// @notice Deliver from the wrong address, to prove the caller check works.
    function fulfilAsStranger(address consumer, uint256 id, bytes32 word) external {
        ID20Consumer(consumer).rawFulfillRandomness(id, word);
    }
}
