/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { Brand, brandize } from '~/components/Brand.tsx';
import { CallTabs } from '~/components/CallTabs.tsx';
import { Callout } from '~/components/Callout.tsx';
import { Challenge } from '~/components/Challenge.tsx';
import { Cite } from '~/components/Cite.tsx';
import { Code } from '~/components/Code.tsx';
import {
  ChartOfAccounts,
  CreditMaturity,
  HashChain,
  IdempotentRetry,
  PayoutSaga,
  RateLadder,
  SubmitPipeline,
  SubscriptionStates,
  WorkerSweeps,
} from '~/components/Diagrams.tsx';
import { Runnable } from '~/components/Runnable.tsx';
import { SourceLink } from '~/components/SourceLink.tsx';
import { type TocEntry, docBySlug } from '~/content.ts';
import { crumbsFor, prevNext } from '~/nav.ts';
import { sourceUrl } from '~/repo.ts';

// Custom components available to every page's MDX without a per-file import.
const MDX_COMPONENTS = {
  CallTabs,
  Callout,
  Challenge,
  ChartOfAccounts,
  PayoutSaga,
  SubscriptionStates,
  HashChain,
  RateLadder,
  SubmitPipeline,
  WorkerSweeps,
  CreditMaturity,
  IdempotentRetry,
  SourceLink,
  Runnable,
  Cite,
  Brand,
  Code,
};

/**
 * One source-reference chip: the file path plus a muted symbol. The stored ref is `path#Lnn · symbol`,
 * where `·` is {@link sourceUrl}'s separator rather than display text, so it's split out here.
 */
function SourceChip({ refStr }: { refStr: string }) {
  const href = sourceUrl(refStr);
  const dot = refStr.indexOf('·');
  const path = dot >= 0 ? refStr.slice(0, dot).trim() : refStr;
  const sym = dot >= 0 ? refStr.slice(dot + 1).trim() : '';
  const body = (
    <code>
      {path}
      {sym ? <span className="chip-sym">{sym}</span> : null}
    </code>
  );
  return href ? (
    <a className="source-chip" href={href} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  ) : (
    <span className="source-chip">{body}</span>
  );
}

/** A begriffs-style on-page table of contents: a static list of anchor links, shown only once the page has enough sections to earn it. Zero JS. */
function PageToc({ toc }: { toc: TocEntry[] }) {
  if (toc.length < 3) return null;
  return (
    <nav className="page-toc" aria-label="On this page">
      <p className="page-toc-label">Contents</p>
      <ul>
        {toc.map((h) => (
          <li key={h.id ?? h.value}>
            <a href={`#${h.id}`}>{h.value}</a>
            {h.children && h.children.length > 0 && (
              <ul>
                {h.children.map((c) => (
                  <li key={c.id ?? c.value}>
                    <a href={`#${c.id}`}>{c.value}</a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The shared leaf-page renderer. Every section route (concept, operation, reference page, port,
 * scope) resolves its slug and hands it here, so the page chrome — breadcrumb, title, status, source
 * links, the compiled MDX body, "see also", and prev/next — lives in one place. A slug that resolves
 * to nothing renders an inline notice rather than throwing: a bad URL is routine.
 *
 * The status badge and the draft callout both read the single `status` frontmatter field, so they can
 * never fall out of step — set `status: stable` and both disappear together.
 */
export function DocPage({ slug }: { slug: string }) {
  const doc = docBySlug(slug);
  if (!doc) {
    return (
      <article className="prose doc">
        <h1>Page not found</h1>
        <p>
          <a href="/economy/">← Back to the economy docs</a>
        </p>
      </article>
    );
  }

  const { Component } = doc;
  const crumbs = crumbsFor(slug);
  const { prev, next } = prevNext(slug);

  return (
    <article className="prose doc">
      <nav className="crumb" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={c.href}>
            {i > 0 && <span className="crumb-sep"> / </span>}
            <a href={c.href}>{c.label}</a>
          </span>
        ))}
      </nav>

      <h1>{doc.title}</h1>
      {doc.status !== 'stable' && (
        <p className={`status-badge status-${doc.status}`}>
          {doc.status === 'draft' ? 'Draft' : 'Planned'}
        </p>
      )}
      <p className="doc-summary">{brandize(doc.summary)}</p>

      {doc.plain && (
        <p className="doc-plain">
          {brandize(doc.plain)}
          {doc.plainCite && <Cite n={doc.plainCite} />}
        </p>
      )}

      {doc.sourceRefs.length > 0 && (
        <p className="source-refs">
          <span className="source-label">Source</span>{' '}
          {doc.sourceRefs.map((r) => (
            <SourceChip key={r} refStr={r} />
          ))}
        </p>
      )}

      {doc.status === 'draft' && (
        <aside className="callout callout-draft">
          <strong>Draft.</strong> This page is scaffolded — its canonical prose is still being
          authored. The slug, frontmatter, and source links above are already in place.
        </aside>
      )}
      {doc.status === 'planned' && (
        <aside className="callout callout-planned">
          <strong>Planned.</strong> This page is not written yet.
        </aside>
      )}

      <PageToc toc={doc.toc} />

      <Component components={MDX_COMPONENTS} />

      {doc.related.length > 0 && (
        <section className="see-also">
          <h2>See also</h2>
          <ul>
            {doc.related.map((s) => {
              const r = docBySlug(s);
              return r ? (
                <li key={s}>
                  <a href={`/${s}/`}>{r.title}</a>
                </li>
              ) : null;
            })}
          </ul>
        </section>
      )}

      {doc.notes.length > 0 && (
        <section className="footnotes" aria-labelledby="notes-label">
          <p id="notes-label" className="footnotes-label">
            Notes
          </p>
          <ol>
            {doc.notes.map((note, i) => {
              const n = i + 1;
              return (
                <li key={note.text} id={`note-${n}`}>
                  {brandize(note.text)}{' '}
                  {note.href && (
                    <a href={note.href} target="_blank" rel="noopener noreferrer">
                      source
                    </a>
                  )}{' '}
                  <a
                    className="footnote-back"
                    href={`#cite-${n}-ref`}
                    aria-label="Back to citation"
                  >
                    ↩
                  </a>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {(prev || next) && (
        <nav className="prev-next" aria-label="Pagination">
          {prev ? (
            <a className="pn-prev" href={`/${prev.slug}/`}>
              <span className="pn-label">Previous</span>
              {prev.title}
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a className="pn-next" href={`/${next.slug}/`}>
              <span className="pn-label">Next</span>
              {next.title}
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}
    </article>
  );
}
