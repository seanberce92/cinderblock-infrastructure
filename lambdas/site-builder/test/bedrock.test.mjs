import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceColors,
  enforceFavicon,
  mergeContactData,
  formatImageList,
} from "../bedrock.mjs";

test("enforceColors overrides an existing declaration", () => {
  const css = ":root{--color-primary:#000000;}";
  const out = enforceColors(css, { primary: "#123456" });
  assert.match(out, /--color-primary:#123456;/);
});

test("enforceColors injects a missing property into an existing :root block", () => {
  const css = ":root{--color-secondary:#111111;}";
  const out = enforceColors(css, { primary: "#abcdef" });
  assert.match(out, /--color-primary:#abcdef;/);
  assert.match(out, /--color-secondary:#111111;/);
});

test("enforceColors appends a :root block when none exists", () => {
  const css = "body{color:red;}";
  const out = enforceColors(css, { primary: "#abcdef" });
  assert.match(out, /:root\{--color-primary:#abcdef;\}/);
});

test("enforceColors ignores invalid hex values", () => {
  const css = ":root{--color-primary:#000000;}";
  const out = enforceColors(css, { primary: "not-a-color" });
  assert.equal(out, css);
});

test("enforceColors leaves unset colors untouched", () => {
  const css = ":root{--color-primary:#000000;}";
  const out = enforceColors(css, undefined);
  assert.equal(out, css);
});

test("enforceFavicon: no-ops when there is no logo", () => {
  const html = "<html><head><title>x</title></head><body></body></html>";
  const out = enforceFavicon(html, { logoPath: undefined });
  assert.equal(out, html);
});

test("enforceFavicon: replaces an existing icon tag with the logo path + derived type", () => {
  const html =
    '<html><head><link rel="icon" href="/old.ico"><title>x</title></head></html>';
  const out = enforceFavicon(html, { logoPath: "/dist/images/logo.png" });
  assert.match(out, /<link rel="icon" type="image\/png" href="\/dist\/images\/logo\.png">/);
  assert.doesNotMatch(out, /\/old\.ico/);
});

test("enforceFavicon: matches and replaces the legacy shortcut icon form", () => {
  const html =
    '<html><head><link rel="shortcut icon" href="/old.ico"><title>x</title></head></html>';
  const out = enforceFavicon(html, { logoPath: "/dist/images/logo.svg" });
  assert.match(out, /<link rel="icon" type="image\/svg\+xml" href="\/dist\/images\/logo\.svg">/);
  assert.doesNotMatch(out, /\/old\.ico/);
});

test("enforceFavicon: injects a new tag right after <head> when none exists", () => {
  const html = "<html><head><title>x</title></head><body></body></html>";
  const out = enforceFavicon(html, { logoPath: "/dist/images/logo.png" });
  assert.match(
    out,
    /<head>\s*<link rel="icon" type="image\/png" href="\/dist\/images\/logo\.png">\s*<title>x<\/title>/
  );
});

test("enforceFavicon: injects a whole <head> block after <html> when head is missing", () => {
  const html = '<html lang="en"><body></body></html>';
  const out = enforceFavicon(html, { logoPath: "/dist/images/logo.jpg" });
  assert.match(
    out,
    /<html lang="en">\s*<head>\s*<link rel="icon" type="image\/jpeg" href="\/dist\/images\/logo\.jpg">\s*<\/head>/
  );
});

test("enforceFavicon: no-ops when neither <head> nor <html> is present", () => {
  const malformed = "<div>not a real document</div>";
  const out = enforceFavicon(malformed, { logoPath: "/dist/images/logo.png" });
  assert.equal(out, malformed);
});

test("enforceFavicon: idempotent — running twice yields identical output", () => {
  const html = "<html><head><title>x</title></head></html>";
  const once = enforceFavicon(html, { logoPath: "/dist/images/logo.png" });
  const twice = enforceFavicon(once, { logoPath: "/dist/images/logo.png" });
  assert.equal(once, twice);
});

test("enforceFavicon: omits the type attribute for an unknown extension", () => {
  const html = "<html><head><title>x</title></head></html>";
  const out = enforceFavicon(html, { logoPath: "/dist/images/logo.bmp" });
  assert.match(out, /<link rel="icon" href="\/dist\/images\/logo\.bmp">/);
  assert.doesNotMatch(out, /type=/);
});

test("mergeContactData: manual phone wins over scraped", () => {
  const merged = mergeContactData({ phone: "555-1111" }, { phone: "555-2222" });
  assert.equal(merged.phone, "555-1111");
});

test("mergeContactData: falls back to scraped phone when manual absent", () => {
  const merged = mergeContactData({}, { phone: "555-2222" });
  assert.equal(merged.phone, "555-2222");
});

test("mergeContactData: merges social links per-platform, manual wins per key", () => {
  const merged = mergeContactData(
    { socialLinks: { facebook: "https://facebook.com/manual" } },
    {
      socialLinks: {
        facebook: "https://facebook.com/scraped",
        instagram: "https://instagram.com/scraped",
      },
    }
  );
  assert.equal(merged.socialLinks.facebook, "https://facebook.com/manual");
  assert.equal(merged.socialLinks.instagram, "https://instagram.com/scraped");
});

test("mergeContactData: socialLinks is undefined when neither side has any", () => {
  const merged = mergeContactData({}, null);
  assert.equal(merged.socialLinks, undefined);
  assert.equal(merged.phone, undefined);
});

test("formatImageList: empty list with no logo", () => {
  assert.equal(
    formatImageList([], undefined),
    "(no images were uploaded — design without a photo gallery)"
  );
});

test("formatImageList: uncaptioned images render as bare paths", () => {
  const out = formatImageList(
    [{ path: "/dist/images/photo-0.jpg" }, { path: "/dist/images/photo-1.jpg" }],
    undefined
  );
  assert.equal(out, "- /dist/images/photo-0.jpg\n- /dist/images/photo-1.jpg");
});

test("formatImageList: captioned image renders the caption as a quoted suffix", () => {
  const out = formatImageList(
    [{ path: "/dist/images/photo-0.jpg", caption: "Headshot" }],
    undefined
  );
  assert.equal(out, '- /dist/images/photo-0.jpg — "Headshot"');
});

test("formatImageList: captioned image alongside a logo and an uncaptioned photo", () => {
  const out = formatImageList(
    [
      { path: "/dist/images/photo-0.jpg", caption: "Storefront" },
      { path: "/dist/images/photo-1.jpg" },
    ],
    "/dist/images/logo.png"
  );
  assert.equal(
    out,
    '- /dist/images/logo.png (logo)\n- /dist/images/photo-0.jpg — "Storefront"\n- /dist/images/photo-1.jpg'
  );
});
