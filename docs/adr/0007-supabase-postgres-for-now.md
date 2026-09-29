# 0007 · Supabase for Postgres, and only for Postgres

**Status:** Superseded by [0009](0009-postgres-and-the-app-on-our-own-vps.md) · 2026-09-23
**Originally:** Accepted · 2026-09-22

> Kept because the constraint it imposed is why the migration was cheap:
> plain SQL and a standard driver, nothing Supabase-specific. Moving off
> it changed no application code. The reasoning below is still the
> reasoning for staying portable.

## Context

The API needs a database for accounts, linked wallets and a mirror of on-chain
raffle state (Section 10). Section 1 says Stubby is "fully owned and operated by
the platform owner (no third-party hosts)", which points at self-hosting, and a
VPS already running another project was considered.

Self-hosting was deferred: it is a real amount of operations work — TLS,
backups, Postgres tuning, systemd hardening, isolation from the other tenant —
before a single screen can talk to a database.

## Decision

Use Supabase for managed Postgres now. Project `ehfuxfacsaxpuwonsxjs` in the
Starterdot organisation, `eu-west-1`, matching the existing projects.

**Supabase is the database and nothing else.** Email magic links, X OAuth and
session handling are ours. SIWE already is (ADR-less, see Section 4.1 and
`packages/shared/src/siwe.ts`).

## Consequences

- This is a third-party host, which sits against Section 1. It is accepted as
  temporary, and the constraints below are what keep it temporary rather than
  permanent by accident.
- **Migrating away must stay a matter of repointing `DATABASE_URL`.** That holds
  only if nothing depends on Supabase beyond Postgres itself. So:
  - plain SQL and a standard Postgres driver, no `supabase-js` in the API
  - no PostgREST, no Edge Functions, no Storage
  - authorisation in the API, not in Row Level Security. RLS is a fine mechanism
    but it is reached through Supabase's own auth, and adopting it would put
    identity in the platform we are trying to stay portable from
  - migrations as SQL files the project owns, runnable against any Postgres
- Supabase pauses free-tier projects after inactivity. A paused project means a
  dead API, so this is a launch blocker on the free tier regardless of anything
  else: either the project is on a paid plan before real users, or the VPS move
  happens first.
- **TLS is verified only if `DATABASE_CA_CERT` is set.** The pooler requires
  TLS but presents a certificate signed by Supabase's own CA, which no system
  trust store carries. With the variable unset, `apps/api/src/db/pool.ts`
  connects with verification off: the connection is encrypted, but nothing
  proves the far end is the database. That is acceptable against a throwaway
  project on a laptop and is not acceptable in production, where the connection
  carries every nonce and every wallet address. `pnpm check:env` warns while it
  is unset. Note that the VPS move does not make this go away — it replaces a
  downloaded CA with one we issue.

- The chain remains the source of truth for entries and prizes (Section 4.2), so
  losing the database costs login mappings and notification preferences, never
  funds. That is what makes a managed database an acceptable interim risk.

## Revisit when

Any of: real users, a paid Supabase plan becoming the cheaper option than the
VPS, or the operations work being done anyway for other reasons. The migration
is then a `pg_dump`, a restore, and one environment variable.
