/**
 * site-builder Lambda.
 *
 * Event: { siteId, action: "build" | "revise", instructions?, target?: "live" | "sandbox" }
 *
 * `target` (default "live") selects which bucket gets written and which
 * fields on the site record get updated. "live" is the original behavior,
 * unchanged: cinderblock-preview-{siteId}-{env}, status/previewBucket/previewUrl.
 * "sandbox" is used to revise an already-live site without touching
 * production: cinderblock-sandbox-{siteId}-{env}, sandboxStatus/sandboxBucket/
 * sandboxUrl only — the site's own `status` and `error` fields are untouched.
 * On the first sandbox revision (sandbox bucket has no source yet), prior
 * files are read back from the live preview bucket instead, so the sandbox
 * starts from what's actually live.
 *
 * Flow:
 *   1. Load the site record from DynamoDB.
 *   2. Ensure the public preview/sandbox bucket (cinderblock-preview-{siteId}-{env}
 *      or cinderblock-sandbox-{siteId}-{env}).
 *   3. Reset a local /tmp workspace and lay down the fixed Astro + Tailwind
 *      build plumbing (package.json, astro.config.mjs, tailwind.config.mjs —
 *      see templates/), plus every uploaded image + logo, copied into both
 *      the workspace's public/images/ (so the Astro build embeds them) and
 *      directly into the preview bucket's dist/images/ (so images are already
 *      in place before generation/build even runs).
 *   4. Best-effort fetch external context: the inspiration URL (title/meta
 *      only, via fetchContext.mjs), the Google Business Profile URL resolved
 *      to structured phone/address/hours/website/social data (via
 *      googleBusinessData.mjs's MCP + Places API calls, cached on the site
 *      record after the first successful resolution), and the customer
 *      review list (via reviews.mjs — manual entries plus vision-OCR'd
 *      screenshots).
 *   5. Ask Bedrock to DESIGN the three Astro source files (see bedrock.mjs /
 *      prompts/system.md), grounded in that contact/review data. On revise,
 *      the prior three files are read back from the preview bucket itself
 *      (source of truth, not cached in DynamoDB) and passed in as context.
 *      A post-generation link-safety check (validateLinks.mjs) then runs a
 *      single self-contained corrective regeneration pass if any dead/
 *      placeholder hrefs are found.
 *   6. Force-override any explicit brand colors in the generated stylesheet,
 *      write the files into the workspace, and upload the FULL project
 *      source tree to the bucket (this is what a customer/provisioner would
 *      see as "the src files").
 *   7. Run `npm install && npm run build` in the workspace and upload the
 *      resulting dist/ output to the bucket under a dist/ prefix.
 *   8. Update the site record: previewBucket, previewUrl (.../dist/index.html), status=preview.
 *
 * Any generation or build failure (guardrail block, throttling, a bad Astro/
 * Tailwind build, etc.) propagates to the outer catch below, which marks the
 * site status=failed with the error message. There is no placeholder-page
 * fallback — the frontend shows the error and lets the customer retry
 * (POST /sites/:id/retry re-triggers a fresh, from-scratch generation).
 *
 * Relies on the AWS SDK v3 bundled in the Node.js Lambda runtime, plus that
 * runtime's bundled `npm` binary and outbound internet access (no VPC
 * attachment) to install Astro/Tailwind and build.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketWebsiteCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import {
  generateSiteFiles,
  enforceColors,
  enforceFavicon,
  MODEL_FILE_PATHS,
} from "./bedrock.mjs";
import { fetchUrlContext } from "./fetchContext.mjs";
import { resolveGoogleBusinessData } from "./googleBusinessData.mjs";
import { buildReviewData } from "./reviews.mjs";
import { findLinkIssues, describeIssuesForPrompt } from "./validateLinks.mjs";
import {
  resetWorkspace,
  writeFilesToWorkspace,
  runNpmInstallAndBuild,
  uploadDirToBucket,
} from "./buildAstro.mjs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ENV = process.env.ENV ?? "qa";
const SITES_TABLE = process.env.SITES_TABLE ?? "cinderblock-sites-qa";
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET ?? "cinderblock-uploads-qa";
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

// Fixed build plumbing (not model-authored) — loaded once at module scope.
const TEMPLATE_DIR = new URL("./templates/", import.meta.url);
const FIXED_TEMPLATE_FILES = {
  "package.json": readFileSync(new URL("package.json", TEMPLATE_DIR), "utf-8"),
  "astro.config.mjs": readFileSync(new URL("astro.config.mjs", TEMPLATE_DIR), "utf-8"),
  "tailwind.config.mjs": readFileSync(new URL("tailwind.config.mjs", TEMPLATE_DIR), "utf-8"),
};

const extFromKey = (key) => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(key || "");
  return m ? m[1].toLowerCase() : "jpg";
};
const contentTypeFor = (ext) =>
  ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
  }[ext] || "application/octet-stream");

async function objectExists(bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function bucketExists(bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

async function ensurePreviewBucket(bucket) {
  if (await bucketExists(bucket)) return;
  // us-east-1 must NOT pass a LocationConstraint.
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    })
  );
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PublicReadForPreview",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
        ],
      }),
    })
  );
  await s3.send(
    new PutBucketWebsiteCommand({
      Bucket: bucket,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: "index.html" },
        ErrorDocument: { Key: "index.html" },
      },
    })
  );
}

/**
 * Copies one uploaded image into the preview bucket's dist/images/ (directly,
 * idempotent — skipped if already copied on a prior build/revision) AND into
 * the local workspace's public/images/ so the Astro build embeds it too.
 */
