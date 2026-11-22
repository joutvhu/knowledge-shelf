/**
 * Regression tests for v1.1.3 maintenance fixes:
 * 1. recordInstalledSource replaces entry cleanly so add --force doesn't retain stale trusted or pin
 * 2. install --force overwriting git entry removes stale git fields (branch, fullCommit, pin, path)
 * 3. import standalone .md archive supports --name alias
 * 4. validate on directory validates both manifest units and standalone .md files
 * 5. export format zip with output path without .zip extension succeeds
 * 6. list skips corrupted secondary layer .registry.json without process exit
 * 7. scaffold rejects names containing slashes or starting with '.'
 * 8. info rejects reserved internal paths starting with '.'
 * 9. toolGetDocSection matches headings with diacritic folding fallback
 * 10. toolGetResource returns clear message when offset exceeds total lines
 * 11. expandBraces expands braces even when pattern contains non-comma braces
 * 12. patch step rejects empty anchor for insert_before/insert_after/replace
 * 13. assertSafeArchivePaths rejects corrupted/non-archive files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  expandBraces,
  executeWorkflowSteps,
  toolGetDocSection,
  toolGetResource,
  validateManifestUnitDir,
} from '../src/core.js';
import { assertSafeArchivePaths } from '../src/cli/git.js';
import { recordInstalledSource, type Registry } from '../src/cli/registry.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

describe('v1.1.3 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v113-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. recordInstalledSource should replace entry without retaining stale trusted or pin', () => {
    const reg: Registry = {
      version: '1.0',
      sources: [
        {
          name: 'my-unit',
          url: 'https://example.com/repo1.git',
          commit: '1111111',
          pin: '1111111',
          trusted: true,
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    recordInstalledSource(reg, {
      name: 'my-unit',
      url: 'https://example.com/repo2.git',
      commit: '2222222',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(reg.sources.length).toBe(1);
    expect(reg.sources[0].url).toBe('https://example.com/repo2.git');
    expect(reg.sources[0].commit).toBe('2222222');
    expect(reg.sources[0].trusted).toBeUndefined();
    expect(reg.sources[0].pin).toBeUndefined();
  });

  it('2. install --force over git source clears git metadata', () => {
    const shelf = path.join(tmpDir, 'shelf');
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(shelf, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    expect(runCli(['init', '--dir', shelf]).status).toBe(0);

    // Write a mock git entry in registry
    const regPath = path.join(shelf, '.registry.json');
    const reg: Registry = {
      version: '1.0',
      sources: [
        {
          name: 'unit-a',
          url: 'https://github.com/org/repo.git',
          branch: 'main',
          commit: 'abcdef1',
          fullCommit: 'abcdef1234567890abcdef1234567890abcdef12',
          pin: 'abcdef1',
          path: 'sub/unit-a',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), 'utf-8');

    // Scaffold a local unit and install --force over unit-a
    expect(runCli(['scaffold', 'unit-a', '--output', work]).status).toBe(0);
    const instRes = runCli(['install', path.join(work, 'unit-a'), '--force', '--dir', shelf]);
    expect(instRes.status).toBe(0);

    const updatedReg = JSON.parse(fs.readFileSync(regPath, 'utf-8')) as Registry;
    const entry = updatedReg.sources.find((s) => s.name === 'unit-a');
    expect(entry).toBeDefined();
    expect(entry!.url).toContain('local:');
    expect(entry!.commit).toBe('local');
    expect(entry!.branch).toBeUndefined();
    expect(entry!.fullCommit).toBeUndefined();
    expect(entry!.pin).toBeUndefined();
    expect(entry!.trusted).toBe(true);
  });

  it('3. import standalone .md archive supports --name alias', () => {
    const shelf = path.join(tmpDir, 'shelf');
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(shelf, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    expect(runCli(['init', '--dir', shelf]).status).toBe(0);

    const mdFile = path.join(work, 'guide.md');
    fs.writeFileSync(
      mdFile,
      '---\ntitle: Standalone Guide\ndescription: Test doc\ntags: [test]\n---\n# Standalone Guide\n\nContent here.\n',
      'utf-8'
    );
    expect(runCli(['install', mdFile, '--dir', shelf]).status).toBe(0);

    const zipPath = path.join(work, 'guide.zip');
    expect(runCli(['export', 'guide.md', '--output', zipPath, '--format', 'zip', '--dir', shelf]).status).toBe(0);

    const shelf2 = path.join(tmpDir, 'shelf2');
    expect(runCli(['init', '--dir', shelf2]).status).toBe(0);
    const impRes = runCli(['import', zipPath, '--name', 'custom-guide.md', '--dir', shelf2]);
    expect(impRes.status).toBe(0);
    expect(fs.existsSync(path.join(shelf2, 'custom-guide.md'))).toBe(true);
  });

  it('4. validate on directory validates both manifest units and standalone .md files', () => {
    const work = path.join(tmpDir, 'repo');
    fs.mkdirSync(work, { recursive: true });

    expect(runCli(['scaffold', 'repo-unit', '--type', 'boilerplate', '--output', work]).status).toBe(0);
    const emptyMd = path.join(work, 'empty.md');
    fs.writeFileSync(emptyMd, '', 'utf-8');

    const valRes = runCli(['validate', work]);
    expect(valRes.status).toBe(1);
    expect(valRes.stdout).toContain("Validating 'empty.md'");
    expect(valRes.stdout).toContain('Markdown file is empty');
  });

  it('5. export format zip with output path without .zip extension succeeds', () => {
    const shelf = path.join(tmpDir, 'shelf');
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(shelf, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    expect(runCli(['init', '--dir', shelf]).status).toBe(0);
    expect(runCli(['scaffold', 'my-unit', '--output', work]).status).toBe(0);
    expect(runCli(['install', path.join(work, 'my-unit'), '--dir', shelf]).status).toBe(0);

    const outArchiveWithoutExt = path.join(work, 'archive-out');
    const expRes = runCli([
      'export',
      'my-unit',
      '--output',
      outArchiveWithoutExt,
      '--format',
      'zip',
      '--dir',
      shelf,
    ]);
    expect(expRes.status).toBe(0);
    expect(fs.existsSync(`${outArchiveWithoutExt}.zip`)).toBe(true);
  });

  it('6. list skips corrupted secondary layer .registry.json without process exit', () => {
    const shelfOk = path.join(tmpDir, 'shelf-ok');
    const shelfBad = path.join(tmpDir, 'shelf-bad');
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(shelfOk, { recursive: true });
    fs.mkdirSync(shelfBad, { recursive: true });
    fs.mkdirSync(work, { recursive: true });

    expect(runCli(['init', '--dir', shelfOk]).status).toBe(0);
    expect(runCli(['scaffold', 'ok-unit', '--output', work]).status).toBe(0);
    expect(runCli(['install', path.join(work, 'ok-unit'), '--dir', shelfOk]).status).toBe(0);

    fs.writeFileSync(path.join(shelfBad, '.registry.json'), '{ invalid json', 'utf-8');

    const listRes = runCli(['list', '--dir', shelfOk, '--dir', shelfBad]);
    expect(listRes.status).toBe(0);
    expect(listRes.stdout).toContain('ok-unit');
  });

  it('7. scaffold rejects names containing slashes or starting with dot', () => {
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(work, { recursive: true });

    const slashRes = runCli(['scaffold', 'nested/bad', '--output', work]);
    expect(slashRes.status).toBe(1);
    expect(slashRes.stderr).toContain('Invalid unit name');

    const dotRes = runCli(['scaffold', '.hidden', '--output', work]);
    expect(dotRes.status).toBe(1);
    expect(dotRes.stderr).toContain('Invalid unit name');
  });

  it('8. info rejects reserved internal paths starting with dot', () => {
    const shelf = path.join(tmpDir, 'shelf');
    fs.mkdirSync(shelf, { recursive: true });
    expect(runCli(['init', '--dir', shelf]).status).toBe(0);

    const infoRes = runCli(['info', '.registry.json', '--dir', shelf]);
    expect(infoRes.status).toBe(1);
    expect(infoRes.stderr).toContain('Access denied');
  });

  it('9. toolGetDocSection matches headings with diacritic folding fallback', () => {
    const shelf = path.join(tmpDir, 'shelf');
    fs.mkdirSync(shelf, { recursive: true });
    const mdFile = path.join(shelf, 'viet.md');
    fs.writeFileSync(
      mdFile,
      '# Tài liệu\n\n## Cài đặt hệ thống\n\nChạy npm install để cài đặt.\n\n## Hướng dẫn\n\nChi tiết.\n',
      'utf-8'
    );

    const res = toolGetDocSection(shelf, 'viet.md', 'cai dat he thong');
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('Chạy npm install để cài đặt.');
  });

  it('10. toolGetResource returns non-inverted lines header when offset exceeds total lines', () => {
    const shelf = path.join(tmpDir, 'shelf');
    fs.mkdirSync(shelf, { recursive: true });
    const file = path.join(shelf, 'short.txt');
    fs.writeFileSync(file, 'line 1\nline 2', 'utf-8');

    const res = toolGetResource(shelf, 'short.txt', { offset: 10, limit: 5 });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('[lines 10-10 of 2]');
  });

  it('11. expandBraces expands braces even when non-comma braces precede', () => {
    const patterns = expandBraces('src/{single}/**/*.{ts,js}');
    expect(patterns).toEqual(['src/{single}/**/*.ts', 'src/{single}/**/*.js']);
  });

  it('12. patch step rejects empty anchor for insert_before/insert_after/replace', async () => {
    const unitDir = path.join(tmpDir, 'unit');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    const manifest = {
      name: 'unit',
      version: '1.0.0',
      type: 'boilerplate',
      description: 'test',
      workflows: {
        wf: {},
      },
    };
    fs.writeFileSync(path.join(unitDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

    const wf = {
      steps: [
        {
          action: 'patch',
          target: '{{TARGET}}/file.txt',
          mode: 'insert_after',
          anchor: '',
          content: 'new content',
        },
      ],
    };
    fs.writeFileSync(path.join(unitDir, 'workflows', 'wf.json'), JSON.stringify(wf), 'utf-8');

    const val = validateManifestUnitDir(unitDir);
    expect(val.errors.some((e) => e.includes('requires non-empty "anchor"'))).toBe(true);

    const targetDir = path.join(tmpDir, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'file.txt'), 'hello', 'utf-8');

    const runRes = await executeWorkflowSteps('wf', unitDir, wf.steps, { TARGET: targetDir });
    expect(runRes.errors.some((e) => e.includes('requires a non-empty anchor'))).toBe(true);
  });

  it('13. assertSafeArchivePaths rejects corrupt archive files', () => {
    const badFile = path.join(tmpDir, 'corrupt.zip');
    fs.writeFileSync(badFile, 'not a zip file', 'utf-8');
    expect(() => assertSafeArchivePaths(badFile)).toThrow();
  });
});
