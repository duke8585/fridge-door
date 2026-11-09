import { describe, expect, it } from "vitest";
import { extractPage, findJsonLdRecipe, readableText } from "../../worker/extract";
import { checkTarget, isPrivateHost } from "../../worker/pageFetch";
import { cleanTitle } from "../../worker/urlImport";

const PAGE = "https://cook.example/dal/";
const ld = (data: unknown): string => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

describe("JSON-LD extraction", () => {
  it("finds the Recipe inside @graph and renders HowToSections with their names", () => {
    const html = `<html><head>
      <meta content="https://cdn.cook.example/dal.jpg" property="og:image">
      ${ld({ "@context": "https://schema.org", "@type": "WebSite", name: "Cook" })}
      ${ld({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Cook" },
          {
            "@type": ["Recipe", "NewsArticle"],
            name: "Red lentil dal &amp; rice",
            recipeYield: ["4", "4 servings"],
            totalTime: "PT45M",
            recipeIngredient: ["1 cup red lentils", "2 cloves garlic, minced"],
            recipeInstructions: [
              { "@type": "HowToSection", name: "Dal", itemListElement: [{ "@type": "HowToStep", text: "Rinse the lentils." }, { "@type": "HowToStep", text: "Simmer <b>20 min</b>." }] },
              { "@type": "HowToSection", name: "Tadka", itemListElement: [{ "@type": "HowToStep", text: "Fry the garlic." }] },
            ],
          },
        ],
      })}
    </head><body><nav>Home</nav></body></html>`;
    const out = extractPage(html, PAGE);
    expect(out.kind).toBe("json-ld");
    if (out.kind !== "json-ld") return;
    expect(out.text).toContain("Title: Red lentil dal & rice");
    expect(out.text).toContain("Yield: 4 / 4 servings");
    expect(out.text).toContain("Total time: PT45M");
    expect(out.text).toContain("Ingredients:\n- 1 cup red lentils\n- 2 cloves garlic, minced");
    expect(out.text).toContain("Instructions:\nDal:\n1. Rinse the lentils.\n2. Simmer 20 min .\nTadka:\n3. Fry the garlic.");
    expect(out.meta.image).toBe("https://cdn.cook.example/dal.jpg");
  });

  it("takes the JSON-LD image when there is no og:image, and skips broken blocks", () => {
    const html = `<script type="application/ld+json">{ not json</script>${ld([{ "@type": "Recipe", name: "Socca", image: [{ url: "/img/socca.jpg" }], recipeInstructions: "<p>Whisk.</p><p>Bake.</p>" }])}`;
    const out = extractPage(html, PAGE);
    expect(out.kind).toBe("json-ld");
    if (out.kind !== "json-ld") return;
    expect(out.meta.image).toBe("https://cook.example/img/socca.jpg");
    expect(out.text).toContain("Instructions:\n1. Whisk.\n2. Bake.");
  });

  it("returns undefined without a Recipe", () => {
    expect(findJsonLdRecipe(ld({ "@type": "Article", name: "x" }))).toBeUndefined();
  });
});

describe("readable text fallback", () => {
  const filler = "Simmer the lentils with turmeric until soft, then season. ".repeat(10);

  it("uses the article, drops scripts, nav, footer and comments", () => {
    const html = `<html><head><title>Dal | Blog</title><script>var tracking = "SECRET";</script><style>.x{}</style></head><body>
      <nav>Home Recipes About</nav><header>Subscribe!</header>
      <article><h1>Dal</h1><ul><li>200 g red lentils</li><li>1 onion</li></ul><p>${filler}</p><!-- ad slot --></article>
      <aside>Popular posts</aside><footer>(c) Blog</footer></body></html>`;
    const out = extractPage(html, PAGE);
    expect(out.kind).toBe("text");
    if (out.kind !== "text") return;
    expect(out.text.startsWith("Dal\n- 200 g red lentils\n- 1 onion\nSimmer")).toBe(true);
    for (const gone of ["SECRET", "Home Recipes", "Subscribe", "Popular posts", "(c) Blog", "ad slot"]) expect(out.text).not.toContain(gone);
    expect(out.meta.title).toBe("Dal | Blog");
  });

  it("caps the text at 30k characters", () => {
    expect(readableText(`<main><p>${"word ".repeat(20_000)}</p></main>`).length).toBe(30_000);
  });

  it("reports no recipe text for a login wall", () => {
    const out = extractPage(`<html><head><meta property="og:title" content="Log in"></head><body><p>Log in to continue</p></body></html>`, PAGE);
    expect(out.kind).toBe("none");
  });
});

describe("fetch policy helpers", () => {
  it("flags private and local hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "[::1]", "fd00::1", "nas.local", "router", "0.0.0.0"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]"]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("accepts http(s) on default ports only", () => {
    expect(checkTarget("ftp://example.com/x")).toMatchObject({ ok: false, failure: "invalid_url" });
    expect(checkTarget("https://example.com:8443/x")).toMatchObject({ ok: false, failure: "blocked" });
    expect(checkTarget("http://2130706433/")).toMatchObject({ ok: false, failure: "blocked" });
    expect(checkTarget("http://example.com/recipe")).toMatchObject({ ok: true });
  });
});

describe("titles", () => {
  it("cleans platform titles", () => {
    expect(cleanTitle('Chef Anna on Instagram: "Crispy chickpea bowl 🥗 #vegan #easy\nRecipe below"', "https://www.instagram.com/p/x")).toBe("Crispy chickpea bowl");
    expect(cleanTitle("Best socca ever | TikTok", "https://www.tiktok.com/@a/video/1")).toBe("Best socca ever");
    expect(cleanTitle(undefined, "https://www.youtube.com/watch?v=1")).toBe("Recipe from youtube.com");
  });
});
