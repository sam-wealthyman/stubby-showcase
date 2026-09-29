# Audit pack: Stubby contracts

For the firm reviewing Stubby's smart contracts. It says what is in scope, what
the contracts promise, who can do what, what we already know about, and where
we would most like a second pair of eyes. Prepared 2026-09-27.

## Scope

| File                                              | Lines | What                                                      |
| ------------------------------------------------- | ----- | --------------------------------------------------------- |
| `packages/contracts/src/StubbyRaffle.sol`         | 745   | Every raffle, keyed by id: entry, draw, claim, commission |
| `packages/contracts/src/D20RandomnessAdapter.sol` | 169   | Bridges the raffle to D20DAO's VRF coordinator            |
| `packages/contracts/src/IRandomnessSource.sol`    | 34    | The raffle's randomness seam, and its callback            |
| `packages/contracts/src/ID20Coordinator.sol`      | 46    | The subset of D20DAO's coordinator the adapter calls      |

Solidity 0.8.28, OpenZeppelin (`Ownable2Step`, `ReentrancyGuard`, `SafeERC20`).
Out of scope: the app, the API and the scripts, none of which holds a key that
can move funds.

**Commit:** the head of `main` when the engagement starts; `git rev-parse HEAD`
on the day. This pack describes `91b79c5`.

**Deployed.** Mainnet runs this code, the internal review's fixes included (redeployed 2026-09-27; the executable bytecode matches `main`, only the 32-byte metadata hash differs). Testnet runs the code from before the review:

| Network               | `StubbyRaffle`                               | `D20RandomnessAdapter`                       |
| --------------------- | -------------------------------------------- | -------------------------------------------- |
| Arc mainnet (5042)    | `0x7213526D82FE7E1A37A26974E343e23eF88bdfa4` | `0x66ABac54Cd4080fED9275529F6d23f8A217298B3` |
| Arc testnet (5042002) | `0xf4FDe0b23A252d01851A50eBb4ca7D4Bad10718c` | `0x7DE85C29af84A2b694378679cfB357E18a983D1E` |

Mainnet has no raffles yet and is not used by the app until the audit is done.

## Running it

```bash
cd packages/contracts
forge test                         # 97 tests, 6 stateful invariants
forge coverage --report summary    # see below
forge snapshot --check             # gas, within 1%
```

Coverage of the in-scope contracts:

| File                       | Lines           | Branches      | Functions    |
| -------------------------- | --------------- | ------------- | ------------ |
| `StubbyRaffle.sol`         | 99.5% (212/213) | 95.3% (41/43) | 100% (32/32) |
| `D20RandomnessAdapter.sol` | 100% (41/41)    | 88.9% (8/9)   | 100% (9/9)   |

CI runs format, build, tests, the gas snapshot, coverage and Slither on every
pull request (`.github/workflows/contracts.yml`).

## What the contracts promise

The brief's Section 6.1 in one sentence: **a raffle can never freeze, and a
prize can never be lost.** Concretely:

1. **Solvency.** The USDC balance is always at least escrow + unclaimed prizes +
   unwithdrawn commission (`requiredHoldings()`), and with no donations, exactly
   that. Six invariants in `test/invariant/RaffleInvariants.t.sol` check it after
   any sequence of entries, top-ups, edits, cancels, draws, fulfilments,
   re-requests, claims, withdrawals, pauses, token failures and clock jumps:
   - holdings cover obligations;
   - nothing is trapped (balance equals obligations);
   - money in equals money out plus what is held (ghost accounting);
   - the running totals match per-raffle state;
   - every raffle is internally consistent (never oversold, no wallet over the cap, a completed raffle has a real winner holding a real entry, the prize is never partial);
   - a prize is paid at most once, and only to the winner or where the winner sent it.
2. **A draw only selects.** `fulfillRandomness` records the winner and what is
   owed; nothing is transferred, so no transfer can block a draw.
3. **A claim is atomic and retryable.** Mark paid and transfer happen in one
   transaction. A failed transfer (for example a USDC-blocklisted winner)
   reverts both, the prize stays owed with no deadline, and `claimTo` lets the
   winning wallet send it elsewhere.
4. **Commission is pulled.** `withdrawCommission` by the owner, so a treasury
   that cannot receive USDC never blocks a winner.
