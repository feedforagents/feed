import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { requireServer, waitForServerAvailability } from './helpers';
import { createStewardTestToken } from './helpers/steward-auth';

setDefaultTimeout(30000);
const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const ids: string[] = [];

async function createUser() {
  const id = await generateSnowflakeId();
  const stewardId = `retired-transfer-${id}`;
  ids.push(id);
  await dbWrite.insert(users).values({
    id,
    stewardId,
    username: `retired-${id}`,
    virtualBalance: '1000',
    totalDeposited: '1000',
    profileComplete: true,
    updatedAt: new Date(),
  });
  return { id, token: await createStewardTestToken(stewardId) };
}

async function state() {
  const balances = await dbWrite
    .select({
      id: users.id,
      balance: users.virtualBalance,
      pnl: users.lifetimePnL,
    })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(users.id);
  const ledger = await dbWrite
    .select()
    .from(balanceTransactions)
    .where(inArray(balanceTransactions.userId, ids));
  return { balances, ledger };
}

beforeAll(async () => {
  requireServer(await waitForServerAvailability(baseUrl), baseUrl);
  await dbWrite.execute(sql`SELECT 1`);
});

afterAll(async () => {
  if (ids.length) {
    await dbWrite
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, ids));
    await dbWrite.delete(users).where(inArray(users.id, ids));
  }
});

describe('retired peer transfers with real API and wallets', () => {
  test('a valid authenticated caller cannot move points to another user', async () => {
    const sender = await createUser(),
      recipient = await createUser();
    const headers = {
      Authorization: `Bearer ${sender.token}`,
      'Content-Type': 'application/json',
    };
    const identity = await fetch(`${baseUrl}/api/users/me`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    expect(identity.status).toBe(200);
    const before = await state();
    const response = await fetch(
      `${baseUrl}/api/users/trading-balance/transfer`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ recipientUserId: recipient.id, amount: 25 }),
        signal: AbortSignal.timeout(20000),
      }
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe(
      'TRADING_BALANCE_TRANSFER_DISABLED'
    );
    expect(await state()).toEqual(before);
    const [senderAfter] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, sender.id));
    expect(Number(senderAfter?.virtualBalance)).toBe(1000);
  });

  test('a malformed anonymous request is retired before authentication or body parsing', async () => {
    const response = await fetch(
      `${baseUrl}/api/users/trading-balance/transfer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
        signal: AbortSignal.timeout(20000),
      }
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe(
      'TRADING_BALANCE_TRANSFER_DISABLED'
    );
  });
});
