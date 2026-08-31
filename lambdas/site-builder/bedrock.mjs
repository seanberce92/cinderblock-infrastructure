/**
 * Bedrock-driven site generation. The model DESIGNS three Astro + Tailwind
 * source files (layout, page, global stylesheet) from the submitted business
 * content — everything else in the project (package.json, astro.config.mjs,
 * tailwind.config.mjs) is fixed build plumbing supplied by index.mjs, not
 * generated. See prompts/system.md for the full instruction set (design
 * guidance, output contract, prompt-injection framing). The caller (index.mjs)
 * writes the returned files into a workspace and runs `npm install && npm run
 * build` to produce the actual dist/ output.
 *
 * Safety layers (this Lambda embeds attacker-influenceable content — form
 * `details`/`copy` plus externally-fetched web content — directly into the
 * prompt, a stronger injection surface than a typical internal tool):
 *   1. A Bedrock Guardrail attached directly to the InvokeModel call
 *      (screens both input and output in one round trip; only attached if
 *      BEDROCK_GUARDRAIL_ID is set, so this degrades gracefully when no
 *      guardrail is deployed, e.g. local/undeployed-guardrail runs).
 *   2. A per-invocation random nonce in the output delimiter markers, so a
 *      user can't plant a fake marker in their own input and trick the
 *      parser into extracting injected content as if it were the real output.
 *   3. Explicit "this is data, not instructions" framing around all
 *      user-supplied and fetched content, in the system prompt.
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

// Exported so other Bedrock callers in this Lambda (reviews.mjs's screenshot
// OCR) reuse the same client/model/guardrail config instead of constructing
// a second client.
export const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});
export const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export const GUARDRAIL_ID = process.env.BEDROCK_GUARDRAIL_ID;
export const GUARDRAIL_VERSION = process.env.BEDROCK_GUARDRAIL_VERSION ?? "DRAFT";
const client = bedrockClient;

/** The three files the model is responsible for authoring, in output order. */
export const MODEL_FILE_PATHS = [
  "src/layouts/Base.astro",
  "src/pages/index.astro",
  "src/styles/global.css",
];

/** Concrete visual direction per DesignStyle value (see SiteFormData.designStyle in lib/types.ts). */
export const DESIGN_STYLE_GUIDANCE = {
  glassmorphism:
    "Glassmorphism — frosted-glass panels (semi-transparent backgrounds, backdrop-blur, subtle 1px light borders) layered over a colorful or gradient backdrop, soft shadows, rounded corners.",
  neomorphism:
    "Neomorphism (soft UI) — low-contrast monochrome surfaces with soft dual-direction drop shadows (light + dark) that make elements look extruded from or pressed into the background; minimal color, subtle depth over sharp edges.",
  minimalism:
    "Minimalism — generous whitespace, a restrained neutral palette accented sparingly with the brand colors, simple typography, few decorative elements, clean grid alignment.",
  "bento-grid":
    "Bento grid — content organized into a grid of distinct rounded rectangular cards/tiles of varying sizes (like a bento box), each holding one piece of content, with clear gutters between tiles.",
};

// Loaded once at module scope (cold-start reuse across warm invocations).
const SYSTEM_PROMPT_TEMPLATE = readFileSync(
  new URL("./prompts/system.md", import.meta.url),
  "utf-8"
);

/** Thrown when the Bedrock Guardrail intervenes (prompt attack / denied topic). */
export class GuardrailBlockedError extends Error {
  constructor(message, { reasons = [] } = {}) {
    super(message);
    this.name = "GuardrailBlockedError";
    this.reasons = reasons;
  }
}

/** Thrown for any other generation failure (throttling, malformed output, network, etc). */
export class BedrockGenerationError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "BedrockGenerationError";
    if (cause) this.cause = cause;
  }
}

