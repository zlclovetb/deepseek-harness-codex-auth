import assert from "node:assert/strict";
import test from "node:test";
import { parseUsage } from "../lib/probe.js";

const NOW = 1_700_000_000_000;

/**
 * The shape the backend really serves for an account whose 5-hour window is not
 * currently running: the weekly window is named `primary_window` and the
 * secondary slot is null. Captured from the live endpoint.
 */
const WEEKLY_ONLY = {
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 37, limit_window_seconds: 604_800, reset_at: 1_792_478_014 },
    secondary_window: null
  }
};

test("a weekly window sent as `primary_window` fills the weekly slot", () => {
  const quota = parseUsage(WEEKLY_ONLY, NOW);
  // The names are positional, so the 604800-second window must not be shown as
  // the 5-hour one: the panel would then print a weekly reading under "5 小时窗口".
  assert.equal(quota.primaryUsedPercent, undefined);
  assert.equal(quota.primaryResetsAt, undefined);
  assert.equal(quota.secondaryUsedPercent, 37);
  assert.equal(quota.secondaryWindowMinutes, 10_080);
});

test("both windows land in their own slots whatever the payload's order", () => {
  const quota = parseUsage({
    rate_limit: {
      secondary_window: { used_percent: 44, limit_window_seconds: 604_800, reset_after_seconds: 448_153 },
      primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000 }
    }
  }, NOW);
  assert.equal(quota.primaryUsedPercent, 0);
  assert.equal(quota.primaryWindowMinutes, 300);
  assert.equal(quota.primaryResetsAt, NOW + 18_000_000);
  assert.equal(quota.secondaryUsedPercent, 44);
  assert.equal(quota.secondaryWindowMinutes, 10_080);
});

test("a lone 5-hour window leaves the weekly slot empty", () => {
  const quota = parseUsage({
    rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 3600 } }
  }, NOW);
  assert.equal(quota.primaryUsedPercent, 12);
  assert.equal(quota.primaryResetsAt, NOW + 3_600_000);
  assert.equal(quota.secondaryUsedPercent, undefined);
});

test("windows that declare no length still rank shortest first", () => {
  const quota = parseUsage({ rate_limit: { first: { used_percent: 5 }, second: { used_percent: 60 } } }, NOW);
  assert.equal(quota.primaryUsedPercent, 5);
  assert.equal(quota.secondaryUsedPercent, 60);
});

test("a payload with no windows reads as no reading", () => {
  assert.equal(parseUsage({ rate_limit: { allowed: true, primary_window: null } }, NOW), undefined);
});
