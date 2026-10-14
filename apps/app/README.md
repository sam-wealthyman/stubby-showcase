# The app's Arc layer

Stubby's app (Expo and React Native, for the web and Android) talks to Arc
through the two folders here. They are published in full; the screens, styles
and design system that sit on top of them are not, so this folder does not
build on its own. The live app is at https://stubby.starterdot.com.

| Path         | What                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/wallet` | wagmi pointed at Arc mainnet or testnet (`config.ts`, `network.ts`), browser and phone wallets over WalletConnect (`connectors.ts`, `usePhoneConnect.ts`), switching a wallet onto Arc, and gas paid in USDC (`gas.ts`).                                                                          |
| `src/chain`  | Reading every draw in one Multicall3 batch (`useRaffles.ts`), buying with a USDC approval and `enter` (`useBuyEntries.ts`), claiming (`useClaim.ts`), starting a draw (`useStartDraw.ts`), the draw's on-chain events as its proof (`useDrawProof.ts`), and the owner's controls (`useOwner.ts`). |
| `test`       | The tests for the pure parts: gas, networks, holdings, picking, ownership, recovery.                                                                                                                                                                                                              |

## USDC is the gas token

On Arc, gas is paid in USDC, and a wallet's USDC has two views: 18 decimals as
the native gas balance and 6 as the ERC-20 at `0x3600…0000`. They are the same
money. Every amount here is the 6-decimal view, converted with `nativeToUsdc`
and `usdcToNative` from `@stubby/shared`. One consequence shapes the buy flow
(`gas.ts`, `picking.ts`): ticket money and gas money come out of the same
balance, so a wallet holding exactly the ticket price cannot buy a ticket, and
the app sets aside a gas budget when it works out how many tickets you can
afford.
