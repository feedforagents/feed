/**
 * Training Benchmark Service
 *
 * Stores and compares recorded model evaluation results.
 *
 * **Purpose:** Evaluate models as part of continuous training
 * **Used by:** Model evaluation consumers
 * **Storage:** trainedModel.evalMetrics (JSON field)
 * **Focus:** Training pipeline integration, deployment decisions
 *
 * **Note:** For HuggingFace upload benchmarking, see ModelBenchmarkService
 *
 * @see ModelBenchmarkService - For HuggingFace upload evaluation
 */

import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNotNull,
  not,
  trainedModels,
} from '@feed/db';
import { logger } from '../utils/logger';

export interface BenchmarkResults {
  modelId: string;
  benchmarkScore: number; // Overall composite score
  pnl: number;
  accuracy: number;
  optimality: number;
  perpTrades: number;
  correctPredictions: number;
  totalPositions: number;
  duration: number;
  timestamp: Date;
}

export interface ComparisonResults {
  newModel: string;
  previousModel: string | null;
  newScore: number;
  previousScore: number | null;
  improvement: number | null; // Percentage improvement
  shouldDeploy: boolean;
  reason: string;
}

export class BenchmarkService {
  private readonly DEPLOYMENT_THRESHOLD = 0.95; // Deploy if new model >= 95% of best
  /**
   * Compare new model performance against previous best
   *
   * Evaluates whether a new model should be deployed based on its benchmark
   * score compared to the previous best model. Uses a configurable threshold.
   *
   * @param newModelId - Unique identifier for the new model to compare
   * @param threshold - Deployment threshold (default: 0.95, meaning 95% of best)
   * @returns ComparisonResults with deployment recommendation
   * @throws Error if model not found or not benchmarked
   *
   * @example
   * ```typescript
   * const comparison = await benchmarkService.compareModels('model-123');
   * if (comparison.shouldDeploy) {
   *   console.log(`Deploying: ${comparison.reason}`);
   * }
   * ```
   */
  async compareModels(
    newModelId: string,
    threshold: number = this.DEPLOYMENT_THRESHOLD
  ): Promise<ComparisonResults> {
    logger.info(
      `Comparing model: ${newModelId}`,
      undefined,
      'BenchmarkService'
    );

    // Get new model's benchmark results
    const newModelResult = await db
      .select()
      .from(trainedModels)
      .where(eq(trainedModels.modelId, newModelId))
      .limit(1);

    const newModel = newModelResult[0];

    if (!newModel) {
      throw new Error(`Model not found: ${newModelId}`);
    }

    if (newModel.benchmarkScore === null) {
      throw new Error(`Model has not been benchmarked: ${newModelId}`);
    }

    const newScore = newModel.benchmarkScore;

    // Get previous best model (excluding the new one)
    const previousBestResult = await db
      .select()
      .from(trainedModels)
      .where(
        and(
          not(eq(trainedModels.modelId, newModelId)),
          inArray(trainedModels.status, ['ready', 'deployed']),
          isNotNull(trainedModels.benchmarkScore)
        )
      )
      .orderBy(desc(trainedModels.benchmarkScore))
      .limit(1);

    const previousBest = previousBestResult[0];

    // If no previous model, always deploy
    if (!previousBest) {
      logger.info(
        'No previous model to compare - will deploy',
        { newScore },
        'BenchmarkService'
      );
      return {
        newModel: newModelId,
        previousModel: null,
        newScore,
        previousScore: null,
        improvement: null,
        shouldDeploy: true,
        reason: 'First model - no comparison available',
      };
    }

    const previousScore = previousBest.benchmarkScore!;
    const improvement = ((newScore - previousScore) / previousScore) * 100;
    const thresholdScore = previousScore * threshold;
    const shouldDeploy = newScore >= thresholdScore;

    let reason = '';
    if (shouldDeploy) {
      if (newScore > previousScore) {
        reason = `Improved by ${improvement.toFixed(1)}% (${newScore.toFixed(3)} > ${previousScore.toFixed(3)})`;
      } else {
        reason = `Within acceptable range (${newScore.toFixed(3)} >= ${thresholdScore.toFixed(3)}, threshold: ${threshold * 100}%)`;
      }
    } else {
      reason = `Performance too low (${newScore.toFixed(3)} < ${thresholdScore.toFixed(3)}, need ${threshold * 100}% of best)`;
    }

    logger.info(
      'Model comparison complete',
      {
        newModel: newModelId,
        newScore: newScore.toFixed(3),
        previousModel: previousBest.modelId,
        previousScore: previousScore.toFixed(3),
        improvement: improvement.toFixed(1) + '%',
        shouldDeploy,
        reason,
      },
      'BenchmarkService'
    );

    return {
      newModel: newModelId,
      previousModel: previousBest.modelId,
      newScore,
      previousScore,
      improvement,
      shouldDeploy,
      reason,
    };
  }

  /**
   * Store benchmark results in database
   *
   * Saves benchmark metrics to the trainedModel record for tracking
   * and comparison purposes.
   *
   * @param modelId - Unique identifier for the trained model
   * @param results - Benchmark results to store
   * @throws Error if model not found or database update fails
   */
  async storeBenchmarkResults(
    modelId: string,
    results: BenchmarkResults
  ): Promise<void> {
    await db
      .update(trainedModels)
      .set({
        benchmarkScore: results.benchmarkScore,
        accuracy: results.accuracy,
        evalMetrics: {
          pnl: results.pnl,
          accuracy: results.accuracy,
          optimality: results.optimality,
          perpTrades: results.perpTrades,
          correctPredictions: results.correctPredictions,
          totalPositions: results.totalPositions,
          duration: results.duration,
          benchmarkedAt: results.timestamp.toISOString(),
        },
      })
      .where(eq(trainedModels.modelId, modelId));

    logger.info(
      'Stored benchmark results',
      { modelId, score: results.benchmarkScore },
      'BenchmarkService'
    );
  }

  /**
   * Determine if model should be deployed based on performance
   *
   * Convenience wrapper around compareModels() that returns only
   * the deployment decision boolean.
   *
   * @param modelId - Unique identifier for the model to evaluate
   * @param threshold - Deployment threshold (default: 0.95)
   * @returns True if model should be deployed, false otherwise
   * @throws Error if model not found or not benchmarked
   */
  async shouldDeploy(
    modelId: string,
    threshold: number = this.DEPLOYMENT_THRESHOLD
  ): Promise<boolean> {
    const comparison = await this.compareModels(modelId, threshold);
    return comparison.shouldDeploy;
  }

  /**
   * Get benchmark summary for monitoring
   */
  async getBenchmarkSummary() {
    const models = await db
      .select()
      .from(trainedModels)
      .where(isNotNull(trainedModels.benchmarkScore))
      .orderBy(desc(trainedModels.benchmarkScore))
      .limit(10);

    const summary = models.map((m: (typeof models)[number]) => ({
      modelId: m.modelId,
      version: m.version,
      score: m.benchmarkScore,
      accuracy: m.accuracy,
      status: m.status,
      createdAt: m.createdAt,
    }));

    return {
      totalBenchmarked: models.length,
      topModels: summary.slice(0, 5),
      recentModels: summary
        .sort(
          (a: (typeof summary)[number], b: (typeof summary)[number]) =>
            b.createdAt.getTime() - a.createdAt.getTime()
        )
        .slice(0, 5),
    };
  }
}

export const benchmarkService = new BenchmarkService();