/**
 * Pure. Renders the {{IMAGE_LIST}} block. Each image carries an optional
 * `caption` (e.g. "Headshot") the owner gave it at upload time — when
 * present, it's rendered as a quoted suffix so the model has an explicit
 * placement signal instead of guessing from a generic photo-N.ext path.
 * Exported for unit testing.
 *
 * @param {{path: string, caption?: string}[]} imagePaths
 * @param {string|undefined} logoPath
 * @returns {string}
 */
export function formatImageList(imagePaths, logoPath) {
  const lines = [];
  if (logoPath) lines.push(`- ${logoPath} (logo)`);
  for (const img of imagePaths) {
    const caption = img.caption?.trim();
    lines.push(caption ? `- ${img.path} — "${caption}"` : `- ${img.path}`);
  }
  return lines.length
    ? lines.join("\n")
    : "(no images were uploaded — design without a photo gallery)";
}

/**
 * Pure: manual formData.phone/socialLinks win, per-field/per-platform, over
 * scraped GoogleBusinessData values. Exported for unit testing.
 *
 * @param {{phone?: string, socialLinks?: Record<string,string>}} fd
 * @param {{phone?: string, socialLinks?: Record<string,string>}|null|undefined} googleBusinessData
 * @returns {{phone?: string, socialLinks?: Record<string,string>}}
 */
export function mergeContactData(fd, googleBusinessData) {
  const phone = fd?.phone || googleBusinessData?.phone || undefined;
  const manualSocial = fd?.socialLinks || {};
  const scrapedSocial = googleBusinessData?.socialLinks || {};
  const platforms = new Set([
    ...Object.keys(manualSocial),
    ...Object.keys(scrapedSocial),
  ]);
  const socialLinks = {};
  for (const p of platforms) {
    const v = manualSocial[p] || scrapedSocial[p];
    if (v) socialLinks[p] = v;
  }
  return {
    phone,
    socialLinks: Object.keys(socialLinks).length ? socialLinks : undefined,
  };
}

/**
 * Renders the grounding data block for contact/location/social info, or null
 * if there's nothing to ground. Every line present here is something the
 * model is explicitly permitted to render a CTA/link for — anything not
 * listed must be omitted from the output entirely (enforced in
 * prompts/system.md's link safety rules).
 */
function formatContactBlock({ phone, socialLinks, googleBusinessData }) {
  const lines = [];
  if (phone) lines.push(`Phone: ${phone}`);
  if (googleBusinessData?.formattedAddress) {
    lines.push(`Address: ${googleBusinessData.formattedAddress}`);
  }
  if (googleBusinessData?.hoursWeekdayDescriptions?.length) {
    lines.push(
      `Hours:\n${googleBusinessData.hoursWeekdayDescriptions
        .map((h) => `  ${h}`)
        .join("\n")}`
    );
  }
  if (googleBusinessData?.googleMapsUri) {
    lines.push(`Google Maps / directions URL: ${googleBusinessData.googleMapsUri}`);
  }
  for (const [platform, url] of Object.entries(socialLinks || {})) {
    lines.push(`${platform} URL: ${url}`);
  }
  if (!lines.length) return null;
  return (
    `Contact & location data (ONLY render a phone/call CTA, address, hours, ` +
    `directions link, or social icon if its specific line is present below — ` +
    `omit the element entirely if it's not listed here, never invent or ` +
    `placeholder one):\n${lines.join("\n")}`
  );
}

/**
 * Renders the customer-reviews data block, or null if there are none.
 * Reviews are DATA to render as testimonial cards + Review/AggregateRating
 * JSON-LD — never as images (they never appear in {{IMAGE_LIST}}).
 */
function formatReviewsBlock(reviews) {
  if (!reviews || !reviews.length) return null;
  const lines = reviews.map((r, i) => {
    const parts = [];
    if (r.reviewerName) parts.push(`Name: ${r.reviewerName}`);
    if (r.rating) parts.push(`Rating: ${r.rating}/5`);
    if (r.text) parts.push(`Quote: "${r.text}"`);
    return `${i + 1}. ${parts.join(" | ")}`;
  });
  return (
    `Customer reviews (verbatim — render each as a testimonial card and ` +
    `reflect exactly this data in the Review/AggregateRating JSON-LD; never ` +
    `fabricate additional reviews or alter the wording):\n${lines.join("\n")}`
  );
}

