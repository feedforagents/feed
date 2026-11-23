# Shared Primitives

Shared pure Quint rules and boundary types reused across markets, social, auth, MCP, engine, and the web application. None of these library specs declare a mutable state machine of their own.

- [Money & canonical fees](./money.md): exact integer cents (`CENTS_PER_PT = 100`), canonical `10 bps` rounded-up fee formula, and partition non-amplification laws.
- [UTC time, slots & cooldowns](./time.md): UTC 8-hour perpetual funding boundaries, 10 rolling prediction market slots (`15m`..`3d`), and 30-day phone deletion cooldowns.
- [Rate limits & D-25 spend budgets](./limits.md): shared per-account web/MCP hourly rate limits and integer-cent D-25 NPC daily spend reservations with automatic 80%/90% throttling.
