# 0001 · Arc only at launch

**Status:** Accepted · 2026-09-21

## Context

Participants hold USDC on many chains. Supporting several at launch means a
conversion or bridging layer inside the money path, and a second gas token to
explain. Brief Section 5.

## Decision

Deploy to Arc only. USDC is the native gas token there, so entries, gas, prizes
and commission are all USDC and no conversion layer exists. The contract stays
Arc-native USDC only (Section 11.4).

Cross-chain holders are served in the app, not the contract: App Kit Bridge and
Onramp as a "fund your wallet" step.

## Consequences

- One token end to end. No volatile asset anywhere in the flow.
- **USDC has two views, 10^12 apart, and this bit us.** The native gas token is
  18 decimals; the ERC-20 interface is 6. Contracts move money through ERC-20,
  so every amount in the codebase is **6-decimal** base units, with the native
  view confined to gas math. The first implementation used 18-decimal amounts
  throughout — a 50 USDC prize would have meant 50 trillion — and was corrected
  only after checking Circle's docs. Being explicit about which view a value is
  in is not pedantry here.
- Arc is new, so most users will arrive holding USDC elsewhere. The bridge step
  is therefore adoption-critical, not a nicety.
- Other chains stay deferred. Revisit as a new ADR, not an edit to this one.
