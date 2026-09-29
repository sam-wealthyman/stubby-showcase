/**
 * Deciding what linking a wallet should do.
 *
 * Section 4.2 lets an account hold more than one wallet, which means three
 * situations that look alike and must not be treated alike:
 *
 *   - the wallet belongs to nobody — link it;
 *   - the wallet already belongs to **this** account — say yes and change
 *     nothing, because pressing the button twice is not an error;
 *   - the wallet belongs to **another** account — refuse, always.
 *
 * The third is the one that matters. Entries and prizes belong to the wallet
 * (Section 4.2), so moving a wallet between logins would move who can see them,
 * and a link that silently reassigned would be a way to take over somebody
 * else's history by signing a message they cannot see. There is no "force"
 * variant of this on purpose: unlinking is the owner's to do first.
 *
 * Pure. The proof of control is checked elsewhere; this only decides what a
 * proven signature entitles the caller to.
 */

export type LinkDecision =
  /** Not linked to anyone. Link it. */
  | { kind: 'link' }
  /** Already this account's. Nothing to do, and that is a success. */
  | { kind: 'already-yours' }
  /** Another account holds it. Refused. */
  | { kind: 'taken' };

export function decideLink(input: {
  /** The account asking, from a valid session. */
  accountId: string;
  /** Who currently holds the wallet, or null when nobody does. */
  currentOwner: string | null;
}): LinkDecision {
  const { accountId, currentOwner } = input;
  if (currentOwner === null) return { kind: 'link' };
  // Compared as strings: these are BIGSERIAL ids that pg returns as text, and
  // converting to Number would work for a long time and then silently collide.
  if (currentOwner === accountId) return { kind: 'already-yours' };
  return { kind: 'taken' };
}

export function linkMessage(decision: LinkDecision): string {
  switch (decision.kind) {
    case 'link':
      return 'Linked. Tickets bought with this wallet will show under your account.';
    case 'already-yours':
      return 'That wallet is already on your account.';
    case 'taken':
      return 'This wallet belongs to another Stubby account with its own email or X login. Sign in with that account to use it, or remove the wallet there first.';
  }
}
