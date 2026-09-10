#!/usr/bin/env node
// =============================================================================
// assemble-runtime.mjs
//
// Removes files an assembled npm closure never needs at runtime, leaving the
// layout dsh actually loads. Used by both build-release.sh (packaging time) and
// the app's runtime installer, so the two cannot drift apart.
//
//   node assemble-runtime.mjs <node_modules_dir>
//
// Removed, at any depth, without following symlinks:
//   *.map, *.d.ts, *.d.ts.map, *.tsbuildinfo, .DS_Store, README*, CHANGELOG*
//   directories named test, tests, __tests__, docs, fixtures
//
// The reachability-based pruning of unreachable sources stays in
// prune-node-modules.mjs, which runs after this script.
// =============================================================================
import { readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) {
    console.error('usage: node assemble-runtime.mjs <node_modules_dir>');
    process.exit(1);
}

const FILE_RE = /\.d\.ts\.map$|\.d\.ts$|\.map$|\.tsbuildinfo$/;
const NAME_RE = /^(README|CHANGELOG)/;
const DIR_NAMES = new Set(['test', 'tests', '__tests__', 'docs', 'fixtures']);

const stats = { files: 0, directories: 0 };

function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue; // never follow nor delete links
        if (entry.isDirectory()) {
            if (DIR_NAMES.has(entry.name)) {
                try { rmSync(full, { recursive: true, force: true }); stats.directories++; } catch { /* ignore */ }
                continue;
            }
            walk(full);
            continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name === '.DS_Store' || FILE_RE.test(entry.name) || NAME_RE.test(entry.name)) {
            try { unlinkSync(full); stats.files++; } catch { /* ignore */ }
        }
    }
}

console.log(`assemble-runtime: scanning ${ROOT}`);
walk(ROOT);
console.log('assemble-runtime: done');
console.log(`  files removed:       ${stats.files}`);
console.log(`  directories removed: ${stats.directories}`);
