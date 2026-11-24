/**
 * Registry, team sync config (knowledge-shelf.json), shelf catalog (shelf.json), and checksum helpers.
 */

import * as crypto from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { isReservedPath, resolveInsideDir, stripBom, walkDir, walkUnitFiles } from '../core.js';

export interface RegistryEntry {
  name: string;
  url: string;
  path?: string;
  branch?: string;
  commit: string;
  fullCommit?: string;
  pin?: string;
  checksum?: string;
  trusted?: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface RegistrySource extends RegistryEntry {}

export function isSameUnitName(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

export function recordInstalledSource(registry: Registry, entry: RegistryEntry): RegistryEntry {
  const existingIndex = registry.sources.findIndex((s) => isSameUnitName(s.name, entry.name));
  if (existingIndex !== -1) {
    registry.sources[existingIndex] = entry;
    return entry;
  } else {
    registry.sources.push(entry);
    return entry;
  }
}

export interface Registry {
  version: '1.0';
  sources: RegistryEntry[];
}

export interface TeamSourceEntry {
  name: string;
  url: string;
  path?: string;
  ref?: string;
  branch?: string;
  pin?: string;
}

export interface TeamConfig {
  $schema?: string;
  version: '1.0';
  sources: TeamSourceEntry[];
}

export interface ShelfCatalogUnit {
  name: string;
  path: string;
  type?: string;
  version?: string;
  description?: string;
  tags?: string[];
}

export interface ShelfCatalogPack {
  description?: string;
  units: string[];
}

export interface ShelfCatalog {
  $schema?: string;
  name?: string;
  description?: string;
  homepage?: string;
  units: ShelfCatalogUnit[];
  packs?: Record<string, ShelfCatalogPack>;
}

export function getRegistryPath(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.registry.json');
}

export function getCacheDir(knowledgeDir: string): string {
  return path.join(knowledgeDir, '.cache');
}

export function resolveSafeUnitDir(knowledgeDir: string, name: string): string {
  const trimmed = (name || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    console.error(`Error: Invalid knowledge unit name '${name}'.`);
    process.exit(1);
  }
  const canonicalDir = fs.existsSync(knowledgeDir) ? fs.realpathSync(knowledgeDir) : path.resolve(knowledgeDir);
  const resolved = resolveInsideDir(canonicalDir, trimmed, true);
  if (!resolved) {
    console.error(`Error: Access denied. '${name}' is outside the knowledge directory.`);
    process.exit(1);
  }
  const segments = trimmed.split(/[\\/]+/);
  if (
    isReservedPath(canonicalDir, resolved) ||
    segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))
  ) {
    console.error(`Error: Access denied. '${name}' is a reserved internal path or starts with '.'.`);
    process.exit(1);
  }
  return resolved;
}

export interface LoadRegistryOptions {
  exitOnError?: boolean;
}

export function loadRegistry(knowledgeDir: string, options: LoadRegistryOptions = {}): Registry {
  const registryPath = getRegistryPath(knowledgeDir);
  if (!fs.existsSync(registryPath)) {
    return { version: '1.0', sources: [] };
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(stripBom(content)) as Registry;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)) {
      throw new Error('expected an object with a "sources" array');
    }
    return parsed;
  } catch (e) {
    if (options.exitOnError === false) {
      throw e;
    }
    // Never fall back to an empty registry: the next save would silently erase every entry.
    console.error(`Error: Cannot read registry ${registryPath}: ${e instanceof Error ? e.message : e}`);
    console.error('Fix or delete the file manually, then retry.');
    process.exit(1);
  }
}

const activeLocks = new Set<string>();

/**
 * Executes `fn` with a re-entrant cross-process file lock on `.registry.lock`.
 */
