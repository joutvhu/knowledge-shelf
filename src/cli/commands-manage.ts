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
  normalizeListField,
  parseFrontmatter,
  rankDocuments,
  resolveInsideDir,
  scanDocuments,
  searchScore,
  validateManifestUnitDir,
  validateStandaloneMdFile,
  walkDir,
} from '../core.js';
import {
  collectUnitFolders,
  copyDirSync,
  formatSize,
  removeDirSync,
  replaceDirSync,
  syncManifestName,
} from './git.js';
import {
  computeUnitChecksum,
  getCacheDir,
  loadRegistry,
  resolveSafeUnitDir,
  saveRegistry,
} from './registry.js';

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

export function cmdInit(knowledgeDir: string): void {
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

export function cmdList(primaryDir: string, knowledgeDirs: string[]): void {
  const registry = loadRegistry(primaryDir);
  const trackedNames = new Set(registry.sources.map((s) => s.name));

  const allDocs = scanDocuments(knowledgeDirs);
  const unmanaged = allDocs.filter((d) => !trackedNames.has(d.name));

  if (registry.sources.length === 0 && unmanaged.length === 0) {
    console.log('No knowledge sources installed.');
    console.log(`Knowledge directory: ${primaryDir}`);
    return;
  }

  console.log(
    knowledgeDirs.length > 1
      ? `Knowledge directories: ${knowledgeDirs.join(', ')}\n`
      : `Knowledge directory: ${primaryDir}\n`
  );

  if (registry.sources.length > 0) {
    console.log('Installed sources:\n');
    for (const source of registry.sources) {
      const pathInfo = source.path ? ` (path: ${source.path})` : '';
      const branchInfo = source.branch ? ` [${source.branch}]` : '';
      const pinInfo = source.pin ? ` [pinned: ${source.pin}]` : '';
      const trustInfo = source.trusted ? ' [trusted]' : '';
      console.log(`  ${source.name}${branchInfo}${pinInfo}${trustInfo}`);
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
    `Total: ${registry.sources.length} tracked source(s), ${unmanaged.length} local/unmanaged unit(s)`
  );
}

export function cmdRemove(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'remove');
  const name = args[0];

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf remove <name>');
    process.exit(1);
  }

  const destDir = resolveSafeUnitDir(knowledgeDir, name);
  const registry = loadRegistry(knowledgeDir);
  const idx = registry.sources.findIndex((s) => s.name === name);

  if (idx === -1) {
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

export function cmdInfo(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'info');
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
    if (source.trusted) {
      console.log('  Trusted:      yes');
    }
    console.log(`  Installed:    ${source.installedAt}`);
    console.log(`  Updated:      ${source.updatedAt}`);
  } else {
    console.log('  Source:       local (not from registry)');
  }

  console.log('');
}

export function cmdValidate(knowledgeDir: string, args: string[]): void {
  rejectUnknownFlags(args, 'validate');
  const targetArg = args[0];

  const installedUnits = fs.existsSync(knowledgeDir)
    ? new Set(scanDocuments(knowledgeDir).map((d) => d.name))
    : undefined;

  if (targetArg) {
    const localCandidate = path.resolve(expandHome(targetArg));
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
            const { errors, warnings } = validateManifestUnitDir(unitDir, {
              expectedUnitName: path.basename(unitDir),
              installedUnits,
            });
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
    if (!fs.existsSync(manifestPath)) continue;

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

  if (validatedCount > 0) {
    console.log(`\n${validatedCount} unit(s) validated.  ${totalErrors} error(s), ${totalWarnings} warning(s).`);
    if (totalErrors > 0) process.exit(1);
  } else {
    console.log('No manifest-based units to validate.');
  }
}

export function cmdInstall(knowledgeDir: string, args: string[]): void {
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

  const resolvedSource = path.resolve(expandHome(sourceArg));
  if (!fs.existsSync(resolvedSource)) {
    console.error(`Error: Source path not found: ${sourceArg}`);
    process.exit(1);
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  const registry = loadRegistry(knowledgeDir);
  const stat = fs.statSync(resolvedSource);

  const upsertRegistryEntry = (unitName: string, originPath: string, destPath: string) => {
    const now = new Date().toISOString();
    const checksum = computeUnitChecksum(destPath);
    const existing = registry.sources.find((s) => s.name === unitName);
    if (existing) {
      existing.url = `local:${originPath}`;
      existing.commit = 'local';
      existing.checksum = checksum;
      existing.updatedAt = now;
    } else {
      registry.sources.push({
        name: unitName,
        url: `local:${originPath}`,
        commit: 'local',
        checksum,
        trusted: true,
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
    if (path.basename(baseName).toLowerCase() === 'readme.md') {
      console.error('Error: Standalone doc cannot be named README.md (ignored by knowledge scanner).');
      process.exit(1);
    }
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
    upsertRegistryEntry(baseName, resolvedSource, destFile);
    saveRegistry(knowledgeDir, registry);
    console.log(`✓ Installed standalone knowledge '${baseName}'`);
    return;
  }

  // Case 2: Directory with --all
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
      if (path.resolve(destDir) === path.resolve(unitDir)) {
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
      if (path.resolve(destFile) === path.resolve(mdFile)) {
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
  if (!fs.existsSync(targetPath) && !name.endsWith('.md')) {
    const mdCandidate = resolveSafeUnitDir(knowledgeDir, `${name}.md`);
    if (fs.existsSync(mdCandidate)) targetPath = mdCandidate;
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: '${name}' not found in ${knowledgeDir}`);
    process.exit(1);
  }

  const relName = path.relative(knowledgeDir, targetPath).replace(/\\/g, '/');

  if (!outputPath) {
    const ext = format === 'tar' ? '.tar.gz' : '.zip';
    outputPath = path.resolve(process.cwd(), `${path.basename(relName)}${ext}`);
  } else {
    outputPath = path.resolve(expandHome(outputPath));
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
    console.error('Error: Archive path is required.\nUsage: knowledge-shelf import <archive.zip|.tar.gz> [--name <alias>] [--force]');
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
      console.error('Error: Unsupported archive format. Use .zip, .tar.gz, or .tgz.');
      process.exit(1);
    }

    if (res.error || res.status !== 0) {
      throw new Error(String(res.stderr || (res.error ? res.error.message : 'extraction failed')));
    }

    const entries = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
    if (entries.length === 0) {
      console.error('Error: Archive is empty.');
      process.exit(1);
    }

    let installSource = extractDir;
    if (entries.length === 1) {
      installSource = path.join(extractDir, entries[0].name);
    }

    const installArgs = [installSource];
    if (customName) installArgs.push('--name', customName);
    if (force) installArgs.push('--force');
    if (entries.length > 1 && !fs.existsSync(path.join(extractDir, 'manifest.json'))) {
      installArgs.push('--all');
    }

    cmdInstall(knowledgeDir, installArgs);

    // Replace transient temp extraction path in registry with archive origin & safe trust state
    const registry = loadRegistry(knowledgeDir);
    const tempPrefix = `local:${extractDir}`;
    let changed = false;
    for (const entry of registry.sources) {
      if (entry.url.startsWith(tempPrefix)) {
        entry.url = `archive:${archivePath}`;
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
    process.exit(1);
  } finally {
    removeDirSync(extractDir);
  }
}

export function cmdTrust(knowledgeDir: string, args: string[], trusted: boolean): void {
  rejectUnknownFlags(args, trusted ? 'trust' : 'untrust');
  const name = args[0];
  if (!name) {
    console.error(`Error: Name is required.\nUsage: knowledge-shelf ${trusted ? 'trust' : 'untrust'} <name>`);
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
