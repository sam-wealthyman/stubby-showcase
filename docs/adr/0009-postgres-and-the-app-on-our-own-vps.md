# 0009 · Postgres and the app on our own VPS

**Status:** Accepted · 2026-09-23
**Supersedes:** [0007](0007-supabase-postgres-for-now.md)

## Context

ADR 0007 took Supabase for managed Postgres and said to revisit on "real users,
a paid plan becoming cheaper than the VPS, or the operations work being done
anyway". What actually forced it was the free tier's daily limits interrupting
ordinary development, and the session pooler's 15-client ceiling, which the API
tests hit twice hard enough to fail.

Section 1 says Stubby is "fully owned and operated by the platform owner (no
third-party hosts)", so this direction was always the intended one.

## Decision

Run Postgres and serve the app from the VPS at `23.95.168.183`, alongside the
existing tenant, at `stubby.starterdot.com`.

- **Postgres 15** on loopback only, `max_connections = 40`. Not reachable from
  the network at all, so the only way in is a process on the box.
- **The app is a static Expo web export** in the Virtualmin document root, and
  the **API is a systemd service** on `127.0.0.1:3000`, proxied by Apache at
  `/api`. One origin for both: the session cookie is same-site and there is no
  CORS in the browser path at all.
- **TLS on the database connection, verified.** Postgres holds a self-signed
  certificate and `DATABASE_CA_CERT` points the API at that exact file.

## Consequences

- **ADR 0007's portability constraint paid for itself.** Because nothing used
  `supabase-js`, PostgREST, Edge Functions or RLS-as-authz, the migration was
  repointing `DATABASE_URL` and running the existing SQL migrations. No
  application code changed. The rule to keep is the same one: plain SQL, a
  standard driver, migrations the project owns.
- **The connection is now verified, which it never was on Supabase.** 0007 noted
  that with `DATABASE_CA_CERT` unset the API connects with verification off —
  encrypted, but with nothing proving the far end is the database. Issuing the
  certificate ourselves is what closes that, and it is the reason the loopback
  connection is _not_ simply set to `sslmode=disable`: an unverified connection
  and a disabled one are both weaker than a pinned one, and pinning costs one
  file.
- **Backups are ours now.** A verified dump runs nightly and keeps 14 days
  (`docs/deploying.md`). They are on-box only, which survives losing the
  database and not losing the box; an off-box destination is what remains of
  this item. The chain stays the source of truth for entries and prizes
  (Section 4.2), so what a lost database costs is login mappings and linked
  wallets — recoverable by signing in again, but a real interruption.
- **We share a box with another tenant.** `max_connections = 40` and
  `shared_buffers = 64MB` are sized for 962MB of RAM with someone else on it,
  and the API unit carries `MemoryMax=220M` so that a leak here cannot take the
  neighbour down. Node 22 is installed at `/opt/node22` rather than over the
  system Node 20 the other project runs on.
- **Certificate renewal depends on port 80 staying open** for the ACME
  challenge, which is why the HTTPS redirect exempts `/.well-known/`.

## Revisit when

The box runs out of room — either RAM, or the point where the neighbour's load
and ours start interfering. The next step is a dedicated box, not a managed
database: the portability constraint above is what keeps that cheap.
