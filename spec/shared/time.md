# Shared time boundaries and market schedules

UTC 8-hour funding period indexing (`00:00`, `08:00`, `16:00` UTC), rolling prediction market slot durations (`15m` to `3d`, 10 total slots), and the 30-day phone number release cooldown after account deletion.

## UTC 8-hour funding boundaries

### Funding periods partition UTC time into non-negative 8-hour windows

`epochHours` counts whole hours since the UTC epoch. Period index `epochHours / 8` is always non-negative (`>= 0`) and monotonically non-decreasing.

```quint
pure val FUNDING_PERIOD_HOURS = 8
pure val HOURS_PER_DAY = 24
pure val SECONDS_PER_HOUR = 3600
pure val SECONDS_PER_FUNDING_PERIOD = FUNDING_PERIOD_HOURS * SECONDS_PER_HOUR

pure val epochHoursValues = Set(-1, 0, 7, 8, 15, 16, 24)

pure def fundingPeriodIndex(epochHours: int): int =
  if (epochHours <= 0) 0 else epochHours / FUNDING_PERIOD_HOURS

pure def fundingPeriodStartHour(periodIndex: int): int =
  if (periodIndex <= 0) 0 else periodIndex * FUNDING_PERIOD_HOURS

pure def nextFundingPeriodStartHour(epochHours: int): int =
  (fundingPeriodIndex(epochHours) + 1) * FUNDING_PERIOD_HOURS

pure def utcDayIndex(epochHours: int): int =
  if (epochHours <= 0) 0 else epochHours / HOURS_PER_DAY

pure def fundingPeriodFromSeconds(epochSeconds: int): int =
  if (epochSeconds <= 0) 0 else epochSeconds / SECONDS_PER_FUNDING_PERIOD

pure def lawFundingPeriodIsNonNegative(epochHours: int): bool =
  fundingPeriodIndex(epochHours) >= 0

pure def lawFundingPeriodIsMonotonic(h1: int, h2: int): bool =
  (h1 <= h2) implies fundingPeriodIndex(h1) <= fundingPeriodIndex(h2)

pure def lawFundingPeriodContainsHour(epochHours: int): bool =
  epochHours >= 0 implies
    (fundingPeriodStartHour(fundingPeriodIndex(epochHours)) <= epochHours
      and epochHours < nextFundingPeriodStartHour(epochHours))
```

## Rolling prediction market slot durations

### Ten rolling slots span from 15 minutes to 3 days

The market structure maintains 10 active slots across 8 timeframes (`15m: 2`, `30m: 2`, `1h: 1`, `6h: 1`, `12h: 1`, `1d: 1`, `2d: 1`, `3d: 1`).

```quint
type MarketSlot = Slot15m | Slot30m | Slot1h | Slot6h | Slot12h | Slot1d | Slot2d | Slot3d

pure val MIN_MARKET_DURATION_MINUTES = 15
pure val MAX_MARKET_DURATION_MINUTES = 3 * 24 * 60
pure val ROLLING_MARKET_SLOT_TOTAL = 10

pure def slotDurationMinutes(slot: MarketSlot): int =
  match slot {
    | Slot15m => 15
    | Slot30m => 30
    | Slot1h => 60
    | Slot6h => 360
    | Slot12h => 720
    | Slot1d => 1440
    | Slot2d => 2880
    | Slot3d => 4320
  }

pure def slotTargetCount(slot: MarketSlot): int =
  match slot {
    | Slot15m => 2
    | Slot30m => 2
    | _ => 1
  }

pure def isValidMarketDurationMinutes(minutes: int): bool =
  minutes >= MIN_MARKET_DURATION_MINUTES and minutes <= MAX_MARKET_DURATION_MINUTES

pure val ALL_MARKET_SLOTS: List[MarketSlot] =
  List(Slot15m, Slot30m, Slot1h, Slot6h, Slot12h, Slot1d, Slot2d, Slot3d)

pure def lawAllSlotsWithinDurationBounds(slot: MarketSlot): bool =
  isValidMarketDurationMinutes(slotDurationMinutes(slot))
    and ALL_MARKET_SLOTS.foldl(0, (acc, sl) => acc + slotTargetCount(sl)) == ROLLING_MARKET_SLOT_TOTAL
```

## Phone deletion cooldown

### A deleted account's phone hash is held for a full 30-day cooldown before reuse

Per D-20, self-serve account deletion releases the phone hash only after 30 days (`720` hours / `2,592,000` seconds).

```quint
pure val PHONE_COOLDOWN_DAYS = 30
pure val PHONE_COOLDOWN_HOURS = PHONE_COOLDOWN_DAYS * HOURS_PER_DAY
pure val PHONE_COOLDOWN_SECONDS = PHONE_COOLDOWN_HOURS * SECONDS_PER_HOUR

pure val cooldownCheckHoursValues = Set(0, 719, 720, 721)

pure def isPhoneCooldownElapsed(deletedAtHour: int, currentHour: int): bool =
  deletedAtHour >= 0 and currentHour >= deletedAtHour and (currentHour - deletedAtHour) >= PHONE_COOLDOWN_HOURS

pure def isPhoneCooldownElapsedSeconds(deletedAtSec: int, currentSec: int): bool =
  deletedAtSec >= 0 and currentSec >= deletedAtSec and (currentSec - deletedAtSec) >= PHONE_COOLDOWN_SECONDS

pure def lawPhoneCooldownBlocksBefore30Days(deletedAtHour: int, cooldownCheckHours: int): bool =
  cooldownCheckHours < PHONE_COOLDOWN_HOURS implies
    not(isPhoneCooldownElapsed(deletedAtHour, deletedAtHour + cooldownCheckHours))
```
