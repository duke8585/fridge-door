import { describe, expect, it } from "vitest";
import { isSafeHref, renderMarkdown, renderMarkdownInline } from "../src/lib/markdown";

describe("markdown link sanitizing", () => {
  it.each([
    "[x](javascript:alert(1))",
    "[x](JavaScript:alert(1))",
    "[x](  javascript:alert(1))",
    "[x](jav&#x61;script:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox(1))",
    "<javascript:alert(1)>",
    "[x][r]\n\n[r]: javascript:alert(1)",
    "![i](javascript:alert(1))",
  ])("neutralizes %j", (src) => {
    for (const html of [renderMarkdown(src), renderMarkdownInline(src)]) {
      expect(html).not.toMatch(/(href|src)="[^"#]*script/i);
      expect(html).not.toMatch(/(href|src)="data:/i);
    }
    expect(renderMarkdown(src)).not.toMatch(/javascript:alert\(1\)"/i);
  });
  it("renders a javascript: link as an inert # link", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).toContain('<a href="#">x</a>');
  });
  it.each([
    ["[a](https://example.com/x?y=1)", 'href="https://example.com/x?y=1"'],
    ["[a](http://example.com)", 'href="http://example.com"'],
    ["[a](mailto:me@example.com)", 'href="mailto:me@example.com"'],
    ["[a](/recipes/pancakes)", 'href="/recipes/pancakes"'],
    ["[a](other/page)", 'href="other/page"'],
    ["[a](#notes)", 'href="#notes"'],
  ])("keeps %j", (src, want) => expect(renderMarkdown(src)).toContain(want));
  it("still escapes raw HTML", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain("<img");
  });
  it("isSafeHref", () => {
    expect(isSafeHref("javascript:x")).toBe(false);
    expect(isSafeHref("a/b:c")).toBe(true);
    expect(isSafeHref("?q=1")).toBe(true);
  });
});
