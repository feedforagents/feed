# Markets and economy

Market mechanics, spot-driven perpetuals, and the single-currency `pts` economy (`100 cents = 1 pt`) built on [money precision](../shared/money.md), [time schedules](../shared/time.md), and [shared limits](../shared/limits.md).

#### Areas

- [Prediction markets](./prediction.md): complete-set CPMM YES/NO pools, cent-settled buys and sells with canonical `10 bps` round-up fees in `feeLedger`, schedule-driven expiry close, private outcome and proof until resolution, manual review holds, duplicate-safe `1 pt` (`100 cents`) per winning share redemption (`D-14`), and cost-basis cancellation refunds.
- [Spot and perpetuals](./spotPerp.md): NPC-only spot CPMM pools (`D-17`) acting as the sole persisted index price source (no random walk), up to `20x` leverage perpetuals (`D-17b`), bounded open-interest mark premium, at-most-once per UTC 8-hour period funding accrual with cutover protection, and mark-price liquidation.
- [Economy and leaderboard](./economy.md): single virtual currency `pts` (`100 pts` initial grant once per verified account, no free refills when broke per `D-15`), web-only Stripe Checkout packs (`$5` / `$20` / `$50` at `100 pts/$1`), Washington purchase block with free play kept open, and purchase-invariant net-profit leaderboard ranking (`D-15b`).

#### Shared Guarantees

1. **No extra points from splitting:** Cash inputs and proceeds settle down to whole cents (`floorCents`) and pay the canonical `10 bps` fee rounded up to whole cents (`canonicalTradingFee`).
2. **No cash value or transfers:** `pts` are non-transferable virtual game points that never cash out (`D-18`).
3. **Hidden signal isolation:** Prediction outcomes and prepared proof articles remain private until resolution settles the market.
4. **Deterministic pricing sources:** Prediction prices derive from CPMM reserves; perp index prices derive solely from NPC-traded spot pools.
