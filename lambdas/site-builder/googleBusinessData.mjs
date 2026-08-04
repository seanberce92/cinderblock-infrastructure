/**
 * Resolves a user-supplied Google Business Profile / Maps URL into structured
 * contact/hours/social data, using two Google APIs under the same API key (a
 * single Google Cloud project with both Maps Grounding Lite and Places API
 * (New) enabled):
 *
 *   1. Maps Grounding Lite MCP server (`resolve_maps_urls`) resolves the
 *      arbitrary pasted URL (g.page short link, full
 *      google.com/maps/place/... URL, share link, etc) to a canonical place
 *      resource name. This is the part a plain HTML fetch can't do — Google
 *      Maps/Business listing pages are JS-rendered SPAs (see
 *      fetchContext.mjs's header comment for why fetchUrlContext alone can't
 *      read them).
 *   2. Places API (New) "Place Details" is then called with that place ID
 *      for reliable TYPED fields (phone, address, hours, website, Maps URL,
 *      rating) — the MCP's own `search_places` tool only returns free-text
 *      "AI-generated summaries," not structured data suitable for grounding
 *      hrefs/JSON-LD, so it's deliberately not used here.
 *
 * If Place Details returns a website, it's scraped (via fetchContext.mjs's
 * SSRF-safe fetchSafely) for social media links — a business's own site is
 * normal server-rendered HTML, unlike the Maps SPA.
 *
 * Every step is independently try/caught and this module NEVER throws: a
 * Google API hiccup (missing/invalid key, quota, unresolvable URL, network
 * error) must never fail a site build — same philosophy as fetchContext.mjs.
 * The caller is expected to cache the result on the site record so these
 * (paid) calls happen once per site, not on every build/revise.
 */
import { fetchSafely } from "./fetchContext.mjs";

const MCP_ENDPOINT = "https://mapstools.googleapis.com/mcp";
const PLACES_FIELD_MASK = [
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "formattedAddress",
  "regularOpeningHours.weekdayDescriptions",
  "websiteUri",
  "googleMapsUri",
  "rating",
  "userRatingCount",
].join(",");
const FETCH_TIMEOUT_MS = 8000;

const SOCIAL_DOMAINS = {
  facebook: /facebook\.com/i,
  instagram: /instagram\.com/i,
  twitter: /(?:twitter\.com|x\.com)/i,
  linkedin: /linkedin\.com/i,
  yelp: /yelp\.com/i,
  tiktok: /tiktok\.com/i,
};

/**
 * Isolated on purpose: the MCP's exact response envelope was confirmed
 * against Google's public reference docs at implementation time (JSON-RPC
 * "tools/call" -> `{ result: { entities: [{ place }], failedRequests } }`,
 * per the resolve_maps_urls reference page), NOT against a live call — no
 * API key was available to verify. If the real shape differs, this is the
 * one place to fix; a couple of alternate envelope shapes are tried
 * defensively before giving up.
 *
 * @param {any} mcpPayload
 * @returns {string | null} a place resource name, e.g. "places/ChIJ...", or null
 */
export function extractPlaceResourceName(mcpPayload) {
  const entities =
    mcpPayload?.result?.entities ??
    mcpPayload?.entities ??
    mcpPayload?.result?.content?.[0]?.entities;
  const place = Array.isArray(entities) ? entities[0]?.place : undefined;
  return typeof place === "string" && place.length > 0 ? place : null;
}

/** "places/ChIJ..." -> "ChIJ..."; passes a bare ID through unchanged. */
function placeIdFromResourceName(resourceName) {
  return resourceName.startsWith("places/")
    ? resourceName.slice("places/".length)
    : resourceName;
}

async function resolvePlaceResourceName(url, apiKey) {
  let res;
  try {
    res = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "X-Goog-Api-Key": apiKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "resolve_maps_urls", arguments: { urls: [url] } },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`resolvePlaceResourceName: MCP fetch failed: ${err}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`resolvePlaceResourceName: MCP non-2xx status ${res.status}`);
    return null;
  }
  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    console.warn(`resolvePlaceResourceName: could not parse MCP response: ${err}`);
    return null;
  }
  return extractPlaceResourceName(payload);
}

async function fetchPlaceDetails(placeId, apiKey) {
  let res;
  try {
    res = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": PLACES_FIELD_MASK,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
  } catch (err) {
    console.warn(`fetchPlaceDetails: fetch failed: ${err}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`fetchPlaceDetails: non-2xx status ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    console.warn(`fetchPlaceDetails: could not parse response: ${err}`);
    return null;
  }
}

/**
 * Pure: regex-extracts the first href matching each known social platform
 * domain out of raw HTML. Dedupes per platform (first match in document
 * order wins).
 *
 * @param {string|null|undefined} html
 * @returns {Record<string,string>}
 */
export function extractSocialLinks(html) {
  if (!html) return {};
  const hrefRe = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
  const links = {};
  let m;
  while ((m = hrefRe.exec(html))) {
    const href = m[1];
    for (const [platform, domainRe] of Object.entries(SOCIAL_DOMAINS)) {
      if (!links[platform] && domainRe.test(href)) {
        links[platform] = href;
      }
    }
  }
  return links;
}

/**
 * @param {object} args
 * @param {string|undefined} args.googleProfileUrl
 * @param {string|undefined} args.apiKey
 * @returns {Promise<object|null>} a GoogleBusinessData-shaped object, or null
 *   if nothing could be resolved (no URL, no key, or every step failed).
 */
export async function resolveGoogleBusinessData({ googleProfileUrl, apiKey }) {
  if (!googleProfileUrl || !apiKey) return null;

  let resourceName = null;
  try {
    resourceName = await resolvePlaceResourceName(googleProfileUrl, apiKey);
  } catch (err) {
    console.warn(`resolveGoogleBusinessData: MCP resolution failed: ${err}`);
  }
  if (!resourceName) return null;
  const placeId = placeIdFromResourceName(resourceName);

  let details = null;
  try {
    details = await fetchPlaceDetails(placeId, apiKey);
  } catch (err) {
    console.warn(`resolveGoogleBusinessData: Place Details failed: ${err}`);
  }
  if (!details) {
    // We at least resolved a place ID — return that much rather than nothing.
    return { placeId, resolvedAt: Date.now() };
  }

  let socialLinks;
  if (details.websiteUri) {
    try {
      const html = await fetchSafely(details.websiteUri);
      const found = extractSocialLinks(html);
      if (Object.keys(found).length > 0) socialLinks = found;
    } catch (err) {
      console.warn(`resolveGoogleBusinessData: website social-link scrape failed: ${err}`);
    }
  }

  return {
    placeId,
    phone: details.nationalPhoneNumber || details.internationalPhoneNumber || undefined,
    formattedAddress: details.formattedAddress || undefined,
    hoursWeekdayDescriptions:
      details.regularOpeningHours?.weekdayDescriptions || undefined,
    websiteUri: details.websiteUri || undefined,
    googleMapsUri: details.googleMapsUri || undefined,
    rating: details.rating ?? undefined,
    userRatingCount: details.userRatingCount ?? undefined,
    socialLinks,
    resolvedAt: Date.now(),
  };
}
