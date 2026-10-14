/**
 * The network a wallet is on when it is not Arc, for the Connect board's
 * "Now on" card.
 *
 * Only the chains people most often arrive from. Anything else is named by its
 * id rather than guessed at: a wrong name here would tell someone their wallet
 * is somewhere it is not.
 */
const KNOWN: Record<number, { name: string; gas: string }> = {
  1: { name: 'Ethereum', gas: 'ETH' },
  10: { name: 'Optimism', gas: 'ETH' },
  56: { name: 'BNB Chain', gas: 'BNB' },
  137: { name: 'Polygon', gas: 'POL' },
  8453: { name: 'Base', gas: 'ETH' },
  42161: { name: 'Arbitrum', gas: 'ETH' },
  43114: { name: 'Avalanche', gas: 'AVAX' },
  11155111: { name: 'Sepolia', gas: 'ETH' },
  84532: { name: 'Base Sepolia', gas: 'ETH' },
};

export function otherChain(chainId: number | undefined): { name: string; note: string } {
  const known = chainId === undefined ? undefined : KNOWN[chainId];
  if (known) return { name: known.name, note: `Gas in ${known.gas}` };
  return {
    name: 'Another network',
    note: chainId === undefined ? 'Not Arc' : `Chain ${chainId}`,
  };
}
