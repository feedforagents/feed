/**
 * Starting grant — PRD §9.1 [D-11]: "Start: 100 pts per account, once, at
 * phone verification." MVP Phase 6 item 1: "starting grant 100".
 *
 * The grant must happen exactly once, at phone verification, through the
 * ledgered welcome-bonus path (PhoneVerificationService records the
 * verification on the user row and settles the grant through
 * TradingBalanceFundingService.awardWelcomeBonus with
 * POINTS.INITIAL_SIGNUP). Profile completion is not the grant event.
 * A user row must therefore be born with no balance of its own: if the
 * schema default granted anything, accounts created on any path
 * (/api/users/me first auth, ensure-user, telegram mini-app) would hold
 * an unledgered grant before ever verifying a phone.
 *
 * The behavioral once-only proof lives in
 * phone-verification-grant.test.ts, which runs the real services
 * against a stateful fake DB; this file pins the static invariants.
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

  it('totals exactly 100 pts at phone verification and 0 before it', () => {
    const bornWith = Number(schemaDefault('virtualBalance'));
    // Phone verification: born-with amount plus the single ledgered grant.
    expect(bornWith + POINTS.INITIAL_SIGNUP).toBe(100);
    // Before verification — on any creation path — an account holds 0.
    expect(bornWith).toBe(0);
    expect(Number(schemaDefault('totalDeposited'))).toBe(0);
  });

  it('records phone verification on the user row', () => {
    const config = getTableConfig(users);
    const column = config.columns.find((col) => col.name === 'phoneVerifiedAt');
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(false);
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
