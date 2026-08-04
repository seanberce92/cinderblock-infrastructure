import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOcrResult, mergeReviewRow } from "../reviews.mjs";

test("extractOcrResult parses a well-formed nonce-delimited response", () => {
  const nonce = "abc123";
  const text = `<<<REVIEW_START_${nonce}>>>\n{"reviewerName":"Jane","rating":5,"text":"Great!"}\n<<<REVIEW_END_${nonce}>>>`;
  assert.deepEqual(extractOcrResult(text, nonce), {
    reviewerName: "Jane",
    rating: 5,
    text: "Great!",
  });
});

test("extractOcrResult returns null when the delimiter markers are missing", () => {
  assert.equal(extractOcrResult("no markers here", "abc"), null);
});

test("extractOcrResult returns null for a malformed JSON body", () => {
  const nonce = "n1";
  const text = `<<<REVIEW_START_${nonce}>>>not json<<<REVIEW_END_${nonce}>>>`;
  assert.equal(extractOcrResult(text, nonce), null);
});

test("extractOcrResult drops an out-of-range rating but keeps other fields", () => {
  const nonce = "n2";
  const text = `<<<REVIEW_START_${nonce}>>>{"rating":9,"text":"x"}<<<REVIEW_END_${nonce}>>>`;
  const result = extractOcrResult(text, nonce);
  assert.equal(result.rating, undefined);
  assert.equal(result.text, "x");
});

test("extractOcrResult ignores content outside a different nonce's markers", () => {
  const text = `<<<REVIEW_START_wrong>>>{"text":"x"}<<<REVIEW_END_wrong>>>`;
  assert.equal(extractOcrResult(text, "right"), null);
});

test("mergeReviewRow: manual fields win over OCR, per field", () => {
  const manual = { reviewerName: "Manual Name", rating: undefined, text: undefined };
  const ocr = { reviewerName: "OCR Name", rating: 4, text: "OCR text" };
  const merged = mergeReviewRow(manual, ocr);
  assert.equal(merged.reviewerName, "Manual Name");
  assert.equal(merged.rating, 4);
  assert.equal(merged.text, "OCR text");
});

test("mergeReviewRow: returns manual unchanged when ocr is null", () => {
  const manual = { reviewerName: "X" };
  assert.deepEqual(mergeReviewRow(manual, null), manual);
});
