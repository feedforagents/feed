/** Structured A2A trading actions. Identifiers and financial choices are never inferred from prose. */
import type { Action } from '@elizaos/core';
import { z } from 'zod';
import type { FeedRuntime } from '../types';
import { clientFor, complete } from './contracts';

const id = z.string().trim().min(1);
const positive = z.number().finite().positive();
const finite = z.number().finite();

export const buySharesAction: Action = {
  name: 'BUY_PREDICTION_SHARES',
  description:
    'Buy prediction shares using a dollar amount; requires exact market ID and explicit YES/NO outcome.',
  parameters: {
    marketId: {
      type: 'string',
      description: 'Exact prediction market ID',
      required: true,
    },
    outcome: { type: 'string', description: 'YES or NO', required: true },
    amount: {
      type: 'number',
      description: 'Dollar amount to spend',
      required: true,
    },
  } as unknown as Action['parameters'],
  examples: [],
  validate: async (runtime) =>
    Boolean((runtime as FeedRuntime).a2aClient?.isConnected()),
  handler: async (runtime, _message, state, _options, callback) => {
    const client = clientFor(runtime);
    const params = z
      .object({
        marketId: id,
        outcome: z.enum(['YES', 'NO']),
        amount: positive,
      })
      .parse(state?.data?.actionParams);
    const raw = await client.buyShares(
      params.marketId,
      params.outcome,
      params.amount
    );
    // Preserve explicit backend errors before checking the successful response shape.
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.success === false
    )
      return complete('BUY_PREDICTION_SHARES', raw, callback);
    z.object({
      success: z.literal(true),
      position: z.object({
        id,
        marketId: id,
        side: z.enum(['YES', 'NO']),
        shares: positive,
        avgPrice: positive,
        totalCost: positive,
      }),
      newBalance: finite,
    }).parse(raw);
    return complete('BUY_PREDICTION_SHARES', raw, callback);
  },
};

export const sellSharesAction: Action = {
  name: 'SELL_PREDICTION_SHARES',
  description:
    'Sell an explicit number of shares from an owned prediction position.',
  parameters: {
    positionId: {
      type: 'string',
      description: 'Exact owned position ID',
      required: true,
    },
    shares: {
      type: 'number',
      description: 'Number of shares to sell',
      required: true,
    },
  } as unknown as Action['parameters'],
  examples: [],
  validate: async (runtime) =>
    Boolean((runtime as FeedRuntime).a2aClient?.isConnected()),
  handler: async (runtime, _message, state, _options, callback) => {
    const client = clientFor(runtime);
    const params = z
      .object({ positionId: id, shares: positive })
      .parse(state?.data?.actionParams);
    const raw = await client.sellShares(params.positionId, params.shares);
    // Preserve explicit backend errors before checking the successful response shape.
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.success === false
    )
      return complete('SELL_PREDICTION_SHARES', raw, callback);
    z.object({
      success: z.literal(true),
      sharesSold: positive,
      netProceeds: finite,
      remainingShares: finite.nonnegative(),
      pnl: finite,
      newBalance: finite,
      positionId: id,
    }).parse(raw);
    return complete('SELL_PREDICTION_SHARES', raw, callback);
  },
};

export const openPerpPositionAction: Action = {
  name: 'OPEN_PERP_POSITION',
  description:
    'Open a perpetual position with exact ticker, explicit side, notional position amount and leverage.',
  parameters: {
    ticker: {
      type: 'string',
      description: 'Exact tradable ticker',
      required: true,
    },
    side: { type: 'string', description: 'LONG or SHORT', required: true },
    amount: {
      type: 'number',
      description: 'Notional position size in dollars',
      required: true,
    },
    leverage: {
      type: 'number',
      description: 'Explicit leverage multiplier',
      required: true,
    },
  } as unknown as Action['parameters'],
  examples: [],
  validate: async (runtime) =>
    Boolean((runtime as FeedRuntime).a2aClient?.isConnected()),
  handler: async (runtime, _message, state, _options, callback) => {
    const client = clientFor(runtime);
    const params = z
      .object({
        ticker: id,
        side: z.enum(['LONG', 'SHORT']),
        amount: positive,
        leverage: positive.min(1).max(20),
      })
      .parse(state?.data?.actionParams);
    const raw = await client.openPosition(
      params.ticker,
      params.side,
      params.amount,
      params.leverage
    );
    // Preserve explicit backend errors before checking the successful response shape.
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.success === false
    )
      return complete('OPEN_PERP_POSITION', raw, callback);
    z.object({
      success: z.literal(true),
      position: z.object({
        positionId: id,
        ticker: id,
        side: z.enum(['LONG', 'SHORT']),
        entryPrice: positive,
        size: positive,
        leverage: positive,
      }),
      marginPaid: finite.nonnegative(),
      newBalance: finite,
    }).parse(raw);
    return complete('OPEN_PERP_POSITION', raw, callback);
  },
};

export const closePerpPositionAction: Action = {
  name: 'CLOSE_PERP_POSITION',
  description:
    'Close a perpetual position using its exact owned position ID. A ticker is not a position ID.',
  parameters: {
    positionId: {
      type: 'string',
      description: 'Exact owned perpetual position ID',
      required: true,
    },
  } as unknown as Action['parameters'],
  examples: [],
  validate: async (runtime) =>
    Boolean((runtime as FeedRuntime).a2aClient?.isConnected()),
  handler: async (runtime, _message, state, _options, callback) => {
    const client = clientFor(runtime);
    const params = z
      .object({ positionId: id })
      .parse(state?.data?.actionParams);
    const raw = await client.closePosition(params.positionId);
    // Preserve explicit backend errors before checking the successful response shape.
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.success === false
    )
      return complete('CLOSE_PERP_POSITION', raw, callback);
    z.object({
      success: z.literal(true),
      position: z.object({
        positionId: id,
        exitPrice: positive,
        entryPrice: positive,
      }),
      pnl: finite,
      marginReturned: finite,
      newBalance: finite,
    }).parse(raw);
    return complete('CLOSE_PERP_POSITION', raw, callback);
  },
};
