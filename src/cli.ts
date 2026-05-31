/**
 * Knowledge Shelf CLI
 *
 * Subcommands:
 *   add <url> [--path <subfolder>] [--name <alias>]   Pull knowledge from a git repo
 *   list                                               List installed knowledge sources
 *   update [name]                                      Update all or specific knowledge
 *   remove <name>                                      Remove installed knowledge
 *   init                                               Initialize a knowledge directory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
// Configuration
// ---------------------------------------------------------------------------

/**
 * Resolve the knowledge directory.  Priority:
 * 1. --dir <path> CLI flag (extracted before calling this)
 * 2. KNOWLEDGE_DIR environment variable
 * 3. Walk up from CWD looking for a "knowledge/" folder with .registry.json
 * 4. ~/.knowledge (global default)
 */
function getKnowledgeDir(cliDir?: string): string {
  // 1. Explicit --dir flag
  if (cliDir) {
    return path.resolve(cliDir);
  }

  // 2. Environment variable
  if (process.env.KNOWLEDGE_DIR) {
    return path.resolve(process.env.KNOWLEDGE_DIR);
  }

  // 3. Walk up from CWD looking for knowledge/.registry.json
  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, 'knowledge');
    if (fs.existsSync(path.join(candidate, '.registry.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  // 4. Global default: ~/.knowledge
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.resolve(home, '.knowledge');
}

function getRegistryPath(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.registry.json');
}

function getCacheDir(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.cache');
}

// ---------------------------------------------------------------------------
// Registry Management
// ---------------------------------------------------------------------------

function loadRegistry(knowledgeDir: string): Registry {
  const registryPath = getRegistryPath(knowledgeDir);
  if (!fs.existsSync(registryPath)) {
    return {version: '1.0', sources: []};
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as Registry;
  } catch {
    return {version: '1.0', sources: []};
  }
}

function saveRegistry(knowledgeDir: string, registry: Registry): void {
  const registryPath = getRegistryPath(knowledgeDir);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Git Helpers
// ---------------------------------------------------------------------------

function gitClone(url: string, targetDir: string): void {
  assertGitAvailable();
  const result = spawnSync('git', ['clone', '--depth', '1', url, targetDir], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git clone failed');
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
  // Try sparse checkout first (faster for large repos)
  const cloneResult = spawnSync(
    'git',
    ['clone', '--depth', '1', '--filter=blob:none', '--sparse', url, targetDir],
    {stdio: 'pipe', encoding: 'utf-8'}
  );
  if (cloneResult.status !== 0) {
    // Fallback to full shallow clone if sparse not supported
    removeDirSync(targetDir);
    gitClone(url, targetDir);
    return;
  }
  const sparseResult = spawnSync('git', ['sparse-checkout', 'set', sparsePath], {
    cwd: targetDir,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (sparseResult.status !== 0) {
    removeDirSync(targetDir);
    gitClone(url, targetDir);
  }
}

let _gitChecked = false;

function assertGitAvailable(): void {
  if (_gitChecked) return;
  const result = spawnSync('git', ['--version'], {stdio: 'pipe', encoding: 'utf-8'});
  if (result.status !== 0) {
    console.error('Error: git is not installed or not in PATH.');
    console.error('Install git from https://git-scm.com/ and try again.');
    process.exit(1);
  }
  _gitChecked = true;
}

function deriveNameFromUrl(url: string): string {
  // https://github.com/user/repo.git → repo
  // git@github.com:user/repo.git → repo
  // ssh://git@host/user/repo.git → repo
  const match = url.match(/[/:]([^/:]+?)(?:\.git)?$/);
  return match ? match[1] : 'unknown';
}

// ---------------------------------------------------------------------------
// Copy Directory (recursive)
// ---------------------------------------------------------------------------

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, {recursive: true});
  const entries = fs.readdirSync(src, {withFileTypes: true});
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === '.git') continue; // skip .git
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirSync(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

function cmdInstallSkill(args: string[]): void {
  const targetParentDir = args[0] || '.';

  const resolvedTargetParent = path.resolve(targetParentDir);
  if (!fs.existsSync(resolvedTargetParent)) {
    console.log(`Target directory '${resolvedTargetParent}' does not exist. Creating it...`);
    fs.mkdirSync(resolvedTargetParent, {recursive: true});
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(knowledgeDir: string): void {
  fs.mkdirSync(knowledgeDir, {recursive: true});
  fs.mkdirSync(getCacheDir(knowledgeDir), {recursive: true});

  const registry = loadRegistry(knowledgeDir);
  saveRegistry(knowledgeDir, registry);

  // Create .gitignore for cache dir
  const cacheGitignore = path.join(knowledgeDir, '.cache', '.gitignore');
  fs.writeFileSync(cacheGitignore, '*\n', 'utf-8');

  // Create .gitignore at knowledge root (ignore cache, keep registry)
  const rootGitignore = path.join(knowledgeDir, '.gitignore');
  if (!fs.existsSync(rootGitignore)) {
    fs.writeFileSync(
      rootGitignore,
      [
        '# Knowledge Shelf',
        '.cache/',
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  console.log(`✓ Initialized knowledge directory: ${knowledgeDir}`);
}

function cmdAdd(knowledgeDir: string, args: string[]): void {
  fs.mkdirSync(knowledgeDir, {recursive: true});
  fs.mkdirSync(getCacheDir(knowledgeDir), {recursive: true});

  // Parse args
  let url = '';
  let subPath = '';
  let customName = '';
  let addAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && i + 1 < args.length) {
      subPath = args[++i];
    } else if (args[i] === '--name' && i + 1 < args.length) {
      customName = args[++i];
    } else if (args[i] === '--all') {
      addAll = true;
    } else if (!url) {
      url = args[i];
    }
  }

  if (!url) {
    console.error('Error: URL is required.\nUsage: knowledge-shelf add <url> [--path <subfolder>] [--name <alias>] [--all]');
    process.exit(1);
  }

  const repoName = deriveNameFromUrl(url);

  // Clone to cache
  const cacheDir = getCacheDir(knowledgeDir);
  const cloneTarget = path.join(cacheDir, repoName);

  console.log(`Cloning ${url}...`);
  removeDirSync(cloneTarget);

  try {
    // Feature 6: Use sparse checkout when --path is specified (faster for large repos)
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

  // --all mode: find all subfolders with manifest.json and install each
  if (addAll) {
    const baseDir = subPath ? path.join(cloneTarget, subPath) : cloneTarget;
    if (!fs.existsSync(baseDir)) {
      console.error(`Error: Path '${subPath}' not found in repository.`);
      removeDirSync(cloneTarget);
      process.exit(1);
    }

    const entries = fs.readdirSync(baseDir, {withFileTypes: true});
    const registry = loadRegistry(knowledgeDir);
    let installed = 0;
    let skipped = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(baseDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      const unitName = entry.name;
      if (registry.sources.find((s) => s.name === unitName)) {
        console.log(`  Skipping '${unitName}' (already installed)`);
        skipped++;
        continue;
      }

      const sourceDir = path.join(baseDir, entry.name);
      const destDir = path.join(knowledgeDir, unitName);
      if (fs.existsSync(destDir)) {
        console.log(`  Skipping '${unitName}' (directory exists)`);
        skipped++;
        continue;
      }

      copyDirSync(sourceDir, destDir);
      const sourcePath = subPath ? `${subPath}/${entry.name}` : entry.name;
      registry.sources.push({
        name: unitName,
        url,
        path: sourcePath,
        commit,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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

  // Check if already installed
  const registry = loadRegistry(knowledgeDir);
  const existing = registry.sources.find((s) => s.name === name);
  if (existing) {
    console.error(`Error: '${name}' is already installed.  Use 'update ${name}' to refresh.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  // Determine source directory
  const sourceDir = subPath ? path.join(cloneTarget, subPath) : cloneTarget;
  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: Path '${subPath}' not found in repository.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  // Copy to knowledge directory
  const destDir = path.join(knowledgeDir, name);
  if (fs.existsSync(destDir)) {
    console.error(`Error: Directory '${name}' already exists in knowledge folder.`);
    removeDirSync(cloneTarget);
    process.exit(1);
  }

  console.log(`Installing to ${name}/...`);
  copyDirSync(sourceDir, destDir);

  // Update registry
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

  // Clean up cache
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
  const targetName = args[0]; // optional — update specific or all

  if (registry.sources.length === 0) {
    console.log('No knowledge sources installed.');
    return;
  }

  const toUpdate = targetName
    ? registry.sources.filter((s) => s.name === targetName)
    : registry.sources;

  if (targetName && toUpdate.length === 0) {
    console.error(`Error: '${targetName}' not found in registry.`);
    process.exit(1);
  }

  const cacheDir = getCacheDir(knowledgeDir);
  fs.mkdirSync(cacheDir, {recursive: true});

  let updated = 0;
  let failed = 0;

  for (const source of toUpdate) {
    // Feature 4: Skip pinned sources
    if (source.pin) {
      console.log(`  Skipping '${source.name}' (pinned to ${source.pin})`);
      continue;
    }

    console.log(`Updating '${source.name}'...`);

    const repoName = deriveNameFromUrl(source.url);
    const cloneTarget = path.join(cacheDir, repoName);

    try {
      // Fresh clone (shallow)
      removeDirSync(cloneTarget);
      gitClone(source.url, cloneTarget);

      const newCommit = gitGetCommit(cloneTarget);

      if (newCommit === source.commit) {
        console.log(`  Already up to date (${newCommit})`);
        removeDirSync(cloneTarget);
        continue;
      }

      // Determine source
      const sourceDir = source.path ? path.join(cloneTarget, source.path) : cloneTarget;
      if (!fs.existsSync(sourceDir)) {
        console.error(`  Error: Path '${source.path}' no longer exists in repo.`);
        failed++;
        removeDirSync(cloneTarget);
        continue;
      }

      // Replace destination
      const destDir = path.join(knowledgeDir, source.name);
      removeDirSync(destDir);
      copyDirSync(sourceDir, destDir);

      // Update registry entry
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

  const registry = loadRegistry(knowledgeDir);
  const idx = registry.sources.findIndex((s) => s.name === name);

  if (idx === -1) {
    // Still try to remove the directory even if not in registry
    const destDir = path.join(knowledgeDir, name);
    if (fs.existsSync(destDir)) {
      removeDirSync(destDir);
      console.log(`✓ Removed directory '${name}' (was not in registry)`);
    } else {
      console.error(`Error: '${name}' not found.`);
      process.exit(1);
    }
    return;
  }

  // Remove directory
  const destDir = path.join(knowledgeDir, name);
  removeDirSync(destDir);

  // Remove from registry
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

  const unitDir = path.join(knowledgeDir, name);
  if (!fs.existsSync(unitDir) || !fs.statSync(unitDir).isDirectory()) {
    console.error(`Error: '${name}' not found in ${knowledgeDir}`);
    process.exit(1);
  }

  // Load manifest if exists
  const manifestPath = path.join(unitDir, 'manifest.json');
  let manifest: Record<string, unknown> | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = null;
    }
  }

  // Count files and calculate size
  let fileCount = 0;
  let totalSize = 0;
  walkDir(unitDir, (filePath) => {
    fileCount++;
    try {
      totalSize += fs.statSync(filePath).size;
    } catch { /* skip */
    }
  });

  // Registry info
  const registry = loadRegistry(knowledgeDir);
  const source = registry.sources.find((s) => s.name === name);

  // Display
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
    console.log(`  Type:         standalone (no manifest.json)`);
  }

  console.log(`  Files:        ${fileCount}`);
  console.log(`  Size:         ${formatSize(totalSize)}`);
  console.log(`  Path:         ${unitDir}`);

  if (source) {
    console.log(`  Source:       ${source.url}${source.path ? ` (path: ${source.path})` : ''}`);
    console.log(`  Commit:       ${source.commit}`);
    console.log(`  Installed:    ${source.installedAt}`);
    console.log(`  Updated:      ${source.updatedAt}`);
  } else {
    console.log(`  Source:       local (not from registry)`);
  }

  console.log('');
}

function cmdValidate(knowledgeDir: string, args: string[]): void {
  const targetName = args[0]; // optional — validate specific or all

  if (!fs.existsSync(knowledgeDir)) {
    console.error(`Error: Knowledge directory not found: ${knowledgeDir}`);
    process.exit(1);
  }

  // Find units to validate
  const entries = fs.readdirSync(knowledgeDir, {withFileTypes: true});
  const units = entries
    .filter((e) => e.isDirectory() && e.name !== '.cache')
    .map((e) => e.name);

  const toValidate = targetName ? units.filter((u) => u === targetName) : units;

  if (targetName && toValidate.length === 0) {
    console.error(`Error: '${targetName}' not found.`);
    process.exit(1);
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const unitName of toValidate) {
    const unitDir = path.join(knowledgeDir, unitName);
    const manifestPath = path.join(unitDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      // Standalone docs — minimal validation
      continue;
    }

    console.log(`Validating '${unitName}'...`);
    const errors: string[] = [];
    const warnings: string[] = [];

    // Parse manifest
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      errors.push(`manifest.json is invalid JSON: ${e}`);
      printValidationResults(unitName, errors, warnings);
      totalErrors += errors.length;
      continue;
    }

    // Required fields
    if (!manifest.name) errors.push('Missing required field: name');
    if (!manifest.version) errors.push('Missing required field: version');
    if (!manifest.type) errors.push('Missing required field: type');
    if (!manifest.description) errors.push('Missing required field: description');

    // Name matches folder
    if (manifest.name && manifest.name !== unitName) {
      errors.push(`manifest.name "${manifest.name}" does not match folder name "${unitName}"`);
    }

    // Doc file exists
    if (manifest.doc && typeof manifest.doc === 'string') {
      const docPath = path.join(unitDir, manifest.doc);
      if (!fs.existsSync(docPath)) {
        errors.push(`doc file not found: ${manifest.doc}`);
      }
    }

    // Validate modules
    const modules = manifest.modules as Record<string, {
      files?: string[];
      guide?: string;
      dependencies?: string[]
    }> | undefined;
    if (modules) {
      const moduleNames = Object.keys(modules);
      for (const [modName, mod] of Object.entries(modules)) {
        if (mod.files) {
          for (const file of mod.files) {
            const filePath = path.join(unitDir, file);
            if (!fs.existsSync(filePath)) {
              errors.push(`modules.${modName}.files: file not found: ${file}`);
            }
          }
        }
        if (mod.guide) {
          const guidePath = path.join(unitDir, mod.guide);
          if (!fs.existsSync(guidePath)) {
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

    // Validate scripts
    const scripts = manifest.scripts as Record<string, { file?: string }> | undefined;
    if (scripts) {
      for (const [scriptName, script] of Object.entries(scripts)) {
        if (script.file) {
          const scriptPath = path.join(unitDir, script.file);
          if (!fs.existsSync(scriptPath)) {
            errors.push(`scripts.${scriptName}.file: not found: ${script.file}`);
          }
        }
      }
    }

    // Validate references
    const references = manifest.references as Record<string, { file?: string }> | undefined;
    if (references) {
      for (const [refName, ref] of Object.entries(references)) {
        if (ref.file) {
          const refPath = path.join(unitDir, ref.file);
          if (!fs.existsSync(refPath)) {
            errors.push(`references.${refName}.file: not found: ${ref.file}`);
          }
        }
      }
    }

    // Validate workflows
    const workflows = manifest.workflows as Record<string, unknown> | undefined;
    if (workflows) {
      for (const wfName of Object.keys(workflows)) {
        const wfPath = path.join(unitDir, 'workflows', `${wfName}.json`);
        if (!fs.existsSync(wfPath)) {
          warnings.push(`workflows.${wfName}: file not found: workflows/${wfName}.json`);
        } else {
          // Validate workflow JSON
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

    printValidationResults(unitName, errors, warnings);
    totalErrors += errors.length;
    totalWarnings += warnings.length;
  }

  // Summary
  if (toValidate.length > 0) {
    console.log(`\n${toValidate.length} unit(s) validated.  ${totalErrors} error(s), ${totalWarnings} warning(s).`);
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function walkDir(dir: string, callback: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, {withFileTypes: true});
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.cache' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Feature 4: Pin / Unpin (version locking)
// ---------------------------------------------------------------------------

function cmdPin(knowledgeDir: string, args: string[]): void {
  const name = args[0];
  const version = args[1]; // optional — tag or commit hash

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

// ---------------------------------------------------------------------------
// Feature 5: Search (CLI wrapper for search_docs logic)
// ---------------------------------------------------------------------------

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

  // Scan all documents (same logic as MCP server)
  const docs = scanDocumentsForCli(knowledgeDir);

  if (docs.length === 0) {
    console.log('No documents found.');
    return;
  }

  const queryTerms = query.split(/\s+/);
  const scored: Array<{ name: string; title: string; description: string; score: number; type: string }> = [];

  for (const doc of docs) {
    const score = cliSearchScore(doc, queryTerms);
    if (score > 0) {
      scored.push({
        name: doc.name,
        title: doc.title,
        description: doc.description,
        score,
        type: doc.has_manifest ? (doc.type || 'manifest') : 'standalone',
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

interface CliDocEntry {
  name: string;
  title: string;
  description: string;
  tags: string[];
  aliases: string[];
  sections: string[];
  modules: string[];
  type: string;
  has_manifest: boolean;
}

function scanDocumentsForCli(knowledgeDir: string): CliDocEntry[] {
  const docs: CliDocEntry[] = [];
  if (!fs.existsSync(knowledgeDir)) return docs;

  // Find manifest folders
  const manifestFolders: string[] = [];
  walkDir(knowledgeDir, (filePath) => {
    if (path.basename(filePath) === 'manifest.json') {
      manifestFolders.push(path.dirname(filePath));
    }
  });
  manifestFolders.sort();

  // Index manifest-based
  for (const folder of manifestFolders) {
    const manifestPath = path.join(folder, 'manifest.json');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }

    const relFolder = path.relative(knowledgeDir, folder).replace(/\\/g, '/');
    docs.push({
      name: relFolder,
      title: (manifest.name as string) || relFolder,
      description: (manifest.description as string) || '',
      tags: (manifest.tags as string[]) || [],
      aliases: [],
      sections: [],
      modules: manifest.modules ? Object.keys(manifest.modules as Record<string, unknown>) : [],
      type: (manifest.type as string) || 'unknown',
      has_manifest: true,
    });
  }

  // Index standalone .md files
  const ignoredFiles = new Set(['README.md', 'manifest.json']);
  walkDir(knowledgeDir, (filePath) => {
    if (!filePath.endsWith('.md')) return;
    if (ignoredFiles.has(path.basename(filePath))) return;
    // Skip files inside manifest folders
    const resolved = path.resolve(filePath);
    for (const mf of manifestFolders) {
      if (resolved.startsWith(path.resolve(mf) + path.sep)) return;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const {metadata, body} = parseFrontmatterCli(content);
    const relPath = path.relative(knowledgeDir, filePath).replace(/\\/g, '/');

    let title = '';
    if (typeof metadata.title === 'string') title = metadata.title;
    else {
      for (const line of body.split(/\r?\n/)) {
        if (line.startsWith('# ')) {
          title = line.slice(2).trim();
          break;
        }
      }
    }
    if (!title) title = path.basename(filePath, '.md').replace(/[-_]/g, ' ');

    const tags = normalizeField(metadata, 'tags', 'keywords');
    const aliases = normalizeField(metadata, 'aliases');
    const description = typeof metadata.description === 'string' ? metadata.description : '';

    docs.push({
      name: relPath,
      title,
      description,
      tags,
      aliases,
      sections: [],
      modules: [],
      type: 'standalone',
      has_manifest: false
    });
  });

  return docs;
}

function parseFrontmatterCli(content: string): { metadata: Record<string, unknown>; body: string } {
  const metadata: Record<string, unknown> = {};
  let body = content;
  if (content.startsWith('---')) {
    const parts = content.split('---', 3);
    if (parts.length >= 3) {
      const fm = parts[1].trim();
      body = parts.slice(2).join('---').trim();
      for (const line of fm.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const key = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
          if (value.includes(',') && ['tags', 'keywords', 'aliases'].includes(key)) {
            metadata[key] = value.split(',').map((v) => v.trim());
          } else {
            metadata[key] = value;
          }
        }
      }
    }
  }
  return {metadata, body};
}

function normalizeField(metadata: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = metadata[key];
    if (value != null) {
      if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
      if (typeof value === 'string' && value.trim()) return value.split(',').map((v) => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function cliSearchScore(doc: CliDocEntry, queryTerms: string[]): number {
  let score = 0;
  const titleLower = doc.title.toLowerCase();
  const descLower = doc.description.toLowerCase();
  const tagsLower = doc.tags.join(' ').toLowerCase();
  const aliasesLower = doc.aliases.join(' ').toLowerCase();
  const nameLower = doc.name.toLowerCase();
  const modulesLower = doc.modules.join(' ').toLowerCase();
  const typeLower = doc.type.toLowerCase();

  for (const term of queryTerms) {
    const t = term.toLowerCase();
    if (aliasesLower.includes(t)) score += 12;
    if (titleLower.includes(t)) score += 10;
    if (tagsLower.includes(t)) score += 8;
    if (typeLower.includes(t)) score += 7;
    if (modulesLower.includes(t)) score += 6;
    if (nameLower.includes(t)) score += 6;
    if (descLower.includes(t)) score += 2;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Feature 7: Export (package knowledge as zip)
// ---------------------------------------------------------------------------

function cmdExport(knowledgeDir: string, args: string[]): void {
  let name = '';
  let outputPath = '';
  let format = 'zip';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (args[i] === '--format' && i + 1 < args.length) {
      format = args[++i];
    } else if (!name) {
      name = args[i];
    }
  }

  if (!name) {
    console.error('Error: Name is required.\nUsage: knowledge-shelf export <name> [--output <path>] [--format zip|tar]');
    process.exit(1);
  }

  const unitDir = path.join(knowledgeDir, name);
  if (!fs.existsSync(unitDir) || !fs.statSync(unitDir).isDirectory()) {
    console.error(`Error: '${name}' not found in ${knowledgeDir}`);
    process.exit(1);
  }

  // Default output path
  if (!outputPath) {
    const ext = format === 'tar' ? '.tar.gz' : '.zip';
    outputPath = path.resolve(process.cwd(), `${name}${ext}`);
  }

  console.log(`Exporting '${name}' to ${outputPath}...`);

  try {
    let result: ReturnType<typeof spawnSync>;
    if (format === 'tar') {
      result = spawnSync('tar', ['-czf', outputPath, '-C', knowledgeDir, name], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } else {
      // Use PowerShell Compress-Archive on Windows, zip on Unix
      if (process.platform === 'win32') {
        const escapedUnitDir = unitDir.replace(/'/g, '\'\'');
        const escapedOutputPath = outputPath.replace(/'/g, '\'\'');
        result = spawnSync(
          'powershell',
          ['-NoProfile', '-Command',
            `Compress-Archive -Path '${escapedUnitDir}\\*' -DestinationPath '${escapedOutputPath}' -Force`],
          {stdio: 'pipe', encoding: 'utf-8'}
        );
      } else {
        result = spawnSync('zip', ['-r', outputPath, name], {
          cwd: knowledgeDir,
          stdio: 'pipe',
          encoding: 'utf-8',
        });
      }
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
Knowledge Shelf — manage knowledge sources from git repositories.

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
      Lock a source to its current version (or a specific tag/commit).
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

Global Options:
  --dir <path>     Explicit path to knowledge directory.

Resolution Order (how the knowledge directory is found):
  1. --dir flag (highest priority)
  2. KNOWLEDGE_DIR environment variable
  3. Walk up from CWD looking for knowledge/.registry.json
  4. ~/.knowledge (global default)

Examples:
  knowledge-shelf add https://github.com/team/qa-knowledge.git
  knowledge-shelf add https://github.com/team/shared.git --path cucumber-boilerplate --name cucumber
  knowledge-shelf add https://github.com/team/shared.git --all
  knowledge-shelf search cucumber ui
  knowledge-shelf list
  knowledge-shelf list --dir C:\\projects\\my-repo\\knowledge
  knowledge-shelf pin cucumber v1.2.0
  knowledge-shelf update
  knowledge-shelf update cucumber
  knowledge-shelf export cucumber --output ./cucumber.zip
  knowledge-shelf install-skill
  knowledge-shelf install-skill ./my-agent/skills
  knowledge-shelf remove cucumber
`);
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

export function runCli(rawArgs: string[]): void {
  // Extract global --dir flag before dispatching
  let cliDir: string | undefined;
  const args: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--dir' && i + 1 < rawArgs.length) {
      cliDir = rawArgs[++i];
    } else {
      args.push(rawArgs[i]);
    }
  }

  const command = args[0];
  const knowledgeDir = getKnowledgeDir(cliDir);

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