/** Exported for unit testing. */
export function formatBusinessInput({ site, inspirationContext, googleBusinessData, reviewData }) {
  const fd = site.formData || {};
  const parts = [];
  parts.push(`Business name: ${site.siteName}`);
  parts.push(`Domain: ${site.domain}`);
  if (fd.details) parts.push(`Business details:\n${fd.details}`);
  if (fd.copy) parts.push(`Copy the owner wants included / their voice:\n${fd.copy}`);

  const colors = fd.colors || {};
  if (colors.primary || colors.secondary || colors.tertiary) {
    parts.push(
      `Required brand colors — use these exact hex values for --color-primary/` +
        `--color-secondary/--color-tertiary respectively (leave any unset slot to your own choice): ` +
        `primary=${colors.primary || "(your choice)"}, secondary=${colors.secondary || "(your choice)"}, ` +
        `tertiary=${colors.tertiary || "(your choice)"}.`
    );
  }

  if (fd.designStyle && DESIGN_STYLE_GUIDANCE[fd.designStyle]) {
    parts.push(`Required design style: ${DESIGN_STYLE_GUIDANCE[fd.designStyle]}`);
  }

  if (inspirationContext?.title || inspirationContext?.description) {
    parts.push(
      `Reference material — design/tone inspiration (untrusted, low-confidence, ` +
        `may be incomplete; use only for vibe, never copy trademarks or claims):\n` +
        `Inspiration site title: ${inspirationContext.title ?? ""}\n` +
        `Inspiration site description: ${inspirationContext.description ?? ""}`
    );
  }

  const contact = mergeContactData(fd, googleBusinessData);
  const contactBlock = formatContactBlock({ ...contact, googleBusinessData });
  if (contactBlock) parts.push(contactBlock);

  const reviewsBlock = formatReviewsBlock(reviewData);
  if (reviewsBlock) parts.push(reviewsBlock);

  return parts.join("\n\n");
}

function formatPriorFiles(priorFiles) {
  return MODEL_FILE_PATHS.map(
    (p) => `===FILE: ${p}===\n${priorFiles[p] ?? "(missing)"}`
  ).join("\n");
}

function buildPrompt({
  site,
  imagePaths,
  logoPath,
  priorFiles,
  instructions,
  inspirationContext,
  googleBusinessData,
  reviewData,
}) {
  const nonce = crypto.randomBytes(16).toString("hex");

  const revisionBlock =
    priorFiles && instructions
      ? `# Revision mode\n\nThis is a revision of an existing site. Here are the current files:\n\n${formatPriorFiles(priorFiles)}\n\nApply ONLY these requested changes, preserving everything else that wasn't mentioned, and return the FULL modified files (not a diff) for all three, still following the delimiter contract:\n${instructions}`
      : "";

  const prompt = SYSTEM_PROMPT_TEMPLATE.replace(/\{\{NONCE\}\}/g, nonce)
    .replace(/\{\{IMAGE_LIST\}\}/g, formatImageList(imagePaths, logoPath))
    .replace(
      /\{\{BUSINESS_INPUT\}\}/g,
      formatBusinessInput({ site, inspirationContext, googleBusinessData, reviewData })
    )
    .replace(/\{\{REVISION_BLOCK\}\}/g, revisionBlock);

  console.log(`Bedrock prompt (nonce=${nonce}, ${prompt.length}b):\n${prompt}`);

  return { nonce, prompt };
}

