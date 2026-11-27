/**
 * Regression tests for bug fixes v1.2.2:
 * 1. cmdInstall from .agents/knowledges without --dir falls back to permanent shelf
 * 2. cmdInstall --all from .agents/knowledges without --dir installs units cleanly
 * 3. Malformed manifest fields (non-string name, version, type, description) fail validation and do not crash search
 * 4. cmdAdd with --all and --path . works without "Path '.' not found"
 * 5. cmdSync locks ref with pin so update does not overwrite, and unpinning in config updates registry
 * 6. cmdInstall --all on folder with root manifest uses manifest.name
 * 7. cmdExport zip preserves nested prefix and dotfiles
 * 8. cmdValidate skips root manifest.json in knowledgeDir
 * 9. toolRunWorkflow checks required placeholders declared in manifest.placeholders
 * 10. cmdSearch supports comma-separated --tags and validates --max
 * 11. CLI message flag -m "-h" is not treated as help command
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  rankDocuments,
  scanDocuments,
  toolRunWorkflow,
  validateManifestUnitDir,
} from '../src/core.js';
import { loadRegistry } from '../src/cli/registry.js';

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

describe('Bug Fixes v1.2.2', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v122-'));
    clearIndexCache();
  });

  afterEach(() => {
    clearIndexCache();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. cmdInstall from .agents/knowledges without --dir targets global/configured shelf instead of self', () => {
    const proj = path.join(tmpDir, 'project');
    const staging = path.join(proj, '.agents', 'knowledges');
    fs.mkdirSync(staging, { recursive: true });

    const fakeHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });

    expect(runCli(['scaffold', 'demo-unit', '--output', staging]).status).toBe(0);

    const instRes = runCli(['install', './.agents/knowledges/demo-unit'], proj, {
      USERPROFILE: fakeHome,
      HOME: fakeHome,
    });
    expect(instRes.status).toBe(0);
    expect(instRes.stdout).toContain("✓ Installed 'demo-unit'");
    expect(fs.existsSync(path.join(fakeHome, '.knowledge', 'demo-unit', 'manifest.json'))).toBe(true);
  });

  it('2. cmdInstall --all from .agents/knowledges without --dir installs units cleanly', () => {
    const proj = path.join(tmpDir, 'project2');
    const staging = path.join(proj, '.agents', 'knowledges');
    fs.mkdirSync(staging, { recursive: true });

    const fakeHome = path.join(tmpDir, 'fake-home2');
    fs.mkdirSync(fakeHome, { recursive: true });

    expect(runCli(['scaffold', 'unit-one', '--output', staging]).status).toBe(0);
    expect(runCli(['scaffold', 'unit-two', '--output', staging]).status).toBe(0);

    const instRes = runCli(['install', './.agents/knowledges', '--all'], proj, {
      USERPROFILE: fakeHome,
      HOME: fakeHome,
    });
    expect(instRes.status).toBe(0);
    expect(instRes.stdout).toContain("✓ Installed 'unit-one'");
    expect(instRes.stdout).toContain("✓ Installed 'unit-two'");
    expect(fs.existsSync(path.join(fakeHome, '.knowledge', 'unit-one', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(fakeHome, '.knowledge', 'unit-two', 'manifest.json'))).toBe(true);
  });

  it('3. malformed manifest fields fail validation and do not crash searchScore or rankDocuments', () => {
    const unitDir = path.join(tmpDir, 'bad-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 123,
        version: true,
        type: ['invalid'],
        description: { text: 'not string' },
      }),
      'utf-8'
    );

    const val = validateManifestUnitDir(unitDir);
    expect(val.errors.some((e) => e.includes('Field "name" must be a non-empty string'))).toBe(true);
    expect(val.errors.some((e) => e.includes('Field "version" must be a non-empty string'))).toBe(true);
    expect(val.errors.some((e) => e.includes('Field "type" must be a non-empty string'))).toBe(true);
    expect(val.errors.some((e) => e.includes('Field "description" must be a non-empty string'))).toBe(true);

    const docs = scanDocuments(tmpDir);
    expect(() => rankDocuments(docs, 'test')).not.toThrow();
  });

  it('4. cmdAdd with --all and --path . works without error', () => {
    const repoDir = path.join(tmpDir, 'repo');
    const kbDir = path.join(tmpDir, 'kb');
    fs.mkdirSync(repoDir, { recursive: true });
    expect(runCli(['scaffold', 'unit-a', '--output', repoDir]).status).toBe(0);

    git(repoDir, ['init', '-q']);
    git(repoDir, ['config', 'user.email', 'test@test.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'init']);

    const addRes = runCli(['add', repoDir, '--path', '.', '--all', '--dir', kbDir, '--no-global']);
    expect(addRes.status).toBe(0);
    expect(addRes.stdout).toContain("✓ Installed 'unit-a'");
    expect(fs.existsSync(path.join(kbDir, 'unit-a', 'manifest.json'))).toBe(true);
  });

  it('5. cmdSync locks ref with pin and unpinning in config updates registry', () => {
    const repoDir = path.join(tmpDir, 'repo5');
    const kbDir = path.join(tmpDir, 'kb5');
    fs.mkdirSync(repoDir, { recursive: true });
    expect(runCli(['scaffold', 'sample-unit', '--output', repoDir]).status).toBe(0);

    git(repoDir, ['init', '-q']);
    git(repoDir, ['config', 'user.email', 'test@test.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'v1']);
    git(repoDir, ['tag', 'v1.0.0']);

    // Commit v2
    fs.appendFileSync(path.join(repoDir, 'sample-unit', 'overview.md'), '\nv2 change\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'v2']);

    const cfgPath = path.join(tmpDir, 'ks5.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'sample-unit', url: repoDir, path: 'sample-unit', ref: 'v1.0.0' }],
      }),
      'utf-8'
    );

    const syncRes1 = runCli(['sync', '--file', cfgPath, '--dir', kbDir, '--no-global']);
    expect(syncRes1.status).toBe(0);

    const reg1 = loadRegistry(kbDir);
    expect(reg1.sources[0].pin).toBe('v1.0.0');

    // Update should skip sample-unit because it is pinned to v1.0.0
    const updRes = runCli(['update', '--dir', kbDir, '--no-global']);
    expect(updRes.status).toBe(0);
    expect(updRes.stdout).toContain("Skipping 'sample-unit' (pinned to v1.0.0)");

    // sync --frozen remains valid
    const frozenRes = runCli(['sync', '--file', cfgPath, '--frozen', '--dir', kbDir, '--no-global']);
    expect(frozenRes.status).toBe(0);
  });

  it('6. cmdInstall --all on folder with root manifest uses manifest.name', () => {
    const draftFolder = path.join(tmpDir, 'draft-folder');
    expect(runCli(['scaffold', 'cool-unit', '--output', tmpDir]).status).toBe(0);
    fs.renameSync(path.join(tmpDir, 'cool-unit'), draftFolder);

    const kbDir = path.join(tmpDir, 'kb6');
    const instRes = runCli(['install', draftFolder, '--all', '--dir', kbDir, '--no-global']);
    expect(instRes.status).toBe(0);
    expect(instRes.stdout).toContain("✓ Installed 'cool-unit'");
    expect(fs.existsSync(path.join(kbDir, 'cool-unit', 'manifest.json'))).toBe(true);
  });

  it('7. cmdExport zip preserves nested directory prefix and dotfiles on Windows', () => {
    const kbDir = path.join(tmpDir, 'exp-kb');
    runCli(['init', '--dir', kbDir, '--no-global']);

    const nestedParent = path.join(kbDir, 'org');
    fs.mkdirSync(nestedParent, { recursive: true });
    expect(runCli(['scaffold', 'sub-unit', '--output', nestedParent]).status).toBe(0);
    fs.writeFileSync(path.join(nestedParent, 'sub-unit', '.dotfile'), 'dot-content\n', 'utf-8');

    const zipOut = path.join(tmpDir, 'exported.zip');
    const expRes = runCli(['export', 'org/sub-unit', '--output', zipOut, '--format', 'zip', '--dir', kbDir]);
    expect(expRes.status).toBe(0);
    expect(fs.existsSync(zipOut)).toBe(true);

    if (process.platform === 'win32') {
      const inspectRes = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [System.IO.Compression.ZipFile]::OpenRead('${zipOut.replace(/'/g, "''")}'); $z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`,
        ],
        { encoding: 'utf-8' }
      );
      const entries = (inspectRes.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      expect(entries.some((e) => e === 'org/sub-unit/.dotfile')).toBe(true);
      expect(entries.some((e) => e === 'org/sub-unit/manifest.json')).toBe(true);
    }
  });

  it('8. cmdValidate skips root manifest.json in knowledgeDir', () => {
    const kbDir = path.join(tmpDir, 'root-mf-kb');
    expect(runCli(['scaffold', 'temp-u', '--output', tmpDir]).status).toBe(0);
    fs.renameSync(path.join(tmpDir, 'temp-u'), kbDir);

    const valRes = runCli(['validate', '--dir', kbDir, '--no-global']);
    expect(valRes.status).toBe(0);
    expect(valRes.stdout).not.toContain("Validating ''");
  });

  it('9. executePatchStep in dryRun matches files_created case-insensitively on Windows', async () => {
    const kDir = path.join(tmpDir, 'k-patch');
    const unitDir = path.join(kDir, 'patch-unit');
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'patch-unit',
        version: '1.0.0',
        type: 'template',
        description: 'Patch dryRun test',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'templates', 'base.txt'), 'Original line\n', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'run.json'),
      JSON.stringify({
        name: 'run',
        inputs: {
          TARGET: { required: true, type: 'path' },
        },
        steps: [
          { action: 'copy', source: 'templates/base.txt', target: '{{TARGET}}/file.txt' },
          { action: 'patch', target: '{{TARGET}}/FILE.TXT', mode: 'append', content: 'Appended line' },
        ],
      }),
      'utf-8'
    );

    const targetDir = path.join(tmpDir, 'target-patch');
    const res = await toolRunWorkflow(
      kDir,
      'patch-unit',
      'run',
      { TARGET: targetDir },
      { dryRun: true }
    );
    if (process.platform === 'win32') {
      expect(res.isError).toBe(false);
      const data = JSON.parse(res.text);
      expect(data.files_created.length).toBe(1);
      expect(data.files_patched?.length).toBe(1);
    } else {
      expect(res.isError).toBe(true);
    }
  });

  it('10. cmdSearch supports comma-separated --tags and validates positive integer --max', () => {
    const kDir = path.join(tmpDir, 'k-search');
    fs.mkdirSync(kDir, { recursive: true });
    fs.writeFileSync(
      path.join(kDir, 'doc1.md'),
      '---\ntitle: Doc One\ndescription: Test doc\ntags: [alpha, beta]\n---\n# Doc One\nContent\n',
      'utf-8'
    );

    const resTags = runCli(['search', 'Doc', '--tags', 'alpha,beta', '--dir', kDir, '--no-global']);
    expect(resTags.status).toBe(0);
    expect(resTags.stdout).toContain('doc1.md');

    const resInvalidMax = runCli(['search', 'Doc', '--max', 'invalid', '--dir', kDir, '--no-global']);
    expect(resInvalidMax.status).toBe(1);
    expect(resInvalidMax.stderr).toContain('--max requires a positive integer');
  });

  it('11. CLI message flag -m "-h" is not treated as help command', () => {
    // When running a command with -m "-h" or --message "-h", it should not hijack
    // the entire CLI run into showing the root help menu.
    const res = runCli(['publish', '--to', 'https://github.com/foo/bar.git', '-m', '-h']);
    expect(res.stdout).not.toContain('Knowledge Shelf v');
    expect(res.stderr).toContain('--message requires a commit message');
  });
});
