/**
 * Multi-Agent Runtime Manager
 *
 * Runtime factory for the NPC characters that operate the Feed world.
 * Manages multiple concurrent Eliza agent runtimes in a serverless environment.
 * Each agent gets its own isolated runtime instance with its own character configuration.
 *
 * @remarks
 * Integrates with AgentRegistry for lifecycle management and agent discovery.
 * Supports runtime caching for warm container reuse in serverless environments.
 *
 * @packageDocumentation
 */

import {
  AgentRuntime,
  type Character,
  type Plugin,
  type UUID,
} from '@elizaos/core';
import {
  actorState,
  agentLogs,
  agentTrades,
  and,
  db,
  desc,
  eq,
  gte,
} from '@feed/db';
import {
  type ActorData,
  loadActorById,
  StaticDataRegistry,
} from '@feed/engine';
import { GROQ_MODELS, type PackActor } from '@feed/shared';
import { feedPlugin } from '../plugins/feed';
import { enhanceRuntimeWithFeed } from '../plugins/feed/integration';
import { groqPlugin } from '../plugins/groq';
import { agentCorePlugin } from '../plugins/plugin-agent-core/src';
// TODO: experiencePlugin disabled due to missing plugin implementation
// Re-enable when plugin-experience is properly implemented and exports valid Plugin
// import { experiencePlugin } from '../plugins/plugin-experience/src';
import { trajectoryLoggerPlugin } from '../plugins/plugin-trajectory-logger/src';
import {
  wrapPluginActions,
  wrapPluginProviders,
} from '../plugins/plugin-trajectory-logger/src/action-interceptor';
import { TrajectoryLoggerService } from '../plugins/plugin-trajectory-logger/src/TrajectoryLoggerService';
import { agentRegistry } from '../services/agent-registry.service';
import { logger } from '../shared/logger';
import { generateSnowflakeId } from '../shared/snowflake';
import { type AgentRegistration, AgentType } from '../types/agent-registry';
import type { JsonValue } from '../types/common';
import { FeedRuntimeAdapter } from './FeedRuntimeAdapter';
import { installRuntimeProviders } from './runtime-providers';

/**
 * Extended AgentRuntime with Feed-specific properties
 * @internal
 */
interface ExtendedAgentRuntime extends AgentRuntime {
  currentModelVersion?: string;
  currentModel?: string;
  trajectoryLogger?: TrajectoryLoggerService;
}

/** Global runtime cache for warm container reuse */
const globalRuntimes = new Map<string, AgentRuntime>();

/** Global trajectory logger instances per agent */
const trajectoryLoggers = new Map<string, TrajectoryLoggerService>();

interface RuntimeLifecycleMetadata {
  createdAtMs: number;
  refreshCount: number;
}

/** Runtime lifecycle metadata used for periodic refresh decisions */
const runtimeLifecycleMetadata = new Map<string, RuntimeLifecycleMetadata>();

const DEFAULT_CONTEXT_REFRESH_HOURS = 48;
const MS_PER_HOUR = 60 * 60 * 1000;
const MAX_REFRESH_WINDOW_LOGS = 250;
const MAX_REFRESH_WINDOW_TRADES = 250;
const CONTEXT_REFRESH_INTERVAL_MS = (() => {
  const configured = Number(process.env.AGENT_CONTEXT_REFRESH_HOURS ?? '');
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * MS_PER_HOUR);
  }
  return DEFAULT_CONTEXT_REFRESH_HOURS * MS_PER_HOUR;
})();

export class AgentRuntimeManager {
  private static instance: AgentRuntimeManager;

  private constructor() {
    logger.info(
      'AgentRuntimeManager initialized',
      undefined,
      'AgentRuntimeManager'
    );
  }

  public static getInstance(): AgentRuntimeManager {
    if (!AgentRuntimeManager.instance) {
      AgentRuntimeManager.instance = new AgentRuntimeManager();
    }
    return AgentRuntimeManager.instance;
  }

