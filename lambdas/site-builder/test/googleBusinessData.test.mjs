import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSocialLinks, extractPlaceResourceName } from "../googleBusinessData.mjs";

test("extractSocialLinks finds known platforms and dedupes to the first match", () => {
  const html = `
    <a href="https://facebook.com/biz">FB</a>
    <a href="https://facebook.com/other">FB2</a>
    <a href="https://instagram.com/biz">IG</a>
    <a href="https://example.com">Other</a>
  `;
  const links = extractSocialLinks(html);
  assert.equal(links.facebook, "https://facebook.com/biz");
  assert.equal(links.instagram, "https://instagram.com/biz");
  assert.equal(links.twitter, undefined);
});

test("extractSocialLinks treats x.com as twitter", () => {
  const links = extractSocialLinks(`<a href="https://x.com/biz">X</a>`);
  assert.equal(links.twitter, "https://x.com/biz");
});

test("extractSocialLinks returns {} for null/empty html", () => {
  assert.deepEqual(extractSocialLinks(null), {});
  assert.deepEqual(extractSocialLinks(""), {});
});

test("extractPlaceResourceName reads result.entities[0].place", () => {
  const payload = { result: { entities: [{ place: "places/ChIJabc123" }] } };
  assert.equal(extractPlaceResourceName(payload), "places/ChIJabc123");
});

test("extractPlaceResourceName falls back to a top-level entities array", () => {
  const payload = { entities: [{ place: "places/xyz" }] };
  assert.equal(extractPlaceResourceName(payload), "places/xyz");
});

test("extractPlaceResourceName returns null when missing or malformed", () => {
  assert.equal(extractPlaceResourceName({}), null);
  assert.equal(extractPlaceResourceName({ result: { entities: [] } }), null);
  assert.equal(extractPlaceResourceName(null), null);
});
