/**
 * Registry, team sync config (knowledge-shelf.json), shelf catalog (shelf.json), and checksum helpers.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveInsideDir, walkDir } from '../core.js';

export interface RegistryEntry {
  name: string;
  url: string;
  path?: string;
  branch?: string;
  commit: string;
  pin?: string;
  checksum?: string;
  trusted?: boolean;
  installedAt: string;
  updatedAt: string;
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

export function loadRegistry(knowledgeDir: string): Registry {
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

export function saveRegistry(knowledgeDir: string, registry: Registry): void {
  const registryPath = getRegistryPath(knowledgeDir);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * Computes a deterministic SHA-256 content checksum for an installed unit directory or standalone file.
 */
export function computeUnitChecksum(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return '';
  const hash = crypto.createHash('sha256');
  const stat = fs.statSync(targetPath);

  if (stat.isFile()) {
    hash.update(path.basename(targetPath));
    hash.update('\0');
    hash.update(fs.readFileSync(targetPath));
    return hash.digest('hex').slice(0, 16);
  }

  const files: string[] = [];
  walkDir(targetPath, (fp) => files.push(fp));
  files.sort((a, b) =>
    path.relative(targetPath, a).replace(/\\/g, '/').localeCompare(path.relative(targetPath, b).replace(/\\/g, '/'))
  );

  for (const fp of files) {
    const rel = path.relative(targetPath, fp).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(fp));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function loadShelfCatalog(repoDir: string): ShelfCatalog | null {
  const shelfPath = path.join(repoDir, 'shelf.json');
  if (!fs.existsSync(shelfPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(shelfPath, 'utf-8')) as ShelfCatalog;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.units)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadTeamConfig(configPath: string): TeamConfig {
  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(content) as TeamConfig;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)) {
    throw new Error(`Invalid team config '${configPath}': expected an object with a "sources" array.`);
  }
  return parsed;
}
