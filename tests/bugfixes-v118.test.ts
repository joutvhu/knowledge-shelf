/**
 * Regression tests for v1.1.8 fixes:
 * 1. import --all works on root-manifest archives (no wrapper folder) while explicit --name + --all still errors
 * 2. index writes path: "." for single-unit root-manifest repos, and add --pack installs root units (path "." or "")
 * 3. untrust on a local: source sets trusted: false and is enforced by --strict-trust
 * 4. Extra positional arguments are rejected consistently on list, outdated, validate, scaffold, sync, catalog, publish
 * 5. expandBraces caps expansion count against exponential blowup
 * 6. Index cache invalidates when .txt / .mdx doc or reference files change
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  expandBraces,
  scanDocuments,
  toolRunWorkflow,
  toolSearchDocs,
} from '../src/core.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function git(cwd: string, args: string[]) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout || '').trim();
}

describe('v1.1.8 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v118-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. import --all succeeds on archive with manifest.json at archive root and rejects explicit --name + --all', () => {
    const unitDir = path.join(tmpDir, 'root-unit');
    expect(runCli(['scaffold', 'root-unit', '--type', 'boilerplate', '--output', tmpDir]).status).toBe(0);

    // Create a tar.gz whose entries sit at archive root (manifest.json, overview.md, ...)
    const tarPath = path.join(tmpDir, 'root-unit.tar.gz');
    const tarRes = spawnSync('tar', ['-czf', tarPath, '-C', unitDir, '.'], { encoding: 'utf-8' });
    expect(tarRes.status).toBe(0);

    const kDir = path.join(tmpDir, 'kd-import');
    const impRes = runCli(['import', tarPath, '--all', '--dir', kDir]);
    expect(impRes.status).toBe(0);
    expect(fs.existsSync(path.join(kDir, 'root-unit', 'manifest.json'))).toBe(true);

    // Explicit --name + --all must still fail cleanly
    const badRes = runCli(['import', tarPath, '--all', '--name', 'custom', '--dir', kDir]);
    expect(badRes.status).toBe(1);
    expect(badRes.stderr).toContain('--name cannot be combined with --all');
  });

  it('2. index emits path "." for root-manifest repos and add --pack installs root units', () => {
    const repoDir = path.join(tmpDir, 'single-repo');
    expect(runCli(['scaffold', 'single-repo', '--type', 'boilerplate', '--output', tmpDir]).status).toBe(0);

    const idxRes = runCli(['index', repoDir]);
    expect(idxRes.status).toBe(0);

    const shelfPath = path.join(repoDir, 'shelf.json');
    const shelf = JSON.parse(fs.readFileSync(shelfPath, 'utf-8'));
    expect(shelf.units).toHaveLength(1);
    expect(shelf.units[0].path).toBe('.');

    // Add a pack referencing the root unit and commit to git
    shelf.packs = {
      core: { description: 'Root pack', units: ['single-repo'] },
    };
    fs.writeFileSync(shelfPath, JSON.stringify(shelf, null, 2), 'utf-8');

    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    const kDir1 = path.join(tmpDir, 'kd-pack-dot');
    const packRes1 = runCli(['add', repoDir, '--pack', 'core', '--dir', kDir1]);
    expect(packRes1.status).toBe(0);
    expect(fs.existsSync(path.join(kDir1, 'single-repo', 'manifest.json'))).toBe(true);
    const reg1 = JSON.parse(fs.readFileSync(path.join(kDir1, '.registry.json'), 'utf-8'));
    expect(reg1.sources[0].path).toBeUndefined();

    // Legacy shelf.json with empty string "" path should also install via --pack
    shelf.units[0].path = '';
    fs.writeFileSync(shelfPath, JSON.stringify(shelf, null, 2), 'utf-8');
    git(repoDir, ['add', 'shelf.json']);
    git(repoDir, ['commit', '-m', 'empty path']);

    const kDir2 = path.join(tmpDir, 'kd-pack-empty');
    const packRes2 = runCli(['add', repoDir, '--pack', 'core', '--dir', kDir2]);
    expect(packRes2.status).toBe(0);
    expect(fs.existsSync(path.join(kDir2, 'single-repo', 'manifest.json'))).toBe(true);
  });

  it('3. untrust on a local: source sets trusted: false and strictTrust blocks its scripts', async () => {
    const unitSrc = path.join(tmpDir, 'local-script-unit');
    expect(runCli(['scaffold', 'local-script-unit', '--type', 'toolkit', '--output', tmpDir]).status).toBe(0);

    fs.mkdirSync(path.join(unitSrc, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(unitSrc, 'scripts', 'ping.js'), 'console.log("pong");\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitSrc, 'workflows', 'ping.json'),
      JSON.stringify({
        name: 'ping',
        inputs: { TARGET: { required: true, type: 'path' } },
        steps: [{ action: 'run', script: 'scripts/ping.js' }],
      }),
      'utf-8'
    );
    const manifestPath = path.join(unitSrc, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.workflows.ping = { description: 'Run ping script' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const kDir = path.join(tmpDir, 'kd-trust');
    const targetOut = path.join(tmpDir, 'target');
    fs.mkdirSync(targetOut, { recursive: true });

    expect(runCli(['install', unitSrc, '--dir', kDir]).status).toBe(0);

    // Allowed initially (local install is trusted by default)
    const allowedRes = await toolRunWorkflow(
      kDir,
      'local-script-unit',
      'ping',
      { TARGET: targetOut },
      { strictTrust: true }
    );
    expect(allowedRes.isError).toBe(false);

    // Explicitly untrust -> must persist trusted: false and block under strictTrust
    const untrustRes = runCli(['untrust', 'local-script-unit', '--dir', kDir]);
    expect(untrustRes.status).toBe(0);

    const reg = JSON.parse(fs.readFileSync(path.join(kDir, '.registry.json'), 'utf-8'));
    expect(reg.sources[0].trusted).toBe(false);

    const blockedRes = await toolRunWorkflow(
      kDir,
      'local-script-unit',
      'ping',
      { TARGET: targetOut },
      { strictTrust: true }
    );
    expect(blockedRes.isError).toBe(true);
    expect(blockedRes.text).toContain('strict trust policy');

    // Re-trusting restores execution
    expect(runCli(['trust', 'local-script-unit', '--dir', kDir]).status).toBe(0);
    const reallowedRes = await toolRunWorkflow(
      kDir,
      'local-script-unit',
      'ping',
      { TARGET: targetOut },
      { strictTrust: true }
    );
    expect(reallowedRes.isError).toBe(false);
  });

  it('4. extra positional arguments are rejected on list, outdated, validate, scaffold, sync, catalog, publish', () => {
    const kDir = path.join(tmpDir, 'kd-args');
    expect(runCli(['init', '--dir', kDir]).status).toBe(0);

    const cases: string[][] = [
      ['list', 'extra', '--dir', kDir],
      ['outdated', 'extra', '--dir', kDir],
      ['validate', 'a', 'b', '--dir', kDir],
      ['scaffold', 'unit-a', 'extra', '--output', tmpDir],
      ['sync', 'file1.json', 'extra', '--dir', kDir],
      ['catalog', 'https://example.com/repo.git', 'extra'],
      ['publish', 'unit-a', 'extra', '--to', 'https://example.com/repo.git', '--dir', kDir],
    ];

    for (const args of cases) {
      const res = runCli(args);
      expect(res.status, `expected exit 1 for: ${args.join(' ')}`).toBe(1);
      expect(res.stderr).toContain('Unexpected argument');
    }
  });

  it('5. expandBraces caps expansion count against exponential blowup', () => {
    const huge = '{a,b}'.repeat(20); // 2^20 = 1,048,576 combinations if uncapped
    const expanded = expandBraces(huge);
    expect(expanded.length).toBeLessThanOrEqual(256);
    expect(expanded.length).toBeGreaterThan(0);

    // Normal patterns still expand completely
    expect(expandBraces('src/{a,b}/*.{ts,js}')).toEqual([
      'src/a/*.ts',
      'src/a/*.js',
      'src/b/*.ts',
      'src/b/*.js',
    ]);
  });

  it('6. index cache invalidates when .txt reference files are modified', () => {
    clearIndexCache();
    const kDir = path.join(tmpDir, 'kd-cache');
    const unitDir = path.join(kDir, 'txt-unit');
    fs.mkdirSync(path.join(unitDir, 'references'), { recursive: true });

    const refFile = path.join(unitDir, 'references', 'notes.txt');
    fs.writeFileSync(refFile, 'initial alpha token\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'txt-unit',
        version: '1.0.0',
        type: 'cookbook',
        description: 'Unit with txt reference',
        references: {
          notes: { file: 'references/notes.txt', description: 'Notes' },
        },
      }),
      'utf-8'
    );

    expect(scanDocuments(kDir)).toHaveLength(1);
    const before = JSON.parse(toolSearchDocs(kDir, 'xylophone', 10, { includeContent: true }).text);
    expect(before.total).toBe(0);

    // Update the .txt reference with a new size & content
    fs.writeFileSync(refFile, 'updated content containing xylophone keyword for testing\n', 'utf-8');

    const after = JSON.parse(toolSearchDocs(kDir, 'xylophone', 10, { includeContent: true }).text);
    expect(after.total).toBe(1);
  });
});
