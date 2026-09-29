# 0003 · One contract for all raffles, not a factory

**Status:** Accepted · 2026-09-21

## Context

Each raffle could be its own contract instance (factory) or a row in one
contract keyed by id. Brief Section 11.7.

## Decision

A single non-upgradeable contract managing every raffle by id. New versions are
new deployments that take new raffles; older versions keep running and settling
the raffles they already hold.

## Consequences

- Cheaper per raffle, one address for users and indexers, one audit surface.
- Isolation has to be built rather than inherited: each raffle's escrow, owed
  prize and owed commission are accounted separately, so a stuck or unclaimed
  prize in one raffle cannot affect another (Section 6.1).
- No upgrade path means a bug is fixed by deploying a new version, so the
  migration story must exist before mainnet.
- Ownership transfer is two-step and can never be renounced (Section 13.3).
