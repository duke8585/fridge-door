import { describe, expect, it } from "vitest";
import { findDuplicates, normalizeSourceUrl, titleSimilarity } from "../shared/duplicates";

describe("normalizeSourceUrl", () => {
  it("ignores scheme, www, host case, trailing slash and tracking parameters", () => {
    const want = "instagram.com/reel/abc?x=1";
    for (const u of ["https://www.instagram.com/reel/abc/?x=1&igsh=zz", "http://Instagram.com/reel/abc?utm_source=ig&x=1", "https://instagram.com/reel/abc?x=1&si=1"]) {
      expect(normalizeSourceUrl(u)).toBe(want);
    }
    expect(normalizeSourceUrl("https://example.com/a")).not.toBe(normalizeSourceUrl("https://example.com/b"));
  });
});

describe("titleSimilarity / findDuplicates", () => {
  it("treats spelling variants as similar and different dishes as different", () => {
    expect(titleSimilarity("Red lentil dal", "red lentil dal!")).toBe(1);
    expect(titleSimilarity("Red lentil dal", "Red lentil dhal")).toBeGreaterThanOrEqual(0.85);
    expect(titleSimilarity("Red lentil dal", "Dal makhani")).toBeLessThan(0.85);
    expect(titleSimilarity("Banana bread", "Banana pancakes")).toBeLessThan(0.85);
  });

  it("returns url matches first by reason and title matches otherwise", () => {
    const existing = [
      { id: "a", title: "Socca", source_url: "https://www.example.com/socca/" },
      { id: "b", title: "Kimchi pancakes" },
      { id: "c", title: "Banana bread" },
    ];
    expect(findDuplicates({ title: "Chickpea flatbread", source_url: "http://example.com/socca" }, existing)).toEqual([
      { id: "a", title: "Socca", source_url: "https://www.example.com/socca/", reason: "same source_url" },
    ]);
    expect(findDuplicates({ title: "Kimchi pancake" }, existing).map((d) => [d.id, d.reason])).toEqual([["b", "similar title"]]);
    expect(findDuplicates({ title: "Pad thai" }, existing)).toEqual([]);
  });
});
