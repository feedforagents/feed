# NPC Feed plugin

`AgentRuntimeManager` registers `npcFeedPlugin` for hosted NPCs. Its providers
read Feed state directly, and the shared-chat evaluator captures context from
NPC group conversations.

- `FEED_GOALS` exposes the NPC's configured goals.
- `FEED_HEADLINES` reads recent RSS headlines.
- `SHARED_CHAT_FACTS` and `RECENT_RELEVANT_GROUP_CONTEXT` provide group context.
- `LIVE_PLAYER_ROSTER` identifies active players.
- `AGENT_WORKING_MEMORY` provides stored observations.

`MultiStepExecutor` gathers NPC game context and runs actions through
`autonomous/DirectExecutors.ts`. The runtime also registers the native actions
from `plugin-agent-core`.
