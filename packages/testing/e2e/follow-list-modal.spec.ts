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
 * Seed ownership: names are run-scoped, so one run never adopts rows left
 * by an interrupted run; ids enter the cleanup lists only after a
 * successful INSERT ... RETURNING, so cleanup deletes only rows this run
 * actually wrote. A colliding setup fails before writing anything.
 * The seed writes into the same local database the dev server reads (the
 * server must see the roster), so beforeAll refuses a non-loopback
 * DATABASE_URL instead of asserting a separate test-database name.
 *
 * Run with: bunx playwright test follow-list-modal.spec.ts --config packages/testing/playwright.config.ts
 */

import assert from 'node:assert/strict';
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
// Run-scoped seed names: a fixed prefix would let one run adopt (and
// delete) rows left by an interrupted run. The random suffix makes this
// run's rows unique to it.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const SEED_PREFIX = `f1809-e2e-${RUN_ID}`;
const MINUTE_MS = 60 * 1000;

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.setTimeout(180_000);

let serverAvailable = false;
let session: BrowserDevAuthSession | null = null;
let viewerId = '';
// Hold ONLY ids an INSERT ... RETURNING below actually returned, so
// cleanup never deletes a row this run did not write.
const seededUserIds: string[] = [];
const seededFollowIds: string[] = [];
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

async function openFollowers(
  page: Page,
  profilePath = '/u/playwright-dev-admin'
) {
  await page.goto(`${BASE_URL}${profilePath}`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('button', { name: /Followers/ })
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
    userRows.push({
      id: await generateSnowflakeId(),
      username: seedUsername(i),
      displayName: `F1809 E2E ${String(i).padStart(3, '0')}`,
      updatedAt: new Date(now),
    });
  }
  // Collision control: fail before writing anything if any generated id
  // or username is already present, so cleanup can only ever delete rows
  // this run created. A failed or partial setup registers no ownership.
  const clashingUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(
        users.id,
        userRows.map((row) => row.id)
      )
    );
  assert.equal(clashingUsers.length, 0, 'seed user ids already exist');
  const clashingNames = await db
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(
        users.username,
        userRows.map((row) => row.username)
      )
    );
  assert.equal(clashingNames.length, 0, 'seed usernames already exist');
  // Register ONLY the ids the database actually returned. A thrown or
  // short insert registers nothing, so cleanup never assumes rows it
  // never wrote.
  const insertedUsers = await db
    .insert(users)
    .values(userRows)
    .returning({ id: users.id });
  assert.deepEqual(
    insertedUsers.map((row) => row.id).sort(),
    userRows.map((row) => row.id).sort(),
    'seed users partial insert'
  );
  seededUserIds.push(...insertedUsers.map((row) => row.id));

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
  const clashingFollows = await db
    .select({ id: follows.id })
    .from(follows)
    .where(
      inArray(
        follows.id,
        followRows.map((row) => row.id)
      )
    );
  assert.equal(clashingFollows.length, 0, 'seed follow ids already exist');
  const insertedFollows = await db
    .insert(follows)
    .values(followRows)
    .returning({ id: follows.id });
  assert.deepEqual(
    insertedFollows.map((row) => row.id).sort(),
    followRows.map((row) => row.id).sort(),
    'seed follows partial insert'
  );
  seededFollowIds.push(...insertedFollows.map((row) => row.id));
}

async function cleanupRoster() {
  // Delete ONLY rows this run inserted (ids the inserts actually
  // returned). Unrelated followers of the seeded users, and any rows a
  // previous run left behind, are never matched here and survive.
  if (seededFollowIds.length > 0) {
    await db.delete(follows).where(inArray(follows.id, seededFollowIds));
    seededFollowIds.length = 0;
  }
  if (seededUserIds.length > 0) {
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
  // The seed writes into the same local database the dev server reads,
  // so the server can see the roster. Refuse a non-loopback destination:
  // this fixture must never write to a remote or production database.
  // (No separate test-database name is asserted: the dev server's local
  // database is the destination by design, and run-scoped names plus
  // RETURNING ownership are what keep other rows safe in it.)
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname),
    `refusing non-local DATABASE_URL host: ${databaseUrl.hostname}`
  );

  await page.close();
  await context.close();

  // No adoption of rows from earlier runs: seed names are run-scoped, so
  // leftovers keep names this run never matches, and cleanup only ever
  // deletes ids this run's own inserts returned.
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

