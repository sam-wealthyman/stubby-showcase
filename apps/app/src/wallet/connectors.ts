/**
 * How a wallet reaches the app — the **web** build.
 *
 * Metro resolves platform suffixes before the bare name, so this file is the
 * web (and default) implementation and a `connectors.native.ts` beside it will
 * be the Android one. TypeScript has no such rule: it resolves `./connectors`
 * to this file and typechecks each on its own, so both must export the same
 * shape. That is deliberate — everything above this module is shared.
 *
 * There is no AppKit or other vendor modal. Section 12.1 says every screen is
 * built from Stubby's own visual language, and Section 12.6 already designs the
 * Connect screen with "choose a wallet" as one of its three states. A dropped-in
 * modal would replace a designed screen with someone else's.
 *
 * ## The two connectors here
 *
 * **EIP-6963 needs none.** It is a browser standard: every installed wallet
 * announces itself, and wagmi's `multiInjectedProviderDiscovery` (enabled in
 * `config.ts`) turns each announcement into a connector carrying the wallet's
 * own name and icon. The desktop picker is a list of what is really installed.
 *
 * `injected()` is for the wallet browsers that set `window.ethereum` without
 * announcing themselves; without it such a browser finds nothing. It comes
 * from `wagmi` itself. The Connect screen shows it only when nothing announced
 * itself (`pickableConnectors`), so it never duplicates a named wallet.
 *
 * **WalletConnect** is how a phone's browser reaches an installed wallet app:
 * the phone jumps to the wallet to approve and comes back connected (see
 * `usePhoneConnect`). It was once left out, for three reasons that are now
 * each handled:
 *
 *   1. `wagmi/connectors` is a barrel that eagerly imports `porto`, whose
 *      nested `ox` ships raw .ts sources Metro cannot follow, so the web build
 *      failed outright. `metro.config.js` maps `@stubby/wagmi-walletconnect` to
 *      the one self-contained connector file, and the barrel is never reached.
 *   2. wagmi marks the connector deprecated for `pino@7` under WalletConnect's
 *      logger. `pnpm-workspace.yaml` overrides it to pino 10, wagmi's own fix.
 *   3. Newer `@walletconnect/ethereum-provider` releases are not Apache-2.0.
 *      The lockfile holds 2.21.1, the last one that is, and every package it
 *      brings (Sign Client, Universal Provider, AppKit 1.7.8) is Apache-2.0 or
 *      MIT at the versions installed.
 *
 * Its QR modal is off: there is no vendor modal (above), and on a phone the
 * right move is straight to the wallet app, which the Connect screen does.
 */

import { walletConnect } from '@stubby/wagmi-walletconnect';
import { injected, type CreateConnectorFn } from 'wagmi';

import { NATIVE } from './device';

const PROJECT_ID = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';
const SITE = process.env.EXPO_PUBLIC_SIWE_URI ?? 'https://stubby.starterdot.com';

export function walletConnectors(): CreateConnectorFn[] {
  // The native app has no browser for a wallet to inject into.
  const inBrowser = NATIVE ? [] : [injected()];
  if (!PROJECT_ID) return inBrowser;
  return [
    ...inBrowser,
    quickToRestore(
      walletConnect({
        projectId: PROJECT_ID,
        showQrModal: false,
        // What the wallet shows on its approval screen.
        metadata: {
          name: 'Stubby',
          description: 'Tear a stub, win USDC. Provably fair raffles on Arc.',
          url: SITE,
          icons: [`${SITE.replace(/\/$/, '')}/app-icons/icon-192.png`],
          // Where the wallet sends the person back after they approve.
          redirect: { native: 'stubby://', universal: SITE },
        },
      }),
    ),
  ];
}

/** Longest a page load waits on WalletConnect to say whether a session is live. */
export const RESTORE_TIMEOUT_MS = 4000;

/**
 * WalletConnect, without holding up every page load.
 *
 * On load wagmi asks each connector whether it is still connected, and shows
 * nothing until all have answered. WalletConnect answers by dialling its
 * relay, so a slow or blocked relay left the Connect screen on "Checking for
 * a connected wallet" for good. Now it only asks when WalletConnect was the
 * last way this browser connected (wagmi's own record of that), and even then
 * gives up after a few seconds and treats the session as gone.
 */
function quickToRestore(create: CreateConnectorFn): CreateConnectorFn {
  return (config) => {
    const connector = create(config);
    return {
      ...connector,
      async isAuthorized() {
        if (!lastUsedWalletConnect()) return false;
        return Promise.race([
          connector.isAuthorized.call(this),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), RESTORE_TIMEOUT_MS)),
        ]).catch(() => false);
      },
    };
  };
}

function lastUsedWalletConnect(): boolean {
  // In the app WalletConnect is the only connector, so always ask; the
  // timeout above still bounds the wait.
  if (NATIVE) return true;
  try {
    return globalThis.localStorage?.getItem('wagmi.recentConnectorId') === '"walletConnect"';
  } catch {
    return false;
  }
}

/** Whether a phone wallet can be connected over WalletConnect in this build. */
export const WALLET_CONNECT_AVAILABLE = PROJECT_ID !== '';
