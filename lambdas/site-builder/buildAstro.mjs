/**
 * Shared Astro+Tailwind workspace helpers used by both the site-builder Lambda
 * (build for the pre-payment preview) and the provisioner Lambda (rebuild from
 * the bucket's stored source right before going live). Kept as a plain file
 * copied into both Lambda zips (see build-lambda.sh) rather than a shared
 * package, since each Lambda is packaged independently with no node_modules
 * linking between them.
 *
 * Runs `npm install` / `npm run build` for real, inside the Lambda execution
 * environment. Relies on the Node.js managed runtime's bundled npm binary and
 * outbound internet access (these functions are not attached to a VPC), and
 * requires HOME/npm cache to be redirected to /tmp since only /tmp is writable.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

/** Thrown when `npm install` or `npm run build` exits non-zero. */
export class BuildError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "BuildError";
    if (cause) this.cause = cause;
  }
}

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
};

export function contentTypeForPath(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

/** Writes a {relativePath: content} map into workspaceDir, creating directories as needed. */
export function writeFilesToWorkspace(workspaceDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const dest = path.join(workspaceDir, relPath);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf-8");
  }
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/** Recursively uploads every file under localDir to bucket, prefixed with keyPrefix (no trailing slash). */
export async function uploadDirToBucket(s3, bucket, localDir, keyPrefix = "") {
  for (const rel of walkFiles(localDir)) {
    const key = keyPrefix ? `${keyPrefix}/${rel}` : rel;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: readFileSync(path.join(localDir, rel)),
        ContentType: contentTypeForPath(rel),
        CacheControl: "no-cache",
      })
    );
  }
}

/**
 * Recursively downloads every object under the bucket root (excluding any key
 * starting with an excludePrefix, e.g. "dist/") into localDir, mirroring key
 * paths as relative file paths.
 */
export async function downloadSourceToWorkspace(s3, bucket, localDir, { excludePrefixes = [] } = {}) {
  let ContinuationToken;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken })
    );
    for (const obj of listed.Contents || []) {
      const key = obj.Key;
      if (excludePrefixes.some((p) => key === p || key.startsWith(`${p}/`))) continue;
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = Buffer.from(await res.Body.transformToByteArray());
      const dest = path.join(localDir, key);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, body);
    }
    ContinuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

/** Wipes and recreates an empty workspace directory (warm Lambda containers reuse /tmp across invocations). */
export function resetWorkspace(workspaceDir) {
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(workspaceDir, { recursive: true });
}

/**
 * Runs `npm install` then `npm run build` in workspaceDir. HOME and the npm
 * cache are redirected under workspaceDir's own /tmp tree since the Lambda
 * execution role can only write to /tmp.
 * @param {string} workspaceDir
 * @param {number} timeoutMs - hard ceiling per command; keep well under the
 *   Lambda's remaining execution time.
 * @throws {BuildError}
 */
export function runNpmInstallAndBuild(workspaceDir, { timeoutMs = 480_000 } = {}) {
  const env = {
    ...process.env,
    HOME: "/tmp",
    npm_config_cache: "/tmp/.npm-cache",
    npm_config_update_notifier: "false",
  };
  const opts = { cwd: workspaceDir, env, timeout: timeoutMs, stdio: "pipe" };

  try {
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], opts);
  } catch (err) {
    throw new BuildError(
      `npm install failed: ${err.stderr?.toString().slice(0, 2000) || err.message}`,
      { cause: err }
    );
  }

  try {
    execFileSync("npm", ["run", "build", "--loglevel=error"], opts);
  } catch (err) {
    throw new BuildError(
      `npm run build failed: ${err.stderr?.toString().slice(0, 2000) || err.message}`,
      { cause: err }
    );
  }
}
