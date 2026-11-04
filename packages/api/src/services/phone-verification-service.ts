import { and, db, eq, isNull, users } from '@feed/db';
import { logger, POINTS } from '@feed/shared';
import { TradingBalanceFundingService } from './trading-balance-funding-service';

export interface PhoneVerificationCompletionResult {
  success: boolean;
  /** `phoneVerifiedAt` was already recorded before this call. */
  alreadyVerified: boolean;
  /** This call paid the starting grant. */
  grantAwarded: boolean;
  /** The grant's ledger row already existed before this call. */
  grantAlreadyProcessed: boolean;
  /** Trading balance after this call (unchanged on failure). */
  newBalance: number;
  error?: string;
}

/**
 * Phone verification completion — the starting grant's only trigger.
 *
 * PRD §9.1 [D-11]: "Start: 100 pts per account, once, at phone
 * verification." The MVP sign-up flow (Phase 2, item 5: phone → code →
 * username → grant 100 pts) calls `completePhoneVerification` when code
 * verification succeeds for an account. Profile completion is NOT the
 * grant event: an account that never verifies a phone receives nothing,
 * and the born-with schema defaults are '0', so no other creation path
 * holds an unledgered grant either.
 *
 * Once-only rests on two independent records, either of which alone
 * stops a second payment:
 *
 * 1. `users.phoneVerifiedAt` is set with a conditional update that only
 *    matches while it is still null, so exactly one completion call
 *    records the verification event.
 * 2. The grant itself is paid through
 *    `TradingBalanceFundingService.awardWelcomeBonus`, which takes the
 *    user-row lock and no-ops when the welcome-bonus ledger row exists.
 *
 * The funding call runs on every completion call — including repeats —
 * so a failure between recording the verification and paying the grant
 * heals on the next call instead of stranding a verified account with
 * no grant: the repeat sees `alreadyVerified`, the funding service sees
 * no ledger row, and the grant is paid then.
 */
export class PhoneVerificationService {
  static async completePhoneVerification(
    userId: string
  ): Promise<PhoneVerificationCompletionResult> {
    // Record the verification event. The conditional update is atomic:
    // it matches only the first completion for this account.
    const [marked] = await db
      .update(users)
      .set({ phoneVerifiedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.phoneVerifiedAt)))
      .returning({ id: users.id });

    let alreadyVerified = false;
    if (!marked) {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!existing) {
        return {
          success: false,
          alreadyVerified: false,
          grantAwarded: false,
          grantAlreadyProcessed: false,
          newBalance: 0,
          error: 'User not found',
        };
      }
      alreadyVerified = true;
    }

    const grant = await TradingBalanceFundingService.awardWelcomeBonus(
      userId,
      POINTS.INITIAL_SIGNUP
    );

    if (!grant.success) {
      logger.error(
        'Starting grant failed after phone verification was recorded; a later completion call retries the grant',
        { userId, error: grant.error },
        'PhoneVerificationService'
      );
      return {
        success: false,
        alreadyVerified,
        grantAwarded: false,
        grantAlreadyProcessed: false,
        newBalance: grant.newBalance,
        error: grant.error ?? 'Failed to pay the starting grant',
      };
    }

    if (!alreadyVerified) {
      logger.info(
        'Phone verification recorded and starting grant settled',
        {
          userId,
          amount: POINTS.INITIAL_SIGNUP,
          grantAwarded: !grant.alreadyProcessed,
        },
        'PhoneVerificationService'
      );
    }

    return {
      success: true,
      alreadyVerified,
      grantAwarded: !grant.alreadyProcessed,
      grantAlreadyProcessed: grant.alreadyProcessed === true,
      newBalance: grant.newBalance,
    };
  }
}
