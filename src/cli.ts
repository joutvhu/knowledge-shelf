/**
 * Knowledge Shelf CLI
 *
 * Subcommands:
 *   add <url> [--path <subfolder>] [--name <alias>] [--all]   Pull knowledge from a git repo
 *   info <name>                                               Show detailed unit info
 *   search <keywords>                                         Search installed knowledge
 *   list                                                      List installed knowledge sources
 *   validate [name]                                           Validate manifest-based units
 *   update [name]                                             Update all or specific knowledge
 *   pin <name> [tag|commit]                                   Lock knowledge source version
 *   unpin <name>                                              Unlock knowledge source
 *   export <name> [--output <path>] [--format zip|tar]        Package knowledge unit
 *   install-skill [path]                                      Install bundled skill
 *   remove <name>                                             Remove installed knowledge
 *   init                                                      Initialize a knowledge directory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findManifestFolders,
  getPackageVersion,
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
    return JSON.parse(content) as Registry;
  } catch {
    return { version: '1.0', sources: [] };
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

function deriveNameFromUrl(url: string): string {
  const normalized = url.replace(/[\\/]+$/, '');
  const match = normalized.match(/[/:\\]([^/:\\]+?)(?:\.git)?$/);
  return match ? match[1] : 'unknown';
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInstallSkill(args: string[]): void {
  const targetParentDir = args[0] || '.';

  const resolvedTargetParent = path.resolve(targetParentDir);
  if (!fs.existsSync(resolvedTargetParent)) {
    console.log(`Target directory '${resolvedTargetParent}' does not exist. Creating it...`);
    fs.mkdirSync(resolvedTargetParent, { recursive: true });
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const skillSrc = path.resolve(__dirname, '..', 'skills', 'knowledge-builder');

  if (!fs.existsSync(skillSrc)) {
    console.error(`Error: Bundled skill source not found at: ${skillSrc}`);
    process.exit(1);
  }

  const destDir = path.join(resolvedTargetParent, 'knowledge-builder');
  if (fs.existsSync(destDir)) {
    console.log(`Skill 'knowledge-builder' is already installed at: ${destDir}`);
    console.log('Overwriting...');
    removeDirSync(destDir);
  }

  console.log(`Copying skill 'knowledge-builder' to ${destDir}...`);
  copyDirSync(skillSrc, destDir);
  console.log('✓ Successfully installed bundled skill!');
}

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
  const cloneTarget = path.join(cacheDir, repoName);

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

    const manifestFolders = findManifestFolders(baseDir).filter((f) => path.resolve(f) !== path.resolve(baseDir));
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

    console.log(`Updating '${source.name}'...`);

    const repoName = deriveNameFromUrl(source.url);
    const cloneTarget = path.join(cacheDir, repoName);

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
      removeDirSync(destDir);
      copyDirSync(sourceDir, destDir);

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

  const unitDir = resolveSafeUnitDir(knowledgeDir, name);
  if (!fs.existsSync(unitDir) || !fs.statSync(unitDir).isDirectory()) {
    console.error(`Error: '${name}' not found in ${knowledgeDir}`);
    process.exit(1);
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

function cmdValidate(knowledgeDir: string, args: string[]): void {
  const targetName = args[0];

  if (!fs.existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  if (targetName) {
    resolveSafeUnitDir(knowledgeDir, targetName);
  }

  const allManifestFolders = findManifestFolders(knowledgeDir);
  const toValidate = targetName
    ? allManifestFolders.filter((folder) => {
        const rel = path.relative(knowledgeDir, folder).replace(/\\/g, '/');
        return rel === targetName.replace(/\\/g, '/') || path.basename(folder) === targetName;
      })
    : allManifestFolders;

  if (targetName && toValidate.length === 0) {
    const targetDir = path.join(knowledgeDir, targetName);
    if (!fs.existsSync(targetDir)) {
      console.error(`Error: '${targetName}' not found.`);
      process.exit(1);
    }
    console.log('No manifest-based units to validate.');
    return;
  }

  let validatedCount = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const unitDir of toValidate) {
    const unitName = path.basename(unitDir);
    const displayUnit = path.relative(knowledgeDir, unitDir).replace(/\\/g, '/');
    const manifestPath = path.join(unitDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    validatedCount++;
    console.log(`Validating '${displayUnit}'...`);
    const errors: string[] = [];
    const warnings: string[] = [];

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      errors.push(`manifest.json is invalid JSON: ${e}`);
      printValidationResults(displayUnit, errors, warnings);
      totalErrors += errors.length;
      continue;
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
    const cacheDir = getCacheDir(knowledgeDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    const repoName = deriveNameFromUrl(source.url);
    const cloneTarget = path.join(cacheDir, `${repoName}-pin`);

    try {
      removeDirSync(cloneTarget);
      gitCloneAtRef(source.url, cloneTarget, version);

      const sourceDir = source.path ? resolveInsideDir(cloneTarget, source.path, true) : cloneTarget;
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        throw new Error(`Path '${source.path}' not found at ref '${version}'.`);
      }

      const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
      removeDirSync(destDir);
      copyDirSync(sourceDir, destDir);

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

  info <name>
      Show detailed information about an installed knowledge unit.

  search <keywords>
      Search installed knowledge by keyword (same scoring as MCP search_docs tool).

  list
      List all installed knowledge sources with their origin and version.

  validate [name]
      Validate knowledge unit structure (manifest, file references, workflows).
      If no name given, validates all manifest-based units.

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

  install-skill [path]
      Install the bundled 'knowledge-builder' skill to the target agent skills directory (default: current directory).

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
    case 'install-skill':
      cmdInstallSkill(args.slice(1));
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
