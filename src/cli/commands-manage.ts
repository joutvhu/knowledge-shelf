/**
 * Core local & inspection CLI commands:
 * init, list, info, search, validate, install, remove, export, import, trust, untrust.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  canonicalizePath,
  expandHome,
  findManifestFolders,
  findMdFiles,
  getDefaultGlobalKnowledgeDir,
  inspectUnitSecurity,
  isReservedPath,
  isSafeUnitSegment,
  loadManifest,
  normalizeListField,
  parseFrontmatter,
  rankDocuments,
  resolveInsideDir,
  scanDocuments,
  stripBom,
  validateManifestUnitDir,
  validateStandaloneMdFile,
  walkUnitFiles,
} from '../core.js';
import {
  collectUnitFolders,
  extractArchiveSafely,
  formatSize,
  removeDirSync,
  replaceDirSync,
  syncManifestName,
} from './git.js';
import {
  RegistryEntry,
  checkUnitNestingConflict,
  computeUnitChecksum,
  getCacheDir,
  getRegistryPath,
  isSameUnitName,
  loadRegistry,
  mutateRegistry,
  normalizeUnitName,
  recordInstalledSource,
  resolveSafeUnitDir,
  saveRegistry,
  tryResolveSafeUnitDir,
  withRegistryLock,
} from './registry.js';

function filterTopLevelManifestFolders(folders: string[]): string[] {
  const resolved = folders.map((f) => path.resolve(f));
  return resolved.filter((f) => !resolved.some((other) => other !== f && f.startsWith(other + path.sep)));
}

function isSamePath(p1: string, p2: string): boolean {
  const resolveCanon = (p: string) => {
    try {
      return fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
    } catch {
      return path.resolve(p);
    }
  };
  const r1 = resolveCanon(p1);
  const r2 = resolveCanon(p2);
  return process.platform === 'win32' ? r1.toLowerCase() === r2.toLowerCase() : r1 === r2;
}

export function rejectUnknownFlags(args: string[], command: string): void {
  const unknown = args.find((a) => a.startsWith('-'));
  if (unknown) {
    console.error(`Error: Unknown option '${unknown}' for '${command}'.`);
    process.exit(1);
  }
}

export function printValidationResults(name: string, errors: string[], warnings: string[]): void {
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

export function printSecurityNotice(unitName: string, unitDir: string): void {
  const sec = inspectUnitSecurity(unitDir);
  if (!sec.hasExecutables) return;
  const parts: string[] = [];
  if (sec.scriptFiles.length > 0) {
    parts.push(`scripts: ${sec.scriptFiles.join(', ')}`);
  }
  if (sec.runWorkflows.length > 0) {
    parts.push(`workflows with 'run' steps: ${sec.runWorkflows.join(', ')}`);
  }
  console.log(`  ⚠ Security notice: '${unitName}' contains executable code (${parts.join('; ')}).`);
}

export function cmdInit(knowledgeDir: string, args: string[] = []): void {
  rejectUnknownFlags(args, 'init');
  if (args.length > 0) {
    console.error(`Error: Unexpected argument '${args[0]}'.`);
    process.exit(1);
  }
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

export function cmdList(primaryDir: string, knowledgeDirs: string[], args: string[] = []): void {
  rejectUnknownFlags(args, 'list');
  if (args.length > 0) {
    console.error(`Error: Unexpected argument '${args[0]}' for 'list'.`);
    process.exit(1);
  }
  const dirs = knowledgeDirs && knowledgeDirs.length > 0 ? knowledgeDirs : [primaryDir];
  const allSources: Array<{ source: any; layerDir?: string }> = [];
  const trackedNames = new Set<string>();
  const layerSources = new Map<string, any[]>();

  const normTrackKey = (n: string) => {
    const cleaned = normalizeUnitName(n);
    return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
  };

  for (const d of dirs) {
    if (fs.existsSync(d) && fs.existsSync(getRegistryPath(d))) {
      const isSinglePrimary = d === primaryDir && dirs.length === 1;
      try {
        const reg = loadRegistry(d, { exitOnError: isSinglePrimary });
        layerSources.set(d, reg.sources);
        for (const s of reg.sources) {
          const trackKey = normTrackKey(s.name);
          if (!trackedNames.has(trackKey)) {
            trackedNames.add(trackKey);
            allSources.push({ source: s, layerDir: dirs.length > 1 ? d : undefined });
          }
        }
      } catch (e) {
        if (isSinglePrimary) {
          throw e;
        }
        console.warn(
          `  ⚠ Warning: Skipping invalid registry in '${d}': ${e instanceof Error ? e.message : e}`
        );
      }
    }
  }

  const allDocs = scanDocuments(dirs);
  const isDocTrackedInLayer = (docName: string, layer: string): boolean => {
    const sources = layerSources.get(layer) || [];
    const dNameNorm = normTrackKey(docName);
    for (const s of sources) {
      const tNorm = normTrackKey(s.name);
      if (dNameNorm === tNorm || dNameNorm.startsWith(tNorm + '/')) return true;
    }
    return false;
  };

  const unmanaged = allDocs.filter((d) => {
    const layer = d.source_layer || primaryDir;
    return !isDocTrackedInLayer(d.name, layer);
  });

  if (allSources.length === 0 && unmanaged.length === 0) {
    console.log('No knowledge sources installed.');
    console.log(`Knowledge directory: ${primaryDir}`);
    return;
  }

  console.log(
    dirs.length > 1
      ? `Knowledge directories: ${dirs.join(', ')}\n`
      : `Knowledge directory: ${primaryDir}\n`
  );

  if (allSources.length > 0) {
    console.log('Installed sources:\n');
    for (const { source, layerDir } of allSources) {
      const pathInfo = source.path ? ` (path: ${source.path})` : '';
      const branchInfo = source.branch ? ` [${source.branch}]` : '';
      const pinInfo = source.pin ? ` [pinned: ${source.pin}]` : '';
      const trustInfo = source.trusted ? ' [trusted]' : '';
      const layerInfo = layerDir ? ` (${layerDir})` : '';
      console.log(`  ${source.name}${branchInfo}${pinInfo}${trustInfo}${layerInfo}`);
      console.log(`    URL:       ${source.url}${pathInfo}`);
      console.log(`    Commit:    ${source.commit}`);
      console.log(`    Updated:   ${source.updatedAt}`);
      console.log('');
    }
  }

  if (unmanaged.length > 0) {
    console.log('Local / unmanaged units & documents:\n');
    for (const doc of unmanaged) {
      const kind = doc.has_manifest ? doc.type || 'manifest' : 'standalone';
      const layerNote = doc.source_layer ? ` (${doc.source_layer})` : '';
      console.log(`  ${doc.name}  [${kind}]${layerNote}`);
      if (doc.description) {
        console.log(`    ${doc.description.slice(0, 90)}`);
      }
    }
    console.log('');
  }

  console.log(
    `Total: ${allSources.length} tracked source(s), ${unmanaged.length} local/unmanaged unit(s)`
  );
}

export interface CmdRemoveOptions {
  isExplicitDir?: boolean;
}

export function cmdRemove(
  primaryDir: string,
  dirsOrArgs: string[] | string,
  maybeArgs?: string[],
  options: CmdRemoveOptions = {}
): void {
  let knowledgeDirs: string[];
  let args: string[];
  if (Array.isArray(dirsOrArgs) && maybeArgs !== undefined) {
    knowledgeDirs = dirsOrArgs;
    args = maybeArgs;
  } else if (typeof dirsOrArgs === 'string' && maybeArgs !== undefined) {
    knowledgeDirs = [dirsOrArgs];
    args = maybeArgs;
  } else {
    knowledgeDirs = [primaryDir];
    args = Array.isArray(dirsOrArgs) ? dirsOrArgs : [];
  }

  rejectUnknownFlags(args, 'remove');
  let name = (args[0] || '').trim().replace(/[\\/]+$/, '');

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf remove <name>');
    process.exit(1);
  }
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. 'remove' takes exactly one name.`);
    process.exit(1);
  }

  let targetKnowledgeDir = primaryDir;
  let destDir = resolveSafeUnitDir(targetKnowledgeDir, name);
  let registry: { version: '1.0'; sources: RegistryEntry[] };
  try {
    registry = loadRegistry(targetKnowledgeDir, { exitOnError: knowledgeDirs.length <= 1 });
  } catch (e) {
    console.warn(
      `  ⚠ Warning: Skipping invalid registry in '${targetKnowledgeDir}': ${e instanceof Error ? e.message : e}`
    );
    registry = { version: '1.0', sources: [] };
  }
  let idx = registry.sources.findIndex((s) => isSameUnitName(s.name, name));

  if (idx === -1 && !name.toLowerCase().endsWith('.md')) {
    const mdName = `${name}.md`;
    const mdCandidate = resolveSafeUnitDir(targetKnowledgeDir, mdName);
    const mdIdx = registry.sources.findIndex((s) => isSameUnitName(s.name, mdName));
    if (mdIdx !== -1 || fs.existsSync(mdCandidate)) {
      name = mdName;
      destDir = mdCandidate;
      idx = mdIdx;
    }
  }

  const normPrimary = path.resolve(primaryDir);
  const primaryKey = process.platform === 'win32' ? normPrimary.toLowerCase() : normPrimary;
  const isAutoAgentsStaging =
    !options.isExplicitDir &&
    !process.env.KNOWLEDGE_DIR &&
    !process.env.KNOWLEDGE_DIRS &&
    (primaryKey.endsWith(path.sep + '.agents' + path.sep + 'knowledges') ||
      primaryKey.endsWith('/.agents/knowledges'));

  // If not tracked in primaryDir (and either absent on disk in primaryDir, or primaryDir is
  // the auto-discovered .agents/knowledges staging dir where drafts live), check other layers' registries
  // so `remove <name>` uninstalls the installed copy instead of deleting the workspace draft.
  if (idx === -1 && (!fs.existsSync(destDir) || isAutoAgentsStaging) && knowledgeDirs.length > 1) {
    for (const kDir of knowledgeDirs) {
      if (kDir === primaryDir || !fs.existsSync(kDir) || !fs.existsSync(getRegistryPath(kDir))) continue;
      let otherReg;
      try {
        otherReg = loadRegistry(kDir, { exitOnError: false });
      } catch (e) {
        console.warn(
          `  ⚠ Warning: Skipping invalid registry in '${kDir}': ${e instanceof Error ? e.message : e}`
        );
        continue;
      }
      let otherIdx = otherReg.sources.findIndex((s) => isSameUnitName(s.name, name));
      if (otherIdx === -1 && !name.toLowerCase().endsWith('.md')) {
        const mdName = `${name}.md`;
        otherIdx = otherReg.sources.findIndex((s) => isSameUnitName(s.name, mdName));
        if (otherIdx !== -1) {
          name = mdName;
        }
      }
      if (otherIdx !== -1) {
        targetKnowledgeDir = kDir;
        destDir = resolveSafeUnitDir(targetKnowledgeDir, name);
        registry = otherReg;
        idx = otherIdx;
        break;
      }
    }
  }

  if (idx === -1) {
    const canonicalKd = fs.existsSync(targetKnowledgeDir) ? fs.realpathSync(targetKnowledgeDir) : path.resolve(targetKnowledgeDir);
    const topSegment = path.relative(canonicalKd, destDir).split(path.sep)[0];
    if (topSegment.startsWith('.')) {
      console.error(`Error: '${name}' is a reserved path and cannot be removed.`);
      process.exit(1);
    }
    if (fs.existsSync(destDir)) {
      const isDir = fs.statSync(destDir).isDirectory();
      removeDirSync(destDir);
      console.log(`✓ Removed ${isDir ? 'directory' : 'file'} '${name}' (was not in registry)`);
    } else {
      console.error(`Error: '${name}' not found.`);
      process.exit(1);
    }
    return;
  }

  const matchedName = registry.sources[idx].name;
  removeDirSync(destDir);
  mutateRegistry(targetKnowledgeDir, (reg) => {
    const targetIdx = reg.sources.findIndex((s) => isSameUnitName(s.name, matchedName));
    if (targetIdx !== -1) {
      reg.sources.splice(targetIdx, 1);
    }
  });

  console.log(`✓ Removed '${matchedName}'`);
}

export function cmdInfo(knowledgeDirs: string | string[], args: string[]): void {
  rejectUnknownFlags(args, 'info');
  const rawName = args[0];

  if (!rawName) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf info <name>');
    process.exit(1);
  }
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. 'info' takes exactly one name.`);
    process.exit(1);
  }

  const name = rawName.trim().replace(/[\\/]+$/, '');
  const segments = name.split(/[\\/]+/);
  if (!name || segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    console.error(`Error: Access denied. '${name}' is a reserved internal path.`);
    process.exit(1);
  }

  const dirs = Array.isArray(knowledgeDirs) ? knowledgeDirs : [knowledgeDirs];
  const loadInfoRegistry = () => {
    const isSingleLayer = dirs.length <= 1;
    try {
      return loadRegistry(knowledgeDir, { exitOnError: isSingleLayer });
    } catch (e) {
      if (isSingleLayer) throw e;
      console.warn(
        `  ⚠ Warning: Skipping invalid registry in '${knowledgeDir}': ${e instanceof Error ? e.message : e}`
      );
      return { version: '1.0' as const, sources: [] };
    }
  };
  let unitDir: string | null = null;
  let knowledgeDir = dirs[0];

  for (const kDir of dirs) {
    if (!fs.existsSync(kDir)) continue;
    const directCandidate = resolveInsideDir(kDir, name, true);
    if (directCandidate && fs.existsSync(directCandidate)) {
      if (isReservedPath(kDir, directCandidate)) {
        console.error(`Error: Access denied. '${name}' is a reserved internal path.`);
        process.exit(1);
      }
      unitDir = directCandidate;
      knowledgeDir = kDir;
      break;
    }
    if (!name.toLowerCase().endsWith('.md')) {
      const mdCandidate = resolveInsideDir(kDir, `${name}.md`, true);
      if (mdCandidate && fs.existsSync(mdCandidate)) {
        if (isReservedPath(kDir, mdCandidate)) {
          console.error(`Error: Access denied. '${name}' is a reserved internal path.`);
          process.exit(1);
        }
        unitDir = mdCandidate;
        knowledgeDir = kDir;
        break;
      }
    }
  }

  if (!unitDir) {
    const displayDir = dirs.length > 1 ? dirs.join(', ') : dirs[0];
    console.error(`Error: '${name}' not found in ${displayDir}`);
    process.exit(1);
  }

  const stat = fs.statSync(unitDir);
  if (stat.isFile()) {
    if (!unitDir.toLowerCase().endsWith('.md')) {
      console.error(`Error: '${name}' is not a Markdown document or knowledge unit.`);
      process.exit(1);
    }
    const canonicalKd = fs.existsSync(knowledgeDir) ? fs.realpathSync(knowledgeDir) : path.resolve(knowledgeDir);
    const displayName = path.relative(canonicalKd, unitDir).replace(/\\/g, '/');
    const content = fs.readFileSync(unitDir, 'utf-8');
    const { metadata } = parseFrontmatter(content);
    const registry = loadInfoRegistry();
    const findSource = (targetName: string) => {
      const normTarget = targetName.toLowerCase().replace(/\\/g, '/');
      let found = registry.sources.find((s) => s.name.toLowerCase().replace(/\\/g, '/') === normTarget);
      if (!found && normTarget.includes('/')) {
        const segments = normTarget.split('/');
        for (let i = segments.length - 1; i >= 1; i--) {
          const prefix = segments.slice(0, i).join('/');
          const match = registry.sources.find((s) => s.name.toLowerCase().replace(/\\/g, '/') === prefix);
          if (match) {
            found = match;
            break;
          }
        }
      }
      return found;
    };
    const source = findSource(displayName) || findSource(name);

    console.log(`\n  ${displayName}`);
    console.log(`  ${'─'.repeat(displayName.length + 4)}`);
    console.log('  Type:         standalone (.md)');
    if (metadata.description) {
      console.log(`  Description:  ${metadata.description}`);
    }
    const tags = normalizeListField(metadata, 'tags', 'keywords');
    if (tags.length > 0) {
      console.log(`  Tags:         ${tags.join(', ')}`);
    }
    const aliases = normalizeListField(metadata, 'aliases');
    if (aliases.length > 0) {
      console.log(`  Aliases:      ${aliases.join(', ')}`);
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
  let manifestError: string | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(stripBom(fs.readFileSync(manifestPath, 'utf-8')));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        manifest = parsed;
      } else {
        manifestError = 'manifest.json must be a JSON object';
      }
    } catch (e) {
      manifestError = `invalid manifest.json: ${e instanceof Error ? e.message : e}`;
    }
  }

  let fileCount = 0;
  let totalSize = 0;
  walkUnitFiles(unitDir, (filePath) => {
    fileCount++;
    try {
      totalSize += fs.statSync(filePath).size;
    } catch {
      /* skip */
    }
  });

  const registry = loadInfoRegistry();
  const findSource = (targetName: string) => {
    const normTarget = targetName.toLowerCase().replace(/\\/g, '/');
    let found = registry.sources.find((s) => s.name.toLowerCase().replace(/\\/g, '/') === normTarget);
    if (!found && normTarget.includes('/')) {
      const segments = normTarget.split('/');
      for (let i = segments.length - 1; i >= 1; i--) {
        const prefix = segments.slice(0, i).join('/');
        const match = registry.sources.find((s) => s.name.toLowerCase().replace(/\\/g, '/') === prefix);
        if (match) {
          found = match;
          break;
        }
      }
    }
    return found;
  };
  const source = findSource(name);

  console.log(`\n  ${name}`);
  console.log(`  ${'─'.repeat(name.length + 4)}`);

  if (manifest) {
    console.log(`  Type:         ${manifest.type || 'unknown'}`);
    console.log(`  Version:      ${manifest.version || '—'}`);
    if (manifest.status) {
      console.log(`  Status:       ${manifest.status}`);
    }
    if (manifest.superseded_by) {
      console.log(`  Superseded:   ${manifest.superseded_by}`);
    }
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

    if (Array.isArray(manifest.requires) && manifest.requires.length > 0) {
      console.log(`  Requires:     ${manifest.requires.join(', ')}`);
    }
  } else if (manifestError) {
    console.log(`  Type:         invalid manifest (${manifestError})`);
  } else {
    console.log('  Type:         standalone (no manifest.json)');
  }

  console.log(`  Files:        ${fileCount}`);
  console.log(`  Size:         ${formatSize(totalSize)}`);
  console.log(`  Path:         ${unitDir}`);

  if (source) {
    console.log(`  Source:       ${source.url}${source.path ? ` (path: ${source.path})` : ''}`);
    if (source.branch) {
      console.log(`  Branch:       ${source.branch}`);
    }
    console.log(`  Commit:       ${source.commit}`);
    if (source.pin) {
      console.log(`  Pinned:       ${source.pin}`);
    }
    if (source.trusted === true) {
      console.log('  Trusted:      yes');
    } else if (source.trusted === false) {
      console.log('  Trusted:      no');
    }
    console.log(`  Installed:    ${source.installedAt}`);
    console.log(`  Updated:      ${source.updatedAt}`);
  } else {
    console.log('  Source:       local (not from registry)');
  }

  console.log('');
}

