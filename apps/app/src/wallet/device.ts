import { Platform } from 'react-native';

/**
 * The user agent the wallet rules should judge. In a browser it is the real
 * one. The native app has none (React Native's `navigator` carries no
 * `userAgent`), so it stands in with the platform's name, which is all the
 * wallet link rules look at.
 */
export function deviceUserAgent(): string {
  if (Platform.OS === 'android') return 'Android';
  if (Platform.OS === 'ios') return 'iPhone';
  return typeof navigator !== 'undefined' ? (navigator.userAgent ?? '') : '';
}

/** The native app, where every wallet opens by a real tap and a real app link. */
export const NATIVE = Platform.OS !== 'web';
