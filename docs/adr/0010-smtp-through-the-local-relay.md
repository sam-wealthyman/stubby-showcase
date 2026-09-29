# 0010 · SMTP through the local relay, written rather than depended on

**Status:** Accepted · 2026-09-23

## Context

Email login (Section 4.1) has been finished on both sides — the API issues and
verifies single-use links, and the app has the screens — with no way to deliver
the mail. Production has been running `createUnconfiguredMailer()`, which throws
rather than pretending, so `/auth/email/request` answers 502.

ADR 0009 put the app on a VPS that already runs Postfix with OpenDKIM for the
neighbouring domains. So there is a submission agent on loopback that already
does the difficult parts of sending mail: queueing, retries, MX lookup, DKIM
signing, bounce handling.

That leaves one question: how the API hands a message to it.

## Decision

Write the SMTP client, in `apps/api/src/mail/smtp.ts`. No new dependency.

`Mailer` stays the seam. A hosted provider later means a new implementation of
that interface, not a change to the login flow.

## Consequences

- **The target is narrow enough to be written correctly.** One conversation —
  greet, envelope, data, quit — to a relay on loopback that wants no
  authentication and offers no TLS, because there is no network between us and
  it. No AUTH, no STARTTLS, no pipelining, no connection reuse, no delivery to a
  remote MX. Every one of those is where an SMTP library earns its keep, and
  none of them is in scope.
- **It keeps the dependency list honest.** ADR 0008 took Hono partly for having
  no dependencies; the API's runtime list is five entries. `nodemailer` is a
  fine library and the usual answer, and most of what it would do here is
  already Postfix's job.
- **The parts that are security bugs rather than bounces are tested by
  mutation.** Header injection through a recipient address, a reply reader that
  stops at the first line of a multi-line `EHLO` and desynchronises everything
  after it, and an envelope built from a display name: each was broken on
  purpose and the suite was confirmed to fail. The tests drive a real TCP
  server speaking the real protocol, because the bugs live in the bytes on the
  wire and a mock would reproduce whatever I believed those bytes were.
- **Bodies are base64.** That makes line length, 8-bit content and dot-stuffing
  non-issues by construction rather than by care. Dot-stuffing is implemented
  anyway, because relying on the encoding to make it unreachable is the kind of
  argument that stops being true when someone changes the encoding.
- **This bounds where it may be used.** Widen the target — credentials, a public
  port, a hosted provider — and this file stops being the right answer. The
  comment at the top of it says so, and this ADR is what it points at.
- **Deliverability is now a DNS problem, not a code problem.** The relay signs
  with DKIM only for domains in its list, so the sending domain has to be in
  that list and publish a matching key. `docs/deploying.md` covers it.

## Revisit when

Mail needs to leave from somewhere that is not this box — a second API instance,
a managed host, or a provider chosen for deliverability reporting. At that point
write a `Mailer` against that provider's HTTP API; do not grow this file into a
general SMTP client.