async function copyOneImage(bucket, workspaceDir, srcKey, destName) {
  const ext = extFromKey(srcKey);
  const distKey = `dist/images/${destName}`;
  if (!(await objectExists(bucket, distKey))) {
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `/${UPLOADS_BUCKET}/${srcKey}`,
        Key: distKey,
        MetadataDirective: "COPY",
        ContentType: contentTypeFor(ext),
      })
    );
  }
  const res = await s3.send(
    new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: srcKey })
  );
  const body = Buffer.from(await res.Body.transformToByteArray());
  const dest = path.join(workspaceDir, "public", "images", destName);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, body);
}

/**
 * Copies every uploaded image + logo; returns paths for the prompt/markup as
 * "/dist/images/...". The leading /dist matters: the built page is served
 * directly from the bucket's dist/ key prefix (no domain root), so a
 * hand-authored <img src="/images/x"> would resolve against the bucket root
 * and 404 — only Astro's own asset pipeline gets base-prefixed automatically
 * (see templates/astro.config.mjs), hand-authored src/href attributes don't.
 *
 * Deliberately only ever reads site.images/site.logoKey, NOT
 * formData.reviews[].screenshotKey — review screenshots must never be merged
 * into images upstream (see sites.controller.ts's createSchema and
 * BuildPage.tsx's separate "review" upload kind). That's what keeps review
 * screenshots out of the public gallery/{{IMAGE_LIST}} by construction: they
 * only ever reach reviews.mjs's OCR call, never this function.
 *
 * Returns imagePaths as {path, caption}[] — caption is the optional label
 * the owner gave the photo (e.g. "Headshot"), carried through so the prompt
 * can use it as a placement signal.
 */
async function copyAllImages(bucket, workspaceDir, site) {
  const images = site.images || [];
  const imagePaths = [];
  for (let i = 0; i < images.length; i++) {
    const ext = extFromKey(images[i].key);
    const destName = `photo-${i}.${ext}`;
    await copyOneImage(bucket, workspaceDir, images[i].key, destName);
    imagePaths.push({ path: `/dist/images/${destName}`, caption: images[i].caption });
  }

  let logoPath;
  if (site.logoKey) {
    const ext = extFromKey(site.logoKey);
    const destName = `logo.${ext}`;
    await copyOneImage(bucket, workspaceDir, site.logoKey, destName);
    logoPath = `/dist/images/${destName}`;
  }

  return { imagePaths, logoPath };
}

