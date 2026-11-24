/**
 * Git & sharing CLI commands:
 * add, update, pin, unpin, outdated, sync, catalog, index, scaffold, publish.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkFilePublishHygiene,
  checkUnitPublishHygiene,
  expandHome,
  extractTitle,
  findManifestFolders,
  findMdFiles,
  isReservedPath,
  isSafeUnitSegment,
  loadManifest,
  normalizeListField,
  parseFrontmatter,
  resolveInsideDir,
  stripBom,
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
  assertSafeArchivePaths,
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
  gitGetFullCommit,
  gitLsRemote,
  gitResolveRemoteRef,
  isHexRef,
  removeDirSync,
  replaceDirSync,
  shaMatches,
  syncManifestName,
} from './git.js';
import {
  RegistryEntry,
  ShelfCatalog,
  ShelfCatalogUnit,
  TeamSourceEntry,
  computeUnitChecksum,
  getCacheDir,
  hasLocalModifications,
  isSameUnitName,
  loadRegistry,
  loadShelfCatalog,
  loadTeamConfig,
  mutateRegistry,
  recordInstalledSource,
  resolveSafeUnitDir,
  saveRegistry,
  withRegistryLock,
} from './registry.js';

export function validateStaged(
  stagedPath: string,
  isDirectory: boolean
): { ok: boolean; errors: string[] };
export function validateStaged(
  stagedPath: string,
  unitName: string,
  noVerify?: boolean
): boolean;
export function validateStaged(
  stagedPath: string,
  arg2: boolean | string,
  arg3?: boolean
): { ok: boolean; errors: string[] } | boolean {
  if (typeof arg2 === 'string') {
    const unitName = arg2;
    const noVerify = Boolean(arg3);
    if (noVerify) return true;
    const isDir = fs.existsSync(stagedPath) && fs.statSync(stagedPath).isDirectory();
    if (!isDir) {
      const { errors, warnings } = validateStandaloneMdFile(stagedPath);
      printValidationResults(unitName, errors, warnings);
      return errors.length === 0;
    }
    const manifestPath = path.join(stagedPath, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const { errors, warnings } = validateManifestUnitDir(stagedPath, unitName);
      printValidationResults(unitName, errors, warnings);
      return errors.length === 0;
    }
    return true;
  }

  const isDirectory = arg2;
  if (!isDirectory) {
    const result = validateStandaloneMdFile(stagedPath);
    const ok = (result as any).valid ?? (result.errors.length === 0);
    return { ok, errors: result.errors };
  } else {
    const manifestPath = path.join(stagedPath, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      let expectedName: string | undefined = undefined;
      try {
        const m = JSON.parse(stripBom(fs.readFileSync(manifestPath, 'utf-8')));
        if (typeof m.name === 'string') expectedName = m.name;
      } catch {
        // validateManifestUnitDir will catch invalid JSON
      }
      const result = validateManifestUnitDir(stagedPath, expectedName);
      const ok = (result as any).valid ?? (result.errors.length === 0);
      return { ok, errors: result.errors };
    }
    return { ok: true, errors: [] };
  }
}

function validateStagedDirectory(
  stagedDir: string,
  unitName: string,
  noVerify: boolean
): boolean {
  return validateStaged(stagedDir, unitName, noVerify);
}

export interface InstallValidatedOptions {
  incomingSourcePath: string;
  destDir: string;
  isDirectory?: boolean;
  noVerify?: boolean;
  onSuccess?: () => void;
  knowledgeDir?: string;
  unitName?: string;
}

let stageSeq = 0;

export function installValidated(
  knowledgeDir: string,
  srcPath: string,
  destPath: string,
  unitName: string,
  noVerify?: boolean
): boolean;
export function installValidated(options: InstallValidatedOptions): boolean;
export function installValidated(
  firstArg: string | InstallValidatedOptions,
  srcPathArg?: string,
  destPathArg?: string,
  unitNameArg?: string,
  noVerifyArg?: boolean
): boolean {
  let knowledgeDir: string;
  let srcPath: string;
  let destPath: string;
  let unitName: string;
  let isDirectory: boolean;
  let noVerify: boolean;
  let onSuccess: (() => void) | undefined;

  if (typeof firstArg === 'object') {
    srcPath = firstArg.incomingSourcePath;
    destPath = firstArg.destDir;
    isDirectory =
      firstArg.isDirectory !== undefined
        ? firstArg.isDirectory
        : fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory();
    noVerify = Boolean(firstArg.noVerify);
    onSuccess = firstArg.onSuccess;
    knowledgeDir = firstArg.knowledgeDir || path.dirname(destPath);
    unitName = firstArg.unitName || path.basename(destPath);
  } else {
    knowledgeDir = firstArg;
    srcPath = srcPathArg!;
    destPath = destPathArg!;
    unitName = unitNameArg || path.basename(destPath);
    noVerify = Boolean(noVerifyArg);
    isDirectory = fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory();
    onSuccess = undefined;
  }

  const cacheDir = getCacheDir(knowledgeDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  const stageRoot = getCloneTarget(
    knowledgeDir,
    `.vstage-${process.pid}-${Date.now()}-${++stageSeq}`
  );
  removeDirSync(stageRoot);

  try {
    if (!isDirectory) {
      fs.mkdirSync(stageRoot, { recursive: true });
      const staged = path.join(stageRoot, path.basename(destPath));
      fs.copyFileSync(srcPath, staged);

      if (!noVerify) {
        const ok = validateStaged(staged, unitName, false);
        if (!ok) {
          console.error(
            `Error: Validation failed for '${unitName}'; keeping the installed version (use --no-verify to bypass).`
          );
          return false;
        }
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(staged, destPath);
    } else {
      copyDirSync(srcPath, stageRoot);
      syncManifestName(stageRoot, unitName);

      if (!noVerify) {
        const ok = validateStaged(stageRoot, unitName, false);
        if (!ok) {
          console.error(
            `Error: Validation failed for '${unitName}'; keeping the installed version (use --no-verify to bypass).`
          );
          return false;
        }
      }

      replaceDirSync(knowledgeDir, stageRoot, destPath);
    }

    if (onSuccess) {
      onSuccess();
    }
    return true;
  } finally {
    removeDirSync(stageRoot);
  }
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
      subPath = args[++i].replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
  const cloneTarget = getCloneTarget(
    knowledgeDir,
    `${repoName}-${process.pid}-${Date.now()}-${++stageSeq}`
  );
  const isRootSubPath = subPath === '.' || subPath === './';

  console.log(`Cloning ${url}${ref ? ` (ref: ${ref})` : ''}...`);
  removeDirSync(cloneTarget);

  try {
    if (ref) {
      gitCloneAtRef(url, cloneTarget, ref);
    } else if (subPath && !isRootSubPath && !addAll && !packName) {
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
  const fullCommit = gitGetFullCommit(cloneTarget);
  const branch = gitGetBranch(cloneTarget);
  const pinVal = pinAfter
    ? (ref && ref !== branch ? ref : commit)
    : (ref && !branch ? ref : undefined);

  const registry = loadRegistry(knowledgeDir);
  const installedEntries: RegistryEntry[] = [];
  const installUnitFromSource = (
      unitName: string,
      sourceDir: string,
      sourceSubPath: string | undefined,
      syncName: boolean
    ): 'installed' | 'skipped' | 'invalid' => {
      const isFile = fs.statSync(sourceDir).isFile();
      const destDir = resolveSafeUnitDir(knowledgeDir, unitName);
      const existing = registry.sources.find((s) => isSameUnitName(s.name, unitName));
      if ((existing || fs.existsSync(destDir)) && !force) {
        return 'skipped';
      }

      if (isFile) {
        if (!noVerify && sourceDir.toLowerCase().endsWith('.md')) {
          const { errors, warnings } = validateStandaloneMdFile(sourceDir);
          printValidationResults(unitName, errors, warnings);
          if (errors.length > 0) {
            console.error(`Error: Validation failed for '${unitName}'. Use --no-verify to bypass.`);
            return 'invalid';
          }
        }
        fs.mkdirSync(path.dirname(destDir), { recursive: true });
        fs.copyFileSync(sourceDir, destDir);
      } else {
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
      }

      const now = new Date().toISOString();
      const checksum = computeUnitChecksum(destDir);
      const entry: RegistryEntry = {
        name: unitName,
        url,
        path: sourceSubPath || undefined,
        ...(branch ? { branch } : {}),
        commit,
        ...(fullCommit ? { fullCommit } : {}),
        ...(pinVal ? { pin: pinVal } : {}),
        checksum,
        ...(trusted ? { trusted: true } : {}),
        installedAt: existing?.installedAt || now,
        updatedAt: now,
      };

      installedEntries.push(entry);
      recordInstalledSource(registry, entry);
      if (!isFile) {
        printSecurityNotice(unitName, destDir);
      }
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
    let installed = 0;
    let skipped = 0;
    let invalid = 0;

    for (const uName of unitNames) {
      const unitMeta = catalog.units.find((u) => u.name === uName);
      const rawRelPath = unitMeta ? (unitMeta.path || '.') : uName;
      const isRootUnit = rawRelPath === '.' || rawRelPath === './';
      const sourceDir = isRootUnit ? cloneTarget : resolveInsideDir(cloneTarget, rawRelPath, true);
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        console.error(`  ✗ Pack unit '${uName}' path '${rawRelPath}' not found.`);
        invalid++;
        continue;
      }
      const status = installUnitFromSource(uName, sourceDir, isRootUnit ? undefined : rawRelPath, true);
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

    if (installedEntries.length > 0) {
      mutateRegistry(knowledgeDir, (reg) => {
        for (const entry of installedEntries) {
          recordInstalledSource(reg, entry);
        }
      });
    }
    removeDirSync(cloneTarget);
    console.log(`\nDone. ${installed} installed, ${skipped} skipped${invalid ? `, ${invalid} failed` : ''}.`);
    if (invalid > 0) process.exit(1);
    return;
  }

  // Monorepo --all mode (installs all manifest units + top-level standalone .md files)
  if (addAll) {
    const isRootSubPath = !subPath || subPath === '.' || subPath === './';
    const baseDir = !isRootSubPath ? resolveInsideDir(cloneTarget, subPath, true) : cloneTarget;
    if (!baseDir || !fs.existsSync(baseDir)) {
      console.error(`Error: Path '${subPath}' not found in repository.`);
      removeDirSync(cloneTarget);
      process.exit(1);
    }
    if (!fs.statSync(baseDir).isDirectory()) {
      console.error(`Error: Path '${subPath}' is not a directory in repository.`);
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

    const hasRootManifest = fs.existsSync(path.join(baseDir, 'manifest.json'));
    const standaloneMds = hasRootManifest
      ? []
      : findMdFiles(baseDir).filter((md) => {
          const rmd = path.resolve(md);
          return !manifestFolders.some((mf) => {
            const rmf = path.resolve(mf);
            return rmd === rmf || rmd.startsWith(rmf + path.sep);
          });
        });

    let installed = 0;
    let skipped = 0;
    let invalid = 0;

    for (const sourceDir of manifestFolders) {
      let unitName = path.basename(sourceDir);
      if (sourceDir === baseDir) {
        const rootManifest = loadManifest(sourceDir);
        if (rootManifest?.name && isSafeUnitSegment(rootManifest.name)) {
          unitName = rootManifest.name;
        } else {
          unitName = repoName;
        }
      }
      const sourcePath = path.relative(cloneTarget, sourceDir).replace(/\\/g, '/') || undefined;
      const status = installUnitFromSource(unitName, sourceDir, sourcePath, false);
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

    for (const mdFile of standaloneMds) {
      const docName = path.relative(baseDir, mdFile).replace(/\\/g, '/');
      const destFile = resolveSafeUnitDir(knowledgeDir, docName);
      const existing = registry.sources.find((s) => isSameUnitName(s.name, docName));
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
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
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
        ...(fullCommit ? { fullCommit } : {}),
        ...(pinVal ? { pin: pinVal } : {}),
        checksum,
        ...(trusted ? { trusted: true } : {}),
        installedAt: existing?.installedAt || now,
        updatedAt: now,
      };
      installedEntries.push(entry);
      recordInstalledSource(registry, entry);
      console.log(`  ✓ Installed '${docName}'`);
      installed++;
    }

    if (installedEntries.length > 0) {
      mutateRegistry(knowledgeDir, (reg) => {
        for (const entry of installedEntries) {
          recordInstalledSource(reg, entry);
        }
      });
    }
    removeDirSync(cloneTarget);
    console.log(`\nDone. ${installed} installed, ${skipped} skipped${invalid ? `, ${invalid} failed` : ''}.`);
    if (invalid > 0) process.exit(1);
    return;
  }

  // Single unit or file mode
  const sourceDir = subPath && !isRootSubPath ? resolveInsideDir(cloneTarget, subPath, true) : cloneTarget;
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    console.error(`Error: Path '${subPath}' not found in repository.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  const isFile = fs.statSync(sourceDir).isFile();
  if (isFile) {
    let derivedDefault = path.basename(sourceDir);
    let name = customName || derivedDefault;
    if (sourceDir.toLowerCase().endsWith('.md') && !name.toLowerCase().endsWith('.md')) {
      name = `${name}.md`;
    }
    const destFile = resolveSafeUnitDir(knowledgeDir, name);

    const existing = registry.sources.find((s) => isSameUnitName(s.name, name));
    if (existing && !force) {
      console.error(`Error: '${name}' is already installed.  Use 'update ${name}' or pass --force.`);
      removeDirSync(cloneTarget);
      process.exit(1);
    }
    if (fs.existsSync(destFile) && !force) {
      console.error(`Error: File '${name}' already exists in knowledge folder. Pass --force to overwrite.`);
      removeDirSync(cloneTarget);
      process.exit(1);
    }

    if (!noVerify && sourceDir.toLowerCase().endsWith('.md')) {
      const { errors, warnings } = validateStandaloneMdFile(sourceDir);
      printValidationResults(name, errors, warnings);
      if (errors.length > 0) {
        console.error(`Error: Validation failed for '${name}'. Aborting add (use --no-verify to skip).`);
        removeDirSync(cloneTarget);
        process.exit(1);
      }
    }

    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    try {
      fs.copyFileSync(sourceDir, destFile);
    } catch (e) {
      removeDirSync(cloneTarget);
      throw e;
    }

    const now = new Date().toISOString();
    const checksum = computeUnitChecksum(destFile);
    const entry: RegistryEntry = {
      name,
      url,
      path: (subPath && !isRootSubPath) ? subPath : undefined,
      ...(branch ? { branch } : {}),
      commit,
      ...(fullCommit ? { fullCommit } : {}),
      ...(pinVal ? { pin: pinVal } : {}),
      checksum,
      ...(trusted ? { trusted: true } : {}),
      installedAt: existing?.installedAt || now,
      updatedAt: now,
    };

    recordInstalledSource(registry, entry);
    mutateRegistry(knowledgeDir, (reg) => {
      recordInstalledSource(reg, entry);
    });
    removeDirSync(cloneTarget);
    console.log(`✓ Installed '${name}' (${commit})`);
    return;
  }

  let derivedDefault = subPath && !isRootSubPath ? path.basename(subPath) : repoName;
  if (!customName && (!subPath || isRootSubPath)) {
    const rootManifest = loadManifest(sourceDir);
    if (rootManifest?.name && isSafeUnitSegment(rootManifest.name)) {
      derivedDefault = rootManifest.name;
    }
  }
  const name = customName || derivedDefault;
  const destDir = resolveSafeUnitDir(knowledgeDir, name);

  const existing = registry.sources.find((s) => isSameUnitName(s.name, name));
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
      removeDirSync(stageDir);
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
    path: (subPath && !isRootSubPath) ? subPath : undefined,
    ...(branch ? { branch } : {}),
    commit,
    ...(fullCommit ? { fullCommit } : {}),
    ...(pinVal ? { pin: pinVal } : {}),
    checksum,
    ...(trusted ? { trusted: true } : {}),
    installedAt: existing?.installedAt || now,
    updatedAt: now,
  };

  recordInstalledSource(registry, entry);
  mutateRegistry(knowledgeDir, (reg) => {
    recordInstalledSource(reg, entry);
  });
  removeDirSync(cloneTarget);
  console.log(`✓ Installed '${name}' (${commit})`);
  printSecurityNotice(name, destDir);
}

export function cmdUpdate(knowledgeDir: string, args: string[]): void {
  let targetName = '';
  let force = false;
  let noVerify = false;

  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--no-verify') {
      noVerify = true;
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

  const cleanTargetName = targetName ? targetName.trim().replace(/[\\/]+$/, '') : '';
  const toUpdate = cleanTargetName
    ? registry.sources.filter(
        (s) =>
          isSameUnitName(s.name, cleanTargetName) ||
          (!cleanTargetName.toLowerCase().endsWith('.md') && isSameUnitName(s.name, `${cleanTargetName}.md`))
      )
    : registry.sources;
  if (cleanTargetName && toUpdate.length === 0) {
    console.error(`Error: '${targetName}' not found in registry.`);
    process.exit(1);
  }

  const cacheDir = getCacheDir(knowledgeDir);
  fs.mkdirSync(cacheDir, { recursive: true });

  let updated = 0;
  let failed = 0;
  const updatedEntries: RegistryEntry[] = [];

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
        const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
        if (!force && hasLocalModifications(destDir, source.checksum)) {
          console.log(
            `  ⚠ Skipping '${source.name}' (local modifications detected; pass --force to overwrite)`
          );
          continue;
        }
        const ok = installValidated(knowledgeDir, localPath, destDir, source.name, noVerify);
        if (!ok) {
          failed++;
          continue;
        }
        source.checksum = computeUnitChecksum(destDir);
        source.updatedAt = new Date().toISOString();
        updated++;
        updatedEntries.push(source);
        console.log('  ✓ Updated from local path');
      } catch (e) {
        console.error(`  Error updating '${source.name}': ${e}`);
        failed++;
      }
      continue;
    }

    if (source.url.startsWith('archive:')) {
      const archivePath = source.url.slice('archive:'.length);
      console.log(`Updating '${source.name}' from archive ${archivePath}...`);
      if (!fs.existsSync(archivePath)) {
        console.log(`  Skipping '${source.name}' (archive file no longer exists)`);
        continue;
      }
      const extractDir = path.join(cacheDir, `update-archive-${process.pid}-${Date.now()}`);
      try {
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
          throw new Error('Unsupported archive format.');
        }

        if (res.error || res.status !== 0) {
          throw new Error(String(res.stderr || (res.error ? res.error.message : 'extraction failed')));
        }

        const entries = fs
          .readdirSync(extractDir, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');

        let installSource: string | null = null;
        if (source.path) {
          const cand = resolveInsideDir(extractDir, source.path, true);
          if (cand && fs.existsSync(cand)) {
            installSource = cand;
          }
        }
        if (!installSource) {
          const directMatch = resolveInsideDir(extractDir, source.name, true);
          if (directMatch && fs.existsSync(directMatch)) {
            installSource = directMatch;
          } else if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0].name)).isDirectory()) {
            const wrapperDir = path.join(extractDir, entries[0].name);
            const insideWrapper = resolveInsideDir(wrapperDir, source.name, true);
            if (insideWrapper && fs.existsSync(insideWrapper)) {
              installSource = insideWrapper;
            }
          }
        }
        if (!installSource) {
          // Search any manifest folder whose manifest name or folder name matches source.name
          const allManifests = findManifestFolders(extractDir);
          for (const mf of allManifests) {
            if (path.basename(mf) === source.name) {
              installSource = mf;
              break;
            }
            const m = loadManifest(mf);
            if (m?.name === source.name) {
              installSource = mf;
              break;
            }
          }
        }
        if (!installSource) {
          const allMds = findMdFiles(extractDir);
          for (const md of allMds) {
            if (
              path.basename(md) === source.name ||
              path.relative(extractDir, md).replace(/\\/g, '/') === source.name
            ) {
              installSource = md;
              break;
            }
          }
        }
        if (!installSource) {
          // Single unit archive root
          if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0].name)).isDirectory()) {
            installSource = path.join(extractDir, entries[0].name);
          } else if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0].name)).isFile()) {
            installSource = path.join(extractDir, entries[0].name);
          } else if (entries.some((e) => e.name === 'manifest.json')) {
            installSource = extractDir;
          }
        }

        if (!installSource || !fs.existsSync(installSource)) {
          console.error(`  Error: Unit '${source.name}' not found inside archive.`);
          failed++;
          continue;
        }

        const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
        if (!force && hasLocalModifications(destDir, source.checksum)) {
          console.log(
            `  ⚠ Skipping '${source.name}' (local modifications detected; pass --force to overwrite)`
          );
          continue;
        }
        const ok = installValidated(knowledgeDir, installSource, destDir, source.name, noVerify);
        if (!ok) {
          failed++;
        } else {
          source.checksum = computeUnitChecksum(destDir);
          source.updatedAt = new Date().toISOString();
          updated++;
          updatedEntries.push(source);
          console.log('  ✓ Updated from archive');
        }
      } catch (e) {
        console.error(`  Error updating '${source.name}': ${e instanceof Error ? e.message : e}`);
        failed++;
      } finally {
        removeDirSync(extractDir);
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
    const cloneTarget = getCloneTarget(
      knowledgeDir,
      `${repoName}-${process.pid}-${Date.now()}-${++stageSeq}`
    );

    // Check remote HEAD/branch SHA before cloning when all entries in group exist on disk
    const remoteSha = gitLsRemote(url, branch ? `refs/heads/${branch}` : 'HEAD');
    const pending: RegistryEntry[] = [];
    for (const source of group) {
      const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
      if (
        !force &&
        remoteSha &&
        source.commit &&
        source.commit.length >= 4 &&
        remoteSha.startsWith(source.commit) &&
        fs.existsSync(destDir)
      ) {
        console.log(`Updating '${source.name}'...`);
        if (hasLocalModifications(destDir, source.checksum)) {
          console.log(
            `  ⚠ Skipping '${source.name}' (local modifications detected; pass --force to overwrite)`
          );
        } else {
          console.log(`  Already up to date (${source.commit})`);
        }
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

        if (!force && newCommit === source.commit && fs.existsSync(destDir)) {
          console.log(`  Already up to date (${newCommit})`);
          continue;
        }

        if (!force && hasLocalModifications(destDir, source.checksum)) {
          console.log(
            `  ⚠ Skipping '${source.name}' (local modifications detected; pass --force to overwrite)`
          );
          continue;
        }

        const isRootPath = source.path === '.' || source.path === './';
        const sourceDir = source.path && !isRootPath ? resolveInsideDir(cloneTarget, source.path, true) : cloneTarget;
        if (!sourceDir || !fs.existsSync(sourceDir)) {
          console.error(`  Error: Path '${source.path}' no longer exists in repo.`);
          failed++;
          continue;
        }

        const ok = installValidated(knowledgeDir, sourceDir, destDir, source.name, noVerify);
        if (!ok) {
          failed++;
          continue;
        }

        source.commit = newCommit;
        source.fullCommit = gitGetFullCommit(cloneTarget) || undefined;
        source.checksum = computeUnitChecksum(destDir);
        source.updatedAt = new Date().toISOString();
        updated++;
        updatedEntries.push(source);
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

  if (updatedEntries.length > 0) {
    mutateRegistry(knowledgeDir, (reg) => {
      for (const s of updatedEntries) {
        const existing = reg.sources.find((item) => isSameUnitName(item.name, s.name));
        if (existing) {
          existing.commit = s.commit;
          existing.fullCommit = s.fullCommit;
          existing.checksum = s.checksum;
          existing.updatedAt = s.updatedAt;
        }
      }
    });
  }
  console.log(`\nDone. ${updated} updated, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

export function cmdPin(knowledgeDir: string, args: string[]): void {
  const noVerify = args.includes('--no-verify');
  const cleanArgs = args.filter((a) => a !== '--no-verify');
  rejectUnknownFlags(cleanArgs, 'pin');
  let name = cleanArgs[0] ? cleanArgs[0].trim().replace(/[\\/]+$/, '') : '';
  const version = cleanArgs[1];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf pin <name> [tag|commit]');
    process.exit(1);
  }
  if (cleanArgs.length > 2) {
    console.error(`Error: Unexpected argument '${cleanArgs[2]}'. 'pin' takes at most two arguments.`);
    process.exit(1);
  }

  const registry = loadRegistry(knowledgeDir);
  let source = registry.sources.find((s) => isSameUnitName(s.name, name));
  if (!source && !name.toLowerCase().endsWith('.md')) {
    source = registry.sources.find((s) => isSameUnitName(s.name, `${name}.md`));
  }

  if (!source) {
    console.error(`Error: '${name}' not found in registry.`);
    process.exit(1);
  }
  name = source.name;

  if (version && version !== source.commit) {
    if (source.url.startsWith('local:') || source.url.startsWith('archive:')) {
      const srcType = source.url.startsWith('local:') ? 'local path' : 'archive';
      console.error(
        `Error: '${name}' was installed from a ${srcType} and has no git history; ` +
          `cannot pin it to '${version}'. Run 'pin ${name}' without a version to lock it as-is.`
      );
      process.exit(1);
    }
    fs.mkdirSync(getCacheDir(knowledgeDir), { recursive: true });
    const repoName = deriveNameFromUrl(source.url);
    const cloneTarget = getCloneTarget(
      knowledgeDir,
      `${repoName}-pin-${process.pid}-${Date.now()}-${++stageSeq}`
    );
    let installFailed = false;
    let checkoutError: Error | null = null;

    try {
      removeDirSync(cloneTarget);
      gitCloneAtRef(source.url, cloneTarget, version);

      const isRootPath = source.path === '.' || source.path === './';
      const sourceDir = source.path && !isRootPath ? resolveInsideDir(cloneTarget, source.path, true) : cloneTarget;
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        throw new Error(`Path '${source.path}' not found at ref '${version}'.`);
      }

      const destDir = resolveSafeUnitDir(knowledgeDir, source.name);
      const ok = installValidated(knowledgeDir, sourceDir, destDir, source.name, noVerify);
      if (!ok) {
        installFailed = true;
      } else {
        source.commit = gitGetCommit(cloneTarget);
        source.fullCommit = gitGetFullCommit(cloneTarget) || undefined;
        source.checksum = computeUnitChecksum(destDir);
        source.updatedAt = new Date().toISOString();
      }
    } catch (e) {
      checkoutError = e instanceof Error ? e : new Error(String(e));
    } finally {
      removeDirSync(cloneTarget);
    }

    if (checkoutError) {
      console.error(`Error: Failed to checkout '${version}' for '${name}': ${checkoutError.message}`);
      process.exit(1);
    }

    if (installFailed) {
      process.exit(1);
    }
  }

  mutateRegistry(knowledgeDir, (reg) => {
    const s = reg.sources.find((item) => isSameUnitName(item.name, name));
    if (s) {
      s.pin = version || s.commit;
      if (source.commit) s.commit = source.commit;
      if (source.fullCommit) s.fullCommit = source.fullCommit;
      if (source.checksum) s.checksum = source.checksum;
      if (source.updatedAt) s.updatedAt = source.updatedAt;
    }
  });
  console.log(`✓ Pinned '${name}' to ${version || source.commit}`);
  console.log(`  This source will be skipped during 'update'.  Use 'unpin ${name}' to unlock.`);
}

export function cmdUnpin(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'unpin');
  let name = args[0] ? args[0].trim().replace(/[\\/]+$/, '') : '';

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf unpin <name>');
    process.exit(1);
  }
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. 'unpin' takes exactly one name.`);
    process.exit(1);
  }

  const registry = loadRegistry(knowledgeDir);
  let source = registry.sources.find((s) => isSameUnitName(s.name, name));
  if (!source && !name.toLowerCase().endsWith('.md')) {
    source = registry.sources.find((s) => isSameUnitName(s.name, `${name}.md`));
  }

  if (!source) {
    console.error(`Error: '${name}' not found in registry.`);
    process.exit(1);
  }
  name = source.name;

  if (!source.pin) {
    console.log(`'${name}' is not pinned.`);
    return;
  }

  mutateRegistry(knowledgeDir, (reg) => {
    const s = reg.sources.find((item) => isSameUnitName(item.name, name));
    if (s) {
      delete s.pin;
    }
  });
  console.log(`✓ Unpinned '${name}'.  It will be updated normally.`);
}

export function cmdOutdated(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'outdated');
  if (args.length > 0) {
    console.error(`Error: Unexpected argument '${args[0]}' for 'outdated'.`);
    process.exit(1);
  }
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
      hasLocalModifications(destDir, s.checksum) ? ' [modified-locally]' : '';

    if (!exists) {
      console.log(`  ${s.name}: missing on disk`);
      continue;
    }
    if (s.url.startsWith('local:')) {
      console.log(`  ${s.name}: local${drift}`);
      continue;
    }
    if (s.url.startsWith('archive:')) {
      console.log(`  ${s.name}: archive${drift}`);
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
  let noVerify = false;

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
    } else if (args[i] === '--no-verify') {
      noVerify = true;
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'sync'.`);
      process.exit(1);
    } else if (!fileArg) {
      fileArg = args[i];
    } else {
      console.error(`Error: Unexpected argument '${args[i]}' for 'sync'.`);
      process.exit(1);
    }
  }

  if (fileArg) {
    const explicitConfig = path.resolve(expandHome(fileArg));
    if (!fs.existsSync(explicitConfig)) {
      console.error(`Error: Config file not found: ${fileArg}`);
      process.exit(1);
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
      .filter((s) => !s.url.startsWith('local:') && !s.url.startsWith('archive:'))
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
      const regEntry = registry.sources.find((r) => isSameUnitName(r.name, s.name));
      if (!fs.existsSync(destDir) || !regEntry) {
        console.error(`Error (--frozen): '${s.name}' is not installed.`);
        process.exit(1);
      }
      const targetRef = s.pin || s.ref;
      if (targetRef) {
        const matchedOffline =
          regEntry.commit === targetRef ||
          regEntry.pin === targetRef ||
          shaMatches(targetRef, regEntry.commit) ||
          shaMatches(targetRef, regEntry.fullCommit);

        if (!matchedOffline) {
          let matchedRemote = false;
          let couldNotResolve = false;
          if (!isHexRef(targetRef)) {
            const remoteSha = gitResolveRemoteRef(s.url, targetRef);
            if (remoteSha && (shaMatches(remoteSha, regEntry.commit) || shaMatches(remoteSha, regEntry.fullCommit))) {
              matchedRemote = true;
            } else if (!remoteSha) {
              couldNotResolve = true;
            }
          }

          if (!matchedRemote) {
            const extra = couldNotResolve ? ` (could not resolve '${targetRef}' on the remote)` : '';
            console.error(
              `Error (--frozen): '${s.name}' version mismatch (installed: ${regEntry.commit}, expected: ${targetRef})${extra}.`
            );
            process.exit(1);
          }
        }
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
  let skipped = 0;
  const syncedEntries: RegistryEntry[] = [];

  for (const [, group] of groups) {
    const sample = group[0];
    const requestedRef = sample.pin || sample.ref || sample.branch || '';
    const cloneTarget = getCloneTarget(
      knowledgeDir,
      `${deriveNameFromUrl(sample.url)}-sync-${process.pid}-${Date.now()}-${++stageSeq}`
    );

    try {
      removeDirSync(cloneTarget);
      console.log(`Syncing from ${sample.url}${requestedRef ? ` (${requestedRef})` : ''}...`);
      if (requestedRef) {
        gitCloneAtRef(sample.url, cloneTarget, requestedRef);
      } else {
        gitClone(sample.url, cloneTarget);
      }

      const commit = gitGetCommit(cloneTarget);
      const fullCommit = gitGetFullCommit(cloneTarget);
      const branch = gitGetBranch(cloneTarget);

      for (const s of group) {
        const destDir = resolveSafeUnitDir(knowledgeDir, s.name);
        const existing = registry.sources.find((r) => isSameUnitName(r.name, s.name));
        const effectivePin = s.pin || (s.ref && (!branch || s.ref !== branch) ? s.ref : undefined);
        const pinMatches = (effectivePin || undefined) === (existing?.pin || undefined);

        if (
          !force &&
          fs.existsSync(destDir) &&
          existing &&
          existing.commit === commit &&
          pinMatches
        ) {
          console.log(`  ✓ '${s.name}' already at ${commit}`);
          continue;
        }

        if (!force && existing && fs.existsSync(destDir) && hasLocalModifications(destDir, existing.checksum)) {
          console.log(
            `  ⚠ Skipping '${s.name}' (local modifications detected; pass --force to overwrite)`
          );
          skipped++;
          continue;
        }

        const isRootPath = s.path === '.' || s.path === './';
        const sourceDir = s.path && !isRootPath ? resolveInsideDir(cloneTarget, s.path, true) : cloneTarget;
        if (!sourceDir || !fs.existsSync(sourceDir)) {
          console.error(`  Error: Path '${s.path}' not found in repo for '${s.name}'.`);
          failed++;
          continue;
        }

        const ok = installValidated(knowledgeDir, sourceDir, destDir, s.name, noVerify);
        if (!ok) {
          failed++;
          continue;
        }

        const now = new Date().toISOString();
        const checksum = computeUnitChecksum(destDir);
        const updatedEntry: RegistryEntry = {
          name: s.name,
          url: s.url,
          path: s.path,
          ...(branch ? { branch } : {}),
          commit,
          ...(fullCommit ? { fullCommit } : {}),
          ...(effectivePin ? { pin: effectivePin } : {}),
          checksum,
          ...(existing?.trusted ? { trusted: true } : {}),
          installedAt: existing?.installedAt || now,
          updatedAt: now,
        };
        recordInstalledSource(registry, updatedEntry);
        syncedEntries.push(updatedEntry);

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

  if (syncedEntries.length > 0) {
    mutateRegistry(knowledgeDir, (reg) => {
      for (const entry of syncedEntries) {
        recordInstalledSource(reg, entry);
      }
    });
  }
  const skippedStr = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\nDone. ${synced} synced, ${failed} failed${skippedStr}.`);
  if (failed > 0) process.exit(1);
}

export function cmdCatalog(_knowledgeDir: string, args: string[]): void {
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
    } else {
      console.error(`Error: Unexpected argument '${args[i]}' for 'catalog'.`);
      process.exit(1);
    }
  }

  if (!url) {
    console.error('Error: Repository URL is required.\nUsage: knowledge-shelf catalog <url> [--ref <ref>]');
    process.exit(1);
  }

  const rawTmpClone = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-catalog-'));
  const tmpClone = fs.existsSync(rawTmpClone) ? fs.realpathSync(rawTmpClone) : rawTmpClone;
  fs.rmSync(tmpClone, { recursive: true, force: true });

  let exitCode = 0;
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

    // Fallback: auto-scan manifest.json folders & standalone md files
    const { units: folders } = collectUnitFolders(tmpClone);
    const topLevelMds = fs.existsSync(path.join(tmpClone, 'manifest.json'))
      ? []
      : fs
          .readdirSync(tmpClone, { withFileTypes: true })
          .filter(
            (e) =>
              e.isFile() &&
              e.name.toLowerCase().endsWith('.md') &&
              e.name.toLowerCase() !== 'readme.md'
          )
          .map((e) => path.join(tmpClone, e.name));

    const totalCount = folders.length + topLevelMds.length;
    console.log(`\nRepository: ${deriveNameFromUrl(url)} (no shelf.json; discovered ${totalCount} unit(s))\n`);
    for (const f of folders) {
      const m = loadManifest(f);
      const rel = path.relative(tmpClone, f).replace(/\\/g, '/') || '.';
      console.log(`  ${m?.name || path.basename(f)}  [${m?.type || 'unknown'}]  (path: ${rel})`);
      if (m?.description) console.log(`    ${m.description}`);
    }
    for (const md of topLevelMds) {
      const base = path.basename(md);
      console.log(`  ${base}  [standalone]  (path: ${base})`);
    }
    console.log('');
  } catch (e) {
    console.error(`Error: Failed to inspect repository.\n${e instanceof Error ? e.message : e}`);
    exitCode = 1;
  } finally {
    removeDirSync(tmpClone);
  }
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

export function cmdIndex(args: string[]): void {
  let targetDir = process.cwd();
  let targetDirSet = false;
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
    } else if (!targetDirSet) {
      targetDir = path.resolve(expandHome(args[i]));
      targetDirSet = true;
    } else {
      console.error(`Error: Unexpected argument '${args[i]}' for 'index'.`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.error(`Error: Directory not found: ${targetDir}`);
    process.exit(1);
  }

  const outFile = outputPath ? path.resolve(expandHome(outputPath)) : path.join(targetDir, 'shelf.json');
  const existing = loadShelfCatalog(targetDir);

  const { units: folders, conflicts } = collectUnitFolders(targetDir);
  if (conflicts.length > 0) {
    console.warn(`Warning: Multiple units share the same folder name: ${conflicts.join('; ')}.`);
  }
  const units: ShelfCatalogUnit[] = folders.map((f) => {
    const m = loadManifest(f);
    const rel = path.relative(targetDir, f).replace(/\\/g, '/') || '.';
    return {
      name: m?.name || path.basename(f),
      path: rel,
      ...(m?.type ? { type: m.type } : {}),
      ...(m?.version ? { version: m.version } : {}),
      ...(m?.description ? { description: m.description } : {}),
      ...(Array.isArray(m?.tags) && m.tags.length > 0 ? { tags: m.tags } : {}),
    };
  });

  const hasRootManifest = fs.existsSync(path.join(targetDir, 'manifest.json'));
  const standaloneMds = hasRootManifest
    ? []
    : findMdFiles(targetDir).filter((md) => {
        const rmd = path.resolve(md);
        return !folders.some((mf) => {
          const rmf = path.resolve(mf);
          return rmd === rmf || rmd.startsWith(rmf + path.sep);
        });
      });

  for (const mdFile of standaloneMds) {
    const rel = path.relative(targetDir, mdFile).replace(/\\/g, '/');
    let description: string | undefined;
    let tags: string[] | undefined;
    try {
      const content = fs.readFileSync(mdFile, 'utf-8');
      const { metadata } = parseFrontmatter(content);
      if (typeof metadata.description === 'string' && metadata.description.trim()) {
        description = metadata.description.trim();
      }
      const rawTags = normalizeListField(metadata, 'tags', 'keywords');
      if (rawTags.length > 0) tags = rawTags;
    } catch {
      /* ignore read failure */
    }
    units.push({
      name: rel,
      path: rel,
      type: 'standalone',
      ...(description ? { description } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    });
  }

  const catalog: ShelfCatalog = {
    $schema: 'https://raw.githubusercontent.com/joutvhu/knowledge-shelf/main/schemas/shelf-v1.schema.json',
    name: repoName || existing?.name || path.basename(targetDir),
    description: existing?.description || 'Shared Knowledge Shelf repository',
    ...(existing?.homepage ? { homepage: existing.homepage } : {}),
    units,
    ...(existing?.packs ? { packs: existing.packs } : {}),
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
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
    } else {
      console.error(`Error: Unexpected argument '${args[i]}' for 'scaffold'.`);
      process.exit(1);
    }
  }

  if (!name) {
    console.error(
      'Error: Name is required.\nUsage: knowledge-shelf scaffold <name> [--type boilerplate|template|toolkit|cookbook|repo] [--output <dir>]'
    );
    process.exit(1);
  }

  if (!isSafeUnitSegment(name)) {
    console.error(
      `Error: Invalid unit name '${name}'. Names cannot contain slashes or start with '.' (use a flat name like 'my-unit').`
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

export function buildPublishPushArgs(branch: string, isFirstPublish: boolean = true): string[] {
  return isFirstPublish ? ['push', '-u', 'origin', branch] : ['push', 'origin', branch];
}

export function resolvePublishTarget(
  raw: string,
  knowledgeDir: string
): { kind: 'unit' | 'file'; path: string } | null {
  if (!raw) return null;

  // 1. Direct path check (with ~ expanded)
  const expanded = path.resolve(expandHome(raw));
  if (fs.existsSync(expanded)) {
    const stat = fs.statSync(expanded);
    if (stat.isDirectory()) {
      return { kind: 'unit', path: expanded };
    }
    if (stat.isFile()) {
      if (raw.toLowerCase().endsWith('.md')) {
        return { kind: 'file', path: expanded };
      }
      return null;
    }
  }

  // 2. Relative to knowledgeDir: check as-is
  const relInside = resolveInsideDir(knowledgeDir, raw, true);
  if (relInside && fs.existsSync(relInside)) {
    const stat = fs.statSync(relInside);
    if (stat.isDirectory()) {
      return { kind: 'unit', path: relInside };
    }
    if (stat.isFile()) {
      if (raw.toLowerCase().endsWith('.md')) {
        return { kind: 'file', path: relInside };
      }
      return null;
    }
  }

  // 3. If !raw.endsWith('.md'), check knowledgeDir/<raw>.md
  if (!raw.toLowerCase().endsWith('.md')) {
    const mdRelInside = resolveInsideDir(knowledgeDir, `${raw}.md`, true);
    if (mdRelInside && fs.existsSync(mdRelInside)) {
      const stat = fs.statSync(mdRelInside);
      if (stat.isFile()) {
        return { kind: 'file', path: mdRelInside };
      }
    }
  }

  return null;
}

export interface PublishViaCloneOptions {
  toRepo: string;
  targetBranch: string;
  targetRelPath?: string;
  populateClone: (dest: string) => void;
  commitMsg: string;
  push: boolean;
  label?: string;
  updateShelf?: boolean;
}

export function publishViaClone(opts: PublishViaCloneOptions): void {
  const { toRepo, targetBranch, targetRelPath, populateClone, commitMsg, push, label, updateShelf } = opts;
  assertGitAvailable();
  assertSafeGitArg(toRepo, 'target repository');
  assertSafeGitArg(targetBranch, 'branch name');

  const rawWorkClone = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-publish-'));
  const workClone = fs.existsSync(rawWorkClone) ? fs.realpathSync(rawWorkClone) : rawWorkClone;
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

    // Determine whether origin/<targetBranch> exists on the remote
    const showRefRes = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${targetBranch}`], {
      cwd: workClone,
      stdio: 'pipe',
    });
    const branchExistsRemotely = showRefRes.status === 0;
    const isFirstPublish = !branchExistsRemotely;

    if (branchExistsRemotely) {
      const checkoutRes = spawnSync('git', ['checkout', '-B', targetBranch, `refs/remotes/origin/${targetBranch}`], {
        cwd: workClone,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      if (checkoutRes.status !== 0) {
        throw new Error(checkoutRes.stderr || `git checkout -B ${targetBranch} refs/remotes/origin/${targetBranch} failed`);
      }
    } else {
      const checkoutRes = spawnSync('git', ['checkout', '-B', targetBranch], {
        cwd: workClone,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      if (checkoutRes.status !== 0) {
        throw new Error(checkoutRes.stderr || `git checkout -B ${targetBranch} failed`);
      }
    }

    const isRootTarget = !targetRelPath || targetRelPath === '.' || targetRelPath === './';
    const destDir = !isRootTarget
      ? resolveInsideDir(workClone, targetRelPath, true)
      : workClone;
    if (!destDir || isReservedPath(workClone, destDir)) {
      throw new Error(`Invalid destination path '${targetRelPath}' inside target repository.`);
    }

    populateClone(destDir);

    // Update shelf.json if updateShelf is true (or undefined/default) and shelf.json exists at target repo root
    if (updateShelf !== false && fs.existsSync(path.join(workClone, 'shelf.json'))) {
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

    const commitRes = spawnSync('git', ['commit', '-m', commitMsg], {
      cwd: workClone,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (commitRes.status !== 0) {
      throw new Error(commitRes.stderr || 'git commit failed');
    }

    const displayLabel = label || 'unit';
    if (push) {
      const pushArgs = buildPublishPushArgs(targetBranch, isFirstPublish);
      const pushRes = spawnSync('git', pushArgs, {
        cwd: workClone,
        stdio: 'pipe',
        encoding: 'utf-8',
        env: gitEnv(),
      });
      if (pushRes.status !== 0) {
        throw new Error(
          `git push was rejected (publish never force-pushes; --force only overrides hygiene warnings).\n${pushRes.stderr || ''}`
        );
      }
      console.log(`✓ Published '${displayLabel}' to ${toRepo} on branch '${targetBranch}'.`);
    } else {
      console.log(`✓ Committed '${displayLabel}' to temporary clone on branch '${targetBranch}'.`);
      console.log('  Pass --push to push the branch to the remote repository.');
    }
  } finally {
    removeDirSync(workClone);
  }
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
      const rawSub = args[++i];
      const hasTrailing = rawSub.endsWith('/') || rawSub.endsWith('\\');
      subPath = rawSub.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (hasTrailing && subPath) {
        subPath += '/';
      }
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
    } else {
      console.error(`Error: Unexpected argument '${args[i]}' for 'publish'.`);
      process.exit(1);
    }
  }

  if (!unitArg || !toRepo) {
    console.error(
      'Error: Unit path/name and --to <git-url> are required.\n' +
        'Usage: knowledge-shelf publish <unit-path-or-name> --to <git-url> [--path <subpath>] [--branch <branch>] [--push] [--force]'
    );
    process.exit(1);
  }

  const target = resolvePublishTarget(unitArg, knowledgeDir);
  if (!target) {
    const expanded = path.resolve(expandHome(unitArg));
    const relInside = resolveInsideDir(knowledgeDir, unitArg, true);
    if ((fs.existsSync(expanded) && fs.statSync(expanded).isFile()) ||
        (relInside && fs.existsSync(relInside) && fs.statSync(relInside).isFile())) {
      console.error(`Error: '${unitArg}' is neither a knowledge unit directory nor a Markdown (.md) file.`);
      process.exit(1);
    }
    console.error(`Error: Knowledge unit not found: ${unitArg} (expected a unit directory or a standalone .md file)`);
    process.exit(1);
  }

  assertGitAvailable();
  assertSafeGitArg(toRepo, 'target repository');

  if (target.kind === 'file') {
    const filePath = target.path;
    const fileName = path.basename(filePath);
    const { errors, warnings } = validateStandaloneMdFile(filePath);
    printValidationResults(fileName, errors, warnings);
    if (errors.length > 0) {
      console.error('Error: Fix validation errors before publishing.');
      process.exit(1);
    }

    const hygieneWarnings = checkFilePublishHygiene(filePath);
    if (hygieneWarnings.length > 0) {
      for (const w of hygieneWarnings) {
        console.log(`  ⚠ Hygiene warning: ${w}`);
      }
      if (!force) {
        console.error('Error: Hygiene warnings detected. Clean them or pass --force to publish anyway.');
        process.exit(1);
      }
    }

    const baseNameWithoutExt = path.basename(filePath, path.extname(filePath));
    const targetBranch = branchName || `knowledge/${baseNameWithoutExt}`;
    const msg = commitMessage || `chore(knowledge): publish ${fileName}`;

    try {
      publishViaClone({
        toRepo,
        targetBranch,
        targetRelPath: undefined,
        populateClone: (cloneRoot) => {
          let destPathInClone: string;
          const isRootSubpath = subPath === '.' || subPath === './';
          if (subPath && !isRootSubpath) {
            const isDirLike = subPath.endsWith('/') || subPath.endsWith('\\');
            const resolvedPath = resolveInsideDir(cloneRoot, subPath, true);
            if (!resolvedPath) {
              throw new Error(`Invalid destination path '${subPath}' inside target repository.`);
            }
            if (isDirLike || (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory())) {
              destPathInClone = path.join(resolvedPath, fileName);
            } else {
              destPathInClone = resolvedPath;
            }
          } else {
            destPathInClone = path.join(cloneRoot, fileName);
          }

          const safeDest = resolveInsideDir(cloneRoot, path.relative(cloneRoot, destPathInClone), true);
          if (!safeDest || isReservedPath(cloneRoot, safeDest)) {
            throw new Error(`Destination path escapes repository: '${destPathInClone}'`);
          }

          fs.mkdirSync(path.dirname(safeDest), { recursive: true });
          fs.copyFileSync(filePath, safeDest);
        },
        commitMsg: msg,
        push,
        label: fileName,
        updateShelf: false,
      });
    } catch (e) {
      console.error(`Error: Publish failed.\n${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    return;
  }

  const unitDir = target.path;
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

  const manifest = loadManifest(unitDir);
  const version = manifest?.version || '1.0.0';
  const targetBranch = branchName || `knowledge/${unitName}-${version}`;
  const isRootSubpath = subPath === '.' || subPath === './';
  const isContainerDir = Boolean(subPath && subPath.endsWith('/'));
  const cleanSubPath = subPath.replace(/\/+$/, '');
  const destSubpath = isRootSubpath
    ? undefined
    : isContainerDir
      ? (cleanSubPath ? `${cleanSubPath}/${unitName}` : unitName)
      : (cleanSubPath || unitName);
  const msg = commitMessage || `chore(knowledge): publish ${unitName} v${version}`;

  try {
    publishViaClone({
      toRepo,
      targetBranch,
      targetRelPath: destSubpath,
      populateClone: (destInRepo) => {
        if (destSubpath) {
          removeDirSync(destInRepo);
        } else {
          const entries = fs.readdirSync(destInRepo, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'shelf.json') continue;
            const full = path.join(destInRepo, entry.name);
            if (entry.isDirectory()) {
              removeDirSync(full);
            } else {
              fs.unlinkSync(full);
            }
          }
        }
        copyDirSync(unitDir, destInRepo);
        syncManifestName(destInRepo, destSubpath ? path.basename(destInRepo) : unitName);
      },
      commitMsg: msg,
      push,
      label: unitName,
      updateShelf: true,
    });
  } catch (e) {
    console.error(`Error: Publish failed.\n${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
