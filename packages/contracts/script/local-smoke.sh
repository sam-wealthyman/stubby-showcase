#!/usr/bin/env bash
# Drive one raffle end to end on a local chain: deploy, fill, draw, settle,
# claim, and check the holdings invariant after every step.
#
# Proves the local stack in Section 13.5 actually works, and doubles as the
# fastest way to see the contract behave without reading the tests.
#
#   ./script/local-smoke.sh
#
# Starts and stops its own Anvil unless one is already listening.
set -euo pipefail

RPC=${RPC:-http://127.0.0.1:8545}
MNEMONIC="test test test test test test test test test test test junk"
ANVIL_PID=""

cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
fail() {
  printf '  ✗ %s\n' "$*" >&2
  exit 1
}

key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }

step "Chain"
if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  ok "using the chain already at $RPC"
else
  anvil --silent >/tmp/stubby-anvil.log 2>&1 &
  ANVIL_PID=$!
  # Poll rather than sleep: each cast invocation is itself a short delay, and
  # some sandboxes refuse a foreground sleep.
  for _ in $(seq 1 60); do
    cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  done
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start"
  ok "started anvil (pid $ANVIL_PID)"
fi

step "Deploy the local stack"
OUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC" --broadcast --private-key "$(key 0)" 2>&1)
USDC=$(grep -oE 'DevUsdc +0x[0-9a-fA-F]{40}' <<<"$OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
VRF=$(grep -oE 'DevRandomness +0x[0-9a-fA-F]{40}' <<<"$OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
RAFFLE=$(grep -oE 'StubbyRaffle +0x[0-9a-fA-F]{40}' <<<"$OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
[[ -n "$USDC" && -n "$VRF" && -n "$RAFFLE" ]] || fail "could not read deployed addresses"
ok "usdc $USDC"
ok "randomness $VRF"
ok "raffle $RAFFLE"

invariant() {
  local held owed
  held=$(cast call "$USDC" "balanceOf(address)(uint256)" "$RAFFLE" --rpc-url "$RPC" | awk '{print $1}')
  owed=$(cast call "$RAFFLE" "requiredHoldings()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
  [[ "$held" == "$owed" ]] || fail "holdings $held != owed $owed after $1"
  ok "holdings match obligations after $1 ($held)"
}

step "Ten wallets buy five entries each"
for i in $(seq 0 9); do
  K=$(key "$i")
  cast send "$USDC" "approve(address,uint256)" "$RAFFLE" \
    100000000 --private-key "$K" --rpc-url "$RPC" >/dev/null
  cast send "$RAFFLE" "enter(uint256,uint8)" 1 5 --private-key "$K" --rpc-url "$RPC" >/dev/null
done
COLLECTED=$(cast call "$RAFFLE" "collected(uint256)(uint256)" 1 --rpc-url "$RPC" | awk '{print $1}')
[[ "$COLLECTED" == "50000000" ]] || fail "expected 50 USDC collected, got $COLLECTED"
ok "50 entries, 50 USDC collected"
invariant "entries"

step "Prize-covered early draw (Section 11.5)"
COVERED=$(cast call "$RAFFLE" "isPrizeCovered(uint256)(bool)" 1 --rpc-url "$RPC")
[[ "$COVERED" == "true" ]] || fail "raffle should be prize-covered at 50 of 70"
ok "prize covered at 50 of 70 entries"
cast send "$RAFFLE" "closeEarly(uint256)" 1 --private-key "$(key 0)" --rpc-url "$RPC" >/dev/null
ok "owner closed the raffle early"
# Starting the draw is a separate, permissionless, retryable step, so a broken
# coordinator can never block an entry. Anyone may call it.
cast send "$RAFFLE" "startDraw(uint256)" 1 --private-key "$(key 1)" --rpc-url "$RPC" >/dev/null
ok "draw started by a non-owner"
cast send "$VRF" "fulfilLatest()" --private-key "$(key 0)" --rpc-url "$RPC" >/dev/null
ok "randomness delivered"
invariant "draw"

step "Settle"
# Drawn(uint256 indexed raffleId, address indexed winner, ...) -> winner is topic 2.
TOPIC=$(cast logs --from-block 0 --address "$RAFFLE" \
  "Drawn(uint256,address,uint32,uint256,uint256)" --rpc-url "$RPC" |
  grep -A3 'topics' | grep -oE '0x0{24}[0-9a-fA-F]{40}' | tail -1)
[[ -n "$TOPIC" ]] || fail "no Drawn event found"
WINNER="0x${TOPIC: -40}"
ok "winner $WINNER"

PRIZES=$(cast call "$RAFFLE" "totalPrizesOwed()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
COMMISSION=$(cast call "$RAFFLE" "totalCommissionOwed()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
[[ "$PRIZES" == "50000000" ]] || fail "expected the full 50 USDC prize owed, got $PRIZES"
[[ "$COMMISSION" == "0" ]] || fail "an exactly-covered raffle leaves no commission, got $COMMISSION"
ok "winner owed the full 50 USDC prize, owner takes 0"

WK=""
for i in $(seq 0 9); do
  if [[ "$(addr "$i" | tr 'A-Z' 'a-z')" == "$(tr 'A-Z' 'a-z' <<<"$WINNER")" ]]; then
    WK=$(key "$i")
    ok "winner is anvil account $i"
  fi
done
[[ -n "$WK" ]] || fail "winner is not one of the funded accounts"

step "Claim"
BEFORE=$(cast call "$USDC" "balanceOf(address)(uint256)" "$WINNER" --rpc-url "$RPC" | awk '{print $1}')
cast send "$RAFFLE" "claim(uint256)" 1 --private-key "$WK" --rpc-url "$RPC" >/dev/null
AFTER=$(cast call "$USDC" "balanceOf(address)(uint256)" "$WINNER" --rpc-url "$RPC" | awk '{print $1}')
python3 - "$BEFORE" "$AFTER" <<'PY' || fail "winner did not receive exactly the prize"
import sys
before, after = int(sys.argv[1]), int(sys.argv[2])
assert after - before == 50 * 10**6, f"gained {after - before}"
PY
ok "winner received exactly 50 USDC"
invariant "claim"

FINAL=$(cast call "$USDC" "balanceOf(address)(uint256)" "$RAFFLE" --rpc-url "$RPC" | awk '{print $1}')
[[ "$FINAL" == "0" ]] || fail "contract should be empty, holds $FINAL"
ok "contract is empty: nothing trapped"

printf '\n\033[1;32mLocal smoke test passed.\033[0m\n'
