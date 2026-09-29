# Running Stubby locally

Three processes: a database, the API, the app. Every command below was run
before it was written down.

## 1. Database

```bash
./scripts/dev-db.sh
```

Starts Postgres in Docker on port 55432 and applies the migrations. It prints
the connection string the next step wants.

**Throwaway rather than shared, on purpose.** A couple of parallel test runs
can exhaust a shared database's connection limit, and while it is exhausted the
database is simply unreachable — which looks exactly like the API being broken.
This one is yours and you can delete it. Production is our own Postgres on the
VPS (ADR 0009, `docs/deploying.md`); nothing here is specific to either, because
it is plain Postgres with migrations the project owns.

`./scripts/dev-db.sh stop` removes it.

## 2. API

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:55432/stubby?sslmode=disable' \
  pnpm --filter @stubby/api start
```

Expect:

```
stubby-api on :3000 · Arc Testnet · domain localhost:8081
cors: http://localhost:8081
```

Use the pnpm script rather than `node dist/server.js` directly — the script
loads `.env`, and without it the API exits with `SIWE_DOMAIN is not set`.

`.env` stays pointed at testnet; only `DATABASE_URL` is overridden, which is the
rule in `CLAUDE.md`.

## 3. App

```bash
pnpm --filter @stubby/app web
```

The first bundle takes about 20 seconds. Then <http://localhost:8081>.

Expo reads `.env` from `apps/app`, not the repository root, so the app's
public values have to be in the environment. Export only the `EXPO_PUBLIC_*`
lines, never the whole file:

```bash
set -a; eval "$(grep -E '^EXPO_PUBLIC_[A-Z_]*=' .env)"; set +a
pnpm --filter @stubby/app web
```

Without them the app loads but reads nothing ("EXPO_PUBLIC_RAFFLE_ADDRESS is
not set"). `CI=1` in front of `expo start` turns off file watching, so edits
need a restart.

## What to try

### Email sign-in, no wallet needed

1. **Email link** on the welcome screen, or go to `/email`.
2. Any address. It does not have to exist — §4.1 makes email a handle, and the
   first sign-in creates the account.
3. **No mail is sent.** No provider is configured, so the API prints the link to
   its own terminal:

   ```
   ── login link for ru***@example.com ─────────────
      http://localhost:8081/login?token=...
      valid for 10 minutes, once
   ```

   Copy that into the browser. This is why the console mailer refuses to run
   under `NODE_ENV=production`.

4. You land signed in. `/account` shows the address and a sign-out.

Worth trying: open the same link twice. The second says the link is spent,
which is the property that makes a magic link safe rather than a password in
an inbox.

### Wallet sign-in

Needs a browser wallet on **Arc testnet** (chain 5042002, RPC
`https://rpc.testnet.arc.io`). The Connect screen adds the network if the wallet
offers to.

1. `/connect` → pick a wallet → approve.
2. **Sign in with this wallet** → sign the message. Nothing is spent; it is a
   signature, not a transaction.

### The part worth testing most

Sign in **by email first**, then connect a wallet. The button should say
**"Link this wallet to my account"** rather than "Sign in with this wallet", and
afterwards `/account` should show one account holding both.

That was a real bug: the two paths used to produce two accounts for one person.
It is fixed and has been verified with scripts — but not once by a human with a
wallet, which is the whole reason this document exists.

### Buying a ticket

Needs testnet USDC and an open raffle. There is none open right now — every
raffle on testnet is complete. Creating one is the admin screen (`/admin/new`,
owner only) or `docs/mainnet-deploy.md`'s approach pointed at testnet.

## End-to-end tests

`pnpm e2e` runs the whole system and drives it in a browser: the built app, the
real API on your local Postgres, and the real `StubbyRaffle` on Anvil (under
Arc testnet's chain id, with the mock USDC placed at Arc's USDC address). A test
wallet announces itself like an extension and forwards every request to Anvil's
unlocked accounts, so the only thing automated is the person pressing Approve.

```sh
./scripts/dev-db.sh
DATABASE_URL='postgresql://postgres:postgres@localhost:55432/stubby?sslmode=disable' pnpm e2e
```

It needs Foundry (`anvil`, `forge`) and Chromium (`pnpm --filter @stubby/e2e
exec playwright install chromium`). To use a Chrome that is already running
instead, start it with `--remote-debugging-port=9222` and set
`E2E_CDP_URL=http://127.0.0.1:9222`. `E2E_SKIP_BUILD=1` reuses the last build
when only the tests changed. CI runs the same suite on every pull request.

What it covers: email sign-in and sign-out, a spent link refused, connecting a
wallet and signing in with it, buying tickets (approve, then enter), a
permissionless draw, and the winner claiming. Not yet: Claim recovery's retry
and redirect, switching network, and the owner screens.

## What a person has not yet done

Since 2026-09-26 a person has bought tickets, won, taken ownership and topped
up the randomness adapter from the admin screens, and received push on an
Android phone. These have run in the end-to-end suite and from scripts, but not
yet with a person approving in a real wallet:

- switching network from a wallet's own prompt
- a claim through Claim recovery (retry, or another address)
- editing or cancelling a draw from the control room
