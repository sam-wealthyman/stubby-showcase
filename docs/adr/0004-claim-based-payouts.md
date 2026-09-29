# 0004 · Winners claim; the contract never pushes

**Status:** Accepted · 2026-09-21

## Context

At draw time the contract could push USDC to the winner. A push can fail — the
winner's address may be a contract that reverts, or USDC-blocklisted — and a
failed push inside the draw would leave the draw itself stuck. Brief Section 6.1.

## Decision

The draw only selects a winner and records the prize as owed. Payout is a
separate `claim` the winning wallet makes. Commission works the same way:
recorded as owed, withdrawn by `withdrawCommission`.

A claim is atomic — mark paid and transfer in one transaction, so a failed
transfer reverts the whole thing and the prize stays owed. Retryable forever,
with no deadline. `claimTo(recipient)`, authorised only by the winning wallet,
covers a winning address that can never receive.

## Consequences

- A raffle can never freeze. The draw completes regardless of what happens to
  the claim, and nothing about a claim can reopen or block it.
- The winner pays their own claim gas, which settles who pays for payout.
- Only the wallet that won can claim, so no backend can redirect funds.
- Unclaimed prizes sit in the contract indefinitely, so the holdings invariant
  must account for them: escrow + unclaimed prizes + commission, exactly.
- The app owes the winner a clear unclaimed state and a retry affordance.
