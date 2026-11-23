# @feed/agent-harness

Run agent decisions against Feed's in-memory simulation and record trajectories for local evaluation.

## Overview

The harness runs a `TrainableAgent` in a configurable loop. Each step:

1. Gathers context (portfolio, markets, feed) from the simulation.
2. Asks the agent to decide an action.
3. Executes the action.
4. Records the step with a reward signal.

At the end of the run, trajectories are saved as JSON files for downstream training.

## Prerequisites

Install dependencies with `bun install` at the repo root. The built-in CLI agents run locally without credentials. `LLMAgent` requires a configured Groq, OpenAI, or Anthropic key. Use `bun run agent-frameworks:bootstrap` when running a framework adapter that needs sources outside this repository.

## Quick Start

```typescript
import {
  runHarness,
  archetypeAgent,
  getArchetype,
} from '@feed/agent-harness';

const result = await runHarness({
  agents: [archetypeAgent],
  archetypes: [getArchetype('trader'), getArchetype('degen')],
  instancesPerAgent: 1,
  ticksPerAgent: 20,
  parallelAgents: 4,
  tickInterval: 0,
  recordTrajectories: true,
  outputDir: './trajectories',
});

console.log(`Ran ${result.agentsRun} agents, ${result.totalTicks} ticks`);
```

Or use the CLI:

```bash
# From this directory
bun run train --archetypes trader,degen --ticks 3
bun run test:agents --agent random --ticks 1
```

## Agents

### RandomAgent

Stochastic baseline that makes uniformly random decisions. Good as a floor for benchmarking.

```typescript
import { randomAgent } from '@feed/agent-harness';
```

### ArchetypeAgent

Rule-based agent influenced by archetype traits (greed, fear, confidence, ethics). Deterministic-ish — reproducible without an LLM key.

```typescript
import { archetypeAgent } from '@feed/agent-harness';
```

### LLMAgent

Sends the full game context to a real LLM and parses its JSON decision. Supports Groq, OpenAI, and Anthropic.

```typescript
import { createLLMAgent } from '@feed/agent-harness';

const agent = createLLMAgent({
  provider: 'groq',                         // 'groq' | 'openai' | 'anthropic'
  model: 'llama-3.3-70b-versatile',        // optional, uses provider default
  temperature: 0.7,
});
```

Auto-detects the provider from available env keys (`GROQ_API_KEY` takes priority, then `OPENAI_API_KEY`, then `ANTHROPIC_API_KEY`).

### HermesAdapter

Runs [Hermes](https://github.com/NousResearch/hermes-agent) (NousResearch) via the Python bridge script. Requires bootstrap.

```typescript
import { createHermesAdapter } from '@feed/agent-harness';

const agent = createHermesAdapter({
  model: 'llama-3.3-70b-versatile',
  baseUrl: 'https://api.groq.com/openai/v1',
  persistent: true,   // keep Python process alive between ticks (faster)
});
```

### OpenClawAdapter

Runs [OpenClaw](https://openclaw.ai) in CLI mode (`openclaw agent --message ...`) or connects to its HTTP gateway.

```typescript
import { createOpenClawAdapter } from '@feed/agent-harness';

// CLI mode — no gateway required
const agent = createOpenClawAdapter({ mode: 'cli', model: 'gpt-4o' });

// Gateway mode — requires `openclaw gateway` running
const agent = createOpenClawAdapter({
  mode: 'gateway',
  gatewayUrl: 'http://localhost:18789',
});
```

## Simulation

`runHarness` starts a separate `SimulationAdapter` for each instance. For seeded runs, supply `clientFactory: (index) => new SimulationAdapter({ seed: 42 + index })`. The adapter uses virtual balances and simplified social interactions. A harness loop records agent steps against that state.

## Archetypes

Archetypes define personality traits (greed, fear, patience, confidence, ethics) and action-weight distributions that influence how agents behave.

```typescript
import { getArchetype, getAllArchetypes, getArchetypeIds } from '@feed/agent-harness';

getArchetypeIds();
// → ['trader', 'degen', 'hodler', 'scammer', 'whale', 'analyst', ...]

const trader = getArchetype('trader');
// → { id, name, description, system, traits, riskTolerance, actionWeights }
```

The `system` field is a plain-English prompt suffix injected into LLM-based agents.

## Trajectory Format

Each run produces one JSON file per agent instance and a `summary.json`:

```
trajectories/
  traj-1712345678-0.json   # full trajectory with all steps
  traj-1712345678-1.json
  summary.json             # aggregate stats
```

A trajectory file:
```json
{
  "id": "traj-1712345678-0",
  "agentId": "agent-31337-123456",
  "archetype": "trader",
  "startTime": "2026-04-07T00:00:00.000Z",
  "endTime": "2026-04-07T00:01:30.000Z",
  "totalReward": 14.5,
  "metadata": { "agentType": "llm-agent", "language": "typescript" },
  "steps": [
    {
      "tick": 1,
      "timestamp": "...",
      "context": { "balance": 1000, "positions": [], "markets": [...], "posts": [...] },
      "decision": { "action": "BUY_YES", "params": { "marketId": "...", "amount": 50 }, "reasoning": "..." },
      "result": { "success": true, "action": "BUY_YES", "data": { ... } },
      "reward": 3.0
    }
  ]
}
```

These are the inputs to the Python ScamBench training pipeline — see `packages/training/SCAMBENCH_RUNBOOK.md`.

## Feed-native training

Use the [ScamBench runbook](../../training/SCAMBENCH_RUNBOOK.md) for Feed-native trajectory collection, training, and benchmarking. The [Python training bridge](../../training/book/src/training-pipeline/modes.md) supports the online and hybrid training modes.

## CLI Reference

```
bun run dev -- [command] [options]

Commands:
  train           Run offline training
  test            Run a quick offline test
  list-archetypes List all available archetypes
  list-agents     List available built-in agents

Options:
  --archetypes    Comma-separated archetype IDs (default: trader,degen)
  --ticks         Ticks per agent (default: 10)
  --parallel      Max parallel agents (default: 4)
  --output        Directory for trajectory output (default: ./trajectories)
```

## Implementing a Custom Agent

```typescript
import type { TrainableAgent, AgentContext, AgentDecision, AgentConfig } from '@feed/agent-harness';

class MyAgent implements TrainableAgent {
  readonly id = 'my-agent';
  readonly name = 'My Agent';
  readonly language = 'typescript';

  async initialize(config: AgentConfig): Promise<void> {
    // setup
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    return {
      action: 'BUY_YES',
      params: { marketId: context.markets[0]?.id, amount: 10 },
      reasoning: 'always buy YES',
    };
  }

  async cleanup(): Promise<void> {
    // teardown
  }
}
```