  private shouldRefreshRuntime(createdAtMs: number): boolean {
    return Date.now() - createdAtMs >= CONTEXT_REFRESH_INTERVAL_MS;
  }

  private async persistContextRefreshSummary(
    agentUserId: string,
    lifecycle: RuntimeLifecycleMetadata
  ): Promise<void> {
    const refreshEndedAt = new Date();
    const refreshStartedAt = new Date(lifecycle.createdAtMs);

    const [windowLogs, windowTrades, npcSnapshot] = await Promise.all([
      db
        .select({
          type: agentLogs.type,
          level: agentLogs.level,
          createdAt: agentLogs.createdAt,
        })
        .from(agentLogs)
        .where(
          and(
            eq(agentLogs.agentUserId, agentUserId),
            gte(agentLogs.createdAt, refreshStartedAt)
          )
        )
        .orderBy(desc(agentLogs.createdAt))
        .limit(MAX_REFRESH_WINDOW_LOGS),
      db
        .select({
          marketType: agentTrades.marketType,
          action: agentTrades.action,
          pnl: agentTrades.pnl,
          executedAt: agentTrades.executedAt,
        })
        .from(agentTrades)
        .where(
          and(
            eq(agentTrades.agentUserId, agentUserId),
            gte(agentTrades.executedAt, refreshStartedAt)
          )
        )
        .orderBy(desc(agentTrades.executedAt))
        .limit(MAX_REFRESH_WINDOW_TRADES),
      db
        .select({ tradingBalance: actorState.tradingBalance })
        .from(actorState)
        .where(eq(actorState.id, agentUserId))
        .limit(1),
    ]);

    const actionCounts = {
      ticks: 0,
      trades: 0,
      posts: 0,
      comments: 0,
      dms: 0,
      likes: 0,
      reposts: 0,
      errors: 0,
    };

    for (const entry of windowLogs) {
      if (entry.level === 'error') {
        actionCounts.errors++;
      }

      switch (entry.type) {
        case 'tick':
          actionCounts.ticks++;
          break;
        case 'trade':
          actionCounts.trades++;
          break;
        case 'post':
          actionCounts.posts++;
          break;
        case 'comment':
          actionCounts.comments++;
          break;
        case 'dm':
          actionCounts.dms++;
          break;
        case 'like':
          actionCounts.likes++;
          break;
        case 'repost':
          actionCounts.reposts++;
          break;
        default:
          break;
      }
    }

    const closedTrades = windowTrades.filter((trade) => trade.pnl !== null);
    const winningTrades = closedTrades.filter(
      (trade) => Number(trade.pnl ?? 0) > 0
    ).length;
    const realizedPnl = Number(
      closedTrades
        .reduce((acc, trade) => acc + Number(trade.pnl ?? 0), 0)
        .toFixed(2)
    );
    const runtimeAgeHours = Number(
      (
        (refreshEndedAt.getTime() - lifecycle.createdAtMs) /
        MS_PER_HOUR
      ).toFixed(2)
    );

    const npc = npcSnapshot[0];
    const balanceText = npc
      ? `$${Number(npc.tradingBalance ?? 0).toFixed(2)} NPC trading balance`
      : 'balance unavailable';

    const summary =
      `Runtime refreshed after ${runtimeAgeHours}h. ` +
      `Window activity: ${actionCounts.ticks} ticks, ${actionCounts.trades} logged trades, ` +
      `${actionCounts.posts} posts, ${actionCounts.comments} comments, ${actionCounts.dms} DMs, ` +
      `${actionCounts.likes + actionCounts.reposts} engagements. ` +
      `Trade outcomes: ${windowTrades.length} trades, ${closedTrades.length} closed, ${winningTrades} wins, realized PnL ${realizedPnl >= 0 ? '+' : ''}$${Math.abs(realizedPnl).toFixed(2)}. ` +
      `Current state: ${balanceText}.`;

    const metadata: Record<string, JsonValue> = {
      event: 'context_refresh',
      summary,
      refreshCount: lifecycle.refreshCount + 1,
      refreshIntervalHours: Number(
        (CONTEXT_REFRESH_INTERVAL_MS / MS_PER_HOUR).toFixed(2)
      ),
      runtimeAgeHours,
      windowStart: refreshStartedAt.toISOString(),
      windowEnd: refreshEndedAt.toISOString(),
      actionCounts,
      tradeStats: {
        total: windowTrades.length,
        closed: closedTrades.length,
        wins: winningTrades,
        realizedPnl,
      },
      accountState: {
        displayName: StaticDataRegistry.getActor(agentUserId)?.name ?? null,
        balance: npc ? Number(npc.tradingBalance ?? 0) : null,
      },
      lastActionAt:
        windowLogs[0]?.createdAt instanceof Date
          ? windowLogs[0].createdAt.toISOString()
          : null,
      logsSampled: windowLogs.length,
      tradesSampled: windowTrades.length,
    };

    await db.insert(agentLogs).values({
      id: await generateSnowflakeId(),
      agentUserId,
      type: 'system',
      level: 'info',
      message: 'Context refresh checkpoint',
      metadata,
    });
  }

