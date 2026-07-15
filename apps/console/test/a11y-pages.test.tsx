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

// @vitest-environment jsdom

import axe from 'axe-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { expect, it } from 'vitest';

import { buildEngine } from '~/economy.ts';
import { recordCalls } from '~/xray.ts';
import Accounts from '../app/routes/accounts';
import Controls from '../app/routes/controls';
import Developers from '../app/routes/developers';
import Integrity from '../app/routes/integrity';
import Ledger from '../app/routes/ledger';
import TxnDetail from '../app/routes/ledger.txn.$id';
import Market from '../app/routes/market';
import Overview from '../app/routes/overview';
import Payouts from '../app/routes/payouts';
import Pipeline from '../app/routes/pipeline';

import type { ComponentType } from 'react';

// Real loader data from a fresh seeded engine, rendered through a router stub (the pages use
// Link/useSearchParams), then run through axe. color-contrast is off: jsdom has no canvas.
async function violationsOf(Page: ComponentType<never>, data: unknown) {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: () => {
        const P = Page as ComponentType<{ loaderData: never }>;
        return <P loaderData={data as never} />;
      },
    },
  ]);
  // Wrapped in <main> as the chrome does, so the landmark rule checks the page, not the harness.
  document.body.innerHTML = `<main>${renderToStaticMarkup(<Stub />)}</main>`;
  const result = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help}`);
}

// axe over every page state outruns the default 5s on slower CI machines.
it(
  'every seeded page renders with no axe violations',
  { timeout: 60_000 },
  async () => {
    const eco = await buildEngine();

    const [
      walletPage,
      accounts,
      solvency,
      ledger,
      payouts,
      counts,
      prove,
      status,
    ] = await Promise.all([
      eco.wallets({ offset: 0, limit: 8 }),
      eco.platformAccounts(),
      eco.solvency(),
      eco.ledger({ offset: 0, limit: 50 }),
      eco.payouts({ offset: 0, limit: 50 }),
      eco.payoutCounts(),
      eco.prove(),
      eco.status(),
    ]);
    const settings = eco.settings();
    const users = walletPage.rows.map((w) => w.userId);
    const subscriptions = await eco.subscriptions();
    const mkt = {
      status,
      settings,
      users,
      subscriptions,
      flash: null,
      raceTally: null,
    };

    // Saga drill: a real (terminal) payout opened, with its postings.
    const failedPayout = payouts.rows.find((p) => p.state === 'FAILED');
    const sagaDetail = failedPayout
      ? await eco.sagaDetail(failedPayout.id)
      : null;

    // Event pipeline: real delivered events after a relay run.
    await eco.runRelay();
    const pipelineData = {
      delivered: eco.pipeline().delivered,
      wallets: walletPage.rows,
      flash: null,
    };
    const pipelineInvalid = {
      kind: 'invalid',
      message: 'Please fix the highlighted fields.',
      fields: { eventId: 'A provider event id is required.' },
      form: 'pipeline-webhook',
    };

    // Ledger explorer drill: a real posting and one account's statement + chain + checkpoint.
    const txnId = ledger.rows[0].id;
    const posting = await eco.posting(txnId);
    if (posting === null) {
      throw new Error('seed produced no postings');
    }
    const drillAccount = posting.legs[0].account;
    const [statement, lineage, checkpoint] = await Promise.all([
      eco.statement(drillAccount),
      eco.lineage(drillAccount),
      eco.checkpoint(),
    ]);
    const txnBase = { txnId, account: null, posting, checkpoint: null };

    // Ledger search: a txn-id hit, a checkpoint hit (the richest result), and a clean miss.
    const searchTxn = await eco.find(txnId);
    const searchCheckpoint = checkpoint
      ? await eco.find(checkpoint.root)
      : null;

    // Controls: the rate desk locked (seed has payouts in flight) and, synthetically, unlocked.
    const rateBoard = await eco.rateBoard();
    const rateBoardOpen = {
      ...rateBoard,
      locked: false,
      inFlightPayouts: 0,
      paused: true,
    };

    // Developers X-ray: the recorded engine calls the page's own loader would make.
    const xrayCalls: unknown[] = [];
    const xrayEco = recordCalls(eco, xrayCalls as never);
    await Promise.all([
      xrayEco.solvency(),
      xrayEco.prove(),
      xrayEco.wallets({ offset: 0, limit: 8 }),
      xrayEco.status(),
      xrayEco.checkpoint(),
    ]);

    // Error and notice states, not just happy paths: axe over the outcome, validation, race, and
    // maintenance-banner renders too.
    const outcomeFlash = {
      kind: 'outcome',
      code: 'INSUFFICIENT_FUNDS',
      message: 'The account is short of what this operation needs.',
      figures: [
        { label: 'Required', value: '500.00 Cr' },
        { label: 'Available', value: '0.00 Cr' },
      ],
      form: 'market-purchase',
    };
    const invalidFlash = {
      kind: 'invalid',
      message: 'Please fix the highlighted fields.',
      fields: {
        user: 'A user id is required.',
        seller: 'A seller id is required.',
      },
      form: 'market-purchase',
    };
    const raceTally = {
      mode: 'order',
      attempts: 6,
      committed: 1,
      duplicates: 5,
      insufficient: 0,
      other: 0,
      movedCredits: 200,
    };
    const paused = {
      paused: true,
      pauseStart: 0,
      pauseEnd: 86_400_000,
      resumesAt: 86_400_000,
    };

    const cases: [string, ComponentType<never>, unknown][] = [
      ['overview', Overview, { walletPage, accounts, solvency }],
      [
        'accounts',
        Accounts,
        { page: walletPage, detail: walletPage.rows[0], selected: null },
      ],
      ['ledger', Ledger, { page: ledger }],
      [
        'ledger-search-txn',
        Ledger,
        { page: ledger, query: txnId, hit: searchTxn },
      ],
      [
        'ledger-search-checkpoint',
        Ledger,
        { page: ledger, query: checkpoint?.root ?? '', hit: searchCheckpoint },
      ],
      [
        'ledger-search-miss',
        Ledger,
        { page: ledger, query: 'nope', hit: null },
      ],
      [
        'payouts',
        Payouts,
        { page: payouts, counts, settings, detail: null, flash: null },
      ],
      [
        'payouts-drill',
        Payouts,
        { page: payouts, counts, settings, detail: sagaDetail, flash: null },
      ],
      // `full` as an already-resolved value renders the audit cards and the break form, not the fallback.
      ['integrity', Integrity, { prove, solvency, checkpoint, full: prove }],
      ['market', Market, mkt],
      ['market-outcome', Market, { ...mkt, flash: outcomeFlash }],
      ['market-invalid', Market, { ...mkt, flash: invalidFlash }],
      ['market-race', Market, { ...mkt, raceTally }],
      ['market-paused', Market, { ...mkt, status: paused }],
      ['txn-detail', TxnDetail, { ...txnBase, statement: null, lineage: null }],
      [
        'txn-drill',
        TxnDetail,
        {
          txnId,
          account: drillAccount,
          posting,
          statement,
          lineage,
          checkpoint,
        },
      ],
      ['pipeline', Pipeline, pipelineData],
      [
        'pipeline-invalid',
        Pipeline,
        { ...pipelineData, flash: pipelineInvalid },
      ],
      ['developers', Developers, { calls: xrayCalls }],
      ['controls', Controls, { rates: rateBoard, settings }],
      ['controls-unlocked', Controls, { rates: rateBoardOpen, settings }],
    ];

    for (const [name, Page, data] of cases) {
      expect({
        page: name,
        violations: await violationsOf(Page, data),
      }).toEqual({
        page: name,
        violations: [],
      });
    }
  },
);
