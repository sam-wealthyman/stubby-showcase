/**
 * The wallet context.
 *
 * Wraps the app in wagmi and the query client it depends on. Mounted in the
 * root layout, above the router, so a screen can ask about the wallet without
 * knowing whether one has been connected yet.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';

import { wagmiConfig } from './config';

/**
 * Created once, outside the component.
 *
 * A client built during render is a new client on every render, which throws
 * away every cached read — the sort of bug that shows up as "the balance
 * flickers" rather than as an error.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Chain state is not free to read and rarely changes between renders.
      // Screens that need it live — a countdown, a filling raffle — ask for a
      // shorter time themselves.
      staleTime: 10_000,
      retry: 2,
    },
  },
});

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
