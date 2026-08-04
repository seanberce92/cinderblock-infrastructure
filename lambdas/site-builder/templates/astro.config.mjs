import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

// Fixed build plumbing (not model-authored) - see index.mjs. Keeping this
// deterministic means npm run build can only fail on the model's own
// src/ content, not on wiring the model has no reason to touch per-site.
//
// base: "/dist/" - the built site is served directly from the preview
// bucket's dist/ key prefix (https://bucket.s3.../dist/index.html), not from
// a domain root, so Astro's own root-relative asset links (compiled CSS/JS
// under _astro/) need the same /dist prefix or they 404 against bucket root.
export default defineConfig({
  base: "/dist/",
  integrations: [tailwind()],
});
