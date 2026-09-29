# 0002 · Pin TypeScript to 5.9.x

**Status:** Accepted · 2026-09-21

## Context

TypeScript 7.0 (the native compiler) is current and typechecks this workspace
correctly. But typescript-eslint 8.70.1, the latest release, refuses to load
against it: `typescript-eslint does not support TS 7.0`. Brief Section 13.2
requires lint to pass on every pull request, so the lint toolchain decides.

## Decision

Pin `typescript` to `5.9.3` exactly, with `typescript-eslint` at `8.70.1`.

## Consequences

- Lint, typecheck and tests all run clean today.
- We forgo TS 7's compile speed for now.
- Revisit when typescript-eslint ships TS 7 support. The upgrade should be a
  one-line version bump plus a CI run; nothing in the code depends on 5.x.

## Update, 2026-09-21

Dependabot proposed 5.9.3 → 6.0.3 and the full pipeline passed on it, so the
constraint is narrower than this ADR first assumed: **typescript-eslint is fine
with TypeScript 6, and only rejects 7.** The bump is merged and the repository
now runs 6.0.3.

Dependabot is configured to ignore `typescript >= 7` (`.github/dependabot.yml`)
so the 7.x bump cannot reappear until this ADR is superseded. The title of this
ADR is kept for the record; read it as "pin below TypeScript 7".
