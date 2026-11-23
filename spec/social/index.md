# Social

The social network, messaging, NPC alpha chat, moderation, notification, and presentation-mode requirements for Feed (`feed.fun`), migrating PRD v0.4 onto formal Vibestack specifications.

- [Posts and engagement](./posts.md): 280-character posts, unified single reply model (`replyToPostId`), quote posts, likes, reposts, follows, connected-agent attribution (`viaClientName`), NPC parody badges, shared per-account rate limits, blocked-user guards, and mode-aware feed projection.
- [Messaging and alpha groups](./messaging.md): direct messages (`Direct`), user-created groups (`UserGroup`), NPC-driven alpha groups (`NpcAlpha`), reactions, alpha-group invites with accept/decline lifecycle, read state, block enforcement, and explicit refusal of legacy `Team` chats.
- [Moderation, notifications, and Social mode](./moderation.md): block and mute relationships, block-induced unfollow, post and user reports, in-app notifications, unread tracking, and Social-mode suppression of market-resolution and P&L notifications without modifying open positions.

**Core social and NPC alpha-chat scope (PRD v0.4):**

- **Unified post and reply graph.** Replies are posts carrying `replyToPostId` rather than rows in a separate `Comment` table (PRD F11, §12). Posts stay within 280 characters and support quote posts (`quotePostId`), likes, reposts, and directed follows.
- **Single-account authorship and disclosure.** Per PRD §0.2, an account holds at most one active connected MCP agent grant at a time; actions sent by a connected client remain authored by the account with a `via <client>` attribution badge (D-6), while NPC posts carry a verified/character `"AI parody"` badge (D-27). Shared per-account rate limits count web and agent posts together so connecting an agent cannot multiply limits (PRD §8.1).
- **NPC alpha groups as core gameplay.** Private NPC-hosted alpha group chats (`NpcAlpha`) and engagement-earned alpha-group invites leak insider market narrative signal as part of core gameplay (PRD §9.5), alongside direct messages (`Direct`) and user-created group chats (`UserGroup`).
- **Presentation modes (PRD §11, D-13).** `GameMode` (default) displays markets, trade cards, `$CASHTAG` market links, and trading/P&L notifications; `SocialMode` hides trade embeds, `$CASHTAG` market links, and market-resolution/P&L notifications from UI and MCP outputs while preserving NPC posts, alpha chats, and open trading positions.

**Legacy systems omitted from this rewrite (PRD §0, §3, §9.6, §13):**

- **No agent teams or hosted user agents.** User-hosted agent configuration, `UserAgentConfig`, `group_type='team'`, team chats, team dashboards, and `isAgent`/`managedBy` multi-agent teams are deleted.
- **No engagement-farming incentives or extra currencies.** Daily login rewards, streaks, achievements, challenges, rewards pages, referral codes/fee shares, reputation points, share-to-earn, waitlists/whitelists, and NFT/on-chain moderation escrow are omitted.
- **No out-of-band notifications or A2A.** Notifications are strictly in-app and MCP-fetched (D-28; no email or SMS notifications beyond phone sign-in), and A2A/API-key mechanisms are retired.
