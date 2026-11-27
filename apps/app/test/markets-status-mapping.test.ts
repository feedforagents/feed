// @vitest-environment happy-dom
// spec/markets/prediction.md, "Story: Close on schedule, review, resolve, or cancel"
import { expect, it } from "vitest";
import { toPredictionStatus } from "../src/web/screens/markets-status.ts";

it("server statuses that close a market map out of the active list", () => {
  expect(toPredictionStatus("expired")).toBe("expired");
  expect(toPredictionStatus("awaiting_proof")).toBe("expired");
  expect(toPredictionStatus("manual_hold")).toBe("expired");
  expect(toPredictionStatus("resolved")).toBe("resolved");
  expect(toPredictionStatus("cancelled")).toBe("cancelled");
  expect(toPredictionStatus("open")).toBe("active");
});