/**
 * Resolves Google Business Profile data once per site and caches it on the
 * record (googleData) — the MCP + Places API calls are paid/rate-limited, so
 * repeat builds/revisions of the same site reuse the cached result instead of
 * re-resolving. Never throws: a resolution or persistence failure just means
 * no grounding data for this build, not a failed build.
 */
async function getOrResolveGoogleData(site) {
  if (site.googleData) return site.googleData;
  const googleProfileUrl = site.formData?.googleProfile;
  if (!googleProfileUrl || !GOOGLE_MAPS_API_KEY) return null;

  let data = null;
  try {
    data = await resolveGoogleBusinessData({
      googleProfileUrl,
      apiKey: GOOGLE_MAPS_API_KEY,
    });
  } catch (err) {
    console.warn(`getOrResolveGoogleData: resolution failed: ${err}`);
    return null;
  }
  if (!data) return null;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SITES_TABLE,
        Key: { siteId: site.siteId },
        UpdateExpression: "SET googleData = :g",
        ExpressionAttributeValues: { ":g": data },
      })
    );
  } catch (err) {
    console.warn(`getOrResolveGoogleData: failed to persist googleData: ${err}`);
  }
  return data;
}

/** Reads a site's current three source files back from a bucket, for revisions. */
async function getPriorFiles(bucket) {
  const files = {};
  for (const p of MODEL_FILE_PATHS) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: p }));
      files[p] = await res.Body.transformToString("utf-8");
    } catch (err) {
      console.warn(`Could not read prior ${p} from ${bucket}, building fresh: ${err}`);
      return undefined;
    }
  }
  return files;
}

