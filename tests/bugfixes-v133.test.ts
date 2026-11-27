/**
 * Regression tests for bug fixes v1.3.3:
 * 1. --no-global (includeGlobal: false) does not fall back to ~/.knowledge when no local/env/explicit dir exists.
 * 2. CLI commands (list, search, outdated, info, validate, remove, init) and MCP server respect --no-global safely.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { clearIndexCache, resolveKnowledgeDirs, toolListDocs } from '../src/core.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, envOverrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env,
  });
}

describe('Bug fixes v1.3.3 (--no-global isolation)', () => {
  let tmpDir: string;
  let fakeHome: string;
  let fakeGlobal: string;
  let emptyWorkspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v133-'));
    fakeHome = path.join(tmpDir, 'home');
    fakeGlobal = path.join(fakeHome, '.knowledge');
    emptyWorkspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(fakeGlobal, { recursive: true });
    fs.mkdirSync(emptyWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(fakeGlobal, 'personal-note.md'),
      '---\ntitle: Personal Secret\ntags: [personal]\n---\n\n# Personal Secret\nDo not leak when --no-global is set.\n',
      'utf-8'
    );
    clearIndexCache();
  });

  afterEach(() => {
    clearIndexCache();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. resolveKnowledgeDirs(undefined, { includeGlobal: false }) returns [] in an empty workspace', () => {
    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevDir = process.env.KNOWLEDGE_DIR;
    const prevDirs = process.env.KNOWLEDGE_DIRS;

    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.KNOWLEDGE_DIR;
    delete process.env.KNOWLEDGE_DIRS;
    process.chdir(emptyWorkspace);

    try {
      const dirs = resolveKnowledgeDirs(undefined, { includeGlobal: false });
      expect(dirs).toEqual([]);

      const listRes = JSON.parse(toolListDocs(dirs).text);
      expect(listRes.total).toBe(0);

      // Default (includeGlobal omitted) still falls back to ~/.knowledge
      const defaultDirs = resolveKnowledgeDirs(undefined);
      expect(defaultDirs.map((d) => d.toLowerCase())).toContain(path.resolve(fakeGlobal).toLowerCase());
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevDir !== undefined) process.env.KNOWLEDGE_DIR = prevDir;
      if (prevDirs !== undefined) process.env.KNOWLEDGE_DIRS = prevDirs;
    }
  });

  it('2. CLI commands respect --no-global in an empty workspace without leaking global docs or mutating CWD/global', () => {
    const envOverrides = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      KNOWLEDGE_DIR: undefined,
      KNOWLEDGE_DIRS: undefined,
    };

    const listRes = runCli(['list', '--no-global'], emptyWorkspace, envOverrides);
    expect(listRes.status).toBe(0);
    expect(listRes.stdout).not.toContain('personal-note.md');
    expect(listRes.stdout).toContain('No knowledge sources installed.');

    const searchRes = runCli(['search', 'Personal', '--no-global'], emptyWorkspace, envOverrides);
    expect(searchRes.status).toBe(0);
    expect(searchRes.stdout).not.toContain('personal-note.md');
    expect(searchRes.stdout).toContain('No documents found.');

    const outdatedRes = runCli(['outdated', '--no-global'], emptyWorkspace, envOverrides);
    expect(outdatedRes.status).toBe(0);
    expect(outdatedRes.stdout).toContain('No knowledge sources installed.');

    const infoRes = runCli(['info', 'personal-note', '--no-global'], emptyWorkspace, envOverrides);
    expect(infoRes.status).toBe(1);
    expect(infoRes.stderr).not.toContain('undefined');

    // Create a local folder in CWD to ensure `remove --no-global` never resolves primaryDir to CWD
    const cwdSentinel = path.join(emptyWorkspace, 'personal-note');
    fs.mkdirSync(cwdSentinel, { recursive: true });
    const removeRes = runCli(['remove', 'personal-note', '--no-global'], emptyWorkspace, envOverrides);
    expect(removeRes.status).toBe(1);
    expect(fs.existsSync(cwdSentinel)).toBe(true);
    expect(fs.existsSync(path.join(fakeGlobal, 'personal-note.md'))).toBe(true);

    const initRes = runCli(['init', '--no-global'], emptyWorkspace, envOverrides);
    expect(initRes.status).toBe(1);
    expect(initRes.stderr).toContain('--no-global');

    const valEmptyRes = runCli(['validate', '--no-global'], emptyWorkspace, envOverrides);
    expect(valEmptyRes.status).toBe(1);
    expect(valEmptyRes.stderr).not.toContain('undefined');

    const valUnitRes = runCli(['validate', 'personal-note.md', '--no-global'], emptyWorkspace, envOverrides);
    expect(valUnitRes.status).toBe(1);
    expect(valUnitRes.stderr).not.toContain('undefined');

    // Local path validation still works with --no-global
    const localDoc = path.join(emptyWorkspace, 'local-check.md');
    fs.writeFileSync(localDoc, '---\ndescription: ok\ntags: [test]\n---\n# Local\nBody\n', 'utf-8');
    const valLocalRes = runCli(['validate', './local-check.md', '--no-global'], emptyWorkspace, envOverrides);
    expect(valLocalRes.status).toBe(0);
  });

  it('3. MCP server with --no-global returns 0 docs when workspace has no local knowledge dir', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'KNOWLEDGE_DIR' && k !== 'KNOWLEDGE_DIRS') {
        env[k] = v;
      }
    }
    env.HOME = fakeHome;
    env.USERPROFILE = fakeHome;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, '--no-global'],
      cwd: emptyWorkspace,
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test-no-global-mcp', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listResult = await client.callTool({ name: 'list_docs', arguments: {} });
      const content = listResult.content as Array<{ text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.total).toBe(0);
      expect(parsed.knowledge_dir).toBeUndefined();

      const resList = await client.listResources();
      expect(resList.resources).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