5. **Randomness can be retried by anyone.** `startDraw` and
   `reRequestRandomness` are permissionless, so a stalled provider cannot hold
   a draw. A re-request does not cancel the request before it; the first
   answer to any of a draw's requests settles it, each answerable only by the
   source it was made to (`sourceOfRequest`).

## Who can do what

| Caller                | May                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone                | `enter`, `activateRandomnessSource` (after the delay), `startDraw` (full or closed-early raffles), `extendWindow` (after the window), `reRequestRandomness` (after the timeout), all views                                                                                                                 |
| The winning wallet    | `claim`, `claimTo`                                                                                                                                                                                                                                                                                         |
| The randomness source | `fulfillRandomness`, only for the request it made (`r.source`)                                                                                                                                                                                                                                             |
| The owner             | `createRaffle`, `updateRaffle` and `cancelRaffle` (no entries sold), `closeEarly` (prize covered), `topUp`, `withdrawCommission`, `setTreasury`, `setRandomnessSource`, `setRandomnessTimeout`, `setEntriesPaused`; `cancelRandomnessSource`; `transferOwnership` (two-step). `renounceOwnership` reverts. |
| Adapter owner         | `setCallbackGas`, `withdrawFloat`                                                                                                                                                                                                                                                                          |
| D20DAO coordinator    | `rawFulfillRandomness` on the adapter                                                                                                                                                                                                                                                                      |

## Trust assumptions and known issues

Listed so the review can spend its time elsewhere, or tell us we are wrong.

1. **Fixed 2026-09-27: the owner could choose the randomness source, and so
   the winner.** `setRandomnessSource` took effect immediately and
   `setRandomnessTimeout` accepted any value above zero, so an owner (or a
   thief of the owner key) could point a draw at a source they control, even
   a live one (a one-second timeout, a swap, then `reRequestRandomness`, which
   asks the current source). **The fix:** once any raffle exists,
   `setRandomnessSource` only schedules a source (`RandomnessSourceScheduled`),
   which takes effect after `RANDOMNESS_SOURCE_DELAY` (1 hour) through the
   permissionless `activateRandomnessSource`, and the owner can withdraw it
   with `cancelRandomnessSource`. Before the first raffle it is immediate, so a
   deployment can wire its adapter. `setRandomnessTimeout` has a floor of
   `MIN_RANDOMNESS_TIMEOUT` (10 minutes) and a ceiling of
   `MAX_RANDOMNESS_TIMEOUT` (1 day). Re-requests still go to the current
   source, so a broken provider stays replaceable; the delay is what stops a
   quiet swap. The delay is an hour, by the owner's choice, backed by two
   off-chain measures: the watcher alerts the owner within a minute of a
   `RandomnessSourceScheduled` (so an announcement the owner did not make
   means a compromised key, with an hour to cancel), and the app stops selling
   tickets until the new source takes effect. **The residual trust:** an owner
   can still announce a source and use it an hour later, and holders of
   tickets in open draws cannot withdraw. We would value your view on whether
   an hour, with those measures, is enough.
   A keeper outage never needs a swap: D20DAO's coordinator is served by
   several keepers, and a stale request is re-requested from the same
   coordinator. The swap exists for the coordinator failing as a whole.
2. **Entries are never refunded.** An underfilled raffle extends its window
   indefinitely (`extendWindow` is permissionless); it settles only by filling,
   or by the owner covering the prize (`topUp`) and closing early. Entrants of a
   raffle that never fills rely on the owner to do that. Cancelling is allowed
   only before the first entry, when there is nothing to refund.
3. **The per-wallet cap is per wallet, not per person** (`walletCap`: a quarter
   of the raffle, at most 5). One person with many wallets can exceed it; this
   is a stated design choice (brief, Section 11.3).
4. **Geo-restriction is off-chain.** The contract is permissionless; the app
   refuses purchases from blocked countries and regions, a direct contract call
   does not.
5. **D20DAO VRF** is trusted to deliver an unbiased word through
   `rawFulfillRandomness`. The adapter binds the seed to chain, adapter, raffle
   and request, ignores unknown ids, and pays the fee from a float the owner
   funds. D20DAO's own audit status is unverified.
6. **Modulo bias** in `randomWord % entriesSold` is negligible (a 256-bit word
   over at most 2³² entries).
