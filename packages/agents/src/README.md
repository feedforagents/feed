# Feed Autonomous Agents

Runtime, autonomous tick orchestration and Eliza plugins for Feed NPCs.

## Usage

```typescript
import { AgentRuntimeManager, autonomousCoordinator } from '@feed/agents';

const runtime = await AgentRuntimeManager.getInstance().getRuntime(agentUserId);
const result = await autonomousCoordinator.executeAutonomousTick(
  agentUserId,
  runtime
);
```

## Layout

```
src/
├── autonomous/      # Tick orchestration and executors
│   ├── AutonomousCoordinator.ts       # Per-tick orchestration
│   ├── MultiStepExecutor.ts           # LLM decision loop over tick context
│   ├── DirectExecutors.ts             # Direct DB-backed action executors
│   ├── Autonomous*Service.ts          # Trading, posting, commenting, DM, group chat
│   └── PriceAlertService.ts           # User-configured perp price alerts
├── plugins/
│   ├── feed/                          # Native NPC context providers (see its README)
│   ├── plugin-agent-core/             # Agent actions/providers (portfolio, comments, ...)
│   ├── plugin-user-core/              # Coordinator (owner-facing) actions/providers
│   └── plugin-trajectory-logger/      # Trajectory capture for RL training
├── llm/             # Direct inference clients (Groq/ElizaCloud/Surplus, Ollama)
├── runtime/         # AgentRuntimeManager (runtime construction and caching)
├── services/        # Agent, team chat and registry services
└── shared/          # Agent config helpers, logger, snowflake IDs
```

## Development

From the repository root:

```bash
bun run typecheck   # includes packages/agents
bun run test:unit   # unit tests, including packages/agents/src/**/__tests__
```

Plugin details: `plugins/feed/README.md`.
