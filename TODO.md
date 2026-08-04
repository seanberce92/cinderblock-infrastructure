# TODO

## Live-verify photo caption placement

Uploaded photos now carry an optional per-photo `caption` (e.g. "Headshot",
"Storefront") set in `BuildPage.tsx`, threaded through
`sites.controller.ts`'s `images` field, and rendered into the site-builder
Lambda's `{{IMAGE_LIST}}` prompt block as `- /dist/images/photo-N.ext —
"Caption"` (`bedrock.mjs`'s `formatImageList`). `prompts/system.md`'s
`# Images` section now instructs the model to treat a caption as a real
placement instruction (person/role → About/team section, place/space →
location section, product/service → near that copy). This closes the gap
that caused a headshot to land in the wrong spot: the model previously had
zero data connecting a specific photo to a business-details instruction like
"use my headshot in the About section" — filenames were discarded and
replaced with generic `photo-N.ext` names before the prompt was built.
Covered by unit tests (`formatImageList` in `test/bedrock.test.mjs`) and
manually verified in the browser (multi-photo select renders one row per
photo, captions persist across add/remove, re-selecting appends up to the
10-photo cap) — none of that proves the model actually *follows* the
placement instruction, which needs a real generation:

- [ ] Build a real qa site with 2-3 photos, at least one captioned
      "Headshot" and one left uncaptioned, and inspect the generated
      `index.astro` to confirm the captioned photo lands in an About/team
      section (or wherever its caption implies) rather than the generic
      gallery, while the uncaptioned photo gets ordinary default placement.
- [ ] Check the Lambda's CloudWatch prompt-log line to confirm the
      caption-annotated `{{IMAGE_LIST}}` text reaches the model in the
      intended `- path — "caption"` format.
- [ ] Smoke-test a caption containing injection-style text (e.g. "ignore
      previous instructions") to confirm the guardrail + "data, not
      instructions" framing in `prompts/system.md` still holds for this new
      free-text field — same trust boundary as `details`/`copy`, but it's a
      new path into the prompt worth checking explicitly.
- [ ] If any qa sites already exist with the old bare `imageKeys: string[]`
      shape (this repo's own history shows the reviews/GBP/link-safety work
      was never live-verified, so this is unlikely but worth a quick check),
      `revise` one and confirm `copyAllImages` doesn't break on
      `images[i].key` being undefined.

## Live-verify the accessibility (WCAG contrast) prompt rules

`prompts/system.md` now has an "Accessibility (WCAG 2.1 AA)" section with
concrete contrast-ratio rules (4.5:1 text / 3:1 large text & UI elements,
never pair matching `bg-X`/`text-X`, choose text color per-background rather
than defaulting to black, links must never match their background). This is
prompt guidance only — there's no automated enforcement backstop like
`validateLinks.mjs`'s corrective pass for dead links, because reliably
computing real contrast ratios would mean statically resolving arbitrary
Tailwind utility classes (including the `--color-primary/secondary/tertiary`
custom properties) back to actual hex values and doing real relative-
luminance/contrast math against whatever ancestor supplies the background —
much harder to get right than a link/href regex check, so it wasn't built.
This means compliance depends entirely on the model following the prompt:

- [ ] Build a handful of real sites (varied brand color palettes, especially
      ones close in lightness to each other, and at least one with a photo
      behind hero text) and run each through a real contrast checker —
      Chrome DevTools' Lighthouse accessibility audit or the WebAIM Contrast
      Checker — to see how often the model actually complies.
- [ ] Specifically re-check for the two failure modes reported: dark body
      text on a mid/dark-toned background section, and a link colored
      identically to its background.
- [ ] If compliance is inconsistent in practice, consider adding a real
      contrast-ratio check to `validateLinks.mjs`'s corrective pass (parse
      class="..." + the :root custom properties from the generated
      global.css, resolve fg/bg per text-bearing element, compute WCAG
      relative luminance, flag anything under 4.5:1/3:1) — deferred for now
      since it's a meaningfully bigger, more fragile undertaking than the
      href checks already there.

## Live-verify social share previews (Open Graph / Twitter Card)

