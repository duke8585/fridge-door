import { describe, expect, it } from "vitest";
import { DEFAULT_FOCUS, MAX_COVER_BYTES, coverFileProblem, focusPosition, parseFocusParam, pointToFocus } from "../shared/cover";

describe("pointToFocus (pointer over the rendered image -> percent)", () => {
  const box = { left: 100, top: 50, width: 400, height: 200 };
  it("maps corners, center and an inner point relative to the image box", () => {
    expect(pointToFocus(100, 50, box)).toEqual({ x: 0, y: 0 });
    expect(pointToFocus(500, 250, box)).toEqual({ x: 100, y: 100 });
    expect(pointToFocus(300, 150, box)).toEqual({ x: 50, y: 50 });
    expect(pointToFocus(200, 200, box)).toEqual({ x: 25, y: 75 });
  });
  it("clamps a drag that leaves the image", () => {
    expect(pointToFocus(-20, 900, box)).toEqual({ x: 0, y: 100 });
    expect(pointToFocus(9999, 0, box)).toEqual({ x: 100, y: 0 });
  });
  it("rounds to 0.1 %", () => {
    expect(pointToFocus(100 + 400 / 3, 50 + 200 / 7, box)).toEqual({ x: 33.3, y: 14.3 });
  });
  it("falls back to the default for an unlaid-out (zero-size) image", () => {
    expect(pointToFocus(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual(DEFAULT_FOCUS);
  });
});

describe("focus helpers", () => {
  it("object-position uses the default when unset", () => {
    expect(focusPosition(null)).toBe("50% 40%");
    expect(focusPosition(undefined)).toBe("50% 40%");
    expect(focusPosition({ x: 12.5, y: 0 })).toBe("12.5% 0%");
  });
  it("parses the upload query param", () => {
    expect(parseFocusParam("30,20.5")).toEqual({ x: 30, y: 20.5 });
    expect(parseFocusParam("30")).toBeUndefined();
    expect(parseFocusParam("-1,2")).toBeUndefined();
  });
});

describe("coverFileProblem (client-side check before staging a cover)", () => {
  it("accepts the raster types the server accepts, up to 10 MiB", () => {
    expect(coverFileProblem({ type: "image/png", size: 1 })).toBeUndefined();
    expect(coverFileProblem({ type: "image/jpeg", size: MAX_COVER_BYTES })).toBeUndefined();
  });
  it("rejects SVG, unknown types, oversized and empty files with a message", () => {
    expect(coverFileProblem({ type: "image/svg+xml", size: 10 })).toMatch(/JPEG, PNG/);
    expect(coverFileProblem({ type: "", size: 10 })).toMatch(/unknown type/);
    expect(coverFileProblem({ type: "image/png", size: MAX_COVER_BYTES + 1 })).toMatch(/larger than 10 MB/);
    expect(coverFileProblem({ type: "image/png", size: 0 })).toMatch(/empty/);
  });
});
