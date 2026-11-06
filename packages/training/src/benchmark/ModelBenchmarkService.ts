/**
 * Model Benchmark Service (For HuggingFace Integration)
 *
 * Reads recorded benchmark results for trained-model evaluation.
 * Compares new models against baselines and previous versions.
 *
 * **Purpose:** Evaluate models for HuggingFace upload
 * **Used by:** HuggingFace integration and model result consumers
 * **Storage:** benchmark_results table (dedicated table)
 * **Focus:** Public model release, baseline comparison
 *
 * **Note:** For training pipeline benchmarking, see BenchmarkService
 *
 * @see BenchmarkService - For training pipeline evaluation
 */

import { benchmarkResults, db, trainedModels } from '@feed/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import {
  type JsonValue,
  parseSimulationMetrics,
} from './parseSimulationMetrics';
import type { SimulationMetrics } from './SimulationEngine';

export interface ModelBenchmarkResult {
  modelId: string;
  modelVersion: string;
  benchmarkId: string;
  benchmarkPath: string;
  runAt: Date;
  metrics: SimulationMetrics;
  comparisonToBaseline?: {
    pnlDelta: number;
    accuracyDelta: number;
    optimalityDelta: number;
    improved: boolean;
  };
}

export interface ModelComparisonResult {
  newModel: {
    modelId: string;
    version: string;
    avgMetrics: AverageMetrics;
  };
  baseline: {
    modelId: string;
    avgMetrics: AverageMetrics;
  };
  improvement: {
    pnlDelta: number;
    accuracyDelta: number;
    optimalityDelta: number;
    isImprovement: boolean;
  };
  recommendation: 'deploy' | 'keep_training' | 'baseline_better';
}

export interface AverageMetrics {
  totalPnl: number;
  accuracy: number;
  winRate: number;
  optimality: number;
  benchmarkCount: number;
}

export class ModelBenchmarkService {
  /**
   * Compare new model against baseline
   */
  static async compareToBaseline(
    modelId: string
  ): Promise<ModelComparisonResult> {
    // Get new model benchmarks
    const newModelBenchmarks = await this.getModelBenchmarks(modelId);

    if (newModelBenchmarks.length === 0) {
      throw new Error(`No benchmarks found for model: ${modelId}`);
    }

    // Calculate new model average metrics
    const newModelMetrics = this.calculateAverageMetrics(
      newModelBenchmarks.map((b) => b.metrics)
    );

    // Get baseline benchmarks (use best baseline model)
    const baselineMetrics = await this.getBaselineAverageMetrics();

    // Calculate improvement
    const pnlDelta = newModelMetrics.totalPnl - baselineMetrics.totalPnl;
    const accuracyDelta = newModelMetrics.accuracy - baselineMetrics.accuracy;
    const optimalityDelta =
      newModelMetrics.optimality - baselineMetrics.optimality;

    // Determine if this is an improvement (weighted score)
    const improvementScore =
      (pnlDelta > 0 ? 1 : 0) * 0.4 +
      (accuracyDelta > 0 ? 1 : 0) * 0.3 +
      (optimalityDelta > 0 ? 1 : 0) * 0.3;

    const isImprovement = improvementScore > 0.5;

    let recommendation: 'deploy' | 'keep_training' | 'baseline_better';
    if (isImprovement && pnlDelta > 0) {
      recommendation = 'deploy';
    } else if (pnlDelta < -100) {
      recommendation = 'baseline_better';
    } else {
      recommendation = 'keep_training';
    }

    return {
      newModel: {
        modelId,
        version: newModelBenchmarks[0]!.modelVersion,
        avgMetrics: newModelMetrics,
      },
      baseline: {
        modelId: 'baseline',
        avgMetrics: baselineMetrics,
      },
      improvement: {
        pnlDelta,
        accuracyDelta,
        optimalityDelta,
        isImprovement,
      },
      recommendation,
    };
  }

  /**
   * Get all unbenchmarked models
   */
  static async getUnbenchmarkedModels(): Promise<string[]> {
    const models = await db
      .select({ modelId: trainedModels.modelId })
      .from(trainedModels)
      .where(
        and(
          eq(trainedModels.status, 'ready'),
          isNull(trainedModels.benchmarkScore)
        )
      );

    return models.map((m) => m.modelId);
  }

  /**
   * Get model benchmark results
   */
  private static async getModelBenchmarks(
    modelId: string
  ): Promise<ModelBenchmarkResult[]> {
    // For now, read from files
    // In production, you'd store these in a database table

    const benchmarksDir = path.join(
      process.cwd(),
      'benchmarks',
      'model-results'
    );
    const results: ModelBenchmarkResult[] = [];

    try {
      const modelResult = await db
        .select({ version: trainedModels.version })
        .from(trainedModels)
        .where(eq(trainedModels.modelId, modelId))
        .limit(1);
      const model = modelResult[0];

      if (!model) return results;

      const modelDir = path.join(benchmarksDir, model.version);
      const files = await fs.readdir(modelDir).catch(() => []);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(modelDir, file);
          const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));