  /**
   * Gets or creates a runtime for a registered NPC.
   *
   * @param agentUserId - Agent user ID
   * @returns Agent runtime instance
   */
  public async getRuntime(agentUserId: string): Promise<AgentRuntime> {
    const registration = await agentRegistry.getAgentById(agentUserId);
    const actor = StaticDataRegistry.getActor(agentUserId);
    if (
      registration?.type !== AgentType.NPC ||
      registration.agentId !== agentUserId ||
      actor?.id !== agentUserId
    ) {
      throw new Error(`Only registered NPCs can run in Feed: ${agentUserId}`);
    }
    let refreshCount = 0;

    if (globalRuntimes.has(agentUserId)) {
      const lifecycle = runtimeLifecycleMetadata.get(agentUserId);

      if (!lifecycle) {
        runtimeLifecycleMetadata.set(agentUserId, {
          createdAtMs: Date.now(),
          refreshCount: 0,
        });
        const runtime = globalRuntimes.get(agentUserId)!;
        logger.info(
          `Using cached runtime for agent ${agentUserId} (lifecycle initialized)`,
          undefined,
          'AgentRuntimeManager'
        );
        return runtime;
      }

      if (!this.shouldRefreshRuntime(lifecycle.createdAtMs)) {
        const runtime = globalRuntimes.get(agentUserId)!;
        logger.info(
          `Using cached runtime for agent ${agentUserId}`,
          undefined,
          'AgentRuntimeManager'
        );
        return runtime;
      }

      refreshCount = lifecycle.refreshCount + 1;
      const runtimeAgeHours = (
        (Date.now() - lifecycle.createdAtMs) /
        MS_PER_HOUR
      ).toFixed(2);

      logger.info(
        `Refreshing runtime for agent ${agentUserId} after ${runtimeAgeHours}h`,
        {
          refreshIntervalHours: CONTEXT_REFRESH_INTERVAL_MS / MS_PER_HOUR,
          refreshCount,
        },
        'AgentRuntimeManager'
      );

      await this.persistContextRefreshSummary(agentUserId, lifecycle);

      await this.clearRuntime(agentUserId);
    }

    const runtime = await this.createNpcRuntime(registration);
    const runtimeInstanceId = await generateSnowflakeId();
    await agentRegistry.setRuntimeInstance(agentUserId, runtimeInstanceId);
    globalRuntimes.set(agentUserId, runtime);
    runtimeLifecycleMetadata.set(agentUserId, {
      createdAtMs: Date.now(),
      refreshCount,
    });
    logger.debug(
      `Runtime created for NPC ${agentUserId}`,
      undefined,
      'AgentRuntimeManager'
    );
    return runtime;
  }