export interface CmdValidateOptions {
  isExplicitDir?: boolean;
}

export function cmdValidate(
  knowledgeDirs: string | string[],
  args: string[],
  options: CmdValidateOptions = {}
): void {
  rejectUnknownFlags(args, 'validate');
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. 'validate' takes at most one target.`);
    process.exit(1);
  }
  const targetArg = args[0] ? args[0].trim().replace(/[\\/]+$/, '') : '';
  const dirs = Array.isArray(knowledgeDirs) ? knowledgeDirs : [knowledgeDirs];

  const installedUnits = dirs.some((d) => fs.existsSync(d))
    ? new Set(scanDocuments(dirs).map((d) => d.name))
    : undefined;

  let knowledgeDir = dirs[0];
  let foundInKnowledgeDir = false;
  if (targetArg) {
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      const targetDir = path.join(d, targetArg);
      const targetMd = targetArg.toLowerCase().endsWith('.md') ? targetDir : `${targetDir}.md`;
      if (fs.existsSync(targetDir) || fs.existsSync(targetMd)) {
        knowledgeDir = d;
        foundInKnowledgeDir = true;
        break;
      }
      const manifests = findManifestFolders(d);
      const hasManifest = manifests.some((mf) => {
        const rel = path.relative(d, mf).replace(/\\/g, '/');
        return isSameUnitName(rel, targetArg) || isSameUnitName(path.basename(mf), targetArg);
      });
      if (hasManifest) {
        knowledgeDir = d;
        foundInKnowledgeDir = true;
        break;
      }
      const mds = findMdFiles(d);
      const tNorm = targetArg.toLowerCase().endsWith('.md') ? targetArg : `${targetArg}.md`;
      const hasMd = mds.some((md) => {
        const rel = path.relative(d, md).replace(/\\/g, '/');
        return isSameUnitName(rel, tNorm) || isSameUnitName(path.basename(md), tNorm);
      });
      if (hasMd) {
        knowledgeDir = d;
        foundInKnowledgeDir = true;
        break;
      }
    }
  }

  if (targetArg) {
    const localCandidate = path.resolve(expandHome(targetArg));
    const isExplicitLocalPath =
      targetArg === '.' ||
      targetArg === '..' ||
      targetArg.startsWith('./') ||
      targetArg.startsWith('.\\') ||
      targetArg.startsWith('../') ||
      targetArg.startsWith('..\\') ||
      targetArg === '~' ||
      targetArg.startsWith('~/') ||
      targetArg.startsWith('~\\') ||
      path.isAbsolute(targetArg);

    if (isExplicitLocalPath && !fs.existsSync(localCandidate)) {
      console.error(`Error: Path not found: ${targetArg}`);
      process.exit(1);
    }

    const hasPathSyntax =
      /[\\/]/.test(targetArg) ||
      targetArg.startsWith('.') ||
      targetArg.toLowerCase().endsWith('.md') ||
      path.isAbsolute(targetArg);

    const preferInstalledOverCwd = Boolean(options.isExplicitDir && foundInKnowledgeDir && !isExplicitLocalPath);

    if (
      !preferInstalledOverCwd &&
      fs.existsSync(localCandidate) &&
      (hasPathSyntax || !foundInKnowledgeDir)
    ) {
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
        const manifestFolders = filterTopLevelManifestFolders(findManifestFolders(localCandidate));
        const allMdFiles = findMdFiles(localCandidate);
        const standaloneMds = allMdFiles.filter((md) => {
          const rmd = path.resolve(md);
          return !manifestFolders.some((mf) => {
            const rmf = path.resolve(mf);
            return rmd === rmf || rmd.startsWith(rmf + path.sep);
          });
        });

        if (manifestFolders.length > 0 || standaloneMds.length > 0) {
          let totalErrors = 0;
          let totalWarnings = 0;
          for (const unitDir of manifestFolders) {
            const rel = path.relative(localCandidate, unitDir).replace(/\\/g, '/');
            const displayUnit = rel || path.basename(unitDir);
            console.log(`Validating '${displayUnit}'...`);
            const { errors, warnings } = validateManifestUnitDir(unitDir, {
              expectedUnitName: path.basename(unitDir),
              installedUnits,
            });
            printValidationResults(displayUnit, errors, warnings);
            totalErrors += errors.length;
            totalWarnings += warnings.length;
          }
          for (const mdFile of standaloneMds) {
            const displayUnit = path.relative(localCandidate, mdFile).replace(/\\/g, '/');
            console.log(`Validating '${displayUnit}'...`);
            const { errors, warnings } = validateStandaloneMdFile(mdFile);
            printValidationResults(displayUnit, errors, warnings);
            totalErrors += errors.length;
            totalWarnings += warnings.length;
          }
          const totalCount = manifestFolders.length + standaloneMds.length;
          console.log(
            `\n${totalCount} unit(s) validated.  ${totalErrors} error(s), ${totalWarnings} warning(s).`
          );
          if (totalErrors > 0) process.exit(1);
          return;
        }

        console.log('No manifest-based units to validate.');
        return;
      }
    }
  }

  let validatedCount = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  if (targetArg) {
    if (!fs.existsSync(knowledgeDir)) {
      console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
      process.exit(1);
    }
    resolveSafeUnitDir(knowledgeDir, targetArg);
    const allManifestFolders = filterTopLevelManifestFolders(findManifestFolders(knowledgeDir));
    const toValidate = allManifestFolders.filter((folder) => {
      const rel = path.relative(knowledgeDir, folder).replace(/\\/g, '/');
      return isSameUnitName(rel, targetArg) || isSameUnitName(path.basename(folder), targetArg);
    });

    if (toValidate.length === 0) {
      const targetDir = path.join(knowledgeDir, targetArg);
      const targetMd = targetArg.toLowerCase().endsWith('.md') ? targetDir : `${targetDir}.md`;
      let foundMd: string | null = null;
      if (fs.existsSync(targetMd) && fs.statSync(targetMd).isFile()) {
        foundMd = targetMd;
      } else {
        const allMds = findMdFiles(knowledgeDir);
        for (const md of allMds) {
          const rel = path.relative(knowledgeDir, md).replace(/\\/g, '/');
          const tNorm = targetArg.toLowerCase().endsWith('.md') ? targetArg : `${targetArg}.md`;
          if (isSameUnitName(rel, tNorm) || isSameUnitName(path.basename(md), tNorm)) {
            foundMd = md;
            break;
          }
        }
      }
      if (foundMd) {
        const canonicalKd = fs.existsSync(knowledgeDir) ? fs.realpathSync(knowledgeDir) : path.resolve(knowledgeDir);
        const display = path.relative(canonicalKd, foundMd).replace(/\\/g, '/');
        console.log(`Validating '${display}'...`);
        const { errors, warnings } = validateStandaloneMdFile(foundMd);
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

    for (const unitDir of toValidate) {
      const displayUnit = path.relative(knowledgeDir, unitDir).replace(/\\/g, '/');
      validatedCount++;
      console.log(`Validating '${displayUnit}'...`);
      const { errors, warnings } = validateManifestUnitDir(unitDir, {
        expectedUnitName: displayUnit,
        installedUnits,
      });
      printValidationResults(displayUnit, errors, warnings);
      totalErrors += errors.length;
      totalWarnings += warnings.length;
    }
  } else {
    const existingDirs = dirs.filter((d) => fs.existsSync(d));
    if (existingDirs.length === 0) {
      console.error(`Error: Knowledge directory not found: ${dirs[0]}`);
      process.exit(1);
    }

    for (const kDir of existingDirs) {
      const manifestFolders = filterTopLevelManifestFolders(
        findManifestFolders(kDir).filter((folder) => path.resolve(folder) !== path.resolve(kDir))
      );
      for (const unitDir of manifestFolders) {
        const displayUnit = path.relative(kDir, unitDir).replace(/\\/g, '/');
        validatedCount++;
        console.log(`Validating '${displayUnit}'...`);
        const { errors, warnings } = validateManifestUnitDir(unitDir, {
          expectedUnitName: displayUnit,
          installedUnits,
        });
        printValidationResults(displayUnit, errors, warnings);
        totalErrors += errors.length;
        totalWarnings += warnings.length;
      }

      const mdFiles = findMdFiles(kDir);
      for (const mdFile of mdFiles) {
        const isInside = manifestFolders.some((mf) => {
          const rmf = path.resolve(mf);
          const rmd = path.resolve(mdFile);
          return rmd === rmf || rmd.startsWith(rmf + path.sep);
        });
        if (isInside) continue;
        const displayDoc = path.relative(kDir, mdFile).replace(/\\/g, '/');
        validatedCount++;
        console.log(`Validating '${displayDoc}'...`);
        const { errors, warnings } = validateStandaloneMdFile(mdFile);
        printValidationResults(displayDoc, errors, warnings);
        totalErrors += errors.length;
        totalWarnings += warnings.length;
      }
    }
  }

  if (validatedCount > 0) {
    console.log(`\n${validatedCount} unit(s) validated.  ${totalErrors} error(s), ${totalWarnings} warning(s).`);
    if (totalErrors > 0) process.exit(1);
  } else {
    console.log('No manifest-based units to validate.');
  }
}

export interface CmdInstallOptions {
  exitOnError?: boolean;
  originArchive?: string;
  extractDir?: string;
  defaultTrusted?: boolean;
  isExplicitDir?: boolean;
}

export function cmdInstall(
  knowledgeDir: string,
  args: string[],
  options: CmdInstallOptions = {}
): void {
  const exitOnError = options.exitOnError !== false;
  const fail = (msg: string): never => {
    if (exitOnError) {
      console.error(msg);
      process.exit(1);
    }
    throw new Error(msg);
  };

  let sourceArg = '';
  let customName = '';
  let force = false;
  let installAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        fail('Error: --name requires an alias argument.');
      }
      customName = args[++i];
    } else if (args[i] === '--force' || args[i] === '-f') {
      force = true;
    } else if (args[i] === '--all') {
      installAll = true;
    } else if (args[i].startsWith('-')) {
      fail(`Error: Unknown option '${args[i]}' for 'install'.`);
    } else if (!sourceArg) {
      sourceArg = args[i];
    } else {
      fail(`Error: Unexpected argument '${args[i]}'.`);
    }
  }

  if (!sourceArg) {
    fail(
      'Error: Source path is required.\nUsage: knowledge-shelf install <path> [--name <alias>] [--force] [--all]'
    );
  }

  const resolvedSource = path.resolve(expandHome(sourceArg));
  if (!fs.existsSync(resolvedSource)) {
    fail(`Error: Source path not found: ${sourceArg}`);
  }

  if (!options.isExplicitDir && !options.originArchive && !process.env.KNOWLEDGE_DIR && !process.env.KNOWLEDGE_DIRS) {
    const normKd = path.resolve(knowledgeDir);
    const normSrc = path.resolve(resolvedSource);
    const kdKey = process.platform === 'win32' ? normKd.toLowerCase() : normKd;
    const srcKey = process.platform === 'win32' ? normSrc.toLowerCase() : normSrc;
    const isAgentsKnowledge =
      kdKey.endsWith(path.sep + '.agents' + path.sep + 'knowledges') ||
      kdKey.endsWith('/.agents/knowledges');
    if (isAgentsKnowledge && (srcKey === kdKey || srcKey.startsWith(kdKey + path.sep))) {
      const fallbackDir = getDefaultGlobalKnowledgeDir();
      if (fallbackDir && fallbackDir.toLowerCase() !== kdKey) {
        knowledgeDir = fallbackDir;
      }
    }
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  const stat = fs.statSync(resolvedSource);

  if (customName) {
    const trimmed = customName.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = trimmed.split('/');
    if (
      !trimmed ||
      path.isAbsolute(trimmed) ||
      /^[A-Za-z]:/.test(trimmed) ||
      segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))
    ) {
      fail(
        `Error: Invalid unit name '${customName}'. Names cannot contain '..', be absolute, or have segments that start with '.'.`
      );
    }
    customName = trimmed;
  }

  const upsertRegistryEntry = (unitName: string, originPath: string, destPath: string) => {
    mutateRegistry(knowledgeDir, (reg) => {
      const now = new Date().toISOString();
      const checksum = computeUnitChecksum(destPath);
      const existingIndex = reg.sources.findIndex((s) => isSameUnitName(s.name, unitName));
      const existing = existingIndex !== -1 ? reg.sources[existingIndex] : undefined;

      let url = `local:${originPath}`;
      let subPath: string | undefined = undefined;
      let isTrusted: boolean | undefined = true;

      if (options.originArchive) {
        url = `archive:${options.originArchive}`;
        if (options.extractDir) {
          const rel = path.relative(options.extractDir, originPath).replace(/\\/g, '/');
          if (rel && rel !== '.' && rel !== unitName) {
            subPath = rel;
          }
        }
        isTrusted = options.defaultTrusted ? true : undefined;
      }

      const entry: RegistryEntry = {
        name: unitName,
        url,
        ...(subPath ? { path: subPath } : {}),
        commit: 'local',
        checksum,
        ...(isTrusted ? { trusted: true } : {}),
        installedAt: existing?.installedAt || now,
        updatedAt: now,
      };
      recordInstalledSource(reg, entry);
    });
  };

  // Case 1: Standalone .md file
  if (stat.isFile()) {
    if (installAll) {
      fail('Error: --all cannot be used when installing a single file.');
    }
    const baseName = customName
      ? customName.toLowerCase().endsWith('.md')
        ? customName
        : `${customName}.md`
      : path.basename(resolvedSource);
    if (path.basename(baseName).toLowerCase() === 'readme.md') {
      fail('Error: Standalone doc cannot be named README.md (ignored by knowledge scanner).');
    }
    console.log(`Validating '${baseName}'...`);
    const { errors, warnings } = validateStandaloneMdFile(resolvedSource);
    printValidationResults(baseName, errors, warnings);
    if (errors.length > 0) {
      fail(`\nError: Validation failed with ${errors.length} error(s). Aborting install.`);
    }

    const destRes = tryResolveSafeUnitDir(knowledgeDir, baseName);
    if (!destRes.path) {
      fail(`Error: ${destRes.error}`);
    }
    const destFile = destRes.path!;
    if (isSamePath(destFile, resolvedSource)) {
      fail(`Error: Source and destination are the same path (${destFile}).`);
    }
    const existingReg = loadRegistry(knowledgeDir, { exitOnError: false });
    const nestingErr = checkUnitNestingConflict(knowledgeDir, baseName, false, existingReg.sources);
    if (nestingErr) {
      fail(`Error: ${nestingErr}`);
    }
    if (fs.existsSync(destFile) && !force) {
      fail(`Error: '${baseName}' already exists in knowledge folder. Use --force to overwrite.`);
    }

    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(resolvedSource, destFile);
    upsertRegistryEntry(baseName, resolvedSource, destFile);
    console.log(`✓ Installed standalone knowledge '${baseName}'`);
    return;
  }

  // Case 2: Directory with --all
  if (installAll) {
    if (customName) {
      fail('Error: --name cannot be combined with --all.');
    }

    const { units: manifestFolders, conflicts } = collectUnitFolders(resolvedSource);
    if (conflicts.length > 0) {
      console.error(`Error: Multiple units share the same folder name: ${conflicts.join('; ')}.`);
      fail('Install each one individually with --name.');
    }
    const hasRootManifest = fs.existsSync(path.join(resolvedSource, 'manifest.json'));
    const allMdFiles = findMdFiles(resolvedSource);
    const standaloneMds = hasRootManifest
      ? []
      : allMdFiles.filter((md) => {
          const rmd = path.resolve(md);
          return !manifestFolders.some((mf) => {
            const rmf = path.resolve(mf);
            return rmd === rmf || rmd.startsWith(rmf + path.sep);
          });
        });

    if (manifestFolders.length === 0 && standaloneMds.length === 0) {
      fail(`Error: No knowledge units or standalone .md files found inside '${sourceArg}'.`);
    }

    let validationFailures = 0;
    for (const unitDir of manifestFolders) {
      let unitName = path.basename(unitDir);
      if (unitDir === resolvedSource) {
        const rootManifest = loadManifest(unitDir);
        if (rootManifest?.name && isSafeUnitSegment(rootManifest.name)) {
          unitName = rootManifest.name;
        }
      }
      console.log(`Validating '${unitName}'...`);
      const { errors, warnings } = validateManifestUnitDir(unitDir, {
        expectedUnitName: unitName,
        allowAnyName: unitDir === resolvedSource,
      });
      printValidationResults(unitName, errors, warnings);
      if (errors.length > 0) validationFailures += errors.length;
    }
    for (const mdFile of standaloneMds) {
      const docName = path.relative(resolvedSource, mdFile).replace(/\\/g, '/');
      console.log(`Validating '${docName}'...`);
      const { errors, warnings } = validateStandaloneMdFile(mdFile);
      printValidationResults(docName, errors, warnings);
      if (errors.length > 0) validationFailures += errors.length;
    }

    if (validationFailures > 0) {
      fail(`\nError: Validation failed with ${validationFailures} error(s). Aborting install.`);
    }

    let installed = 0;
    let skipped = 0;
    const existingRegAll = loadRegistry(knowledgeDir, { exitOnError: false });

    for (const unitDir of manifestFolders) {
      let unitName = path.basename(unitDir);
      if (unitDir === resolvedSource) {
        const rootManifest = loadManifest(unitDir);
        if (rootManifest?.name && isSafeUnitSegment(rootManifest.name)) {
          unitName = rootManifest.name;
        }
      }
      const destRes = tryResolveSafeUnitDir(knowledgeDir, unitName);
      if (!destRes.path) {
        fail(`Error: ${destRes.error}`);
      }
      const destDir = destRes.path!;
      if (isSamePath(destDir, unitDir)) {
        console.log(`  Skipping '${unitName}' (source and destination are the same directory)`);
        skipped++;
        continue;
      }
      const nestingErr = checkUnitNestingConflict(knowledgeDir, unitName, true, existingRegAll.sources);
      if (nestingErr) {
        fail(`Error: ${nestingErr}`);
      }
      if (fs.existsSync(destDir) && !force) {
        console.log(`  Skipping '${unitName}' (already exists; use --force to overwrite)`);
        skipped++;
        continue;
      }
      replaceDirSync(knowledgeDir, unitDir, destDir);
      upsertRegistryEntry(unitName, unitDir, destDir);
      console.log(`  ✓ Installed '${unitName}'`);
      printSecurityNotice(unitName, destDir);
      installed++;
    }

    for (const mdFile of standaloneMds) {
      const docName = path.relative(resolvedSource, mdFile).replace(/\\/g, '/');
      const destRes = tryResolveSafeUnitDir(knowledgeDir, docName);
      if (!destRes.path) {
        fail(`Error: ${destRes.error}`);
      }
      const destFile = destRes.path!;
      if (isSamePath(destFile, mdFile)) {
        console.log(`  Skipping '${docName}' (source and destination are the same path)`);
        skipped++;
        continue;
      }
      const nestingErr = checkUnitNestingConflict(knowledgeDir, docName, false, existingRegAll.sources);
      if (nestingErr) {
        fail(`Error: ${nestingErr}`);
      }
      if (fs.existsSync(destFile) && !force) {
        console.log(`  Skipping '${docName}' (already exists; use --force to overwrite)`);
        skipped++;
        continue;
      }
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(mdFile, destFile);
      upsertRegistryEntry(docName, mdFile, destFile);
      console.log(`  ✓ Installed '${docName}'`);
      installed++;
    }

    console.log(`\nDone. ${installed} installed, ${skipped} skipped.`);
    return;
  }

  // Case 3: Single manifest-based directory
  const manifestPath = path.join(resolvedSource, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail(
      `Error: No manifest.json found in '${sourceArg}'. (If this is a parent folder of multiple units, pass --all)`
    );
  }

  const manifest = loadManifest(resolvedSource);
  const derivedDefault =
    manifest?.name && isSafeUnitSegment(manifest.name)
      ? manifest.name
      : path.basename(resolvedSource);
  const unitName = customName || derivedDefault;
  console.log(`Validating '${unitName}'...`);
  const { errors, warnings } = validateManifestUnitDir(
    resolvedSource,
    { expectedUnitName: unitName, allowAnyName: Boolean(customName) }
  );
  printValidationResults(unitName, errors, warnings);

  if (errors.length > 0) {
    fail(`\nError: Validation failed with ${errors.length} error(s). Aborting install.`);
  }

  const destResSingle = tryResolveSafeUnitDir(knowledgeDir, unitName);
  if (!destResSingle.path) {
    fail(`Error: ${destResSingle.error}`);
  }
  const destDir = destResSingle.path!;
  if (isSamePath(destDir, resolvedSource)) {
    fail(`Error: Source and destination are the same directory (${destDir}).`);
  }

  const existingRegSingle = loadRegistry(knowledgeDir, { exitOnError: false });
  const nestingErrSingle = checkUnitNestingConflict(knowledgeDir, unitName, true, existingRegSingle.sources);
  if (nestingErrSingle) {
    fail(`Error: ${nestingErrSingle}`);
  }

  if (fs.existsSync(destDir) && !force) {
    fail(`Error: '${unitName}' is already installed. Use --force to overwrite.`);
  }

  replaceDirSync(knowledgeDir, resolvedSource, destDir);
  if (customName) {
    syncManifestName(destDir, unitName);
  }

  upsertRegistryEntry(unitName, resolvedSource, destDir);
  console.log(`✓ Installed '${unitName}'`);
  printSecurityNotice(unitName, destDir);
}

export function cmdSearch(knowledgeDirs: string[], args: string[]): void {
  let typeFilter: string | undefined;
  let unitFilter: string | undefined;
  let includeContent: boolean | undefined;
  let maxResults = 10;
  const tagFilters: string[] = [];
  const terms: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' || args[i] === '-t') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --type requires a type filter.');
        process.exit(1);
      }
      typeFilter = args[++i];
    } else if (args[i] === '--tag' || args[i] === '--tags') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --tag requires a tag argument.');
        process.exit(1);
      }
      const rawTag = args[++i];
      tagFilters.push(...rawTag.split(',').map((t) => t.trim()).filter(Boolean));
    } else if (args[i] === '--unit' || args[i] === '-u') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --unit requires a unit name.');
        process.exit(1);
      }
      unitFilter = args[++i];
    } else if (args[i] === '--content' || args[i] === '--include-content') {
      includeContent = true;
    } else if (args[i] === '--max' || args[i] === '-m') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --max requires a number.');
        process.exit(1);
      }
      const rawNum = args[++i];
      if (!/^\d+$/.test(rawNum)) {
        console.error('Error: --max requires a positive integer.');
        process.exit(1);
      }
      const num = parseInt(rawNum, 10);
      if (num <= 0) {
        console.error('Error: --max requires a positive integer.');
        process.exit(1);
      }
      maxResults = num;
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'search'.`);
      process.exit(1);
    } else {
      terms.push(args[i]);
    }
  }

  const query = terms.join(' ').trim();
  if (!query && !typeFilter && !unitFilter && tagFilters.length === 0) {
    console.error('Error: Query is required.\nUsage: knowledge-shelf search <keywords> [--type <type>] [--tag <tag>] [--unit <unit>] [--content] [--max <n>]');
    process.exit(1);
  }

  const docs = scanDocuments(knowledgeDirs);
  if (docs.length === 0) {
    console.log('No documents found.');
    return;
  }

  const allResults = rankDocuments(docs, query, {
    type: typeFilter,
    unit: unitFilter,
    tags: tagFilters.length > 0 ? tagFilters : undefined,
    includeContent,
  });
  const results = allResults.slice(0, maxResults);
  const displayQuery = query || `(filters: ${[typeFilter ? `type=${typeFilter}` : '', unitFilter ? `unit=${unitFilter}` : '', tagFilters.length > 0 ? `tags=${tagFilters.join(',')}` : ''].filter(Boolean).join(' ')})`;

  if (results.length === 0) {
    console.log(`No results for "${displayQuery}".`);
    return;
  }

  const truncatedNote =
    allResults.length > results.length ? ` [showing top ${results.length} of ${allResults.length}]` : '';
  console.log(`\nResults for "${displayQuery}" (${results.length} found)${truncatedNote}:\n`);
  for (const r of results) {
    const desc = r.description ? `  ${r.description.slice(0, 80)}` : '';
    const kind = r.has_manifest ? r.type || 'manifest' : 'standalone';
    console.log(`  ${r.name}  [${kind}]  (score: ${r.relevance_score})`);
    if (desc) console.log(`  ${desc}`);
    if (r.content_snippets && r.content_snippets.length > 0) {
      for (const snippet of r.content_snippets) {
        console.log(`    > ${snippet}`);
      }
    }
    console.log('');
  }
}

