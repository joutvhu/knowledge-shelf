/**
 * Knowledge Shelf CLI
 *
 * Subcommands:
 *   add <url> [--path <subfolder>] [--name <alias>] [--all]   Pull knowledge from a git repo
 *   install <path> [--name <alias>] [--force] [--all]         Validate & install knowledge from a local path
 *   info <name>                                               Show detailed unit info
 *   search <keywords>                                         Search installed knowledge
 *   list                                                      List installed knowledge sources
 *   validate [name|path]                                      Validate manifest-based units or standalone docs
 *   update [name]                                             Update all or specific knowledge
 *   pin <name> [tag|commit]                                   Lock knowledge source version
 *   unpin <name>                                              Unlock knowledge source
 *   export <name> [--output <path>] [--format zip|tar]        Package knowledge unit
 *   remove <name>                                             Remove installed knowledge
 *   init                                                      Initialize a knowledge directory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findManifestFolders,
  findMdFiles,
  getPackageVersion,
  parseFrontmatter,
  resolveInsideDir,
  resolveKnowledgeDir,
  scanDocuments,
  searchScore,
  walkDir,
} from './core.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistryEntry {
  name: string;
  url: string;
  path?: string; // subfolder within repo
  commit: string;
  pin?: string; // pinned tag/commit — if set, update skips this entry
  installedAt: string;
  updatedAt: string;
}

interface Registry {
  version: '1.0';
  sources: RegistryEntry[];
}

// ---------------------------------------------------------------------------
// Configuration & Path Validation
// ---------------------------------------------------------------------------

function getRegistryPath(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.registry.json');
}

function getCacheDir(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.cache');
}

function resolveSafeUnitDir(knowledgeDir: string, name: string): string {
  if (!name || name === '.' || name === '..') {
    console.error(`Error: Invalid knowledge unit name '${name}'.`);
    process.exit(1);
  }
  const resolved = resolveInsideDir(knowledgeDir, name, true);
  if (!resolved) {
    console.error(`Error: Access denied. '${name}' is outside the knowledge directory.`);
    process.exit(1);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Registry Management
// ---------------------------------------------------------------------------

function loadRegistry(knowledgeDir: string): Registry {
  const registryPath = getRegistryPath(knowledgeDir);
  if (!fs.existsSync(registryPath)) {
    return { version: '1.0', sources: [] };
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(content) as Registry;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)) {
      throw new Error('expected an object with a "sources" array');
    }
    return parsed;
  } catch (e) {
    // Never fall back to an empty registry: the next save would silently erase every entry.
    console.error(`Error: Cannot read registry ${registryPath}: ${e instanceof Error ? e.message : e}`);
    console.error('Fix or delete the file manually, then retry.');
    process.exit(1);
  }
}

function saveRegistry(knowledgeDir: string, registry: Registry): void {
  const registryPath = getRegistryPath(knowledgeDir);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Git Helpers
// ---------------------------------------------------------------------------

function gitEnv(): NodeJS.ProcessEnv {
  return process.stdin.isTTY
    ? process.env
    : { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function assertSafeGitArg(value: string, label: string): void {
  if (!value || value.startsWith('-')) {
    throw new Error(`Invalid ${label}: '${value}'`);
  }
}

function gitClone(url: string, targetDir: string): void {
  assertGitAvailable();
  assertSafeGitArg(url, 'repository URL');
  const result = spawnSync('git', ['clone', '--depth', '1', '--', url, targetDir], {
    stdio: 'pipe',
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git clone failed');
  }
}

function gitCloneAtRef(url: string, targetDir: string, ref: string): void {
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

function gitGetCommit(repoDir: string): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  return (result.stdout || '').trim();
}

function gitCloneSparse(url: string, targetDir: string, sparsePath: string): void {
  assertGitAvailable();
  assertSafeGitArg(url, 'repository URL');
  assertSafeGitArg(sparsePath, 'sparse path');
  const cloneResult = spawnSync(
    'git',
    ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--', url, targetDir],
    { stdio: 'pipe', encoding: 'utf-8', env: gitEnv() }
  );
  if (cloneResult.status !== 0) {
    removeDirSync(targetDir);
    gitClone(url, targetDir);
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
    gitClone(url, targetDir);
  }
}

let _gitChecked = false;

function assertGitAvailable(): void {
  if (_gitChecked) return;
  const result = spawnSync('git', ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) {
    console.error('Error: git is not installed or not in PATH.');
    console.error('Install git from https://git-scm.com/ and try again.');
    process.exit(1);
  }
  _gitChecked = true;
}

/**
 * Derives a filesystem-safe repository name from a git URL. The result is used as a directory
 * name under `.cache/` that is deleted and re-created, so it must never be empty, `.`/`..`, or
 * contain path separators (e.g. `https://host/..` must not resolve to the knowledge directory).
 */
