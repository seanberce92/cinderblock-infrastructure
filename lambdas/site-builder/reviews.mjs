/**
 * Builds the structured review list the site-builder prompt uses for
 * testimonial cards + Review/AggregateRating JSON-LD.
 *
 * Each formData.reviews[] row is either used as-is (manual reviewerName +
 * rating + text all present) or, if it's missing any of those, its
 * screenshot (if attached) is read from the uploads bucket and sent to
 * Bedrock as a vision request to extract {reviewerName, rating, text} —
 * reusing the same client/model/guardrail exported from bedrock.mjs rather
 * than constructing a second Bedrock client. Manual field values always win
 * over OCR'd ones, per field.
 *
 * A bad/unreadable screenshot or a failed OCR call must never fail the site
 * build — rows that end up with no usable text are silently dropped, same
 * best-effort philosophy as fetchContext.mjs/googleBusinessData.mjs.
 *
 * Screenshots are read into memory only for this OCR call — the resulting
 * bytes/paths are never returned from this module, which is what keeps
 * review screenshots out of the public image gallery ({{IMAGE_LIST}}):
 * copyAllImages in index.mjs only ever iterates site.images/logoKey, and
 * review screenshotKeys are never merged into those.
 */
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, MODEL_ID, GUARDRAIL_ID, GUARDRAIL_VERSION } from "./bedrock.mjs";

const OCR_PROMPT_TEMPLATE = readFileSync(
  new URL("./prompts/review-ocr.md", import.meta.url),
  "utf-8"
);

const extFromKey = (key) => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(key || "");
  return m ? m[1].toLowerCase() : "jpg";
};
const MEDIA_TYPE_FOR_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function isComplete(row) {
  return !!(row?.reviewerName && row?.rating && row?.text);
}

/**
 * Isolated for testability: parses the nonce-delimited OCR response text.
 * Returns {reviewerName?, rating?, text?} or null if malformed/unusable.
 *
 * @param {string} text
 * @param {string} nonce
 */
export function extractOcrResult(text, nonce) {
  const startMarker = `<<<REVIEW_START_${nonce}>>>`;
  const endMarker = `<<<REVIEW_END_${nonce}>>>`;
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return null;

  const body = text.slice(start + startMarker.length, end).trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const rating = Number(parsed.rating);
  return {
    reviewerName:
      typeof parsed.reviewerName === "string"
        ? parsed.reviewerName.slice(0, 100)
        : undefined,
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : undefined,
    text: typeof parsed.text === "string" ? parsed.text.slice(0, 2000) : undefined,
  };
}

/**
 * Pure: manual field values win over OCR'd ones, per field.
 *
 * @param {{reviewerName?: string, rating?: number, text?: string}|undefined} manual
 * @param {{reviewerName?: string, rating?: number, text?: string}|null} ocr
 */
export function mergeReviewRow(manual, ocr) {
  if (!ocr) return manual;
  return {
    reviewerName: manual?.reviewerName || ocr.reviewerName,
    rating: manual?.rating || ocr.rating,
    text: manual?.text || ocr.text,
  };
}

async function ocrScreenshot({ s3, uploadsBucket, screenshotKey }) {
  const ext = extFromKey(screenshotKey);
  const mediaType = MEDIA_TYPE_FOR_EXT[ext] || "image/jpeg";

  let bytes;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: uploadsBucket, Key: screenshotKey })
    );
    bytes = Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    console.warn(`ocrScreenshot: could not read ${screenshotKey}: ${err}`);
    return null;
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const prompt = OCR_PROMPT_TEMPLATE.replace(/\{\{NONCE\}\}/g, nonce);

  let res;
  try {
    res = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 500,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: bytes.toString("base64"),
                  },
                },
              ],
            },
          ],
        }),
        ...(GUARDRAIL_ID
          ? { guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION }
          : {}),
      })
    );
  } catch (err) {
    console.warn(`ocrScreenshot: Bedrock call failed: ${err}`);
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(res.body).toString("utf-8"));
  } catch (err) {
    console.warn(`ocrScreenshot: could not parse Bedrock response: ${err}`);
    return null;
  }
  if (payload["amazon-bedrock-guardrailAction"] === "INTERVENED") {
    console.warn("ocrScreenshot: guardrail intervened on a review screenshot, skipping it");
    return null;
  }

  // Don't assume content[0] is the text block — see bedrock.mjs's identical
  // extraction for why (models with always-on extended thinking prepend a
  // "thinking" block before the text block).
  const text = payload.content?.find((b) => b.type === "text")?.text ?? "";
  return extractOcrResult(text, nonce);
}

/**
 * @param {object} args
 * @param {object} args.site - DynamoDB site record
 * @param {import("@aws-sdk/client-s3").S3Client} args.s3
 * @param {string} args.uploadsBucket
 * @returns {Promise<{reviewerName?: string, rating?: number, text?: string}[]>}
 */
export async function buildReviewData({ site, s3, uploadsBucket }) {
  const rows = site.formData?.reviews || [];
  const results = [];

  for (const row of rows) {
    let merged = {
      reviewerName: row.reviewerName,
      rating: row.rating,
      text: row.text,
    };
    if (!isComplete(merged) && row.screenshotKey) {
      try {
        const ocr = await ocrScreenshot({
          s3,
          uploadsBucket,
          screenshotKey: row.screenshotKey,
        });
        merged = mergeReviewRow(merged, ocr);
      } catch (err) {
        console.warn(`buildReviewData: OCR failed for ${row.screenshotKey}: ${err}`);
      }
    }
    if (merged.text || merged.reviewerName) {
      results.push(merged);
    }
  }

  return results;
}
