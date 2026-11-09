import { describe, expect, it } from "vitest";
import { TimeSchema } from "../shared/schema";
import { formatTime, matchesTimeFilter } from "../shared/time";

describe("time", () => {
  it("formats total and active", () => {
    expect(formatTime({ total_min: 45, active_min: 20 })).toBe("45 min (20 active)");
    expect(formatTime({ total_min: 90 })).toBe("1 h 30 min");
    expect(formatTime({ total_min: 720, active_min: 75 })).toBe("12 h (1 h 15 min active)");
  });
  it("filters by total time; recipes without time match only 'all'", () => {
    expect(matchesTimeFilter({ total_min: 15 }, "15")).toBe(true);
    expect(matchesTimeFilter({ total_min: 16 }, "15")).toBe(false);
    expect(matchesTimeFilter({ total_min: 60 }, "60")).toBe(true);
    expect(matchesTimeFilter({ total_min: 60 }, "longer")).toBe(false);
    expect(matchesTimeFilter({ total_min: 61 }, "longer")).toBe(true);
    expect(matchesTimeFilter(undefined, "longer")).toBe(false);
    expect(matchesTimeFilter(undefined, null)).toBe(true);
  });
  it("validates", () => {
    expect(TimeSchema.safeParse({ total_min: 10, active_min: 11 }).success).toBe(false);
    expect(TimeSchema.safeParse({ total_min: 7 * 24 * 60 + 1 }).success).toBe(false);
    expect(TimeSchema.safeParse({ total_min: 10, active_min: 10 }).success).toBe(true);
  });
});
