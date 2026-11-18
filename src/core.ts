/**
 * Core logic shared between the Knowledge Shelf MCP server and CLI:
 * - Knowledge directory resolution & path containment security
 * - Markdown frontmatter & section parsing (code-fence aware)
 * - Document & manifest scanning + relevance scoring
 * - MCP tool implementations
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Package Metadata & Configuration
// ---------------------------------------------------------------------------

export const IGNORED_FILES = new Set(['README.md', 'manifest.json']);

export function getPackageVersion(): string {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || '1.0.3';
  } catch {
    return '1.0.3';
  }
}

/**
 * Resolve the knowledge directory. Priority:
 * 1. Explicit directory argument (--dir <path> or server CLI path arg)
 * 2. KNOWLEDGE_DIR environment variable
 * 3. Walk up from CWD looking for .registry.json (in current dir or ./knowledge/)
 * 4. ~/.knowledge (global default)
 */
export function resolveKnowledgeDir(explicitDir?: string): string {
  if (explicitDir) {
    return path.resolve(explicitDir);
  }

  if (process.env.KNOWLEDGE_DIR) {
    return path.resolve(process.env.KNOWLEDGE_DIR);
  }

  let current = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(current, '.registry.json'))) {
      return current;
    }
    const candidate = path.join(current, 'knowledge');
    if (fs.existsSync(path.join(candidate, '.registry.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  return path.resolve(home, '.knowledge');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocEntry {
  name: string;
  title: string;
  description: string;
  tags: string[];
  has_manifest: boolean;
  type?: string;
  version?: string;
  modules?: string[];
  workflows?: string[];
  scripts?: string[];
  references?: string[];
  aliases?: string[];
  sections?: string[];
}

export interface Manifest {
  name?: string;
  description?: string;
  type?: string;
  version?: string;
  doc?: string;
  tags?: string[];
  aliases?: string[];
  modules?: Record<string, unknown>;
  workflows?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  references?: Record<string, unknown>;
  placeholders?: Record<string, unknown>;

  [key: string]: unknown;
}

export interface SectionInfo {
  level: number;
  title: string;
  line: number;
  end_line: number;
}

export interface WorkflowResults {
  workflow: string;
  steps_executed: number;
  files_created: string[];
  files_skipped: string[];
  scripts_run: Array<{ script: string; exit_code: number; stdout: string; stderr: string }>;
  messages: string[];
  errors: string[];
  summary?: string;
}

export interface ToolResponse {
  text: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Security Helpers
// ---------------------------------------------------------------------------

function isPathInside(base: string, target: string, strictChild: boolean): boolean {
  const rel = path.relative(base, target);
  if (!rel) return !strictChild;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolves `subPath` relative to `baseDir` and verifies the target stays inside
 * `baseDir` (following symlinks on existing ancestors to block symlink escapes).
 * If `strictChild` is true, rejects paths equal to `baseDir` itself.
 */
export function resolveInsideDir(baseDir: string, subPath: string, strictChild = false): string | null {
  try {
    const resolvedBase = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir);
    const candidate = path.resolve(resolvedBase, subPath);

    if (!isPathInside(resolvedBase, candidate, strictChild)) {
      return null;
    }

    // Walk up to the deepest existing ancestor so realpathSync resolves symlinks
    // even when the leaf path does not exist yet.
    let current = candidate;
    const tail: string[] = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      tail.unshift(path.basename(current));
      current = parent;
    }

    const realExisting = fs.existsSync(current) ? fs.realpathSync(current) : current;
    const canonical = tail.length > 0 ? path.join(realExisting, ...tail) : realExisting;

    if (!isPathInside(resolvedBase, canonical, strictChild)) {
      return null;
    }

    return canonical;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File System Helpers
// ---------------------------------------------------------------------------

export function walkDir(dir: string, callback: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
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

export function findMdFiles(dir: string): string[] {
  const files: string[] = [];
  walkDir(dir, (filePath) => {
    if (filePath.endsWith('.md') && !IGNORED_FILES.has(path.basename(filePath))) {
      files.push(filePath);
    }
  });
  return files.sort();
}

export function loadManifest(folder: string): Manifest | null {
  const manifestPath = path.join(folder, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as Manifest;
  } catch {
    return null;
  }
}

export function findManifestFolders(knowledgeDir: string): string[] {
  if (!fs.existsSync(knowledgeDir)) return [];
  const folders: string[] = [];
  walkDir(knowledgeDir, (filePath) => {
    if (path.basename(filePath) === 'manifest.json') {
      folders.push(path.dirname(filePath));
    }
  });
  return folders.sort();
}

function isInsideManifestFolder(filePath: string, manifestFolders: string[]): boolean {
  const normalized = path.resolve(filePath);
  for (const mf of manifestFolders) {
    const normalizedMf = path.resolve(mf);
    if (normalized === normalizedMf || normalized.startsWith(normalizedMf + path.sep)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Document Parsing
// ---------------------------------------------------------------------------

/**
 * Parses optional YAML frontmatter (`--- ... ---`) at the top of a Markdown file
 * without truncating `---` horizontal rules inside the document body.
 */
export function parseFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  const metadata: Record<string, unknown> = {};
  const cleaned = content.replace(/^\uFEFF/, '');

  const match = cleaned.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
    || cleaned.match(/^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/);

  if (!match) {
    return { metadata, body: cleaned };
  }

  const frontmatterText = (match[1] || '').trim();
  const body = cleaned.slice(match[0].length).trim();

  let currentListKey: string | null = null;
  for (const line of frontmatterText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentListKey && trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      if (item) (metadata[currentListKey] as string[]).push(item);
      continue;
    }
    currentListKey = null;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const rawValue = trimmed.slice(colonIdx + 1).trim();

      if (!rawValue) {
        currentListKey = key;
        metadata[key] = [];
      } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        metadata[key] = rawValue
          .slice(1, -1)
          .split(',')
          .map((v) => v.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else {
        const value = rawValue.replace(/^["']|["']$/g, '');
        if (value.includes(',') && ['tags', 'keywords', 'aliases'].includes(key)) {
          metadata[key] = value.split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else {
          metadata[key] = value;
        }
      }
    }
  }

  return { metadata, body };
}

export function extractTitle(metadata: Record<string, unknown>, body: string, filename: string): string {
  if (metadata.title && typeof metadata.title === 'string') return metadata.title;
  const sections = extractSections(body);
  const h1 = sections.find((s) => s.level === 1);
  if (h1) return h1.title;
  return path.basename(filename, '.md').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extracts Markdown headings (`#`..`######`) while ignoring `#` comments inside
 * fenced code blocks (` ``` ` or ` ~~~ `).
 */
export function extractSections(body: string): SectionInfo[] {
  const sections: SectionInfo[] = [];
  const lines = body.split(/\r?\n/);

  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        continue;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && line.trim() === marker) {
        fenceChar = '';
        fenceLen = 0;
        continue;
      }
    }

    if (fenceChar) continue;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      sections.push({ level: match[1].length, title: match[2].trim(), line: i, end_line: 0 });
    }
  }

  for (let i = 0; i < sections.length; i++) {
    sections[i].end_line = i + 1 < sections.length ? sections[i + 1].line - 1 : lines.length - 1;
  }

  return sections;
}

export function normalizeListField(metadata: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = metadata[key];
    if (value != null) {
      if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
      if (typeof value === 'string' && value.trim()) {
        return value.split(',').map((v) => v.trim()).filter(Boolean);
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Scanning & Search Scoring
// ---------------------------------------------------------------------------

export function scanDocuments(knowledgeDir: string): DocEntry[] {
  const docs: DocEntry[] = [];
  if (!fs.existsSync(knowledgeDir)) return docs;

  const manifestFolders = findManifestFolders(knowledgeDir);

  // Index manifest-based knowledge units
  for (const folder of manifestFolders) {
    const manifest = loadManifest(folder);
    if (!manifest) continue;

    const relFolder = path.relative(knowledgeDir, folder).replace(/\\/g, '/');
    const entry: DocEntry = {
      name: relFolder,
      title: manifest.name || relFolder,
      description: manifest.description || '',
      type: manifest.type || 'unknown',
      version: manifest.version || '',
      tags: Array.isArray(manifest.tags) ? manifest.tags : [],
      has_manifest: true,
    };

    if (Array.isArray(manifest.aliases)) entry.aliases = manifest.aliases;
    if (manifest.modules) entry.modules = Object.keys(manifest.modules);
    if (manifest.workflows) entry.workflows = Object.keys(manifest.workflows);
    if (manifest.scripts) entry.scripts = Object.keys(manifest.scripts);
    if (manifest.references) entry.references = Object.keys(manifest.references);

    docs.push(entry);
  }

  // Index standalone .md files (not inside manifest folders)
  const mdFiles = findMdFiles(knowledgeDir);
  for (const filePath of mdFiles) {
    if (isInsideManifestFolder(filePath, manifestFolders)) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { metadata, body } = parseFrontmatter(content);
    const relPath = path.relative(knowledgeDir, filePath).replace(/\\/g, '/');
    const title = extractTitle(metadata, body, path.basename(filePath));
    const tags = normalizeListField(metadata, 'tags', 'keywords');
    const aliases = normalizeListField(metadata, 'aliases');

    let description = typeof metadata.description === 'string' ? metadata.description : '';
    if (!description) {
      let inFence = false;
      for (const line of body.split(/\r?\n/)) {
        const stripped = line.trim();
        if (/^(`{3,}|~{3,})/.test(stripped)) {
          inFence = !inFence;
          continue;
        }
        if (!inFence && stripped && !stripped.startsWith('#')) {
          description = stripped.slice(0, 200);
          break;
        }
      }
    }

    const sections = extractSections(body);

    docs.push({
      name: relPath,
      title,
      description,
      tags,
      aliases,
      sections: sections.map((s) => s.title),
      has_manifest: false,
    });
  }

  return docs;
}

function matchesToken(haystackLower: string, termLower: string): boolean {
  const escaped = termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(haystackLower);
}

function scoreField(haystackLower: string, termLower: string, fullWeight: number): number {
  if (!haystackLower || !haystackLower.includes(termLower)) return 0;
  if (matchesToken(haystackLower, termLower)) return fullWeight;
  // Short terms (<=2 chars) that only match inside another word get no score to avoid noise;
  // longer partial/prefix matches receive half weight.
  if (termLower.length <= 2) return 0;
  return Math.max(1, Math.floor(fullWeight / 2));
}

export function searchScore(doc: DocEntry, queryTerms: string[]): number {
  let score = 0;
  const titleLower = (doc.title || '').toLowerCase();
  const descLower = (doc.description || '').toLowerCase();
  const tagsLower = (doc.tags || []).join(' ').toLowerCase();
  const aliasesLower = (doc.aliases || []).join(' ').toLowerCase();
  const nameLower = (doc.name || '').toLowerCase();
  const sectionsLower = (doc.sections || []).join(' ').toLowerCase();
  const modulesLower = (doc.modules || []).join(' ').toLowerCase();
  const typeLower = (doc.type || '').toLowerCase();

  for (const term of queryTerms) {
    const t = term.toLowerCase();
    if (!t) continue;
    score += scoreField(aliasesLower, t, 12);
    score += scoreField(titleLower, t, 10);
    score += scoreField(tagsLower, t, 8);
    score += scoreField(typeLower, t, 7);
    score += scoreField(modulesLower, t, 6);
    score += scoreField(nameLower, t, 6);
    score += scoreField(sectionsLower, t, 4);
    score += scoreField(descLower, t, 2);
  }

  return score;
}

// ---------------------------------------------------------------------------
// Case-Insensitive Finders
// ---------------------------------------------------------------------------

function findCaseInsensitive(knowledgeDir: string, name: string): string | null {
  if (!fs.existsSync(knowledgeDir)) return null;
  const nameLower = name.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
  const nameWithMd = nameLower.endsWith('.md') ? nameLower : `${nameLower}.md`;

  const mdFiles = findMdFiles(knowledgeDir);
  for (const filePath of mdFiles) {
    const rel = path.relative(knowledgeDir, filePath).replace(/\\/g, '/').toLowerCase();
    if (rel === nameLower || rel === nameWithMd) return filePath;
  }

  // Fallback to filename stem match only when caller did not specify a directory path
  if (!nameLower.includes('/')) {
    const targetStem = path.basename(nameLower, '.md');
    for (const filePath of mdFiles) {
      if (path.basename(filePath, '.md').toLowerCase() === targetStem) return filePath;
    }
  }

  return null;
}

function findResourceCaseInsensitive(knowledgeDir: string, name: string): string | null {
  if (!fs.existsSync(knowledgeDir)) return null;
  const nameLower = name.toLowerCase().replace(/\\/g, '/');

  let found: string | null = null;
  walkDir(knowledgeDir, (filePath) => {
    if (found) return;
    const rel = path.relative(knowledgeDir, filePath).replace(/\\/g, '/');
    if (rel.toLowerCase() === nameLower) found = filePath;
  });

  return found;
}

// ---------------------------------------------------------------------------
// Workflow Execution
// ---------------------------------------------------------------------------

function replacePlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

/**
 * Validates that a workflow output path (`copy` target or `mkdir` path) does not
 * contain unresolved placeholders, starts with a root path placeholder (`{{KEY}}/...`),
 * and stays inside that root input directory.
 */
function resolveSafeOutputTarget(
  pathTemplate: string,
  inputs: Record<string, string>
): { resolvedPath?: string; error?: string } {
  const trimmedTemplate = pathTemplate.trim();
  if (!trimmedTemplate) {
    return { error: 'Target path is empty.' };
  }

  const prefixMatch = trimmedTemplate.match(/^\{\{([A-Za-z0-9_]+)\}\}(?:[/\\](.*))?$/);
  if (!prefixMatch) {
    return {
      error: `Target path '${pathTemplate}' must start with a root path placeholder (e.g. {{TARGET}}/...).`,
    };
  }

  const rendered = replacePlaceholders(trimmedTemplate, inputs).trim();
  if (/\{\{[A-Za-z0-9_]+\}\}/.test(rendered)) {
    return { error: `Target path '${rendered}' contains unresolved placeholder(s).` };
  }

  const rootKey = prefixMatch[1];
  const rootVal = inputs[rootKey];
  if (!rootVal || !path.isAbsolute(rootVal)) {
    return { error: `Input '${rootKey}' ('${rootVal || ''}') must be an absolute path.` };
  }

  const rootBase = path.resolve(rootVal);
  const subRel = replacePlaceholders(prefixMatch[2] || '', inputs);
  if (!subRel) {
    return { resolvedPath: rootBase };
  }

  const safe = resolveInsideDir(rootBase, subRel, true);
  if (!safe) {
    return { error: `Target path '${rendered}' escapes base directory '${rootBase}'.` };
  }
  return { resolvedPath: safe };
}

function executeCopyStep(
  step: Record<string, unknown>,
  folder: string,
  inputs: Record<string, string>,
  results: WorkflowResults
): void {
  const sourceRel = String(step.source || '');
  const targetTemplate = String(step.target || '');
  const skipIfExists = Boolean(step.skip_if_exists);

  if (!sourceRel) {
    results.errors.push('Copy step missing source path.');
    return;
  }
  if (!targetTemplate) {
    results.errors.push(`Copy step for '${sourceRel}' missing target path.`);
    return;
  }

  const sourcePath = resolveInsideDir(folder, sourceRel, true);
  if (!sourcePath) {
    results.errors.push(`Source path '${sourceRel}' is outside the knowledge unit folder.`);
    return;
  }

  const targetCheck = resolveSafeOutputTarget(targetTemplate, inputs);
  if (!targetCheck.resolvedPath) {
    results.errors.push(targetCheck.error || `Invalid target path for '${sourceRel}'.`);
    return;
  }
  const targetPath = targetCheck.resolvedPath;

  if (skipIfExists && fs.existsSync(targetPath)) {
    results.files_skipped.push(sourceRel);
    return;
  }

  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    results.errors.push(`Source not found: ${sourceRel}`);
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const buf = fs.readFileSync(sourcePath);
  if (buf.subarray(0, 8192).includes(0)) {
    // Binary file: copy raw bytes without corrupting non-UTF-8 data
    fs.writeFileSync(targetPath, buf);
  } else {
    const content = replacePlaceholders(buf.toString('utf-8'), inputs);
    fs.writeFileSync(targetPath, content, 'utf-8');
  }
  results.files_created.push(targetPath);
}

function executeRunStep(
  step: Record<string, unknown>,
  folder: string,
  inputs: Record<string, string>,
  results: WorkflowResults
): void {
  const scriptRel = String(step.script || '');
  const argsTemplate = Array.isArray(step.args) ? (step.args as string[]) : [];
  const rawInterpreter = typeof step.interpreter === 'string' ? step.interpreter.trim() : '';

  if (!scriptRel) {
    results.errors.push('Run step missing script path.');
    return;
  }

  const resolvedScript = resolveInsideDir(folder, scriptRel, true);
  if (!resolvedScript) {
    results.errors.push(`Script path '${scriptRel}' is outside the knowledge unit folder.`);
    return;
  }

  if (!fs.existsSync(resolvedScript) || !fs.statSync(resolvedScript).isFile()) {
    results.errors.push(`Script not found: ${scriptRel}`);
    return;
  }

  const args = argsTemplate.map((a) => replacePlaceholders(String(a), inputs));
  const ext = path.extname(resolvedScript).toLowerCase();

  let interpreter = rawInterpreter.toLowerCase() === 'cmd /c' ? 'cmd' : rawInterpreter;
  if (!interpreter) {
    const interpreterMap: Record<string, string> = {
      '.py': 'python',
      '.js': 'node',
      '.mjs': 'node',
      '.cjs': 'node',
      '.ps1': 'pwsh',
      '.sh': 'bash',
      '.cmd': 'cmd',
      '.bat': 'cmd',
    };
    interpreter = interpreterMap[ext] || 'node';
  }

  const allowedInterpreters = new Set([
    'python',
    'python3',
    'node',
    'pwsh',
    'powershell',
    'bash',
    'sh',
    'cmd',
  ]);
  const normalizedInterp = interpreter.toLowerCase();
  if (!allowedInterpreters.has(normalizedInterp)) {
    results.errors.push(`Interpreter '${interpreter}' is not allowed.`);
    return;
  }

  const quoteCmdArg = (arg: string): string => {
    // Reject control characters and escape cmd.exe metacharacters outside/inside quotes
    const clean = arg.replace(/[\r\n\0]/g, '');
    return `"${clean.replace(/"/g, '""').replace(/%/g, '%%')}"`;
  };

  const buildSpawnArgs = (interp: string): [string, string[], boolean] => {
    if (interp === 'cmd') {
      const cmdLine = `"${[resolvedScript, ...args].map(quoteCmdArg).join(' ')}"`;
      return ['cmd.exe', ['/d', '/s', '/c', cmdLine], true];
    }
    if (interp === 'pwsh' || interp === 'powershell') {
      return [interp, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedScript, ...args], false];
    }
    return [interp, [resolvedScript, ...args], false];
  };

  let [bin, spawnArgs, verbatim] = buildSpawnArgs(normalizedInterp);
  let result = spawnSync(bin, spawnArgs, {
    cwd: folder,
    timeout: 120_000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: verbatim,
  });

  // Fallback from pwsh to Windows PowerShell if pwsh is not installed
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === 'ENOENT' &&
    normalizedInterp === 'pwsh' &&
    !rawInterpreter &&
    process.platform === 'win32'
  ) {
    [bin, spawnArgs, verbatim] = buildSpawnArgs('powershell');
    result = spawnSync(bin, spawnArgs, {
      cwd: folder,
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: verbatim,
    });
  }

  const stdout = (result.stdout || '').slice(0, 2000);
  const stderr = (result.stderr || (result.error ? result.error.message : '')).slice(0, 1000);
  const exitCode = result.error ? 1 : (result.status ?? 1);

  results.scripts_run.push({ script: scriptRel, exit_code: exitCode, stdout, stderr });

  if (result.error) {
    results.errors.push(`Failed to execute '${bin}' for '${scriptRel}': ${result.error.message}`);
  } else if (exitCode !== 0) {
    results.errors.push(`Script '${scriptRel}' exited with code ${exitCode}: ${stderr.slice(0, 200)}`);
  }
}

function executeMkdirStep(
  step: Record<string, unknown>,
  inputs: Record<string, string>,
  results: WorkflowResults
): void {
  const pathTemplate = String(step.path || '');
  if (!pathTemplate) {
    results.errors.push('Mkdir step missing path.');
    return;
  }
  const targetCheck = resolveSafeOutputTarget(pathTemplate, inputs);
  if (!targetCheck.resolvedPath) {
    results.errors.push(targetCheck.error || 'Invalid mkdir path.');
    return;
  }
  fs.mkdirSync(targetCheck.resolvedPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// Tool Implementations
// ---------------------------------------------------------------------------

export function toolListDocs(knowledgeDir: string): ToolResponse {
  const docs = scanDocuments(knowledgeDir);
  if (docs.length === 0) {
    return {
      text: JSON.stringify({ total: 0, knowledge_dir: knowledgeDir, message: 'No documents found.' }, null, 2),
    };
  }
  return {
    text: JSON.stringify({ total: docs.length, documents: docs }, null, 2),
  };
}

export function toolSearchDocs(knowledgeDir: string, query: string, maxResults = 10): ToolResponse {
  const docs = scanDocuments(knowledgeDir);
  if (docs.length === 0) {
    return {
      text: JSON.stringify({ query, total: 0, message: 'No documents.' }, null, 2),
    };
  }

  const queryTerms = query.trim().split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) {
    return {
      text: JSON.stringify({ query, total: 0, message: 'Empty query.' }, null, 2),
    };
  }

  const scored: Array<DocEntry & { relevance_score: number }> = [];
  for (const doc of docs) {
    const score = searchScore(doc, queryTerms);
    if (score > 0) scored.push({ ...doc, relevance_score: score });
  }

  scored.sort((a, b) => b.relevance_score - a.relevance_score);
  const results = scored.slice(0, maxResults);

  return {
    text: JSON.stringify({ query, total: results.length, results }, null, 2),
  };
}

function findManifestFolderCaseInsensitive(knowledgeDir: string, name: string): string | null {
  const nameLower = name.toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!nameLower) return null;
  for (const folder of findManifestFolders(knowledgeDir)) {
    const rel = path.relative(knowledgeDir, folder).replace(/\\/g, '/').toLowerCase();
    if (rel === nameLower) return folder;
  }
  return null;
}

export function toolGetDoc(knowledgeDir: string, name: string): ToolResponse {
  const resolvedTarget = resolveInsideDir(knowledgeDir, name, true);
  if (!resolvedTarget) {
    return {
      text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
      isError: true,
    };
  }

  // Try as manifest-based folder first (exact or case-insensitive)
  const manifestFolder =
    fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()
      ? resolvedTarget
      : findManifestFolderCaseInsensitive(knowledgeDir, name);

  if (manifestFolder) {
    const manifest = loadManifest(manifestFolder);

    if (manifest) {
      const docFile = manifest.doc;
      if (docFile && typeof docFile === 'string') {
        const docPath = resolveInsideDir(manifestFolder, docFile, true);
        if (!docPath) {
          return {
            text: JSON.stringify({ error: 'Access denied. Manifest doc path outside knowledge unit.' }, null, 2),
            isError: true,
          };
        }
        if (fs.existsSync(docPath) && fs.statSync(docPath).isFile()) {
          try {
            const content = fs.readFileSync(docPath, 'utf-8');
            const { body } = parseFrontmatter(content);
            return { text: `directory: ${manifestFolder}\n---\n\n${body}` };
          } catch (e) {
            return {
              text: JSON.stringify({ error: `Failed to read ${docFile}: ${e}` }, null, 2),
              isError: true,
            };
          }
        }
      }
      const desc = manifest.description || 'No description available.';
      return { text: `directory: ${manifestFolder}\n---\n\n${desc}` };
    }
  }

  // Try as standalone .md file
  let filePath = resolvedTarget;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const found = findCaseInsensitive(knowledgeDir, name);
    if (!found) {
      return {
        text: JSON.stringify(
          {
            error: `Document '${name}' not found.`,
            hint: 'Use list_docs() to see available documents.',
          },
          null,
          2
        ),
        isError: true,
      };
    }
    const relFound = path.relative(knowledgeDir, found);
    const safeFound = resolveInsideDir(knowledgeDir, relFound, true);
    if (!safeFound) {
      return {
        text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
        isError: true,
      };
    }
    filePath = safeFound;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { body } = parseFrontmatter(content);
    return { text: `directory: ${path.dirname(filePath)}\n---\n\n${body}` };
  } catch (e) {
    return {
      text: JSON.stringify({ error: `Failed to read: ${e}` }, null, 2),
      isError: true,
    };
  }
}

export function toolGetDocSection(knowledgeDir: string, name: string, section: string): ToolResponse {
  const docResponse = toolGetDoc(knowledgeDir, name);
  if (docResponse.isError) return docResponse;

  const docContent = docResponse.text;
  const separator = '\n---\n\n';
  const sepIdx = docContent.indexOf(separator);
  const body = sepIdx >= 0 ? docContent.slice(sepIdx + separator.length) : docContent;

  const sections = extractSections(body);
  const sectionLower = section.toLowerCase().trim();

  // Match priority: 1) exact match -> 2) heading contains query -> 3) query contains heading (>=3 chars)
  const matched =
    sections.find((s) => s.title.toLowerCase() === sectionLower) ||
    sections.find((s) => s.title.toLowerCase().includes(sectionLower)) ||
    sections.find((s) => s.title.length >= 3 && sectionLower.includes(s.title.toLowerCase()));

  if (!matched) {
    return {
      text: JSON.stringify(
        {
          error: `Section '${section}' not found.`,
          available_sections: sections.map((s) => s.title),
        },
        null,
        2
      ),
      isError: true,
    };
  }

  const lines = body.split(/\r?\n/);
  let endLine = lines.length;
  for (const s of sections) {
    if (s.line > matched.line && s.level <= matched.level) {
      endLine = s.line;
      break;
    }
  }

  return { text: lines.slice(matched.line, endLine).join('\n').trim() };
}

export function toolGetResource(knowledgeDir: string, name: string): ToolResponse {
  const resolvedCandidate = resolveInsideDir(knowledgeDir, name, true);
  if (!resolvedCandidate) {
    return {
      text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
      isError: true,
    };
  }

  let filePath = resolvedCandidate;
  if (!fs.existsSync(filePath)) {
    const found = findResourceCaseInsensitive(knowledgeDir, name);
    if (!found) {
      return {
        text: JSON.stringify(
          {
            error: `Resource '${name}' not found.`,
            hint: 'Use get_manifest() to see available resources.',
          },
          null,
          2
        ),
        isError: true,
      };
    }
    const relFound = path.relative(knowledgeDir, found);
    const safeFound = resolveInsideDir(knowledgeDir, relFound, true);
    if (!safeFound) {
      return {
        text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
        isError: true,
      };
    }
    filePath = safeFound;
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return {
        text: JSON.stringify({ error: `Resource '${name}' is a directory, not a file.` }, null, 2),
        isError: true,
      };
    }

    const buf = fs.readFileSync(filePath);
    if (buf.subarray(0, 8192).includes(0)) {
      return {
        text: JSON.stringify(
          {
            error: `Resource '${name}' is binary and cannot be read as text.`,
            path: filePath,
          },
          null,
          2
        ),
        isError: true,
      };
    }

    return { text: buf.toString('utf-8') };
  } catch (e) {
    return {
      text: JSON.stringify({ error: `Failed to read: ${e}` }, null, 2),
      isError: true,
    };
  }
}

export function toolGetManifest(knowledgeDir: string, name: string): ToolResponse {
  const folder = resolveInsideDir(knowledgeDir, name, true);
  if (!folder) {
    return {
      text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
      isError: true,
    };
  }

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return {
      text: JSON.stringify(
        {
          error: `Knowledge folder '${name}' not found.`,
          hint: 'Use list_docs() to see available knowledge units.',
        },
        null,
        2
      ),
      isError: true,
    };
  }

  const manifest = loadManifest(folder);
  if (!manifest) {
    return {
      text: JSON.stringify(
        {
          error: `No manifest.json in '${name}'.`,
          hint: 'This is a legacy knowledge folder without structured metadata.',
        },
        null,
        2
      ),
      isError: true,
    };
  }

  (manifest as Record<string, unknown>)._directory = folder;
  return { text: JSON.stringify(manifest, null, 2) };
}

