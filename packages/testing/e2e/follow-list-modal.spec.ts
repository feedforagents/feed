/**
 * FollowListModal E2E: profile follow lists page past 100 rows, restart
 * after an own unfollow, and recover from a failed later page.
 *
 * Prerequisites:
 * - Dev server running at PLAYWRIGHT_BASE_URL (default 127.0.0.1:3400)
 *   with dev auth enabled (ALLOW_TEST_PRIVY_DID_AUTH=true).
 * - A production server also works if FEED_STEWARD_TEST_TOKEN holds a
 *   Steward JWT for the Playwright dev user (the spec links the dev user's
 *   stewardId to its own id so the token resolves to the same row).
 * - Database reachable through the same DATABASE_URL the server uses, so
 *   the seed below and the server read the same roster.
 *
 * The seed is 150 fresh users the Playwright dev user follows. Row order
 * follows the API's createdAt-desc sort: seed i is created now - i minutes,
 * so seed 000 is the first row and seed 100 is the 101st row (the row the
 * old modal could never reach, and the row a stale page walk skips after
 * an unfollow).
 *
 * Run with: bunx playwright test follow-list-modal.spec.ts --config packages/testing/playwright.config.ts
 */

import { closeDatabase, db, eq, follows, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { expect, type Page, test } from '@playwright/test';
import {
  type BrowserDevAuthSession,
  installPlaywrightDevAuth,
} from './dev-auth';

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3400';

const SEED_COUNT = 150;
const SEED_PREFIX = 'f1809-e2e';
const MINUTE_MS = 60 * 1000;

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.setTimeout(180_000);

let serverAvailable = false;
let session: BrowserDevAuthSession | null = null;
let viewerId = '';
const seededUserIds: string[] = [];
const seedUsername = (i: number) =>
  `${SEED_PREFIX}-${String(i).padStart(3, '0')}`;

async function openFollowing(
  page: Page,
  profilePath = '/u/playwright-dev-admin'
) {
  await page.goto(`${BASE_URL}${profilePath}`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('button', { name: /Following/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

// Signed-in setup: install dev auth, then mark the game guide complete in
// localStorage before the first app navigation, so the first-run tour does
// not redirect the profile page to /onboarding mid-test.
async function installSignedIn(page: Page) {
  const authSession = await installPlaywrightDevAuth(page, BASE_URL);
  // Production servers ignore the dev-auth bypass, so when a Steward test
  // token is provided (FEED_STEWARD_TEST_TOKEN), install it as the
  // steward-token cookie — the same credential production users carry.
  const stewardToken = process.env.FEED_STEWARD_TEST_TOKEN;
  if (stewardToken) {
    await page.context().addCookies([
      {
        name: 'steward-token',
        value: stewardToken,
        url: BASE_URL,
        sameSite: 'Lax',
      },
    ]);
  }
  await page.addInitScript(
    ({ userId }) => {
      const key = 'feed-game-guide-completed';
      const prev = JSON.parse(
        window.localStorage.getItem(key) ?? '{}'
      ) as Record<string, boolean>;
      prev[userId] = true;
      window.localStorage.setItem(key, JSON.stringify(prev));
    },
    { userId: authSession.userId }
  );
  return authSession;
}

async function scrollListToBottom(page: Page) {
  const scroller = page.locator('[role="dialog"] .overflow-y-auto');
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

// One locator per rendered row: each row renders its handle in a <p>.
function rowHandles(page: Page) {
  return page.locator('[role="dialog"] p', { hasText: `@${SEED_PREFIX}-` });
}

async function loadedRowCount(page: Page) {
  return rowHandles(page).count();
}

async function loadedHandles(page: Page) {
  return rowHandles(page).allTextContents();
}

async function scrollUntilLoaded(page: Page, expected: number) {
  for (let i = 0; i < 10; i++) {
    await scrollListToBottom(page);
    if ((await loadedRowCount(page)) >= expected) return;
    await page.waitForTimeout(500);
  }
}

async function seedRoster() {
  const now = Date.now();
  const userRows: Array<{
    id: string;
    username: string;
    displayName: string;
    updatedAt: Date;
  }> = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const id = await generateSnowflakeId();
    seededUserIds.push(id);
    userRows.push({
      id,
      username: seedUsername(i),
      displayName: `F1809 E2E ${String(i).padStart(3, '0')}`,
      updatedAt: new Date(now),
    });
  }
  await db.insert(users).values(userRows);
  const followRows: Array<{
    id: string;
    followerId: string;
    followingId: string;
    createdAt: Date;
  }> = [];
  for (let i = 0; i < userRows.length; i++) {
    followRows.push({
      id: await generateSnowflakeId(),
      followerId: viewerId,
      followingId: userRows[i]!.id,
      createdAt: new Date(now - i * MINUTE_MS),
    });
  }
  await db.insert(follows).values(followRows);
}

async function cleanupRoster() {
  if (seededUserIds.length > 0) {
    await db.delete(follows).where(inArray(follows.followingId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
    seededUserIds.length = 0;
  }
}

test.beforeAll(async ({ browser }) => {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    serverAvailable = response.ok;
  } catch {
    serverAvailable = false;
  }
  if (!serverAvailable) return;

  const context = await browser.newContext();
  const page = await context.newPage();
  session = await installPlaywrightDevAuth(page, BASE_URL);
  viewerId = session.userId;
  // Link the dev user to the Steward identity used by FEED_STEWARD_TEST_TOKEN
  // (userId == viewer id), so a Steward JWT resolves to this same row
  // instead of creating a second user. No-op for dev-server runs.
  await db
    .update(users)
    .set({ stewardId: viewerId })
    .where(eq(users.id, viewerId));
  await page.close();
  await context.close();

  // Drop any seed left by an interrupted run, then seed fresh.
  const stale = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, seedUsername(0)));
  if (stale.length > 0) {
    const staleIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(
          inArray(
            users.username,
            Array.from({ length: SEED_COUNT }, (_, i) => seedUsername(i))
          )
        )
    ).map((row) => row.id);
    if (staleIds.length > 0) {
      await db.delete(follows).where(inArray(follows.followingId, staleIds));
      await db.delete(users).where(inArray(users.id, staleIds));
    }
  }
  await seedRoster();
});

test.afterAll(async () => {
  if (!serverAvailable) return;
  await cleanupRoster();
  await closeDatabase();
});

test('logged-out browsing shows the following list without follow buttons', async ({
  browser,
}) => {
  test.skip(!serverAvailable, 'Server not available');
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const dialog = await openFollowing(page);
    await expect(dialog).toContainText('(150)', { timeout: 30_000 });
    await expect(
      page.getByText(`@${seedUsername(0)}`, { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    // Logged out: no follow/unfollow buttons in the list.
    await expect(
      dialog.getByRole('button', { name: 'Follow', exact: true })
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Following', exact: true })
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('signed-in paging reaches all 150 rows exactly once', async ({ page }) => {
  test.skip(!serverAvailable, 'Server not available');
  await installSignedIn(page);
  const dialog = await openFollowing(page);
  await expect(dialog).toContainText('(150)', { timeout: 30_000 });

  // Scroll until the sentinel loads the second page.
  await scrollUntilLoaded(page, SEED_COUNT);
  const handles = await loadedHandles(page);
  expect(handles).toHaveLength(SEED_COUNT);
  expect(new Set(handles).size).toBe(SEED_COUNT);
  // The 101st row (seed 100) is reachable only past page 1.
  expect(handles).toContain(`@${seedUsername(100)}`);
  expect(handles).toContain(`@${seedUsername(149)}`);
});

test('own unfollow restarts the walk instead of skipping a row', async ({
  page,
}) => {
  test.skip(!serverAvailable, 'Server not available');
  await installSignedIn(page);
  const dialog = await openFollowing(page);
  await expect(dialog).toContainText('(150)', { timeout: 30_000 });

  // Unfollow the first row (seed 000). The handle <p> sits in the row's
  // info div, so its grandparent is the row element holding the button.
  const firstRow = page
    .locator('[role="dialog"] p', { hasText: `@${seedUsername(0)}` })
    .locator('xpath=../..');
  await firstRow
    .getByRole('button', { name: 'Following', exact: true })
    .click();

  // The walk restarts from page 1: total drops to 149, the unfollowed row
  // is gone, and the old 101st row (seed 100) is now inside page 1.
  await expect(dialog).toContainText('(149)', { timeout: 30_000 });
  await expect(
    page.getByText(`@${seedUsername(0)}`, { exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByText(`@${seedUsername(100)}`, { exact: true })
  ).toBeVisible({ timeout: 30_000 });

  // Loading the remaining page still reaches every row exactly once.
  await scrollUntilLoaded(page, SEED_COUNT - 1);
  const handles = await loadedHandles(page);
  expect(handles).toHaveLength(SEED_COUNT - 1);
  expect(new Set(handles).size).toBe(SEED_COUNT - 1);
  expect(handles).not.toContain(`@${seedUsername(0)}`);
});

test('failed page 2 offers a retry in the same open modal', async ({
  page,
}) => {
  test.skip(!serverAvailable, 'Server not available');
  await installSignedIn(page);

  let failedOnce = false;
  await page.route('**/api/users/*/following*', async (route) => {
    const url = new URL(route.request().url());
    if (!failedOnce && url.searchParams.get('page') === '2') {
      failedOnce = true;
      await route.fulfill({ status: 500, body: '{}' });
      return;
    }
    await route.continue();
  });

  const dialog = await openFollowing(page);
  await expect(dialog).toContainText('(149)', { timeout: 30_000 });

  await scrollListToBottom(page);
  await expect(
    dialog.getByText('Failed to load more. Please try again.')
  ).toBeVisible({ timeout: 30_000 });
  // Loaded rows stay visible; the failure is not shown as exhaustion.
  await expect(
    page.getByText(`@${seedUsername(0)}`, { exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByText(`@${seedUsername(99)}`, { exact: true })
  ).toBeVisible();

  await dialog.getByRole('button', { name: 'Try again' }).click();
  await scrollUntilLoaded(page, SEED_COUNT - 1);
  const handles = await loadedHandles(page);
  expect(handles).toHaveLength(SEED_COUNT - 1);
  expect(new Set(handles).size).toBe(SEED_COUNT - 1);
  expect(failedOnce).toBe(true);
});

test('close/reopen and user switch start a fresh walk', async ({ page }) => {
  test.skip(!serverAvailable, 'Server not available');
  await installSignedIn(page);
  const dialog = await openFollowing(page);
  await expect(dialog).toContainText('(149)', { timeout: 30_000 });

  // Close and reopen: a fresh page 1, not the previous scroll position.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const reopened = await openFollowing(page);
  await expect(reopened).toContainText('(149)', { timeout: 30_000 });
  // Seed 000 was unfollowed in the earlier test, so the first row is now
  // seed 001.
  await expect(
    page.getByText(`@${seedUsername(1)}`, { exact: true })
  ).toBeVisible({ timeout: 30_000 });

  // Switch to a different user: no rows from the previous list leak in.
  await page.keyboard.press('Escape');
  await expect(reopened).toBeHidden({ timeout: 30_000 });
  await page.goto(`${BASE_URL}/u/${seedUsername(1)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('button', { name: /Following/ })
    .first()
    .click();
  const otherDialog = page.getByRole('dialog');
  await expect(otherDialog).toBeVisible({ timeout: 30_000 });
  await expect(otherDialog).toContainText('Not following anyone yet', {
    timeout: 30_000,
  });
  await expect(
    otherDialog.locator('p', { hasText: `@${SEED_PREFIX}-` })
  ).toHaveCount(0);
});
