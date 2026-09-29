# Stubby

_Tear a stub. Win USDC._

A raffle app for web and Android on [Arc](https://www.arc.io), Circle's
stablecoin-native chain. People buy stubs in USDC for a chance at a USDC prize.
When a draw sells out, a verifiable random number picks the winner, and the
prize waits in the contract until the winner claims it straight to their own
wallet. Nobody, the operator included, can choose the winner or hold the money.

**Live on Arc mainnet:** https://stubby.starterdot.com
**Contract:** [`0x7213526D82FE7E1A37A26974E343e23eF88bdfa4`](https://explorer.arc.io/address/0x7213526D82FE7E1A37A26974E343e23eF88bdfa4?tab=contract)
on the Arc explorer, with its source verified, as is the [randomness adapter](https://explorer.arc.io/address/0x66ABac54Cd4080fED9275529F6d23f8A217298B3?tab=contract) · **Android:** [`/download/stubby.apk`](https://stubby.starterdot.com/download/stubby.apk)

> **This is a public showcase of a private repository.** It shows how Stubby is
> built. A few pieces are left out so that it does not run as a copy of the
> product; the full source is private. See [What is left out](#what-is-left-out).

## What it does

- **Buy.** Players buy stubs in USDC from a browser wallet, a phone wallet over
  WalletConnect, or the Android app. One wallet can hold at most a quarter of
  any draw. On Arc, gas is USDC too, so one balance covers everything.
- **Draw.** The purchase that takes the last stub starts the draw. The random
  number comes from D20DAO's VRF on Arc, and every step links its transaction,
  so anyone can check the result.
- **Claim.** Winners are told in the app, by push and by email, and claim to
  their own wallet or any address, with no deadline.
- **Accounts.** Sign in with a wallet (SIWE), an email link or X. One account
  can hold several wallets, a username and a referral link.

## What is in this repository

| Path                 | What                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | `StubbyRaffle` and `D20RandomnessAdapter` in Solidity (Foundry), with unit, invariant and gas tests. The same code is live on mainnet. |
| `apps/api`           | The Hono API (accounts, sessions, sign-in, referrals, push devices) and the watcher that mirrors the chain and sends mail and push.    |
| `packages/shared`    | Chains, USDC units, raffle arithmetic, SIWE and the contract ABIs, shared by the app (private), the API and the tests.                 |
| `docs`               | Architecture and the decision records (ADRs).                                                                                          |

## What is left out

- **The app** (web and Android): its screens, design and the buy, sign-in and
  control-room flows. To see it, use the live site,
  [stubby.starterdot.com](https://stubby.starterdot.com), or the Android app. It is
  an Expo Router app (React Native Web and Android) that reads the chain directly
  with wagmi and talks to the API in this repository.
- **Deployment:** the server setup, deploy gate, backups, the deploy and
  Android signing workflows, and the end-to-end suite.
- **Operating documents:** runbooks, key management and the mainnet deploy
  guide. Some docs here still link to them; those links are to private files.

Everything that decides who wins and where the money goes is in the contracts,
and they are all here.

## Try it

Needs Node 22+ (see `.nvmrc`) and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm test        # unit tests across the workspace
pnpm typecheck
pnpm lint
```

The contracts need [Foundry](https://getfoundry.sh) and the submodules:

```bash
git submodule update --init --recursive
cd packages/contracts
forge test
```

## Built with

Arc · USDC · D20DAO VRF · Solidity and Foundry · OpenZeppelin · Expo and React
Native · wagmi and viem · WalletConnect · Hono · PostgreSQL.

Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates.

## Licence

All rights reserved. This code is shared so it can be read and reviewed; it is
not licensed for reuse or redistribution.
