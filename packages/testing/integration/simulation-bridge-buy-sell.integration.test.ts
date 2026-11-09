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
async function rejectedSell(amount: number, npcId = 'npc-000') {
  const before = await balance(npcId);
  const outcome = await execute('sell', amount, npcId);
  expect(outcome.success).toBe(false);
  expect(outcome.error).toBe('Insufficient open position');
  expect(outcome.pnl).toBe(0);
  expect(outcome.newBalance).toBe(before);
  expect(await balance(npcId)).toBe(before);
}
async function sold(amount: number) {
  const before = await balance();
  const outcome = await execute('sell', amount);
  expect(outcome.success).toBe(true);
  expect(outcome.error).toBeUndefined();
  expect(outcome.pnl).toBeGreaterThanOrEqual(-0.135 * amount);
  expect(outcome.pnl).toBeLessThanOrEqual(0.165 * amount);
  expect(outcome.newBalance).toBe(before + (amount + outcome.pnl));
  expect(await balance()).toBe(outcome.newBalance);
}

beforeAll(async () => {
  bridge = await startBridge();
}, 30_000);
afterAll(async () => {
  if (bridge) await bridge.stop();
});
beforeEach(initialize);

describe('owned HTTP simulator generic buy/sell stake', () => {
  it('rejects sell without any open position and keeps balances unchanged', async () => {
    await rejectedSell(100);
    await rejectedSell(1);
  });
  it('buys stake exposure instead of settling phantom PnL, then sells within it', async () => {
    const bought = await execute('buy', 100);
    expect(bought.success).toBe(true);
    expect(bought.error).toBeUndefined();
    // A buy opens a stake: no PnL is realized until the sell.
    expect(bought.pnl).toBe(0);
    expect(bought.newBalance).toBe(10_000 - 100);
    expect(await balance()).toBe(9_900);
    await sold(25);
    await sold(25);
    await sold(50);
    await rejectedSell(1);
  });
  it('keeps a buy stake in the shared pool closable by the close aliases', async () => {
    expect((await execute('buy', 100)).success).toBe(true);
    const before = await balance();
    const closed = await execute('close_position', 100);
    expect(closed.success).toBe(true);
    expect(closed.pnl).toBeGreaterThanOrEqual(-0.08 * 100);
    expect(closed.pnl).toBeLessThanOrEqual(0.12 * 100);
    expect(closed.newBalance).toBe(before + (100 + closed.pnl));
    await rejectedSell(1);
  });
  it('never grants sellable exposure from prediction buys or failed buys', async () => {
    for (const action of ['buy_yes', 'buy_no'])
      expect((await execute(action, 10)).success).toBe(true);
    await rejectedSell(1);
    await initialize();
    const before = await balance();
    const failed = await execute('buy', before + 1);
    expect(failed.success).toBe(false);
    expect(failed.error).toBe('Insufficient balance');
    expect(await balance()).toBe(before);
    await rejectedSell(1);
  });
  it('never grants another NPC sellable exposure from a buy', async () => {
    expect((await execute('buy', 100)).success).toBe(true);
    await rejectedSell(1, 'npc-001');
    await sold(100);
  });
});