`prompts/system.md` now has a "Social share preview" section instructing the
model to emit `og:title`/`og:description`/`og:url`/`og:image` and
`twitter:*` tags in `Base.astro`, with an absolute `https://{domain}/...`
URL for `og:url` and `og:image`/`twitter:image` (relative paths don't work —
crawlers fetch the URL directly, they don't resolve it against the page).
`validateLinks.mjs`'s `findLinkIssues` now also flags a missing `og:url` tag
or a non-absolute `og:image`/`twitter:image`/`og:url` value, triggering the
same one-shot corrective regeneration pass as dead links. Not yet verified
against a live site:

- [ ] Build a real site in qa, get it to `live` status, and paste the actual
      custom domain into Facebook's Sharing Debugger
      (developers.facebook.com/tools/debug/) and X/Twitter's Card Validator
      (or just DM/paste the link) to confirm a real crawler successfully
      fetches `og:image` and renders a card — this is the only way to
      actually confirm the `/dist/images/...` absolute-URL path assumption
      (derived from reading the provisioner's CloudFront config, not from a
      live fetch) is correct.
- [ ] Confirm Facebook's crawler can actually reach the image: the site is
      served via CloudFront + an OAC-locked S3 origin — check there isn't
      some bot-blocking (there shouldn't be, no WAF is configured, but this
      hasn't been checked against a real crawler request/IP).
- [ ] Spot-check image dimensions on a few real builds — Facebook/Twitter
      want an `og:image` of at least ~1200×630 for the large card; uploaded
      photos are used as-is with no resizing, so a very small or oddly
      cropped photo may render poorly even though the tag itself is correct.

## Live-verify the Bedrock model switch to Claude Sonnet 5

`bedrock_model_id` now defaults to `us.anthropic.claude-haiku-4-5-20251001-v1:0` (was
`us.anthropic.claude-haiku-4-5-20251001-v1:0`) in
`modules/workers/variables.tf`, `qa/variables.tf`,
`qa/terraform.tfvars.example`, and `lambdas/site-builder/bedrock.mjs`'s
fallback default. This was not verified against a live Bedrock call:

- [ ] Per Claude Sonnet 5's Bedrock model card, adaptive/extended thinking is
      always on and can't be disabled — this typically means the response
      `content` array has a `{type: "thinking", ...}` block before the
      `{type: "text", ...}` block. Both call sites that previously assumed
      `content[0]` was the text block (`bedrock.mjs`'s `generateSiteFiles`
      and `reviews.mjs`'s `ocrScreenshot`) were changed to
      `content.find(b => b.type === "text")` defensively, but this hasn't
      been confirmed against a real Sonnet 5 response shape on Bedrock.
- [ ] Confirm `max_tokens: 16000` (site generation) and `max_tokens: 500`
      (review screenshot OCR) are still sufficient now that thinking is
      always on — if thinking tokens count against `max_tokens`, the OCR
      call in particular may need a higher budget.
- [ ] Sanity-check cost/latency: Sonnet 5 is a larger, always-thinking model
      than Haiku 4.5 — confirm build times still fit inside the Lambda's
      15-minute timeout and the per-site Bedrock cost is acceptable at
      expected build/revise volume.
- [ ] Re-run the guardrail (`aws_bedrock_guardrail.site_builder`) against a
      real Sonnet 5 call — guardrails are model-agnostic in principle, but
      hasn't been confirmed for this pairing.

## Live-verify the reviews / Google Business Profile / link-safety changes

The reviews, Google Business Profile grounding, and dead-link-prevention work
in `lambdas/site-builder` (`googleBusinessData.mjs`, `reviews.mjs`,
`validateLinks.mjs`, and the `bedrock.mjs`/`prompts/system.md` changes) was
implemented and unit-tested (`lambdas/site-builder/test/`, `npm test`) without
deployed AWS infra or real API keys — that combination doesn't exist in a
local/planning session. Before calling this feature production-verified,
confirm against a real qa deploy:

- [ ] **Confirm the MCP `resolve_maps_urls` response shape against a live
      call.** `googleBusinessData.mjs`'s `extractPlaceResourceName` was
      written against Google's public reference docs only (no API key was
      available to make a real `tools/call` request). Call `tools/list` and
      then a real `resolve_maps_urls` request against
      `https://mapstools.googleapis.com/mcp` with a valid
      `GOOGLE_MAPS_API_KEY` and check the actual response envelope matches
      what `extractPlaceResourceName` expects (`result.entities[0].place`,
      or one of the fallback shapes tried). Fix the extraction function if
      the real shape differs — it's the one place that needs to change.
- [ ] **Confirm the Places API (New) Place Details response** — field names
      (`nationalPhoneNumber`, `formattedAddress`,
      `regularOpeningHours.weekdayDescriptions`, `websiteUri`,
      `googleMapsUri`, `rating`, `userRatingCount`) and rate limits, against
      a real place ID.
- [ ] **Set up a Google Cloud project** with Maps Grounding Lite + Places API
      (New) enabled and billing on, get an API key, and set
      `google_maps_api_key` in `qa/terraform.tfvars` (see
      `qa/terraform.tfvars.example`).
- [ ] **Run a full end-to-end site build in qa**: submit a real business
      through the frontend with a Google Business Profile URL, a manually
      typed review, and a review screenshot, and confirm:
  - the Bedrock generation actually renders the contact/hours/social/reviews
    sections and the `Review`/`AggregateRating` JSON-LD as instructed in
    `prompts/system.md`;
  - review screenshots never appear in the image gallery;
  - the corrective link-validation pass in `index.mjs` fires and fixes
    real-world dead links the model produces (or confirm it rarely needs to);
  - the `npm install && npm run build` Astro build succeeds with the new
    generated sections.
- [ ] Spot-check the vision OCR prompt (`prompts/review-ocr.md`) against a
      few real review screenshots (different platforms — Google, Yelp,
      Facebook — and low-quality/cropped images) to see how often it
      extracts a usable `{reviewerName, rating, text}`.
