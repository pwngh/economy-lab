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

/**
 * The offline half of `read.export`: parse an exported ledger file, rebuild a read-only ledger
 * view over it, and run the same provers the live economy runs — no store, no economy boot.
 * scripts/ledger-verify.ts is the CLI over this; a consumer imports `verifyExport` directly.
 */

import {
  proveChain,
  verifyArchiveHeads,
  verifyCheckpoint,
} from '#src/chain.ts';
import type { ArchiveBoundary, ChainBreak } from '#src/chain.ts';
import { decodeWire } from '#src/adapters/http-wire.ts';
import { systemDigest } from '#src/runtime.ts';
import { fromHex } from '#src/bytes.ts';
import { EXPORT_FORMAT } from '#src/economy.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  ArchiveHead,
  ArchiveState,
  Checkpoint,
  Digest,
  Ledger,
  Signer,
  StoredLink,
} from '#src/ports.ts';

/** What {@link parseExport} returns, for custom tooling over an export file. */
export type ParsedExport = {
  /** Each account's chain links in lineage order (oldest first), as the file carried them. */
  lineage: Map<AccountRef, StoredLink[]>;
  /** The embedded signed checkpoint, or null when none had been sealed at export time. */
  checkpoint: Checkpoint | null;
  /** The signed archive boundary, or null when nothing had been archived at export time. */
  boundary: { state: ArchiveState; rows: ArchiveHead[] } | null;
};

/**
 * Parses `read.export` lines into per-account lineage plus the embedded checkpoint. Blank lines
 * are skipped. Throws when the first line does not declare the {@link EXPORT_FORMAT} marker, on
 * an unknown line type, and on empty input — a truncated or foreign file fails loudly instead
 * of parsing to an empty ledger.
 */
export function parseExport(lines: Iterable<string>): ParsedExport {
  const lineage = new Map<AccountRef, StoredLink[]>();
  let checkpoint: Checkpoint | null = null;
  let boundary: ParsedExport['boundary'] = null;
  let sawHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    const row = JSON.parse(line) as Record<string, unknown>;
    if (!sawHeader) {
      if (row.format !== EXPORT_FORMAT) {
        throw new Error(
          `Not a ledger export: the first line must declare format '${EXPORT_FORMAT}'.`,
        );
      }
      sawHeader = true;
      continue;
    }
    if (row.type === 'link') {
      const account = row.account as AccountRef;
      const links = lineage.get(account) ?? [];
      links.push(decodeWire.storedLink(row.link));
      lineage.set(account, links);
    } else if (row.type === 'checkpoint') {
      checkpoint = row.checkpoint as Checkpoint;
    } else if (row.type === 'boundary') {
      const rows = row.rows as Array<{
        account: AccountRef;
        head: string;
        sum: string;
      }>;
      boundary = {
        state: row.state as ArchiveState,
        rows: rows.map((r) => ({
          account: r.account,
          head: r.head,
          sum: BigInt(r.sum),
        })),
      };
    } else {
      throw new Error(`Unknown export line type: ${String(row.type)}.`);
    }
  }
  if (!sawHeader) {
    throw new Error('Empty input: no export header line.');
  }
  return { lineage, checkpoint, boundary };
}

// A read-only ledger over the parsed file: exactly the members the provers walk (heads,
// headSums, lineage). Every other Ledger member is a store-side concern the file can never
// serve, so the cast is safe.
function fileLedger(parsed: ParsedExport): Ledger {
  const view = {
    heads: async function* () {
      for (const [account, links] of parsed.lineage) {
        yield [account, links[links.length - 1]!.hash] as const;
      }
    },
    headSums: async function* () {
      for (const [account, links] of parsed.lineage) {
        let sum = 0n;
        for (const link of links) {
          for (const leg of link.legs) {
            if (leg.account === account) {
              sum += leg.amount.minor;
            }
          }
        }
        yield [account, links[links.length - 1]!.hash, sum] as const;
      }
    },
    lineage: async function* (account: AccountRef) {
      for (const link of parsed.lineage.get(account) ?? []) {
        yield link;
      }
    },
  };
  return view as unknown as Ledger;
}

