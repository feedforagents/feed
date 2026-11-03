/**
 * Close Perp Action
 * Close an open perpetual position via direct DB operations
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import { and, db, eq, isNull, perpPositions } from '@feed/db';
import {
  createPerpPriceImpactPort,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { AgentPnLService } from '../../../../services/AgentPnLService';
import { logger } from '../../../../shared/logger';

const agentPnLService = new AgentPnLService();

export const closePerpAction: Action = {
  name: 'CLOSE_PERP',
  description:
    'Close YOUR perpetual position (full or partial). IMPORTANT: Call CHECK_PNL first to see your open positions and get the position ID. Optionally specify amount for partial close.',
  parameters: {
    positionId: {
      type: 'string',
      description: 'The ID of the perpetual position to close',
      required: true,
    },
    amount: {
      type: 'number',
      description:
        'Dollar amount of position to close. If not specified, closes the entire position.',
      required: false,
    },
  } as unknown as Action['parameters'],
  examples: [
    [
      {
        name: 'user',
        content: { text: 'Close my NVDA position' },
      },
      {
        name: 'assistant',
        content: { text: 'Closing your NVDA position now...' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Exit my Tesla short' },
      },
      {
        name: 'assistant',
        content: { text: "I'll close that position for you." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const agentUserId = runtime.agentId;

    // Get parameters from state
    const actionParams = state?.data?.actionParams as
      | { positionId?: string; amount?: number }
      | undefined;

    const positionId = actionParams?.positionId;
    const closeAmount = actionParams?.amount;

    if (!positionId) {
      return {
        success: false,
        text: 'Missing positionId. Call CHECK_PNL first to get position IDs.',
        error: 'Missing positionId',
      };
    }

    // Only an omitted amount means "close everything". An explicit amount
    // must be a positive finite number; never let 0/NaN/negative silently
    // become a full close.
    if (
      closeAmount !== undefined &&
      (typeof closeAmount !== 'number' ||
        !Number.isFinite(closeAmount) ||
        closeAmount <= 0)
    ) {
      return {
        success: false,
        text: 'Close amount must be a positive number, or omitted to close the entire position.',
        error: 'Invalid amount',
      };
    }

    try {
      // Get position
      const [position] = await db
        .select()
        .from(perpPositions)
        .where(
          and(
            eq(perpPositions.id, positionId),
            eq(perpPositions.userId, agentUserId),
            isNull(perpPositions.closedAt)
          )
        )
        .limit(1);

      if (!position) {
        return {
          success: false,
          text: `Position not found. Call CHECK_PNL first to get valid position IDs.`,
          error: 'Position not found',
        };
      }

      const service = new PerpMarketService({
        db: new PerpDbAdapter(),
        wallet: createUserWalletAdapter(),
        fees: {
          tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
          platformShare: FEE_CONFIG.PLATFORM_SHARE,
          referrerShare: FEE_CONFIG.REFERRER_SHARE,
          minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
        },
        priceImpact: createPerpPriceImpactPort(),
      });

      const positionSize = Number(position.size);
      // Tolerate float noise when the agent asks for exactly the full size.
      const FULL_CLOSE_TOLERANCE = 0.01;
      if (
        closeAmount !== undefined &&
        closeAmount > positionSize + FULL_CLOSE_TOLERANCE
      ) {
        return {
          success: false,
          text: `Close amount $${closeAmount} exceeds position size $${positionSize.toFixed(2)}. Omit amount to close the entire position.`,
          error: 'Close amount exceeds position size',
        };
      }
      const isPartialClose =
        closeAmount !== undefined &&
        closeAmount < positionSize - FULL_CLOSE_TOLERANCE;

      const result = await service.closePosition({
        positionId,
        userId: agentUserId,
        percentage: isPartialClose ? closeAmount / positionSize : undefined,
      });

      const pnl = result.realizedPnL ?? 0;
      const closedAmount = result.size;
      const remainingSize = result.remainingSize ?? 0;
      const exitPrice = result.exitPrice ?? Number(position.entryPrice);

      const pnlStr =
        pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

      // Record trade for UI/performance tracking. The close is committed, so
      // an analytics failure must not report it as failed.
      await agentPnLService
        .recordTrade({
          agentId: agentUserId,
          userId: agentUserId,
          marketType: 'perp',
          ticker: position.ticker,
          action: 'close',
          side: position.side as 'long' | 'short',
          amount: closedAmount,
          price: exitPrice,
          pnl,
          reasoning:
            (state?.data?.thought as string) || 'Chat-initiated perp close',
        })
        .catch((error: Error) => {
          logger.error('[CLOSE_PERP] Failed to record trade analytics', {
            agentUserId,
            positionId,
            error: error.message,
          });
        });

      logger.info('[CLOSE_PERP] Position closed', {
        agentUserId,
        positionId,
        ticker: position.ticker,
        side: position.side,
        exitPrice,
        closedAmount,
        remainingSize,
        pnl,
        isPartialClose,
      });

      const resultText = isPartialClose
        ? `Partial close on ${position.ticker}: $${closedAmount.toFixed(2)} closed. P&L: ${pnlStr}. Remaining: $${remainingSize.toFixed(2)}`
        : `Closed ${position.ticker} position. P&L: ${pnlStr}`;

      return {
        success: true,
        text: resultText,
        data: {
          positionId,
          ticker: position.ticker,
          side: position.side,
          exitPrice,
          closedAmount,
          remainingSize,
          pnl,
          isPartialClose,
        },
        values: {
          positionId,
          ticker: position.ticker,
          side: position.side,
          exitPrice,
          closedAmount,
          pnl,
          remainingSize,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[CLOSE_PERP] Error:', errorMsg);
      return {
        success: false,
        text: `Failed to close position: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