  /**
   * Create runtime for NPC agent
   * Loads ActorData and creates Character from NPC configuration
   */
  private async createNpcRuntime(
    registration: AgentRegistration
  ): Promise<AgentRuntime> {
    // Verify actor exists in static registry
    const actor = StaticDataRegistry.getActor(registration.agentId);

    if (!actor) {
      throw new Error(
        `Actor ${registration.agentId} not found in static registry`
      );
    }

    // Try to get full PackActor for rich Eliza character fields
    const packActor: PackActor | undefined = StaticDataRegistry.getPackActor(
      registration.agentId
    );

    let character: Character;

    if (packActor) {
      // Build full Character from PackActor with ALL Eliza fields
      // Feed stores style/messageExamples as plain JSON objects;
      // ElizaOS Character type expects protobuf wrappers ($typeName, etc.).
      // The runtime normalizes these at init time — cast through unknown.
      character = {
        name: packActor.name,
        system: packActor.system,
        bio: packActor.bio,
        lore: packActor.lore,
        topics: packActor.topics,
        adjectives: packActor.adjectives,
        style: packActor.style,
        messageExamples: packActor.messageExamples,
        postExamples: packActor.postExamples,
        plugins: [],
        settings: {
          ...this.getModelSettings(),
          model: packActor.settings.model,
        },
      } as unknown as Character;

      // Attach feed metadata so MultiStepExecutor can access autonomy flags
      (character as unknown as Record<string, unknown>).feed = packActor.feed;
    } else {
      // Fallback: build minimal Character from ActorData (backward compat)
      const actorData: ActorData | null = loadActorById(actor.id);
      if (!actorData) {
        throw new Error(`ActorData ${actor.id} not found in data files`);
      }

      const bio: string[] = [];
      if (actorData.description) {
        bio.push(actorData.description);
      }
      if (actorData.pfpDescription) {
        bio.push(`Physical: ${actorData.pfpDescription}`);
      }
      if (actorData.role) {
        bio.push(`Role: ${actorData.role}`);
      }

      character = {
        name: registration.name,
        system: registration.systemPrompt,
        bio,
        messageExamples: [],
        plugins: [],
        settings: this.getModelSettings(),
      };
    }

    return this.createRuntimeWithPlugins(registration.agentId, character);
  }

  /** Create an NPC runtime with the shared game plugins. */
  private async createRuntimeWithPlugins(
    agentId: string,
    character: Character
  ): Promise<AgentRuntime> {
    // Database configuration
    const dbPort = process.env.POSTGRES_DEV_PORT || 5432;
    const postgresUrl =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      `postgres://postgres:password@localhost:${dbPort}/feed`;

    // Create runtime with standard plugins
    // NPCs use GROQ only - skip OpenAI/Anthropic to avoid API validation spam during bootstrap
    const hasGroqAccess = !!(
      process.env.SURPLUS_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.ELIZACLOUD_API_KEY
    );
    const plugins: Plugin[] = [
      agentCorePlugin as Plugin,
      trajectoryLoggerPlugin as Plugin,
      // GROQ (or ElizaCloud) is always available for NPCs
      ...(hasGroqAccess ? [groqPlugin as Plugin] : []),
    ];

    const runtimeConfig = {
      character,
      agentId: agentId as UUID,
      plugins,
      settings: {
        ...character.settings,
        POSTGRES_URL: postgresUrl,
      },
    };

    const runtime = new AgentRuntime(runtimeConfig) as ExtendedAgentRuntime;

    // Store model version on runtime for LLM call logging
    if (character.settings?.MODEL_VERSION) {
      runtime.currentModelVersion = character.settings.MODEL_VERSION as string;
    }
    runtime.currentModel = 'groq';

    // Feed persists domain state in PostgreSQL; runtime metadata is process-local.
    runtime.registerDatabaseAdapter(new FeedRuntimeAdapter());

    // Configure logger
    this.configureLogger(runtime, character.name ?? 'agent');

    // Register plugins
    const pluginRegistrationPromises: Promise<void>[] = [];
    const pluginsToLoad = plugins;

    for (const plugin of pluginsToLoad) {
      if (plugin) {
        pluginRegistrationPromises.push(runtime.registerPlugin(plugin));
      }
    }
    await Promise.all(pluginRegistrationPromises);

    // Initialize runtime to signal services that runtime is ready
    // This prevents 30s timeout errors in services waiting for runtime initialization
    // Skip migrations — see comment in createNPCAgentRuntime for rationale.
    await runtime.initialize({ skipMigrations: true });
    installRuntimeProviders(runtime, plugins);

    const trajectoryLogger = await this.getRuntimeTrajectoryLogger(
      runtime,
      agentId
    );

    await this.enhanceWithFeed(runtime, agentId, trajectoryLogger);

    // Store trajectory logger reference on runtime
    runtime.trajectoryLogger = trajectoryLogger;

    return runtime;
  }

