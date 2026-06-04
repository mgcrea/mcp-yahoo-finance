import { describe, expect, it } from "vitest";

import { INTERVALS, PERIODS, periodToRange } from "../src/lib/period";

const NOW = new Date("2024-06-15T12:00:00Z");
const asDate = (epoch: number) => new Date(epoch * 1000).toISOString();

describe("periodToRange", () => {
  it("returns period2 = now in epoch seconds", () => {
    const { period2 } = periodToRange("1mo", NOW);
    expect(period2).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it("subtracts a month for 1mo", () => {
    const { period1 } = periodToRange("1mo", NOW);
    expect(asDate(period1)).toBe("2024-05-15T12:00:00.000Z");
  });

  it("subtracts years for 5y", () => {
    const { period1 } = periodToRange("5y", NOW);
    expect(asDate(period1)).toBe("2019-06-15T12:00:00.000Z");
  });

  it("snaps to local midnight on Jan 1 for ytd", () => {
    const { period1 } = periodToRange("ytd", NOW);
    const d = new Date(period1 * 1000);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
  });

  it("returns epoch 0 for max", () => {
    expect(periodToRange("max", NOW).period1).toBe(0);
  });

  it("exposes the expected period/interval enums", () => {
    expect(PERIODS).toContain("ytd");
    expect(PERIODS).toContain("max");
    expect(INTERVALS).toContain("1d");
    expect(INTERVALS).toContain("1m");
  });
});
