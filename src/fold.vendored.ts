/**
 * @pwngh/money
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 *
 * Vendored from @pwngh/money@0.3.0 (src/fold.ts), reflowed to this repo's line
 * width; content otherwise identical.
 */

/**
 * Checked i64 balance folding in WebAssembly: the hot path beneath @pwngh/money,
 * shipped as its /fold subpath so the importer composes it in — the main entry never
 * loads it. Still a single-file amalgamation: zero imports, and no binary blob ships;
 * the module is assembled at load time by the
 * micro-assembler below, so the reviewable TypeScript stays the audit target — the
 * schema-as-string-constant rule applied to executable code. The WAT mirror
 * (`foldWat`) is the human-readable statement of the same instructions.
 *
 * Semantics, pinned by `vectors`: a left fold with overflow checked at every step
 * against i64 bounds. Order matters — an intermediate overflow traps even when the
 * final total would fit — because a balance fold that silently passes through an
 * unrepresentable intermediate state is not auditable. Traps surface as RangeError,
 * matching @pwngh/money arithmetic.
 *
 * Composes further than TypeScript source can: the same assembled module runs under
 * Node, browsers, Deno, Bun, and .NET or Unity via wasmtime. Emit it for those hosts:
 *
 *   node -e 'import("./fold.ts").then(m => process.stdout.write(m.moduleBytes()))' > fold.wasm
 *
 * UdonSharp remains the vectors-only boundary: Udon loads nothing, so Pwngh.Fold
 * reimplements against the same embedded conformance vectors.
 */

export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

/** The module's instructions in WebAssembly text form: what the assembler below emits. */
export const foldWat = `(module
  (memory (export "memory") 1)
  (func (export "fold") (param $ptr i32) (param $len i32) (result i64)
    (local $sum i64) (local $v i64) (local $s i64) (local $end i32)
    local.get $ptr  local.get $len  i32.const 3  i32.shl  i32.add  local.set $end
    block $done
      loop $next
        local.get $ptr  local.get $end  i32.ge_u  br_if $done
        local.get $ptr  i64.load align=8  local.set $v
        local.get $sum  local.get $v  i64.add  local.set $s
        local.get $sum  local.get $s  i64.xor
        local.get $v    local.get $s  i64.xor
        i64.and  i64.const 0  i64.lt_s
        if  unreachable  end
        local.get $s  local.set $sum
        local.get $ptr  i32.const 8  i32.add  local.set $ptr
        br $next
      end
    end
    local.get $sum))`;

// prettier-ignore
const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, end: 0x0b,
  br: 0x0c, brIf: 0x0d, localGet: 0x20, localSet: 0x21,
  i64Load: 0x29, i32Const: 0x41, i64Const: 0x42,
  i32GeU: 0x4f, i64LtS: 0x53, i32Add: 0x6a, i32Shl: 0x74,
  i64Add: 0x7c, i64And: 0x83, i64Xor: 0x85,
  void: 0x40, i32: 0x7f, i64: 0x7e, funcType: 0x60,
} as const;

function uleb(value: number): number[] {
  const out: number[] = [];
  let n = value;
  do {
    const byte = n & 0x7f;
    n >>>= 7;
    out.push(n === 0 ? byte : byte | 0x80);
  } while (n !== 0);
  return out;
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function name(text: string): number[] {
  return [text.length, ...[...text].map((c) => c.charCodeAt(0))];
}

/** Assembles the fold module. Deterministic, 125 bytes, built fresh on each call. */
export function moduleBytes(): Uint8Array<ArrayBuffer> {
  const ptr = 0;
  const len = 1;
  const sum = 2;
  const v = 3;
  const s = 4;
  const end = 5;
  // prettier-ignore
  const body = [
    2, 3, OP.i64, 1, OP.i32,
    OP.localGet, ptr, OP.localGet, len, OP.i32Const, 3, OP.i32Shl, OP.i32Add,
    OP.localSet, end,
    OP.block, OP.void,
    OP.loop, OP.void,
    OP.localGet, ptr, OP.localGet, end, OP.i32GeU, OP.brIf, 1,
    OP.localGet, ptr, OP.i64Load, 3, 0, OP.localSet, v,
    OP.localGet, sum, OP.localGet, v, OP.i64Add, OP.localSet, s,
    OP.localGet, sum, OP.localGet, s, OP.i64Xor,
    OP.localGet, v, OP.localGet, s, OP.i64Xor,
    OP.i64And, OP.i64Const, 0, OP.i64LtS,
    OP.if, OP.void, OP.unreachable, OP.end,
    OP.localGet, s, OP.localSet, sum,
    OP.localGet, ptr, OP.i32Const, 8, OP.i32Add, OP.localSet, ptr,
    OP.br, 0,
    OP.end,
    OP.end,
    OP.localGet, sum,
    OP.end,
  ];
  // prettier-ignore
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, OP.funcType, 2, OP.i32, OP.i32, 1, OP.i64]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...name('memory'), 2, 0, ...name('fold'), 0, 0]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

