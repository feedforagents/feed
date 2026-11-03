import { afterEach, describe, expect, it } from 'bun:test';
import { RealPriceService } from '../../engine/src/services/real-price-service';

/**
 * RealPriceService failure fallback tests
 *
 * Pins the oracle fallback contract: a failed upstream price fetch must keep
 * serving the last successfully fetched live price, NOT the older hardcoded
 * static reference, and must not advertise fresh staleness-free data that has
 * silently degraded to defaults.
 */

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_NOW = Date.now;

function withFetch(stub: () => Promise<Response>) {
  globalThis.fetch = stub as unknown as typeof fetch;
}

describe('RealPriceService failure fallback', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    Date.now = ORIGINAL_NOW;
  });

  it('carries forward last-known-good live prices when the next fetch fails', async () => {
    const service = new RealPriceService();

    // Step 1: successful fetch primes the cache with live ETH price 2500.
    withFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ethereum: { usd: 2500, usd_24h_change: 1.5 },
            zcash: { usd: 240, usd_24h_change: -0.5 },
          }),
          { status: 200 }
        )
      )
    );
    const prices = await service.fetchPrices();
    expect(prices.get('ethereum')).toBe(2500);
    expect(service.getBasePriceForOrg('ethereum-foundaition')).toBe(2500);

    // Step 2: simulate cache expiry (TTL is 5 minutes).
    const fakeLater = Date.now() + 6 * 60 * 1000;
    Date.now = () => fakeLater;

    // Step 3: upstream fails outright (network error).
    withFetch(() => Promise.reject(new Error('network down')));
    await service.fetchPrices();

    // Last-known-good live price must survive the failed refresh.
    // The bug this pins: the failure path rebuilt the cache without any live
    // crypto entries, so getBasePriceForOrg silently degraded to the stale
    // hardcoded 2100 static reference while resetting the freshness TTL.
    expect(service.getBasePriceForOrg('ethereum-foundaition')).toBe(2500);
  });

  it('still prefers fresh live prices over carried-forward ones after recovery', async () => {
    const service = new RealPriceService();

    withFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ethereum: { usd: 2500 } }), {
          status: 200,
        })
      )
    );
    await service.fetchPrices();

    const fakeLater = Date.now() + 6 * 60 * 1000;
    Date.now = () => fakeLater;
    withFetch(() => Promise.reject(new Error('network down')));
    await service.fetchPrices();

    // Recovery after the outage.
    const fakeMuchLater = fakeLater + 6 * 60 * 1000;
    Date.now = () => fakeMuchLater;
    withFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ethereum: { usd: 3000 } }), {
          status: 200,
        })
      )
    );
    await service.fetchPrices();

    expect(service.getBasePriceForOrg('ethereum-foundaition')).toBe(3000);
  });
});