/** A Signer that verifies against the given hex Ed25519 public keys and refuses to sign. */
function verifyOnlySigner(publicKeysHex: ReadonlyArray<string>): Signer {
  const keys = publicKeysHex.map((hex) =>
    crypto.subtle.importKey('raw', fromHex(hex), { name: 'Ed25519' }, false, [
      'verify',
    ]),
  );
  return {
    sign: async () => {
      throw new Error('This signer only verifies.');
    },
    verify: async (bytes, signature) => {
      for (const key of keys) {
        if (
          await crypto.subtle.verify(
            { name: 'Ed25519' },
            await key,
            signature,
            bytes,
          )
        ) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Why the chain verdict is false when no link is at fault: the file carried an archive boundary
 * the run could not authenticate, so the anchors the chains start from are unproven.
 */
export type BoundaryBreak = {
  reason: 'boundary-unchecked' | 'boundary-unauthenticated';
  accounts: number;
};

/** What {@link verifyExport} resolves to: the chain verdict, then the checkpoint check. */
export type VerifyReport = {
  /**
   * True when every account's chain re-derives link by link from the file alone, and any archive
   * boundary the file carried authenticated against a supplied key.
   */
  chainIntact: boolean;
  /**
   * The first failing link as the prover reports it, or a {@link BoundaryBreak} when the chains
   * re-derive but only from anchors that never authenticated. Null when the chain is intact.
   */
  firstBreak: ChainBreak | BoundaryBreak | null;
  /** How many account chains the file carried and the prover walked. */
  accounts: number;
  checkpoint: {
    /** Whether the file embedded a checkpoint at all. */
    present: boolean;
    id?: string;
    /** The key id the checkpoint was sealed under, when the seal recorded one. */
    kid?: string | null;
    /** False when no checkpoint is embedded or no public key was supplied. */
    signatureChecked: boolean;
    /** Present only when `signatureChecked`; true when the seal verifies against a supplied key. */
    verified?: boolean;
  };
  boundary: {
    /** Whether the file embedded a signed archive boundary at all. */
    present: boolean;
    /** How many per-account archived heads the boundary carried. */
    accounts?: number;
    /** False when no boundary is embedded or no public key was supplied. */
    signatureChecked: boolean;
    /** Present only when `signatureChecked`; true when the boundary's root and signature hold. */
    verified?: boolean;
  };
};

/**
 * Runs the full offline verification: re-prove every account's chain from the file's links,
 * then check the embedded checkpoint's root and signature against the supplied public keys.
 * The checkpoint verifies against the exported tip, so a checkpoint sealed before the last
 * postings reports as unverified until the ledger is exported right after a seal.
 *
 * `chainIntact` is false whenever the file carried an archive boundary that did not
 * authenticate against a supplied key, including when no key was supplied at all: the chains of
 * the accounts a boundary names start at its anchors, so an unproven boundary leaves nothing for
 * the verdict to rest on. `firstBreak` is then a {@link BoundaryBreak} rather than a link.
 *
 * @example
 * import { readFileSync } from 'node:fs';
 * const lines = readFileSync('ledger-export.jsonl', 'utf8').split('\n');
 * const report = await verifyExport(lines, [publishedSigningKeyHex]);
 * if (!report.chainIntact) throw new Error('export chain broken');
 */
export async function verifyExport(
  lines: Iterable<string>,
  publicKeysHex: ReadonlyArray<string>,
  digest: Digest = systemDigest(),
): Promise<VerifyReport> {
  const parsed = parseExport(lines);
  const ledger = fileLedger(parsed);
  const signer =
    publicKeysHex.length > 0 ? verifyOnlySigner(publicKeysHex) : null;

  // The boundary authenticates exactly as the live prover authenticates it: recompute the
  // Merkle sum-root over the rows, match the signed state, verify the signature. The chains
  // then anchor at the archived heads instead of genesis.
  let boundary: ArchiveBoundary | null = null;
  let boundaryVerified: boolean | undefined;
  if (parsed.boundary !== null) {
    if (signer !== null) {
      boundaryVerified = await verifyArchiveHeads(
        { digest, signer },
        parsed.boundary.rows,
        parsed.boundary.state,
      );
    }
    boundary = {
      anchors: new Map(parsed.boundary.rows.map((r) => [r.account, r.head])),
      rawSums: new Map(parsed.boundary.rows.map((r) => [r.account, r.sum])),
      state: parsed.boundary.state,
    };
  }

  // A boundary is where every account it names starts its chain, so an unproven boundary makes
  // the chain verdict worthless: the anchors are values an attacker can move. The live prover
  // refuses outright over one — `loadArchiveBoundary` faults CHAIN_BROKEN on a bad signature and
  // `proveBoundary` faults CONFIG_INVALID when no signer was supplied. Offline the refusal
  // arrives as a verdict rather than a throw, and it is `chainIntact` that carries it, because
  // that is the field the module's own example and `scripts/ledger-verify.ts` branch on. The
  // checkpoint is unlike the boundary here: nothing anchors on it, so leaving it unchecked
  // costs only its own claim.
  const boundaryBreak: BoundaryBreak | null =
    parsed.boundary === null || boundaryVerified === true
      ? null
      : {
          reason:
            signer === null ? 'boundary-unchecked' : 'boundary-unauthenticated',
          accounts: parsed.boundary.rows.length,
        };

  const chain = await proveChain({ ledger, digest, boundary });
  const report: VerifyReport = {
    chainIntact: chain.intact && boundaryBreak === null,
    firstBreak: boundaryBreak ?? chain.firstBreak,
    accounts: chain.count,
    checkpoint: {
      present: parsed.checkpoint !== null,
      signatureChecked: false,
    },
    boundary: {
      present: parsed.boundary !== null,
      ...(parsed.boundary !== null
        ? { accounts: parsed.boundary.rows.length }
        : {}),
      signatureChecked: parsed.boundary !== null && signer !== null,
      ...(boundaryVerified !== undefined ? { verified: boundaryVerified } : {}),
    },
  };
  if (parsed.checkpoint === null) {
    return report;
  }
  report.checkpoint.id = parsed.checkpoint.id;
  report.checkpoint.kid = parsed.checkpoint.kid;
  if (signer === null) {
    return report;
  }
  report.checkpoint.signatureChecked = true;
  report.checkpoint.verified = await verifyCheckpoint(
    { ledger, digest, signer, boundary },
    parsed.checkpoint,
  );
  return report;
}
