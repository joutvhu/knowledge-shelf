/**
 * Regression tests for bug fixes v1.2.4:
 * 1. stripBom handles UTF-8 BOM in manifest.json, registry, and workflow JSON files.
 * 2. cmdAdd single file with nested --name creates parent directories without ENOENT crash.
 * 3. Windows case-insensitivity in registry lookups (remove, install --force, trust, pin, unpin).
 * 4. cmdAdd --path normalizes backslashes for sparse checkout and registry storage.
 * 5. VAL_OPTIONS supports --format=tar / --format=zip in export.
 * 6. -f --help displays help on commands where -f is --force.
 * 7. cmdExport nested standalone .md then cmdImport --name installs the single doc cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  loadManifest,
  stripBom,
  validateManifestUnitDir,
} from '../src/core.js';
import { isSameUnitName, loadRegistry, recordInstalledSource, Registry } from '../src/cli/registry.js';

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

describe('Bug Fixes v1.2.4', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v124-'));
    clearIndexCache();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('stripBom strips UTF-8 BOM correctly and allows parsing BOM JSON', () => {
    expect(stripBom('\uFEFF{"name": "test"}')).toBe('{"name": "test"}');
    expect(stripBom('{"name": "test"}')).toBe('{"name": "test"}');

    const bomUnit = path.join(tmpDir, 'bom-unit');
    fs.mkdirSync(bomUnit, { recursive: true });
    fs.writeFileSync(
      path.join(bomUnit, 'manifest.json'),
      '\uFEFF' + JSON.stringify({ name: 'bom-unit', version: '1.0.0', type: 'boilerplate', description: 'BOM test' }),
      'utf-8'
    );

    const m = loadManifest(bomUnit);
    expect(m).not.toBeNull();
    expect(m?.name).toBe('bom-unit');

    const val = validateManifestUnitDir(bomUnit, 'bom-unit');
    expect(val.errors).toHaveLength(0);
  });

  it('VAL_OPTIONS splits --format=tar in export and -f --help displays help', () => {
    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const unitDir = path.join(tmpDir, 'my-unit');
    runCli(['scaffold', 'my-unit', '--type', 'toolkit', '--output', tmpDir]);
    runCli(['install', unitDir, '--dir', shelfDir]);

    const outTar = path.join(tmpDir, 'exported.tar.gz');
    const resTar = runCli(['export', 'my-unit', '--format=tar', '--output', outTar, '--dir', shelfDir]);
    expect(resTar.status).toBe(0);
    expect(fs.existsSync(outTar)).toBe(true);

    // Test -f --help
    const resHelp = runCli(['add', 'https://example.com/repo.git', '-f', '--help', '--dir', shelfDir]);
    expect(resHelp.status).toBe(0);
    expect(resHelp.stdout).toContain('Knowledge Shelf');
    expect(resHelp.stdout).toContain('Usage:');
  });

  it('cmdAdd single file with nested --name creates parent dirs without ENOENT', () => {
    const repoDir = path.join(tmpDir, 'repo');
    const docsDir = path.join(repoDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'guide.md'),
      '---\ntitle: Guide\ndescription: A nested guide\ntags: [guide]\n---\n# Guide\nBody content.\n',
      'utf-8'
    );

    git(repoDir, ['init', '-q']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'init']);

    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const res = runCli([
      'add',
      repoDir,
      '--path',
      'docs/guide.md',
      '--name',
      'sub/my-guide',
      '--dir',
      shelfDir,
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("✓ Installed 'sub/my-guide.md'");

    const installedFile = path.join(shelfDir, 'sub', 'my-guide.md');
    expect(fs.existsSync(installedFile)).toBe(true);
  });

  it('cmdAdd normalizes backslashes in --path for sparse checkout', () => {
    const repoDir = path.join(tmpDir, 'repo');
    const unitDir = path.join(repoDir, 'units', 'test-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'test-unit', version: '1.0.0', type: 'boilerplate', description: 'Sparse test' }),
      'utf-8'
    );

    git(repoDir, ['init', '-q']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'init']);

    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const res = runCli([
      'add',
      repoDir,
      '--path',
      'units\\test-unit',
      '--dir',
      shelfDir,
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("✓ Installed 'test-unit'");

    const reg = loadRegistry(shelfDir);
    const entry = reg.sources.find((s) => s.name === 'test-unit');
    expect(entry).toBeDefined();
    expect(entry?.path).toBe('units/test-unit');
  });

  it('case-insensitive registry matching updates existing entry and removes correctly on Windows', () => {
    const reg: Registry = {
      version: '1.0',
      sources: [
        {
          name: 'MyCaseUnit',
          url: 'local:/path/to/MyCaseUnit',
          commit: 'local',
          installedAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ],
    };

    recordInstalledSource(reg, {
      name: 'mycaseunit',
      url: 'local:/path/to/mycaseunit-new',
      commit: 'local',
      installedAt: '2026-01-01',
      updatedAt: '2026-01-02',
    });

    if (process.platform === 'win32') {
      expect(reg.sources).toHaveLength(1);
      expect(reg.sources[0].url).toBe('local:/path/to/mycaseunit-new');
    }

    expect(isSameUnitName('MyUnit', 'myunit')).toBe(process.platform === 'win32');

    // Test CLI remove case-insensitivity
    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const unitDir = path.join(tmpDir, 'CaseUnit');
    runCli(['scaffold', 'CaseUnit', '--type', 'toolkit', '--output', tmpDir]);
    runCli(['install', unitDir, '--dir', shelfDir]);

    const regBefore = loadRegistry(shelfDir);
    expect(regBefore.sources.some((s) => isSameUnitName(s.name, 'CaseUnit'))).toBe(true);

    const resRemove = runCli(['remove', 'caseunit', '--dir', shelfDir]);
    if (process.platform === 'win32') {
      expect(resRemove.status).toBe(0);
      const regAfter = loadRegistry(shelfDir);
      expect(regAfter.sources.some((s) => isSameUnitName(s.name, 'CaseUnit'))).toBe(false);
    }
  });

  it('cmdExport nested standalone .md then cmdImport --name installs cleanly', () => {
    const shelfDir = path.join(tmpDir, 'shelf');
    runCli(['init', '--dir', shelfDir]);

    const guidesDir = path.join(shelfDir, 'guides');
    fs.mkdirSync(guidesDir, { recursive: true });
    fs.writeFileSync(
      path.join(guidesDir, 'deploy.md'),
      '---\ntitle: Deploy Guide\ndescription: Deployment instructions\ntags: [deploy]\n---\n# Deploy\nContent here.\n',
      'utf-8'
    );

    const archivePath = path.join(tmpDir, 'deploy.zip');
    const resExp = runCli(['export', 'guides/deploy.md', '--dir', shelfDir, '--output', archivePath]);
    expect(resExp.status).toBe(0);

    const targetShelf = path.join(tmpDir, 'target-shelf');
    runCli(['init', '--dir', targetShelf]);

    const resImp = runCli(['import', archivePath, '--name', 'renamed-deploy', '--dir', targetShelf]);
    expect(resImp.status).toBe(0);
    expect(resImp.stdout).toContain("✓ Installed standalone knowledge 'renamed-deploy.md'");

    const reg = loadRegistry(targetShelf);
    expect(reg.sources.some((s) => s.name === 'renamed-deploy.md')).toBe(true);
  });
});
