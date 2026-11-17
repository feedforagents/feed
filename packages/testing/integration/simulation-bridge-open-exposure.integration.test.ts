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
import {
  reserveBridgePort,
  spawnBridge,
  startBridge,
} from './helpers/simulation-bridge';

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
async function rejected(type: string, amount: number, npcId = 'npc-000') {
  const before = await balance(npcId);
  const outcome = await execute(type, amount, npcId);
  expect(outcome.success).toBe(false);
  expect(outcome.error).toBe('Insufficient open position');
  expect(outcome.pnl).toBe(0);
  expect(outcome.newBalance).toBe(before);
  expect(await balance(npcId)).toBe(before);
}
async function closed(type: string, amount: number) {
  const before = await balance();
  const outcome = await execute(type, amount);
  expect(outcome.success).toBe(true);
  expect(outcome.error).toBeUndefined();
  expect(outcome.pnl).toBeGreaterThanOrEqual(-0.08 * amount);
  expect(outcome.pnl).toBeLessThanOrEqual(0.12 * amount);
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

describe('owned HTTP simulator aggregate open exposure', () => {
  it('rejects every close alias without a stake and keeps balances unchanged', async () => {
    for (const type of ['close_long', 'close_short', 'close_position'])
      await rejected(type, 1_000_000);
  });
  it('keeps both open directions and all close aliases within the staked amount', async () => {
    for (const direction of ['open_long', 'open_short']) {
      await initialize();
      expect((await execute(direction, 100)).success).toBe(true);
      expect(await balance()).toBe(9_900);
      await rejected('close_position', 101);
      await closed('close_long', 25);
      await closed('close_short', 25);
      await closed('close_position', 50);
      await rejected('close_position', 1);
    }
  });
  it('never grants another NPC exposure or exposure from predictions/failed opens', async () => {
    expect((await execute('open_long', 100)).success).toBe(true);
    await rejected('close_long', 1, 'npc-001');
    await closed('close_position', 100);
    await initialize();
    const before = await balance();
    const failed = await execute('open_short', before + 1);
    expect(failed.success).toBe(false);
    expect(failed.error).toBe('Insufficient balance');
    expect(await balance()).toBe(before);
    for (const action of ['buy_yes', 'buy_no'])
      expect((await execute(action, 10)).success).toBe(true);
    await rejected('close_short', 1);
  });
  it('drops old exposure on reinitialization and reset', async () => {
    expect((await execute('open_long', 100)).success).toBe(true);
    await initialize();
    expect(await balance()).toBe(10_000);
    await rejected('close_position', 100);
    expect((await execute('open_short', 100)).success).toBe(true);
    const reset = z
      .object({ status: z.literal('reset') })
      .parse(await post('/reset', {}));
    expect(reset.status).toBe('reset');
    await initialize();
    await rejected('close_position', 100);
  });
  it('closes the exact accepted decimal stake in partial amounts', async () => {
    expect((await execute('open_long', 0.3)).success).toBe(true);
    await closed('close_long', 0.1);
    await closed('close_position', 0.2);
    await rejected('close_position', 0.1);
  });
  it('adds decimal opens without creating a spendable floating-point residue', async () => {
    expect((await execute('open_short', 0.1)).success).toBe(true);
    expect((await execute('open_long', 0.2)).success).toBe(true);
    await closed('close_short', 0.3);
    await rejected('close_position', 5e-17);
  });
  it('preserves tiny accepted stakes and rejects an actually larger close', async () => {
    expect((await execute('open_long', 100)).success).toBe(true);
    await rejected('close_position', 100.00000000000001);
    await rejected('close_position', Number.MAX_VALUE);
    expect((await execute('open_short', Number.MIN_VALUE)).success).toBe(true);
    await closed('close_position', 100);
    await closed('close_long', Number.MIN_VALUE);
    await rejected('close_short', Number.MIN_VALUE);
  });
  it('retains default amounts and rejects invalid amounts before exposure conversion', async () => {
    const before = await balance();
    for (const amount of [0, -1, '0.1']) {
      const result = outcomeSchema.parse(
        await post('/execute', {
          npcId: 'npc-000',
          action: { type: 'open_long', amount },
        })
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid amount');
      expect(result.newBalance).toBe(before);
    }
    const overflow = await bridge.request('/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"npcId":"npc-000","action":{"type":"open_long","amount":1e400}}',
    });
    expect(overflow.status).toBe(200);
    const invalid = outcomeSchema.parse(await overflow.json());
    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain('Invalid amount');
    expect(invalid.newBalance).toBe(before);
    const opened = outcomeSchema.parse(
      await post('/execute', {
        npcId: 'npc-000',
        action: { type: 'open_long' },
      })
    );
    expect(opened.success).toBe(true);
    expect(opened.newBalance).toBe(before - 100);
    const closedDefault = outcomeSchema.parse(
      await post('/execute', {
        npcId: 'npc-000',
        action: { type: 'close_position', amount: null },
      })
    );
    expect(closedDefault.success).toBe(true);
    await rejected('close_position', Number.MIN_VALUE);
  });
  it('refuses an occupied owned port before sending HTTP to its occupant', async () => {
    const reservation = await reserveBridgePort();
    const collision = spawnBridge(reservation.port);
    try {
      await expect(collision.ready()).rejects.toThrow(
        'Owned bridge did not bind'
      );
      expect(reservation.connections()).toBe(0);
    } finally {
      await collision.stop();
      await reservation.close();
    }
  }, 30_000);
  it('can start and fully stop two consecutive owned children', async () => {
    for (let index = 0; index < 2; index++) {
      const child = await startBridge();
      try {
        expect(child.child.pid).toBeGreaterThan(0);
      } finally {
        await child.stop();
      }
      expect(await child.child.exited).toBe(143);
    }
  }, 30_000);
});
