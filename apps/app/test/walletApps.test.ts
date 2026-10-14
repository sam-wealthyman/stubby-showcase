import { describe, expect, it } from 'vitest';

import {
  PHONE_WALLETS,
  isPhoneBrowser,
  phoneWalletsFor,
  pickableConnectors,
  requestLink,
  sessionLink,
  tapStillCounts,
} from '@/wallet/walletApps';

describe('sessionLink', () => {
  const uri = 'wc:abc@2?relay-protocol=irn&symKey=123';

  it('opens the chosen wallet with the session, by its universal link', () => {
    const metamask = PHONE_WALLETS.find((w) => w.id === 'metamask')!;
    expect(sessionLink(metamask, uri)).toBe(
      'https://metamask.app.link/wc?uri=wc%3Aabc%402%3Frelay-protocol%3Dirn%26symKey%3D123',
    );
  });

  it('opens it by its own scheme on Android, where the universal link loads a download page', () => {
    const metamask = PHONE_WALLETS.find((w) => w.id === 'metamask')!;
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36';
    expect(sessionLink(metamask, uri, android)).toBe(
      'metamask://wc?uri=wc%3Aabc%402%3Frelay-protocol%3Dirn%26symKey%3D123',
    );
  });

  it('hands another wallet the bare session link', () => {
    const other = PHONE_WALLETS.find((w) => w.id === 'other')!;
    expect(sessionLink(other, uri)).toBe(uri);
  });
});

describe('requestLink', () => {
  it('brings the wallet forward by its own scheme', () => {
    expect(requestLink(PHONE_WALLETS.find((w) => w.id === 'trust')!)).toBe('trust://');
    expect(requestLink(PHONE_WALLETS.find((w) => w.id === 'other')!)).toBeUndefined();
  });
});

describe('phoneWalletsFor', () => {
  it('offers "another wallet" only on Android, where the OS can route it', () => {
    const android = phoneWalletsFor('Mozilla/5.0 (Linux; Android 14) Mobile');
    const iphone = phoneWalletsFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    expect(android.map((w) => w.id)).toContain('other');
    expect(iphone.map((w) => w.id)).not.toContain('other');
  });
});

describe('isPhoneBrowser', () => {
  it('knows a phone, an iPad posing as a Mac, and a desktop', () => {
    expect(isPhoneBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe(
      true,
    );
    expect(isPhoneBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
    expect(isPhoneBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isPhoneBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isPhoneBrowser('Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0')).toBe(false);
  });
});

describe('pickableConnectors', () => {
  const generic = { id: 'injected', type: 'injected' };
  const metamask = { id: 'io.metamask', type: 'injected' };

  it('hides the generic provider when a wallet announced itself', () => {
    expect(pickableConnectors([generic, metamask], true)).toEqual([metamask]);
  });

  it('offers it in a wallet browser that only sets window.ethereum', () => {
    expect(pickableConnectors([generic], true)).toEqual([generic]);
  });

  it('never lists WalletConnect itself; it is offered as the phone wallets', () => {
    const wc = { id: 'walletConnect', type: 'walletConnect' };
    expect(pickableConnectors([wc, metamask], true)).toEqual([metamask]);
  });

  it('hides it when there is no provider at all', () => {
    expect(pickableConnectors([generic], false)).toEqual([]);
  });
});

describe('tapStillCounts', () => {
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';

  it('opens the wallet straight away only while the tap still counts', () => {
    expect(tapStillCounts(0, 3_000, android)).toBe(true);
    expect(tapStillCounts(0, 6_000, android)).toBe(false);
    expect(tapStillCounts(0, 500, iphone)).toBe(true);
    expect(tapStillCounts(0, 2_000, iphone)).toBe(false);
  });
});