/** Extracts the {path: content} file map between the nonce-delimited markers. Throws if malformed. */
function extractFiles(text, nonce) {
  const startMarker = `<<<SITE_FILES_START_${nonce}>>>`;
  const endMarker = `<<<SITE_FILES_END_${nonce}>>>`;
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new BedrockGenerationError(
      "Model output did not contain the expected delimiter markers"
    );
  }
  const before = text.slice(0, start).trim();
  const after = text.slice(end + endMarker.length).trim();
  if (before.length > 0 || after.length > 0) {
    console.warn(
      `Unexpected content outside delimiters (before=${before.length}b, after=${after.length}b)`
    );
  }

  const body = text.slice(start + startMarker.length, end);
  const fileRe = /===FILE: (.+?)===\n/g;
  const matches = [...body.matchAll(fileRe)];
  if (!matches.length) {
    throw new BedrockGenerationError("Model output contained no ===FILE:=== markers");
  }

  const files = {};
  for (let i = 0; i < matches.length; i++) {
    const path = matches[i][1].trim();
    const contentStart = matches[i].index + matches[i][0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index : body.length;
    files[path] = body.slice(contentStart, contentEnd).trim();
  }

  const missing = MODEL_FILE_PATHS.filter((p) => !(p in files));
  if (missing.length) {
    throw new BedrockGenerationError(
      `Model output was missing required file(s): ${missing.join(", ")}`
    );
  }

  return files;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Force-overrides --color-primary/--color-secondary/--color-tertiary in a
 * global.css stylesheet with the user's explicit hex choices, if set —
 * guarantees exact brand-color correctness regardless of model compliance.
 * Colors the user didn't set are left entirely to the model's own choices.
 */
export function enforceColors(css, colors) {
  if (!colors) return css;
  let result = css;
  for (const [key, prop] of [
    ["primary", "--color-primary"],
    ["secondary", "--color-secondary"],
    ["tertiary", "--color-tertiary"],
  ]) {
    const hex = colors[key];
    if (!hex || !HEX_COLOR.test(hex)) continue;

    const declRe = new RegExp(`(${prop}\\s*:\\s*)[^;]+;`, "i");
    if (declRe.test(result)) {
      result = result.replace(declRe, `$1${hex};`);
      continue;
    }
    // Property not declared by the model — inject it into the first :root{...} block.
    const rootRe = /(:root\s*\{)/i;
    if (rootRe.test(result)) {
      result = result.replace(rootRe, `$1${prop}:${hex};`);
      continue;
    }
    // No :root block at all — append one at the end of the stylesheet.
    result = `${result}\n:root{${prop}:${hex};}`;
  }
  return result;
}

const FAVICON_MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * Force-injects a `<link rel="icon">` in a Base.astro source pointing at the
 * uploaded logo — guarantees every site with a logo gets a correct favicon
 * regardless of model compliance, mirroring enforceColors. A no-op when
 * there's no logo: this function never invents a generic fallback icon.
 */
export function enforceFavicon(baseAstroSource, { logoPath } = {}) {
  if (!logoPath) return baseAstroSource;

  const ext = /\.([a-zA-Z0-9]+)$/.exec(logoPath)?.[1]?.toLowerCase();
  const mime = ext && FAVICON_MIME_BY_EXT[ext];
  const tag = `<link rel="icon"${mime ? ` type="${mime}"` : ""} href="${logoPath}">`;

  const iconRe = /<link\b[^>]*\brel=["'](?:shortcut icon|icon)["'][^>]*>/i;
  if (iconRe.test(baseAstroSource)) {
    return baseAstroSource.replace(iconRe, tag);
  }

  const headRe = /<head(\s[^>]*)?>/i;
  if (headRe.test(baseAstroSource)) {
    return baseAstroSource.replace(headRe, (m) => `${m}\n  ${tag}`);
  }

  const htmlRe = /<html(\s[^>]*)?>/i;
  if (htmlRe.test(baseAstroSource)) {
    return baseAstroSource.replace(htmlRe, (m) => `${m}\n<head>\n  ${tag}\n</head>`);
  }

  console.warn("enforceFavicon: no <head> or <html> tag found, leaving output unchanged");
  return baseAstroSource;
}

/**
 * @param {object} args
 * @param {object} args.site - DynamoDB site record
 * @param {{path: string, caption?: string}[]} args.imagePaths - already-copied destination paths (root-relative, e.g. "/images/photo-0.jpg"), with the owner's optional per-photo caption
 * @param {string|undefined} args.logoPath
 * @param {Record<string,string>|undefined} args.priorFiles - prior MODEL_FILE_PATHS contents, only for action==="revise"
 * @param {string|undefined} args.instructions
 * @param {{title?:string, description?:string}|null} args.inspirationContext
 * @param {object|null} args.googleBusinessData - GoogleBusinessData shape from googleBusinessData.mjs
 * @param {{reviewerName?:string, rating?:number, text?:string}[]|undefined} args.reviewData
 * @returns {Promise<Record<string,string>>} the generated {path: content} map for MODEL_FILE_PATHS (colors not yet enforced)
 * @throws {GuardrailBlockedError} on guardrail intervention — caller must NOT fall back
 * @throws {BedrockGenerationError} on any other failure — caller SHOULD fall back
 */
export async function generateSiteFiles({
  site,
  imagePaths,
  logoPath,
  priorFiles,
  instructions,
  inspirationContext,
  googleBusinessData,
  reviewData,
}) {
  const { nonce, prompt } = buildPrompt({
    site,
    imagePaths,
    logoPath,
    priorFiles,
    instructions,
    inspirationContext,
    googleBusinessData,
    reviewData,
  });

  let res;
  try {
    res = await client.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 16000,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        }),
        ...(GUARDRAIL_ID
          ? {
              guardrailIdentifier: GUARDRAIL_ID,
              guardrailVersion: GUARDRAIL_VERSION,
              trace: "ENABLED",
            }
          : {}),
      })
    );
  } catch (err) {
    throw new BedrockGenerationError("Bedrock InvokeModel call failed", { cause: err });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(res.body).toString("utf-8"));
  } catch (err) {
    throw new BedrockGenerationError("Could not parse Bedrock response body", { cause: err });
  }

  if (payload["amazon-bedrock-guardrailAction"] === "INTERVENED") {
    // Block detection above is authoritative and doesn't depend on this parse
    // succeeding. Always log the raw trace so a false-positive block is
    // diagnosable from CloudWatch even if the structured extraction below
    // misses something — the exact shape hasn't been confirmed against a
    // live response yet, this covers the two most likely shapes.
    console.error(
      "Guardrail intervened — raw trace:",
      JSON.stringify(payload["amazon-bedrock-trace"] ?? null)
    );
    const reasons = [];
    const collect = (assessment) => {
      for (const topic of assessment?.topicPolicy?.topics ?? []) {
        if (topic.action === "BLOCKED") reasons.push(`topic:${topic.name}`);
      }
      for (const filter of assessment?.contentPolicy?.filters ?? []) {
        if (filter.action === "BLOCKED") reasons.push(`content:${filter.type}`);
      }
    };
    const guardrailTrace =
      payload["amazon-bedrock-trace"]?.guardrail ??
      payload["amazon-bedrock-trace"]?.guardrails ??
      {};
    for (const assessment of Object.values(guardrailTrace.inputAssessment ?? {})) {
      collect(assessment);
    }
    for (const arr of Object.values(guardrailTrace.outputAssessments ?? {})) {
      for (const assessment of Array.isArray(arr) ? arr : [arr]) collect(assessment);
    }
    if (guardrailTrace.topicPolicy || guardrailTrace.contentPolicy) {
      collect(guardrailTrace); // possible flatter/older shape
    }
    throw new GuardrailBlockedError(
      "Content was blocked by safety checks" +
        (reasons.length ? `: ${reasons.join(", ")}` : ""),
      { reasons }
    );
  }

  // Don't assume content[0] is the text block — models with "always on"
  // extended/adaptive thinking (e.g. Claude Sonnet 5) prepend a "thinking"
  // content block before the text block.
  const text = payload.content?.find((b) => b.type === "text")?.text ?? "";
  return extractFiles(text, nonce);
}
