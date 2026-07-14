# economy-lab-docs

Documentation site for [economy-lab](https://github.com/pwngh/economy-lab) — _correctness in systems that move money._

A static, prerendered docs site (React Router 7 + Vite + MDX) that ships **zero client JavaScript** on content pages (hydration is guarded by `check:static`; the runnable-snippet enhancer loads its engine only on the first Run click) and deploys as flat HTML — composed with the console app into one static site.

## Develop

```sh
npm install
npm run dev        # this app alone; `npm run site:dev` at the repo root runs docs + console on one origin
npm run build      # snippet runner, then prerender to build/client/
npm test           # vitest, incl. the slug-contract guard
npm run verify     # typecheck + lint + test
```

## Add or edit a page

Pages are MDX under `app/content/economy/<section>/<slug>.mdx`; the file path mirrors the URL one-to-one. Each starts with frontmatter:

```mdx
---
title: 'Spend'
summary: 'A marketplace sale: the buyer spends, the seller earns, the platform fee is split out.'
order: 20
status: stable # stable | draft | planned (a display badge)
sourceRefs: ['src/operations/spend.ts#L65 · spend', 'src/pricing.ts#L51 · splitLegs']
related: ['economy/concepts/money-model', 'economy/reference/outcomes-and-reason-codes']
---

Body in Markdown/MDX.
```

It then appears in the sidebar, its section index, the prev/next sequence, and the sitemap automatically. `draft: true` keeps a page out of production builds; `status` is only a display badge, so a `status: draft` page still ships (visibly marked in-progress).

## Deploy

The deployable is the composed one-origin site (docs at `/`, console at `/console/`), assembled at the repo root: `npm run site` builds it into `dist-site/`, and `npm run site:deploy` runs both apps' verify suites, the CSP/static/bundle-budget gates, then `wrangler pages deploy`s it (direct upload; `wrangler.jsonc` points at `../../dist-site`). A manual-trigger GitHub Pages workflow (`.github/workflows/pages.yml`) ships the identical artifact. Node is pinned to 22 via `.node-version`.
