# 0005 · Round up, never down

**Status:** Accepted · 2026-09-21

## Context

`totalEntries × entryPrice = prize + ownerRoi` rarely divides evenly. Something
has to absorb the remainder: the prize, the owner's take, or the entry count.
Brief Section 11.6.

## Decision

Round the entry count (or the entry price) **up**. The prize stays exactly what
was advertised and the owner's take never falls below target. The excess is
always less than one entry price.

Implemented once in `packages/shared/src/raffle.ts`; the admin dashboard shows
the actual take before publishing.

## Consequences

- The advertised prize is always honoured to the cent.
- The owner's ROI is a floor, not an exact figure. `solveRaffle` returns
  `roundedUp` and `roundingGain` so the dashboard can say so plainly.
- Solving for entry price rounds up to a whole cent, not to wei: owners set
  prices people can read.
- Example from the brief: 50 prize, 3 entry, 20 target gives 24 entries, 72
  collected, and the owner takes 22 rather than 20.
