# Deploying to Arc mainnet

A runbook, not an invitation. Section 14 step 7 sequences mainnet **after** the
security audit, and D20DAO's own audit status is still unverified (Section 11.1).
Deploying earlier is a decision the platform owner makes knowingly.

The commands below are exactly what was simulated successfully against chain
5042 on 2026-09-22, with the contracts that pass 75 tests and have run a full
lifecycle on testnet.

## Redeploying with the internal review's fixes (2026-09-27)

**Done 2026-09-27:** now `0x7213…dfa4` / `0x66AB…98B3` (table below). The
contracts at `0x13f3…3e2c` / `0x9494…1947` predated the three fixes in the
audit pack's "Internal review" (timeout ceiling, late answers kept, callback
gas floor). Mainnet has no raffles, so it is the same fresh deploy as below,
and the new adapter is wired at once.

1. Steps 1 and 2 below, with `ADAPTER_FLOAT_WEI=0`. Both scripts read
   `OWNER_ADDRESS` from `.env`, as the `set -a` line loads it.
2. Move the float from the current adapter:

   ```bash
   cast send 0x9494BB245239be7E0E1C827CcA569d7aaB221947 \
     'withdrawFloat(address,uint256)' <new adapter> \
     $(cast balance 0x9494BB245239be7E0E1C827CcA569d7aaB221947 --rpc-url arc_mainnet) \
     --rpc-url arc_mainnet --account stubby-owner
   ```

3. Check it (step 3), then tell whoever updates the site: the new raffle
   address goes in `scripts/check-network.mjs`, the repository variable
   `EXPO_PUBLIC_RAFFLE_ADDRESS`, the server's `RAFFLE_CONTRACT_ADDRESS` and
   `WATCH_START_BLOCK`, and the tables here and in the audit pack.

