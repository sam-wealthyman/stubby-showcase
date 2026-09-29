/**
 * Public usernames: what shows in place of a wallet address in live activity.
 *
 * One rule, shared by the API (which enforces it) and the app (which says why
 * before sending), so the two never disagree about a name.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/** Names that would pass as Stubby itself, or as staff, in a public feed. */
const RESERVED = new Set([
  'admin',
  'administrator',
  'stubby',
  'support',
  'help',
  'owner',
  'official',
  'team',
  'staff',
  'moderator',
  'mod',
  'system',
  'root',
  'null',
  'undefined',
  'anonymous',
]);

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; reason: 'length' | 'characters' | 'start' | 'reserved'; message: string };

export function checkUsername(raw: string): UsernameCheck {
  const username = raw.trim();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return {
      ok: false,
      reason: 'length',
      message: `${USERNAME_MIN} to ${USERNAME_MAX} characters.`,
    };
  }
  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    return { ok: false, reason: 'characters', message: 'Letters, numbers and _ only.' };
  }
  if (!/^[A-Za-z]/.test(username)) {
    return { ok: false, reason: 'start', message: 'Start with a letter.' };
  }
  if (RESERVED.has(username.toLowerCase().replace(/_/g, ''))) {
    return { ok: false, reason: 'reserved', message: 'That name is reserved.' };
  }
  return { ok: true, username };
}