          if (data.modelId === modelId) {
            results.push(data);
          }
        }
      }
    } catch (error) {
      logger.warn('Could not load benchmark results', { error });
    }

    return results;
  }

  /**
   * Get benchmark results from database
   */
  static async getBenchmarkResultsFromDatabase(
    modelId: string
  ): Promise<ModelBenchmarkResult[]> {
    const results = await db
      .select()
      .from(benchmarkResults)
      .where(eq(benchmarkResults.modelId, modelId))
      .orderBy(desc(benchmarkResults.runAt));

    return results.map((r) => ({
      modelId: r.modelId,
      modelVersion: '', // Not stored in results table
      benchmarkId: r.benchmarkId,
      benchmarkPath: r.benchmarkPath,
      runAt: r.runAt,
      metrics: parseSimulationMetrics(r.detailedMetrics as JsonValue),
      comparisonToBaseline:
        r.baselinePnlDelta !== null
          ? {
              pnlDelta: r.baselinePnlDelta,
              accuracyDelta: r.baselineAccuracyDelta ?? 0,
              optimalityDelta: 0, // Not stored separately
              improved: r.improved || false,
            }
          : undefined,
    }));
  }

  /**
   * Calculate average metrics across multiple benchmark results
   */
  private static calculateAverageMetrics(
    metricsArray: SimulationMetrics[]
  ): AverageMetrics {
    if (metricsArray.length === 0) {
      return {
        totalPnl: 0,
        accuracy: 0,
        winRate: 0,
        optimality: 0,
        benchmarkCount: 0,
      };
    }

    const totals = metricsArray.reduce(
      (acc, metrics) => ({
        pnl: acc.pnl + metrics.totalPnl,
        accuracy: acc.accuracy + metrics.predictionMetrics.accuracy,
        winRate: acc.winRate + metrics.perpMetrics.winRate,
        optimality: acc.optimality + metrics.optimalityScore,
      }),
      { pnl: 0, accuracy: 0, winRate: 0, optimality: 0 }
    );

    const count = metricsArray.length;

    return {
      totalPnl: totals.pnl / count,
      accuracy: totals.accuracy / count,
      winRate: totals.winRate / count,
      optimality: totals.optimality / count,
      benchmarkCount: count,
    };
  }

  /**
   * Get baseline average metrics
   */
  private static async getBaselineAverageMetrics(): Promise<AverageMetrics> {
    const baselinesDir = path.join(process.cwd(), 'benchmarks', 'baselines');
    const metricsArray: SimulationMetrics[] = [];

    try {
      const files = await fs.readdir(baselinesDir).catch(() => []);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(baselinesDir, file);
          const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));

          if (data.metrics) {
            metricsArray.push(data.metrics);
          }
        }
      }
    } catch (error) {
      logger.warn('Could not load baseline metrics', { error });
    }

    return this.calculateAverageMetrics(metricsArray);
  }

  /**
   * Get standard benchmark paths for model evaluation
   */
  static async getStandardBenchmarkPaths(): Promise<string[]> {
    const benchmarksDir = path.join(process.cwd(), 'benchmarks');
    const standardBenchmarks: string[] = [];

    try {
      // First, look in benchmarks/standard/ directory
      const standardDir = path.join(benchmarksDir, 'standard');
      if (
        await fs
          .access(standardDir)
          .then(() => true)
          .catch(() => false)
      ) {
        const standardFiles = await fs.readdir(standardDir);
        for (const file of standardFiles) {
          if (file.startsWith('standard-') && file.endsWith('.json')) {
            standardBenchmarks.push(path.join(standardDir, file));
          }
        }
      }

      // If standard benchmarks found, use those
      if (standardBenchmarks.length > 0) {
        logger.info(
          `Using ${standardBenchmarks.length} standard benchmarks from benchmarks/standard/`
        );
        return standardBenchmarks;
      }

      // Fallback: Look for week-long benchmarks in main directory
      const files = await fs.readdir(benchmarksDir);
      for (const file of files) {
        if (file.startsWith('benchmark-week-') && file.endsWith('.json')) {
          standardBenchmarks.push(path.join(benchmarksDir, file));
        }
      }

      // If still nothing, use any benchmark files
      if (standardBenchmarks.length === 0) {
        for (const file of files) {
          if (
            file.startsWith('benchmark-') &&
            file.endsWith('.json') &&
            !file.includes('comparison')
          ) {
            const filePath = path.join(benchmarksDir, file);
            standardBenchmarks.push(filePath);
          }
        }
      }
    } catch (error) {
      logger.error('Could not load standard benchmarks', { error });
    }

    if (standardBenchmarks.length === 0) {
      logger.warn(
        'No standard benchmarks found. Generate with: feed train generate'
      );
    }

    return standardBenchmarks;
  }
}
