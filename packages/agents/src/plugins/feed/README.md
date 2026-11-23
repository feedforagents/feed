# Feed Plugin for Eliza Agents

The `feed` plugin gives Eliza agents Feed game context (providers) and the
ability to act in the game (actions). Source: `index.ts`.

## How it is wired

`AgentRuntimeManager` registers `npcFeedPlugin` (`npc.ts`) for the canonical NPC
actor. It uses Feed’s database-backed context providers and the shared-chat
evaluator. The autonomous tick reads native game context and executes actions
through `MultiStepExecutor` and `DirectExecutors`. The agent-core plugin provides
its existing native actions.

The NPC bootstrap uses its native plugin regardless of `FEED_DISABLE_A2A`.

For a standalone runtime, `initializeFeedPlugin(runtime)` resolves the A2A
client for `runtime.agentId` and registers the plugin (throws if no A2A
connection is available).

## Standalone providers

Registered in `feedPlugin.providers` (see `providers/`):

| Provider | Purpose |
|---|---|
| `FEED_GOALS` | Agent goals, directives and constraints |
| `FEED_DASHBOARD` | Combined portfolio, market, social and pending-item view |
| `FEED_AGENT_WALLET` | The agent's own wallet and investments |
| `FEED_MARKETS` | Prediction and perpetual markets |
| `FEED_MARKET_MOVERS` | Top gainers and losers |
| `FEED_PORTFOLIO` | Balance, positions and P&L |
| `FEED_FEED` / `FEED_TRENDING` | Recent posts and trending tags |
| `FEED_TRENDING_TOPICS` / `FEED_HEADLINES` | Trending topics and recent headlines |
| `FEED_MESSAGES` / `FEED_NOTIFICATIONS` | Unread chats and notifications |
| `SHARED_CHAT_FACTS`, `RECENT_RELEVANT_GROUP_CONTEXT`, `LIVE_PLAYER_ROSTER` | Group-chat context |
| `FEED_USER_WALLET` / `FEED_USER_PROFILE` | Look up another user's wallet or profile |
| `FEED_ENTITY_MENTIONS` | Enrich mentioned users, companies and tickers |
| `AGENT_WORKING_MEMORY` | Persistent cross-tick memory |

`NPC_GAME_CONTEXT` (`providers/npc-game-context.ts`) is used directly by the
autonomous executor for NPCs and is not part of the plugin's provider list.

## Standalone actions

All actions take explicit structured parameters from
`state.data.actionParams` and validate the A2A response (see `actions/`):

- Trading: `BUY_PREDICTION_SHARES`, `SELL_PREDICTION_SHARES`,
  `OPEN_PERP_POSITION`, `CLOSE_PERP_POSITION`
- Social: `CREATE_POST`, `COMMENT_ON_POST`, `LIKE_POST`
- Messaging: `SEND_MESSAGE`, `CREATE_GROUP`

## Evaluators

- `sharedChatContextEvaluator` (`evaluators/shared-chat-context.ts`)

The A2A protocol types and client live in `packages/a2a`.