function deriveNameFromUrl(url: string): string {
  const normalized = url.replace(/[\\/]+$/, '');
  const match = normalized.match(/[/:\\]([^/:\\]+?)(?:\.git)?$/);
  const safe = (match ? match[1] : '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return safe || 'unknown';
}

/**
 * Finds installable units under `baseDir` for `--all` mode. Units nested inside another unit
 * are part of that unit's files and are not installed separately. Units are installed under
 * their folder name, so two units sharing a name are reported as conflicts instead of one
 * being silently skipped.
 */
function collectUnitFolders(baseDir: string): { units: string[]; conflicts: string[] } {
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

/** Returns a clone directory strictly inside `.cache/`, or exits if the name would escape it. */
function getCloneTarget(knowledgeDir: string, name: string): string {
  const target = resolveInsideDir(getCacheDir(knowledgeDir), name, true);
  if (!target) {
    console.error(`Error: Refusing to use unsafe cache directory name '${name}'.`);
    process.exit(1);
  }
  return target;
}

// ---------------------------------------------------------------------------
// File System Helpers
// ---------------------------------------------------------------------------

function copyDirSync(src: string, dest: string): void {
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

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Replaces `destDir` with a copy of `srcDir` without ever leaving it half-written:
 * the copy is staged under `.cache/`, then swapped in with renames. If anything fails,
 * the previous contents of `destDir` are restored.
 */
function replaceDirSync(knowledgeDir: string, srcDir: string, destDir: string): void {
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(knowledgeDir: string): void {
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(getCacheDir(knowledgeDir), { recursive: true });

  const registry = loadRegistry(knowledgeDir);
  saveRegistry(knowledgeDir, registry);

  const cacheGitignore = path.join(knowledgeDir, '.cache', '.gitignore');
  fs.writeFileSync(cacheGitignore, '*\n', 'utf-8');

  const rootGitignore = path.join(knowledgeDir, '.gitignore');
  if (!fs.existsSync(rootGitignore)) {
    fs.writeFileSync(rootGitignore, ['# Knowledge Shelf', '.cache/', ''].join('\n'), 'utf-8');
  }

  console.log(`✓ Initialized knowledge directory: ${knowledgeDir}`);
}

function cmdAdd(knowledgeDir: string, args: string[]): void {
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(getCacheDir(knowledgeDir), { recursive: true });

  let url = '';
  let subPath = '';
  let customName = '';
  let addAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --path requires a subfolder argument.');
        process.exit(1);
      }
      subPath = args[++i];
    } else if (args[i] === '--name') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --name requires an alias argument.');
        process.exit(1);
      }
      customName = args[++i];
    } else if (args[i] === '--all') {
      addAll = true;
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'add'.`);
      process.exit(1);
    } else if (!url) {
      url = args[i];
    } else {
      console.error(`Error: Unexpected argument '${args[i]}'.`);
      process.exit(1);
    }
  }

  if (!url) {
    console.error(
      'Error: URL is required.\nUsage: knowledge-shelf add <url> [--path <subfolder>] [--name <alias>] [--all]'
    );
    process.exit(1);
  }

  const repoName = deriveNameFromUrl(url);
  const cacheDir = getCacheDir(knowledgeDir);
  const cloneTarget = getCloneTarget(knowledgeDir, repoName);

  console.log(`Cloning ${url}...`);
  removeDirSync(cloneTarget);

  try {
    if (subPath && !addAll) {
      gitCloneSparse(url, cloneTarget, subPath);
    } else {
      gitClone(url, cloneTarget);
    }
  } catch (e) {
    console.error(`Error: Failed to clone repository.\n${e}`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  const commit = gitGetCommit(cloneTarget);

  if (addAll) {
    const baseDir = subPath ? resolveInsideDir(cloneTarget, subPath, true) : cloneTarget;
    if (!baseDir || !fs.existsSync(baseDir)) {
      console.error(`Error: Path '${subPath}' not found in repository.`);
      removeDirSync(cloneTarget);
      process.exit(1);
    }

    const { units: manifestFolders, conflicts } = collectUnitFolders(baseDir);
    if (conflicts.length > 0) {
      console.error(`Error: Multiple units share the same folder name: ${conflicts.join('; ')}.`);
      console.error('Use --path to install each one individually with --name.');
      removeDirSync(cloneTarget);
      process.exit(1);
    }
    const registry = loadRegistry(knowledgeDir);
    let installed = 0;
    let skipped = 0;

    for (const sourceDir of manifestFolders) {
      const unitName = path.basename(sourceDir);
      if (registry.sources.find((s) => s.name === unitName)) {
        console.log(`  Skipping '${unitName}' (already installed)`);
        skipped++;
        continue;
      }

      const destDir = resolveSafeUnitDir(knowledgeDir, unitName);
      if (fs.existsSync(destDir)) {
        console.log(`  Skipping '${unitName}' (directory exists)`);
        skipped++;
        continue;
      }

      copyDirSync(sourceDir, destDir);
      const sourcePath = path.relative(cloneTarget, sourceDir).replace(/\\/g, '/');
      const now = new Date().toISOString();
      registry.sources.push({
        name: unitName,
        url,
        path: sourcePath,
        commit,
        installedAt: now,
        updatedAt: now,
      });
      console.log(`  ✓ Installed '${unitName}'`);
      installed++;
    }

    saveRegistry(knowledgeDir, registry);
    removeDirSync(cloneTarget);
    console.log(`\nDone. ${installed} installed, ${skipped} skipped.`);
    return;
  }

  // Single unit mode
  const name = customName || (subPath ? path.basename(subPath) : repoName);
  const destDir = resolveSafeUnitDir(knowledgeDir, name);

  const registry = loadRegistry(knowledgeDir);
  const existing = registry.sources.find((s) => s.name === name);
  if (existing) {
    console.error(`Error: '${name}' is already installed.  Use 'update ${name}' to refresh.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  const sourceDir = subPath ? resolveInsideDir(cloneTarget, subPath, true) : cloneTarget;
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    console.error(`Error: Path '${subPath}' not found in repository.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  if (fs.existsSync(destDir)) {
    console.error(`Error: Directory '${name}' already exists in knowledge folder.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  console.log(`Installing to ${name}/...`);
  copyDirSync(sourceDir, destDir);

  const now = new Date().toISOString();
  registry.sources.push({
    name,
    url,
    path: subPath || undefined,
    commit,
    installedAt: now,
    updatedAt: now,
  });
  saveRegistry(knowledgeDir, registry);

  removeDirSync(cloneTarget);
  console.log(`✓ Installed '${name}' (${commit})`);
}

function cmdList(knowledgeDir: string): void {
  const registry = loadRegistry(knowledgeDir);

  if (registry.sources.length === 0) {
    console.log('No knowledge sources installed.');
    console.log(`Knowledge directory: ${knowledgeDir}`);
    return;
  }

  console.log(`Knowledge directory: ${knowledgeDir}\n`);
  console.log('Installed sources:\n');

  for (const source of registry.sources) {
    const pathInfo = source.path ? ` (path: ${source.path})` : '';
    const pinInfo = source.pin ? ` [pinned: ${source.pin}]` : '';
    console.log(`  ${source.name}${pinInfo}`);
    console.log(`    URL:       ${source.url}${pathInfo}`);
    console.log(`    Commit:    ${source.commit}`);
    console.log(`    Updated:   ${source.updatedAt}`);
    console.log('');
  }

  console.log(`Total: ${registry.sources.length} source(s)`);
}

function cmdUpdate(knowledgeDir: string, args: string[]): void {
  const registry = loadRegistry(knowledgeDir);
  const targetName = args[0];

  if (registry.sources.length === 0) {
    console.log('No knowledge sources installed.');
    return;
  }

  const toUpdate = targetName ? registry.sources.filter((s) => s.name === targetName) : registry.sources;

  if (targetName && toUpdate.length === 0) {
    console.error(`Error: '${targetName}' not found in registry.`);
    process.exit(1);
  }

  const cacheDir = getCacheDir(knowledgeDir);
  fs.mkdirSync(cacheDir, { recursive: true });

  let updated = 0;
  let failed = 0;

  for (const source of toUpdate) {
    if (source.pin) {
      console.log(`  Skipping '${source.name}' (pinned to ${source.pin})`);
      continue;
    }

    if (source.url.startsWith('local:')) {
      const localPath = source.url.slice('local:'.length);
      console.log(`Updating '${source.name}' from local path ${localPath}...`);
      if (!fs.existsSync(localPath)) {
        console.log(`  Skipping '${source.name}' (local source path no longer exists)`);
        continue;
      }
      try {
        const stat = fs.statSync(localPath);
        if (stat.isFile()) {
          const destFile = resolveSafeUnitDir(knowledgeDir, source.name);
          fs.mkdirSync(path.dirname(destFile), { recursive: true });
          fs.copyFileSync(localPath, destFile);
        } else {
          const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
          replaceDirSync(knowledgeDir, localPath, destDir);
          if (fs.existsSync(path.join(destDir, 'manifest.json'))) {
            syncManifestName(destDir, source.name);
          }
        }
        source.updatedAt = new Date().toISOString();
        updated++;
        console.log(`  ✓ Updated from local path`);
      } catch (e) {
        console.error(`  Error updating '${source.name}': ${e}`);
        failed++;
      }
      continue;
    }

    console.log(`Updating '${source.name}'...`);

    const repoName = deriveNameFromUrl(source.url);
    const cloneTarget = getCloneTarget(knowledgeDir, repoName);

    try {
      removeDirSync(cloneTarget);
      if (source.path) {
        gitCloneSparse(source.url, cloneTarget, source.path);
      } else {
        gitClone(source.url, cloneTarget);
      }

      const newCommit = gitGetCommit(cloneTarget);

      if (newCommit === source.commit) {
        console.log(`  Already up to date (${newCommit})`);
        removeDirSync(cloneTarget);
        continue;
      }

      const sourceDir = source.path ? resolveInsideDir(cloneTarget, source.path, true) : cloneTarget;
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        console.error(`  Error: Path '${source.path}' no longer exists in repo.`);
        failed++;
        removeDirSync(cloneTarget);
        continue;
      }

      const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
      replaceDirSync(knowledgeDir, sourceDir, destDir);

      source.commit = newCommit;
      source.updatedAt = new Date().toISOString();
      updated++;

      console.log(`  ✓ Updated to ${newCommit}`);
      removeDirSync(cloneTarget);
    } catch (e) {
      console.error(`  Error updating '${source.name}': ${e}`);
      failed++;
      removeDirSync(cloneTarget);
    }
  }

  saveRegistry(knowledgeDir, registry);
  console.log(`\nDone. ${updated} updated, ${failed} failed.`);
}

function cmdRemove(knowledgeDir: string, args: string[]): void {
  const name = args[0];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf remove <name>');
    process.exit(1);
  }

  const destDir = resolveSafeUnitDir(knowledgeDir, name);
  const registry = loadRegistry(knowledgeDir);
  const idx = registry.sources.findIndex((s) => s.name === name);

  if (idx === -1) {
    // Never allow deleting internal files/folders (.registry.json, .cache, .git, ...) by name.
    const topSegment = path.relative(knowledgeDir, destDir).split(path.sep)[0];
    if (topSegment.startsWith('.')) {
      console.error(`Error: '${name}' is a reserved path and cannot be removed.`);
      process.exit(1);
    }
    if (fs.existsSync(destDir)) {
      removeDirSync(destDir);
      console.log(`✓ Removed directory '${name}' (was not in registry)`);
    } else {
      console.error(`Error: '${name}' not found.`);
      process.exit(1);
    }
    return;
  }

  removeDirSync(destDir);
  registry.sources.splice(idx, 1);
  saveRegistry(knowledgeDir, registry);

  console.log(`✓ Removed '${name}'`);
}

