/**
 * Which IP made this request.
 *
 * The usual answer — "read `X-Forwarded-For`" — is wrong in a way that turns a
 * rate limiter into a decoration, because that header is a client-supplied
 * string. Anyone can send `X-Forwarded-For: 1.2.3.4` and get a fresh bucket per
 * request, so trusting it unconditionally means the limit does nothing at all
 * against the attacker it exists to stop.
 *
 * It is only trustworthy when a proxy you control appends the real peer address,
 * and then only the entry that proxy added. So this requires the number of
 * trusted proxies to be stated, and counts from the **right** so a forged prefix
 * cannot shift which entry is read.
 *
 * With `TRUSTED_PROXIES` unset, the header is ignored entirely and the socket
 * address is used. That is the correct default: it is right when the API is
 * exposed directly, and when it is behind a proxy it fails by limiting everyone
 * together rather than by limiting nobody.
 */

import type { Context } from 'hono';

/**
 * How many proxies sit in front of this API.
 *
 * 0 means none: ignore the header. 1 means one proxy appends the peer address,
 * so the last entry is real. Anything the client sent before that is noise.
 */
export function trustedProxyCount(): number {
  const raw = process.env.TRUSTED_PROXIES ?? '0';
  const count = Number(raw);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * Pick the client address from a forwarded chain.
 *
 * Exported for tests: the off-by-one here is the whole bug class.
 */
export function clientFromChain(
  forwarded: string | undefined,
  socketAddress: string | undefined,
  trustedProxies: number,
): string {
  const fallback = socketAddress ?? 'unknown';
  if (trustedProxies === 0 || !forwarded) return fallback;

  const chain = forwarded
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (chain.length === 0) return fallback;

  /*
   * Counted from the right.
   *
   * The rightmost entry was added by the closest proxy and is the only one it
   * observed. With one trusted proxy the client is the last entry; with two, the
   * second from last. Counting from the left would read whatever the client sent
   * first, which is the forgeable end.
   */
  const index = chain.length - trustedProxies;
  return chain[index] ?? chain[0] ?? fallback;
}

export function clientIp(c: Context): string {
  // Hono's Node adapter exposes the socket through this binding.
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return clientFromChain(c.req.header('x-forwarded-for'), socket, trustedProxyCount());
}
