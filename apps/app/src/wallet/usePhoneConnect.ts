import { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { useConnect, useConnectors, type Connector } from 'wagmi';

import {
  PHONE_WALLETS,
  requestLink,
  sessionLink,
  tapStillCounts,
  type PhoneWallet,
} from '@/wallet/walletApps';
import { NATIVE, deviceUserAgent } from '@/wallet/device';

/**
 * Connecting an installed wallet app from a phone's browser, over WalletConnect.
 *
 * The conventional mobile flow: tap the wallet, the phone switches to it with
 * the session to approve, and switching back finds Stubby connected. After
 * that, every request that needs the wallet (a signature, a purchase, adding
 * Arc) brings the same app forward, so nobody has to go and find it.
 */

const REMEMBERED = 'stubby.phoneWallet';

/** Requests the person approves in the wallet app, so the app is brought forward for them. */
const NEEDS_WALLET = new Set([
  'eth_sendTransaction',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]);

/** The app has no localStorage; the chosen wallet is remembered for the session. */
let rememberedInApp: PhoneWallet['id'] | undefined;

function remember(id: PhoneWallet['id']) {
  rememberedInApp = id;
  try {
    globalThis.localStorage?.setItem(REMEMBERED, id);
  } catch {
    // A private window can refuse storage; the connection still works.
  }
}

function remembered(): PhoneWallet | undefined {
  try {
    const id = globalThis.localStorage?.getItem(REMEMBERED) ?? rememberedInApp;
    return PHONE_WALLETS.find((w) => w.id === id);
  } catch {
    return undefined;
  }
}

function go(href: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.href = href;
  else if (NATIVE) void Linking.openURL(href).catch(() => undefined);
}

/**
 * How long to wait for WalletConnect's relay to hand over a session link,
 * counted from when WalletConnect has loaded, not from the tap. Loading it is
 * a download (hundreds of kilobytes) that a phone on a weak signal can take
 * well over twelve seconds to finish, and that is not the relay's fault.
 */
export const SESSION_LINK_TIMEOUT_MS = 12_000;
/** How long the download itself may take before the person is told. */
export const LOAD_TIMEOUT_MS = 45_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ]);
}

export function usePhoneConnect() {
  const connectors = useConnectors();
  const wc = connectors.find((c) => c.type === 'walletConnect');
  const { connectAsync } = useConnect();
  const [error, setError] = useState<Error | null>(null);
  /** The wallet tapped, while the person approves in it. */
  const [pending, setPending] = useState<PhoneWallet | null>(null);
  /** The session link, once the relay has made one. */
  const [link, setLink] = useState<string | null>(null);
  /** Whether the wallet was opened for them, or needs a tap on "Open". */
  const [opened, setOpened] = useState(false);

  // Start WalletConnect before the tap, so the wallet opens the moment it
  // comes rather than after the relay has been dialled.
  useEffect(() => {
    void wc?.getProvider().catch(() => undefined);
  }, [wc]);

  const abandon = async () => {
    const provider = (await wc?.getProvider().catch(() => undefined)) as
      { abortPairingAttempt?: () => void } | undefined;
    provider?.abortPairingAttempt?.();
  };

  const connect = async (wallet: PhoneWallet) => {
    if (!wc) return;
    setError(null);
    setLink(null);
    setOpened(false);
    setPending(wallet);
    remember(wallet.id);
    const tappedAt = Date.now();

    // First, WalletConnect itself has to have arrived on the phone.
    const loaded = await within(
      wc.getProvider().then(
        () => 'ready' as const,
        () => 'failed' as const,
      ),
      LOAD_TIMEOUT_MS,
    );
    if (loaded !== 'ready') {
      setPending(null);
      setError(
        new Error(
          loaded === 'timeout'
            ? 'This is taking too long. Check your signal.'
            : "We couldn't load the wallet connection. Please try again.",
        ),
      );
      return;
    }

    let gotLink = false;
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type !== 'display_uri' || typeof data !== 'string') return;
      gotLink = true;
      const userAgent = deviceUserAgent();
      const href = sessionLink(wallet, data, userAgent);
      setLink(href);
      // The app opens another app with no browser rule about recent taps.
      if (NATIVE || tapStillCounts(tappedAt, Date.now(), userAgent)) {
        setOpened(true);
        go(href);
      }
    };
    // A relay that never answers must not leave the screen waiting forever.
    const timer = setTimeout(() => {
      if (gotLink) return;
      void abandon();
      setPending(null);
      setError(new Error("We couldn't reach WalletConnect. Check your connection."));
    }, SESSION_LINK_TIMEOUT_MS);
    wc.emitter.on('message', onMessage);
    try {
      await connectAsync({ connector: wc });
      await bringWalletForRequests(wc);
    } catch (e) {
      if (gotLink) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      clearTimeout(timer);
      wc.emitter.off('message', onMessage);
      setPending(null);
      setLink(null);
    }
  };

  return {
    available: wc !== undefined,
    connect,
    error,
    pending,
    /** Open the wallet again: a tap always gets through where a redirect may not. */
    reopen: () => {
      if (link) go(link);
    },
    ready: link !== null,
    opened,
    cancel: () => {
      void abandon();
      setPending(null);
      setLink(null);
    },
  };
}

const patched = new WeakSet<object>();

/**
 * Bring the chosen wallet app forward whenever a request needs it.
 *
 * WalletConnect delivers the request to the wallet over its relay, but the
 * phone is still showing the browser; without this the person would have to
 * switch apps themselves, with nothing telling them to. Safe to call more
 * than once: a provider is only wrapped the first time.
 */
export async function bringWalletForRequests(connector: Connector): Promise<void> {
  if (connector.type !== 'walletConnect') return;
  const wallet = remembered();
  const link = wallet ? requestLink(wallet) : undefined;
  if (!link) return;
  const provider = (await connector.getProvider().catch(() => undefined)) as
    { request: (args: { method: string; params?: unknown }) => Promise<unknown> } | undefined;
  if (!provider || patched.has(provider)) return;
  patched.add(provider);
  const original = provider.request.bind(provider);
  provider.request = (args) => {
    const pending = original(args);
    if (NEEDS_WALLET.has(args.method)) go(link);
    return pending;
  };
}

/**
 * Start loading WalletConnect on a phone as soon as the sign-in screen opens,
 * so it has usually arrived by the time someone reaches Connect and taps a
 * wallet. Nothing is connected or asked for; it only fetches the code.
 */
export function useWarmWalletConnect(): void {
  const connectors = useConnectors();
  const wc = connectors.find((c) => c.type === 'walletConnect');
  useEffect(() => {
    if (!wc) return;
    if (!NATIVE && !/Android|iPhone|iPad|iPod|Mobile/i.test(deviceUserAgent())) return;
    void wc.getProvider().catch(() => undefined);
  }, [wc]);
}
