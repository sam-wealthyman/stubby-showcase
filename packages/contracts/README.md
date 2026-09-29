# @stubby/contracts

Solidity raffle contract for Arc. Foundry project.

`StubbyRaffle.sol` is written and tested: 55 tests including 6 stateful
invariants, 99.45% line coverage, 100% function coverage, 94.59% branch
coverage. Runtime size 8,882 bytes.

The invariants (`test/invariant/`) drive the contract through random sequences of
all 15 actions — including deliberately breaking USDC transfers, blocklisting
participants, stalling the randomness provider and pausing — and assert after
every step that the contract still holds exactly what it owes, that the running
totals never drift from per-raffle state, and that no prize is ever partial or
paid twice.

```bash
forge test
forge test --match-path 'test/invariant/*'   # the stateful invariants alone
forge coverage --report summary
forge snapshot --check --tolerance 1
```

`D20RandomnessAdapter.sol` bridges the raffle's `IRandomnessSource` to the real
D20DAO coordinator: 17 tests, 100% line and function coverage. Every signature it
depends on was verified against the deployed contract rather than documentation,
because two published signatures were wrong — see brief Section 11.1 and the
NatSpec on `ID20Coordinator.sol` for the selectors and how they were confirmed.

It holds a fee float, because the coordinator charges `msg.value` per request in
Arc's native 18-decimal view and the raffle does not forward value. Fund it by
sending USDC to its address; watch `feeBalance()` and `requestsAffordable()`.

```bash
forge script script/DeployAdapter.s.sol:DeployAdapter --rpc-url arc_testnet --broadcast
```

That deploys it, funds the float, and points the raffle at it if the caller owns
the raffle. It refuses to deploy if the coordinator does not answer `quoteFee`,
so an interface mismatch fails before it can produce a raffle that never draws.

Not yet done: verifying D20DAO's audit status, exercising the adapter against the
real coordinator rather than a mock, and the external audit before mainnet.

## The local stack

```bash
./script/local-smoke.sh
```

Starts Anvil if one is not already listening, deploys mock USDC, a hand-driven
randomness source, the raffle contract and one open raffle, funds Anvil's ten
default accounts, then drives a whole raffle: fifty entries, the prize-covered
early draw, settlement, and the winner claiming. It re-checks the holdings
invariant after every step and asserts the contract ends empty.

Point it at your own chain with `RPC=http://... ./script/local-smoke.sh`.

To poke at it by hand instead:

```bash
anvil &
forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 \
  --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

`DeployLocal` refuses to run on any chain that is not 31337 or 1337, because
both mock contracts are unsafe by design: anyone can mint the token, and the
"randomness" is whatever the caller passes in.

## Deploying for real

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url "$ARC_RPC_URL" --broadcast --verify
```

Reads `USDC_ADDRESS`, `VRF_COORDINATOR_ADDRESS`, `TREASURY_ADDRESS` and
`OWNER_ADDRESS` from the environment, and fails before broadcasting if one is
missing or if USDC or the coordinator has no code on the target chain — which
catches pointing a testnet deploy at a mainnet address. Mainnet deploys only
from a tagged, audited release (Section 13.5).

## What it is

- **One singleton** managing all raffles by id, non-upgradeable, versioned
  deployments (Section 11.7)
- **Per-raffle accounting** so a stuck prize in one raffle cannot touch another
- **Retryable claims**: `claim` and `claimTo(recipient)`, no deadline, atomic
  mark-and-send so a failed transfer reverts the whole call (Section 6.1)
- **Filling and drawing are separate steps.** The final entry marks the raffle
  `ReadyToDraw`; a permissionless `startDraw` then requests randomness. Coupling
  them would mean a broken coordinator makes the _final entry_ revert, which is
  not hypothetical: the real D20DAO coordinator does not implement
  `IRandomnessSource`, so an adapter is required before any draw can work
- **Commission owed, not pushed**: `withdrawCommission`, so the owner's wallet
  can never block a draw or a winner (Section 6.1)
- **Randomness behind `IRandomnessSource`** so the provider can be swapped
  without redeploying (Section 11.1)
- **Checks-effects-interactions everywhere**, reentrancy guards on every
  state-changing entry point (Section 13.3)

## Arc specifics that change the code

- USDC has **two views of one balance**: the native gas token is 18 decimals,
  the ERC-20 interface at `0x3600…0000` is 6. This contract moves money with
  `transferFrom`, so its amounts are **6-decimal** base units. Its arithmetic is
  decimal-agnostic — it multiplies a count by a price — but the values the owner
  configures must be in the ERC-20 view
- sending to `address(0)` reverts rather than succeeding
- the mempool enforces a 20 Gwei `maxFeePerGas` floor
- transfers to blocklisted USDC addresses revert, which is why `claimTo` exists

## Test bar

95%+ line coverage, 100% function coverage, fuzz and invariant tests. The
invariant that matters: the contract holds exactly escrow + unclaimed prizes +
commission. Failed claims, retries, `claimTo`, a blocked treasury, failed
randomness requests and stale fulfillments all need explicit cases (13.3).

## The correlation id is ours, not the provider's

`IRandomnessSource.requestRandomness` takes a `requestId` from us rather than
returning one. That is deliberate: it lets the contract record the request
_before_ calling out, so checks-effects-interactions stays strict even for the
randomness call, which Section 13.3 requires by name. An adapter in front of a
provider that mints its own ids maps between the two.

The source is also pinned per raffle at request time, so swapping the provider
cannot strand a draw already in flight.

## Not an npm workspace

This package deliberately has no `package.json`. It is a Foundry project, so
pnpm has nothing to install for it and `forge` handles build, test and
dependencies. Its CI lives in `.github/workflows/contracts.yml`.
