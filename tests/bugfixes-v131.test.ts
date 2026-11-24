/**
 * Regression tests for bug fixes v1.3.1:
 * 1. Archive import/inspection rejects symbolic and hard links in .tar.gz archives.
 * 2. sync with a failing/invalid entry still saves previously synced entries to .registry.json and cleans .cache.
 * 3. export refuses to write the output archive inside the exported unit directory.
 * 4. publish of a standalone .md with --path <dir> (no trailing slash) places the file inside that directory.
 * 5. validateManifestUnitDir catches type errors on tags, aliases, placeholders, workflow.inputs, and run step args.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearIndexCache, validateManifestUnitDir } from '../src/core.js';
import { assertNoSymlinks, assertSafeArchivePaths } from '../src/cli/git.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function git(dir: string, args: string[]) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 60_000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout || '').trim();
}

describe('Bug fixes v1.3.1', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v131-'));
    clearIndexCache();
  });

  afterEach(() => {
    clearIndexCache();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. import and assertSafeArchivePaths reject symlinks and hardlinks in archives', () => {
    const stage = path.join(tmpDir, 'stage');
    fs.mkdirSync(stage, { recursive: true });
    const secretFile = path.join(tmpDir, 'secret-outside.txt');
    fs.writeFileSync(secretFile, 'TOP_SECRET_DATA\n', 'utf-8');
    const regularFile = path.join(stage, 'normal.md');
    fs.writeFileSync(regularFile, '# Normal\nContent\n', 'utf-8');

    // Hardlink test (works without elevated privileges on Windows & Unix)
    const hardlinkPath = path.join(stage, 'hardlink.md');
    fs.linkSync(regularFile, hardlinkPath);
    const hardTar = path.join(tmpDir, 'hard.tar.gz');
    const tarHardRes = spawnSync('tar', ['-czf', hardTar, '-C', stage, 'normal.md', 'hardlink.md'], {
      stdio: 'pipe',
    });
    expect(tarHardRes.status).toBe(0);
    expect(() => assertSafeArchivePaths(hardTar)).toThrow(/symbolic or hard link/i);

    const kb = path.join(tmpDir, 'shelf');
    const impHardRes = runCli(['import', hardTar, '--dir', kb, '--no-global']);
    expect(impHardRes.status).toBe(1);
    expect(impHardRes.stderr).toMatch(/symbolic or hard link/i);

    // Symlink test (if OS permissions allow creating symlinks)
    const symStage = path.join(tmpDir, 'sym-stage');
    fs.mkdirSync(symStage, { recursive: true });
    let symlinkCreated = false;
    try {
      fs.symlinkSync(secretFile, path.join(symStage, 'evil.md'));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      expect(() => assertNoSymlinks(symStage)).toThrow(/symbolic link/i);

      const symTar = path.join(tmpDir, 'sym.tar.gz');
      const tarSymRes = spawnSync('tar', ['-czf', symTar, '-C', symStage, 'evil.md'], {
        stdio: 'pipe',
      });
      expect(tarSymRes.status).toBe(0);
      expect(() => assertSafeArchivePaths(symTar)).toThrow(/symbolic or hard link/i);

      const impSymRes = runCli(['import', symTar, '--dir', kb, '--no-global']);
      expect(impSymRes.status).toBe(1);
      expect(fs.existsSync(path.join(kb, 'evil.md'))).toBe(false);
    }
  });

  it('2. sync persists valid units in .registry.json and cleans .cache when another entry has an unsafe name', () => {
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    expect(runCli(['scaffold', 'good-unit', '--output', repoDir]).status).toBe(0);
    git(tmpDir, ['init', '-b', 'main', repoDir]);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    const kDir = path.join(tmpDir, 'shelf');
    const cfgPath = path.join(tmpDir, 'knowledge-shelf.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: '1.0',
        sources: [
          { name: 'good-unit', url: repoDir, path: 'good-unit' },
          { name: '../evil-unit', url: repoDir, path: 'good-unit' },
        ],
      }),
      'utf-8'
    );

    const syncRes = runCli(['sync', '--file', cfgPath, '--dir', kDir, '--no-global']);
    expect(syncRes.status).toBe(1);
    expect(syncRes.stderr).toContain('outside the knowledge directory');

    // good-unit must be installed AND recorded in .registry.json
    expect(fs.existsSync(path.join(kDir, 'good-unit', 'manifest.json'))).toBe(true);
    const reg = JSON.parse(fs.readFileSync(path.join(kDir, '.registry.json'), 'utf-8'));
    expect(reg.sources.some((s: { name: string }) => s.name === 'good-unit')).toBe(true);

    // .cache must not leak temporary clone directories
    const cacheEntries = fs.existsSync(path.join(kDir, '.cache'))
      ? fs.readdirSync(path.join(kDir, '.cache'))
      : [];
    expect(cacheEntries).toHaveLength(0);
  });

  it('3. export refuses to write archive inside the exported unit directory', () => {
    const kDir = path.join(tmpDir, 'shelf');
    const draft = path.join(tmpDir, 'draft');
    expect(runCli(['scaffold', 'demo-unit', '--output', draft]).status).toBe(0);
    expect(runCli(['install', path.join(draft, 'demo-unit'), '--dir', kDir, '--no-global']).status).toBe(0);

    const unitDir = path.join(kDir, 'demo-unit');
    const resCwdInside = runCli(['export', 'demo-unit', '--dir', kDir, '--no-global'], unitDir);
    expect(resCwdInside.status).toBe(1);
    expect(resCwdInside.stderr).toContain('cannot be inside the exported unit directory');
    expect(fs.existsSync(path.join(unitDir, 'demo-unit.zip'))).toBe(false);

    const resExplicitInside = runCli([
      'export',
      'demo-unit',
      '--output',
      path.join(unitDir, 'sub', 'out.zip'),
      '--dir',
      kDir,
      '--no-global',
    ]);
    expect(resExplicitInside.status).toBe(1);
    expect(resExplicitInside.stderr).toContain('cannot be inside the exported unit directory');
    expect(fs.existsSync(path.join(unitDir, 'sub', 'out.zip'))).toBe(false);
  });

  it('4. publish standalone .md with --path <dir> (no trailing slash) writes <dir>/<file>.md', () => {
    const bareRepo = path.join(tmpDir, 'remote.git');
    const seedDir = path.join(tmpDir, 'seed');
    git(tmpDir, ['init', '--bare', '-b', 'main', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seedDir]);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# Repo\n', 'utf-8');
    git(seedDir, ['add', '.']);
    git(seedDir, ['commit', '-m', 'init']);
    git(seedDir, ['push', '-u', 'origin', 'main']);

    const mdFile = path.join(tmpDir, 'deploy-guide.md');
    fs.writeFileSync(
      mdFile,
      '---\ntitle: Deploy Guide\ndescription: Deployment notes\ntags: [deploy]\n---\n# Deploy\nRun.\n',
      'utf-8'
    );

    const pubRes = runCli([
      'publish',
      mdFile,
      '--to',
      bareRepo,
      '--branch',
      'main',
      '--path',
      'guides',
      '--push',
    ]);
    expect(pubRes.status).toBe(0);

    const verifyDir = path.join(tmpDir, 'verify');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyDir]);
    expect(fs.existsSync(path.join(verifyDir, 'guides', 'deploy-guide.md'))).toBe(true);
    expect(fs.statSync(path.join(verifyDir, 'guides')).isDirectory()).toBe(true);

    // Explicit .md destination path still works as a rename
    const pubRenameRes = runCli([
      'publish',
      mdFile,
      '--to',
      bareRepo,
      '--branch',
      'main',
      '--path',
      'guides/custom-name.md',
      '--push',
    ]);
    expect(pubRenameRes.status).toBe(0);
    const verifyDir2 = path.join(tmpDir, 'verify2');
    git(tmpDir, ['clone', '-b', 'main', bareRepo, verifyDir2]);
    expect(fs.existsSync(path.join(verifyDir2, 'guides', 'custom-name.md'))).toBe(true);
  });

  it('5. validateManifestUnitDir rejects invalid types for tags, aliases, placeholders, inputs, and run args', () => {
    const unitDir = path.join(tmpDir, 'bad-types');
    expect(runCli(['scaffold', 'bad-types', '--output', tmpDir]).status).toBe(0);
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'scripts', 'echo.js'), 'console.log("ok");\n', 'utf-8');

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'bad-types',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Bad types test',
        tags: 'not-an-array',
        aliases: [123],
        placeholders: ['not-an-object'],
        workflows: { setup: { description: 'run' } },
      }),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        inputs: ['not-an-object'],
        steps: [{ action: 'run', script: 'scripts/echo.js', args: '--flag value' }],
      }),
      'utf-8'
    );

    const val = validateManifestUnitDir(unitDir);
    expect(val.errors.some((e) => e.includes('Field "tags" must be an array of strings'))).toBe(true);
    expect(val.errors.some((e) => e.includes('Field "aliases" must be an array of strings'))).toBe(true);
    expect(val.errors.some((e) => e.includes('Field "placeholders" must be an object'))).toBe(true);
    expect(val.errors.some((e) => e.includes('field "inputs" must be an object'))).toBe(true);
    expect(val.errors.some((e) => e.includes('(run): "args" must be an array of strings'))).toBe(true);
  });
});
