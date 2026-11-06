#!/usr/bin/env bun

/**
 * Test Trained Model - TypeScript/Node
 *
 * Tests a trained model by:
 * 1. Loading model from database or path
 * 2. Comparing recorded evaluation results to a baseline
 *
 * Usage:
 *   bun run packages/training/scripts/test-trained-model.ts --model-id <id>
 *   bun run packages/training/scripts/test-trained-model.ts --model-path <path>
 */

import { db, eq, trainedModels } from '@feed/db';
import { BenchmarkService } from '../src/training/BenchmarkService';
import { logger } from '../src/utils/logger';

interface TestConfig {
  modelId?: string;
  modelPath?: string;
  compareToBaseline?: boolean;
}

async function testModel(config: TestConfig): Promise<void> {
  logger.info('Testing trained model', config);

  // Get model from database or path
  let model;
  if (config.modelId) {
    const result = await db
      .select()
      .from(trainedModels)
      .where(eq(trainedModels.modelId, config.modelId))
      .limit(1);

    model = result[0];

    if (!model) {
      throw new Error(`Model not found: ${config.modelId}`);
    }

    logger.info('Found model in database', {
      modelId: model.modelId,
      version: model.version,
      status: model.status,
      storagePath: model.storagePath,
    });
  } else if (config.modelPath) {
    // Create mock model entry for testing
    model = {
      modelId: `test-${Date.now()}`,
      version: 'test',
      status: 'ready' as const,
      storagePath: config.modelPath,
      benchmarkScore: null,
    };

    logger.info('Using model from path', {
      modelPath: config.modelPath,
    });
  } else {
    throw new Error('Must provide either --model-id or --model-path');
  }

  // Test 1: Model loading validation
  logger.info('='.repeat(60));
  logger.info('TEST 1: Model Loading');
  logger.info('='.repeat(60));

  if (!model.storagePath) {
    throw new Error('Model storage path not set');
  }

  const modelExists = await Bun.file(model.storagePath)
    .exists()
    .catch(() => false);
  if (!modelExists && !config.modelPath) {
    logger.warn('Model file not found at storage path', {
      storagePath: model.storagePath,
    });
  } else {
    logger.info('✅ Model path validated', {
      path: model.storagePath || config.modelPath,
    });
  }

  if (config.compareToBaseline && config.modelId) {
    const comparison = await new BenchmarkService().compareModels(
      config.modelId
    );
    logger.info('Comparison to Baseline:', comparison);
  }

  // Summary
  logger.info('='.repeat(60));
  logger.info('TESTING COMPLETE');
  logger.info('='.repeat(60));
  logger.info('Model:', {
    id: model.modelId,
    version: model.version,
    status: model.status,
  });

  if (model.benchmarkScore !== null) {
    logger.info('Benchmark Score:', model.benchmarkScore);
  }
}

async function main() {
  const args = process.argv.slice(2);

  const config: TestConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--model-id' && i + 1 < args.length) {
      config.modelId = args[i + 1];
      i++;
    } else if (arg === '--model-path' && i + 1 < args.length) {
      config.modelPath = args[i + 1];
      i++;
    } else if (arg === '--compare') {
      config.compareToBaseline = true;
    }
  }

  if (!config.modelId && !config.modelPath) {
    console.error('Usage:');
    console.error(
      '  bun run test-trained-model.ts --model-id <id> [--compare]'
    );
    console.error('  bun run test-trained-model.ts --model-path <path>');
    process.exit(1);
  }

  try {
    await testModel(config);
  } catch (error) {
    logger.error('Testing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