  /**
   * Get model settings (Groq configuration)
   * Shared logic for model configuration
   */
  private getModelSettings(): Record<string, string> {
    return {
      // ElizaCloud unified inference (takes priority over direct provider keys)
      ELIZACLOUD_API_KEY: process.env.ELIZACLOUD_API_KEY || '',
      ELIZACLOUD_API_URL: process.env.ELIZACLOUD_API_URL || '',
      // GROQ configuration (used when ELIZACLOUD_API_KEY is not set)
      // Keys must match what groq.ts plugin looks up via runtime.getSetting()
      GROQ_API_KEY: process.env.GROQ_API_KEY || '',
      GROQ_BASE_URL: process.env.GROQ_BASE_URL || '',
      GROQ_LARGE_MODEL:
        process.env.GROQ_LARGE_MODEL ||
        process.env.GROQ_PRIMARY_MODEL ||
        GROQ_MODELS.PRO.modelId,
      GROQ_PRIMARY_MODEL:
        process.env.GROQ_PRIMARY_MODEL ||
        process.env.GROQ_LARGE_MODEL ||
        GROQ_MODELS.PRO.modelId,
      GROQ_SMALL_MODEL:
        process.env.GROQ_SMALL_MODEL ||
        process.env.GROQ_PRIMARY_MODEL ||
        GROQ_MODELS.FREE.modelId,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    };
  }

  /**
   * Configure runtime logger
   */
  private configureLogger(runtime: AgentRuntime, agentName: string): void {
    if (!runtime.logger || !runtime.logger.log) {
      const customLogger = {
        log: (msg: string) =>
          logger.info(msg, undefined, `Agent[${agentName}]`),
        info: (msg: string) =>
          logger.info(msg, undefined, `Agent[${agentName}]`),
        warn: (msg: string) =>
          logger.warn(msg, undefined, `Agent[${agentName}]`),
        error: (msg: string) =>
          logger.error(msg, new Error(msg), `Agent[${agentName}]`),
        debug: (msg: string) =>
          logger.debug(msg, undefined, `Agent[${agentName}]`),
        success: (msg: string) =>
          logger.info(`✓ ${msg}`, undefined, `Agent[${agentName}]`),
        notice: (msg: string) =>
          logger.info(msg, undefined, `Agent[${agentName}]`),
        level: 'info' as const,
        trace: (msg: string) =>
          logger.debug(msg, undefined, `Agent[${agentName}]`),
        fatal: (msg: string) =>
          logger.error(msg, new Error(msg), `Agent[${agentName}]`),
        progress: (msg: string) =>
          logger.info(msg, undefined, `Agent[${agentName}]`),
        // biome-ignore lint/suspicious/noConsole: console.clear is not a logging call
        clear: () => (console.clear ? console.clear() : undefined),
        child: () => customLogger,
      } as typeof runtime.logger;
      runtime.logger = customLogger;
    }
  }

  private async getRuntimeTrajectoryLogger(
    runtime: AgentRuntime,
    runtimeId: string
  ): Promise<TrajectoryLoggerService> {
    const existing = runtime.getService<TrajectoryLoggerService>(
      TrajectoryLoggerService.serviceType
    );

    if (existing) {
      trajectoryLoggers.set(runtimeId, existing);
      return existing;
    }

    const service = (await runtime.getServiceLoadPromise(
      TrajectoryLoggerService.serviceType
    )) as TrajectoryLoggerService;

    trajectoryLoggers.set(runtimeId, service);
    return service;
  }

