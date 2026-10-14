import AsyncStorage from '@react-native-async-storage/async-storage';
import { createStorage } from 'wagmi';

/**
 * wagmi's record of the last wallet used, kept on the device so the app
 * reconnects after a restart. (WalletConnect keeps its own session in the
 * same storage, through its React Native companion.)
 */
export const wagmiStorage = createStorage({ storage: AsyncStorage });
