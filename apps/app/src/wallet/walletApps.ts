/**
 * Connecting a wallet from a phone's browser, the way phones do it.
 *
 * A phone browser has no wallet extension, so EIP-6963 finds nothing there.
 * WalletConnect is how a mobile site reaches an installed wallet app: Stubby
 * opens a session, the phone jumps to the chosen wallet with the session's
 * `wc:` address, the person approves there, and comes back to the browser
 * already connected. Later requests to sign or pay bring that same app
 * forward the same way.
 *
 * The links are each wallet's own, as the WalletConnect registry lists them.
 * On iOS the universal link (`https://…`) opens the app. On Android it often
 * does not: Chrome loads it as a web page, which is the wallet's download
 * page, so Android uses the app's own scheme (`metamask://…`), which only the
 * installed app answers.
 */
export interface PhoneWallet {
  id: 'metamask' | 'trust' | 'rainbow' | 'other';
  name: string;
  /** Universal link base, without a trailing slash. Undefined for "other". */
  universal?: string;
  /** The app's own scheme, to bring it forward for a request. */
  native?: string;
}

export const PHONE_WALLETS: readonly PhoneWallet[] = [
  {
    id: 'metamask',
    name: 'MetaMask',
    universal: 'https://metamask.app.link',
    native: 'metamask://',
  },
  {
    id: 'trust',
    name: 'Trust Wallet',
    universal: 'https://link.trustwallet.com',
    native: 'trust://',
  },
  { id: 'rainbow', name: 'Rainbow', universal: 'https://rnbwapp.com', native: 'rainbow://' },
  // Any other WalletConnect wallet. Android hands a bare `wc:` link to
  // whichever wallets are installed; iOS has no such chooser.
  { id: 'other', name: 'Another wallet' },
];

/** Where to send the phone so the wallet can approve a new session. */
export function sessionLink(wallet: PhoneWallet, uri: string, userAgent = ''): string {
  const session = `wc?uri=${encodeURIComponent(uri)}`;
  if (/Android/i.test(userAgent) && wallet.native) return `${wallet.native}${session}`;
  if (!wallet.universal) return uri;
  return `${wallet.universal}/${session}`;
}

/** Where to send the phone so the wallet comes forward for a request. */
export function requestLink(wallet: PhoneWallet): string | undefined {
  return wallet.native;
}

/**
 * How long after a tap the browser still treats a navigation as the person's.
 *
 * A phone hands a wallet's link to the installed app only when the page was
 * opened by a tap; a page opened later by script is loaded in the browser
 * instead, and a wallet's link loaded there is its download page. Chrome
 * keeps a tap's permission for five seconds and Safari for about one, so a
 * session link that arrives later than this is offered as a button to tap.
 */
export function tapStillCounts(tappedAt: number, now: number, userAgent: string): boolean {
  const window = /iPhone|iPad|iPod|Macintosh/i.test(userAgent) ? 900 : 4_000;
  return now - tappedAt < window;
}

/** The wallets a phone can offer: "Another wallet" only where the OS can route it. */
export function phoneWalletsFor(userAgent: string): PhoneWallet[] {
  const android = /Android/i.test(userAgent);
  return PHONE_WALLETS.filter((w) => w.id !== 'other' || android);
}

/**
 * A phone or tablet browser.
 *
 * iPadOS reports itself as a Mac, so a Mac with a touch screen counts; no real
 * Mac has one.
 */
export function isPhoneBrowser(userAgent: string, maxTouchPoints = 0): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/**
 * The wallets worth listing.
 *
 * `injected()` is in the config for wallet browsers that expose
 * `window.ethereum` without announcing themselves over EIP-6963. It is only
 * shown when no wallet announced itself and a provider actually exists;
 * otherwise it is a duplicate of a named wallet, or a row that opens nothing.
 */
export function pickableConnectors<T extends { id: string; type: string }>(
  connectors: readonly T[],
  hasProvider: boolean,
): T[] {
  const announced = connectors.some((c) => c.type === 'injected' && c.id !== 'injected');
  return connectors.filter(
    (c) =>
      // WalletConnect is offered as the phone wallets, not as a row of its own.
      c.type !== 'walletConnect' && (c.id !== 'injected' || (!announced && hasProvider)),
  );
}