  /**
   * Enhance runtime with Feed plugin (wrapped for trajectory logging)
   */
  private async enhanceWithFeed(
    runtime: AgentRuntime,
    agentId: string,
    trajectoryLogger: TrajectoryLoggerService
  ): Promise<void> {
    // Wrap Feed plugin BEFORE registering (so wrapped version is used)
    let wrappedFeedPlugin = feedPlugin;
    if (feedPlugin.actions) {
      wrappedFeedPlugin = wrapPluginActions(
        wrappedFeedPlugin,
        trajectoryLogger
      );
    }
    if (feedPlugin.providers) {
      wrappedFeedPlugin = wrapPluginProviders(
        wrappedFeedPlugin,
        trajectoryLogger
      );
    }

    // Enhance with wrapped Feed plugin
    await enhanceRuntimeWithFeed(runtime, agentId, wrappedFeedPlugin);
  }

  /**
   * Get trajectory logger for an agent
   */
  public getTrajectoryLogger(
    agentUserId: string
  ): TrajectoryLoggerService | null {
    return trajectoryLoggers.get(agentUserId) || null;
  }

  /**
   * Remove runtime from cache
   */
  public async clearRuntime(agentUserId: string): Promise<void> {
    if (globalRuntimes.has(agentUserId)) {
      await globalRuntimes.get(agentUserId)!.stop();
      globalRuntimes.delete(agentUserId);
      trajectoryLoggers.delete(agentUserId);
      runtimeLifecycleMetadata.delete(agentUserId);

      // Update registry status if agent exists in registry
      await agentRegistry.clearRuntimeInstance(agentUserId);

      logger.info(
        `Runtime cleared for agent ${agentUserId}`,
        undefined,
        'AgentRuntimeManager'
      );
    }
  }

  /**
   * Backwards-compatible alias used by the training package.
   */
  public async resetRuntime(agentUserId: string): Promise<void> {
    await this.clearRuntime(agentUserId);
  }

  public clearAllRuntimes(): void {
    globalRuntimes.clear();
    trajectoryLoggers.clear();
    runtimeLifecycleMetadata.clear();
    logger.info('All runtimes cleared', undefined, 'AgentRuntimeManager');
  }

  public getRuntimeCount(): number {
    return globalRuntimes.size;
  }

  public hasRuntime(agentUserId: string): boolean {
    return globalRuntimes.has(agentUserId);
  }
}

// Export singleton instance (lazy initialization to avoid circular dependencies)
let _agentRuntimeManagerInstance: AgentRuntimeManager | null = null;

function getManagerInstance(): AgentRuntimeManager {
  if (!_agentRuntimeManagerInstance) {
    _agentRuntimeManagerInstance = AgentRuntimeManager.getInstance();
  }
  return _agentRuntimeManagerInstance;
}

export const agentRuntimeManager = {
  getInstance(): AgentRuntimeManager {
    return getManagerInstance();
  },
  async getRuntime(agentUserId: string) {
    return getManagerInstance().getRuntime(agentUserId);
  },
  getTrajectoryLogger(agentUserId: string) {
    return getManagerInstance().getTrajectoryLogger(agentUserId);
  },
  async clearRuntime(agentUserId: string) {
    return getManagerInstance().clearRuntime(agentUserId);
  },
  async resetRuntime(agentUserId: string) {
    return getManagerInstance().resetRuntime(agentUserId);
  },
  clearAllRuntimes() {
    return getManagerInstance().clearAllRuntimes();
  },
  getRuntimeCount() {
    return getManagerInstance().getRuntimeCount();
  },
  hasRuntime(agentUserId: string) {
    return getManagerInstance().hasRuntime(agentUserId);
  },
} as AgentRuntimeManager & { getInstance(): AgentRuntimeManager };
