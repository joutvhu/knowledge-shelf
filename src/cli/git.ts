/**
 * Git operations, filesystem staging/atomic replacement, and unit collection helpers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findManifestFolders, resolveInsideDir } from '../core.js';
import { getCacheDir } from './registry.js';

let _gitChecked = false;

export function gitEnv(): NodeJS.ProcessEnv {
  return process.stdin.isTTY ? process.env : { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

export function assertSafeGitArg(value: string, label: string): void {
  if (!value || value.startsWith('-')) {
    throw new Error(`Invalid ${label}: '${value}'`);
  }
}

export function assertGitAvailable(): void {
  if (_gitChecked) return;
  const result = spawnSync('git', ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) {
    console.error('Error: git is not installed or not in PATH.');
    console.error('Install git from https://git-scm.com/ and try again.');
    process.exit(1);
  }
  _gitChecked = true;
}

export function gitClone(url: string, targetDir: string, branch?: string): void {
  assertGitAvailable();
  assertSafeGitArg(url, 'repository URL');
  const args = ['clone', '--depth', '1'];
  if (branch) {
    assertSafeGitArg(branch, 'branch');
    args.push('--branch', branch);
  }
  args.push('--', url, targetDir);
  const result = spawnSync('git', args, {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git clone failed');
  }
}

export function gitCloneAtRef(url: string, targetDir: string, ref: string): void {
  assertGitAvailable();
  assertSafeGitArg(url, 'repository URL');
  assertSafeGitArg(ref, 'git ref');
  // Fast path: shallow clone by branch or tag
  const branchClone = spawnSync('git', ['clone', '--depth', '1', '--branch', ref, '--', url, targetDir], {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (branchClone.status === 0) {
    return;
  }

  // Fallback for commit hashes: clone without checkout, then checkout specific commit
  removeDirSync(targetDir);
  const fullClone = spawnSync('git', ['clone', '--no-checkout', '--', url, targetDir], {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (fullClone.status !== 0) {
    throw new Error(fullClone.stderr || 'git clone failed');
  }

  const checkout = spawnSync('git', ['checkout', ref, '--'], {
    cwd: targetDir,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (checkout.status !== 0) {
    throw new Error(checkout.stderr || `git checkout '${ref}' failed`);
  }
}

export function gitCloneSparse(url: string, targetDir: string, sparsePath: string, branch?: string): void {
  assertGitAvailable();
  assertSafeGitArg(url, 'repository URL');
  assertSafeGitArg(sparsePath, 'sparse path');
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--sparse'];
  if (branch) {
    assertSafeGitArg(branch, 'branch');
    args.push('--branch', branch);
  }
  args.push('--', url, targetDir);

  const cloneResult = spawnSync('git', args, { stdio: 'pipe', encoding: 'utf-8', env: gitEnv() });
  if (cloneResult.status !== 0) {
    removeDirSync(targetDir);
    gitClone(url, targetDir, branch);
    return;
  }
  const sparseResult = spawnSync('git', ['sparse-checkout', 'set', '--', sparsePath], {
    cwd: targetDir,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (sparseResult.status !== 0) {
    removeDirSync(targetDir);
    gitClone(url, targetDir, branch);
  }
}

export function gitGetCommit(repoDir: string): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  return (result.stdout || '').trim();
}

export function gitGetFullCommit(repoDir: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  return (result.stdout || '').trim();
}

export function gitGetBranch(repoDir: string): string | undefined {
  const result = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.status !== 0) return undefined;
  const branch = (result.stdout || '').trim();
  return branch || undefined;
}

/**
 * Checks the remote commit SHA for a ref (defaults to HEAD) without cloning.
 * Returns null if ls-remote fails or ref is not found.
 */
export function gitLsRemote(url: string, ref?: string): string | null {
  assertGitAvailable();
  assertSafeGitArg(url, 'repository URL');
  const targetRef = ref || 'HEAD';
  assertSafeGitArg(targetRef, 'git ref');
  const res = spawnSync('git', ['ls-remote', '--', url, targetRef], {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (res.status !== 0 || !res.stdout) return null;
  const firstLine = res.stdout.trim().split(/\r?\n/)[0];
  if (!firstLine) return null;
  const sha = firstLine.split(/\s+/)[0];
  return sha || null;
}

export function deriveNameFromUrl(url: string): string {
  const normalized = url.replace(/[\\/]+$/, '');
  const match = normalized.match(/[/:\\]([^/:\\]+?)(?:\.git)?$/);
  const safe = (match ? match[1] : '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return safe || 'unknown';
}

export function collectUnitFolders(baseDir: string): { units: string[]; conflicts: string[] } {
  const base = path.resolve(baseDir);
  const all = findManifestFolders(baseDir)
    .map((f) => path.resolve(f))
    .filter((f) => f !== base);
  const topLevel = all.filter((f) => !all.some((other) => other !== f && f.startsWith(other + path.sep)));

  const byName = new Map<string, string[]>();
  for (const folder of topLevel) {
    const name = path.basename(folder);
    byName.set(name, [...(byName.get(name) || []), folder]);
  }
  const conflicts = [...byName.entries()]
    .filter(([, folders]) => folders.length > 1)
    .map(([name, folders]) => `'${name}' (${folders.map((f) => path.relative(base, f) || f).join(', ')})`);

  return { units: topLevel, conflicts };
}

export function getCloneTarget(knowledgeDir: string, name: string): string {
  const target = resolveInsideDir(getCacheDir(knowledgeDir), name, true);
  if (!target) {
    console.error(`Error: Refusing to use unsafe cache directory name '${name}'.`);
    process.exit(1);
  }
  return target;
}

export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function replaceDirSync(knowledgeDir: string, srcDir: string, destDir: string): void {
  const cacheDir = getCacheDir(knowledgeDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const staged = path.join(cacheDir, `.stage-${stamp}`);
  const backup = path.join(cacheDir, `.backup-${stamp}`);

  try {
    copyDirSync(srcDir, staged);
  } catch (e) {
    removeDirSync(staged);
    throw e;
  }

  const hadExisting = fs.existsSync(destDir);
  try {
    if (hadExisting) fs.renameSync(destDir, backup);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.renameSync(staged, destDir);
  } catch (e) {
    if (hadExisting && !fs.existsSync(destDir) && fs.existsSync(backup)) {
      fs.renameSync(backup, destDir);
    }
    removeDirSync(staged);
    throw e;
  }
  removeDirSync(backup);
}

export function syncManifestName(unitDir: string, targetName: string): void {
  const manifestPath = path.join(unitDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    if (manifest.name !== targetName) {
      manifest.name = targetName;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    }
  } catch {
    /* ignore */
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
