/**
 * Git operations, filesystem staging/atomic replacement, and unit collection helpers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findManifestFolders, resolveInsideDir, stripBom } from '../core.js';
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
  const normalizedSparse = sparsePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
  const sparseResult = spawnSync('git', ['sparse-checkout', 'set', '--no-cone', '--', normalizedSparse], {
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

export const getCloneFullCommit = gitGetFullCommit;

export function isHexRef(s: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(s);
}

export function shaMatches(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  if (la.length >= 7 && lb.startsWith(la)) return true;
  if (lb.length >= 7 && la.startsWith(lb)) return true;
  return false;
}

/**
 * Resolves a tag or branch name on the remote to a full 40-character SHA.
 * Tags resolve to the peeled commit (^{}) when present.
 */
export function gitResolveRemoteRef(url: string, ref: string): string | null {
  assertGitAvailable();
  assertSafeGitArg(url, 'repository URL');
  assertSafeGitArg(ref, 'git ref');
  const res = spawnSync('git', ['ls-remote', '--tags', '--heads', '--', url], {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (res.status !== 0 || !res.stdout) return null;
  const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const cleanRef = ref.replace(/^refs\/(tags|heads)\//, '').replace(/\^{}$/, '');
  const targets = [
    `refs/tags/${cleanRef}^{}`,
    `refs/tags/${cleanRef}`,
    `refs/heads/${cleanRef}`,
  ];
  if (ref !== cleanRef) {
    targets.unshift(`${ref}^{}`);
    targets.unshift(ref);
  }

  for (const target of targets) {
    for (const line of lines) {
      const [sha, name] = line.split(/\s+/);
      if (name === target && /^[0-9a-f]{40}$/i.test(sha)) return sha;
    }
  }
  return null;
}

export const resolveRemoteRef = gitResolveRemoteRef;

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
  if (fs.existsSync(path.join(base, 'manifest.json'))) {
    return { units: [base], conflicts: [] };
  }
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
    const manifest = JSON.parse(stripBom(fs.readFileSync(manifestPath, 'utf-8'))) as Record<string, unknown>;
    const cleanName = path.basename(targetName.replace(/\\/g, '/').replace(/\/+$/, ''));
    if (manifest.name !== cleanName) {
      manifest.name = cleanName;
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

export function assertNoSymlinks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const lstat = fs.lstatSync(full);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Archive contains unsafe symbolic link: '${entry.name}'`);
    }
    if (lstat.isDirectory()) {
      assertNoSymlinks(full);
    }
  }
}

export function assertSafeArchivePaths(archivePath: string): void {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const listRes = spawnSync('tar', ['-ztf', archivePath], { stdio: 'pipe', encoding: 'utf-8' });
    if (listRes.status !== 0 || !listRes.stdout) {
      throw new Error(
        `Failed to inspect archive '${path.basename(archivePath)}': ${String(listRes.stderr || 'tar command failed')}`
      );
    }
    const lines = listRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const normalized = line.replace(/\\/g, '/');
      if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
        throw new Error(`Archive contains unsafe path: '${line}'`);
      }
    }
    const verboseRes = spawnSync('tar', ['-ztvf', archivePath], { stdio: 'pipe', encoding: 'utf-8' });
    if (verboseRes.status !== 0) {
      throw new Error(
        `Failed to inspect archive entries '${path.basename(archivePath)}': ${String(verboseRes.stderr || 'tar command failed')}`
      );
    }
    for (const vLine of (verboseRes.stdout || '').split(/\r?\n/)) {
      const trimmed = vLine.trim();
      if (!trimmed) continue;
      if (/^[lh][-rwxstST]{9}/.test(trimmed)) {
        throw new Error(`Archive contains symbolic or hard link entry, which is not permitted.`);
      }
    }
  } else if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const escSrc = archivePath.replace(/'/g, "''");
      const checkRes = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
            `try { ` +
            `  $z = [System.IO.Compression.ZipFile]::OpenRead('${escSrc}'); ` +
            `  foreach ($e in $z.Entries) { ` +
            `    $n = $e.FullName.Replace('\\', '/'); ` +
            `    if ($n.StartsWith('/') -or $n -match '^[A-Za-z]:' -or ($n.Split('/') -contains '..')) { ` +
            `      $z.Dispose(); exit 2 ` +
            `    } ` +
            `  }; ` +
            `  $z.Dispose() ` +
            `} catch { exit 3 }`,
        ],
        { stdio: 'pipe', encoding: 'utf-8' }
      );
      if (checkRes.status === 2) {
        throw new Error('Archive contains unsafe path(s) attempting path traversal.');
      }
      if (checkRes.status === 3 || checkRes.status !== 0) {
        throw new Error(
          `Failed to read zip archive '${path.basename(archivePath)}': ${String(checkRes.stderr || 'invalid archive')}`
        );
      }
    } else {
      const listRes = spawnSync('unzip', ['-Z1', archivePath], { stdio: 'pipe', encoding: 'utf-8' });
      if (listRes.status !== 0 || !listRes.stdout) {
        throw new Error(
          `Failed to inspect zip archive '${path.basename(archivePath)}': ${String(listRes.stderr || 'unzip command failed')}`
        );
      }
      const lines = listRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const normalized = line.replace(/\\/g, '/');
        if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
          throw new Error(`Archive contains unsafe path: '${line}'`);
        }
      }
    }
  } else {
    throw new Error(`Unsupported archive format for '${path.basename(archivePath)}'. Expected .zip, .tar.gz, or .tgz.`);
  }
}

export function extractArchiveSafely(archivePath: string, extractDir: string): void {
  assertSafeArchivePaths(archivePath);
  fs.mkdirSync(extractDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  let res: ReturnType<typeof spawnSync>;
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    res = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'pipe', encoding: 'utf-8' });
  } else if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const escSrc = archivePath.replace(/'/g, "''");
      const escDst = extractDir.replace(/'/g, "''");
      res = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${escSrc}', '${escDst}')`,
        ],
        { stdio: 'pipe', encoding: 'utf-8' }
      );
    } else {
      res = spawnSync('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'pipe', encoding: 'utf-8' });
    }
  } else {
    throw new Error('Unsupported archive format. Use .zip, .tar.gz, or .tgz.');
  }

  if (res.error || res.status !== 0) {
    throw new Error(String(res.stderr || (res.error ? res.error.message : 'extraction failed')));
  }

  assertNoSymlinks(extractDir);
}

