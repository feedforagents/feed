// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadAdminReports } from "../src/web/store-auth.ts";
import { installDeferredFetchQueue, jsonResponse } from "./deferred-fetch.ts";

const adminViewer = {
  accountId: "admin-1",
  handle: "admin",
  displayName: "Admin",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: null,
  phoneVerifiedAt: null,
  emailMasked: null,
  emailVerifiedAt: null,
  uiMode: "game" as const,
  balanceCents: 0,
  startingGrantCents: 0,
  isAdmin: true,
  isReviewer: false,
  agentGrant: null,
};

const openReportsKey = "GET /api/admin/reports?status=open&limit=50";
const reportOne = { id: "report-1", reporterHandle: "alice", targetKind: "post", targetId: "post-9", reason: "spam", status: "open" };
const reportTwo = { id: "report-2", reporterHandle: "bob", targetKind: "post", targetId: "post-10", reason: "abuse", status: "open" };

function seedAdmin(): void {
  setStoreState({ viewer: adminViewer, adminReports: [], adminTabLoading: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, adminReports: [], adminTabLoading: false });
});

describe("admin reports load race", () => {
  it('stale response started before a resolve must not resurrect the resolved report (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const queue = installDeferredFetchQueue();
    const refresh = loadAdminReports("open");
    const reload = loadAdminReports("open");
    queue.resolveNewest(openReportsKey, jsonResponse([]));
    await reload;
    expect(getStoreSnapshot().adminReports.map((r) => r.id)).toEqual([]);
    queue.resolveOldest(openReportsKey, jsonResponse([reportOne]));
    await refresh;
    expect(getStoreSnapshot().adminReports.map((r) => r.id)).toEqual([]);
    expect(getStoreSnapshot().adminTabLoading).toBe(false);
  });

  it('superseded response is dropped and the newest response applies (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const queue = installDeferredFetchQueue();
    const first = loadAdminReports("open");
    const second = loadAdminReports("open");
    queue.resolveOldest(openReportsKey, jsonResponse([reportOne]));
    await first;
    expect(getStoreSnapshot().adminReports.map((r) => r.id)).toEqual([]);
    queue.resolveNewest(openReportsKey, jsonResponse([reportOne, reportTwo]));
    await second;
    expect(getStoreSnapshot().adminReports.map((r) => r.id)).toEqual(["report-1", "report-2"]);
    expect(getStoreSnapshot().adminTabLoading).toBe(false);
  });
});
