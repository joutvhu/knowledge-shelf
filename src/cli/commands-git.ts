/**
 * Git & sharing CLI commands:
 * add, update, pin, unpin, outdated, sync, catalog, index, scaffold, publish.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkUnitPublishHygiene,
  expandHome,
  findManifestFolders,
  loadManifest,
  resolveInsideDir,
  validateManifestUnitDir,
  validateStandaloneMdFile,
} from '../core.js';
import {
  printSecurityNotice,
  printValidationResults,
  rejectUnknownFlags,
} from './commands-manage.js';
import {
  assertGitAvailable,
  assertSafeGitArg,
  collectUnitFolders,
  copyDirSync,
  deriveNameFromUrl,
  getCloneTarget,
  gitClone,
  gitCloneAtRef,
  gitCloneSparse,
  gitEnv,
  gitGetBranch,
  gitGetCommit,
  gitLsRemote,
  removeDirSync,
  replaceDirSync,
  syncManifestName,
} from './git.js';
import {
  RegistryEntry,
  ShelfCatalog,
  ShelfCatalogUnit,
  TeamSourceEntry,
  computeUnitChecksum,
  getCacheDir,
  loadRegistry,
  loadShelfCatalog,
  loadTeamConfig,
  resolveSafeUnitDir,
  saveRegistry,
} from './registry.js';

function isSafeUnitSegment(name: string): boolean {
  return Boolean(name) && !name.startsWith('.') && !name.includes('/') && !name.includes('\\') && name !== '..';
}

function validateStagedDirectory(
  stagedDir: string,
  unitName: string,
  noVerify: boolean
): boolean {
  if (noVerify) return true;
  const manifestPath = path.join(stagedDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const { errors, warnings } = validateManifestUnitDir(stagedDir, unitName);
    printValidationResults(unitName, errors, warnings);
    return errors.length === 0;
  }
  return true;
}

export function cmdAdd(knowledgeDir: string, args: string[]): void {
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(getCacheDir(knowledgeDir), { recursive: true });

  let url = '';
  let subPath = '';
  let customName = '';
  let ref = '';
  let packName = '';
  let addAll = false;
  let force = false;
  let noVerify = false;
  let trusted = false;
  let pinAfter = false;

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
    } else if (args[i] === '--ref') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --ref requires a branch, tag, or commit argument.');
        process.exit(1);
      }
      ref = args[++i];
    } else if (args[i] === '--pack') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --pack requires a pack name.');
        process.exit(1);
      }
      packName = args[++i];
    } else if (args[i] === '--all') {
      addAll = true;
    } else if (args[i] === '--force' || args[i] === '-f') {
      force = true;
    } else if (args[i] === '--no-verify') {
      noVerify = true;
    } else if (args[i] === '--trust') {
      trusted = true;
    } else if (args[i] === '--pin') {
      pinAfter = true;
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
      'Error: URL is required.\nUsage: knowledge-shelf add <url> [--path <subfolder>] [--name <alias>] [--ref <ref>] [--pack <pack>] [--all] [--force] [--no-verify]'
    );
    process.exit(1);
  }

  if ((addAll || packName) && customName) {
    console.error('Error: --name cannot be combined with --all or --pack.');
    process.exit(1);
  }

  const repoName = deriveNameFromUrl(url);
  const cloneTarget = getCloneTarget(knowledgeDir, repoName);

  console.log(`Cloning ${url}${ref ? ` (ref: ${ref})` : ''}...`);
  removeDirSync(cloneTarget);

  try {
    if (ref) {
      gitCloneAtRef(url, cloneTarget, ref);
    } else if (subPath && !addAll && !packName) {
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
  const branch = gitGetBranch(cloneTarget);

  let stageSeq = 0;
  const installUnitFromSource = (
    unitName: string,
    sourceDir: string,
    sourceSubPath: string | undefined,
    registry: ReturnType<typeof loadRegistry>,
    syncName: boolean
  ): 'installed' | 'skipped' | 'invalid' => {
    const destDir = resolveSafeUnitDir(knowledgeDir, unitName);
    const existing = registry.sources.find((s) => s.name === unitName);
    if ((existing || fs.existsSync(destDir)) && !force) {
      return 'skipped';
    }

    const stageDir = getCloneTarget(knowledgeDir, `.add-stage-${process.pid}-${Date.now()}-${++stageSeq}`);
    removeDirSync(stageDir);
    try {
      copyDirSync(sourceDir, stageDir);
      if (syncName) {
        syncManifestName(stageDir, unitName);
      }
      if (!validateStagedDirectory(stageDir, unitName, noVerify)) {
        console.error(`Error: Validation failed for '${unitName}'. Use --no-verify to bypass.`);
        removeDirSync(stageDir);
        return 'invalid';
      }
      replaceDirSync(knowledgeDir, stageDir, destDir);
    } finally {
      removeDirSync(stageDir);
    }

    const now = new Date().toISOString();
    const checksum = computeUnitChecksum(destDir);
    const entry: RegistryEntry = {
      name: unitName,
      url,
      path: sourceSubPath || undefined,
      ...(branch ? { branch } : {}),
      commit,
      ...(pinAfter || (ref && !branch) ? { pin: ref || commit } : {}),
      checksum,
      ...(trusted ? { trusted: true } : {}),
      installedAt: existing?.installedAt || now,
      updatedAt: now,
    };

    if (existing) {
      Object.assign(existing, entry);
    } else {
      registry.sources.push(entry);
    }
    printSecurityNotice(unitName, destDir);
    return 'installed';
  };

  // Pack mode (--pack <name> via shelf.json)
  if (packName) {
    const catalog = loadShelfCatalog(cloneTarget);
    if (!catalog || !catalog.packs || !catalog.packs[packName]) {
      console.error(`Error: Pack '${packName}' not found in repository shelf.json.`);
      removeDirSync(cloneTarget);
      process.exit(1);
    }
    const unitNames = catalog.packs[packName].units || [];
    const registry = loadRegistry(knowledgeDir);
    let installed = 0;
    let skipped = 0;
    let invalid = 0;

    for (const uName of unitNames) {
      const unitMeta = catalog.units.find((u) => u.name === uName);
      const unitRelPath = unitMeta?.path || uName;
      const sourceDir = resolveInsideDir(cloneTarget, unitRelPath, true);
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        console.error(`  ✗ Pack unit '${uName}' path '${unitRelPath}' not found.`);
        invalid++;
        continue;
      }
      const status = installUnitFromSource(uName, sourceDir, unitRelPath, registry, true);
      if (status === 'installed') {
        console.log(`  ✓ Installed '${uName}'`);
        installed++;
      } else if (status === 'invalid') {
        invalid++;
      } else {
        console.log(`  Skipping '${uName}' (already exists)`);
        skipped++;
      }
    }

    saveRegistry(knowledgeDir, registry);
    removeDirSync(cloneTarget);
    console.log(`\nDone. ${installed} installed, ${skipped} skipped${invalid ? `, ${invalid} failed` : ''}.`);
    if (invalid > 0) process.exit(1);
    return;
  }

  // Monorepo --all mode (installs all manifest units + top-level standalone .md files)
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

    const topLevelMds = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() &&
          e.name.toLowerCase().endsWith('.md') &&
          e.name.toLowerCase() !== 'readme.md'
      )
      .map((e) => path.join(baseDir, e.name));

    const registry = loadRegistry(knowledgeDir);
    let installed = 0;
    let skipped = 0;
    let invalid = 0;

    for (const sourceDir of manifestFolders) {
      const unitName = path.basename(sourceDir);
      const sourcePath = path.relative(cloneTarget, sourceDir).replace(/\\/g, '/');
      const status = installUnitFromSource(unitName, sourceDir, sourcePath, registry, false);
      if (status === 'installed') {
        console.log(`  ✓ Installed '${unitName}'`);
        installed++;
      } else if (status === 'invalid') {
        invalid++;
      } else {
        console.log(`  Skipping '${unitName}' (already installed)`);
        skipped++;
      }
    }

    for (const mdFile of topLevelMds) {
      const docName = path.basename(mdFile);
      const destFile = resolveSafeUnitDir(knowledgeDir, docName);
      const existing = registry.sources.find((s) => s.name === docName);
      if ((existing || fs.existsSync(destFile)) && !force) {
        console.log(`  Skipping '${docName}' (already exists)`);
        skipped++;
        continue;
      }
      if (!noVerify) {
        const { errors, warnings } = validateStandaloneMdFile(mdFile);
        printValidationResults(docName, errors, warnings);
        if (errors.length > 0) {
          invalid++;
          continue;
        }
      }
      fs.copyFileSync(mdFile, destFile);
      const sourcePath = path.relative(cloneTarget, mdFile).replace(/\\/g, '/');
      const now = new Date().toISOString();
      const checksum = computeUnitChecksum(destFile);
      const entry: RegistryEntry = {
        name: docName,
        url,
        path: sourcePath,
        ...(branch ? { branch } : {}),
        commit,
        ...(pinAfter || (ref && !branch) ? { pin: ref || commit } : {}),
        checksum,
        installedAt: existing?.installedAt || now,
        updatedAt: now,
      };
      if (existing) Object.assign(existing, entry);
      else registry.sources.push(entry);
      console.log(`  ✓ Installed '${docName}'`);
      installed++;
    }

    saveRegistry(knowledgeDir, registry);
    removeDirSync(cloneTarget);
    console.log(`\nDone. ${installed} installed, ${skipped} skipped${invalid ? `, ${invalid} failed` : ''}.`);
    if (invalid > 0) process.exit(1);
    return;
  }

  // Single unit mode
  const sourceDir = subPath ? resolveInsideDir(cloneTarget, subPath, true) : cloneTarget;
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    console.error(`Error: Path '${subPath}' not found in repository.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  let derivedDefault = subPath ? path.basename(subPath) : repoName;
  if (!customName && !subPath) {
    const rootManifest = loadManifest(sourceDir);
    if (rootManifest?.name && isSafeUnitSegment(rootManifest.name)) {
      derivedDefault = rootManifest.name;
    }
  }
  const name = customName || derivedDefault;
  const destDir = resolveSafeUnitDir(knowledgeDir, name);

  const registry = loadRegistry(knowledgeDir);
  const existing = registry.sources.find((s) => s.name === name);
  if (existing && !force) {
    console.error(`Error: '${name}' is already installed.  Use 'update ${name}' or pass --force.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  if (fs.existsSync(destDir) && !force) {
    console.error(`Error: Directory '${name}' already exists in knowledge folder. Pass --force to overwrite.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  console.log(`Installing to ${name}/...`);

  const stageDir = getCloneTarget(knowledgeDir, `.add-stage-${process.pid}-${Date.now()}`);
  removeDirSync(stageDir);
  try {
    copyDirSync(sourceDir, stageDir);
    if (customName) {
      syncManifestName(stageDir, name);
    }
    if (!validateStagedDirectory(stageDir, name, noVerify)) {
      console.error(`Error: Validation failed for '${name}'. Aborting add (use --no-verify to skip).`);
      removeDirSync(cloneTarget);
      process.exit(1);
    }
    replaceDirSync(knowledgeDir, stageDir, destDir);
  } finally {
    removeDirSync(stageDir);
  }

  const now = new Date().toISOString();
  const checksum = computeUnitChecksum(destDir);
  const entry: RegistryEntry = {
    name,
    url,
    path: subPath || undefined,
    ...(branch ? { branch } : {}),
    commit,
    ...(pinAfter || (ref && !branch) ? { pin: ref || commit } : {}),
    checksum,
    ...(trusted ? { trusted: true } : {}),
    installedAt: existing?.installedAt || now,
    updatedAt: now,
  };

  if (existing) {
    Object.assign(existing, entry);
  } else {
    registry.sources.push(entry);
  }
  saveRegistry(knowledgeDir, registry);
  removeDirSync(cloneTarget);
  console.log(`✓ Installed '${name}' (${commit})`);
  printSecurityNotice(name, destDir);
}

export function cmdUpdate(knowledgeDir: string, args: string[]): void {
  let targetName = '';
  let force = false;

  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg.startsWith('-')) {
      console.error(`Error: Unknown option '${arg}' for 'update'.`);
      process.exit(1);
    } else if (!targetName) {
      targetName = arg;
    } else {
      console.error(`Error: Unexpected argument '${arg}'.`);
      process.exit(1);
    }
  }

  const registry = loadRegistry(knowledgeDir);
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

  // Separate local vs remote sources; group remote sources by (url, branch) to deduplicate clones
  const remoteGroups = new Map<string, RegistryEntry[]>();

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
          source.checksum = computeUnitChecksum(destFile);
        } else {
          const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
          replaceDirSync(knowledgeDir, localPath, destDir);
          if (fs.existsSync(path.join(destDir, 'manifest.json'))) {
            syncManifestName(destDir, source.name);
          }
          source.checksum = computeUnitChecksum(destDir);
        }
        source.updatedAt = new Date().toISOString();
        updated++;
        console.log('  ✓ Updated from local path');
      } catch (e) {
        console.error(`  Error updating '${source.name}': ${e}`);
        failed++;
      }
      continue;
    }

    const groupKey = `${source.url}\0${source.branch || ''}`;
    const list = remoteGroups.get(groupKey) || [];
    list.push(source);
    remoteGroups.set(groupKey, list);
  }

  for (const [, group] of remoteGroups) {
    const first = group[0];
    const url = first.url;
    const branch = first.branch;
    const repoName = deriveNameFromUrl(url);
    const cloneTarget = getCloneTarget(knowledgeDir, repoName);

    // Check remote HEAD/branch SHA before cloning when all entries in group exist on disk
    const remoteSha = gitLsRemote(url, branch ? `refs/heads/${branch}` : 'HEAD');
    const pending: RegistryEntry[] = [];
    for (const source of group) {
      const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
      if (
        remoteSha &&
        source.commit &&
        source.commit.length >= 4 &&
        remoteSha.startsWith(source.commit) &&
        fs.existsSync(destDir)
      ) {
        console.log(`Updating '${source.name}'...`);
        console.log(`  Already up to date (${source.commit})`);
        continue;
      }
      pending.push(source);
    }

    if (pending.length === 0) continue;

    try {
      removeDirSync(cloneTarget);
      if (pending.length === 1 && pending[0].path) {
        gitCloneSparse(url, cloneTarget, pending[0].path, branch);
      } else {
        gitClone(url, cloneTarget, branch);
      }

      const newCommit = gitGetCommit(cloneTarget);

      for (const source of pending) {
        console.log(`Updating '${source.name}'...`);
        const destDir = resolveSafeUnitDir(knowledgeDir, source.name);

        if (newCommit === source.commit && fs.existsSync(destDir)) {
          console.log(`  Already up to date (${newCommit})`);
          continue;
        }

        if (source.checksum && fs.existsSync(destDir) && !force) {
          const currentChecksum = computeUnitChecksum(destDir);
          if (currentChecksum && currentChecksum !== source.checksum) {
            console.log(
              `  ⚠ Skipping '${source.name}' (local modifications detected; pass --force to overwrite)`
            );
            continue;
          }
        }

        const sourceDir = source.path ? resolveInsideDir(cloneTarget, source.path, true) : cloneTarget;
        if (!sourceDir || !fs.existsSync(sourceDir)) {
          console.error(`  Error: Path '${source.path}' no longer exists in repo.`);
          failed++;
          continue;
        }

        if (fs.statSync(sourceDir).isFile()) {
          fs.mkdirSync(path.dirname(destDir), { recursive: true });
          fs.copyFileSync(sourceDir, destDir);
        } else {
          replaceDirSync(knowledgeDir, sourceDir, destDir);
          syncManifestName(destDir, source.name);
        }

        source.commit = newCommit;
        source.checksum = computeUnitChecksum(destDir);
        source.updatedAt = new Date().toISOString();
        updated++;
        console.log(`  ✓ Updated to ${newCommit}`);
      }
    } catch (e) {
      for (const source of pending) {
        console.error(`  Error updating '${source.name}': ${e}`);
        failed++;
      }
    } finally {
      removeDirSync(cloneTarget);
    }
  }

  saveRegistry(knowledgeDir, registry);
  console.log(`\nDone. ${updated} updated, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

export function cmdPin(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'pin');
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
      syncManifestName(destDir, source.name);

      source.commit = gitGetCommit(cloneTarget);
      source.checksum = computeUnitChecksum(destDir);
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

export function cmdUnpin(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'unpin');
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

export function cmdOutdated(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'outdated');
  const registry = loadRegistry(knowledgeDir);
  if (registry.sources.length === 0) {
    console.log('No knowledge sources installed.');
    return;
  }

  console.log(`Checking ${registry.sources.length} source(s)...\n`);
  for (const s of registry.sources) {
    const destDir = resolveSafeUnitDir(knowledgeDir, s.name);
    const exists = fs.existsSync(destDir);
    const drift =
      exists && s.checksum && computeUnitChecksum(destDir) !== s.checksum ? ' [modified-locally]' : '';

    if (!exists) {
      console.log(`  ${s.name}: missing on disk`);
      continue;
    }
    if (s.url.startsWith('local:')) {
      console.log(`  ${s.name}: local${drift}`);
      continue;
    }
    if (s.pin) {
      console.log(`  ${s.name}: pinned (${s.pin})${drift}`);
      continue;
    }
    const ref = s.branch ? `refs/heads/${s.branch}` : 'HEAD';
    const remoteSha = gitLsRemote(s.url, ref);
    if (!remoteSha) {
      console.log(`  ${s.name}: unreachable${drift}`);
    } else if (s.commit && remoteSha.startsWith(s.commit)) {
      console.log(`  ${s.name}: up-to-date (${s.commit})${drift}`);
    } else {
      console.log(`  ${s.name}: outdated (${s.commit} -> ${remoteSha.slice(0, 7)})${drift}`);
    }
  }
}

export function cmdSync(knowledgeDir: string, args: string[]): void {
  let fileArg = '';
  let frozen = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' || args[i] === '-f') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --file requires a config path.');
        process.exit(1);
      }
      fileArg = args[++i];
    } else if (args[i] === '--frozen') {
      frozen = true;
    } else if (args[i] === '--force') {
      force = true;
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'sync'.`);
      process.exit(1);
    } else if (!fileArg) {
      fileArg = args[i];
    }
  }

  let sources: TeamSourceEntry[] = [];
  const candidatePaths = fileArg
    ? [path.resolve(expandHome(fileArg))]
    : [
        path.join(knowledgeDir, 'knowledge-shelf.json'),
        path.join(process.cwd(), 'knowledge-shelf.json'),
      ];

  const foundConfig = candidatePaths.find((p) => fs.existsSync(p));
  if (foundConfig) {
    try {
      sources = loadTeamConfig(foundConfig).sources;
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  } else {
    const reg = loadRegistry(knowledgeDir);
    sources = reg.sources
      .filter((s) => !s.url.startsWith('local:'))
      .map((s) => ({
        name: s.name,
        url: s.url,
        path: s.path,
        branch: s.branch,
        ref: s.pin || s.commit,
      }));
  }

  if (sources.length === 0) {
    console.log('No remote sources to sync.');
    return;
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(getCacheDir(knowledgeDir), { recursive: true });
  const registry = loadRegistry(knowledgeDir);

  if (frozen) {
    for (const s of sources) {
      const destDir = resolveSafeUnitDir(knowledgeDir, s.name);
      const regEntry = registry.sources.find((r) => r.name === s.name);
      if (!fs.existsSync(destDir) || !regEntry) {
        console.error(`Error (--frozen): '${s.name}' is not installed.`);
        process.exit(1);
      }
      const targetRef = s.pin || s.ref;
      if (targetRef && regEntry.commit !== targetRef && regEntry.pin !== targetRef) {
        console.error(
          `Error (--frozen): '${s.name}' version mismatch (installed: ${regEntry.commit}, expected: ${targetRef}).`
        );
        process.exit(1);
      }
    }
    console.log(`✓ All ${sources.length} source(s) verified (--frozen).`);
    return;
  }

  // Group by (url, ref || branch) to clone each repo+ref at most once
  const groups = new Map<string, TeamSourceEntry[]>();
  for (const s of sources) {
    const refKey = s.pin || s.ref || s.branch || '';
    const key = `${s.url}\0${refKey}`;
    groups.set(key, [...(groups.get(key) || []), s]);
  }

  let synced = 0;
  let failed = 0;

  for (const [, group] of groups) {
    const sample = group[0];
    const requestedRef = sample.pin || sample.ref || sample.branch || '';
    const cloneTarget = getCloneTarget(knowledgeDir, `${deriveNameFromUrl(sample.url)}-sync`);

    try {
      removeDirSync(cloneTarget);
      console.log(`Syncing from ${sample.url}${requestedRef ? ` (${requestedRef})` : ''}...`);
      if (requestedRef) {
        gitCloneAtRef(sample.url, cloneTarget, requestedRef);
      } else {
        gitClone(sample.url, cloneTarget);
      }

      const commit = gitGetCommit(cloneTarget);
      const branch = gitGetBranch(cloneTarget);

      for (const s of group) {
        const destDir = resolveSafeUnitDir(knowledgeDir, s.name);
        const existing = registry.sources.find((r) => r.name === s.name);

        if (
          !force &&
          fs.existsSync(destDir) &&
          existing &&
          existing.commit === commit &&
          (!s.pin || existing.pin === s.pin)
        ) {
          console.log(`  ✓ '${s.name}' already at ${commit}`);
          continue;
        }

        const sourceDir = s.path ? resolveInsideDir(cloneTarget, s.path, true) : cloneTarget;
        if (!sourceDir || !fs.existsSync(sourceDir)) {
          console.error(`  Error: Path '${s.path}' not found in repo for '${s.name}'.`);
          failed++;
          continue;
        }

        if (fs.statSync(sourceDir).isFile()) {
          fs.mkdirSync(path.dirname(destDir), { recursive: true });
          fs.copyFileSync(sourceDir, destDir);
        } else {
          replaceDirSync(knowledgeDir, sourceDir, destDir);
          syncManifestName(destDir, s.name);
        }

        const now = new Date().toISOString();
        const checksum = computeUnitChecksum(destDir);
        const updatedEntry: RegistryEntry = {
          name: s.name,
          url: s.url,
          path: s.path,
          ...(branch ? { branch } : {}),
          commit,
          ...(s.pin ? { pin: s.pin } : {}),
          checksum,
          ...(existing?.trusted ? { trusted: true } : {}),
          installedAt: existing?.installedAt || now,
          updatedAt: now,
        };
        if (existing) Object.assign(existing, updatedEntry);
        else registry.sources.push(updatedEntry);

        console.log(`  ✓ Synced '${s.name}' (${commit})`);
        synced++;
      }
    } catch (e) {
      for (const s of group) {
        console.error(`  Error syncing '${s.name}': ${e instanceof Error ? e.message : e}`);
        failed++;
      }
    } finally {
      removeDirSync(cloneTarget);
    }
  }

  saveRegistry(knowledgeDir, registry);
  console.log(`\nDone. ${synced} synced, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

export function cmdCatalog(knowledgeDir: string, args: string[]): void {
  let url = '';
  let ref = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ref') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --ref requires a branch/tag/commit.');
        process.exit(1);
      }
      ref = args[++i];
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'catalog'.`);
      process.exit(1);
    } else if (!url) {
      url = args[i];
    }
  }

  if (!url) {
    console.error('Error: Repository URL is required.\nUsage: knowledge-shelf catalog <url> [--ref <ref>]');
    process.exit(1);
  }

  const tmpClone = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-catalog-'));
  fs.rmSync(tmpClone, { recursive: true, force: true });

  try {
    if (ref) {
      gitCloneAtRef(url, tmpClone, ref);
    } else {
      gitClone(url, tmpClone);
    }

    const shelf = loadShelfCatalog(tmpClone);
    if (shelf) {
      console.log(`\nRepository: ${shelf.name || deriveNameFromUrl(url)}`);
      if (shelf.description) console.log(`Description: ${shelf.description}`);
      console.log(`\nUnits (${shelf.units.length}):\n`);
      for (const u of shelf.units) {
        const badge = u.type ? ` [${u.type}]` : '';
        console.log(`  ${u.name}${badge}  (${u.path})`);
        if (u.description) console.log(`    ${u.description}`);
      }
      if (shelf.packs && Object.keys(shelf.packs).length > 0) {
        console.log('\nPacks:\n');
        for (const [pName, p] of Object.entries(shelf.packs)) {
          console.log(`  ${pName}: ${p.units.join(', ')}`);
          if (p.description) console.log(`    ${p.description}`);
        }
      }
      console.log(`\nInstall one:  knowledge-shelf add ${url} --path <unit-path>`);
      console.log(`Install all:  knowledge-shelf add ${url} --all`);
      if (shelf.packs && Object.keys(shelf.packs).length > 0) {
        console.log(`Install pack: knowledge-shelf add ${url} --pack <pack-name>`);
      }
      console.log('');
      return;
    }

    // Fallback: auto-scan manifest.json folders
    const folders = findManifestFolders(tmpClone);
    console.log(`\nRepository: ${deriveNameFromUrl(url)} (no shelf.json; discovered ${folders.length} unit(s))\n`);
    for (const f of folders) {
      const m = loadManifest(f);
      const rel = path.relative(tmpClone, f).replace(/\\/g, '/') || '.';
      console.log(`  ${m?.name || path.basename(f)}  [${m?.type || 'unknown'}]  (path: ${rel})`);
      if (m?.description) console.log(`    ${m.description}`);
    }
    console.log('');
  } catch (e) {
    console.error(`Error: Failed to inspect repository.\n${e instanceof Error ? e.message : e}`);
    process.exit(1);
  } finally {
    removeDirSync(tmpClone);
  }
}

export function cmdIndex(args: string[]): void {
  let targetDir = process.cwd();
  let outputPath = '';
  let repoName = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --output requires a file path.');
        process.exit(1);
      }
      outputPath = args[++i];
    } else if (args[i] === '--name') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --name requires a catalog name.');
        process.exit(1);
      }
      repoName = args[++i];
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'index'.`);
      process.exit(1);
    } else {
      targetDir = path.resolve(expandHome(args[i]));
    }
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.error(`Error: Directory not found: ${targetDir}`);
    process.exit(1);
  }

  const outFile = outputPath ? path.resolve(expandHome(outputPath)) : path.join(targetDir, 'shelf.json');
  const existing = loadShelfCatalog(targetDir);

  const { units: folders } = collectUnitFolders(targetDir);
  const units: ShelfCatalogUnit[] = folders.map((f) => {
    const m = loadManifest(f);
    const rel = path.relative(targetDir, f).replace(/\\/g, '/');
    return {
      name: m?.name || path.basename(f),
      path: rel,
      ...(m?.type ? { type: m.type } : {}),
      ...(m?.version ? { version: m.version } : {}),
      ...(m?.description ? { description: m.description } : {}),
      ...(Array.isArray(m?.tags) && m.tags.length > 0 ? { tags: m.tags } : {}),
    };
  });

  const catalog: ShelfCatalog = {
    $schema: 'https://raw.githubusercontent.com/joutvhu/knowledge-shelf/main/schemas/shelf-v1.schema.json',
    name: repoName || existing?.name || path.basename(targetDir),
    description: existing?.description || 'Shared Knowledge Shelf repository',
    ...(existing?.homepage ? { homepage: existing.homepage } : {}),
    units,
    ...(existing?.packs ? { packs: existing.packs } : {}),
  };

  fs.writeFileSync(outFile, JSON.stringify(catalog, null, 2) + '\n', 'utf-8');
  console.log(`✓ Generated ${outFile} (${units.length} unit(s))`);
}

export function cmdScaffold(args: string[]): void {
  let name = '';
  let type = 'boilerplate';
  let outputBase = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' || args[i] === '-t') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --type requires one of: boilerplate, template, toolkit, cookbook, repo.');
        process.exit(1);
      }
      type = args[++i];
    } else if (args[i] === '--output' || args[i] === '-o') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --output requires a directory path.');
        process.exit(1);
      }
      outputBase = path.resolve(expandHome(args[++i]));
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'scaffold'.`);
      process.exit(1);
    } else if (!name) {
      name = args[i];
    }
  }

  if (!name) {
    console.error(
      'Error: Name is required.\nUsage: knowledge-shelf scaffold <name> [--type boilerplate|template|toolkit|cookbook|repo] [--output <dir>]'
    );
    process.exit(1);
  }

  const validTypes = new Set(['boilerplate', 'template', 'toolkit', 'cookbook', 'repo']);
  if (!validTypes.has(type)) {
    console.error(`Error: Invalid type '${type}'. Use boilerplate, template, toolkit, cookbook, or repo.`);
    process.exit(1);
  }

  const targetDir = path.join(outputBase, name);
  if (fs.existsSync(targetDir)) {
    console.error(`Error: Target directory already exists: ${targetDir}`);
    process.exit(1);
  }

  const createUnitSkeleton = (unitDir: string, unitName: string, unitType: string) => {
    fs.mkdirSync(path.join(unitDir, 'references'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify(
        {
          $schema: 'https://raw.githubusercontent.com/joutvhu/knowledge-shelf/main/schemas/manifest-v1.schema.json',
          name: unitName,
          version: '1.0.0',
          type: unitType,
          doc: 'overview.md',
          description: `Describe what ${unitName} provides and when AI should use it.`,
          aliases: [unitName],
          tags: [unitType, 'patterns'],
          status: 'active',
          modules: {
            core: {
              description: 'Core files',
              guide: 'references/usage.md',
              files: ['templates/example.txt'],
            },
          },
          references: {
            usage: {
              file: 'references/usage.md',
              description: 'Usage guide and integration notes',
            },
          },
          workflows: {
            setup: {
              description: `Scaffold ${unitName} files into target project`,
            },
          },
          placeholders: {
            TARGET: {
              type: 'path',
              required: true,
              description: 'Absolute path to target project root',
            },
          },
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );

    fs.writeFileSync(
      path.join(unitDir, 'overview.md'),
      `# ${unitName}\n\nConcise overview of when and how to use this unit.\n\n## Quick Start\n\nRun the \`setup\` workflow or inspect \`references/usage.md\`.\n`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'references', 'usage.md'),
      `# Usage Guide\n\nDetailed guidance and examples for ${unitName}.\n`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'templates', 'example.txt'),
      `Generated by ${unitName} in {{TARGET}}\n`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify(
        {
          $schema: 'https://raw.githubusercontent.com/joutvhu/knowledge-shelf/main/schemas/workflow-v1.schema.json',
          name: 'setup',
          description: `Setup ${unitName}`,
          inputs: {
            TARGET: { required: true, type: 'path', description: 'Absolute path to target project root' },
          },
          steps: [
            { action: 'message', text: `Setting up ${unitName} in {{TARGET}}...` },
            {
              action: 'copy',
              source: 'templates/example.txt',
              target: `{{TARGET}}/.knowledge-${unitName}.txt`,
              skip_if_exists: true,
            },
          ],
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
  };

  if (type === 'repo') {
    fs.mkdirSync(path.join(targetDir, '.github', 'workflows'), { recursive: true });
    createUnitSkeleton(path.join(targetDir, 'sample-unit'), 'sample-unit', 'boilerplate');
    fs.writeFileSync(
      path.join(targetDir, 'README.md'),
      `# ${name}\n\nShared Knowledge Shelf repository.\n\n## Install\n\n\`\`\`bash\nnpx knowledge-shelf catalog <repo-url>\nnpx knowledge-shelf add <repo-url> --all\n\`\`\`\n`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(targetDir, '.github', 'workflows', 'validate-knowledge.yml'),
      [
        'name: Validate Knowledge Units',
        'on:',
        '  pull_request:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  validate:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 20',
        '      - run: npx -y knowledge-shelf validate .',
        '',
      ].join('\n'),
      'utf-8'
    );
    cmdIndex([targetDir]);
    console.log(`✓ Scaffolded shareable knowledge repo: ${targetDir}`);
    return;
  }

  createUnitSkeleton(targetDir, name, type);
  console.log(`✓ Scaffolded ${type} unit: ${targetDir}`);
}

export function cmdPublish(knowledgeDir: string, args: string[]): void {
  let unitArg = '';
  let toRepo = '';
  let subPath = '';
  let branchName = '';
  let push = false;
  let force = false;
  let commitMessage = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --to requires a git repository URL or local repo path.');
        process.exit(1);
      }
      toRepo = args[++i];
    } else if (args[i] === '--path') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --path requires a relative destination path in target repo.');
        process.exit(1);
      }
      subPath = args[++i];
    } else if (args[i] === '--branch') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --branch requires a branch name.');
        process.exit(1);
      }
      branchName = args[++i];
    } else if (args[i] === '--message' || args[i] === '-m') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --message requires a commit message.');
        process.exit(1);
      }
      commitMessage = args[++i];
    } else if (args[i] === '--push') {
      push = true;
    } else if (args[i] === '--force' || args[i] === '-f') {
      force = true;
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'publish'.`);
      process.exit(1);
    } else if (!unitArg) {
      unitArg = args[i];
    }
  }

  if (!unitArg || !toRepo) {
    console.error(
      'Error: Unit path/name and --to <git-url> are required.\n' +
        'Usage: knowledge-shelf publish <unit-path-or-name> --to <git-url> [--path <subpath>] [--branch <branch>] [--push] [--force]'
    );
    process.exit(1);
  }

  let unitDir = path.resolve(expandHome(unitArg));
  if (!fs.existsSync(unitDir)) {
    unitDir = resolveSafeUnitDir(knowledgeDir, unitArg);
  }
  if (!fs.existsSync(unitDir) || !fs.statSync(unitDir).isDirectory()) {
    console.error(`Error: Knowledge unit not found: ${unitArg}`);
    process.exit(1);
  }

  const unitName = path.basename(unitDir);
  const { errors, warnings } = validateManifestUnitDir(unitDir, unitName);
  printValidationResults(unitName, errors, warnings);
  if (errors.length > 0) {
    console.error('Error: Fix validation errors before publishing.');
    process.exit(1);
  }

  const hygieneWarnings = checkUnitPublishHygiene(unitDir);
  if (hygieneWarnings.length > 0) {
    for (const w of hygieneWarnings) {
      console.log(`  ⚠ Hygiene warning: ${w}`);
    }
    if (!force) {
      console.error('Error: Hygiene warnings detected. Clean them or pass --force to publish anyway.');
      process.exit(1);
    }
  }

  assertGitAvailable();
  assertSafeGitArg(toRepo, 'target repository');

  const manifest = loadManifest(unitDir);
  const version = manifest?.version || '1.0.0';
  const targetBranch = branchName || `knowledge/${unitName}-${version}`;
  assertSafeGitArg(targetBranch, 'branch name');

  const workClone = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-publish-'));
  fs.rmSync(workClone, { recursive: true, force: true });

  try {
    const cloneRes = spawnSync('git', ['clone', '--', toRepo, workClone], {
      stdio: 'pipe',
      encoding: 'utf-8',
      env: gitEnv(),
    });
    if (cloneRes.status !== 0) {
      throw new Error(cloneRes.stderr || 'git clone failed');
    }

    const checkoutRes = spawnSync('git', ['checkout', '-B', targetBranch], {
      cwd: workClone,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (checkoutRes.status !== 0) {
      throw new Error(checkoutRes.stderr || `git checkout -B ${targetBranch} failed`);
    }

    const destSubpath = subPath || unitName;
    const destInRepo = resolveInsideDir(workClone, destSubpath, true);
    if (!destInRepo) {
      throw new Error(`Invalid destination path '${destSubpath}' inside target repository.`);
    }

    removeDirSync(destInRepo);
    copyDirSync(unitDir, destInRepo);

    // Update shelf.json if it exists at target repo root
    if (fs.existsSync(path.join(workClone, 'shelf.json'))) {
      const existingShelf = loadShelfCatalog(workClone);
      const indexArgs = [workClone];
      if (!existingShelf?.name) {
        indexArgs.push('--name', deriveNameFromUrl(toRepo));
      }
      cmdIndex(indexArgs);
    }

    const addRes = spawnSync('git', ['add', '--all'], { cwd: workClone, stdio: 'pipe', encoding: 'utf-8' });
    if (addRes.status !== 0) throw new Error(addRes.stderr || 'git add failed');

    const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: workClone, encoding: 'utf-8' });
    if (!(statusRes.stdout || '').trim()) {
      console.log('No changes to publish (target repo already matches this unit).');
      return;
    }

    const msg = commitMessage || `chore(knowledge): publish ${unitName} v${version}`;
    const commitRes = spawnSync('git', ['commit', '-m', msg], {
      cwd: workClone,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (commitRes.status !== 0) {
      throw new Error(commitRes.stderr || 'git commit failed');
    }

    if (push) {
      const pushRes = spawnSync('git', ['push', '-u', 'origin', targetBranch], {
        cwd: workClone,
        stdio: 'pipe',
        encoding: 'utf-8',
        env: gitEnv(),
      });
      if (pushRes.status !== 0) {
        throw new Error(pushRes.stderr || 'git push failed');
      }
      console.log(`✓ Published '${unitName}' to ${toRepo} on branch '${targetBranch}'.`);
    } else {
      console.log(`✓ Committed '${unitName}' to temporary clone on branch '${targetBranch}'.`);
      console.log('  Pass --push to push the branch to the remote repository.');
    }
  } catch (e) {
    console.error(`Error: Publish failed.\n${e instanceof Error ? e.message : e}`);
    process.exit(1);
  } finally {
    removeDirSync(workClone);
  }
}