export function toolRunWorkflow(
  knowledgeDir: string,
  name: string,
  workflow: string,
  inputsArg: unknown
): ToolResponse {
  const folder = resolveInsideDir(knowledgeDir, name, true);
  if (!folder) {
    return {
      text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
      isError: true,
    };
  }

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return {
      text: JSON.stringify({ error: `Knowledge folder '${name}' not found.` }, null, 2),
      isError: true,
    };
  }

  let inputValues: Record<string, string>;
  try {
    if (!inputsArg || typeof inputsArg !== 'object' || Array.isArray(inputsArg)) {
      inputValues = {};
    } else {
      inputValues = Object.fromEntries(
        Object.entries(inputsArg as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      );
    }
  } catch (e) {
    return {
      text: JSON.stringify({ error: `Invalid inputs: ${e}` }, null, 2),
      isError: true,
    };
  }

  const workflowsDir = path.join(folder, 'workflows');
  const workflowPath = resolveInsideDir(workflowsDir, `${workflow}.json`, true);
  if (!workflowPath) {
    return {
      text: JSON.stringify({ error: 'Access denied. Invalid workflow name.' }, null, 2),
      isError: true,
    };
  }

  if (!fs.existsSync(workflowPath) || !fs.statSync(workflowPath).isFile()) {
    let available: string[] = [];
    if (fs.existsSync(workflowsDir)) {
      available = fs
        .readdirSync(workflowsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
    }
    return {
      text: JSON.stringify({ error: `Workflow '${workflow}' not found.`, available_workflows: available }, null, 2),
      isError: true,
    };
  }

  let workflowDef: Record<string, unknown>;
  try {
    workflowDef = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
  } catch (e) {
    return {
      text: JSON.stringify({ error: `Failed to load workflow: ${e}` }, null, 2),
      isError: true,
    };
  }

  // Apply defaults before validating required inputs
  const workflowInputs = (workflowDef.inputs || {}) as Record<
    string,
    { required?: boolean; default?: unknown }
  >;
  for (const [k, def] of Object.entries(workflowInputs)) {
    if (!(k in inputValues) && def && def.default !== undefined) {
      inputValues[k] = String(def.default);
    }
  }

  const missing = Object.entries(workflowInputs)
    .filter(([, v]) => v?.required)
    .map(([k]) => k)
    .filter((k) => !(k in inputValues));

  if (missing.length > 0) {
    return {
      text: JSON.stringify(
        {
          error: `Missing required inputs: ${JSON.stringify(missing)}`,
          workflow_inputs: workflowInputs,
        },
        null,
        2
      ),
      isError: true,
    };
  }

  const steps = (workflowDef.steps || []) as Array<Record<string, unknown>>;
  const results: WorkflowResults = {
    workflow,
    steps_executed: 0,
    files_created: [],
    files_skipped: [],
    scripts_run: [],
    messages: [],
    errors: [],
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const action = String(step.action || '');
    try {
      if (action === 'copy') {
        executeCopyStep(step, folder, inputValues, results);
      } else if (action === 'run') {
        executeRunStep(step, folder, inputValues, results);
      } else if (action === 'mkdir') {
        executeMkdirStep(step, inputValues, results);
      } else if (action === 'message') {
        const text = replacePlaceholders(String(step.text || ''), inputValues);
        results.messages.push(text);
      } else {
        results.errors.push(`Step ${i + 1}: Unknown action '${action}'`);
      }
    } catch (e) {
      results.errors.push(`Step ${i + 1} (${action}): ${e}`);
    }
    results.steps_executed++;
  }

  results.summary =
    `${results.files_created.length} files created, ` +
    `${results.files_skipped.length} skipped, ` +
    `${results.scripts_run.length} scripts run, ` +
    `${results.errors.length} errors`;

  return {
    text: JSON.stringify(results, null, 2),
    isError: results.errors.length > 0,
  };
}
