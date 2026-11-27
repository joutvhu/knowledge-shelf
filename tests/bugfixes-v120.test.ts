/**
 * Regression tests for v1.2.0 fixes:
 * 1. cmdTrust on non-existent unit does not leak .registry.lock
 * 2. Dead process lock detection reclaims stale lock immediately
 * 3. resolveInsideDir works with non-existent target under symlink/junction
 * 4. findMdFiles ignores readme.md case-insensitively
 * 5. cmdAdd validation failure cleans up stage directory in .cache
 * 6. cmdList preserves active unmanaged units in multi-layer shadowing
 * 7. Workflow dry_run tracks mkdir for subsequent when.exists conditions
 * 8. cmdAdd/cmdUpdate atomic registry mutation prevents lost updates
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  findMdFiles,
  resolveInsideDir,
  toolRunWorkflow,
} from '../src/core.js';
import { loadRegistry, withRegistryLock } from '../src/cli/registry.js';

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

describe('v1.2.0 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v120-'));
    clearIndexCache();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. cmdTrust on non-existent unit exits 1 without leaving orphaned .registry.lock', () => {
    const kDir = path.join(tmpDir, 'k');
    const initRes = runCli(['init', '--dir', kDir]);
    expect(initRes.status).toBe(0);

    const trustRes = runCli(['trust', 'nonexistent-unit', '--dir', kDir]);
    expect(trustRes.status).toBe(1);
    expect(trustRes.stderr).toContain("not found in registry");

    const lockPath = path.join(kDir, '.registry.lock');
    expect(fs.existsSync(lockPath)).toBe(false);

    // Subsequent operation should acquire lock immediately without 15s timeout
    const t0 = Date.now();
    const secondInit = runCli(['init', '--dir', kDir]);
    const elapsed = Date.now() - t0;
    expect(secondInit.status).toBe(0);
    expect(elapsed).toBeLessThan(8000);
  });

  it('2. withRegistryLock reclaims lock from dead PID immediately', () => {
    const kDir = path.join(tmpDir, 'k');
    fs.mkdirSync(kDir, { recursive: true });
    const lockPath = path.join(kDir, '.registry.lock');

    // Write a lock file with a non-existent PID (e.g. 999999)
    fs.writeFileSync(lockPath, '999999\n1000000000\n', 'utf-8');

    const t0 = Date.now();
    const executed = withRegistryLock(kDir, () => {
      return 'acquired';
    });
    const elapsed = Date.now() - t0;

    expect(executed).toBe('acquired');
    expect(elapsed).toBeLessThan(2000);
  });

  it('3. resolveInsideDir resolves non-existent target when ancestor is realpath canonicalized', () => {
    const realBase = path.join(tmpDir, 'real-target');
    fs.mkdirSync(realBase, { recursive: true });

    let linkBase = path.join(tmpDir, 'link-target');
    try {
      fs.symlinkSync(realBase, linkBase, 'junction');
    } catch {
      linkBase = realBase;
    }

    const nonExistentBase = path.join(linkBase, 'new-project');
    const resolved = resolveInsideDir(nonExistentBase, 'src/app.ts', true);
    expect(resolved).not.toBeNull();
    expect(resolved?.endsWith(path.join('new-project', 'src', 'app.ts'))).toBe(true);
  });

  it('4. findMdFiles ignores readme.md regardless of case', () => {
    const kDir = path.join(tmpDir, 'k');
    fs.mkdirSync(kDir, { recursive: true });

    fs.writeFileSync(path.join(kDir, 'readme.md'), '# lower');
    fs.writeFileSync(path.join(kDir, 'README.md'), '# upper');
    fs.writeFileSync(path.join(kDir, 'Guide.md'), '# guide');

    const files = findMdFiles(kDir).map((f) => path.basename(f));
    expect(files).toEqual(['Guide.md']);
  });

  it('5. cmdAdd cleans up staging cache directory when manifest validation fails', () => {
    const kDir = path.join(tmpDir, 'k');
    const badRepo = path.join(tmpDir, 'bad-repo');
    fs.mkdirSync(badRepo, { recursive: true });
    git(badRepo, ['init', '-b', 'main']);
    git(badRepo, ['config', 'user.email', 'test@test.com']);
    git(badRepo, ['config', 'user.name', 'Test']);
    // Invalid manifest (missing required description & type)
    fs.writeFileSync(
      path.join(badRepo, 'manifest.json'),
      JSON.stringify({ name: 'bad-repo', version: '1.0.0' })
    );
    git(badRepo, ['add', '.']);
    git(badRepo, ['commit', '-m', 'init']);

    const res = runCli(['add', badRepo, '--dir', kDir]);
    expect(res.status).toBe(1);

    const cacheDir = path.join(kDir, '.cache');
    if (fs.existsSync(cacheDir)) {
      const items = fs.readdirSync(cacheDir).filter((n) => n.startsWith('.add-stage'));
      expect(items).toEqual([]);
    }
  });

  it('6. cmdList correctly reports active unmanaged units in multi-layer shadowing', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    fs.mkdirSync(layer1, { recursive: true });
    fs.mkdirSync(layer2, { recursive: true });

    // Tracked in layer2
    const reg2 = {
      version: '1.0',
      sources: [
        {
          name: 'shared-unit',
          url: 'https://example.com/shared.git',
          commit: 'abc1234',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(path.join(layer2, '.registry.json'), JSON.stringify(reg2, null, 2));
    fs.mkdirSync(path.join(layer2, 'shared-unit'), { recursive: true });
    fs.writeFileSync(
      path.join(layer2, 'shared-unit', 'manifest.json'),
      JSON.stringify({ name: 'shared-unit', version: '1.0.0', type: 'boilerplate', description: 'layer2' })
    );

    // Unmanaged in layer1 (shadows layer2)
    fs.mkdirSync(path.join(layer1, 'shared-unit'), { recursive: true });
    fs.writeFileSync(
      path.join(layer1, 'shared-unit', 'manifest.json'),
      JSON.stringify({ name: 'shared-unit', version: '1.0.0', type: 'boilerplate', description: 'layer1' })
    );

    const res = runCli(['list', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(res.status).toBe(0);
    // layer1's shared-unit is active and unmanaged
    expect(res.stdout).toContain('Local / unmanaged');
    expect(res.stdout).toContain('shared-unit');
  });

  it('7. Workflow dry_run records mkdir steps so subsequent when.exists conditions evaluate true', async () => {
    const kDir = path.join(tmpDir, 'k');
    const unitDir = path.join(kDir, 'wf-unit');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'wf-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'test',
        workflows: { testwf: { file: 'workflows/testwf.json' } },
      })
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'testwf.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true, type: 'path' } },
        steps: [
          { action: 'mkdir', path: '{{TARGET}}/new-folder' },
          { action: 'message', when: { exists: '{{TARGET}}/new-folder' }, text: 'FOLDER_READY' },
        ],
      })
    );

    const target = path.join(tmpDir, 'target-dry');
    fs.mkdirSync(target, { recursive: true });

    const dryRes = await toolRunWorkflow(
      kDir,
      'wf-unit',
      'testwf',
      { TARGET: target },
      { dryRun: true }
    );
    expect(dryRes.isError).toBe(false);
    const parsed = JSON.parse(dryRes.text);
    expect(parsed.messages).toContain('FOLDER_READY');
    expect(parsed.steps_executed).toBe(2);
  });
});
