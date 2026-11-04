#!/usr/bin/env bun
/**
 * Local Cron Simulator
 *
 * Simulates the Cloudflare cron scheduler locally by calling game-tick, markets-tick, and npc-tick endpoints every minute.
 * Use this if you don't want to run the full daemon but want content generation and agent activity.
 *
 * Usage:
 *   bun run cron:local      (start local cron)
 *   bun run dev             (in another terminal - web app)
 *
 * Or use dev:full to run both automatically.
 */

const CRON_INTERVAL = 60000; // 60 seconds
const GAME_TICK_URL = 'http://localhost:3000/api/cron/game-tick';
const MARKETS_TICK_URL = 'http://localhost:3000/api/cron/markets-tick';
const NPC_TICK_URL = 'http://localhost:3000/api/cron/npc-tick';

let intervalId: NodeJS.Timeout | null = null;
let tickCount = 0;
let tickInProgress = false;

async function executeGameTick() {
  tickCount++;
  console.info(
    `🎮 Triggering game tick #${tickCount}...`,
    undefined,
    'LocalCron'
  );

  const response = await fetch(GAME_TICK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET || 'development'}`,
      'Content-Type': 'application/json',
    },
  }).catch((error: Error) => {
    const errorMessage = error.message;
    console.error(
      `Game tick #${tickCount} error: ${errorMessage}`,
      { error },
      'LocalCron'
    );

    if (errorMessage.includes('ECONNREFUSED')) {
      console.error(
        '❌ Next.js dev server not running!',
        undefined,
        'LocalCron'
      );
      console.error('   Start it first: bun run dev', undefined, 'LocalCron');
      process.exit(1);
    }
    return null;
  });

  if (!response) return;

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(
      `Game tick #${tickCount} failed (HTTP ${response.status})`,
      { body: text.slice(0, 200) },
      'LocalCron'
    );
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    console.warn(
      `Game tick #${tickCount} returned non-JSON (${response.status})`,
      undefined,
      'LocalCron'
    );
    return;
  }

  const data = await response.json().catch(() => ({}));

  if (data.skipped) {
    console.warn(
      `Game tick #${tickCount} skipped: ${data.reason}`,
      undefined,
      'LocalCron'
    );
    return;
  }

  console.info(
    `✅ Game tick #${tickCount} completed`,
    {
      duration: data.duration,
      posts: data.result?.postsCreated || 0,
      events: data.result?.eventsCreated || 0,
      markets: data.result?.marketsUpdated || 0,
    },
    'LocalCron'
  );
}

async function executeNpcTick() {
  console.info(
    `👤 Triggering NPC tick #${tickCount}...`,
    undefined,
    'LocalCron'
  );

  const response = await fetch(NPC_TICK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET || 'development'}`,
      'Content-Type': 'application/json',
    },
  }).catch((error: Error) => {
    console.error(
      `NPC tick #${tickCount} error: ${error.message}`,
      { error },
      'LocalCron'
    );
    return null;
  });

  if (!response) return;

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const text = await response.text();
    console.error(
      `NPC tick #${tickCount} failed (HTTP ${response.status})`,
      { body: text.slice(0, 500) },
      'LocalCron'
    );
    return;
  }

  if (contentType.includes('application/json')) {
    const data = await response.json();
    console.info(
      `✅ NPC tick #${tickCount} completed`,
      {
        postsCreated: data.postsCreated || 0,
        npcsProcessed: data.npcsProcessed || 0,
      },
      'LocalCron'
    );
  }
}

async function executeMarketsTick() {
  console.info(
    `📈 Triggering markets tick #${tickCount}...`,
    undefined,
    'LocalCron'
  );

  const response = await fetch(MARKETS_TICK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET || 'development'}`,
      'Content-Type': 'application/json',
    },
  }).catch((error: Error) => {
    console.error(
      `Markets tick #${tickCount} error: ${error.message}`,
      { error },
      'LocalCron'
    );
    return null;
  });

  if (!response) return;

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const text = await response.text();
    console.error(
      `Markets tick #${tickCount} failed (HTTP ${response.status})`,
      { body: text.slice(0, 500) },
      'LocalCron'
    );
    return;
  }

  if (contentType.includes('application/json')) {
    const data = await response.json();
    if (data.skipped) {
      console.info(
        `Markets tick #${tickCount} skipped: ${data.reason}`,
        undefined,
        'LocalCron'
      );
    } else {
      console.info(
        `✅ Markets tick #${tickCount} completed`,
        {
          resolved: data.resolved ?? 0,
          created: data.created ?? 0,
          active: data.active ?? 0,
        },
        'LocalCron'
      );
    }
  }
}

async function executeTick() {
  await executeGameTick();
  await executeMarketsTick();
  await executeNpcTick();
}

/** First /api/health request can take a long time while Turbopack compiles (slow disks see 10s+). */
const HEALTH_CHECK_TIMEOUT_MS = 60_000;

async function waitForServer(
  maxAttempts = 60,
  delayMs = 3000
): Promise<boolean> {
  console.info(
    'Waiting for Next.js server to be ready...',
    undefined,
    'LocalCron'
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('http://localhost:3000/api/health', {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });

      if (response.ok) {
        console.info(
          `✅ Server ready after ${attempt} attempt(s)`,
          undefined,
          'LocalCron'
        );
        return true;
      }

      if (attempt < maxAttempts) {
        console.info(
          `Attempt ${attempt}/${maxAttempts}: health returned HTTP ${response.status}, waiting ${delayMs}ms...`,
          undefined,
          'LocalCron'
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (_error) {
      if (attempt < maxAttempts) {
        console.info(
          `Attempt ${attempt}/${maxAttempts}: Server not ready, waiting ${delayMs}ms...`,
          undefined,
          'LocalCron'
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error(
    '❌ Server did not become ready after maximum attempts',
    undefined,
    'LocalCron'
  );
  return false;
}

async function main() {
  console.info('🔄 LOCAL CRON SIMULATOR', undefined, 'LocalCron');
  console.info('======================', undefined, 'LocalCron');
  console.info(
    'Simulating the cron scheduler by calling game-tick, markets-tick, npc-tick every minute',
    undefined,
    'LocalCron'
  );
  console.info('Press Ctrl+C to stop', undefined, 'LocalCron');
  console.info('', undefined, 'LocalCron');

  // Wait for server to be ready with health check
  const serverReady = await waitForServer();
  if (!serverReady) {
    console.error(
      'Cannot start cron simulator - server is not ready',
      undefined,
      'LocalCron'
    );
    process.exit(1);
  }

  // Execute first tick immediately
  await executeTick();

  // Then execute every minute
  intervalId = setInterval(async () => {
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      await executeTick();
    } finally {
      tickInProgress = false;
    }
  }, CRON_INTERVAL);

  // Handle shutdown gracefully
  const cleanup = () => {
    console.info('Stopping local cron simulator...', undefined, 'LocalCron');
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    console.info(`Total ticks executed: ${tickCount}`, undefined, 'LocalCron');
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main();
