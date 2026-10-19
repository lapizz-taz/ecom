import { describe, expect, it } from "vitest";
import { normalizeContent, safeImage, safeUrl, slugify } from "@/lib/content/normalize";
import { defaultContent } from "@/lib/content/defaults";

describe("normalizeContent", () => {
  it("returns the defaults for empty input", () => {
    expect(normalizeContent({})).toEqual(normalizeContent(defaultContent));
    expect(normalizeContent(null).hero.title).toBe(defaultContent.hero.title);
  });

  it("keeps valid edits", () => {
    const c = normalizeContent({ ...defaultContent, hero: { ...defaultContent.hero, title: "Study in Europe" } });
    expect(c.hero.title).toBe("Study in Europe");
  });

  it("drops unsafe links and images", () => {
    const c = normalizeContent({
      ...defaultContent,
      socials: [{ network: "facebook", url: "javascript:alert(1)" }],
      hero: { ...defaultContent.hero, imageDesktop: "javascript:alert(1)" },
    });
    expect(c.socials.find((s) => s.network === "facebook")?.url).toBe("");
    expect(c.hero.imageDesktop).toBe(defaultContent.hero.imageDesktop);
  });

  it("cleans universities: needs a name, unique slugs, safe website and colour", () => {
    const c = normalizeContent({
      ...defaultContent,
      universities: [
        { name: "Test Uni", website: "ftp://x", color: "red" },
        { name: "Test Uni" },
        { name: "" },
      ],
    });
    expect(c.universities).toHaveLength(2);
    expect(c.universities.map((u) => u.slug)).toEqual(["test-uni", "test-uni-2"]);
    expect(c.universities[0].website).toBe("");
    expect(c.universities[0].color).toBe("#64748b");
    expect(c.universities[0].shortName).toBe("TU");
  });

  it("allows an empty university list", () => {
    expect(normalizeContent({ ...defaultContent, universities: [] }).universities).toEqual([]);
  });

  it("forces unknown icons to a safe default and trims long text", () => {
    const c = normalizeContent({
      ...defaultContent,
      services: { items: [{ icon: "Evil", title: "x".repeat(500), description: "d" }], placeholder: false },
    });
    expect(c.services.items[0].icon).toBe("ClipboardCheck");
    expect(c.services.items[0].title.length).toBe(120);
  });

  it("keeps the WhatsApp number digits only", () => {
    const c = normalizeContent({ ...defaultContent, contact: { ...defaultContent.contact, whatsapp: "+880 1712-345678" } });
    expect(c.contact.whatsapp).toBe("8801712345678");
  });
});

describe("helpers", () => {
  it("safeUrl only allows http(s)", () => {
    expect(safeUrl("https://facebook.com/unibee")).toBe("https://facebook.com/unibee");
    expect(safeUrl("data:text/html,x")).toBe("");
  });
  it("safeImage allows https and /public paths only", () => {
    expect(safeImage("/media/a.webp")).toBe("/media/a.webp");
    expect(safeImage("/../etc/passwd")).toBe("");
    expect(safeImage("//evil.com/x.png")).toBe("");
    expect(safeImage("http://insecure.com/x.png")).toBe("");
  });
  it("slugify handles Lithuanian letters", () => {
    expect(slugify("Klaipėda University")).toBe("klaipeda-university");
  });
});

describe("about section", () => {
  it("has starting content and drops untitled items", () => {
    expect(defaultContent.about.whatWeDo.length).toBeGreaterThan(0);
    const c = normalizeContent({ ...defaultContent, about: { ...defaultContent.about, whatWeDo: [{ title: "", text: "x" }, { title: "Guide", text: "y" }] } });
    expect(c.about.whatWeDo).toEqual([{ title: "Guide", text: "y" }]);
  });
});