export function cmdExport(
  primaryDir: string,
  dirsOrArgs: string[] | string,
  maybeArgs?: string[]
): void {
  let knowledgeDirs: string[];
  let args: string[];
  if (Array.isArray(dirsOrArgs) && maybeArgs !== undefined) {
    knowledgeDirs = dirsOrArgs;
    args = maybeArgs;
  } else if (typeof dirsOrArgs === 'string' && maybeArgs !== undefined) {
    knowledgeDirs = [dirsOrArgs];
    args = maybeArgs;
  } else {
    knowledgeDirs = [primaryDir];
    args = Array.isArray(dirsOrArgs) ? dirsOrArgs : [];
  }

  let name = '';
  let outputPath = '';
  let format = 'zip';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
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

  name = name.trim().replace(/[\\/]+$/, '');
  const segments = name.split(/[\\/]+/);
  if (!name || segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    console.error(`Error: Access denied. '${name}' is a reserved internal path or starts with '.'.`);
    process.exit(1);
  }

  if (format !== 'zip' && format !== 'tar') {
    console.error(`Error: Unsupported format '${format}'. Use 'zip' or 'tar'.`);
    process.exit(1);
  }

  let targetPath: string | null = null;
  let targetKnowledgeDir: string = primaryDir;

  for (const kDir of knowledgeDirs) {
    if (!fs.existsSync(kDir)) continue;
    const directCandidate = resolveInsideDir(kDir, name, true);
    if (directCandidate && fs.existsSync(directCandidate) && !isReservedPath(kDir, directCandidate)) {
      targetPath = directCandidate;
      targetKnowledgeDir = kDir;
      break;
    }
    if (!name.toLowerCase().endsWith('.md')) {
      const mdCandidate = resolveInsideDir(kDir, `${name}.md`, true);
      if (mdCandidate && fs.existsSync(mdCandidate) && !isReservedPath(kDir, mdCandidate)) {
        targetPath = mdCandidate;
        targetKnowledgeDir = kDir;
        break;
      }
    }
  }

  if (!targetPath) {
    const displayDir = knowledgeDirs.length > 1 ? knowledgeDirs.join(', ') : primaryDir;
    console.error(`Error: '${name}' not found in ${displayDir}`);
    process.exit(1);
  }

  const canonicalKd = fs.existsSync(targetKnowledgeDir) ? fs.realpathSync(targetKnowledgeDir) : path.resolve(targetKnowledgeDir);
  const relName = path.relative(canonicalKd, targetPath).replace(/\\/g, '/');

  if (!outputPath) {
    const ext = format === 'tar' ? '.tar.gz' : '.zip';
    outputPath = path.resolve(process.cwd(), `${path.basename(relName)}${ext}`);
  } else {
    outputPath = path.resolve(expandHome(outputPath));
    const ext = format === 'tar' ? '.tar.gz' : '.zip';
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
      outputPath = path.join(outputPath, `${path.basename(relName)}${ext}`);
    } else if (format === 'zip' && !outputPath.toLowerCase().endsWith('.zip')) {
      outputPath = `${outputPath}.zip`;
    } else if (
      format === 'tar' &&
      !outputPath.toLowerCase().endsWith('.tar.gz') &&
      !outputPath.toLowerCase().endsWith('.tgz')
    ) {
      outputPath = `${outputPath}.tar.gz`;
    }
  }

  if (fs.statSync(targetPath).isDirectory()) {
    const canonTarget = canonicalizePath(targetPath);
    const canonOutput = canonicalizePath(outputPath);
    const relOut = path.relative(canonTarget, canonOutput);
    if (!relOut || (relOut !== '..' && !relOut.startsWith('..' + path.sep) && !path.isAbsolute(relOut))) {
      console.error(
        `Error: Output path '${outputPath}' cannot be inside the exported unit directory '${targetPath}'. Pass --output <path> outside the unit.`
      );
      process.exit(1);
    }
  }

  console.log(`Exporting '${relName}' to ${outputPath}...`);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    let result: ReturnType<typeof spawnSync>;
    if (format === 'tar') {
      result = spawnSync(
        'tar',
        ['--exclude=.git', '--exclude=*/.git', '--exclude=*/.git/*', '-czf', outputPath, '-C', canonicalKd, '--', relName],
        {
          stdio: 'pipe',
          encoding: 'utf-8',
        }
      );
    } else if (process.platform === 'win32') {
      const escapedTarget = targetPath.replace(/'/g, "''");
      const escapedKd = canonicalKd.replace(/'/g, "''");
      const escapedOutputPath = outputPath.replace(/'/g, "''");
      const escapedRelName = relName.replace(/'/g, "''");
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; ` +
            `$zip = [System.IO.Compression.ZipFile]::Open('${escapedOutputPath}', [System.IO.Compression.ZipArchiveMode]::Create); ` +
            `try { ` +
            `  $target = Get-Item -LiteralPath '${escapedTarget}' -Force; ` +
            `  if ($target -is [System.IO.FileInfo]) { ` +
            `    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $target.FullName, '${escapedRelName}') | Out-Null ` +
            `  } else { ` +
            `    $files = Get-ChildItem -LiteralPath '${escapedTarget}' -Recurse -File -Force | Where-Object { $_.FullName -notmatch '[\\\\/]\\.git([\\\\/]|$)' }; ` +
            `    foreach ($f in $files) { ` +
            `      $sub = $f.FullName.Substring('${escapedKd}'.Length).TrimStart('\\', '/').Replace('\\', '/'); ` +
            `      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $sub) | Out-Null ` +
            `    } ` +
            `  } ` +
            `} finally { $zip.Dispose() }`,
        ],
        { stdio: 'pipe', encoding: 'utf-8' }
      );
    } else {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      result = spawnSync(
        'zip',
        ['-r', outputPath, relName, '-x', '*.git/*', '*/.git/*', '*.git', '*/.git'],
        {
          cwd: canonicalKd,
          stdio: 'pipe',
          encoding: 'utf-8',
        }
      );
    }

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(String(result.stderr || 'archive command failed'));

    const stat = fs.statSync(outputPath);
    console.log(`✓ Exported '${relName}' (${formatSize(stat.size)})`);
  } catch (e) {
    console.error(`Error: Failed to create archive.\n${e}`);
    process.exit(1);
  }
}

export function cmdImport(knowledgeDir: string, args: string[]): void {
  let archiveArg = '';
  let customName = '';
  let force = false;
  let importAll = false;
  let trusted = false;

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
      importAll = true;
    } else if (args[i] === '--trust') {
      trusted = true;
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'import'.`);
      process.exit(1);
    } else if (!archiveArg) {
      archiveArg = args[i];
    } else {
      console.error(`Error: Unexpected argument '${args[i]}'.`);
      process.exit(1);
    }
  }

  if (!archiveArg) {
    console.error('Error: Archive path is required.\nUsage: knowledge-shelf import <archive.zip|.tar.gz> [--name <alias>] [--force] [--all]');
    process.exit(1);
  }

  if (importAll && customName) {
    console.error('Error: --name cannot be combined with --all.');
    process.exit(1);
  }

  const archivePath = path.resolve(expandHome(archiveArg));
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    console.error(`Error: Archive not found: ${archiveArg}`);
    process.exit(1);
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  const cacheDir = getCacheDir(knowledgeDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  const extractDir = path.join(cacheDir, `import-${process.pid}-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  let exitCode = 0;
  try {
    extractArchiveSafely(archivePath, extractDir);

    const entries = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
    if (entries.length === 0) {
      throw new Error('Archive is empty.');
    }

    let installSource = extractDir;
    if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0].name)).isDirectory()) {
      installSource = path.join(extractDir, entries[0].name);
    } else if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0].name)).isFile()) {
      installSource = path.join(extractDir, entries[0].name);
    } else if (entries.some((e) => e.name === 'manifest.json')) {
      installSource = extractDir;
      if (!customName) {
        try {
          const m = JSON.parse(stripBom(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf-8')));
          if (m?.name && typeof m.name === 'string' && isSafeUnitSegment(m.name)) {
            customName = m.name;
          }
        } catch {
          /* ignore */
        }
      }
    }

    let hasManifestDirectly = fs.existsSync(path.join(installSource, 'manifest.json'));
    if (!hasManifestDirectly && fs.statSync(installSource).isDirectory()) {
      const allManifests = filterTopLevelManifestFolders(findManifestFolders(installSource));
      const allMds = findMdFiles(installSource).filter(
        (md) =>
          !allManifests.some((mf) => {
            const rmf = path.resolve(mf);
            const rmd = path.resolve(md);
            return rmd === rmf || rmd.startsWith(rmf + path.sep);
          })
      );
      if (allManifests.length === 0 && allMds.length === 1) {
        installSource = allMds[0];
      } else if (allManifests.length === 1 && allMds.length === 0) {
        installSource = allManifests[0];
        hasManifestDirectly = true;
      }
    }

    const isSingleDoc = !hasManifestDirectly && fs.statSync(installSource).isFile();
    const shouldPassAll =
      (importAll && !hasManifestDirectly && !isSingleDoc) ||
      (!hasManifestDirectly &&
        !isSingleDoc &&
        !customName &&
        (findManifestFolders(installSource).length > 0 || findMdFiles(installSource).length > 0));

    const installArgs = [installSource];
    if (customName) installArgs.push('--name', customName);
    if (force) installArgs.push('--force');
    if (shouldPassAll) {
      installArgs.push('--all');
    }

    cmdInstall(knowledgeDir, installArgs, {
      exitOnError: false,
      originArchive: archivePath,
      extractDir,
      defaultTrusted: trusted,
      isExplicitDir: true,
    });

    // Replace transient temp extraction path in registry with archive origin & safe trust state (robust fallback)
    mutateRegistry(knowledgeDir, (registry) => {
      const normExtract = path.resolve(extractDir).toLowerCase();
      for (const entry of registry.sources) {
        if (entry.url.startsWith('local:')) {
          const originPath = entry.url.slice('local:'.length);
          const normOrigin = path.resolve(originPath).toLowerCase();
          if (
            normOrigin === normExtract ||
            normOrigin.startsWith(normExtract + path.sep) ||
            normOrigin.startsWith(normExtract + '/')
          ) {
            const subRel = path.relative(extractDir, originPath).replace(/\\/g, '/');
            entry.url = `archive:${archivePath}`;
            if (subRel && subRel !== '.' && subRel !== entry.name) {
              entry.path = subRel;
            }
            if (!trusted) {
              delete entry.trusted;
            }
          }
        }
      }
    });
  } catch (e) {
    console.error(`Error: Failed to import archive.\n${e instanceof Error ? e.message : e}`);
    exitCode = 1;
  } finally {
    removeDirSync(extractDir);
  }
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

export function cmdTrust(
  primaryDir: string,
  dirsOrArgs: string[] | string,
  arg3: string[] | boolean,
  arg4?: boolean
): void {
  let knowledgeDirs: string[];
  let args: string[];
  let trusted: boolean;

  if (Array.isArray(dirsOrArgs) && Array.isArray(arg3) && typeof arg4 === 'boolean') {
    knowledgeDirs = dirsOrArgs;
    args = arg3;
    trusted = arg4;
  } else {
    knowledgeDirs = [primaryDir];
    args = Array.isArray(dirsOrArgs) ? dirsOrArgs : [];
    trusted = typeof arg3 === 'boolean' ? arg3 : true;
  }

  rejectUnknownFlags(args, trusted ? 'trust' : 'untrust');
  let name = (args[0] || '').trim().replace(/[\\/]+$/, '');
  if (!name) {
    console.error(`Error: Name is required.\nUsage: knowledge-shelf ${trusted ? 'trust' : 'untrust'} <name>`);
    process.exit(1);
  }
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. '${trusted ? 'trust' : 'untrust'}' takes exactly one name.`);
    process.exit(1);
  }

  let targetKnowledgeDir = primaryDir;
  let targetEntryName: string | null = null;
  const isSingleLayer = knowledgeDirs.length <= 1;

  for (const kDir of knowledgeDirs) {
    if (!fs.existsSync(kDir) || !fs.existsSync(getRegistryPath(kDir))) continue;
    try {
      const reg = loadRegistry(kDir, { exitOnError: isSingleLayer });
      let entry = reg.sources.find((s) => isSameUnitName(s.name, name));
      if (!entry && !name.toLowerCase().endsWith('.md')) {
        entry = reg.sources.find((s) => isSameUnitName(s.name, `${name}.md`));
      }
      if (entry) {
        targetKnowledgeDir = kDir;
        targetEntryName = entry.name;
        break;
      }
    } catch (e) {
      if (isSingleLayer) throw e;
      console.warn(
        `  ⚠ Warning: Skipping invalid registry in '${kDir}': ${e instanceof Error ? e.message : e}`
      );
    }
  }

  if (!targetEntryName) {
    console.error(`Error: '${name}' not found in registry.`);
    process.exit(1);
  }

  const matchedName = targetEntryName;
  mutateRegistry(targetKnowledgeDir, (registry) => {
    const entry = registry.sources.find((s) => isSameUnitName(s.name, matchedName));
    if (entry) {
      if (trusted) {
        entry.trusted = true;
      } else if (entry.url?.startsWith('local:')) {
        entry.trusted = false;
      } else {
        delete entry.trusted;
      }
    }
  });

  console.log(
    trusted
      ? `✓ Marked '${matchedName}' as trusted for workflow script execution.`
      : `✓ Removed explicit trust for '${matchedName}'.`
  );
}