/**
 * Reference implementation with identical semantics, in plain bigint. The slow,
 * obviously-correct half of the cross-check; also the fallback where WebAssembly
 * is unavailable.
 */
export function foldRef(values: Iterable<bigint>): bigint {
  let sum = 0n;
  for (const value of values) {
    if (value < I64_MIN || value > I64_MAX)
      throw new RangeError('i64 overflow');
    sum += value;
    if (sum < I64_MIN || sum > I64_MAX) throw new RangeError('i64 overflow');
  }
  return sum;
}

export interface Fold {
  fold(values: BigInt64Array | readonly bigint[]): bigint;
  view(count: number): BigInt64Array;
}

/**
 * Instantiates the module once and returns a folder that reuses its linear memory.
 * `view` hands the caller that memory directly: a column built in place folds with
 * zero copies, because the column IS the buffer the kernel reads. A grow detaches
 * earlier views, so take the view after sizing, not before.
 */
export function createFold(): Fold {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(moduleBytes()),
  );
  const wasm = instance.exports as {
    memory: WebAssembly.Memory;
    fold(ptr: number, len: number): bigint;
  };
  function view(count: number): BigInt64Array {
    const needed = count * 8;
    const have = wasm.memory.buffer.byteLength;
    if (needed > have) wasm.memory.grow(Math.ceil((needed - have) / 65_536));
    return new BigInt64Array(wasm.memory.buffer, 0, count);
  }
  function run(ptr: number, count: number): bigint {
    try {
      return wasm.fold(ptr, count);
    } catch {
      throw new RangeError('i64 overflow');
    }
  }
  return {
    view,
    fold(values) {
      const count = values.length;
      if (
        values instanceof BigInt64Array &&
        values.buffer === wasm.memory.buffer
      ) {
        return run(values.byteOffset, count);
      }
      const target = view(count);
      if (values instanceof BigInt64Array) {
        target.set(values);
      } else {
        for (let i = 0; i < count; i += 1) {
          const value = values[i];
          if (value < I64_MIN || value > I64_MAX)
            throw new RangeError('i64 overflow');
          target[i] = value;
        }
      }
      return run(0, count);
    },
  };
}

/** Conformance vectors, JSON-safe. 'throws' marks folds that must trap. */
export type Vector = readonly ['fold', readonly string[], string | 'throws'];

export const vectors: readonly Vector[] = [
  ['fold', [], '0'],
  ['fold', ['1', '2', '3'], '6'],
  ['fold', ['-5'], '-5'],
  ['fold', ['9223372036854775807', '0'], '9223372036854775807'],
  ['fold', ['-9223372036854775808', '9223372036854775807'], '-1'],
  ['fold', ['9007199254740992', '1'], '9007199254740993'],
  ['fold', ['9223372036854775807', '1'], 'throws'],
  ['fold', ['-9223372036854775808', '-1'], 'throws'],
  ['fold', ['9223372036854775807', '1', '-2'], 'throws'],
  ['fold', ['-2', '1', '9223372036854775807'], '9223372036854775806'],
];

/**
 * Runs every vector against both implementations, then cross-checks them on a
 * 65,537-element seeded LCG array (one past a wasm page of i64s, forcing a grow),
 * built through `view` so the zero-copy path is conformance-covered too.
 * Returns failures; empty means conformant.
 */
export function selfTest(): string[] {
  const failures: string[] = [];
  const folder = createFold();
  const impls: readonly [string, (values: readonly bigint[]) => bigint][] = [
    ['ref', foldRef],
    ['wasm', (values) => folder.fold(values)],
  ];
  for (const [, values, want] of vectors) {
    const input = values.map(BigInt);
    for (const [label, impl] of impls) {
      let got: string;
      try {
        got = impl(input).toString();
      } catch {
        got = 'throws';
      }
      if (got !== want)
        failures.push(`${label} fold(${values.join(',')}) got ${got}`);
    }
  }
  let seed = 88172645463325252n;
  const random = folder.view(65_537);
  for (let i = 0; i < random.length; i += 1) {
    seed =
      (seed * 6364136223846793005n + 1442695040888963407n) &
      0xffffffffffffffffn;
    random[i] = BigInt.asIntN(64, seed) >> 20n;
  }
  const fromRef = foldRef(random);
  const fromWasm = folder.fold(random);
  if (fromRef !== fromWasm)
    failures.push(`cross-check: ref ${fromRef} wasm ${fromWasm}`);
  return failures;
}
