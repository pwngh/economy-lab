# economy-lab-docs

Documentation site for [economy-lab](https://github.com/pwngh/economy-lab) — _correctness in systems that move money._

A static, prerendered docs site (React Router 7 + Vite + MDX) that ships **zero client JavaScript** on content pages and deploys to Cloudflare Pages as flat HTML.

## Develop

```sh
npm install
npm run dev        # local dev server
npm run build      # prerender to build/client/
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

Cloudflare Pages, direct upload: `npm run deploy` builds and `wrangler pages deploy`s `build/client/`. Node is pinned to 22 via `.node-version`.