test('late unfollow completion does not write to the switched list', async ({
  page,
}) => {
  test.skip(!serverAvailable, 'Server not available');
  await installSignedIn(page);

  // Hold the DELETE /follow response so the mutation resolves only after
  // the modal has switched to Followers.
  let releaseDelete!: () => void;
  const deleteHeld = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteSeen = false;
  await page.route('**/api/users/*/follow', async (route) => {
    if (route.request().method() === 'DELETE') {
      deleteSeen = true;
      await deleteHeld;
    }
    await route.continue();
  });

  try {
    const dialog = await openFollowing(page);
    await expect(dialog).toContainText(/\(\d+\)/, { timeout: 30_000 });

    // Unfollow the first row; the DELETE stays held.
    const firstRow = page
      .locator('[role="dialog"] p', { hasText: `@${SEED_PREFIX}-` })
      .first()
      .locator('xpath=../..');
    await firstRow
      .getByRole('button', { name: 'Following', exact: true })
      .click();
    await expect.poll(() => deleteSeen).toBe(true);

    // Switch lists while the mutation is still in flight: close
    // Following and open Followers. Capture the Followers list as shown
    // before the delayed response is released.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const followersDialog = await openFollowers(page);
    await expect(
      followersDialog.locator('#follow-list-modal-title')
    ).toHaveText('Followers', { timeout: 30_000 });
    await expect(followersDialog).toContainText(/\(\d+\)/, {
      timeout: 30_000,
    });
    await page.waitForTimeout(500);
    const followersBefore = await followersDialog.textContent();

    // Release the delayed unfollow: on the old code the stale completion
    // restarts the Following walk and writes Following rows under the
    // Followers heading; with the fix the Followers list is untouched.
    releaseDelete();
    await page.waitForTimeout(2000);
    expect(await followersDialog.textContent()).toBe(followersBefore);
    await expect(
      followersDialog.locator('#follow-list-modal-title')
    ).toHaveText('Followers');
    await expect(
      followersDialog.locator('p', { hasText: `@${SEED_PREFIX}-` })
    ).toHaveCount(0);
  } finally {
    releaseDelete();
  }
});

test('failed insert registers no ownership and preserves existing rows', async () => {
  test.skip(!serverAvailable, 'Server not available');
  // A pre-existing row this run did not seed as roster data, plus a
  // follow pointing at it: both must survive a failed insert, and the
  // failed insert must register no ownership for cleanup.
  const canaryId = await generateSnowflakeId();
  const canaryUsername = `${SEED_PREFIX}-canary`;
  const [canary] = await db
    .insert(users)
    .values({
      id: canaryId,
      username: canaryUsername,
      displayName: 'F1809 E2E canary',
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  assert.ok(canary, 'canary insert returned no row');
  const canaryFollowId = await generateSnowflakeId();
  await db.insert(follows).values({
    id: canaryFollowId,
    followerId: viewerId,
    followingId: canaryId,
    createdAt: new Date(),
  });
  try {
    // Colliding insert: username is unique, so this must fail, and the
    // failed id must never enter the cleanup lists.
    const collidingId = await generateSnowflakeId();
    let failed = false;
    try {
      await db.insert(users).values({
        id: collidingId,
        username: canaryUsername,
        displayName: 'F1809 E2E collision',
        updatedAt: new Date(),
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(seededUserIds).not.toContain(collidingId);
    expect(seededUserIds).not.toContain(canaryId);
    expect(seededFollowIds).not.toContain(canaryFollowId);
    // The pre-existing rows survive untouched.
    const [keptUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, canaryId));
    expect(keptUser?.username).toBe(canaryUsername);
    const [keptFollow] = await db
      .select()
      .from(follows)
      .where(eq(follows.id, canaryFollowId));
    expect(keptFollow?.followingId).toBe(canaryId);
  } finally {
    await db.delete(follows).where(eq(follows.id, canaryFollowId));
    await db.delete(users).where(eq(users.id, canaryId));
  }
});
