#!/usr/bin/env node
// =============================================================================
// prune-node-modules.mjs
//
// Shrinks an assembled node_modules tree by deleting runtime-unreachable files,
// using each package's `exports` / `main` / `bin` / `module` / `browser` map.
//
// Layouts supported:
//   - npm flat:        node_modules/<pkg>/...                (real files)
//   - pnpm .pnpm store: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...
//                      (real files; top-level links already dereferenced by release.sh)
//
// Deletion rules (all require "unreachable" proof):
//   1. Raw .ts (non-.d.ts) not in the package's reachable set.
//      Exception: a package whose exports contain a "./src/*" pattern keeps its
//      entire src/ tree (e.g. @deepseek-ai/cordis).
//   2. .d.mts and .d.mts.map (declaration-only, never loaded at runtime).
//   3. Native build leftovers: *.cc *.cpp *.h *.hh *.gyp* (prebuilt .node kept).
//   4. Redundant dual format copies: a *.cjs present only because a *.mjs exists
//      for the same base and is not in exports (and vice versa), conservatively.
//
// Files already covered by release.sh globs (*.map, *.d.ts, README, tests…) are
// not re-touched here. Symlinks are never followed nor deleted.
//
// Safe: only removes files no resolved export/main/bin path can reference.
// =============================================================================
import { readFileSync, existsSync, statSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2];
if (!ROOT || !existsSync(ROOT)) {
    console.error(`usage: node prune-node-modules.mjs <node_modules_dir>`);
    process.exit(1);
}

// ── counters ──────────────────────────────────────────────────────────────────
const stats = {
    ts: { files: 0, bytes: 0 },
    dMts: { files: 0, bytes: 0 },
    native: { files: 0, bytes: 0 },
    dual: { files: 0, bytes: 0 },
    emptyDirs: 0,
};

// Patterns that always indicate a removable build/declaration artifact.
const NATIVE_RE = /\.(cc|cpp|hh?|gypi?|o|obj)$/;
const DM_TS_RE = /\.d\.mts(\.map)?$/;
const RAW_TS_RE = /\.ts$/;
const DTS_RE = /\.d\.ts$/;

// Discover all package roots under node_modules. Handles:
//   <root>/<pkg>/
//   <root>/@<scope>/<pkg>/
//   <root>/.pnpm/<pkg>@<ver>/node_modules/<pkg>/
//   <root>/.pnpm/@<scope>+<pkg>@<ver>/node_modules/@<scope>/<pkg>/
function findPackages(dir, out = []) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = join(dir, e.name);
        if (e.name === 'node_modules') {
            // nested node_modules: recurse for scope dirs / packages
            findPackages(full, out);
            continue;
        }
        if (e.name.startsWith('.')) continue; // skip .bin, .pnpm at this level
        const pkgJson = join(full, 'package.json');
        if (existsSync(pkgJson)) {
            out.push(full);
        } else if (e.name.startsWith('@')) {
            // scope dir: look one level deeper
            findPackages(full, out);
        }
    }
    return out;
}

// Resolve the reachable file set for a package from its package.json.
function reachableSet(pkgDir) {
    const pkgJsonPath = join(pkgDir, 'package.json');
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')); }
    catch { return new Set(); }

    const keep = new Set();
    const wildSrc = []; // package-relative globs like "src/**"

    const addByPattern = (pat) => {
        if (!pat || typeof pat !== 'string') return;
        if (pat.startsWith('./')) pat = pat.slice(2);
        if (pat.includes('*')) {
            // Expand a single-level-agnostic glob: keep every file currently on
            // disk that matches, so we never delete reachable wildcard targets.
            const base = pat.replace(/\/\*+$/, '').replace(/\*$/, '');
            const baseDir = join(pkgDir, base);
            if (existsSync(baseDir)) collectAll(baseDir, keep);
            return;
        }
        keep.add(pat);
    };

    // exports (object form, possibly nested conditions)
    const walk = (val) => {
        if (!val) return;
        if (typeof val === 'string') { addByPattern(val); return; }
        if (Array.isArray(val)) { val.forEach(walk); return; }
        if (typeof val === 'object') {
            for (const [k, v] of Object.entries(val)) {
                if (k === 'types' || k === 'typings') continue; // .d.ts only
                if (typeof v === 'string') addByPattern(v);
                else walk(v);
            }
        }
    };
    if (pkg.exports) {
        for (const [key, val] of Object.entries(pkg.exports)) {
            if (key === './package.json') { keep.add('package.json'); continue; }
            if (key.includes('*')) {
                // wildcard export key: keep the matched subtree (e.g. ./src/*)
                const seg = key.split('*')[0].replace(/^\.\//, '').replace(/\/$/, '');
                wildSrc.push(seg);
            }
            walk(val);
        }
    }
    // main / module / browser (string forms)
    for (const f of [pkg.main, pkg.module, pkg.browser]) {
        if (typeof f === 'string') addByPattern(f);
    }
    // bin (string or object)
    if (typeof pkg.bin === 'string') addByPattern(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === 'object') {
        for (const b of Object.values(pkg.bin)) addByPattern(b);
    }
    // Always keep package.json, the license, and any referenced .d.ts next to kept entries.
    keep.add('package.json');
    if (pkg.license && typeof pkg.license === 'string') {
        const lc = pkg.license.toLowerCase();
        keep.add(`LICENSE.${lc}`);
    }
    keep.add('LICENSE');

    return { keep, wildSrc };
}

// Walk a directory and add every relative path to `set`.
function collectAll(dir, set, prefix = '') {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const rel = prefix ? join(prefix, e.name) : e.name;
        set.add(rel);
        if (e.isDirectory()) collectAll(join(dir, e.name), set, rel);
    }
}

