/**
 * Post-generation link-safety lint for the model's generated Astro files.
 * Pure, no AWS SDK — fully unit-testable. Flags placeholder/dead hrefs and
 * broken social-share-preview meta tags before a site ships; index.mjs uses
 * this to trigger one corrective regeneration pass (see prompts/system.md's
 * "Social share preview" and "Grounding data & link safety rules" sections
 * for the rules this enforces).
 *
 * Href checks deliberately do NOT flag `tel:`, `mailto:`, or absolute
 * `http(s)://` links — only same-page `#anchor` links (which must resolve to
 * a real `id` in the same output) and placeholder values.
 */

const HREF_RE = /href\s*=\s*["']([^"']*)["']/gi;
const ID_RE = /\bid\s*=\s*["']([^"']+)["']/gi;
const META_TAG_RE = /<meta\s+[^>]*>/gi;

const PLACEHOLDER_VALUES = new Set(["", "#", "undefined", "null"]);

// og:image/twitter:image are only required when the model actually emits
// them (no images uploaded is a legitimate reason to omit both — see
// prompts/system.md); og:url is unconditionally required. All three, when
// present, must be a full absolute URL — crawlers fetch them directly and
// don't resolve relative paths against the page.
const ABSOLUTE_ONLY_META_KEYS = new Set(["og:image", "twitter:image", "og:url"]);

function parseMetaTag(tag) {
  const keyMatch = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
  const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
  return { key: keyMatch?.[1], content: contentMatch?.[1] };
}

/**
 * @param {Record<string,string>} files - {path: content} map, e.g. the
 *   output of bedrock.mjs's extractFiles for MODEL_FILE_PATHS
 * @returns {{type: "placeholder"|"broken-anchor"|"relative-share-meta"|"missing-og-url", href: string, file: string, meta?: string}[]}
 */
export function findLinkIssues(files) {
  const combined = Object.values(files).join("\n");
  const ids = new Set();
  let m;
  ID_RE.lastIndex = 0;
  while ((m = ID_RE.exec(combined))) ids.add(m[1]);

  const issues = [];
  let sawOgUrl = false;

  for (const [file, content] of Object.entries(files)) {
    HREF_RE.lastIndex = 0;
    while ((m = HREF_RE.exec(content))) {
      const raw = m[1];
      const href = raw.trim();
      if (PLACEHOLDER_VALUES.has(href)) {
        issues.push({ type: "placeholder", href: raw, file });
        continue;
      }
      if (href.startsWith("#")) {
        const anchor = href.slice(1);
        if (!anchor || !ids.has(anchor)) {
          issues.push({ type: "broken-anchor", href, file });
        }
      }
    }

    META_TAG_RE.lastIndex = 0;
    while ((m = META_TAG_RE.exec(content))) {
      const { key, content: metaContent } = parseMetaTag(m[0]);
      if (!key || !ABSOLUTE_ONLY_META_KEYS.has(key)) continue;
      if (key === "og:url") sawOgUrl = true;
      if (!metaContent || !/^https?:\/\//i.test(metaContent)) {
        issues.push({
          type: "relative-share-meta",
          meta: key,
          href: metaContent ?? "",
          file,
        });
      }
    }
  }

  if (!sawOgUrl) {
    issues.push({
      type: "missing-og-url",
      meta: "og:url",
      href: "",
      file: "src/layouts/Base.astro",
    });
  }

  return issues;
}

/**
 * @param {{type: string, href: string, file: string, meta?: string}[]} issues
 * @returns {string} an `instructions` string for a corrective generateSiteFiles call
 */
export function describeIssuesForPrompt(issues) {
  const lines = issues.map((issue) => {
    if (issue.type === "placeholder") {
      return (
        `- In ${issue.file}: an element has href="${issue.href}", a dead ` +
        `placeholder link. Either point it at a real in-page #anchor/tel:/` +
        `mailto:/provided URL from the data, or remove that element entirely.`
      );
    }
    if (issue.type === "broken-anchor") {
      return (
        `- In ${issue.file}: href="${issue.href}" points at an anchor with no ` +
        `matching id="..." anywhere in the page. Either add that id to the right ` +
        `section, or fix the href to point at a section that actually exists.`
      );
    }
    if (issue.type === "relative-share-meta") {
      return (
        `- In ${issue.file}: <meta property="${issue.meta}" content="${issue.href}"> ` +
        `is not a full absolute https://... URL. Link-preview crawlers (Facebook, ` +
        `X, Slack, iMessage, etc) fetch this value directly and do NOT resolve ` +
        `relative paths against the page, so it must be "https://" + the exact ` +
        `Domain value from the business data + the asset's path. Fix it to a real ` +
        `absolute URL, or remove the tag if there's no real image/URL to point it at.`
      );
    }
    // missing-og-url
    return (
      `- ${issue.file} is missing a <meta property="og:url" content="..."> tag ` +
      `entirely. Add it with the absolute site URL: "https://" + the exact Domain ` +
      `value from the business data + "/".`
    );
  });
  return (
    `Fix ONLY these broken/placeholder links and social-preview meta tags, ` +
    `changing nothing else:\n${lines.join("\n")}\n` +
    `Every href must end up being a real in-page #anchor with a matching id, ` +
    `a tel:/mailto: link, or one of the URLs given in the grounding data — ` +
    `never "#" or empty. Every og:/twitter: meta tag's content must be a full ` +
    `"https://..." URL, never relative or empty. If there's no real data to ` +
    `ground an element in, remove that element instead of leaving it broken.`
  );
}
