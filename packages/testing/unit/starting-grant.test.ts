/**
 * Starting grant — PRD §9.1 [D-11]: "Start: 100 pts per account, once, at
 * phone verification." MVP Phase 6 item 1: "starting grant 100".
 *
 * The grant must happen exactly once, through the ledgered welcome-bonus
 * path (TradingBalanceFundingService.awardWelcomeBonus, called by the
 * signup route with POINTS.INITIAL_SIGNUP). A user row must therefore be
 * born with no balance of its own: if the schema default granted anything,
 * accounts created outside the signup route (/api/users/me first auth,
 * ensure-user, telegram mini-app) would hold an unledgered grant, and
 * signup completions would be funded twice.
 */
import { describe, expect, it } from 'bun:test';
import {
  classifyBalanceTransaction,
  getCapitalBaseContributionAmount,
  users,
  WELCOME_BONUS_BALANCE_DESCRIPTION,
} from '@feed/db';
import { POINTS } from '@feed/shared';
import { getTableConfig } from 'drizzle-orm/pg-core';

function schemaDefault(columnName: string): string | undefined {
  const config = getTableConfig(users);
  const column = config.columns.find((col) => col.name === columnName);
  return column?.default as string | undefined;
}

describe('starting grant (PRD §9.1 [D-11])', () => {
  it('funds the ledgered welcome bonus with exactly 100 pts', () => {
    expect(POINTS.INITIAL_SIGNUP).toBe(100);
  });

  it('creates user rows with no silent balance grant', () => {
    expect(schemaDefault('virtualBalance')).toBe('0');
    expect(schemaDefault('totalDeposited')).toBe('0');
  });

  it('totals exactly 100 pts on the signup path and 0 before it', () => {
    const bornWith = Number(schemaDefault('virtualBalance'));
    // Signup completion: born-with amount plus the single ledgered grant.
    expect(bornWith + POINTS.INITIAL_SIGNUP).toBe(100);
    // Any other creation path: no grant until signup funds it.
    expect(bornWith).toBe(0);
    expect(Number(schemaDefault('totalDeposited'))).toBe(0);
  });

  it('keeps the welcome-bonus ledger row classified as capital funding', () => {
    const welcomeBonusDeposit = {
      type: 'deposit',
      amount: String(POINTS.INITIAL_SIGNUP),
      description: WELCOME_BONUS_BALANCE_DESCRIPTION,
    };

    const classification = classifyBalanceTransaction(welcomeBonusDeposit);
    expect(classification.capitalKind).toBe('external_funding');
    expect(classification.depositReason).toBe('default_wallet_funding');
    expect(
      getCapitalBaseContributionAmount(welcomeBonusDeposit, 'wallet')
    ).toBe(POINTS.INITIAL_SIGNUP);
    expect(getCapitalBaseContributionAmount(welcomeBonusDeposit, 'team')).toBe(
      POINTS.INITIAL_SIGNUP
    );
  });
});
