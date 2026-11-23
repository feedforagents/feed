/**
 * FollowListModal E2E: profile follow lists page past 100 rows, restart
 * after an own unfollow, and recover from a failed later page.
 *
 * Run against a loopback Next server and a positively identified disposable
 * PostgreSQL database. The server and spec must share DATABASE_URL and
 * STEWARD_JWT_SECRET. Locally, use a freshly created feed_pr<digits> database
 * and the same URL for DIRECT_DATABASE_URL.
 *
 * The roster contains 150 run-owned follows. Seed 100 is the first row
 * beyond the initial page and the row a stale offset skips after unfollow.
 */

import assert from 'node:assert/strict';
import { closeDatabase, db, eq, follows, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { expect, type Page, test } from '@playwright/test';
import { SignJWT } from 'jose';
import { assertDisposableAgentFollowDatabase } from '../integration/helpers/agent-follow-database';
import { PLAYWRIGHT_DEV_AUTH_STORAGE_KEY } from './dev-auth';

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
const VIEWER_USERNAME = `${SEED_PREFIX}-viewer`;
const VIEWER_PROFILE = `/u/${VIEWER_USERNAME}`;

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use({ storageState: { cookies: [], origins: [] } });

let viewerId = '';
// Hold ONLY ids an INSERT ... RETURNING below actually returned, so
// cleanup never deletes a row this run did not write.
const seededUserIds: string[] = [];
const seededFollowIds: string[] = [];
const seedUsername = (i: number) =>
  `${SEED_PREFIX}-${String(i).padStart(3, '0')}`;

async function showFollowList(page: Page, name: 'Following' | 'Followers') {
  await page
    .getByRole('button', { name: new RegExp(`${name}$`) })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

async function openFollowing(page: Page) {
  await page.goto(`${BASE_URL}${VIEWER_PROFILE}`, {
    waitUntil: 'domcontentloaded',
  });
  return showFollowList(page, 'Following');
}

async function installSignedIn(page: Page) {
  const secret = process.env.STEWARD_JWT_SECRET;
  assert.ok(
    secret && viewerId,
    'Owned viewer and Steward signing fixture required'
  );
  const accessToken = await new SignJWT({ userId: viewerId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([
    {
      name: 'steward-token',
      value: accessToken,
      url: BASE_URL,
      sameSite: 'Lax',
    },
  ]);
  await page.addInitScript(
    ({ storageKey, authSession }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(authSession));
      window.localStorage.setItem(
        'feed-game-guide-completed',
        JSON.stringify({ [authSession.userId]: true })
      );
    },
    {
      storageKey: PLAYWRIGHT_DEV_AUTH_STORAGE_KEY,
      authSession: {
        userId: viewerId,
        accessToken,
        displayName: 'Follow list viewer',
      },
    }
  );
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
  await expect
    .poll(
      async () => {
        await scrollListToBottom(page);
        return loadedRowCount(page);
      },
      { timeout: 30_000 }
    )
    .toBe(expected);
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

test.beforeAll(async () => {
  const target = new URL(BASE_URL);
  assert.ok(
    ['http:', 'https:'].includes(target.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
      !target.username &&
      !target.password,
    'Follow-list browser tests require a loopback web server'
  );
  await assertDisposableAgentFollowDatabase();
  const response = await fetch(`${BASE_URL}/api/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  assert.ok(response.ok, 'Follow-list web server is unavailable');

  const id = await generateSnowflakeId();
  const now = new Date();
  const [viewer] = await db
    .insert(users)
    .values({
      id,
      stewardId: id,
      username: VIEWER_USERNAME,
      displayName: 'Follow list viewer',
      bio: 'Owned browser fixture',
      profileComplete: true,
      hasUsername: true,
      hasBio: true,
      profileSetupCompletedAt: now,
      tosAccepted: true,
      tosAcceptedAt: now,
      privacyPolicyAccepted: true,
      privacyPolicyAcceptedAt: now,
      gameGuideCompletedAt: now,
      updatedAt: now,
    })
    .returning({ id: users.id });
  assert.ok(viewer, 'Viewer insert returned no row');
  viewerId = viewer.id;
  seededUserIds.push(viewer.id);
  await seedRoster();
});

test.afterAll(async () => {
  await cleanupRoster();
  await closeDatabase();
});

test('logged-out browsing shows the following list without follow buttons', async ({
  browser,
}) => {
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
  await installSignedIn(page);
  const dialog = await openFollowing(page);
  await expect(rowHandles(page)).toHaveCount(100, { timeout: 30_000 });
  const initialTotal = (await dialog.innerText()).includes('(150)');

  // Scroll before checking the initial badge so the same recording
  // shows whether row 101 was reachable on each revision.
  await scrollUntilLoaded(page, SEED_COUNT);
  const handles = await loadedHandles(page);
  expect(handles).toHaveLength(SEED_COUNT);
  expect(initialTotal).toBe(true);
  expect(new Set(handles).size).toBe(SEED_COUNT);
  // The 101st row (seed 100) is reachable only past page 1.
  expect(handles).toContain(`@${seedUsername(100)}`);
  expect(handles).toContain(`@${seedUsername(149)}`);
});

test('own unfollow restarts the walk instead of skipping a row', async ({
  page,
}) => {
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
  await installSignedIn(page);
  const dialog = await openFollowing(page);
  await expect(dialog).toContainText('(149)', { timeout: 30_000 });

  // Close and reopen: a fresh page 1, not the previous scroll position.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const reopened = await showFollowList(page, 'Following');
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
  await installSignedIn(page);

  // Hold the DELETE /follow response so the mutation resolves only after
  // the modal has switched to Followers.
  let releaseDelete!: () => void;
  const deleteHeld = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteSeen = false;
  let followerLoads = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/followers') && url.searchParams.get('page')) {
      followerLoads++;
    }
  });
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
    const followersDialog = await showFollowList(page, 'Followers');
    await expect(
      followersDialog.locator('#follow-list-modal-title')
    ).toHaveText('Followers', { timeout: 30_000 });
    await expect(followersDialog).toContainText('No followers yet');
    const loadsBeforeDelete = followerLoads;
    const completed = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname.endsWith('/follow')
    );

    // The profile's updated count proves the real response reached its
    // original callback while the same mounted profile shows Followers.
    releaseDelete();
    expect((await completed).ok()).toBe(true);
    await expect(
      page.getByRole('button', { name: /^148\s*Following$/ })
    ).toBeVisible({ timeout: 30_000 });
    expect(followerLoads).toBe(loadsBeforeDelete);
    await expect(
      followersDialog.locator('#follow-list-modal-title')
    ).toHaveText('Followers');
    await expect(followersDialog).toContainText('No followers yet');
    await expect(
      followersDialog.locator('p', { hasText: `@${SEED_PREFIX}-` })
    ).toHaveCount(0);
  } finally {
    releaseDelete();
  }
});

test('failed insert registers no ownership and preserves existing rows', async () => {
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
