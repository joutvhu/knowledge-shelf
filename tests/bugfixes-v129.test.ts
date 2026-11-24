/**
 * Regression tests for bug fixes:
 * 1. Nested unit names (--name team/foo, team/bar in knowledge-shelf.json) validate and install on add, update, and sync.
 * 2. publish --path . onto repo root preserves repository infrastructure (.github/, .gitignore, LICENSE).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearIndexCache } from '../src/core.js';

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

describe('Nested unit names & publish root preservation regression tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v129-'));
    clearIndexCache();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. add --name team/foo, update, and sync validate and work with nested unit names', () => {
    // 1. Create a source git repository
    const repoDir = path.join(tmpDir, 'source-repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'manifest.json'),
      JSON.stringify({
        name: 'original-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Original unit description',
        doc: 'overview.md',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(repoDir, 'overview.md'), '# Original Unit\nContent.', 'utf-8');

    git(tmpDir, ['init', repoDir]);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'v1']);

    const kDir = path.join(tmpDir, 'kdir');
    runCli(['init', '--dir', kDir, '--no-global']);

    // 2. add with nested --name team/foo (without --no-verify) must succeed
    const resAdd = runCli(['add', repoDir, '--name', 'team/foo', '--dir', kDir, '--no-global']);
    expect(resAdd.status).toBe(0);
    expect(resAdd.stdout).toContain("Installed 'team/foo'");
    expect(fs.existsSync(path.join(kDir, 'team', 'foo', 'manifest.json'))).toBe(true);

    // 3. validate must also pass
    const resVal = runCli(['validate', '--dir', kDir, '--no-global']);
    expect(resVal.status).toBe(0);
    expect(resVal.stdout).toContain('0 error(s)');

    // 4. Update the source repo
    fs.appendFileSync(path.join(repoDir, 'overview.md'), '\nUpdated in v2.\n', 'utf-8');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'v2']);

    // 5. update team/foo must validate and succeed
    const resUp = runCli(['update', 'team/foo', '--dir', kDir, '--no-global']);
    expect(resUp.status).toBe(0);
    expect(resUp.stdout).toContain("Updating 'team/foo'");
    expect(resUp.stdout).toContain('1 updated, 0 failed');
    expect(fs.readFileSync(path.join(kDir, 'team', 'foo', 'overview.md'), 'utf-8')).toContain('Updated in v2.');

    // 6. sync with nested name in knowledge-shelf.json must succeed
    const syncCfg = path.join(tmpDir, 'knowledge-shelf.json');
    fs.writeFileSync(
      syncCfg,
      JSON.stringify({
        version: '1.0',
        sources: [{ name: 'team/bar', url: repoDir }],
      }),
      'utf-8'
    );
    const resSync = runCli(['sync', '--file', syncCfg, '--dir', kDir, '--no-global']);
    expect(resSync.status).toBe(0);
    expect(resSync.stdout).toContain("Synced 'team/bar'");
    expect(fs.existsSync(path.join(kDir, 'team', 'bar', 'manifest.json'))).toBe(true);
  });

  it('2. publish --path . onto repo root preserves repository infrastructure (.github/, .gitignore, LICENSE)', () => {
    const bareRepo = path.join(tmpDir, 'root-pub-bare.git');
    const seedRepo = path.join(tmpDir, 'root-pub-seed');
    git(tmpDir, ['init', '--bare', bareRepo]);
    git(tmpDir, ['clone', bareRepo, seedRepo]);
    git(seedRepo, ['config', 'user.email', 'test@example.com']);
    git(seedRepo, ['config', 'user.name', 'Test']);

    fs.mkdirSync(path.join(seedRepo, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(seedRepo, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf-8');
    fs.writeFileSync(path.join(seedRepo, '.gitignore'), 'node_modules/\n', 'utf-8');
    fs.writeFileSync(path.join(seedRepo, 'LICENSE'), 'Apache License 2.0\n', 'utf-8');
    fs.writeFileSync(path.join(seedRepo, 'shelf.json'), JSON.stringify({ units: [] }, null, 2), 'utf-8');

    git(seedRepo, ['add', '.']);
    git(seedRepo, ['commit', '-m', 'initial repo setup']);
    git(seedRepo, ['push', '-u', 'origin', 'HEAD']);

    // Create knowledge unit to publish
    const unitDir = path.join(tmpDir, 'my-unit');
    fs.mkdirSync(path.join(unitDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'my-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Root unit test',
        doc: 'overview.md',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'overview.md'), '# Root Unit\n', 'utf-8');

    // Publish to repo root using --path .
    const resPub = runCli(['publish', unitDir, '--to', bareRepo, '--path', '.', '--branch', 'main', '--push']);
    expect(resPub.status).toBe(0);
    expect(resPub.stdout).toContain("Published 'my-unit'");

    // Verify in a fresh clone
    const verifyRepo = path.join(tmpDir, 'root-pub-verify');
    git(tmpDir, ['clone', '--branch', 'main', bareRepo, verifyRepo]);

    // Repository infrastructure must be preserved!
    expect(fs.existsSync(path.join(verifyRepo, '.github', 'workflows', 'ci.yml'))).toBe(true);
    expect(fs.existsSync(path.join(verifyRepo, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(verifyRepo, 'LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(verifyRepo, 'shelf.json'))).toBe(true);

    // Unit files must be at root
    expect(fs.existsSync(path.join(verifyRepo, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(verifyRepo, 'overview.md'))).toBe(true);

    // shelf.json catalog should list my-unit
    const shelf = JSON.parse(fs.readFileSync(path.join(verifyRepo, 'shelf.json'), 'utf-8'));
    expect(shelf.units.some((u: { name: string }) => u.name === 'my-unit')).toBe(true);
  });
});
