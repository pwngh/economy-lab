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
 * scripts/verify.ts is the CLI over this; the test suite drives it directly.
 */

import { proveChain, verifyCheckpoint } from '#src/chain.ts';
import { decodeWire } from '#src/adapters/http-wire.ts';
import { systemDigest } from '#src/runtime.ts';
import { fromHex } from '#src/bytes.ts';
import { EXPORT_FORMAT } from '#src/economy.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  Checkpoint,
  Digest,
  Ledger,
  Signer,
  StoredLink,
} from '#src/ports.ts';

export type ParsedExport = {
  lineage: Map<AccountRef, StoredLink[]>;
  checkpoint: Checkpoint | null;
};

/** Parses export lines into per-account lineage plus the embedded checkpoint, if any. */
export function parseExport(lines: Iterable<string>): ParsedExport {
  const lineage = new Map<AccountRef, StoredLink[]>();
  let checkpoint: Checkpoint | null = null;
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
    } else {
      throw new Error(`Unknown export line type: ${String(row.type)}.`);
    }
  }
  if (!sawHeader) {
    throw new Error('Empty input: no export header line.');
  }
  return { lineage, checkpoint };
}

// A read-only ledger over the parsed file: exactly the members the provers walk (heads,
// headSums, lineage). Every other Ledger member is a store-side concern the file can never
// serve, so the cast is safe.
export function fileLedger(parsed: ParsedExport): Ledger {
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
export function verifyOnlySigner(publicKeysHex: ReadonlyArray<string>): Signer {
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

export type VerifyReport = {
  chainIntact: boolean;
  firstBreak: unknown;
  accounts: number;
  checkpoint: {
    present: boolean;
    id?: string;
    kid?: string | null;
    // False when no checkpoint is embedded or no public key was supplied.
    signatureChecked: boolean;
    verified?: boolean;
  };
};

/**
 * Runs the full offline verification: re-prove every account's chain from the file's links,
 * then check the embedded checkpoint's root and signature against the supplied public keys.
 * The checkpoint verifies against the exported tip, so a checkpoint sealed before the last
 * postings reports as unverified until the ledger is exported right after a seal.
 */
export async function verifyExport(
  lines: Iterable<string>,
  publicKeysHex: ReadonlyArray<string>,
  digest: Digest = systemDigest(),
): Promise<VerifyReport> {
  const parsed = parseExport(lines);
  const ledger = fileLedger(parsed);
  const chain = await proveChain({ ledger, digest });
  const report: VerifyReport = {
    chainIntact: chain.intact,
    firstBreak: chain.firstBreak,
    accounts: chain.count,
    checkpoint: {
      present: parsed.checkpoint !== null,
      signatureChecked: false,
    },
  };
  if (parsed.checkpoint === null) {
    return report;
  }
  report.checkpoint.id = parsed.checkpoint.id;
  report.checkpoint.kid = parsed.checkpoint.kid;
  if (publicKeysHex.length === 0) {
    return report;
  }
  report.checkpoint.signatureChecked = true;
  report.checkpoint.verified = await verifyCheckpoint(
    { ledger, digest, signer: verifyOnlySigner(publicKeysHex) },
    parsed.checkpoint,
  );
  return report;
}