7. **USDC on Arc** is both the gas token (18 decimals, native) and an ERC-20 (6
   decimals at `0x3600…0000`). The contracts move money only through the ERC-20
   view; the adapter's float is the native view.
8. **Fixed 2026-09-27 — `renounceOwnership` was callable.** It was inherited
   from `Ownable` and not overridden. Done once, even by mistake, it would
   have stranded unwithdrawn commission and every underfilled raffle for good.
   It now reverts with `OwnershipCannotBeRenounced`.

## Internal review, 2026-09-27

A line-by-line read of the four in-scope files, with each finding proved by a
test against the contract before it was fixed. All three are fixed.

- **R-1 (Medium): the owner could freeze a draw.** `setRandomnessTimeout` had
  no ceiling; near the uint64 maximum, `requestedAt + randomnessTimeout`
  overflowed and `reRequestRandomness` reverted forever. Now capped at
  `MAX_RANDOMNESS_TIMEOUT` (1 day). Test: `test_timeout_hasACeiling`.
- **R-2 (Low–Medium): a late answer could be re-rolled.** A re-request
  cancelled the request before it, so anyone who saw a late answer in the
  mempool, and disliked it, could re-request first and have the draw rolled
  again. Every request now stays answerable by its own source until one
  settles the draw. Tests: `test_reRequest_*`, and the invariant handler
  answers any request ever made (`fulfilAnyRequest`).
- **R-3 (Low): callback gas could be starved at once.** `setCallbackGas` took
  any value above zero immediately; at 1, every answer ran out of gas, every
  draw went stale, and after a scheduled source took effect every re-request
  went to it, sidestepping the hour's notice. Now at least
  `MIN_CALLBACK_GAS` (150,000; the callback measures about 100k).

Open questions we could not settle, because the coordinator's source is not
public: whether D20DAO's coordinator checks the gas left before calling back
(if not, whoever submits an answer could make one they dislike fail), and
whether its output is a VRF or a beacon.

## Slither

Run locally with Slither 0.11.6, excluding `lib/`, `test/` and `script/`.
**No medium or high findings.** The rest, with our reading:

| Impact        | Finding                                                                          | Our reading                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low           | `reentrancy-benign` in `D20RandomnessAdapter.requestRandomness`                  | The coordinator mints the id, so `requestIdOf` can only be written after the call. `nonReentrant` holds, and a re-entrant fulfilment would find no mapping and be ignored. |
| Low           | `timestamp` in `reRequestRandomness`, `extendWindow`, `activateRandomnessSource` | Compared against minutes, hours and days; validator skew is seconds.                                                                                                       |
| Low           | `timestamp` in `buyerOfEntry`                                                    | A false positive: it compares an index with `entriesSold`.                                                                                                                 |
| Informational | `low-level-calls` in `withdrawFloat`                                             | A native transfer to an owner-chosen address, result checked.                                                                                                              |
| Informational | `naming-convention` on `USDC`, `COORDINATOR`, `RAFFLE`                           | Immutables, named as constants.                                                                                                                                            |

CI fails on medium or higher.

## History worth knowing

- Filling a raffle used to start its draw in the same transaction. A reverting
  coordinator would then have made the final entry fail, so filling and drawing
  were split; the app now asks the last buyer to send `startDraw` as a separate
  transaction.
- Amounts were once handled in the 18-decimal native view; everything now uses
  the 6-decimal ERC-20 view.
- 2026-09-26: `updateRaffle`, `cancelRaffle`, `MIN_PRIZE` (10 USDC) and
  `walletCap` were added; both networks were redeployed.
- 2026-09-27: the randomness source became time-locked, the re-request timeout
  got a floor, and renouncing ownership was refused (issues 1 and 8), found
  while preparing this pack. The delay was set to an hour by the owner.

## Where we would most like your attention

1. The randomness trust model and its fix (issue 1), and whether the residual trust is acceptable.
2. The accounting across `topUp`, `cancelRaffle` and `closeEarly`, where escrow
   moves outside the ordinary enter-draw-claim path.
3. The adapter's float handling and the coordinator interface, which was
   reverse-engineered from bytecode (brief, Section 11.1).
4. Anything that could leave a raffle `Drawing` forever, or a prize unpayable.

Contact: the platform owner. The product brief is `docs/stubby-project-brief.md`;
the flows are in `docs/architecture.md`.
