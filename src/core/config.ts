/**
 * Configuration, multi-layer knowledge directory resolution, and path containment security.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const IGNORED_FILES = new Set(['README.md', 'manifest.json', 'shelf.json', 'knowledge-shelf.json']);

export const ALLOWED_WORKFLOW_ACTIONS = new Set([
  'copy',
  'copy_dir',
  'patch',
  'run',
  'mkdir',
  'message',
]);

export const ALLOWED_INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'pwsh',
  'powershell',
  'bash',
  'sh',
  'cmd',
]);

export const ROOT_PLACEHOLDER_RE = /^\{\{[A-Za-z0-9_]+\}\}(?:[/\\].*)?$/;

export function isSafeUnitSegment(name: string): boolean {
  return Boolean(name) && !name.startsWith('.') && !name.includes('/') && !name.includes('\\') && name !== '..';
}

export const MIN_WORKFLOW_TIMEOUT_MS = 1_000;
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 120_000;
export const MAX_WORKFLOW_TIMEOUT_MS = 600_000;

export function getPackageVersion(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
}

export function getDefaultGlobalKnowledgeDir(): string {
  return path.resolve(getHomeDir(), '.knowledge');
}

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(getHomeDir(), p.slice(1));
  }
  return p;
}

function dedupDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    let resolved = path.resolve(dir);
    try {
      if (fs.existsSync(resolved)) {
        resolved = fs.realpathSync(resolved);
      }
    } catch {
      /* ignore */
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function findWalkUpRegistryDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.registry.json'))) {
      return current;
    }
    const agentsCandidate = path.join(current, '.agents', 'knowledges');
    if (fs.existsSync(path.join(agentsCandidate, '.registry.json'))) {
      return agentsCandidate;
    }
    const candidate = path.join(current, 'knowledge');
    if (fs.existsSync(path.join(candidate, '.registry.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findWalkUpAgentsKnowledgeDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.agents', 'knowledges');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve the primary (single) knowledge directory. Priority:
 * 1. Explicit directory argument (--dir <path> or server CLI path arg)
 * 2. KNOWLEDGE_DIR environment variable (or first entry of KNOWLEDGE_DIRS)
 * 3. Walk up from CWD looking for .registry.json (in current dir or ./knowledge/)
 * 4. ~/.knowledge (global default)
 */
export function resolveKnowledgeDir(explicitDir?: string): string {
  let resolved: string;
  if (explicitDir) {
    resolved = path.resolve(expandHome(explicitDir));
  } else if (process.env.KNOWLEDGE_DIRS) {
    const first = process.env.KNOWLEDGE_DIRS.split(path.delimiter).map((s) => s.trim()).find(Boolean);
    resolved = first ? path.resolve(expandHome(first)) : getDefaultGlobalKnowledgeDir();
  } else if (process.env.KNOWLEDGE_DIR) {
    resolved = path.resolve(expandHome(process.env.KNOWLEDGE_DIR));
  } else {
    const agentsLocal = findWalkUpAgentsKnowledgeDir(process.cwd());
    const registryDir = findWalkUpRegistryDir(process.cwd());
    resolved = agentsLocal ? agentsLocal : registryDir ? registryDir : getDefaultGlobalKnowledgeDir();
  }

  try {
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
}

export interface ResolveKnowledgeDirsOptions {
  includeGlobal?: boolean;
  includeProjectLocal?: boolean;
}

/**
 * Resolve ordered knowledge directories (highest priority first) for multi-layer discovery.
 * Earlier layers shadow later layers when unit names collide.
 */
export function resolveKnowledgeDirs(
  explicitDirs?: string | string[],
  options: ResolveKnowledgeDirsOptions = {}
): string[] {
  const globalDir = getDefaultGlobalKnowledgeDir();

  const explicitList = Array.isArray(explicitDirs)
    ? explicitDirs.filter(Boolean)
    : explicitDirs
      ? [explicitDirs]
      : [];

  if (explicitList.length > 0) {
    const dirs = explicitList.map((d) => path.resolve(expandHome(d)));
    if (options.includeGlobal && fs.existsSync(globalDir)) {
      dirs.push(globalDir);
    }
    return dedupDirs(dirs);
  }

  if (process.env.KNOWLEDGE_DIRS) {
    const dirs = process.env.KNOWLEDGE_DIRS.split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((d) => path.resolve(expandHome(d)));
    if (options.includeGlobal && fs.existsSync(globalDir)) {
      dirs.push(globalDir);
    }
    if (dirs.length > 0) return dedupDirs(dirs);
  }

  if (process.env.KNOWLEDGE_DIR) {
    const dirs = [path.resolve(expandHome(process.env.KNOWLEDGE_DIR))];
    if (options.includeGlobal && fs.existsSync(globalDir)) {
      dirs.push(globalDir);
    }
    return dedupDirs(dirs);
  }

  const dirs: string[] = [];
  if (options.includeProjectLocal !== false) {
    const agentsLocal = findWalkUpAgentsKnowledgeDir(process.cwd());
    if (agentsLocal) dirs.push(agentsLocal);
  }

  const registryDir = findWalkUpRegistryDir(process.cwd());
  if (registryDir) dirs.push(registryDir);

  if (options.includeGlobal !== false) {
    if (dirs.length === 0 || fs.existsSync(globalDir)) {
      dirs.push(globalDir);
    }
  }

  if (dirs.length === 0) {
    dirs.push(globalDir);
  }

  return dedupDirs(dirs);
}

// ---------------------------------------------------------------------------
// Path Containment Security
// ---------------------------------------------------------------------------

function isPathInside(base: string, target: string, strictChild: boolean): boolean {
  const rel = path.relative(base, target);
  if (!rel) return !strictChild;
  return !(rel === '..' || rel.startsWith('..' + path.sep)) && !path.isAbsolute(rel);
}

/**
 * Resolves a path to its real canonical path by following symlinks/junctions on
 * the deepest existing ancestor, preserving any trailing non-existent segments.
 */
export function canonicalizePath(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const realExisting = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return tail.length > 0 ? path.join(realExisting, ...tail) : realExisting;
}

/**
 * Resolves `subPath` relative to `baseDir` and verifies the target stays inside
 * `baseDir` (following symlinks on existing ancestors to block symlink escapes).
 * If `strictChild` is true, rejects paths equal to `baseDir` itself.
 */
export function resolveInsideDir(baseDir: string, subPath: string, strictChild = false): string | null {
  try {
    const resolvedBase = canonicalizePath(baseDir);
    const candidate = path.resolve(resolvedBase, subPath);

    if (!isPathInside(resolvedBase, candidate, strictChild)) {
      return null;
    }

    const canonical = canonicalizePath(candidate);

    if (!isPathInside(resolvedBase, canonical, strictChild)) {
      return null;
    }

    return canonical;
  } catch {
    return null;
  }
}

/**
 * Returns true if `targetPath` relative to `baseDir` traverses internal shelf files
 * (root dot-items like `.registry.json`, `.cache`, `.git`, or `.git` directory at any depth).
 */
export function isReservedPath(baseDir: string, targetPath: string): boolean {
  const resolvedBase = canonicalizePath(baseDir);
  const resolvedTarget = canonicalizePath(targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  const segments = rel.split(/[\\/]+/);
  if (segments[0].startsWith('.')) return true;
  if (segments.some((seg) => seg === '.git')) return true;
  return false;
}