function cmdInfo(knowledgeDir: string, args: string[]): void {
  const name = args[0];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf info <name>');
    process.exit(1);
  }

  let unitDir = resolveSafeUnitDir(knowledgeDir, name);
  if (!fs.existsSync(unitDir) && !name.endsWith('.md')) {
    const mdCandidate = resolveSafeUnitDir(knowledgeDir, `${name}.md`);
    if (fs.existsSync(mdCandidate)) {
      unitDir = mdCandidate;
    }
  }

  if (!fs.existsSync(unitDir)) {
    console.error(`Error: '${name}' not found in ${knowledgeDir}`);
    process.exit(1);
  }

  const stat = fs.statSync(unitDir);
  if (stat.isFile()) {
    const displayName = path.relative(knowledgeDir, unitDir).replace(/\\/g, '/');
    const content = fs.readFileSync(unitDir, 'utf-8');
    const { metadata } = parseFrontmatter(content);
    const registry = loadRegistry(knowledgeDir);
    const source = registry.sources.find((s) => s.name === displayName || s.name === name);

    console.log(`\n  ${displayName}`);
    console.log(`  ${'─'.repeat(displayName.length + 4)}`);
    console.log('  Type:         standalone (.md)');
    if (metadata.description) {
      console.log(`  Description:  ${metadata.description}`);
    }
    if (Array.isArray(metadata.tags) && metadata.tags.length > 0) {
      console.log(`  Tags:         ${metadata.tags.join(', ')}`);
    }
    if (Array.isArray(metadata.aliases) && metadata.aliases.length > 0) {
      console.log(`  Aliases:      ${metadata.aliases.join(', ')}`);
    }
    console.log('  Files:        1');
    console.log(`  Size:         ${formatSize(stat.size)}`);
    console.log(`  Path:         ${unitDir}`);
    if (source) {
      console.log(`  Source:       ${source.url}`);
      console.log(`  Installed:    ${source.installedAt}`);
      console.log(`  Updated:      ${source.updatedAt}`);
    } else {
      console.log('  Source:       local (not from registry)');
    }
    console.log('');
    return;
  }

  const manifestPath = path.join(unitDir, 'manifest.json');
  let manifest: Record<string, unknown> | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = null;
    }
  }

  let fileCount = 0;
  let totalSize = 0;
  walkDir(unitDir, (filePath) => {
    fileCount++;
    try {
      totalSize += fs.statSync(filePath).size;
    } catch {
      /* skip */
    }
  });

  const registry = loadRegistry(knowledgeDir);
  const source = registry.sources.find((s) => s.name === name);

  console.log(`\n  ${name}`);
  console.log(`  ${'─'.repeat(name.length + 4)}`);

  if (manifest) {
    console.log(`  Type:         ${manifest.type || 'unknown'}`);
    console.log(`  Version:      ${manifest.version || '—'}`);
    console.log(`  Description:  ${manifest.description || '—'}`);
    if (manifest.tags && Array.isArray(manifest.tags)) {
      console.log(`  Tags:         ${(manifest.tags as string[]).join(', ')}`);
    }
    if (manifest.doc) {
      console.log(`  Doc file:     ${manifest.doc}`);
    }

    const modules = manifest.modules as Record<string, unknown> | undefined;
    if (modules && Object.keys(modules).length > 0) {
      console.log(`  Modules:      ${Object.keys(modules).join(', ')}`);
    }

    const workflows = manifest.workflows as Record<string, unknown> | undefined;
    if (workflows && Object.keys(workflows).length > 0) {
      console.log(`  Workflows:    ${Object.keys(workflows).join(', ')}`);
    }

    const scripts = manifest.scripts as Record<string, unknown> | undefined;
    if (scripts && Object.keys(scripts).length > 0) {
      console.log(`  Scripts:      ${Object.keys(scripts).join(', ')}`);
    }

    const references = manifest.references as Record<string, unknown> | undefined;
    if (references && Object.keys(references).length > 0) {
      console.log(`  References:   ${Object.keys(references).join(', ')}`);
    }
  } else {
    console.log('  Type:         standalone (no manifest.json)');
  }

  console.log(`  Files:        ${fileCount}`);
  console.log(`  Size:         ${formatSize(totalSize)}`);
  console.log(`  Path:         ${unitDir}`);

  if (source) {
    console.log(`  Source:       ${source.url}${source.path ? ` (path: ${source.path})` : ''}`);
    console.log(`  Commit:       ${source.commit}`);
    if (source.pin) {
      console.log(`  Pinned:       ${source.pin}`);
    }
    console.log(`  Installed:    ${source.installedAt}`);
    console.log(`  Updated:      ${source.updatedAt}`);
  } else {
    console.log('  Source:       local (not from registry)');
  }

  console.log('');
}

