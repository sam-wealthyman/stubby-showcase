# @stubby/api

Raffle management API, admin dashboard backend, event listeners and
notifications (Section 10).

Not scaffolded yet. Responsibilities when it lands:

- mirror on-chain raffle state; the chain stays the source of truth
- listen for entry, draw and claim events (Section 10)
- alert on stuck draws, failed claims and low randomness-fee balance (13.6)
- enforce geo-restriction at deposit time only (Section 11.9)
- use `@stubby/shared` for every amount and every calculation
