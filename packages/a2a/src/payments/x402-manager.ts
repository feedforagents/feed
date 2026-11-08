/**
 * x402 Micropayment Manager
 * Implements HTTP 402-based micropayment protocol for agent services
 *
 * Supports optional Redis for persistent storage across serverless functions
 */

import {
  type JsonValue,
  logger,
  type PaymentVerificationParams,
  type PaymentVerificationResult,
} from '@feed/shared';
import {
  formatEther,
  hexlify,
  JsonRpcProvider,
  parseEther,
  randomBytes,
} from 'ethers';
import { z } from 'zod';
import type { PaymentRequest } from '../types/a2a';
import { PaymentRequestSchema } from '../types/a2a';

export interface X402Config {
  rpcUrl: string;
  minPaymentAmount?: string; // Minimum payment in wei (default: 0)
  paymentTimeout?: number; // Payment timeout in ms (default: 5 minutes)
  /** Max time for each JSON-RPC read (getTransaction / receipt). Prevents hung providers on serverless. */
  rpcReadTimeoutMs?: number;
  redis?: RedisClient; // Optional Redis client for persistence
  /** Chain reader; defaults to a JsonRpcProvider for rpcUrl. */
  provider?: ChainReader;
}

/**
 * The chain reads payment verification needs (satisfied by ethers providers).
 */
export interface ChainReader {
  getTransaction(
    hash: string
  ): Promise<{ from: string; to: string | null; value: bigint } | null>;
  getTransactionReceipt(
    hash: string
  ): Promise<{ status: number | null; blockNumber: number } | null>;
  getBlock(blockNumber: number): Promise<{ timestamp: number } | null>;
}

/**
 * Generic Redis client interface to avoid dependency on specific Redis libraries
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<void>;
  /** SET key value NX EX ttl. Returns true when the key was set. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

interface PendingPayment {
  request: PaymentRequest;
  createdAt: number;
  verified: boolean;
  /** Transaction that satisfied this request (set once verified). */
  verifiedTxHash?: string;
}

const PendingPaymentSchema = z.object({
  request: PaymentRequestSchema,
  createdAt: z.number(),
  verified: z.boolean(),
  verifiedTxHash: z.string().optional(),
});

const REDIS_PREFIX = 'x402:payment:';
/** Transaction hash -> requestId claims. Kept well beyond request expiry. */
const TX_CLAIM_PREFIX = 'x402:tx:';
const TX_CLAIM_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Allowed clock skew between request creation and the paying block. */
const BLOCK_TIME_SKEW_SECONDS = 120;
/** Process-local tx claims used when no Redis client is configured. */
const localTxClaims = new Map<string, string>();

export class X402Manager {
  private provider: ChainReader;
  private config: Required<
    Omit<X402Config, 'redis' | 'rpcReadTimeoutMs' | 'provider'>
  > & {
    redis?: RedisClient;
    rpcReadTimeoutMs: number;
  };
  private readonly DEFAULT_MIN_PAYMENT = '1000000000000000'; // 0.001 ETH
  private readonly DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly DEFAULT_RPC_READ_TIMEOUT_MS = 20_000;
  private inMemoryStore: Map<string, PendingPayment> = new Map();

  constructor(config: X402Config) {
    this.provider = config.provider ?? new JsonRpcProvider(config.rpcUrl);
    this.config = {
      rpcUrl: config.rpcUrl,
      minPaymentAmount: config.minPaymentAmount || this.DEFAULT_MIN_PAYMENT,
      paymentTimeout: config.paymentTimeout || this.DEFAULT_TIMEOUT,
      rpcReadTimeoutMs:
        config.rpcReadTimeoutMs ?? this.DEFAULT_RPC_READ_TIMEOUT_MS,
      redis: config.redis,
    };
  }

