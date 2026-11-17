/** Real route/auth/database coverage for the remaining legacy domain fallback.
 * PRD §7.1 / MVP phase 2 still require removing domain promotion entirely.
 * These cases only verify the narrower interim fix and stored-role precedence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getAdminRole } from '@feed/api';
import { adminRoles, db, inArray, ROLE_PERMISSIONS, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/admins/route';

const runId = crypto.randomUUID().slice(0, 8);
const domain = `admin-${runId}.example`;
const previousDomain = process.env.ADMIN_EMAIL_DOMAIN;
const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
const ownedUsers: string[] = [];
const ownedRoles: string[] = [];

type Fixture = {
  email?: string | null;
  emailVerified?: boolean;
  isAdmin?: boolean;
  isBanned?: boolean;
};

async function createUser(values: Fixture = {}) {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `admin-email-${id}`,
    isTest: true,
    updatedAt: new Date(),
    ...values,
  });
  ownedUsers.push(id);
  return id;
}

async function status(userId?: string) {
  const response = await GET(
    new NextRequest('http://localhost/api/admin/admins', {
      headers: userId ? { authorization: `Bearer steward:test:${userId}` } : {},
    })
  );
  return response.status;
}

beforeAll(() => {
  process.env.ADMIN_EMAIL_DOMAIN = domain;
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
});

afterAll(async () => {
  try {
    if (ownedRoles.length) {
      await db.delete(adminRoles).where(inArray(adminRoles.id, ownedRoles));
    }
    if (ownedUsers.length) {
      await db.delete(users).where(inArray(users.id, ownedUsers));
    }
  } finally {
    if (previousDomain === undefined) delete process.env.ADMIN_EMAIL_DOMAIN;
    else process.env.ADMIN_EMAIL_DOMAIN = previousDomain;
    if (previousTestAuth === undefined) {
      delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    } else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
  }
});

describe('legacy admin email authorization with real database and route', () => {
  test('requires authentication', async () => {
    expect(await status()).toBe(401);
  });

  test('denies an unverified address on the admin domain', async () => {
    const id = await createUser({ email: `alice@${domain}` });
    expect(await getAdminRole(id)).toEqual({ role: null, permissions: [] });
    expect(await status(id)).toBe(403);
  });

  test('does not use a middle @ segment as the domain', async () => {
    const id = await createUser({
      email: `alice@${domain}@other.test`,
      emailVerified: true,
    });
    expect(await getAdminRole(id)).toEqual({ role: null, permissions: [] });
    expect(await status(id)).toBe(403);
  });

  test('retains the existing verified-domain fallback, case-insensitively', async () => {
    const id = await createUser({
      email: `Alice@${domain.toUpperCase()}`,
      emailVerified: true,
    });
    expect(await getAdminRole(id)).toEqual({
      role: 'ADMIN',
      permissions: ROLE_PERMISSIONS.ADMIN,
    });
    expect(await status(id)).toBe(200);
  });

  test('does not promote a verified different domain', async () => {
    const id = await createUser({
      email: `alice-${runId}@other.example`,
      emailVerified: true,
    });
    expect(await status(id)).toBe(403);
  });

  test('keeps explicit isAdmin access without an email', async () => {
    const id = await createUser({ isAdmin: true });
    expect((await getAdminRole(id)).role).toBe('ADMIN');
    expect(await status(id)).toBe(200);
  });

  test('keeps a stored VIEWER role and its explicit permission list', async () => {
    const id = await createUser({
      email: `viewer@${domain}`,
      emailVerified: true,
      isAdmin: true,
    });
    const roleId = await generateSnowflakeId();
    await db.insert(adminRoles).values({
      id: roleId,
      userId: id,
      grantedBy: id,
      role: 'VIEWER',
      permissions: ['view_stats'],
    });
    ownedRoles.push(roleId);
    expect(await getAdminRole(id)).toEqual({
      role: 'VIEWER',
      permissions: ['view_stats'],
    });
    expect(await status(id)).toBe(200);
  });

  test('does not revive a revoked role from an unverified domain email', async () => {
    const id = await createUser({ email: `revoked@${domain}` });
    const roleId = await generateSnowflakeId();
    await db.insert(adminRoles).values({
      id: roleId,
      userId: id,
      grantedBy: id,
      role: 'ADMIN',
      revokedAt: new Date(),
    });
    ownedRoles.push(roleId);
    expect((await getAdminRole(id)).role).toBeNull();
    expect(await status(id)).toBe(403);
  });

  test('denies a banned user even with verified domain and isAdmin', async () => {
    const id = await createUser({
      email: `banned@${domain}`,
      emailVerified: true,
      isAdmin: true,
      isBanned: true,
    });
    expect(await status(id)).toBe(403);
  });
});