interface ValidationResult {
  errors: string[];
  warnings: string[];
}

function validateManifestUnitDir(unitDir: string, expectedUnitName?: string): ValidationResult {
  const unitName = expectedUnitName || path.basename(unitDir);
  const manifestPath = path.join(unitDir, 'manifest.json');
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(manifestPath)) {
    errors.push('manifest.json not found');
    return { errors, warnings };
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    errors.push(`manifest.json is invalid JSON: ${e}`);
    return { errors, warnings };
  }

  if (!manifest.name) errors.push('Missing required field: name');
  if (!manifest.version) errors.push('Missing required field: version');
  if (!manifest.type) errors.push('Missing required field: type');
  if (!manifest.description) errors.push('Missing required field: description');

  if (manifest.name && manifest.name !== unitName) {
    errors.push(`manifest.name "${manifest.name}" does not match folder name "${unitName}"`);
  }

  if (manifest.doc && typeof manifest.doc === 'string') {
    const docPath = resolveInsideDir(unitDir, manifest.doc, true);
    if (!docPath) {
      errors.push(`doc path escapes unit folder: ${manifest.doc}`);
    } else if (!fs.existsSync(docPath)) {
      errors.push(`doc file not found: ${manifest.doc}`);
    }
  }

  const modules = manifest.modules as
    | Record<string, { files?: string[]; guide?: string; dependencies?: string[] }>
    | undefined;
  if (modules) {
    const moduleNames = Object.keys(modules);
    for (const [modName, mod] of Object.entries(modules)) {
      if (mod.files) {
        for (const file of mod.files) {
          const filePath = resolveInsideDir(unitDir, file, true);
          if (!filePath) {
            errors.push(`modules.${modName}.files: path escapes unit folder: ${file}`);
          } else if (!fs.existsSync(filePath)) {
            errors.push(`modules.${modName}.files: file not found: ${file}`);
          }
        }
      }
      if (mod.guide) {
        const guidePath = resolveInsideDir(unitDir, mod.guide, true);
        if (!guidePath) {
          errors.push(`modules.${modName}.guide: path escapes unit folder: ${mod.guide}`);
        } else if (!fs.existsSync(guidePath)) {
          warnings.push(`modules.${modName}.guide: file not found: ${mod.guide}`);
        }
      }
      if (mod.dependencies) {
        for (const dep of mod.dependencies) {
          if (!moduleNames.includes(dep)) {
            errors.push(`modules.${modName}.dependencies: unknown module "${dep}"`);
          }
        }
      }
    }
  }

  const scripts = manifest.scripts as Record<string, { file?: string }> | undefined;
  if (scripts) {
    for (const [scriptName, script] of Object.entries(scripts)) {
      if (script.file) {
        const scriptPath = resolveInsideDir(unitDir, script.file, true);
        if (!scriptPath) {
          errors.push(`scripts.${scriptName}.file: path escapes unit folder: ${script.file}`);
        } else if (!fs.existsSync(scriptPath)) {
          errors.push(`scripts.${scriptName}.file: not found: ${script.file}`);
        }
      }
    }
  }

  const references = manifest.references as Record<string, { file?: string }> | undefined;
  if (references) {
    for (const [refName, ref] of Object.entries(references)) {
      if (ref.file) {
        const refPath = resolveInsideDir(unitDir, ref.file, true);
        if (!refPath) {
          errors.push(`references.${refName}.file: path escapes unit folder: ${ref.file}`);
        } else if (!fs.existsSync(refPath)) {
          errors.push(`references.${refName}.file: not found: ${ref.file}`);
        }
      }
    }
  }

  const workflows = manifest.workflows as Record<string, unknown> | undefined;
  if (workflows) {
    const workflowsDir = path.join(unitDir, 'workflows');
    for (const wfName of Object.keys(workflows)) {
      const wfPath = resolveInsideDir(workflowsDir, `${wfName}.json`, true);
      if (!wfPath) {
        errors.push(`workflows.${wfName}: invalid workflow name`);
      } else if (!fs.existsSync(wfPath)) {
        warnings.push(`workflows.${wfName}: file not found: workflows/${wfName}.json`);
      } else {
        try {
          const wfContent = fs.readFileSync(wfPath, 'utf-8');
          const wfDef = JSON.parse(wfContent);
          if (!wfDef.steps || !Array.isArray(wfDef.steps)) {
            errors.push(`workflows/${wfName}.json: missing or invalid "steps" array`);
          }
        } catch (e) {
          errors.push(`workflows/${wfName}.json: invalid JSON: ${e}`);
        }
      }
    }
  }

  return { errors, warnings };
}

