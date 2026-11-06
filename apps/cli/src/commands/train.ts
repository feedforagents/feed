#!/usr/bin/env bun

/**
 * Training Commands
 *
 * Commands:
 *   archetype   - Train a specific agent archetype
 *   collect     - Collect trajectories for training
 *   score       - Score collected trajectories
 *   pipeline    - Run canonical training pipeline
 *   list        - List available archetypes
 *   run         - Run full training (alias for pipeline)
 */

import {
  getAvailableArchetypes,
  getPriorityMetrics,
  getRubric,
  hasCustomRubric,
} from '@feed/training/rubrics/index';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { getFlag, getOption, parseArgs, wantsHelp } from '../lib/args.js';
import { logger } from '../lib/logger.js';

function createCliUsageError(message: string): Error {
  const error = new Error(message);
  error.name = 'CliUsageError';
  return error;
}

type PythonCommand = {
  command: string;
  prefixArgs: string[];
};

function resolvePythonCommand(workspaceRoot: string): PythonCommand {
  const configuredPython = process.env.PYTHON_BIN?.trim();

  if (configuredPython) {
    return { command: configuredPython, prefixArgs: [] };
  }

  const venvCandidates =
    process.platform === 'win32'
      ? [
          join(
            workspaceRoot,
            'packages/training/python/.venv/Scripts/python.exe'
          ),
          join(
            workspaceRoot,
            'packages/training/python/venv/Scripts/python.exe'
          ),
        ]
      : [
          join(workspaceRoot, 'packages/training/python/.venv/bin/python'),
          join(workspaceRoot, 'packages/training/python/venv/bin/python'),
        ];

  for (const candidate of venvCandidates) {
    if (existsSync(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }

  if (process.platform === 'win32') {
    return { command: 'py', prefixArgs: ['-3'] };
  }

  return { command: 'python3', prefixArgs: [] };
}

// Heavy imports loaded lazily to avoid initializing connections for simple commands
async function getDbImports() {
  const dbMod = await import('@feed/db');
  return {
    db: dbMod.db,
    eq: dbMod.eq,
    and: dbMod.and,
    isNull: dbMod.isNull,
    not: dbMod.not,
    count: dbMod.count,
    trajectories: dbMod.trajectories,
    closeDatabase: dbMod.closeDatabase,
    users: dbMod.users,
    userAgentConfigs: dbMod.userAgentConfigs,
  };
}

async function getTrainingImports() {
  const trainingMod = await import('@feed/training');
  return {
    archetypeScoringService: trainingMod.archetypeScoringService,
    trajectoryMetricsExtractor: trainingMod.trajectoryMetricsExtractor,
    configureTrainingDependencies: trainingMod.configureTrainingDependencies,
  };
}

async function configureLLMCaller() {
  const { FeedLLMClient } = await import('@feed/engine');
  const { configureTrainingDependencies } = await getTrainingImports();

  // Create LLM client for scoring
  const llmClient = FeedLLMClient.forGameTick();

  // Create adapter that implements ILLMCaller interface
  const llmCaller = {
    callGroqDirect: async (params: {
      prompt: string;
      system: string;
      modelSize?: 'small' | 'medium' | 'large';
      temperature?: number;
      maxTokens?: number;
      actionType?: string;
      responseFormat?: { type: 'json_object' };
    }): Promise<string> => {
      const fullPrompt = `${params.system}\n\n${params.prompt}`;
      const response = await llmClient.generateJSON<{ result: string }>(
        fullPrompt,
        undefined,
        {
          maxTokens: params.maxTokens || 1000,
          temperature: params.temperature || 0.3,
          format: 'json',
        }
      );
      return typeof response === 'string' ? response : JSON.stringify(response);
    },
  };

  configureTrainingDependencies({ llmCaller });
}

function printHelp(): void {
  const archetypes = getAvailableArchetypes();

  console.log(`
Training Commands

USAGE:
  feed train <command> [options]

COMMANDS:
  list        List available archetypes with details
  pipeline    Run canonical training pipeline (Python)
  run         Alias for pipeline
  archetype   Score & export trajectories for archetype
  score       Score collected trajectories
  online      Run continuous online RL training (single or multi-agent)

PIPELINE OPTIONS:
  -a, --archetype=NAME     Train specific archetype (or 'all')
  --archetypes=A,B,C       Train multiple archetypes
  -n, --agents=N           Number of agents (default: 10)
  -t, --ticks=N            Ticks per agent (default: 30)
  -o, --output=DIR         Output directory (default: trained_models)
  --lookback-hours=N       Trajectory lookback window for loading real data
  --min-actions=N          Minimum actions required per trajectory
  --max-trajectories=N     Cap loaded trajectories for training (0 = all)
  --trajectory-source=SRC  Trajectory source: db, huggingface, local_export
  --source-dir=DIR         Local export directory when using local_export source
  --hf-dataset=ID          Hugging Face dataset id when using huggingface source
  --hf-split=NAME          Hugging Face split when using huggingface source
  --training-backend=NAME  Training backend: auto, local, tinker
  --local-backend=NAME     Local training backend: mlx, cuda, cpu
  --local-model=NAME       Override local training base model
  --local-steps=N          Local training iterations / optimizer steps
  --local-batch-size=N     Local training batch size
  --local-lr=N             Local training learning rate
  --tinker-steps=N         Tinker training steps
  --tinker-group-size=N    Tinker GRPO group size
  --tinker-lr=N            Tinker learning rate
  --tinker-lora-rank=N     Tinker LoRA rank
  --tinker-weight-sync-interval=N
                           Tinker weight sync interval in steps
  --skip-rl                Skip RL even if the environment supports it
  --require-rl             Fail the pipeline if RL cannot run
  --rl-steps=N             RL training steps (default: 100)
  --rl-batch-size=N        RL batch size (default: 4)
  --rl-lr=N                RL learning rate (default: 1e-5)
  --reward-profile=NAME    RL reward profile (default: default)
  --skip-scambench         Skip the ScamBench stage
  --prepare-only           Prepare ranked data only, skip local training fallback
  --no-local-validate      Skip post-training validation prompt
  --no-benchmark           Skip benchmarking
  --benchmark-only         Run benchmark phase only using existing data
  --allow-mismatched-reuse Reuse benchmark artifacts even if lineage does not match the requested model
  --dry-run                Show what would be done

LIST OPTIONS:
  -v, --verbose            Show rubric previews

ARCHETYPE OPTIONS:
  -a, --archetype=NAME     Archetype to train (required)
  -m, --min-trajectories=N Minimum trajectories required (default: 20)
  -d, --dry-run            Show what would be done
  -s, --score-only         Only score, don't export

AVAILABLE ARCHETYPES:
${archetypes.map((a) => `  - ${a}`).join('\n')}

ONLINE RL OPTIONS:
  --mode=MODE              single or multi (default: single)
  --num-agents=N           Number of agents for multi mode (default: 4)
  --optimizer=NAME         adamw or apollo (default: apollo)
  --kondo                  Enable Kondo gate for selective backward passes
  --kondo-gate-rate=N      Fraction of backward passes to keep (default: 0.03)
  --turboquant             Enable TurboQuant KV cache compression
  --pbt                    Enable population-based training (multi mode)
  --bridge-url=URL         Feed simulation bridge URL
  --max-ticks=N            Maximum training ticks (0 = unlimited)

EXAMPLES:
  feed train list                          # List all archetypes
  feed train list --verbose                # Show rubric previews
  feed train pipeline -a trader            # Train trader archetype
  feed train pipeline --archetypes=trader,scammer,degen
  feed train run -a all                    # Train all archetypes
  feed train archetype -a scammer          # Score & export scammer data
  feed train online --optimizer=apollo --kondo --turboquant --pbt
`);
}

interface ArchetypeStats {
  totalTrajectories: number;
  unscoredTrajectories: number;
  scoredTrajectories: number;
}

async function getArchetypeStats(): Promise<ArchetypeStats> {
  const { db, eq, and, isNull, not, count, trajectories } =
    await getDbImports();

  // Count total training trajectories
  const totalResult = await db
    .select({ count: count() })
    .from(trajectories)
    .where(
      and(
        eq(trajectories.isTrainingData, true),
        not(eq(trajectories.stepsJson, 'null')),
        not(eq(trajectories.stepsJson, '[]'))
      )
    );

  const totalTrajectories = totalResult[0]?.count || 0;

  // Count unscored
  const unscoredResult = await db
    .select({ count: count() })
    .from(trajectories)
    .where(
      and(
        eq(trajectories.isTrainingData, true),
        isNull(trajectories.aiJudgeReward),
        not(eq(trajectories.stepsJson, 'null')),
        not(eq(trajectories.stepsJson, '[]'))
      )
    );

  const unscoredTrajectories = unscoredResult[0]?.count || 0;

  return {
    totalTrajectories,
    unscoredTrajectories,
    scoredTrajectories: totalTrajectories - unscoredTrajectories,
  };
}

async function scoreArchetypeTrajectories(
  archetype: string,
  dryRun: boolean
): Promise<{ scored: number; errors: number }> {
  if (dryRun) {
    console.log(`[DRY RUN] Would score unscored ${archetype} trajectories`);
    return { scored: 0, errors: 0 };
  }

  logger.step(`Scoring trajectories with ${archetype} rubric...`);

  // Configure LLM for scoring
  await configureLLMCaller();

  const { archetypeScoringService } = await getTrainingImports();
  console.log('   Calling scoring service...');
  const result = await archetypeScoringService.scoreUnscoredTrajectories(
    archetype,
    100
  );
  console.log(`  ✅ Scored: ${result.scored}`);
  if (result.errors > 0) {
    console.log(`  ⚠️  Errors: ${result.errors}`);
  }
  return result;
}

async function exportForTraining(
  archetype: string,
  minTrajectories: number,
  dryRun: boolean
): Promise<{ exported: number; path: string | null }> {
  const { db, eq, and, isNull, not, trajectories } = await getDbImports();
  const { trajectoryMetricsExtractor } = await getTrainingImports();

  // Get scored trajectories with valid data
  const scoredResult = await db
    .select({
      trajectoryId: trajectories.trajectoryId,
      agentId: trajectories.agentId,
      stepsJson: trajectories.stepsJson,
      aiJudgeReward: trajectories.aiJudgeReward,
      aiJudgeReasoning: trajectories.aiJudgeReasoning,
      scenarioId: trajectories.scenarioId,
      finalPnL: trajectories.finalPnL,
    })
    .from(trajectories)
    .where(
      and(
        eq(trajectories.isTrainingData, true),
        not(isNull(trajectories.aiJudgeReward)),
        not(eq(trajectories.stepsJson, 'null')),
        not(eq(trajectories.stepsJson, '[]'))
      )
    );

  if (scoredResult.length < minTrajectories) {
    logger.warn(
      `Not enough scored trajectories: ${scoredResult.length} < ${minTrajectories}`
    );
    return { exported: 0, path: null };
  }

  if (dryRun) {
    console.log(
      `[DRY RUN] Would export ${scoredResult.length} trajectories for ${archetype} training`
    );
    return { exported: scoredResult.length, path: null };
  }

  logger.step(`Exporting ${scoredResult.length} trajectories for training...`);

  // Create export directory
  const exportDir = `./training-data/${archetype}`;
  const { mkdir, writeFile } = await import('fs/promises');
  await mkdir(exportDir, { recursive: true });

  // Export as JSONL for GRPO training
  const exportPath = `${exportDir}/trajectories-${Date.now()}.jsonl`;
  const lines: string[] = [];

  for (const traj of scoredResult) {
    const metrics = trajectoryMetricsExtractor.extractFromRaw({
      trajectoryId: traj.trajectoryId,
      agentId: traj.agentId,
      stepsJson: traj.stepsJson,
      scenarioId: traj.scenarioId ?? undefined,
      finalPnL: traj.finalPnL ?? undefined,
    });

    const exportRecord = {
      trajectory_id: traj.trajectoryId,
      agent_id: traj.agentId,
      archetype,
      score: traj.aiJudgeReward,
      reasoning: traj.aiJudgeReasoning,
      scenario_id: traj.scenarioId,
      final_pnl: traj.finalPnL,
      steps: JSON.parse(traj.stepsJson),
      metrics: metrics || {},
    };

    lines.push(JSON.stringify(exportRecord));
  }

  await writeFile(exportPath, lines.join('\n'));

  logger.success(`Exported to: ${exportPath}`);

  return { exported: scoredResult.length, path: exportPath };
}

async function trainArchetype(
  args: ReturnType<typeof parseArgs>
): Promise<void> {
  const archetype = (getOption(args, 'archetype', 'a') || '').toLowerCase();
  const minTrajectories = parseInt(
    getOption(args, 'min-trajectories', 'm') || '20',
    10
  );
  const dryRun = getFlag(args, 'dry-run', 'd');
  const scoreOnly = getFlag(args, 'score-only', 's');
  const verbose = getFlag(args, 'verbose', 'v');

  if (!archetype) {
    logger.fail('--archetype is required');
    console.log('\nAvailable archetypes:');
    for (const a of getAvailableArchetypes()) {
      console.log(`  - ${a}`);
    }
    process.exit(1);
  }

  if (!hasCustomRubric(archetype)) {
    logger.warn(`No custom rubric for "${archetype}", using default rubric`);
  }

  logger.header(`Training: ${archetype.toUpperCase()}`);

  // Get stats
  logger.step('Gathering statistics...');
  const stats = await getArchetypeStats();

  console.log(`
   Total trajectories:    ${stats.totalTrajectories}
   Already scored:        ${stats.scoredTrajectories}
   Need scoring:          ${stats.unscoredTrajectories}
`);

  if (stats.totalTrajectories === 0) {
    logger.fail(`No trajectories found`);
    console.log(`
To generate trajectories (requires a running server):
  feed train parallel --archetypes ${archetype} --num-agents 3 --ticks 20
  feed train archetype -a ${archetype}
`);
    process.exit(1);
  }

  // Show rubric preview
  if (verbose) {
    console.log('📜 Rubric preview (first 500 chars):');
    const rubric = getRubric(archetype);
    console.log(`   ${rubric.substring(0, 500).replace(/\n/g, '\n   ')}...`);
    console.log('');
  }

  // Score unscored trajectories
  if (stats.unscoredTrajectories > 0) {
    const scoreResult = await scoreArchetypeTrajectories(archetype, dryRun);
    stats.scoredTrajectories += scoreResult.scored;
  } else {
    logger.success('All trajectories already scored');
  }

  // Export for training (unless score-only)
  if (!scoreOnly) {
    const exportResult = await exportForTraining(
      archetype,
      minTrajectories,
      dryRun
    );

    if (exportResult.path) {
      console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                      TRAINING READY                           ║
╚═══════════════════════════════════════════════════════════════╝

Data exported to: ${exportResult.path}

Next step:
  feed train pipeline --archetype ${archetype}
`);
    }
  } else {
    logger.success(
      `Scoring complete. Total scored: ${stats.scoredTrajectories}`
    );
    console.log(`
To export for training, run without --score-only:
  feed train archetype -a ${archetype}
`);
  }
}

async function scoreTrajectories(): Promise<void> {
  logger.header('Score Trajectories');

  const stats = await getArchetypeStats();

  console.log(`Total trajectories: ${stats.totalTrajectories}`);
  console.log(`Already scored: ${stats.scoredTrajectories}`);
  console.log(`Need scoring: ${stats.unscoredTrajectories}`);

  if (stats.unscoredTrajectories === 0) {
    logger.success('All trajectories already scored');
    return;
  }

  // Configure LLM for scoring
  console.log('Configuring LLM for scoring...');
  await configureLLMCaller();

  const { archetypeScoringService } = await getTrainingImports();
  console.log('Scoring trajectories with AI judge...');

  const result = await archetypeScoringService.scoreUnscoredTrajectories(
    'default',
    100
  );

  logger.success(`Scored ${result.scored} trajectories`);
  if (result.errors > 0) {
    logger.warn(`${result.errors} errors encountered`);
  }
}

async function listArchetypes(
  args: ReturnType<typeof parseArgs>
): Promise<void> {
  const verbose = getFlag(args, 'verbose', 'v');
  const archetypes = getAvailableArchetypes();

  logger.header('Available Archetypes');
  console.log();

  for (const archetype of archetypes) {
    const metrics = getPriorityMetrics(archetype);
    const rubric = getRubric(archetype);

    console.log(`📦 ${archetype.toUpperCase()}`);
    console.log(`   Priority Metrics: ${metrics.join(', ')}`);

    if (verbose) {
      const preview = rubric
        .split('\n')
        .slice(0, 8)
        .map((line) => `   ${line}`)
        .join('\n');
      console.log(`   Rubric Preview:`);
      console.log(preview);
      console.log('   ...');
    }

    console.log();
  }

  console.log(`Total: ${archetypes.length} archetypes`);
  console.log();
  console.log('To train an archetype:');
  console.log('  feed train pipeline -a <archetype>');
  console.log('  feed train pipeline --archetypes=trader,scammer,degen');
  console.log('  feed train pipeline -a all  # Train all archetypes');
}

async function runPipeline(args: ReturnType<typeof parseArgs>): Promise<void> {
  const archetype = getOption(args, 'archetype', 'a');
  const archetypesArg = getOption(args, 'archetypes', '');
  const agents = getOption(args, 'agents', 'n') || '10';
  const ticks = getOption(args, 'ticks', 't') || '30';
  const output = getOption(args, 'output', 'o') || 'trained_models';
  const noBenchmark = getFlag(args, 'no-benchmark', '');
  const benchmarkOnly = getFlag(args, 'benchmark-only', '');
  const allowMismatchedReuse = getFlag(args, 'allow-mismatched-reuse', '');
  const dryRun = getFlag(args, 'dry-run', 'd');
  const prepareOnly = getFlag(args, 'prepare-only', '');
  const noLocalValidate = getFlag(args, 'no-local-validate', '');
  const trainingBackend = getOption(args, 'training-backend', '');
  const trajectorySource = getOption(args, 'trajectory-source', '');
  const sourceDir = getOption(args, 'source-dir', '');
  const hfDataset = getOption(args, 'hf-dataset', '');
  const hfSplit = getOption(args, 'hf-split', '');
  const localBackend = getOption(args, 'local-backend', '');
  const localModel = getOption(args, 'local-model', '');
  const localSteps = getOption(args, 'local-steps', '');
  const localBatchSize = getOption(args, 'local-batch-size', '');
  const localLr = getOption(args, 'local-lr', '');
  const tinkerSteps = getOption(args, 'tinker-steps', '');
  const tinkerGroupSize = getOption(args, 'tinker-group-size', '');
  const tinkerLr = getOption(args, 'tinker-lr', '');
  const tinkerLoraRank = getOption(args, 'tinker-lora-rank', '');
  const tinkerWeightSyncInterval = getOption(
    args,
    'tinker-weight-sync-interval',
    ''
  );
  const lookbackHours = getOption(args, 'lookback-hours', '');
  const minActions = getOption(args, 'min-actions', '');
  const maxTrajectories = getOption(args, 'max-trajectories', '');
  const skipRl = getFlag(args, 'skip-rl', '');
  const requireRl = getFlag(args, 'require-rl', '');
  const rlSteps = getOption(args, 'rl-steps', '');
  const rlBatchSize = getOption(args, 'rl-batch-size', '');
  const rlLr = getOption(args, 'rl-lr', '');
  const rewardProfile = getOption(args, 'reward-profile', '');
  const skipScamBench = getFlag(args, 'skip-scambench', '');

  logger.header('Feed Training Pipeline');

  if (noBenchmark && benchmarkOnly) {
    logger.fail('--no-benchmark and --benchmark-only cannot be used together');
    throw createCliUsageError(
      '--no-benchmark and --benchmark-only cannot be used together'
    );
  }

  // Find workspace root (go up from apps/cli/src/commands to workspace root)
  const workspaceRoot = join(import.meta.dir, '..', '..', '..', '..');

  // Find the Python script
  const scriptPath = join(
    workspaceRoot,
    'packages/training/python/scripts/run_pipeline.py'
  );
  const python = resolvePythonCommand(workspaceRoot);

  // Build command args
  const pythonArgs = [
    scriptPath,
    '--mode',
    benchmarkOnly ? 'benchmark' : 'full',
    '--agents',
    agents,
    '--ticks',
    ticks,
    '--output',
    output,
  ];

  // Handle archetypes
  if (archetype === 'all') {
    pythonArgs.push('--archetypes', ...getAvailableArchetypes());
  } else if (archetype) {
    pythonArgs.push('--archetype', archetype);
  } else if (archetypesArg) {
    pythonArgs.push(
      '--archetypes',
      ...archetypesArg.split(',').map((a) => a.trim())
    );
  }

  if (noBenchmark) {
    pythonArgs.push('--skip-scambench');
  }

  if (prepareOnly) {
    pythonArgs.push('--prepare-only');
  }
  if (noLocalValidate) {
    pythonArgs.push('--no-local-validate');
  }
  if (trainingBackend) {
    pythonArgs.push('--training-backend', trainingBackend);
  }
  if (trajectorySource) {
    pythonArgs.push('--trajectory-source', trajectorySource);
  }
  if (sourceDir) {
    pythonArgs.push('--source-dir', sourceDir);
  }
  if (hfDataset) {
    pythonArgs.push('--hf-dataset', hfDataset);
  }
  if (hfSplit) {
    pythonArgs.push('--hf-split', hfSplit);
  }
  if (localBackend) {
    pythonArgs.push('--local-backend', localBackend);
  }
  if (localModel) {
    pythonArgs.push('--local-model', localModel);
  }
  if (localSteps) {
    pythonArgs.push('--local-steps', localSteps);
  }
  if (localBatchSize) {
    pythonArgs.push('--local-batch-size', localBatchSize);
  }
  if (localLr) {
    pythonArgs.push('--local-lr', localLr);
  }
  if (tinkerSteps) {
    pythonArgs.push('--tinker-steps', tinkerSteps);
  }
  if (tinkerGroupSize) {
    pythonArgs.push('--tinker-group-size', tinkerGroupSize);
  }
  if (tinkerLr) {
    pythonArgs.push('--tinker-lr', tinkerLr);
  }
  if (tinkerLoraRank) {
    pythonArgs.push('--tinker-lora-rank', tinkerLoraRank);
  }
  if (tinkerWeightSyncInterval) {
    pythonArgs.push('--tinker-weight-sync-interval', tinkerWeightSyncInterval);
  }
  if (lookbackHours) {
    pythonArgs.push('--lookback-hours', lookbackHours);
  }
  if (minActions) {
    pythonArgs.push('--min-actions', minActions);
  }
  if (maxTrajectories) {
    pythonArgs.push('--max-trajectories', maxTrajectories);
  }
  if (skipRl) {
    pythonArgs.push('--skip-rl');
  }
  if (requireRl) {
    pythonArgs.push('--require-rl');
  }
  if (rlSteps) {
    pythonArgs.push('--rl-steps', rlSteps);
  }
  if (rlBatchSize) {
    pythonArgs.push('--rl-batch-size', rlBatchSize);
  }
  if (rlLr) {
    pythonArgs.push('--rl-lr', rlLr);
  }
  if (rewardProfile) {
    pythonArgs.push('--reward-profile', rewardProfile);
  }
  if (skipScamBench) {
    pythonArgs.push('--skip-scambench');
  }
  if (allowMismatchedReuse) {
    pythonArgs.push('--allow-mismatched-reuse');
  }

  console.log();
  console.log('Configuration:');
  console.log(`  Agents: ${agents}`);
  console.log(`  Ticks per agent: ${ticks}`);
  console.log(`  Output: ${output}`);
  console.log(
    `  Mode: ${benchmarkOnly ? 'benchmark-only' : noBenchmark ? 'full (no benchmark)' : 'full'}`
  );
  console.log(
    `  Allow mismatched reuse: ${allowMismatchedReuse ? 'yes' : 'no'}`
  );
  console.log(
    `  Python: ${python.command}${python.prefixArgs.length ? ` ${python.prefixArgs.join(' ')}` : ''}`
  );
  console.log(`  Training backend: ${trainingBackend || 'auto'}`);
  console.log(
    `  Trajectory source: ${trajectorySource || process.env.TRAJECTORY_SOURCE || 'db'}`
  );
  if (hfDataset || process.env.HF_TRAJECTORY_DATASET) {
    console.log(
      `  HF dataset: ${hfDataset || process.env.HF_TRAJECTORY_DATASET}`
    );
  }
  if (hfSplit || process.env.HF_TRAJECTORY_SPLIT) {
    console.log(`  HF split: ${hfSplit || process.env.HF_TRAJECTORY_SPLIT}`);
  }
  if (lookbackHours) {
    console.log(`  Lookback hours: ${lookbackHours}`);
  }
  if (minActions) {
    console.log(`  Min actions: ${minActions}`);
  }
  if (maxTrajectories) {
    console.log(`  Max trajectories: ${maxTrajectories}`);
  }
  if (localBackend) {
    console.log(`  Local backend: ${localBackend}`);
  }
  if (localModel) {
    console.log(`  Local model: ${localModel}`);
  }
  if (localSteps) {
    console.log(`  Local steps: ${localSteps}`);
  }
  if (tinkerSteps) {
    console.log(`  Tinker steps: ${tinkerSteps}`);
  }
  if (tinkerGroupSize) {
    console.log(`  Tinker group size: ${tinkerGroupSize}`);
  }
  if (tinkerLr) {
    console.log(`  Tinker learning rate: ${tinkerLr}`);
  }
  if (tinkerLoraRank) {
    console.log(`  Tinker LoRA rank: ${tinkerLoraRank}`);
  }
  if (tinkerWeightSyncInterval) {
    console.log(`  Tinker weight sync interval: ${tinkerWeightSyncInterval}`);
  }
  if (skipRl) {
    console.log('  RL stage: skipped');
  } else {
    console.log(`  RL steps: ${rlSteps || '100'}`);
    if (rlBatchSize) {
      console.log(`  RL batch size: ${rlBatchSize}`);
    }
    if (rlLr) {
      console.log(`  RL learning rate: ${rlLr}`);
    }
    if (rewardProfile) {
      console.log(`  Reward profile: ${rewardProfile}`);
    }
    if (requireRl) {
      console.log('  RL required: yes');
    }
  }
  if (skipScamBench || noBenchmark) {
    console.log('  ScamBench: skipped');
  }
  if (archetype) {
    console.log(`  Archetype: ${archetype}`);
  } else if (archetypesArg) {
    console.log(`  Archetypes: ${archetypesArg}`);
  } else {
    console.log(`  Archetype: default (general)`);
  }
  console.log();

  if (dryRun) {
    console.log('[DRY RUN] Would execute:');
    console.log(
      `  ${[python.command, ...python.prefixArgs, ...pythonArgs].join(' ')}`
    );
    return;
  }

  const effectiveTrainingBackend = (trainingBackend || 'auto').toLowerCase();
  const effectiveTrajectorySource = (
    trajectorySource ||
    process.env.TRAJECTORY_SOURCE ||
    'db'
  ).toLowerCase();
  const effectiveHfDataset =
    hfDataset || process.env.HF_TRAJECTORY_DATASET || '';

  if (
    !benchmarkOnly &&
    effectiveTrainingBackend === 'tinker' &&
    !process.env.TINKER_API_KEY
  ) {
    logger.fail('TINKER_API_KEY is required when --training-backend=tinker');
    console.log(
      '\nSet TINKER_API_KEY in your shell or .env before running this command.'
    );
    throw createCliUsageError(
      'TINKER_API_KEY is required for feed train pipeline with --training-backend=tinker'
    );
  }

  if (
    !benchmarkOnly &&
    effectiveTrajectorySource === 'huggingface' &&
    !effectiveHfDataset
  ) {
    logger.fail(
      'HF_TRAJECTORY_DATASET is required when --trajectory-source=huggingface'
    );
    console.log(
      '\nSet --hf-dataset or HF_TRAJECTORY_DATASET before running this command.'
    );
    throw createCliUsageError(
      'HF_TRAJECTORY_DATASET is required for feed train pipeline with trajectory-source=huggingface'
    );
  }

  if (
    !benchmarkOnly &&
    effectiveTrajectorySource === 'local_export' &&
    !sourceDir
  ) {
    logger.fail('source-dir is required when --trajectory-source=local_export');
    console.log(
      '\nSet --source-dir to a local export directory before running this command.'
    );
    throw createCliUsageError(
      'source-dir is required for feed train pipeline with trajectory-source=local_export'
    );
  }

  if (
    !benchmarkOnly &&
    effectiveTrajectorySource !== 'huggingface' &&
    effectiveTrajectorySource !== 'local_export' &&
    !process.env.DATABASE_URL
  ) {
    logger.fail('DATABASE_URL is required for the training pipeline');
    console.log(
      '\nSet DATABASE_URL in your shell or .env before running this command, or use --trajectory-source=huggingface or --trajectory-source=local_export.'
    );
    throw createCliUsageError(
      'DATABASE_URL is required for feed train pipeline unless trajectory-source=huggingface or trajectory-source=local_export'
    );
  }

  logger.step('Starting Python training pipeline...');
  console.log();

  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.prefixArgs, ...pythonArgs], {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    child.on('error', (error) => {
      if (error.message.includes('ENOENT')) {
        logger.fail(
          'Python not found. Set PYTHON_BIN or install Python 3.10+ for the training pipeline'
        );
        console.log('\nInstall with:');
        console.log('  brew install python@3.11  # macOS');
        console.log('  apt install python3       # Ubuntu');
        console.log('  export PYTHON_BIN=/path/to/python');
      } else {
        logger.fail(`Failed to start: ${error.message}`);
      }
      reject(error);
    });

    child.on('close', (code) => {
      console.log();
      if (code === 0) {
        logger.success('Training pipeline completed!');
        console.log();
        console.log('Next steps:');
        if (benchmarkOnly) {
          console.log(`  1. Review benchmark results in ${output}/`);
          console.log(
            `  2. Check ${output}/pipeline_report.json for stage details`
          );
        } else {
          console.log(`  1. Check results in ${output}/`);
          console.log(`  2. Review ${output}/pipeline_report.json`);
          console.log('  3. Upload model: feed model upload --model <path>');
          console.log(
            '  4. Run benchmark: feed train pipeline --benchmark-only'
          );
        }
        resolve();
      } else {
        logger.fail(`Pipeline exited with code ${code}`);
        reject(new Error(`Pipeline failed with code ${code}`));
      }
    });
  });
}

/**
 * Main entry point for training domain commands.
 *
 * @param args - Raw command-line arguments for the training domain
 */

async function runOnlineRL(args: ReturnType<typeof parseArgs>): Promise<void> {
  logger.header('Feed Online RL Training');

  const workspaceRoot = join(import.meta.dir, '..', '..', '..', '..');
  const scriptPath = join(
    workspaceRoot,
    'packages/training/python/scripts/run_online_rl.py'
  );

  if (!existsSync(scriptPath)) {
    logger.fail(`Online RL script not found: ${scriptPath}`);
    throw createCliUsageError('Online RL script not found');
  }

  const python = resolvePythonCommand(workspaceRoot);
  const pythonArgs = [...python.prefixArgs, scriptPath];

  // Map CLI args to Python script args
  const mode = getOption(args, 'mode', 'm') || 'single';
  pythonArgs.push('--mode', mode);

  const model = getOption(args, 'model', '');
  if (model) pythonArgs.push('--model', model);

  const device = getOption(args, 'device', '');
  if (device) pythonArgs.push('--device', device);

  const optimizer = getOption(args, 'optimizer', '');
  if (optimizer) pythonArgs.push('--optimizer', optimizer);

  const lr = getOption(args, 'lr', '');
  if (lr) pythonArgs.push('--lr', lr);

  if (getFlag(args, 'kondo', '')) pythonArgs.push('--kondo');

  const kondoGateRate = getOption(args, 'kondo-gate-rate', '');
  if (kondoGateRate) pythonArgs.push('--kondo-gate-rate', kondoGateRate);

  if (getFlag(args, 'turboquant', '')) pythonArgs.push('--turboquant');

  const bridgeUrl = getOption(args, 'bridge-url', '');
  if (bridgeUrl) pythonArgs.push('--bridge-url', bridgeUrl);

  const maxTicks = getOption(args, 'max-ticks', '');
  if (maxTicks) pythonArgs.push('--max-ticks', maxTicks);

  // Multi-agent options
  const numAgents = getOption(args, 'num-agents', '');
  if (numAgents) pythonArgs.push('--num-agents', numAgents);

  const archetypes = getOption(args, 'archetypes', '');
  if (archetypes) pythonArgs.push('--archetypes', archetypes);

  if (getFlag(args, 'pbt', '')) pythonArgs.push('--pbt');

  const pbtInterval = getOption(args, 'pbt-interval', '');
  if (pbtInterval) pythonArgs.push('--pbt-interval', pbtInterval);

  const checkpointDir = getOption(args, 'checkpoint-dir', 'o');
  if (checkpointDir) pythonArgs.push('--checkpoint-dir', checkpointDir);

  // APOLLO options
  const apolloRank = getOption(args, 'apollo-rank', '');
  if (apolloRank) pythonArgs.push('--apollo-rank', apolloRank);

  logger.info(`Mode: ${mode}`);
  logger.info(`Running: ${python.command} ${pythonArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(python.command, pythonArgs, {
      stdio: 'inherit',
      cwd: workspaceRoot,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        logger.success('Online RL training complete');
        resolve();
      } else {
        reject(new Error(`Online RL training exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start online RL: ${err.message}`));
    });
  });
}

export async function runTrainCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  // Commands that don't need the database
  const noDatabaseCommands = [
    'list',
    'pipeline',
    'run',
    'online',
    'continuous-rl',
  ];
  const needsDatabase = !noDatabaseCommands.includes(parsed.command || '');

  switch (parsed.command) {
    case 'list':
      await listArchetypes(parsed);
      break;

    case 'pipeline':
    case 'run':
      await runPipeline(parsed);
      break;

    case 'archetype':
      await trainArchetype(parsed);
      break;

    case 'score':
      await scoreTrajectories();
      break;

    case 'online':
    case 'continuous-rl':
      await runOnlineRL(parsed);
      break;

    default:
      if (parsed.command) {
        logger.fail(`Unknown command: ${parsed.command}`);
      }
      printHelp();
      process.exit(parsed.command ? 1 : 0);
  }

  if (needsDatabase) {
    const { closeDatabase } = await getDbImports();
    await closeDatabase();
  }
  // Always exit cleanly
  process.exit(0);
}
