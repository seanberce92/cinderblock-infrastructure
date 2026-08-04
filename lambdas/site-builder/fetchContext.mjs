/**
 * SSRF-safe best-effort fetch of external context for the optional
 * "inspiration URL" and "Google profile" form fields. These are user-supplied
 * URLs fetched server-side from a Lambda with default internet egress — that's
 * a classic SSRF surface (most notably the AWS IMDS endpoint at
 * 169.254.169.254), so every hostname/IP is validated before AND after every
 * redirect hop, with a scheme allowlist, timeout, and response-size cap.
 *
 * This module NEVER throws. Any failure (bad scheme, private/reserved IP,
 * timeout, oversized body, network error, no usable content) resolves to
 * `null` and logs a warning — a bad or unreachable URL must never fail the
 * site build.
 *
 * Known limitation: Google Business/Maps listing pages are JS-rendered SPAs
 * with no meaningful static HTML, so `googleProfile` fetches will frequently
 * return null or near-empty signal. That's expected, not a bug — a real fix
 * would need a headless-browser/screenshot service or the paid Google Places
 * API, neither of which is in scope here.
 */
import dns from "node:dns/promises";
import net from "node:net";

const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 512 * 1024; // 512KB cap
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// IP range validation
// ---------------------------------------------------------------------------

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InCidr(ip, base, prefixLen) {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// RFC1918 private, loopback, link-local (incl. AWS IMDS 169.254.169.254),
// CGNAT, IETF reserved/test-net/benchmarking ranges, multicast, broadcast.
const IPV4_BLOCKED_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function isBlockedIpv4(ip) {
  return IPV4_BLOCKED_RANGES.some(([base, prefixLen]) => ipv4InCidr(ip, base, prefixLen));
}

/** Expands an IPv6 address to 8 16-bit hextets, handling "::" compression. */
function expandIpv6(ip) {
  const clean = ip.replace(/^\[|\]$/g, "");
  const [head, tail] = clean.includes("::") ? clean.split("::") : [clean, null];
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];

  const parseHextet = (h) => {
    // Trailing part may be an embedded IPv4 (e.g. "::ffff:169.254.169.254")
    if (h.includes(".")) {
      const v4 = ipv4ToInt(h);
      if (v4 === null) return null;
      return [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    }
    const n = parseInt(h, 16);
    return Number.isNaN(n) ? null : [n];
  };

  const headHextets = [];
  for (const h of headParts) {
    const parsed = parseHextet(h);
    if (parsed === null) return null;
    headHextets.push(...parsed);
  }
  const tailHextets = [];
  for (const h of tailParts) {
    const parsed = parseHextet(h);
    if (parsed === null) return null;
    tailHextets.push(...parsed);
  }

  if (tail === null) {
    // No "::" compression present
    return headHextets.length === 8 ? headHextets : null;
  }
  const fillLen = 8 - headHextets.length - tailHextets.length;
  if (fillLen < 0) return null;
  return [...headHextets, ...new Array(fillLen).fill(0), ...tailHextets];
}

function isBlockedIpv6(ip) {
  const h = expandIpv6(ip);
  if (!h) return true; // unparsable — fail closed

  const allZero = h.every((x) => x === 0);
  if (allZero) return true; // :: (unspecified)
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (ULA)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64 discard

  // ::ffff:a.b.c.d — IPv4-mapped; unwrap and re-check against the v4 list.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    const v4 = `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }
  // 64:ff9b::/96 — NAT64 well-known prefix; unwrap similarly.
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    const v4 = `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }
  return false;
}

/** True if `ip` is private, loopback, link-local, or otherwise reserved. */
export function isPrivateOrReservedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a recognizable IP — fail closed
}

/** Resolves hostname via DNS; rejects if it's a blocked IP literal or ANY resolved address is blocked. */
async function resolveAndValidate(hostname) {
  if (net.isIP(hostname)) {
    return !isPrivateOrReservedIp(hostname);
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (records.length === 0) return false;
  return records.every((r) => !isPrivateOrReservedIp(r.address));
}

// ---------------------------------------------------------------------------
// Fetch + extraction
// ---------------------------------------------------------------------------

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Fallback for environments without a streaming body reader.
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    /* best-effort */
  }
  return out;
}

function extractMeta(html) {
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.trim().slice(0, 200);

  const metaPatterns = [
    /<meta\s+[^>]*?(?:name|property)=["'](?:description|og:description)["'][^>]*?content=["']([^"']*)["']/i,
    /<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:name|property)=["'](?:description|og:description)["']/i,
  ];
  let description;
  for (const re of metaPatterns) {
    const m = re.exec(html);
    if (m?.[1]) {
      description = m[1].trim().slice(0, 400);
      break;
    }
  }

  if (!title && !description) return null;
  return { title, description };
}

/**
 * SSRF-safe fetch of raw response body text, with the full validate-every-hop
 * treatment (scheme allowlist, DNS/IP validation before AND after every
 * redirect, timeout, capped streaming read). This is the single safe-fetch
 * primitive for this Lambda — anything else that needs to fetch a
 * user-supplied URL server-side (e.g. googleBusinessData.mjs scraping a
 * business's own website for social links) should call this rather than
 * hand-rolling a second SSRF implementation.
 *
 * Never throws: any failure (bad scheme, private/reserved IP, timeout,
 * oversized body, network error) resolves to `null` and logs a warning.
 *
 * @param {string|undefined} url
 * @returns {Promise<string | null>} raw response body text, or null
 */
export async function fetchSafely(url) {
  if (!url) return null;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      console.warn(`fetchSafely: invalid URL, skipping`);
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.warn(`fetchSafely: unsupported scheme ${parsed.protocol}, skipping`);
      return null;
    }

    const safe = await resolveAndValidate(parsed.hostname);
    if (!safe) {
      console.warn(`fetchSafely: blocked private/reserved host, skipping`);
      return null;
    }

    let res;
    try {
      res = await fetch(parsed.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "Cinderblock-SiteBuilder/1.0" },
      });
    } catch (err) {
      console.warn(`fetchSafely: fetch failed: ${err}`);
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      current = new URL(location, parsed).toString();
      continue; // re-validate the new host on the next loop iteration
    }

    if (!res.ok) {
      console.warn(`fetchSafely: non-2xx status ${res.status}`);
      return null;
    }

    try {
      return await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      console.warn(`fetchSafely: failed reading body: ${err}`);
      return null;
    }
  }

  console.warn(`fetchSafely: too many redirects, skipping`);
  return null;
}

/**
 * @param {string|undefined} url
 * @returns {Promise<{title?: string, description?: string} | null>}
 */
export async function fetchUrlContext(url) {
  const body = await fetchSafely(url);
  if (body === null) return null;
  return extractMeta(body);
}
