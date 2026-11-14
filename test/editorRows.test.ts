import { describe, expect, it } from "vitest";
import { type DraftSection, deleteEmptyRow, emptyRow, moveRow, type Row, smartSplitRow } from "../src/lib/editorRows";

const row = (key: string, patch: Partial<Row> = {}): Row => ({ ...emptyRow(), key, ...patch });
const sec = (key: string, ...rows: Row[]): DraftSection => ({ key, title: "", rows });
const keys = (s: DraftSection[]): string[][] => s.map((x) => x.rows.map((r) => r.key));

describe("smartSplitRow", () => {
  it("splits a whole line typed into Item", () => {
    expect(smartSplitRow(row("a", { item: "200 g flour, sifted" }))).toEqual(row("a", { qty: "200", unit: "g", item: "flour", prep: "sifted" }));
    expect(smartSplitRow(row("a", { item: "2-3 cloves garlic" }))).toMatchObject({ key: "a", qty: "2", qtyMax: "3", unit: "clove", item: "garlic" });
    expect(smartSplitRow(row("a", { item: "salt (to taste)" }))).toMatchObject({ item: "salt", note: "to taste", qty: "" });
  });
  it("leaves plain items and rows that already have a qty alone", () => {
    expect(smartSplitRow(row("a", { item: "flour" }))).toBeUndefined();
    expect(smartSplitRow(row("a", { qty: "1", item: "200 g flour" }))).toBeUndefined();
    expect(smartSplitRow(row("a", { unit: "g", item: "200 flour" }))).toBeUndefined();
  });
  it("keeps prep typed in its own field", () => {
    expect(smartSplitRow(row("a", { item: "200 g butter", prep: "soft" }))).toMatchObject({ qty: "200", item: "butter", prep: "soft" });
  });
});

describe("moveRow", () => {
  const s = () => [sec("s1", row("a"), row("b")), sec("s2", row("c"))];
  it("moves within a section", () => {
    const r = moveRow(s(), { si: 0, ri: 0 }, 1)!;
    expect(keys(r.sections)).toEqual([["b", "a"], ["c"]]);
    expect(r.at).toEqual({ si: 0, ri: 1 });
  });
  it("hops into the next section at the bottom edge", () => {
    const r = moveRow(s(), { si: 0, ri: 1 }, 1)!;
    expect(keys(r.sections)).toEqual([["a"], ["b", "c"]]);
    expect(r.at).toEqual({ si: 1, ri: 0 });
  });
  it("hops into the previous section at the top edge, leaving an empty row behind", () => {
    const r = moveRow(s(), { si: 1, ri: 0 }, -1)!;
    expect(r.sections[0]!.rows.map((x) => x.key)).toEqual(["a", "b", "c"]);
    expect(r.sections[1]!.rows).toHaveLength(1);
    expect(r.at).toEqual({ si: 0, ri: 2 });
  });
  it("does nothing at the very top", () => expect(moveRow(s(), { si: 0, ri: 0 }, -1)).toBeUndefined());
});

describe("deleteEmptyRow", () => {
  it("deletes an empty row and focuses the previous one", () => {
    const r = deleteEmptyRow([sec("s1", row("a", { item: "x" }), row("b"), row("c", { item: "y" }))], { si: 0, ri: 1 })!;
    expect(keys(r.sections)).toEqual([["a", "c"]]);
    expect(r.focus).toBe("a");
  });
  it("focuses the previous section's last row from the first row of a section", () => {
    const r = deleteEmptyRow([sec("s1", row("a", { item: "x" })), sec("s2", row("b"), row("c", { item: "y" }))], { si: 1, ri: 0 })!;
    expect(keys(r.sections)).toEqual([["a"], ["c"]]);
    expect(r.focus).toBe("a");
  });
  it("focuses the next row when deleting the first row", () => {
    const r = deleteEmptyRow([sec("s1", row("a"), row("b", { item: "x" }))], { si: 0, ri: 0 })!;
    expect(r.focus).toBe("b");
  });
  it("keeps a section's only row but moves focus back", () => {
    const r = deleteEmptyRow([sec("s1", row("a", { item: "x" })), sec("s2", row("b"))], { si: 1, ri: 0 })!;
    expect(keys(r.sections)).toEqual([["a"], ["b"]]);
    expect(r.focus).toBe("a");
  });
  it("ignores non-empty rows and the only row overall", () => {
    expect(deleteEmptyRow([sec("s1", row("a", { item: "x" }), row("b"))], { si: 0, ri: 0 })).toBeUndefined();
    expect(deleteEmptyRow([sec("s1", row("a"))], { si: 0, ri: 0 })).toBeUndefined();
  });
});