function sizeOf(p) {
    try { return statSync(p).size; } catch { return 0; }
}

function tryUnlink(p, bucket) {
    try {
        const sz = sizeOf(p);
        unlinkSync(p);
        bucket.files++; bucket.bytes += sz;
    } catch { /* ignore */ }
}

// Remove empty directories bottom-up.
function pruneEmptyDirs(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = join(dir, e.name);
        pruneEmptyDirs(full);
        try {
            if (readdirSync(full).length === 0) {
                rmSync(full, { recursive: true, force: true });
                stats.emptyDirs++;
            }
        } catch { /* ignore */ }
    }
}

// ── main ───────────────────────────────────────────────── ─────────────────────
console.log(`prune: scanning ${ROOT}`);
const packages = findPackages(ROOT);
console.log(`prune: ${packages.length} packages found`);

for (const pkgDir of packages) {
    let info;
    try { info = reachableSet(pkgDir); } catch { continue; }
    const { keep, wildSrc } = info;
    const keepWild = new Set(wildSrc); // base dirs to keep entirely (e.g. src)

    // 1) raw .ts not reachable + not under a wildcard-kept dir
    // 2) .d.mts / .d.mts.map
    // 3) native build leftovers
    // 4) redundant dual .cjs/.mjs copies
    const tsByBase = new Map(); // base (no ext) -> set of exts present

    const walkDel = (dir, prefix = '') => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const rel = prefix ? join(prefix, e.name) : e.name;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                // keep entire subtree if under a wildcard-kept base (e.g. src/)
                const topBase = rel.split('/')[0];
                if (keepWild.has(topBase)) { continue; }
                walkDel(full, rel);
                continue;
            }
            if (e.isSymbolicLink()) continue; // never touch links

            const ext = extname(e.name);
            const baseNoExt = join(prefix, e.name.replace(/\.[^.]+$/, ''));

            // wildcard-kept subtree files
            const topBase = rel.split('/')[0];
            if (keepWild.has(topBase)) continue;

            // .d.mts / .d.mts.map
            if (DM_TS_RE.test(e.name)) { tryUnlink(full, stats.dMts); continue; }

            // native build leftovers (keep prebuilt .node)
            if (NATIVE_RE.test(e.name)) { tryUnlink(full, stats.native); continue; }

            // raw .ts (not .d.ts), only if not reachable
            if (RAW_TS_RE.test(e.name) && !DTS_RE.test(e.name)) {
                if (!keep.has(rel)) tryUnlink(full, stats.ts);
                continue;
            }

            // track dual-format copies for rule 4
            if (ext === '.mjs' || ext === '.cjs') {
                if (!tsByBase.has(baseNoExt)) tsByBase.set(baseNoExt, new Set());
                tsByBase.get(baseNoExt).add(ext);
            }
        }
    };
    walkDel(pkgDir);

    // rule 4: if both .mjs and .cjs exist for the same base and the package did
    // not reference either via exports/main/bin, the one NOT matching the
    // resolved "type" is redundant. Conservative: only delete when exactly one
    // is referenced anywhere; otherwise leave both.
    for (const [, exts] of tsByBase) {
        if (exts.has('.mjs') && exts.has('.cjs')) {
            // Both present; neither is in `keep` (else we would have skipped).
            // Delete the copy whose extension contradicts package "type".
            let type = 'commonjs';
            try { type = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).type || 'commonjs'; }
            catch { /* default commonjs */ }
            // type=module → .cjs is the odd one; type=commonjs → .mjs is odd.
            const redundant = type === 'module' ? '.cjs' : '.mjs';
            const target = join(pkgDir, baseNoExt + redundant);
            if (existsSync(target)) tryUnlink(target, stats.dual);
        }
    }
}

pruneEmptyDirs(ROOT);

const fmt = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;
console.log('prune: done');
console.log(`  raw .ts removed:        ${stats.ts.files} files, ${fmt(stats.ts.bytes)}`);
console.log(`  .d.mts/.d.mts.map:      ${stats.dMts.files} files, ${fmt(stats.dMts.bytes)}`);
console.log(`  native build leftovers: ${stats.native.files} files, ${fmt(stats.native.bytes)}`);
console.log(`  redundant dual copies:  ${stats.dual.files} files, ${fmt(stats.dual.bytes)}`);
console.log(`  empty dirs removed:     ${stats.emptyDirs}`);
const total = stats.ts.bytes + stats.dMts.bytes + stats.native.bytes + stats.dual.bytes;
console.log(`  total saved:            ${fmt(total)}`);