Rehearsed on a local fork of Arc mainnet with the owner impersonated: both
scripts ran, the raffle was wired to the new adapter immediately, the owner
owned both, the real coordinator quoted its fee, and the 0.20 USDC float moved
across (8 draws at that day's 0.026 USDC fee).

## Bringing mainnet up to date (from 2026-09-26)

The contract deployed on 2026-09-22 predates `updateRaffle`, `cancelRaffle`,
the 10 USDC `MIN_PRIZE` and the quarter-of-a-draw `walletCap`. A contract
cannot gain functions, so bringing mainnet level is a fresh deploy of both
contracts. It has no raffles, so nothing on it needs settling first.

1. Deploy the raffle and the adapter exactly as in steps 1 and 2 below, with
   `ADAPTER_FLOAT_WEI=0`; the old adapter's float moves across next.
2. Move the old float to the new adapter (the owner can; nothing else can):

   ```bash
   cast send 0x03B2eF6fce48a7725170e02C0222c15e19d67CF0 \
     'withdrawFloat(address,uint256)' <new adapter> \
     $(cast balance 0x03B2eF6fce48a7725170e02C0222c15e19d67CF0 --rpc-url arc_mainnet) \
     --rpc-url arc_mainnet --account stubby-owner
   ```

3. Check it as in step 3, then record the new pair in the table below and in
   the brief (Section 13.5).

Measured on the testnet deploy of the same bytecode: `StubbyRaffle`
2,370,123 gas, `D20RandomnessAdapter` 831,252, wiring and the float move
under 100,000 more; about **0.07 USDC** at Arc's 20 gwei floor.

## Before you start

**`.env` stays pointed at testnet.** Every mainnet value is passed on the
command line instead. This is deliberate: the app, the API, `check-chain.mjs`
and every script in `scripts/` read `.env`, and a file left pointing at mainnet
is how a testnet habit becomes a mainnet transaction.

**Use an encrypted keystore, not a key in `.env`.** `cast wallet import
stubby-owner --interactive` once, then `--account stubby-owner` below. Foundry
prompts for the password; the key never enters the environment, the command line
or shell history. `docs/key-management.md` has the full reasoning.

**The deploying key becomes the contract owner.** `StubbyRaffle` is
`Ownable2Step` with eight owner-only functions — `withdrawCommission`,
`setTreasury`, `setRandomnessSource`, `setEntriesPaused`, `closeEarly`,
`topUp`, `createRaffle` and `transferOwnership`. Ownership can be handed to a
hardware wallet or a Safe afterwards, and two-step means the new owner must
accept, so a typo cannot orphan the contract.

## What it costs

Measured, not estimated: these are the gas figures from the testnet
deployment of the same bytecode.

| Step                            | Gas       | At 21 gwei |
| ------------------------------- | --------- | ---------- |
| `StubbyRaffle`                  | 2,179,606 | 0.046 USDC |
| `D20RandomnessAdapter` + wiring | 883,973   | 0.019 USDC |
| **Deploy total**                | 3,063,579 | 0.065 USDC |

Plus the randomness float, and **the fee is not fixed**. The coordinator
quoted 0.02 USDC from a plain `eth_call` and **0.033 USDC** from inside the
deploy broadcast minutes later — it moves with gas conditions. Section 10's
table gives 0.02 as a _minimum_, not a price.

So `requestsAffordable` is a reading taken now, not a promise: the same float
showed 6 draws during the deploy and 10 a few minutes afterwards. Size the
float for the fee you might pay rather than the one you saw, and treat the
low-float alert as a moving threshold.

Forge's own estimate is higher (~0.126 USDC for the raffle) because it pads
`maxFeePerGas`; the charge is base fee plus priority, and Arc's base sits at
the 20 gwei floor. Forge also labels the native token "ETH" in its output. On
Arc it is USDC.

## 1. Deploy the raffle

```bash
set -a && . ./.env && set +a          # owner, treasury, USDC — not the key
export PATH="$HOME/.foundry/bin:$PATH"
cd packages/contracts

VRF_COORDINATOR_ADDRESS=0xd20da057469C45928912d983F45790C41e290571 \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url arc_mainnet --broadcast \
  --verify --verifier sourcify \
  --account stubby-owner \
  --sender <owner address> \
  --priority-gas-price 1000000000
```

The script refuses to run if USDC or the coordinator has no code at the given
address, which is what catches a mainnet deploy pointed at testnet addresses.
It prints the raffle address; keep it.

## 2. Deploy the adapter and wire it

The raffle cannot draw until this exists and `setRandomnessSource` has been
called. The script does both, and funds the float in the same broadcast.

```bash
RAFFLE_CONTRACT_ADDRESS=<address from step 1> \
VRF_COORDINATOR_ADDRESS=0xd20da057469C45928912d983F45790C41e290571 \
ADAPTER_FLOAT_WEI=100000000000000000 \
forge script script/DeployAdapter.s.sol:DeployAdapter \
  --rpc-url arc_mainnet --broadcast \
  --verify --verifier sourcify \
  --account stubby-owner \
  --sender <owner address> \
  --priority-gas-price 1000000000
```

`ADAPTER_FLOAT_WEI` is the **native 18-decimal view** — `1e17` is 0.1 USDC.
The default in the script is `2e18`, sized for testnet, and would be 2 USDC
here.

It calls `quoteFee` on the coordinator before deploying anything and reverts
with `CoordinatorDoesNotAnswer` if the interface does not match. That check
exists because two documented D20DAO signatures turned out to be wrong
(Section 11.1), and a silent mismatch means a raffle that fills and can never
draw.

## Verifying the source

Both deploy commands above verify each contract on
[Sourcify](https://sourcify.dev) as part of the broadcast (`--verify --verifier
sourcify`). The Arc explorer imports the result from there within a few
minutes of the contract's page being viewed: its Contract tab then shows the
source, the compiler settings, the constructor arguments by name and a
Read/Write tab. That is what backs the app's "Check it yourself" link.

Sourcify, not the explorer's own API: the explorer sits behind Cloudflare's bot
check, which answers `forge` with a challenge page instead of JSON.

Verification needs no key, only the source, the compiler settings in
`foundry.toml` and the constructor arguments, so a contract deployed without
`--verify` can be verified afterwards from any machine. The arguments are in
`broadcast/<script>/5042/run-latest.json`:

```bash
cd packages/contracts
forge verify-contract <address> src/StubbyRaffle.sol:StubbyRaffle \
  --chain-id 5042 --verifier sourcify --compiler-version 0.8.28 \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address,address)' \
    <usdc> <randomness source> <treasury> <owner>)" --watch

forge verify-contract <address> src/D20RandomnessAdapter.sol:D20RandomnessAdapter \
  --chain-id 5042 --verifier sourcify --compiler-version 0.8.28 \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address)' \
    <coordinator> <raffle> <owner>)" --watch