function validateStandaloneMdFile(filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!filePath.toLowerCase().endsWith('.md')) {
    errors.push(`File is not a Markdown (.md) document: ${path.basename(filePath)}`);
    return { errors, warnings };
  }

  if (path.basename(filePath).toLowerCase() === 'readme.md') {
    errors.push('Standalone doc cannot be named README.md (ignored by knowledge scanner).');
    return { errors, warnings };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    errors.push(`Failed to read file: ${e}`);
    return { errors, warnings };
  }

  if (!content.trim()) {
    errors.push('Markdown file is empty');
    return { errors, warnings };
  }

  const { metadata, body } = parseFrontmatter(content);
  if (!body.trim()) {
    errors.push('Markdown body is empty');
  }
  if (!metadata.description) {
    warnings.push('Missing frontmatter "description" (recommended for search relevance)');
  }
  if (!metadata.tags && !metadata.keywords) {
    warnings.push('Missing frontmatter "tags" (recommended for search relevance)');
  }

  return { errors, warnings };
}

function syncManifestName(unitDir: string, targetName: string): void {
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

function cmdValidate(knowledgeDir: string, args: string[]): void {
  const targetArg = args[0];

  // Check if targetArg refers to an external or local filesystem path directly
  if (targetArg) {
    const localCandidate = path.resolve(targetArg);
    const hasPathSyntax =
      /[\\/]/.test(targetArg) ||
      targetArg.startsWith('.') ||
      targetArg.endsWith('.md') ||
      path.isAbsolute(targetArg);

    if (fs.existsSync(localCandidate) && (hasPathSyntax || !fs.existsSync(path.join(knowledgeDir, targetArg)))) {
      const stat = fs.statSync(localCandidate);
      if (stat.isFile()) {
        const display = path.basename(localCandidate);
        console.log(`Validating '${display}'...`);
        const { errors, warnings } = validateStandaloneMdFile(localCandidate);
        printValidationResults(display, errors, warnings);
        console.log(`\n1 unit(s) validated.  ${errors.length} error(s), ${warnings.length} warning(s).`);
        if (errors.length > 0) process.exit(1);
        return;
      }

      if (stat.isDirectory()) {
        const manifestFolders = findManifestFolders(localCandidate);
        if (manifestFolders.length > 0) {
          let totalErrors = 0;
          let totalWarnings = 0;
          for (const unitDir of manifestFolders) {
            const rel = path.relative(localCandidate, unitDir).replace(/\\/g, '/');
            const displayUnit = rel || path.basename(unitDir);
            console.log(`Validating '${displayUnit}'...`);
            const { errors, warnings } = validateManifestUnitDir(unitDir);
            printValidationResults(displayUnit, errors, warnings);
            totalErrors += errors.length;
            totalWarnings += warnings.length;
          }
          console.log(
            `\n${manifestFolders.length} unit(s) validated.  ${totalErrors} error(s), ${totalWarnings} warning(s).`
          );
          if (totalErrors > 0) process.exit(1);
          return;
        }

        const mdFiles = findMdFiles(localCandidate);
        if (mdFiles.length > 0) {
          let totalErrors = 0;
          let totalWarnings = 0;
          for (const mdFile of mdFiles) {
            const displayUnit = path.relative(localCandidate, mdFile).replace(/\\/g, '/');
            console.log(`Validating '${displayUnit}'...`);
            const { errors, warnings } = validateStandaloneMdFile(mdFile);
            printValidationResults(displayUnit, errors, warnings);
            totalErrors += errors.length;
            totalWarnings += warnings.length;
          }
          console.log(
            `\n${mdFiles.length} unit(s) validated.  ${totalErrors} error(s), ${totalWarnings} warning(s).`
          );
          if (totalErrors > 0) process.exit(1);
          return;
        }

        console.log('No manifest-based units to validate.');
        return;
      }
    }
  }

  if (!fs.existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  if (targetArg) {
    resolveSafeUnitDir(knowledgeDir, targetArg);
  }

  const allManifestFolders = findManifestFolders(knowledgeDir);
  const toValidate = targetArg
    ? allManifestFolders.filter((folder) => {
        const rel = path.relative(knowledgeDir, folder).replace(/\\/g, '/');
        return rel === targetArg.replace(/\\/g, '/') || path.basename(folder) === targetArg;
      })
    : allManifestFolders;

  if (targetArg && toValidate.length === 0) {
    const targetDir = path.join(knowledgeDir, targetArg);
    const targetMd = targetArg.endsWith('.md') ? targetDir : `${targetDir}.md`;
    if (fs.existsSync(targetMd) && fs.statSync(targetMd).isFile()) {
      const display = path.relative(knowledgeDir, targetMd).replace(/\\/g, '/');
      console.log(`Validating '${display}'...`);
      const { errors, warnings } = validateStandaloneMdFile(targetMd);
      printValidationResults(display, errors, warnings);
      console.log(`\n1 unit(s) validated.  ${errors.length} error(s), ${warnings.length} warning(s).`);
      if (errors.length > 0) process.exit(1);
      return;
    }
    if (!fs.existsSync(targetDir)) {
      console.error(`Error: '${targetArg}' not found.`);
      process.exit(1);
    }
    console.log('No manifest-based units to validate.');
    return;
  }

  let validatedCount = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const unitDir of toValidate) {
    const displayUnit = path.relative(knowledgeDir, unitDir).replace(/\\/g, '/');
    const manifestPath = path.join(unitDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    validatedCount++;
    console.log(`Validating '${displayUnit}'...`);
    const { errors, warnings } = validateManifestUnitDir(unitDir);
    printValidationResults(displayUnit, errors, warnings);
    totalErrors += errors.length;
    totalWarnings += warnings.length;
  }

  if (validatedCount > 0) {
    console.log(`\n${validatedCount} unit(s) validated.  ${totalErrors} error(s), ${totalWarnings} warning(s).`);
    if (totalErrors > 0) process.exit(1);
  } else {
    console.log('No manifest-based units to validate.');
  }
}

function cmdInstall(knowledgeDir: string, args: string[]): void {
  let sourceArg = '';
  let customName = '';
  let force = false;
  let installAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --name requires an alias argument.');
        process.exit(1);
      }
      customName = args[++i];
    } else if (args[i] === '--force' || args[i] === '-f') {
      force = true;
    } else if (args[i] === '--all') {
      installAll = true;
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'install'.`);
      process.exit(1);
    } else if (!sourceArg) {
      sourceArg = args[i];
    } else {
      console.error(`Error: Unexpected argument '${args[i]}'.`);
      process.exit(1);
    }
  }

  if (!sourceArg) {
    console.error(
      'Error: Source path is required.\nUsage: knowledge-shelf install <path> [--name <alias>] [--force] [--all]'
    );
    process.exit(1);
  }

  const resolvedSource = path.resolve(sourceArg);
  if (!fs.existsSync(resolvedSource)) {
    console.error(`Error: Source path not found: ${sourceArg}`);
    process.exit(1);
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  const registry = loadRegistry(knowledgeDir);
  const stat = fs.statSync(resolvedSource);

  const upsertRegistryEntry = (unitName: string, originPath: string) => {
    const now = new Date().toISOString();
    const existing = registry.sources.find((s) => s.name === unitName);
    if (existing) {
      existing.url = `local:${originPath}`;
      existing.commit = 'local';
      existing.updatedAt = now;
    } else {
      registry.sources.push({
        name: unitName,
        url: `local:${originPath}`,
        commit: 'local',
        installedAt: now,
        updatedAt: now,
      });
    }
  };

  // Case 1: Standalone .md file
  if (stat.isFile()) {
    if (installAll) {
      console.error('Error: --all cannot be used when installing a single file.');
      process.exit(1);
    }
    const baseName = customName
      ? customName.endsWith('.md')
        ? customName
        : `${customName}.md`
      : path.basename(resolvedSource);
    console.log(`Validating '${baseName}'...`);
    const { errors, warnings } = validateStandaloneMdFile(resolvedSource);
    printValidationResults(baseName, errors, warnings);
    if (errors.length > 0) {
      console.error(`\nError: Validation failed with ${errors.length} error(s). Aborting install.`);
      process.exit(1);
    }

    const destFile = resolveSafeUnitDir(knowledgeDir, baseName);
    if (path.resolve(destFile) === resolvedSource) {
      console.error(`Error: Source and destination are the same path (${destFile}).`);
      process.exit(1);
    }
    if (fs.existsSync(destFile) && !force) {
      console.error(`Error: '${baseName}' already exists in knowledge folder. Use --force to overwrite.`);
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(resolvedSource, destFile);
    upsertRegistryEntry(baseName, resolvedSource);
    saveRegistry(knowledgeDir, registry);
    console.log(`✓ Installed standalone knowledge '${baseName}'`);
    return;
  }

  // Case 2: Directory with --all (install all units / standalone docs inside a staging folder)
  if (installAll) {
    if (customName) {
      console.error('Error: --name cannot be combined with --all.');
      process.exit(1);
    }

    const { units: manifestFolders, conflicts } = collectUnitFolders(resolvedSource);
    if (conflicts.length > 0) {
      console.error(`Error: Multiple units share the same folder name: ${conflicts.join('; ')}.`);
      console.error('Install each one individually with --name.');
      process.exit(1);
    }
    const topLevelMds = fs
      .readdirSync(resolvedSource, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md')
      .map((e) => path.join(resolvedSource, e.name));

    if (manifestFolders.length === 0 && topLevelMds.length === 0) {
      console.error(`Error: No knowledge units or standalone .md files found inside '${sourceArg}'.`);
      process.exit(1);
    }

    let validationFailures = 0;
    for (const unitDir of manifestFolders) {
      const unitName = path.basename(unitDir);
      console.log(`Validating '${unitName}'...`);
      const { errors, warnings } = validateManifestUnitDir(unitDir, unitName);
      printValidationResults(unitName, errors, warnings);
      if (errors.length > 0) validationFailures += errors.length;
    }
    for (const mdFile of topLevelMds) {
      const docName = path.basename(mdFile);
      console.log(`Validating '${docName}'...`);
      const { errors, warnings } = validateStandaloneMdFile(mdFile);
      printValidationResults(docName, errors, warnings);
      if (errors.length > 0) validationFailures += errors.length;
    }

    if (validationFailures > 0) {
      console.error(`\nError: Validation failed with ${validationFailures} error(s). Aborting install.`);
      process.exit(1);
    }

    let installed = 0;
    let skipped = 0;

    for (const unitDir of manifestFolders) {
      const unitName = path.basename(unitDir);
      const destDir = resolveSafeUnitDir(knowledgeDir, unitName);
      if (fs.existsSync(destDir) && !force) {
        console.log(`  Skipping '${unitName}' (already exists; use --force to overwrite)`);
        skipped++;
        continue;
      }
      replaceDirSync(knowledgeDir, unitDir, destDir);
      upsertRegistryEntry(unitName, unitDir);
      console.log(`  ✓ Installed '${unitName}'`);
      installed++;
    }

    for (const mdFile of topLevelMds) {
      const docName = path.basename(mdFile);
      const destFile = resolveSafeUnitDir(knowledgeDir, docName);
      if (fs.existsSync(destFile) && !force) {
        console.log(`  Skipping '${docName}' (already exists; use --force to overwrite)`);
        skipped++;
        continue;
      }
      fs.copyFileSync(mdFile, destFile);
      upsertRegistryEntry(docName, mdFile);
      console.log(`  ✓ Installed '${docName}'`);
      installed++;
    }

    saveRegistry(knowledgeDir, registry);
    console.log(`\nDone. ${installed} installed, ${skipped} skipped.`);
    return;
  }

  // Case 3: Single manifest-based directory
  const manifestPath = path.join(resolvedSource, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(
      `Error: No manifest.json found in '${sourceArg}'. (If this is a parent folder of multiple units, pass --all)`
    );
    process.exit(1);
  }

  const unitName = customName || path.basename(resolvedSource);
  console.log(`Validating '${unitName}'...`);
  const { errors, warnings } = validateManifestUnitDir(
    resolvedSource,
    customName ? path.basename(resolvedSource) : unitName
  );
  printValidationResults(unitName, errors, warnings);

  if (errors.length > 0) {
    console.error(`\nError: Validation failed with ${errors.length} error(s). Aborting install.`);
    process.exit(1);
  }

  const destDir = resolveSafeUnitDir(knowledgeDir, unitName);
  if (path.resolve(destDir) === resolvedSource) {
    console.error(`Error: Source and destination are the same directory (${destDir}).`);
    process.exit(1);
  }

  if (fs.existsSync(destDir) && !force) {
    console.error(`Error: '${unitName}' is already installed. Use --force to overwrite.`);
    process.exit(1);
  }

  replaceDirSync(knowledgeDir, resolvedSource, destDir);
  if (customName) {
    syncManifestName(destDir, unitName);
  }

  upsertRegistryEntry(unitName, resolvedSource);
  saveRegistry(knowledgeDir, registry);
  console.log(`✓ Installed '${unitName}'`);
}

function printValidationResults(name: string, errors: string[], warnings: string[]): void {
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`  ✓ ${name} — OK`);
    return;
  }
  for (const err of errors) {
    console.log(`  ✗ ${name} — ERROR: ${err}`);
  }
  for (const warn of warnings) {
    console.log(`  ⚠ ${name} — WARNING: ${warn}`);
  }
}

function cmdPin(knowledgeDir: string, args: string[]): void {
  const name = args[0];
  const version = args[1];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf pin <name> [tag|commit]');
    process.exit(1);
  }

  const registry = loadRegistry(knowledgeDir);
  const source = registry.sources.find((s) => s.name === name);

  if (!source) {
    console.error(`Error: '${name}' not found in registry.`);
    process.exit(1);
  }

  // When a specific tag/commit is requested and differs from the installed commit,
  // attempt to check out that ref so on-disk files actually match the pinned version.
  if (version && version !== source.commit) {
    if (source.url.startsWith('local:')) {
      console.error(
        `Error: '${name}' was installed from a local path and has no git history; ` +
          `cannot pin it to '${version}'. Run 'pin ${name}' without a version to lock it as-is.`
      );
      process.exit(1);
    }
    fs.mkdirSync(getCacheDir(knowledgeDir), { recursive: true });
    const repoName = deriveNameFromUrl(source.url);
    const cloneTarget = getCloneTarget(knowledgeDir, `${repoName}-pin`);

    try {
      removeDirSync(cloneTarget);
      gitCloneAtRef(source.url, cloneTarget, version);

      const sourceDir = source.path ? resolveInsideDir(cloneTarget, source.path, true) : cloneTarget;
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        throw new Error(`Path '${source.path}' not found at ref '${version}'.`);
      }

      const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
      replaceDirSync(knowledgeDir, sourceDir, destDir);

      source.commit = gitGetCommit(cloneTarget);
      source.updatedAt = new Date().toISOString();
    } catch (e) {
      console.error(`Error: Failed to checkout '${version}' for '${name}': ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    } finally {
      removeDirSync(cloneTarget);
    }
  }

  source.pin = version || source.commit;
  saveRegistry(knowledgeDir, registry);
  console.log(`✓ Pinned '${name}' to ${source.pin}`);
  console.log(`  This source will be skipped during 'update'.  Use 'unpin ${name}' to unlock.`);
}

