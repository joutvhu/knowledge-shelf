/**
 * Core local & inspection CLI commands:
 * init, list, info, search, validate, install, remove, export, import, trust, untrust.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  expandHome,
  findManifestFolders,
  findMdFiles,
  inspectUnitSecurity,
  isReservedPath,
  isSafeUnitSegment,
  loadManifest,
  normalizeListField,
  parseFrontmatter,
  rankDocuments,
  resolveInsideDir,
  scanDocuments,
  validateManifestUnitDir,
  validateStandaloneMdFile,
  walkUnitFiles,
} from '../core.js';
import {
  assertSafeArchivePaths,
  collectUnitFolders,
  formatSize,
  removeDirSync,
  replaceDirSync,
  syncManifestName,
} from './git.js';
import {
  RegistryEntry,
  computeUnitChecksum,
  getCacheDir,
  getRegistryPath,
  loadRegistry,
  recordInstalledSource,
  resolveSafeUnitDir,
  saveRegistry,
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

  for (const d of dirs) {
    if (fs.existsSync(d) && fs.existsSync(getRegistryPath(d))) {
      const isSinglePrimary = d === primaryDir && dirs.length === 1;
      try {
        const reg = loadRegistry(d, { exitOnError: isSinglePrimary });
        for (const s of reg.sources) {
          if (!trackedNames.has(s.name)) {
            trackedNames.add(s.name);
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
  const unmanaged = allDocs.filter((d) => {
    const dNameNorm = process.platform === 'win32' ? d.name.toLowerCase() : d.name;
    for (const tracked of trackedNames) {
      const tNorm = process.platform === 'win32' ? tracked.toLowerCase() : tracked;
      if (dNameNorm === tNorm) return false;
      if (dNameNorm.startsWith(tNorm + '/')) return false;
    }
    return true;
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

export function cmdRemove(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'remove');
  let name = args[0];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf remove <name>');
    process.exit(1);
  }
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. 'remove' takes exactly one name.`);
    process.exit(1);
  }

  let destDir = resolveSafeUnitDir(knowledgeDir, name);
  const registry = loadRegistry(knowledgeDir);
  let idx = registry.sources.findIndex((s) => s.name === name);

  if (idx === -1 && !name.toLowerCase().endsWith('.md')) {
    const mdName = `${name}.md`;
    const mdCandidate = resolveSafeUnitDir(knowledgeDir, mdName);
    const mdIdx = registry.sources.findIndex((s) => s.name === mdName);
    if (mdIdx !== -1 || fs.existsSync(mdCandidate)) {
      name = mdName;
      destDir = mdCandidate;
      idx = mdIdx;
    }
  }

  if (idx === -1) {
    const canonicalKd = fs.existsSync(knowledgeDir) ? fs.realpathSync(knowledgeDir) : path.resolve(knowledgeDir);
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

  removeDirSync(destDir);
  registry.sources.splice(idx, 1);
  saveRegistry(knowledgeDir, registry);

  console.log(`✓ Removed '${name}'`);
}

export function cmdInfo(knowledgeDirs: string | string[], args: string[]): void {
  rejectUnknownFlags(args, 'info');
  const name = args[0];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf info <name>');
    process.exit(1);
  }
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. 'info' takes exactly one name.`);
    process.exit(1);
  }

  const segments = name.split(/[\\/]+/);
  if (segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    console.error(`Error: Access denied. '${name}' is a reserved internal path.`);
    process.exit(1);
  }

  const dirs = Array.isArray(knowledgeDirs) ? knowledgeDirs : [knowledgeDirs];
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
    const registry = loadRegistry(knowledgeDir);
    const source = registry.sources.find((s) => s.name === displayName || s.name === name);

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
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = null;
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

  const registry = loadRegistry(knowledgeDir);
  const source = registry.sources.find((s) => s.name === name);

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

export function cmdValidate(knowledgeDirs: string | string[], args: string[]): void {
  rejectUnknownFlags(args, 'validate');
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. 'validate' takes at most one target.`);
    process.exit(1);
  }
  const targetArg = args[0];
  const dirs = Array.isArray(knowledgeDirs) ? knowledgeDirs : [knowledgeDirs];

  const installedUnits = dirs.some((d) => fs.existsSync(d))
    ? new Set(scanDocuments(dirs).map((d) => d.name))
    : undefined;

  let knowledgeDir = dirs[0];
  if (targetArg) {
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      const targetDir = path.join(d, targetArg);
      const targetMd = targetArg.toLowerCase().endsWith('.md') ? targetDir : `${targetDir}.md`;
      if (fs.existsSync(targetDir) || fs.existsSync(targetMd)) {
        knowledgeDir = d;
        break;
      }
    }
  }

  if (targetArg) {
    const localCandidate = path.resolve(expandHome(targetArg));
    const hasPathSyntax =
      /[\\/]/.test(targetArg) ||
      targetArg.startsWith('.') ||
      targetArg.toLowerCase().endsWith('.md') ||
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
      return rel === targetArg.replace(/\\/g, '/') || path.basename(folder) === targetArg;
    });

    if (toValidate.length === 0) {
      const targetDir = path.join(knowledgeDir, targetArg);
      const targetMd = targetArg.toLowerCase().endsWith('.md') ? targetDir : `${targetDir}.md`;
      if (fs.existsSync(targetMd) && fs.statSync(targetMd).isFile()) {
        const canonicalKd = fs.existsSync(knowledgeDir) ? fs.realpathSync(knowledgeDir) : path.resolve(knowledgeDir);
        const display = path.relative(canonicalKd, targetMd).replace(/\\/g, '/');
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
      const manifestFolders = filterTopLevelManifestFolders(findManifestFolders(kDir));
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

  fs.mkdirSync(knowledgeDir, { recursive: true });
  const registry = loadRegistry(knowledgeDir);
  const stat = fs.statSync(resolvedSource);

  if (customName) {
    const isMd = customName.toLowerCase().endsWith('.md');
    const checkName = isMd ? customName.slice(0, -3) : customName;
    if (!isSafeUnitSegment(checkName)) {
      fail(
        `Error: Invalid unit name '${customName}'. Names cannot contain slashes or start with '.' (use a flat name like 'my-unit').`
      );
    }
  }

  const upsertRegistryEntry = (unitName: string, originPath: string, destPath: string) => {
    const now = new Date().toISOString();
    const checksum = computeUnitChecksum(destPath);
    const existingIndex = registry.sources.findIndex((s) => s.name === unitName);
    const existing = existingIndex !== -1 ? registry.sources[existingIndex] : undefined;
    const entry: RegistryEntry = {
      name: unitName,
      url: `local:${originPath}`,
      commit: 'local',
      checksum,
      trusted: true,
      installedAt: existing?.installedAt || now,
      updatedAt: now,
    };
    recordInstalledSource(registry, entry);
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

    const destFile = resolveSafeUnitDir(knowledgeDir, baseName);
    if (isSamePath(destFile, resolvedSource)) {
      fail(`Error: Source and destination are the same path (${destFile}).`);
    }
    if (fs.existsSync(destFile) && !force) {
      fail(`Error: '${baseName}' already exists in knowledge folder. Use --force to overwrite.`);
    }

    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(resolvedSource, destFile);
    upsertRegistryEntry(baseName, resolvedSource, destFile);
    saveRegistry(knowledgeDir, registry);
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
    const topLevelMds = fs
      .readdirSync(resolvedSource, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md')
      .map((e) => path.join(resolvedSource, e.name));

    if (manifestFolders.length === 0 && topLevelMds.length === 0) {
      fail(`Error: No knowledge units or standalone .md files found inside '${sourceArg}'.`);
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
      fail(`\nError: Validation failed with ${validationFailures} error(s). Aborting install.`);
    }

    let installed = 0;
    let skipped = 0;

    for (const unitDir of manifestFolders) {
      const unitName = path.basename(unitDir);
      const destDir = resolveSafeUnitDir(knowledgeDir, unitName);
      if (isSamePath(destDir, unitDir)) {
        console.log(`  Skipping '${unitName}' (source and destination are the same directory)`);
        skipped++;
        continue;
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

    for (const mdFile of topLevelMds) {
      const docName = path.basename(mdFile);
      const destFile = resolveSafeUnitDir(knowledgeDir, docName);
      if (isSamePath(destFile, mdFile)) {
        console.log(`  Skipping '${docName}' (source and destination are the same path)`);
        skipped++;
        continue;
      }
      if (fs.existsSync(destFile) && !force) {
        console.log(`  Skipping '${docName}' (already exists; use --force to overwrite)`);
        skipped++;
        continue;
      }
      fs.copyFileSync(mdFile, destFile);
      upsertRegistryEntry(docName, mdFile, destFile);
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

  const destDir = resolveSafeUnitDir(knowledgeDir, unitName);
  if (isSamePath(destDir, resolvedSource)) {
    fail(`Error: Source and destination are the same directory (${destDir}).`);
  }

  if (fs.existsSync(destDir) && !force) {
    fail(`Error: '${unitName}' is already installed. Use --force to overwrite.`);
  }

  replaceDirSync(knowledgeDir, resolvedSource, destDir);
  if (customName) {
    syncManifestName(destDir, unitName);
  }

  upsertRegistryEntry(unitName, resolvedSource, destDir);
  saveRegistry(knowledgeDir, registry);
  console.log(`✓ Installed '${unitName}'`);
  printSecurityNotice(unitName, destDir);
}

export function cmdSearch(knowledgeDirs: string[], args: string[]): void {
  let typeFilter: string | undefined;
  const terms: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' || args[i] === '-t') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error('Error: --type requires a type filter.');
        process.exit(1);
      }
      typeFilter = args[++i];
    } else if (args[i].startsWith('-')) {
      console.error(`Error: Unknown option '${args[i]}' for 'search'.`);
      process.exit(1);
    } else {
      terms.push(args[i]);
    }
  }

  const query = terms.join(' ').trim();
  if (!query && !typeFilter) {
    console.error('Error: Query is required.\nUsage: knowledge-shelf search <keywords> [--type <type>]');
    process.exit(1);
  }

  const docs = scanDocuments(knowledgeDirs);
  if (docs.length === 0) {
    console.log('No documents found.');
    return;
  }

  const results = rankDocuments(docs, query, { type: typeFilter }).slice(0, 10);
  const displayQuery = query || `(type: ${typeFilter})`;

  if (results.length === 0) {
    console.log(`No results for "${displayQuery}".`);
    return;
  }

  console.log(`\nResults for "${displayQuery}" (${results.length} found):\n`);
  for (const r of results) {
    const desc = r.description ? `  ${r.description.slice(0, 80)}` : '';
    const kind = r.has_manifest ? r.type || 'manifest' : 'standalone';
    console.log(`  ${r.name}  [${kind}]  (score: ${r.relevance_score})`);
    if (desc) console.log(`  ${desc}`);
    console.log('');
  }
}

export function cmdExport(knowledgeDir: string, args: string[]): void {
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

  let targetPath = resolveSafeUnitDir(knowledgeDir, name);
  if (!fs.existsSync(targetPath) && !name.toLowerCase().endsWith('.md')) {
    const mdCandidate = resolveSafeUnitDir(knowledgeDir, `${name}.md`);
    if (fs.existsSync(mdCandidate)) targetPath = mdCandidate;
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: '${name}' not found in ${knowledgeDir}`);
    process.exit(1);
  }

  const canonicalKd = fs.existsSync(knowledgeDir) ? fs.realpathSync(knowledgeDir) : path.resolve(knowledgeDir);
  const relName = path.relative(canonicalKd, targetPath).replace(/\\/g, '/');

  if (!outputPath) {
    const ext = format === 'tar' ? '.tar.gz' : '.zip';
    outputPath = path.resolve(process.cwd(), `${path.basename(relName)}${ext}`);
  } else {
    outputPath = path.resolve(expandHome(outputPath));
    if (format === 'zip' && !outputPath.toLowerCase().endsWith('.zip')) {
      outputPath = `${outputPath}.zip`;
    } else if (
      format === 'tar' &&
      !outputPath.toLowerCase().endsWith('.tar.gz') &&
      !outputPath.toLowerCase().endsWith('.tgz')
    ) {
      outputPath = `${outputPath}.tar.gz`;
    }
  }

  console.log(`Exporting '${relName}' to ${outputPath}...`);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    let result: ReturnType<typeof spawnSync>;
    if (format === 'tar') {
      result = spawnSync('tar', ['-czf', outputPath, '-C', knowledgeDir, '--', relName], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } else if (process.platform === 'win32') {
      const escapedTarget = targetPath.replace(/'/g, "''");
      const escapedOutputPath = outputPath.replace(/'/g, "''");
      result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -LiteralPath '${escapedTarget}' -DestinationPath '${escapedOutputPath}' -Force`,
        ],
        { stdio: 'pipe', encoding: 'utf-8' }
      );
    } else {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      result = spawnSync('zip', ['-r', outputPath, '--', relName], {
        cwd: knowledgeDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
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

  assertSafeArchivePaths(archivePath);

  fs.mkdirSync(knowledgeDir, { recursive: true });
  const cacheDir = getCacheDir(knowledgeDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  const extractDir = path.join(cacheDir, `import-${process.pid}-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  let exitCode = 0;
  try {
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
          const m = JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf-8'));
          if (m?.name && typeof m.name === 'string' && isSafeUnitSegment(m.name)) {
            customName = m.name;
          }
        } catch {
          /* ignore */
        }
      }
    }

    const hasManifestDirectly = fs.existsSync(path.join(installSource, 'manifest.json'));
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

    cmdInstall(knowledgeDir, installArgs, { exitOnError: false });

    // Replace transient temp extraction path in registry with archive origin & safe trust state
    const registry = loadRegistry(knowledgeDir);
    const tempPrefix = `local:${extractDir}`;
    let changed = false;
    for (const entry of registry.sources) {
      if (entry.url.startsWith(tempPrefix)) {
        const originPath = entry.url.slice('local:'.length);
        const subRel = path.relative(extractDir, originPath).replace(/\\/g, '/');
        entry.url = `archive:${archivePath}`;
        if (subRel && subRel !== '.' && subRel !== entry.name) {
          entry.path = subRel;
        }
        if (!trusted) {
          delete entry.trusted;
        }
        changed = true;
      }
    }
    if (changed) {
      saveRegistry(knowledgeDir, registry);
    }
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

export function cmdTrust(knowledgeDir: string, args: string[], trusted: boolean): void {
  rejectUnknownFlags(args, trusted ? 'trust' : 'untrust');
  const name = args[0];
  if (!name) {
    console.error(`Error: Name is required.\nUsage: knowledge-shelf ${trusted ? 'trust' : 'untrust'} <name>`);
    process.exit(1);
  }
  if (args.length > 1) {
    console.error(`Error: Unexpected argument '${args[1]}'. '${trusted ? 'trust' : 'untrust'}' takes exactly one name.`);
    process.exit(1);
  }

  const registry = loadRegistry(knowledgeDir);
  const entry = registry.sources.find((s) => s.name === name);
  if (!entry) {
    console.error(`Error: '${name}' not found in registry.`);
    process.exit(1);
  }

  if (trusted) {
    entry.trusted = true;
  } else if (entry.url?.startsWith('local:')) {
    entry.trusted = false;
  } else {
    delete entry.trusted;
  }
  saveRegistry(knowledgeDir, registry);
  console.log(
    trusted
      ? `✓ Marked '${name}' as trusted for workflow script execution.`
      : `✓ Removed explicit trust for '${name}'.`
  );
}