export function withRegistryLock<T>(knowledgeDir: string, fn: () => T, timeoutMs = 15000): T {
  const dir = path.resolve(knowledgeDir);
  const lockKey = process.platform === 'win32' ? dir.toLowerCase() : dir;

  if (activeLocks.has(lockKey)) {
    return fn();
  }

  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, '.registry.lock');
  const startTime = Date.now();
  let fd: number | null = null;

  while (true) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, 'utf-8');
      activeLocks.add(lockKey);
      break;
    } catch (err: any) {
      if (err && err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);

          // Fast path: if the holding process is dead, reclaim the lock immediately
          try {
            const content = fs.readFileSync(lockFile, 'utf-8');
            const [pidStr] = content.split('\n');
            const lockPid = parseInt(pidStr, 10);
            if (Number.isInteger(lockPid) && lockPid > 0 && lockPid !== process.pid) {
              try {
                process.kill(lockPid, 0);
              } catch (killErr: any) {
                if (killErr && killErr.code === 'ESRCH') {
                  fs.unlinkSync(lockFile);
                  continue;
                }
              }
            }
          } catch {
            /* ignore read/parse failure */
          }

          if (Date.now() - stat.mtimeMs > 10000) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() - startTime > timeoutMs) {
          throw new Error(`Timeout waiting for registry lock on ${knowledgeDir}`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } else {
        throw err;
      }
    }
  }

  try {
    return fn();
  } finally {
    activeLocks.delete(lockKey);
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Atomic load-modify-save cycle under registry lock to prevent lost updates.
 */
export function mutateRegistry(
  knowledgeDir: string,
  mutator: (registry: Registry) => void
): Registry {
  return withRegistryLock(knowledgeDir, () => {
    let registry: Registry;
    try {
      registry = loadRegistry(knowledgeDir, { exitOnError: false });
    } catch (e) {
      const registryPath = getRegistryPath(knowledgeDir);
      console.error(`Error: Cannot read registry ${registryPath}: ${e instanceof Error ? e.message : e}`);
      console.error('Fix or delete the file manually, then retry.');
      throw e;
    }
    mutator(registry);
    saveRegistry(knowledgeDir, registry);
    return registry;
  });
}

function renameWithRetry(source: string, destination: string): void {
  const maxAttempts = 5;
  const retryCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (err: any) {
      if (
        attempt < maxAttempts &&
        err &&
        retryCodes.has(err.code) &&
        !(fs.existsSync(destination) && fs.statSync(destination).isDirectory())
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      throw err;
    }
  }
}

export function saveRegistry(knowledgeDir: string, registry: Registry): void {
  withRegistryLock(knowledgeDir, () => {
    const registryPath = getRegistryPath(knowledgeDir);
    const dir = path.dirname(registryPath);
    fs.mkdirSync(dir, { recursive: true });

    const base = path.basename(registryPath);
    const prefix = base.startsWith('.') ? base : '.' + base;
    const tmp = path.join(
      dir,
      `${prefix}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );

    try {
      fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf-8');
      renameWithRetry(tmp, registryPath);
    } catch (e) {
      if (fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
      }
      throw e;
    }
  });
}

function hashFiles(root: string, files: string[]): string {
  const sorted = [...files].sort((a, b) =>
    path.relative(root, a).replace(/\\/g, '/').localeCompare(path.relative(root, b).replace(/\\/g, '/'))
  );
  const hash = crypto.createHash('sha256');
  for (const fp of sorted) {
    const rel = path.relative(root, fp).replace(/\\/g, '/');
    const content = fs.readFileSync(fp);
    hash.update(rel + '\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Computes a deterministic SHA-256 content checksum for an installed unit directory or standalone file.
 * Uses walkUnitFiles to cover the full copy set (including dot files and node_modules).
 */
export function computeUnitChecksum(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return '';
  const stat = fs.statSync(targetPath);

  if (stat.isFile()) {
    const hash = crypto.createHash('sha256');
    hash.update(path.basename(targetPath));
    hash.update('\0');
    hash.update(fs.readFileSync(targetPath));
    return hash.digest('hex').slice(0, 16);
  }

  const files: string[] = [];
  walkUnitFiles(targetPath, (fp) => files.push(fp));
  return hashFiles(targetPath, files);
}

/**
 * Computes the legacy checksum using walkDir (which skips dot files and node_modules).
 * Used for fallback compatibility with older installations.
 */
export function computeLegacyUnitChecksum(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return '';
  const stat = fs.statSync(targetPath);

  if (stat.isFile()) {
    const hash = crypto.createHash('sha256');
    hash.update(path.basename(targetPath));
    hash.update('\0');
    hash.update(fs.readFileSync(targetPath));
    return hash.digest('hex').slice(0, 16);
  }

  const files: string[] = [];
  walkDir(targetPath, (fp) => files.push(fp));
  return hashFiles(targetPath, files);
}

/**
 * Checks whether a unit has local modifications against a stored checksum.
 * Returns false if !stored or !fs.existsSync(targetPath).
 * Returns false if modern checksum or legacy checksum equals stored.
 * Returns true otherwise.
 */
export function hasLocalModifications(targetPath: string, stored?: string): boolean {
  if (!stored || !fs.existsSync(targetPath)) return false;
  const modern = computeUnitChecksum(targetPath);
  if (modern === stored) return false;
  const legacy = computeLegacyUnitChecksum(targetPath);
  if (legacy === stored) return false;
  return true;
}

export function loadShelfCatalog(repoDir: string): ShelfCatalog | null {
  const shelfPath = path.join(repoDir, 'shelf.json');
  if (!fs.existsSync(shelfPath)) return null;
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(shelfPath, 'utf-8'))) as ShelfCatalog;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.units)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadTeamConfig(configPath: string): TeamConfig {
  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(stripBom(content)) as TeamConfig;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)) {
    throw new Error(`Invalid team config '${configPath}': expected an object with a "sources" array.`);
  }
  return parsed;
}
