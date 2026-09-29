# Security

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository, or email the address in the repository profile.

Please include what you found, how to reproduce it, and what an attacker gets.
If it concerns funds held by the raffle contract, say so in the first line.

## Scope

In scope: the raffle contract, the API, the app, and anything that could move
USDC that is not the wallet that owns it.

Of particular interest, because the whole design rests on them:

- anything that lets a raffle freeze, or blocks a draw or a claim (brief 6.1)
- anything that lets a prize be claimed by a wallet that did not win
- anything that lets a prize be paid twice
- anything that biases or predicts the draw (brief 11.1)
- anything that breaks the invariant that the contract holds exactly
  escrow + unclaimed prizes + commission

## Before mainnet

The contract gets an external audit before it holds real funds, and deploys
only from tagged releases (brief 13.3).

## Not a vulnerability

The contract is permissionless by design: anyone can call it directly, so
geo-restriction applies to the app, not the chain (brief 11.9). Per-wallet
entry caps are per wallet, not per person, and that is deliberate (brief 11.3).
