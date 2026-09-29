# 0008 — Hono for the API

**Status:** accepted, 2026-09-22

## Context

The API needs routing, JSON handling, CORS and, soon, sessions, an admin
surface, chain event listeners and notifications. Section 13.1 pins every
dependency exactly and treats each addition as a decision that has to be argued
for, so the framework is not a free choice.

Three candidates:

- **`node:http` with a hand-rolled router.** Zero dependencies, and the most
  code we would own. Routing is easy; CORS, cookie parsing and body limits are
  the sort of thing that is easy to write and easy to get subtly wrong, and this
  API handles authentication.
- **Express.** The obvious default, and a large transitive tree for what it
  does. Its `Request`/`Response` are its own, so testing means a server or
  supertest.
- **Hono.**

## Decision

Hono, with `@hono/node-server`.

**Both have zero dependencies.** That is the argument that settles it in this
repository: the API's entire framework surface is two packages and nothing
transitive, which is a footprint a small team can actually review.

Two consequences follow from its design rather than its size:

- It speaks standard `Request`/`Response`, so `app.request()` drives the real
  routes in a test with no server, no port and no supertest. The SIWE endpoint
  tests are the real app against a real Postgres with real signatures.
- The same app object runs on Node today and on anything with a fetch handler
  later. ADR 0007 keeps the database portable so the Supabase-to-VPS move is one
  environment variable; this keeps the runtime portable for the same reason.

## Consequences

- One more dependency than writing it by hand, and the honest version of that
  trade is: we accept a framework in order not to hand-roll CORS and cookies in
  an authentication path.
- Hono is smaller and younger than Express. If it were abandoned, the port is
  bounded — the app is routes and handlers over standard types, not a framework
  woven through the domain. Nothing below `http/` imports it.
- `createApi()` is a function, not a module-level singleton, so tests inject
  their own stores and no test needs an environment variable to redirect it.

## Revisit when

The API outgrows routing and middleware — background jobs, a queue, scheduled
work — where the question stops being "which router" and becomes "which process
model". Nothing about this decision constrains that.
