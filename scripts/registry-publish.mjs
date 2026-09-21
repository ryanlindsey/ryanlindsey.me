#!/usr/bin/env node
// Publish this server's entry to the official MCP Registry. OWNER-RUN.
//
// WHY A SCRIPT AND NOT A COMMITTED server.json: the entry is built from
// src/lib/discovery/registry-entry.ts, which carries the one version every
// discovery document advertises, so there is nothing for release-please to
// keep in step and nothing to drift. This writes the file into a temporary
// directory, logs in with the domain proof, publishes, and removes the
// directory.
//
// WHAT IT READS: MCP_REGISTRY_PRIVATE_KEY from the environment and nowhere
// else, the 64-character hex Ed25519 seed filed in 1Password as `RLME MCP
// Registry Key`. Run it under `op run` with that reference exported, the way
// scripts/token.mjs is run. The key reaches `mcp-publisher login` as an
// argument, which is the only form that CLI takes (read 2026-09-20), so it is
// briefly visible in the process list on this machine. That is accepted for
// a key that authorizes registry entries under one namespace and nothing
// else.
//
// WHAT IT NEEDS INSTALLED: `mcp-publisher` (brew install mcp-publisher, or a
// release from github.com/modelcontextprotocol/registry). It is not a
// dependency of this repository.
//
// WHAT IT LEAVES BEHIND: `mcp-publisher login` persists a registry bearer
// token at ~/.config/mcp-publisher/token.json, mode 0600, and `publish`
// reads the registry URL and token back from there -- which is also why
// running `publish` with `cwd: dir` works rather than working by accident.
// This script never logs out; `mcp-publisher logout` clears it. Measured
// 2026-09-21 against cmd/publisher/commands/login.go in
// modelcontextprotocol/registry.
//
// Usage:
//   MCP_REGISTRY_PRIVATE_KEY='op://Private/RLME MCP Registry Key/credential' \
//     op run -- npm run registry:publish

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistryEntry } from '../src/lib/discovery/registry-entry.ts';

const DOMAIN = 'ryanlindsey.me';
// package.json's version is the same value as DISCOVERY_VERSION, pinned by
// tests/discovery-server-card.test.ts; read here because the builder takes
// the version as an argument rather than importing it (its header says why).
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const key = process.env.MCP_REGISTRY_PRIVATE_KEY;
if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
  process.stderr.write(
    'MCP_REGISTRY_PRIVATE_KEY is not in the environment as a 64-character hex seed; run under `op run` with the op:// reference exported\n',
  );
  process.exit(2);
}

const entry = buildRegistryEntry(VERSION);
const dir = mkdtempSync(join(tmpdir(), 'rlme-registry-'));
try {
  writeFileSync(join(dir, 'server.json'), `${JSON.stringify(entry, null, 2)}\n`);
  const { MCP_REGISTRY_PRIVATE_KEY: _withheld, ...env } = process.env;

  // Node exposes spawnargs in uncaught exceptions (ENOENT case) and puts the
  // full argv -- including the private key -- into err.message on non-zero
  // exit. Measured 2026-09-21: branch on err.code and err.status only, never
  // on err.message or err.spawnargs, which is what keeps the key off stderr.
  // Both carry no argv, so branching on them is safe: err.code === 'ENOENT'
  // names a missing binary and err.status names the exit code the binary
  // itself chose. stdio: 'inherit' lets the publisher's own output still
  // reach the owner.
  const notInstalled =
    'mcp-publisher is not installed; brew install mcp-publisher, or get a release from github.com/modelcontextprotocol/registry';

  try {
    execFileSync('mcp-publisher', ['login', 'http', '--domain', DOMAIN, '--private-key', key], {
      stdio: 'inherit',
      env,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(notInstalled);
    }
    throw new Error(
      'mcp-publisher login failed; run with MCP_REGISTRY_PRIVATE_KEY exported via op run',
    );
  }

  try {
    execFileSync('mcp-publisher', ['publish'], { cwd: dir, stdio: 'inherit', env });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(notInstalled);
    }
    throw new Error(
      err.status != null
        ? `mcp-publisher publish failed (exit ${err.status})`
        : 'mcp-publisher publish failed',
    );
  }

  process.stdout.write(`published ${entry.name}@${entry.version}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
