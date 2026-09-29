## What and why

<!-- What changes, and which part of docs/stubby-project-brief.md it serves. -->

## Checks

- [ ] Money arithmetic goes through `@stubby/shared`, not a local copy
- [ ] Tests cover the failure path, not just the happy path
- [ ] No secrets added; `.env.example` updated if a new variable appeared
- [ ] Brief or an ADR updated if this changes a documented decision

## Contract changes only

- [ ] State written before any external call (checks-effects-interactions)
- [ ] Cannot freeze a raffle, block a draw, or block a claim (Section 6.1)
- [ ] Gas snapshot reviewed
