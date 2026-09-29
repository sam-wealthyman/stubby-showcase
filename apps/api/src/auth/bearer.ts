/**
 * Finding the session token on a request.
 *
 * Two places, because there are two kinds of client. The web build keeps the
 * session in an httpOnly cookie, which JavaScript cannot read and so an XSS
 * cannot steal. The native build holds a bearer token in secure storage,
 * because React Native's cookie handling is not worth relying on.
 *
 * Its own module because the parsing is fiddlier than it looks — a scheme that
 * is matched case-sensitively, or a header split on the wrong thing, fails by
 * rejecting a valid session rather than by accepting an invalid one, which is
 * the harder failure to notice.
 */

/** RFC 7235 says the scheme is case-insensitive. Clients vary; browsers send `Bearer`. */
const BEARER = /^bearer\s+(.+)$/i;

export function tokenFromAuthorization(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = BEARER.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/**
 * The token for this request, preferring the explicit header.
 *
 * A caller that sent `Authorization` meant it. If both are present they are
 * probably the same session anyway, but silently preferring the cookie would
 * make a native client's explicit choice depend on what a browser once stored.
 */
export function sessionTokenFrom(input: {
  authorization?: string | undefined;
  cookie?: string | undefined;
}): string | undefined {
  return tokenFromAuthorization(input.authorization) ?? input.cookie ?? undefined;
}
