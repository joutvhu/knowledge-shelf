/**
 * Regression tests for bug fixes:
 * 1. cmdSync falling back to .registry.json preserves branch and does not auto-pin unpinned units.
 * 2. cmdValidate matches unit names case-insensitively on Windows.
 * 3. cmdPublish for standalone .md updates shelf.json on target repository branch.
 * 4. cmdExport with --output pointing to an existing directory writes inside the directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function git(dir: string, args: string[]) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout || '').trim();
}

describe('Bug fixes v1.2.6 regression tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v126-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. cmdSync falling back to .registry.json preserves branch and does not pin unpinned sources', () => {
    const seedRepo = path.join(tmpDir, 'seed');
    fs.mkdirSync(seedRepo, { recursive: true });
    git(seedRepo, ['init', '-b', 'main']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Tester']);

    const unitDir = path.join(seedRepo, 'demo-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'demo-unit', version: '1.0.0', type: 'cookbook', description: 'Demo unit' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'overview.md'), '# Demo Unit\nInitial.\n', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', 'init']);

    const bareRepo = path.join(tmpDir, 'remote.git');
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);
    const addRes = runCli(['add', bareRepo, '--path', 'demo-unit', '--dir', shelfDir]);
    expect(addRes.status).toBe(0);

    const regPath = path.join(shelfDir, '.registry.json');
    const regBefore = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    expect(regBefore.sources[0].branch).toBe('main');
    expect(regBefore.sources[0].pin).toBeUndefined();

    // Advance remote
    fs.appendFileSync(path.join(unitDir, 'overview.md'), 'Remote update.\n', 'utf-8');
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', 'update']);
    git(seedRepo, ['push', bareRepo, 'main']);

    // Run sync without knowledge-shelf.json (fallback to .registry.json)
    const syncRes = runCli(['sync', '--dir', shelfDir]);
    expect(syncRes.status).toBe(0);

    const regAfter = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    expect(regAfter.sources[0].branch).toBe('main');
    expect(regAfter.sources[0].pin).toBeUndefined();

    // Verify update immediately after sync does NOT skip as pinned
    const updateRes = runCli(['update', '--dir', shelfDir]);
    expect(updateRes.status).toBe(0);
    expect(updateRes.stdout).not.toContain('pinned to');
  });

  it('2. cmdValidate matches unit names case-insensitively on Windows', () => {
    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const mixedUnit = path.join(shelfDir, 'MyMixedUnit');
    fs.mkdirSync(mixedUnit, { recursive: true });
    // Write invalid manifest.json
    fs.writeFileSync(path.join(mixedUnit, 'manifest.json'), '{ broken JSON', 'utf-8');

    // Validating with exact case should fail
    const resExact = runCli(['validate', 'MyMixedUnit', '--dir', shelfDir, '--no-global']);
    expect(resExact.status).toBe(1);
    expect(resExact.stdout + resExact.stderr).toContain('manifest.json is invalid JSON');

    if (process.platform === 'win32') {
      // Validating with lowercase name on Windows should also catch the error
      const resLower = runCli(['validate', 'mymixedunit', '--dir', shelfDir, '--no-global']);
      expect(resLower.status).toBe(1);
      expect(resLower.stdout + resLower.stderr).toContain('manifest.json is invalid JSON');
    }
  });

  it('3. cmdPublish for standalone .md updates shelf.json on target repository branch', () => {
    const seedRepo = path.join(tmpDir, 'seed-repo');
    runCli(['scaffold', 'seed-repo', '--type', 'repo', '--output', tmpDir]);
    git(seedRepo, ['init', '-b', 'main']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Tester']);
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', 'init']);

    const bareRepo = path.join(tmpDir, 'remote-shelf.git');
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    const standaloneMd = path.join(tmpDir, 'guide-extra.md');
    fs.writeFileSync(
      standaloneMd,
      '---\ntitle: Extra Guide\ndescription: Extra standalone documentation\ntags: [extra]\n---\n# Extra Guide\n\nContent here.\n',
      'utf-8'
    );

    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const pubRes = runCli([
      'publish',
      standaloneMd,
      '--to',
      bareRepo,
      '--branch',
      'main',
      '--push',
      '--dir',
      shelfDir,
    ]);
    expect(pubRes.status).toBe(0);

    const verifyClone = path.join(tmpDir, 'verify-clone');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyClone]);

    expect(fs.existsSync(path.join(verifyClone, 'guide-extra.md'))).toBe(true);
    const shelfContent = JSON.parse(fs.readFileSync(path.join(verifyClone, 'shelf.json'), 'utf-8'));
    const foundDoc = shelfContent.units.find((u: any) => u.name === 'guide-extra.md');
    expect(foundDoc).toBeDefined();
    expect(foundDoc.type).toBe('standalone');
  });

  it('4. cmdExport with --output pointing to an existing directory writes inside the directory', () => {
    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const unitDir = path.join(shelfDir, 'export-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'export-unit', version: '1.0.0', type: 'template', description: 'Export test' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'overview.md'), '# Export Unit\n', 'utf-8');

    const outDir = path.join(tmpDir, 'my-exports');
    fs.mkdirSync(outDir, { recursive: true });

    const exportRes = runCli(['export', 'export-unit', '--output', outDir, '--dir', shelfDir]);
    expect(exportRes.status).toBe(0);

    const expectedZip = path.join(outDir, 'export-unit.zip');
    expect(fs.existsSync(expectedZip)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'my-exports.zip'))).toBe(false);
  });
});
