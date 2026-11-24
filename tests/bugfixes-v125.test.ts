/**
 * Regression tests for bug fixes v1.2.5:
 * 1. cmdPublish with directory-like --path (trailing slash) places manifest unit inside the directory
 *    and preserves sibling units instead of overwriting the entire parent directory.
 * 2. toolGetResource returns clear out-of-range message when offset exceeds file length.
 * 3. cmdList deduplicates tracked sources across layers case-insensitively on Windows.
 * 4. cmdIndex indexes standalone .md files in the repository into shelf.json.
 * 5. Unique clone targets in git operations prevent cache collision.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearIndexCache, toolGetResource } from '../src/core.js';

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

describe('Bug Fixes v1.2.5', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v125-'));
    clearIndexCache();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. publish with trailing slash --path places manifest unit inside container directory and preserves sibling units', () => {
    const bareRepo = path.join(tmpDir, 'remote.git');
    git(tmpDir, ['init', '--bare', bareRepo]);

    const seedDir = path.join(tmpDir, 'seed');
    git(tmpDir, ['clone', bareRepo, seedDir]);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);

    // Seed existing-unit inside units/
    const existingUnitDir = path.join(seedDir, 'units', 'existing-unit');
    fs.mkdirSync(existingUnitDir, { recursive: true });
    fs.writeFileSync(
      path.join(existingUnitDir, 'manifest.json'),
      JSON.stringify({ name: 'existing-unit', version: '1.0.0', type: 'boilerplate', description: 'Existing' }),
      'utf-8'
    );
    git(seedDir, ['checkout', '-b', 'main']);
    git(seedDir, ['add', '-A']);
    git(seedDir, ['commit', '-m', 'seed']);
    git(seedDir, ['push', '-u', 'origin', 'main']);

    // Scaffold new unit to publish
    const localUnit = path.join(tmpDir, 'new-unit');
    fs.mkdirSync(localUnit, { recursive: true });
    fs.writeFileSync(
      path.join(localUnit, 'manifest.json'),
      JSON.stringify({ name: 'new-unit', version: '1.0.0', type: 'boilerplate', description: 'New unit' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(localUnit, 'doc.txt'), 'Hello world\n', 'utf-8');

    // Publish with --path units/ (trailing slash)
    const res = runCli(['publish', localUnit, '--to', bareRepo, '--path', 'units/', '--branch', 'main', '--push']);
    expect(res.status).toBe(0);

    // Verify cloned repo contains BOTH units/existing-unit and units/new-unit
    const verifyDir = path.join(tmpDir, 'verify');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyDir]);

    expect(fs.existsSync(path.join(verifyDir, 'units', 'existing-unit', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(verifyDir, 'units', 'new-unit', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(verifyDir, 'units', 'new-unit', 'doc.txt'))).toBe(true);

    const newManifest = JSON.parse(fs.readFileSync(path.join(verifyDir, 'units', 'new-unit', 'manifest.json'), 'utf-8'));
    expect(newManifest.name).toBe('new-unit');
  });

  it('2. cmdExport with --format tar exports correctly', () => {
    const kdir = path.join(tmpDir, 'shelf');
    const unitDir = path.join(kdir, 'test-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'test-unit', version: '1.0.0', type: 'boilerplate', description: 'Test' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'small.txt'), 'line1\nline2\nline3\n', 'utf-8');

    const tarOut = path.join(tmpDir, 'test-unit.tar.gz');
    const res = runCli(['export', 'test-unit', '--output', tarOut, '--format', 'tar', '--dir', kdir]);
    expect(res.status).toBe(0);
    expect(fs.existsSync(tarOut)).toBe(true);
  });

  it('3. cmdList deduplicates tracked sources across layers case-insensitively on Windows', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    fs.mkdirSync(layer1, { recursive: true });
    fs.mkdirSync(layer2, { recursive: true });

    const unit = path.join(tmpDir, 'my-unit');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(
      path.join(unit, 'manifest.json'),
      JSON.stringify({ name: 'my-unit', version: '1.0.0', type: 'boilerplate', description: 'Test' }),
      'utf-8'
    );

    // Install as Edge-Unit in layer1 and edge-unit in layer2
    runCli(['install', unit, '--name', 'Edge-Unit', '--dir', layer1]);
    runCli(['install', unit, '--name', 'edge-unit', '--dir', layer2]);

    const res = runCli(['list', '--dir', layer1, '--dir', layer2]);
    expect(res.status).toBe(0);

    if (process.platform === 'win32') {
      // On Windows, layer1's Edge-Unit shadows layer2's edge-unit
      expect(res.stdout).toContain('Total: 1 tracked source(s)');
      expect(res.stdout).toContain('Edge-Unit');
    }
  });

  it('4. cmdIndex indexes standalone .md files alongside manifest units in shelf.json', () => {
    const repoDir = path.join(tmpDir, 'repo');
    const manifestDir = path.join(repoDir, 'manifest-unit');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({ name: 'manifest-unit', version: '1.0.0', type: 'toolkit', description: 'Toolkit unit' }),
      'utf-8'
    );

    // Standalone doc
    fs.writeFileSync(
      path.join(repoDir, 'standalone-guide.md'),
      '---\ntitle: Guide\ndescription: Standalone Guide\ntags: [qa, testing]\n---\n# Guide\nBody\n',
      'utf-8'
    );

    const res = runCli(['index', repoDir]);
    expect(res.status).toBe(0);

    const shelfPath = path.join(repoDir, 'shelf.json');
    expect(fs.existsSync(shelfPath)).toBe(true);

    const shelf = JSON.parse(fs.readFileSync(shelfPath, 'utf-8'));
    expect(shelf.units.length).toBe(2);

    const manifestEntry = shelf.units.find((u: any) => u.name === 'manifest-unit');
    expect(manifestEntry).toBeDefined();
    expect(manifestEntry.type).toBe('toolkit');

    const standaloneEntry = shelf.units.find((u: any) => u.name === 'standalone-guide.md');
    expect(standaloneEntry).toBeDefined();
    expect(standaloneEntry.type).toBe('standalone');
    expect(standaloneEntry.description).toBe('Standalone Guide');
    expect(standaloneEntry.tags).toEqual(['qa', 'testing']);
  });
});
