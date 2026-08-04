import { test } from "node:test";
import assert from "node:assert/strict";
import { findLinkIssues, describeIssuesForPrompt } from "../validateLinks.mjs";

const VALID_OG_URL = `<meta property="og:url" content="https://mybusiness.com/">`;

test("findLinkIssues flags empty and # placeholder hrefs", () => {
  const files = {
    "src/pages/index.astro": `${VALID_OG_URL}<a href="#">Home</a><a href="">Blank</a>`,
  };
  const issues = findLinkIssues(files);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.type === "placeholder"));
});

test("findLinkIssues flags #anchor with no matching id", () => {
  const files = {
    "src/pages/index.astro": `${VALID_OG_URL}<a href="#services">Services</a><section id="about"></section>`,
  };
  const issues = findLinkIssues(files);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "broken-anchor");
});

test("findLinkIssues allows a matching #anchor, tel:, mailto:, and absolute URLs", () => {
  const files = {
    "src/layouts/Base.astro": `<section id="services"></section>${VALID_OG_URL}`,
    "src/pages/index.astro":
      `<a href="#services">Services</a>` +
      `<a href="tel:+15551234567">Call</a>` +
      `<a href="mailto:hi@example.com">Email</a>` +
      `<a href="https://facebook.com/x">FB</a>`,
  };
  const issues = findLinkIssues(files);
  assert.equal(issues.length, 0);
});

test("findLinkIssues checks ids across all files, not just the file with the href", () => {
  const files = {
    "src/layouts/Base.astro": `<section id="hero"></section>${VALID_OG_URL}`,
    "src/pages/index.astro": `<a href="#hero">Top</a>`,
  };
  assert.equal(findLinkIssues(files).length, 0);
});

test("findLinkIssues flags a relative og:image as a relative-share-meta issue", () => {
  const files = {
    "src/layouts/Base.astro":
      `${VALID_OG_URL}<meta property="og:image" content="/dist/images/photo-0.jpg">`,
  };
  const issues = findLinkIssues(files);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "relative-share-meta");
  assert.equal(issues[0].meta, "og:image");
});

test("findLinkIssues flags an empty twitter:image content", () => {
  const files = {
    "src/layouts/Base.astro": `${VALID_OG_URL}<meta name="twitter:image" content="">`,
  };
  const issues = findLinkIssues(files);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].meta, "twitter:image");
});

test("findLinkIssues allows an absolute og:image/twitter:image regardless of attribute order", () => {
  const files = {
    "src/layouts/Base.astro":
      `${VALID_OG_URL}` +
      `<meta property="og:image" content="https://mybusiness.com/dist/images/photo-0.jpg">` +
      `<meta content="https://mybusiness.com/dist/images/photo-0.jpg" name="twitter:image">`,
  };
  assert.equal(findLinkIssues(files).length, 0);
});

test("findLinkIssues flags a completely missing og:url tag", () => {
  const files = {
    "src/layouts/Base.astro": `<title>Hi</title>`,
  };
  const issues = findLinkIssues(files);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "missing-og-url");
});

test("findLinkIssues does not require og:image/twitter:image to be present at all", () => {
  const files = { "src/layouts/Base.astro": VALID_OG_URL };
  assert.equal(findLinkIssues(files).length, 0);
});

test("describeIssuesForPrompt mentions the offending file and href", () => {
  const issues = [{ type: "placeholder", href: "#", file: "src/pages/index.astro" }];
  const out = describeIssuesForPrompt(issues);
  assert.match(out, /href="#"/);
  assert.match(out, /src\/pages\/index\.astro/);
});

test("describeIssuesForPrompt explains a relative-share-meta issue with the meta key", () => {
  const issues = [
    {
      type: "relative-share-meta",
      meta: "og:image",
      href: "/dist/images/x.jpg",
      file: "src/layouts/Base.astro",
    },
  ];
  const out = describeIssuesForPrompt(issues);
  assert.match(out, /og:image/);
  assert.match(out, /absolute/);
});

test("describeIssuesForPrompt explains a missing-og-url issue", () => {
  const issues = [
    { type: "missing-og-url", meta: "og:url", href: "", file: "src/layouts/Base.astro" },
  ];
  const out = describeIssuesForPrompt(issues);
  assert.match(out, /og:url/);
  assert.match(out, /src\/layouts\/Base\.astro/);
});