```

Sourcify answers `exact_match` when even the embedded metadata hash matches,
and `match` when the executable code does and only that hash differs (a build
detail such as file paths). Both count as verified; the explorer shows the
second as a partial match.

The contracts deployed on 2026-09-27 were verified this way on 2026-09-29:
the raffle `0x7213…dfa4` as `match` and the adapter `0x66AB…98B3` as
`exact_match`.

## 3. Check it

```bash
cd ../..
ARC_RPC_URL=https://rpc.mainnet.arc.io \
ARC_CHAIN_ID=5042 \
RAFFLE_CONTRACT_ADDRESS=<raffle> \
ADAPTER_ADDRESS=<adapter> \
node scripts/check-chain.mjs
```

Expect: solvent, a float with draws affordable, and zero raffles. Anything else
wants explaining before a single raffle is created.

## Redeployed on 2026-09-27

Brought level with testnet by the platform owner with `--account`, the old
adapter's float moved across: edit and cancel, `MIN_PRIZE` and `walletCap`,
then (the same day) the one-hour randomness-source delay, the 10-minute
timeout floor and refusing to renounce ownership (`0x13f3…3e2c` /
`0x9494…1947`), and finally the internal review's fixes, at block 23071661:

|                        |                                              |
| ---------------------- | -------------------------------------------- |
| `StubbyRaffle`         | `0x7213526D82FE7E1A37A26974E343e23eF88bdfa4` |
| `D20RandomnessAdapter` | `0x66ABac54Cd4080fED9275529F6d23f8A217298B3` |
| Owner / treasury       | `0x55715594636e32E5da4Cb27236da7c811418a833` |
| Float                  | 0.20 USDC, 10 draws at the 0.033 USDC fee    |

`DeployAdapter` checks `raffle.owner() == msg.sender` to wire the adapter, so
with `--account` it needs `--sender <owner address>` too, or Forge stops in the
simulation with "Usage of `msg.sender` inside a `broadcast`". Nothing is sent
when that happens.

## Deployed on 2026-09-22 (retired)

|                        |                                              |
| ---------------------- | -------------------------------------------- |
| `StubbyRaffle`         | `0x782184c6862542F34D71B855eefc9352F200213A` |
| `D20RandomnessAdapter` | `0x03B2eF6fce48a7725170e02C0222c15e19d67CF0` |
| Owner / treasury       | `0x55715594636e32E5da4Cb27236da7c811418a833` |
| Cost                   | 0.0458 + 0.0186 USDC gas, 0.2 USDC float     |

**The mainnet addresses are identical to the testnet ones.** Same deployer,
same nonce, same `CREATE` address — so `RAFFLE_CONTRACT_ADDRESS` alone does not
say which network you are on, and the guard in `Deploy.s.sol` that catches a
deploy pointed at the wrong chain's addresses cannot help here. Only
`ARC_CHAIN_ID` distinguishes them, and `check-chain.mjs` now verifies that
against the RPC before reporting anything.

## 4. Afterwards

- Record both addresses in Section 13.5 beside the testnet pair.
- Consider `transferOwnership` to a hardware wallet or Safe, then `acceptOwnership`
  from that address.
- The app points at mainnet through `EXPO_PUBLIC_ARC_CHAIN_ID=5042` and
  `EXPO_PUBLIC_RAFFLE_ADDRESS`, and the API through `ARC_CHAIN_ID`. Change
  those only when you intend the product to be live.
