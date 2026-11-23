/** PRD §13/D-24, MVP Phase0 step5: isolated simulator correctness only. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { z } from 'zod';
import { startBridge } from './helpers/simulation-bridge';

const outcomeSchema = z.object({
  success: z.boolean(),
  pnl: z.number(),
  newBalance: z.number(),
  error: z.string().optional(),
});
const npcsSchema = z.object({
  npcs: z.array(z.object({ npcId: z.string(), balance: z.number() })),
});
type Bridge = Awaited<ReturnType<typeof startBridge>>;
let bridge: Bridge;
async function post(path: string, body: object) {
  const response = await bridge.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function initialize() {
  const body = z
    .object({ status: z.literal('initialized') })
    .parse(await post('/init', { numNPCs: 2, seed: 42 }));
  expect(body.status).toBe('initialized');
}
async function balance(npcId = 'npc-000') {
  const response = await bridge.request('/npcs');
  expect(response.status).toBe(200);
  const npc = npcsSchema
    .parse(await response.json())
    .npcs.find((row) => row.npcId === npcId);
  if (!npc) throw new Error('Expected owned NPC');
  return npc.balance;
}
async function execute(type: string, amount: number, npcId = 'npc-000') {
  return outcomeSchema.parse(
    await post('/execute', { npcId, action: { type, amount } })
  );
}
async function rejectedPredictionSell(
  type: 'sell_yes' | 'sell_no',
  amount: number,
  npcId = 'npc-000'
) {
  const before = await balance(npcId);
  const outcome = await execute(type, amount, npcId);
  expect(outcome.success).toBe(false);
  expect(outcome.error).toBe('Insufficient open position');
  expect(outcome.pnl).toBe(0);
  expect(outcome.newBalance).toBe(before);
  expect(await balance(npcId)).toBe(before);
}
async function soldPrediction(
  type: 'sell_yes' | 'sell_no',
  amount: number,
  npcId = 'npc-000'
) {
  const before = await balance(npcId);
  const outcome = await execute(type, amount, npcId);
  expect(outcome.success).toBe(true);
  expect(outcome.error).toBeUndefined();
  // Close-leg PnL: (random() - 0.4) * amount * 0.2, i.e. [-0.08, +0.12] * amount.
  expect(outcome.pnl).toBeGreaterThanOrEqual(-0.08 * amount);
  expect(outcome.pnl).toBeLessThanOrEqual(0.12 * amount);
  expect(outcome.newBalance).toBe(before + (amount + outcome.pnl));
  expect(await balance(npcId)).toBe(outcome.newBalance);
}

beforeAll(async () => {
  bridge = await startBridge();
}, 30_000);
afterAll(async () => {
  if (bridge) await bridge.stop();
});
beforeEach(initialize);

describe('owned HTTP simulator prediction buy_yes/buy_no/sell_yes/sell_no', () => {
  it('rejects a prediction sell without any matching holding and keeps balances unchanged', async () => {
    await rejectedPredictionSell('sell_yes', 100);
    await rejectedPredictionSell('sell_yes', 1);
    await rejectedPredictionSell('sell_no', 100);
    await rejectedPredictionSell('sell_no', 1);
  });
  it('returns the principal plus simulated PnL on a YES round trip', async () => {
    const bought = await execute('buy_yes', 100);
    expect(bought.success).toBe(true);
    expect(bought.error).toBeUndefined();
    // A buy opens inventory: no PnL is realized until the sell.
    expect(bought.pnl).toBe(0);
    expect(bought.newBalance).toBe(10_000 - 100);
    expect(await balance()).toBe(9_900);
    await soldPrediction('sell_yes', 100);
    await rejectedPredictionSell('sell_yes', 1);
  });
  it('returns the principal plus simulated PnL on a NO round trip', async () => {
    expect((await execute('buy_no', 100)).success).toBe(true);
    expect(await balance()).toBe(9_900);
    await soldPrediction('sell_no', 100);
    await rejectedPredictionSell('sell_no', 1);
  });
  it('covers partial sales and rejects any sale past the holding', async () => {
    expect((await execute('buy_yes', 100)).success).toBe(true);
    await soldPrediction('sell_yes', 25);
    await soldPrediction('sell_yes', 25);
    await soldPrediction('sell_yes', 50);
    await rejectedPredictionSell('sell_yes', 1);
    expect((await execute('buy_no', 100)).success).toBe(true);
    await rejectedPredictionSell('sell_no', 150);
    await soldPrediction('sell_no', 40);
    await soldPrediction('sell_no', 60);
    await rejectedPredictionSell('sell_no', 1);
  });
  it('keeps YES and NO inventory separate from each other', async () => {
    expect((await execute('buy_yes', 100)).success).toBe(true);
    await rejectedPredictionSell('sell_no', 1);
    await soldPrediction('sell_yes', 100);
    expect((await execute('buy_no', 100)).success).toBe(true);
    await rejectedPredictionSell('sell_yes', 1);
    await soldPrediction('sell_no', 100);
  });
  it('never grants another leg sellable exposure from a prediction buy', async () => {
    for (const action of ['buy_yes', 'buy_no'])
      expect((await execute(action, 10)).success).toBe(true);
    const before = await balance();
    const generic = await execute('sell', 1);
    expect(generic.success).toBe(false);
    expect(generic.error).toBe('Insufficient open position');
    expect(await balance()).toBe(before);
    const closed = await execute('close_position', 1);
    expect(closed.success).toBe(false);
    expect(closed.error).toBe('Insufficient open position');
    expect(await balance()).toBe(before);
  });
  it('never grants a prediction sell from a generic buy', async () => {
    expect((await execute('buy', 100)).success).toBe(true);
    await rejectedPredictionSell('sell_yes', 1);
    await rejectedPredictionSell('sell_no', 1);
    const closed = await execute('close_position', 100);
    expect(closed.success).toBe(true);
  });
  it('never grants another NPC prediction inventory from a buy', async () => {
    expect((await execute('buy_yes', 100)).success).toBe(true);
    await rejectedPredictionSell('sell_yes', 1, 'npc-001');
    await soldPrediction('sell_yes', 100);
  });
});
