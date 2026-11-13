import { describe, expect, it } from "vitest";
import { ago } from "../src/lib/ago";

const now = Date.parse("2026-11-13T12:00:00.000Z");
const before = (ms: number): string => new Date(now - ms).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe("ago", () => {
  it("names the largest whole unit", () => {
    expect(ago(before(30 * 1000), now)).toBe("just now");
    expect(ago(before(5 * MIN), now)).toBe("5 min ago");
    expect(ago(before(3 * H + 59 * MIN), now)).toBe("3 h ago");
    expect(ago(before(2 * D + 5 * H), now)).toBe("2 d ago");
    expect(ago(before(65 * D), now)).toBe("2 mo ago");
    expect(ago(before(800 * D), now)).toBe("2 y ago");
  });
  it("a time ahead of this clock is just now", () => {
    expect(ago(before(-5 * MIN), now)).toBe("just now");
  });
});