export const handler = async (event, context) => {
  const { siteId, action = "build", instructions, target = "live" } = event || {};
  if (!siteId) throw new Error("siteId is required");

  const res = await ddb.send(
    new GetCommand({ TableName: SITES_TABLE, Key: { siteId } })
  );
  const site = res.Item;
  if (!site) throw new Error(`site ${siteId} not found`);

  const workspaceDir = `/tmp/build/${siteId}`;
  const isSandbox = target === "sandbox";

  try {
    const bucket = isSandbox
      ? `cinderblock-sandbox-${siteId}-${ENV}`
      : `cinderblock-preview-${siteId}-${ENV}`;
    await ensurePreviewBucket(bucket);

    resetWorkspace(workspaceDir);
    writeFilesToWorkspace(workspaceDir, FIXED_TEMPLATE_FILES);

    const { imagePaths, logoPath } = await copyAllImages(bucket, workspaceDir, site);

    const fd = site.formData || {};
    const [inspirationContext, googleBusinessData, reviewData] = await Promise.all([
      fetchUrlContext(fd.inspirationUrl),
      getOrResolveGoogleData(site),
      buildReviewData({ site, s3, uploadsBucket: UPLOADS_BUCKET }),
    ]);

    // On the first-ever sandbox revision the sandbox bucket has no source yet;
    // fall back to the live bucket so the sandbox starts from what's actually
    // live rather than regenerating from scratch.
    let priorFiles = action === "revise" ? await getPriorFiles(bucket) : undefined;
    if (!priorFiles && isSandbox && action === "revise" && site.previewBucket) {
      priorFiles = await getPriorFiles(site.previewBucket);
    }
    let files = await generateSiteFiles({
      site,
      imagePaths,
      logoPath,
      priorFiles,
      instructions,
      inspirationContext,
      googleBusinessData,
      reviewData,
    });
    files["src/styles/global.css"] = enforceColors(files["src/styles/global.css"], fd.colors);
    files["src/layouts/Base.astro"] = enforceFavicon(files["src/layouts/Base.astro"], { logoPath });

    // One self-contained corrective pass if the generation left any dead/
    // placeholder links — never allowed to fail the build; a link-quality
    // issue isn't a generation/build failure, so it must not be treated like
    // one. Any error here (including a guardrail hit on the synthesized
    // corrective instructions) just means we ship the original, already-good
    // files.
    const linkIssues = findLinkIssues(files);
    if (linkIssues.length) {
      try {
        const corrected = await generateSiteFiles({
          site,
          imagePaths,
          logoPath,
          priorFiles: files,
          instructions: describeIssuesForPrompt(linkIssues),
          inspirationContext,
          googleBusinessData,
          reviewData,
        });
        corrected["src/styles/global.css"] = enforceColors(
          corrected["src/styles/global.css"],
          fd.colors
        );
        corrected["src/layouts/Base.astro"] = enforceFavicon(
          corrected["src/layouts/Base.astro"],
          { logoPath }
        );
        files = corrected;
      } catch (err) {
        console.warn(
          `Corrective link-fix pass failed, shipping original generation: ${err}`
        );
      }
    }

    writeFilesToWorkspace(workspaceDir, files);
    // Full project source (config + public/images + src/**) — "the src files saved on the bucket".
    await uploadDirToBucket(s3, bucket, workspaceDir, "");

    const remainingMs = context.getRemainingTimeInMillis?.() ?? 480_000;
    runNpmInstallAndBuild(workspaceDir, {
      timeoutMs: Math.max(60_000, Math.floor(remainingMs / 2) - 15_000),
    });

    await uploadDirToBucket(s3, bucket, path.join(workspaceDir, "dist"), "dist");

    if (isSandbox) {
      // sandboxUrl/sandboxStatus="ready" are only meaningful once the sandbox
      // CloudFront distribution exists (see the provisioner's sandbox-
      // provisioning pipeline); until then content is built but not yet
      // publicly viewable, so stay in "building".
      const sandboxUrl = site.sandboxDomain
        ? `https://${site.sandboxDomain}/dist/index.html`
        : undefined;
      await ddb.send(
        new UpdateCommand({
          TableName: SITES_TABLE,
          Key: { siteId },
          UpdateExpression:
            "SET sandboxBucket = :b, sandboxStatus = :s, updatedAt = :now" +
            (sandboxUrl ? ", sandboxUrl = :u" : "") +
            " REMOVE sandboxError",
          ExpressionAttributeValues: {
            ":b": bucket,
            ":s": site.sandboxDistributionId ? "ready" : "building",
            ":now": Date.now(),
            ...(sandboxUrl ? { ":u": sandboxUrl } : {}),
          },
        })
      );
      console.log(`Built sandbox for site ${siteId} -> bucket ${bucket}`);
      return { siteId, sandboxStatus: "building", sandboxBucket: bucket };
    }

    // https REST URL avoids mixed-content when embedded in an https iframe.
    const previewUrl = `https://${bucket}.s3.${REGION}.amazonaws.com/dist/index.html`;

    await ddb.send(
      new UpdateCommand({
        TableName: SITES_TABLE,
        Key: { siteId },
        UpdateExpression:
          "SET #s = :s, previewBucket = :b, previewUrl = :u, updatedAt = :now REMOVE #err",
        ExpressionAttributeNames: { "#s": "status", "#err": "error" },
        ExpressionAttributeValues: {
          ":s": "preview",
          ":b": bucket,
          ":u": previewUrl,
          ":now": Date.now(),
        },
      })
    );

    console.log(`Built site ${siteId} -> ${previewUrl}`);
    return { siteId, status: "preview", previewUrl };
  } catch (err) {
    console.error(`Build failed for ${siteId}:`, err);
    if (isSandbox) {
      await ddb.send(
        new UpdateCommand({
          TableName: SITES_TABLE,
          Key: { siteId },
          UpdateExpression: "SET sandboxStatus = :s, sandboxError = :e, updatedAt = :now",
          ExpressionAttributeValues: {
            ":s": "failed",
            ":e": String(err?.message || err),
            ":now": Date.now(),
          },
        })
      );
      throw err;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: SITES_TABLE,
        Key: { siteId },
        UpdateExpression: "SET #s = :s, #err = :e, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status", "#err": "error" },
        ExpressionAttributeValues: {
          ":s": "failed",
          ":e": String(err?.message || err),
          ":now": Date.now(),
        },
      })
    );
    throw err;
  }
};
