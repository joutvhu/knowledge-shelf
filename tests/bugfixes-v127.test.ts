/**
 * Regression tests for bug fixes v1.2.7:
 * 1. cmdExport excludes .git directory and supports multi-layer directories.
 * 2. cmdCatalog without shelf.json discovers nested standalone .md files.
 * 3. cmdValidate across multiple layers discovers nested units/docs in subsequent layers.
 * 4. toolRunWorkflow detects template placeholders in copy/copy_dir steps and enforces required manifest placeholders.
 * 5. cmdPublish rejects destination subpaths with hidden segments.
 * 6. toolGetDoc reports manifest.json syntax errors when manifest is malformed.
 * 7. run_workflow dry-run with strict trust includes warning on blocked script steps.
 * 8. cmdSync normalizes root path '.' to undefined.
 * 9. CLI option parsing rejects empty --opt= and supports commit messages with leading dash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearIndexCache, toolGetDoc, toolRunWorkflow } from '../src/core.js';

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

describe('Bug fixes v1.2.7 regression tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v127-'));
    clearIndexCache();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. cmdExport excludes .git directory and supports multi-layer directories', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    fs.mkdirSync(layer1, { recursive: true });
    fs.mkdirSync(layer2, { recursive: true });

    const unitDir = path.join(layer2, 'git-unit');
    fs.mkdirSync(path.join(unitDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(unitDir, '.git', 'config'), '[core]\nsecret=1\n');
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'git-unit', version: '1.0.0', type: 'template', description: 'Export test' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'overview.md'), '# Overview\n', 'utf-8');

    const zipOut = path.join(tmpDir, 'git-unit.zip');
    // Export searching across layer1 and layer2
    const resZip = runCli(['export', 'git-unit', '--output', zipOut, '--format', 'zip', '--dir', layer1, '--dir', layer2]);
    expect(resZip.status).toBe(0);
    expect(fs.existsSync(zipOut)).toBe(true);

    if (process.platform === 'win32') {
      const inspectRes = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead('${zipOut.replace(/'/g, "''")}'); $z.Entries.FullName; $z.Dispose()`,
        ],
        { encoding: 'utf-8' }
      );
      expect(inspectRes.stdout).not.toContain('.git');
    }

    const tarOut = path.join(tmpDir, 'git-unit.tar.gz');
    const resTar = runCli(['export', 'git-unit', '--output', tarOut, '--format', 'tar', '--dir', layer1, '--dir', layer2]);
    expect(resTar.status).toBe(0);
    expect(fs.existsSync(tarOut)).toBe(true);

    const tarList = spawnSync('tar', ['-ztf', tarOut], { encoding: 'utf-8' });
    if (tarList.status === 0 && tarList.stdout) {
      expect(tarList.stdout).not.toContain('.git');
    }
  });

  it('2. cmdCatalog without shelf.json discovers nested standalone .md files', () => {
    const repo = path.join(tmpDir, 'repo-nested');
    fs.mkdirSync(path.join(repo, 'guides'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'guides', 'nested-style.md'),
      '---\ndescription: Style guide\ntags: [style]\n---\n# Style\nBody\n',
      'utf-8'
    );
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Tester']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);

    const res = runCli(['catalog', repo]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('guides/nested-style.md');
    expect(res.stdout).toContain('[standalone]');
  });

  it('3. cmdValidate across multiple layers discovers nested units/docs in subsequent layers', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    fs.mkdirSync(layer1, { recursive: true });
    fs.mkdirSync(path.join(layer2, 'nested', 'my-unit'), { recursive: true });
    fs.writeFileSync(
      path.join(layer2, 'nested', 'my-unit', 'manifest.json'),
      JSON.stringify({ name: 'my-unit', version: '1.0.0', type: 'boilerplate', description: 'Desc' }),
      'utf-8'
    );
    fs.mkdirSync(path.join(layer2, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(layer2, 'docs', 'deep-guide.md'),
      '---\ndescription: Deep guide\ntags: [test]\n---\n# Deep\nContent\n',
      'utf-8'
    );

    const resUnit = runCli(['validate', 'my-unit', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(resUnit.status).toBe(0);
    expect(resUnit.stdout).toContain('nested/my-unit — OK');

    const resDoc = runCli(['validate', 'deep-guide.md', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(resDoc.status).toBe(0);
    expect(resDoc.stdout).toContain('docs/deep-guide.md — OK');
  });

  it('4. toolRunWorkflow detects template placeholders in copy steps and enforces required manifest placeholders', async () => {
    const kd = path.join(tmpDir, 'kd-ph');
    const u = path.join(kd, 'ph-unit');
    fs.mkdirSync(path.join(u, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(u, 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(u, 'manifest.json'),
      JSON.stringify({
        name: 'ph-unit',
        version: '1.0.0',
        type: 'template',
        description: 'Testing placeholder',
        placeholders: {
          TARGET: { required: true, type: 'path' },
          PACKAGE_NAME: { required: true, type: 'string' },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(u, 'templates', 'App.java'), 'package {{PACKAGE_NAME}};\n', 'utf-8');
    fs.writeFileSync(
      path.join(u, 'workflows', 'setup.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true } },
        steps: [{ action: 'copy', source: 'templates/App.java', target: '{{TARGET}}/App.java' }],
      }),
      'utf-8'
    );

    const outDir = path.join(tmpDir, 'out-ph');
    // Missing required PACKAGE_NAME should fail
    const resMissing = await toolRunWorkflow(kd, 'ph-unit', 'setup', { TARGET: outDir }, { dryRun: false });
    expect(resMissing.isError).toBe(true);
    const errObj = JSON.parse(resMissing.text);
    expect(errObj.error).toContain('Missing required inputs: ["PACKAGE_NAME"]');

    // Providing PACKAGE_NAME should succeed and replace placeholder
    const resSuccess = await toolRunWorkflow(
      kd,
      'ph-unit',
      'setup',
      { TARGET: outDir, PACKAGE_NAME: 'com.example.test' },
      { dryRun: false }
    );
    expect(resSuccess.isError).toBeFalsy();
    const createdContent = fs.readFileSync(path.join(outDir, 'App.java'), 'utf-8');
    expect(createdContent).toBe('package com.example.test;\n');
  });

  it('5. cmdPublish rejects destination subpaths with hidden segments', () => {
    const bareRepo = path.join(tmpDir, 'pub-repo.git');
    git(tmpDir, ['init', '--bare', bareRepo]);

    const unit = path.join(tmpDir, 'pub-unit');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(
      path.join(unit, 'manifest.json'),
      JSON.stringify({ name: 'pub-unit', version: '1.0.0', type: 'boilerplate', description: 'Desc' }),
      'utf-8'
    );

    const res = runCli(['publish', unit, '--to', bareRepo, '--path', 'units/.hidden/sub', '--branch', 'main']);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain('Destination path contains hidden segment');
  });

  it('6. toolGetDoc reports manifest.json syntax errors when manifest is malformed', () => {
    const kd = path.join(tmpDir, 'kd-bad');
    const u = path.join(kd, 'bad-unit');
    fs.mkdirSync(u, { recursive: true });
    fs.writeFileSync(path.join(u, 'manifest.json'), '{ broken json syntax');

    const res = toolGetDoc(kd, 'bad-unit');
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Invalid manifest.json in 'bad-unit'");
  });

  it('7. run_workflow dry-run with strict trust includes warning on blocked script steps', async () => {
    const kd = path.join(tmpDir, 'kd-strict');
    const u = path.join(kd, 'untrusted-unit');
    fs.mkdirSync(path.join(u, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(u, 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(kd, '.registry.json'),
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'untrusted-unit',
            url: 'https://example.com/repo.git',
            commit: 'abc1234',
            installedAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
        ],
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(u, 'manifest.json'),
      JSON.stringify({
        name: 'untrusted-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Untrusted',
        workflows: { test: { description: 'test' } },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(u, 'scripts', 'noop.js'), 'console.log(1);\n', 'utf-8');
    fs.writeFileSync(
      path.join(u, 'workflows', 'test.json'),
      JSON.stringify({ steps: [{ action: 'run', script: 'scripts/noop.js' }] }),
      'utf-8'
    );

    const resDry = await toolRunWorkflow(kd, 'untrusted-unit', 'test', {}, { strictTrust: true, dryRun: true });
    const parsed = JSON.parse(resDry.text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.scripts_run[0].stdout).toContain('[warning] Script execution blocked by strict trust policy');
    expect(parsed.messages).toContainEqual(expect.stringContaining('[strict-trust warning]'));
  });

  it('8. cmdSync normalizes root path . to undefined', () => {
    const seedRepo = path.join(tmpDir, 'sync-seed');
    fs.mkdirSync(seedRepo, { recursive: true });
    git(seedRepo, ['init', '-b', 'main']);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Tester']);
    fs.writeFileSync(
      path.join(seedRepo, 'manifest.json'),
      JSON.stringify({ name: 'root-unit', version: '1.0.0', type: 'boilerplate', description: 'Root unit' }),
      'utf-8'
    );
    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', 'init']);

    const bareRepo = path.join(tmpDir, 'remote-sync.git');
    execSync(`git clone --bare "${seedRepo}" "${bareRepo}"`, { stdio: 'pipe' });

    const shelfDir = path.join(tmpDir, 'sync-shelf');
    runCli(['init', '--dir', shelfDir]);
    fs.writeFileSync(
      path.join(shelfDir, 'knowledge-shelf.json'),
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'root-unit', url: bareRepo, path: '.' }],
      }),
      'utf-8'
    );

    const resSync = runCli(['sync', '--dir', shelfDir]);
    expect(resSync.status).toBe(0);

    const reg = JSON.parse(fs.readFileSync(path.join(shelfDir, '.registry.json'), 'utf-8'));
    expect(reg.sources[0].path).toBeUndefined();
  });

  it('9. CLI option parsing rejects empty --opt= and supports commit messages with leading dash', () => {
    const resEmpty = runCli(['scaffold', 'demo', '--type=']);
    expect(resEmpty.status).toBe(1);
    expect(resEmpty.stderr).toContain('--type requires an argument');

    const bareRepo = path.join(tmpDir, 'msg-repo.git');
    git(tmpDir, ['init', '--bare', bareRepo]);

    const unit = path.join(tmpDir, 'msg-unit');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(
      path.join(unit, 'manifest.json'),
      JSON.stringify({ name: 'msg-unit', version: '1.0.0', type: 'boilerplate', description: 'Desc' }),
      'utf-8'
    );

    const resMsg = runCli([
      'publish',
      unit,
      '--to',
      bareRepo,
      '--message',
      '-chore: custom dash commit',
      '--branch',
      'main',
    ]);
    expect(resMsg.status).toBe(0);
    expect(resMsg.stdout).toContain("Committed 'msg-unit'");
  });

  it('10. cmdExport blocks reserved internal paths and dot-prefixed paths', () => {
    const kb = path.join(tmpDir, 'kb-sec');
    runCli(['init', '--dir', kb]);
    const outZip = path.join(tmpDir, 'reg.zip');

    const resReg = runCli(['export', '.registry.json', '--dir', kb, '--output', outZip]);
    expect(resReg.status).not.toBe(0);
    expect(resReg.stderr).toContain('reserved internal path or starts with');
    expect(fs.existsSync(outZip)).toBe(false);

    const resCache = runCli(['export', '.cache', '--dir', kb, '--output', outZip]);
    expect(resCache.status).not.toBe(0);
    expect(resCache.stderr).toContain('reserved internal path or starts with');
  });

  it('11. cmdInfo reports invalid manifest syntax when manifest.json is malformed JSON', () => {
    const kb = path.join(tmpDir, 'kb-info');
    runCli(['init', '--dir', kb]);
    const badUnit = path.join(kb, 'broken-unit');
    fs.mkdirSync(badUnit, { recursive: true });
    fs.writeFileSync(path.join(badUnit, 'manifest.json'), '{ broken json');

    const resInfo = runCli(['info', 'broken-unit', '--dir', kb, '--no-global']);
    expect(resInfo.status).toBe(0);
    expect(resInfo.stdout).toContain('Type:         invalid manifest (invalid manifest.json:');
  });

  it('12. cmdSync throws clean error when source entry in knowledge-shelf.json is missing url', () => {
    const kb = path.join(tmpDir, 'kb-sync-err');
    runCli(['init', '--dir', kb]);
    const badCfg = path.join(tmpDir, 'bad-team-shelf.json');
    fs.writeFileSync(badCfg, JSON.stringify({ version: '1.0', sources: [{ name: 'missing-url' }] }));

    const resSync = runCli(['sync', '--file', badCfg, '--dir', kb]);
    expect(resSync.status).not.toBe(0);
    expect(resSync.stderr).toContain("sources[0] must be an object with non-empty 'name' and 'url' strings");
  });

  it('13. toolRunWorkflow copy_dir respects exclude patterns and detects filename placeholders', async () => {
    const kd = path.join(tmpDir, 'kd-copydir');
    const u = path.join(kd, 'cd-unit');
    fs.mkdirSync(path.join(u, 'templates', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(u, 'workflows'), { recursive: true });

    // File that is excluded contains an undeclared/required placeholder {{EXCLUDED_ONLY}}
    fs.writeFileSync(path.join(u, 'templates', 'sub', 'ignored.bak'), '{{EXCLUDED_ONLY}}\n');
    // File that is included has placeholder in filename {{FILENAME_PH}}
    fs.writeFileSync(path.join(u, 'templates', 'sub', '{{FILENAME_PH}}.txt'), 'content\n');

    fs.writeFileSync(
      path.join(u, 'manifest.json'),
      JSON.stringify({
        name: 'cd-unit',
        version: '1.0.0',
        type: 'template',
        description: 'Test copy_dir placeholder detection',
        placeholders: {
          TARGET: { required: true, type: 'path' },
          EXCLUDED_ONLY: { required: true, type: 'string' },
          FILENAME_PH: { required: true, type: 'string' },
        },
      }),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(u, 'workflows', 'setup.json'),
      JSON.stringify({
        steps: [
          {
            action: 'copy_dir',
            source: 'templates/sub',
            target: '{{TARGET}}/out',
            exclude: ['**/*.bak'],
          },
        ],
      }),
      'utf-8'
    );

    const outDir = path.join(tmpDir, 'cd-out');
    // Because **/*.bak is excluded, EXCLUDED_ONLY should NOT be required!
    // But FILENAME_PH is used in filename, so missing FILENAME_PH should fail:
    const resMissing = await toolRunWorkflow(kd, 'cd-unit', 'setup', { TARGET: outDir }, { dryRun: false });
    expect(resMissing.isError).toBe(true);
    const errObj = JSON.parse(resMissing.text);
    expect(errObj.error).toContain('Missing required inputs: ["FILENAME_PH"]');
    expect(errObj.error).not.toContain('EXCLUDED_ONLY');

    // Supplying FILENAME_PH should succeed and create rendered filename:
    const resOk = await toolRunWorkflow(
      kd,
      'cd-unit',
      'setup',
      { TARGET: outDir, FILENAME_PH: 'my-file' },
      { dryRun: false }
    );
    expect(resOk.isError).toBeFalsy();
    expect(fs.existsSync(path.join(outDir, 'out', 'my-file.txt'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'out', 'ignored.bak'))).toBe(false);
  });
});
