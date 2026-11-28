// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, expect, it, vi } from "vitest";
import { formatTimeLabel } from "../src/web/types.ts";

afterEach(() => vi.restoreAllMocks());

it("a label older than a day uses the local calendar date, not the UTC one", () => {
  const ms = Date.UTC(2026, 8, 30, 15, 5);
  vi.spyOn(Date.prototype, "getFullYear").mockReturnValue(2026);
  vi.spyOn(Date.prototype, "getMonth").mockReturnValue(9);
  vi.spyOn(Date.prototype, "getDate").mockReturnValue(1);
  expect(formatTimeLabel(ms)).toBe("2026-10-01");
});

it("a label older than a day is unchanged when the local date matches UTC", () => {
  const ms = Date.UTC(2026, 8, 30, 15, 5);
  vi.spyOn(Date.prototype, "getFullYear").mockReturnValue(2026);
  vi.spyOn(Date.prototype, "getMonth").mockReturnValue(8);
  vi.spyOn(Date.prototype, "getDate").mockReturnValue(30);
  expect(formatTimeLabel(ms)).toBe("2026-09-30");
});
