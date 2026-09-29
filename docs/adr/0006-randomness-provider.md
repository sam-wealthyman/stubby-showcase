# 0006 · D20DAO VRF, behind a swappable interface

**Status:** Accepted · 2026-09-21

## Context

"Provably fair" is the core promise, and Arc has no native randomness —
`PREVRANDAO` is 0, and Chainlink's Arc integration does not include VRF. Brief
Section 11.1.

## Decision

Use D20DAO VRF, a live coordinator on Arc mainnet and testnet, paid in USDC at
roughly 0.08 per request. One request per draw, funded from the owner's take.

Sit it behind an `IRandomnessSource` interface so the provider can be replaced —
including by Chainlink VRF if it arrives on Arc — without redeploying the raffle
contract or disturbing raffles in flight. ArcDraw (drand, BLS-verified) is the
fallback, but it is experimental and unaudited, so it is not the default.

## Decision, explicitly rejected

Commit-reveal run by the platform owner. The owner profits from raffles, so an
owner-controlled seed would undermine the fairness promise no matter how the
scheme is constructed.

## Consequences

- Anyone can verify a draw from the chain, which is what Section 8 promises.
- A third party is now in the critical path, so: verify its audit status before
  mainnet, monitor the fee balance, and let _anyone_ re-request if a request is
  not fulfilled in time, so a draw can never hang.
- The randomness fee is a real per-draw cost that ROI has to cover.