function cmdUnpin(knowledgeDir: string, args: string[]): void {
  const name = args[0];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf unpin <name>');
    process.exit(1);
  }

  const registry = loadRegistry(knowledgeDir);
  const source = registry.sources.find((s) => s.name === name);

  if (!source) {
    console.error(`Error: '${name}' not found in registry.`);
    process.exit(1);
  }

  if (!source.pin) {
    console.log(`'${name}' is not pinned.`);
    return;
  }

  delete source.pin;
  saveRegistry(knowledgeDir, registry);
  console.log(`✓ Unpinned '${name}'.  It will be updated normally.`);
}

function cmdSearch(knowledgeDir: string, args: string[]): void {
  const query = args.join(' ').trim();

  if (!query) {
    console.error('Error: Query is required.\nUsage: knowledge-shelf search <keywords>');
    process.exit(1);
  }

  if (!fs.existsSync(knowledgeDir)) {
    console.log('No knowledge directory found.');
    return;
  }

  const docs = scanDocuments(knowledgeDir);

  if (docs.length === 0) {
    console.log('No documents found.');
    return;
  }

  const queryTerms = query.split(/\s+/).filter(Boolean);
  const scored: Array<{ name: string; title: string; description: string; score: number; type: string }> = [];

  for (const doc of docs) {
    const score = searchScore(doc, queryTerms);
    if (score > 0) {
      scored.push({
        name: doc.name,
        title: doc.title,
        description: doc.description,
        score,
        type: doc.has_manifest ? doc.type || 'manifest' : 'standalone',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, 10);

  if (results.length === 0) {
    console.log(`No results for "${query}".`);
    return;
  }

  console.log(`\nResults for "${query}" (${results.length} found):\n`);
  for (const r of results) {
    const desc = r.description ? `  ${r.description.slice(0, 80)}` : '';
    console.log(`  ${r.name}  [${r.type}]  (score: ${r.score})`);
    if (desc) console.log(`  ${desc}`);
    console.log('');
  }
}

function cmdExport(knowledgeDir: string, args: string[]): void {
  let name = '';
  let outputPath = '';
  let format = 'zip';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --output requires a file path.');
        process.exit(1);
      }
      outputPath = args[++i];
    } else if (args[i] === '--format') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --format requires a format (zip or tar).');
        process.exit(1);
      }
      format = args[++i];
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'export'.`);
      process.exit(1);
    } else if (!name) {
      name = args[i];
    } else {
      console.error(`Error: Unexpected argument '${args[i]}'.`);
      process.exit(1);
    }
  }

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf export <name> [--output <path>] [--format zip|tar]');
    process.exit(1);
  }

  if (format !== 'zip' && format !== 'tar') {
    console.error(`Error: Unsupported format '${format}'. Use 'zip' or 'tar'.`);
    process.exit(1);
  }

  const unitDir = resolveSafeUnitDir(knowledgeDir, name);
  if (!fs.existsSync(unitDir) || !fs.statSync(unitDir).isDirectory()) {
    console.error(`Error: '${name}' not found in ${knowledgeDir}`);
    process.exit(1);
  }

  if (!outputPath) {
    const ext = format === 'tar' ? '.tar.gz' : '.zip';
    outputPath = path.resolve(process.cwd(), `${path.basename(name)}${ext}`);
  } else {
    outputPath = path.resolve(outputPath);
  }

  console.log(`Exporting '${name}' to ${outputPath}...`);

  try {
    let result: ReturnType<typeof spawnSync>;
    if (format === 'tar') {
      result = spawnSync('tar', ['-czf', outputPath, '-C', knowledgeDir, name], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } else if (process.platform === 'win32') {
      const escapedUnitDir = unitDir.replace(/'/g, "''");
      const escapedOutputPath = outputPath.replace(/'/g, "''");
      result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -LiteralPath '${escapedUnitDir}' -DestinationPath '${escapedOutputPath}' -Force`,
        ],
        { stdio: 'pipe', encoding: 'utf-8' }
      );
    } else {
      result = spawnSync('zip', ['-r', outputPath, name], {
        cwd: knowledgeDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    }

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(String(result.stderr || 'archive command failed'));
    }

    const stat = fs.statSync(outputPath);
    console.log(`✓ Exported '${name}' (${formatSize(stat.size)})`);
  } catch (e) {
    console.error(`Error: Failed to create archive.\n${e}`);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
Knowledge Shelf v${getPackageVersion()} — manage knowledge sources from git repositories.

Usage:
  knowledge-shelf <command> [--dir <knowledge-path>] [options]

Commands:
  add <url> [--path <subfolder>] [--name <alias>] [--all]
      Clone a git repository and install knowledge into the local folder.
      --path    Install only a specific subfolder from the repo (uses sparse checkout).
      --name    Custom name for the installed knowledge (default: derived from URL/path).
      --all     Auto-detect and install ALL subfolders with manifest.json (monorepo mode).

  install <path> [--name <alias>] [--force] [--all]
      Validate and install drafted knowledge from a local path (e.g. ./.agents/knowledges/<name>)
      into the knowledge directory. Supports manifest folders and standalone .md files.
      --name    Custom name for the installed knowledge unit.
      --force   Overwrite if already installed in the knowledge directory.
      --all     Install all knowledge units and standalone .md files inside <path>.

  info <name>
      Show detailed information about an installed knowledge unit.

  search <keywords>
      Search installed knowledge by keyword (same scoring as MCP search_docs tool).

  list
      List all installed knowledge sources with their origin and version.

  validate [name|path]
      Validate knowledge unit structure (manifest, file references, workflows, or standalone .md).
      Accepts an installed unit name or a direct local path (e.g. ./.agents/knowledges/<name>).
      If omitted, validates all manifest-based units in the knowledge directory.

  update [name]
      Update all installed sources (or a specific one) from their remote repos.
      Pinned sources are skipped.

  pin <name> [tag|commit]
      Lock a source to its current version (or checkout & lock a specific tag/commit).
      Pinned sources are skipped during 'update'.

  unpin <name>
      Unlock a pinned source so it can be updated again.

  export <name> [--output <path>] [--format zip|tar]
      Package a knowledge unit as a zip or tar.gz archive for sharing.

  remove <name>
      Remove an installed knowledge source.

  init
      Initialize the knowledge directory and registry.

  version, --version, -v
      Print installed version.

Global Options:
  --dir <path>     Explicit path to knowledge directory.

Resolution Order (how the knowledge directory is found):
  1. --dir flag (highest priority)
  2. KNOWLEDGE_DIR environment variable
  3. Walk up from CWD looking for .registry.json (or knowledge/.registry.json)
  4. ~/.knowledge (global default)
`);
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

export function runCli(rawArgs: string[]): void {
  let cliDir: string | undefined;
  const args: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--dir') {
      if (i + 1 >= rawArgs.length || rawArgs[i + 1].startsWith('-')) {
        console.error('Error: --dir requires a directory path.');
        process.exit(1);
      }
      cliDir = rawArgs[++i];
    } else {
      args.push(rawArgs[i]);
    }
  }

  const command = args[0];
  const knowledgeDir = resolveKnowledgeDir(cliDir);

  switch (command) {
    case 'add':
      cmdAdd(knowledgeDir, args.slice(1));
      break;
    case 'install':
      cmdInstall(knowledgeDir, args.slice(1));
      break;
    case 'info':
      cmdInfo(knowledgeDir, args.slice(1));
      break;
    case 'search':
      cmdSearch(knowledgeDir, args.slice(1));
      break;
    case 'list':
    case 'ls':
      cmdList(knowledgeDir);
      break;
    case 'validate':
      cmdValidate(knowledgeDir, args.slice(1));
      break;
    case 'update':
    case 'up':
      cmdUpdate(knowledgeDir, args.slice(1));
      break;
    case 'pin':
      cmdPin(knowledgeDir, args.slice(1));
      break;
    case 'unpin':
      cmdUnpin(knowledgeDir, args.slice(1));
      break;
    case 'export':
      cmdExport(knowledgeDir, args.slice(1));
      break;
    case 'remove':
    case 'rm':
      cmdRemove(knowledgeDir, args.slice(1));
      break;
    case 'init':
      cmdInit(knowledgeDir);
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(getPackageVersion());
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}