  private async withRpcTimeout<T>(
    label: string,
    operation: Promise<T>
  ): Promise<T> {
    const ms = this.config.rpcReadTimeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    });
    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Store payment with optional Redis persistence
   */
  private async storePayment(
    requestId: string,
    payment: PendingPayment
  ): Promise<void> {
    const key = `${REDIS_PREFIX}${requestId}`;
    const ttlSeconds = Math.ceil(this.config.paymentTimeout / 1000);
    const serialized = JSON.stringify(payment);

    // Always store in memory for fast access
    this.inMemoryStore.set(requestId, payment);

    // Also store in Redis if available
    if (this.config.redis) {
      await this.config.redis.set(key, serialized, { ex: ttlSeconds });
      logger.debug('[X402Manager] Stored payment in Redis', {
        requestId,
        ttl: ttlSeconds,
      });
    } else {
      logger.debug('[X402Manager] Redis not configured, using memory storage', {
        requestId,
      });
    }
  }

  /**
   * Retrieve payment from storage
   */
  private async getPayment(requestId: string): Promise<PendingPayment | null> {
    // First check in-memory store
    const inMemory = this.inMemoryStore.get(requestId);
    if (inMemory) {
      return inMemory;
    }

    // Try Redis if available
    if (!this.config.redis) {
      return null;
    }

    const key = `${REDIS_PREFIX}${requestId}`;

    const cached = await this.config.redis.get(key);

    if (!cached) {
      logger.debug('[X402Manager] Payment not found', { requestId });
      return null;
    }

    const paymentData = JSON.parse(cached);
    const validation = PendingPaymentSchema.safeParse(paymentData);

    if (!validation.success) {
      logger.error('[X402Manager] Invalid payment data', {
        requestId,
        error: validation.error,
      });
      await this.deletePayment(requestId);
      return null;
    }

    const payment: PendingPayment = {
      ...validation.data,
      request: {
        ...validation.data.request,
        metadata: validation.data.request.metadata as Record<
          string,
          string | number | boolean | null
        >,
      },
    };

    // Cache in memory
    this.inMemoryStore.set(requestId, payment);
    return payment;
  }

  /**
   * Update payment in storage
   */
  private async updatePayment(
    requestId: string,
    payment: PendingPayment
  ): Promise<void> {
    const key = `${REDIS_PREFIX}${requestId}`;
    const remainingMs = payment.request.expiresAt - Date.now();
    const ttlSeconds = Math.max(Math.ceil(remainingMs / 1000), 1);
    const serialized = JSON.stringify(payment);

    // Update in-memory
    this.inMemoryStore.set(requestId, payment);

    // Update Redis if available
    if (this.config.redis) {
      await this.config.redis.set(key, serialized, { ex: ttlSeconds });
      logger.debug('[X402Manager] Updated payment', { requestId });
    }
  }

  /**
   * Delete payment from storage
   */
  private async deletePayment(requestId: string): Promise<void> {
    const key = `${REDIS_PREFIX}${requestId}`;

    // Remove from memory
    this.inMemoryStore.delete(requestId);

    // Remove from Redis if available
    if (this.config.redis) {
      await this.config.redis.del(key);
      logger.debug('[X402Manager] Deleted payment', { requestId });
    }
  }

  /**
   * Create a payment request for a service
   */
  async createPaymentRequest(
    from: string,
    to: string,
    amount: string,
    service: string,
    metadata?: Record<string, string | number | boolean | null>
  ): Promise<PaymentRequest> {
    // Validate amount meets minimum
    const amountBn = parseEther(formatEther(amount));
    const minAmountBn = parseEther(formatEther(this.config.minPaymentAmount));

    if (amountBn < minAmountBn) {
      throw new Error(
        `Payment amount must be at least ${this.config.minPaymentAmount} wei`
      );
    }

    const requestId = this.generateRequestId();
    const expiresAt = Date.now() + this.config.paymentTimeout;

    const request: PaymentRequest = {
      requestId,
      from,
      to,
      amount,
      service,
      metadata: metadata as Record<string, JsonValue>,
      expiresAt,
    };

    // Store pending payment
    await this.storePayment(requestId, {
      request,
      createdAt: Date.now(),
      verified: false,
    });

    return request;
  }

  /**
   * Verify a payment receipt against blockchain transaction
   * Supports both EOA and smart wallet transactions
   */
  async verifyPayment(
    verificationData: PaymentVerificationParams
  ): Promise<PaymentVerificationResult> {
    const pending = await this.getPayment(verificationData.requestId);
    if (!pending) {
      return { verified: false, error: 'Payment request not found or expired' };
    }

    if (pending.verified) {
      // A verified request stays bound to the transaction that satisfied it.
      if (
        pending.verifiedTxHash &&
        pending.verifiedTxHash === verificationData.txHash.toLowerCase()
      ) {
        return { verified: true };
      }
      return {
        verified: false,
        error: 'Payment request was verified with a different transaction',
      };
    }

    if (Date.now() > pending.request.expiresAt) {
      await this.deletePayment(verificationData.requestId);
      return { verified: false, error: 'Payment request expired' };
    }

    let tx;
    try {
      tx = await this.withRpcTimeout(
        'getTransaction',
        this.provider.getTransaction(verificationData.txHash)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('timed out')) {
        return {
          verified: false,
          error:
            'Blockchain RPC timed out. Wait for confirmation, then try again.',
        };
      }
      throw e;
    }
    if (!tx) {
      return { verified: false, error: 'Transaction not found on blockchain' };
    }

    let txReceipt;
    try {
      txReceipt = await this.withRpcTimeout(
        'getTransactionReceipt',
        this.provider.getTransactionReceipt(verificationData.txHash)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('timed out')) {
        return {
          verified: false,
          error:
            'Blockchain RPC timed out. Wait for confirmation, then try again.',
        };
      }
      throw e;
    }
    if (!txReceipt) {
      return { verified: false, error: 'Transaction not yet confirmed' };
    }

    if (txReceipt.status !== 1) {
      return { verified: false, error: 'Transaction failed on blockchain' };
    }

    const errors: string[] = [];

    // Sender must be the wallet the request was issued for. Smart-wallet /
    // relayed transactions are not accepted: tx.from would be a bundler or
    // paymaster, and accepting any sender would let anyone claim someone
    // else's transfer to the same recipient.
    if (tx.from.toLowerCase() !== pending.request.from.toLowerCase()) {
      errors.push(
        `Sender mismatch: expected ${pending.request.from}, got ${tx.from}`
      );
    }

    if (tx.to?.toLowerCase() !== pending.request.to.toLowerCase()) {
      errors.push(
        `Recipient mismatch: expected ${pending.request.to}, got ${tx.to}`
      );
    }

    // tx.value is the transferred amount (gas is paid separately), so the
    // full requested amount is required.
    const requestedAmount = BigInt(pending.request.amount);
    if (tx.value < requestedAmount) {
      errors.push(
        `Insufficient payment: expected at least ${requestedAmount}, got ${tx.value}`
      );
    }

    if (errors.length > 0) {
      return { verified: false, error: errors.join('; ') };
    }

    // The paying transaction must not predate the request.
    const block = await this.withRpcTimeout(
      'getBlock',
      this.provider.getBlock(txReceipt.blockNumber)
    );
    if (!block) {
      return { verified: false, error: 'Transaction block not found' };
    }
    const requestCreatedSeconds = Math.floor(pending.createdAt / 1000);
    if (block.timestamp < requestCreatedSeconds - BLOCK_TIME_SKEW_SECONDS) {
      return {
        verified: false,
        error: 'Transaction predates the payment request',
      };
    }

    // Atomically bind this transaction to this request so it cannot satisfy
    // any other request (including concurrent verifications).
    const claimed = await this.claimTransaction(
      verificationData.txHash,
      verificationData.requestId
    );
    if (!claimed) {
      return {
        verified: false,
        error: 'Transaction has already been used for another payment',
      };
    }

    pending.verified = true;
    pending.verifiedTxHash = verificationData.txHash.toLowerCase();
    await this.updatePayment(verificationData.requestId, pending);

    logger.info(
      `[X402Manager] Payment verified successfully: ${verificationData.txHash}`,
      { requestId: verificationData.requestId }
    );

    return { verified: true };
  }

  /**
   * Claim txHash for requestId. Succeeds if unclaimed or already claimed by
   * the same request (idempotent retry).
   */
  private async claimTransaction(
    txHash: string,
    requestId: string
  ): Promise<boolean> {
    const key = `${TX_CLAIM_PREFIX}${txHash.toLowerCase()}`;
    if (this.config.redis) {
      if (
        await this.config.redis.setIfAbsent(
          key,
          requestId,
          TX_CLAIM_TTL_SECONDS
        )
      ) {
        return true;
      }
      return (await this.config.redis.get(key)) === requestId;
    }
    const existing = localTxClaims.get(key);
    if (existing === undefined) {
      localTxClaims.set(key, requestId);
      return true;
    }
    return existing === requestId;
  }

  /**
   * Verify a refund transaction actually returned the escrowed funds.
   * Unlike a payment verification, there is no payment request to match
   * against: the caller states the expected sender (the account holding
   * the funds), the acceptable recipients, and the minimum amount, and
   * the on-chain transaction must match all three.
   */
  async verifyRefundTransaction(params: {
    txHash: string;
    from: string;
    to: string | string[];
    amount: string;
  }): Promise<PaymentVerificationResult> {
    let tx;
    try {
      tx = await this.withRpcTimeout(
        'getTransaction',
        this.provider.getTransaction(params.txHash)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('timed out')) {
        return {
          verified: false,
          error:
            'Blockchain RPC timed out. Wait for confirmation, then try again.',
        };
      }
      throw e;
    }
    if (!tx) {
      return { verified: false, error: 'Transaction not found on blockchain' };
    }

    let txReceipt;
    try {
      txReceipt = await this.withRpcTimeout(
        'getTransactionReceipt',
        this.provider.getTransactionReceipt(params.txHash)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('timed out')) {
        return {
          verified: false,
          error:
            'Blockchain RPC timed out. Wait for confirmation, then try again.',
        };
      }
      throw e;
    }
    if (!txReceipt) {
      return { verified: false, error: 'Transaction not yet confirmed' };
    }

    if (txReceipt.status !== 1) {
      return { verified: false, error: 'Transaction failed on blockchain' };
    }

    const errors: string[] = [];

    if (tx.from.toLowerCase() !== params.from.toLowerCase()) {
      errors.push(`Sender mismatch: expected ${params.from}, got ${tx.from}`);
    }

    const expectedRecipients = Array.isArray(params.to)
      ? params.to
      : [params.to];
    if (
      !tx.to ||
      !expectedRecipients.some(
        (recipient) => tx.to!.toLowerCase() === recipient.toLowerCase()
      )
    ) {
      errors.push(
        `Recipient mismatch: expected one of ${expectedRecipients.join(', ')}, got ${tx.to}`
      );
    }

    // tx.value is the transferred amount (gas is paid separately), so the
    // full refunded amount is required.
    const expectedAmount = BigInt(params.amount);
    if (tx.value < expectedAmount) {
      errors.push(
        `Insufficient refund: expected at least ${expectedAmount}, got ${tx.value}`
      );
    }

    if (errors.length > 0) {
      return { verified: false, error: errors.join('; ') };
    }

    return { verified: true };
  }

  /**
   * Check that a transaction exists on chain and succeeded.
   */
  async isTransactionSuccessful(txHash: string): Promise<boolean> {
    const receipt = await this.withRpcTimeout(
      'getTransactionReceipt',
      this.provider.getTransactionReceipt(txHash)
    );
    return receipt !== null && receipt.status === 1;
  }

  /**
   * Get payment request details
   */
  async getPaymentRequest(requestId: string): Promise<PaymentRequest | null> {
    const pending = await this.getPayment(requestId);
    return pending ? pending.request : null;
  }

  /**
   * Check if payment has been verified
   */
  async isPaymentVerified(requestId: string): Promise<boolean> {
    const pending = await this.getPayment(requestId);
    return pending ? pending.verified : false;
  }

  /**
   * Cancel a payment request
   */
  async cancelPaymentRequest(requestId: string): Promise<boolean> {
    await this.deletePayment(requestId);
    return true;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `x402-${Date.now()}-${hexlify(randomBytes(16))}`;
  }

  /**
   * Get all pending payments (for testing/debugging)
   */
  async getPendingPayments(): Promise<PendingPayment[]> {
    // Get from in-memory store
    const payments = Array.from(this.inMemoryStore.values());
    return payments.filter((p) => !p.verified);
  }

  /**
   * Get statistics about payments (for testing/debugging)
   */
  async getStatistics() {
    const payments = Array.from(this.inMemoryStore.values());
    const now = Date.now();

    return payments.reduce(
      (acc, p) => {
        if (p.verified) {
          acc.verified++;
        } else if (p.request.expiresAt < now) {
          acc.expired++;
        } else {
          acc.pending++;
        }
        return acc;
      },
      { pending: 0, verified: 0, expired: 0 }
    );
  }

  /**
   * Cleanup method to clear in-memory storage
   */
  cleanup(): void {
    this.inMemoryStore.clear();
  }
}
