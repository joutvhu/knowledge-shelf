/**
 * Filesystem scanning, Markdown frontmatter/section parsing, and glob matching.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IGNORED_FILES, resolveInsideDir } from './config.js';

export interface SectionInfo {
  level: number;
  title: string;
  line: number;
  end_line: number;
}

export interface ManifestModule {
  description?: string;
  guide?: string;
  files?: string[];
  exclude?: string[];
  dependencies?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export interface ManifestScript {
  file?: string;
  interpreter?: string;
  description?: string;
  timeout_ms?: number;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ManifestWorkflowRef {
  description?: string;
  file?: string;
  [key: string]: unknown;
}

export interface ManifestReference {
  file?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface Manifest {
  $schema?: string;
  name?: string;
  description?: string;
  type?: string;
  version?: string;
  doc?: string;
  tags?: string[];
  aliases?: string[];
  status?: 'active' | 'deprecated' | 'draft' | string;
  superseded_by?: string | null;
  verified_at?: string;
  applies_to?: {
    languages?: string[];
    frameworks?: Record<string, string>;
    detect_files?: string[];
    [key: string]: unknown;
  };
  source?: {
    repository?: string;
    upstream_repo?: string;
    upstream_ref?: string;
    license?: string;
    maintainers?: string[];
    [key: string]: unknown;
  };
  requires?: string[];
  enhances?: string[];
  modules?: Record<string, ManifestModule>;
  workflows?: Record<string, ManifestWorkflowRef>;
  scripts?: Record<string, ManifestScript>;
  references?: Record<string, ManifestReference>;
  placeholders?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// File System Helpers
// ---------------------------------------------------------------------------

/** Visits exactly what copyDirSync copies: regular files at any depth, skipping entries named '.git'. */
export function walkUnitFiles(dir: string, callback: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkUnitFiles(full, callback);
    else if (entry.isFile()) callback(full);
  }
}

export function walkDir(dir: string, callback: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
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
    if (filePath.toLowerCase().endsWith('.md') && !IGNORED_FILES.has(path.basename(filePath))) {
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

// ---------------------------------------------------------------------------
// Glob Matching (zero-dependency)
// ---------------------------------------------------------------------------

export function isGlobPattern(p: string): boolean {
  return /[*?]/.test(p) || (p.includes('{') && p.includes('}') && p.includes(','));
}

// Expands {a,b} brace alternatives in a glob pattern into individual patterns.
// e.g. "src/**/*.{ts,js}" -> ["src/**/*.ts", "src/**/*.js"]
export function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]*,[^{}]*)\}/);
  if (!match) return [pattern];
  const options = match[1].split(',');
  const prefix = pattern.slice(0, match.index!);
  const suffix = pattern.slice(match.index! + match[0].length);
  const expanded: string[] = [];
  for (const opt of options) {
    for (const sub of expandBraces(`${prefix}${opt}${suffix}`)) {
      expanded.push(sub);
    }
  }
  return expanded;
}

/**
 * Converts a POSIX-style relative glob pattern (supporting `**`, `*`, `?`) to a RegExp.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let regex = '^';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        const after = normalized[i + 2];
        if (after === '/') {
          regex += '(?:.+/)?';
          i += 3;
          continue;
        }
        regex += '.*';
        i += 2;
        continue;
      }
      regex += '[^/]*';
      i++;
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

export function matchesAnyGlob(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const expanded = patterns.flatMap(expandBraces);
  return expanded.some((pat) => globToRegExp(pat).test(normalized));
}

/**
 * Resolves a list of literal paths and/or glob patterns relative to `unitDir`,
 * applying optional `exclude` globs. Blocks any traversal outside `unitDir`.
 */
export function resolveUnitFiles(
  unitDir: string,
  patterns: string[],
  excludePatterns: string[] = []
): { files: string[]; missingLiterals: string[]; escapedPatterns: string[] } {
  const matchedSet = new Set<string>();
  const missingLiterals: string[] = [];
  const escapedPatterns: string[] = [];

  let allUnitFiles: string[] | null = null;
  const getAllUnitFiles = () => {
    if (allUnitFiles) return allUnitFiles;
    const list: string[] = [];
    walkUnitFiles(unitDir, (fp) => {
      list.push(path.relative(unitDir, fp).replace(/\\/g, '/'));
    });
    allUnitFiles = list.sort();
    return allUnitFiles;
  };

  for (const rawPattern of patterns) {
    const pat = rawPattern.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!pat) continue;

    // Quick path escape check even for globs (e.g. "../secret/*")
    const literalPrefix = pat.split(/[*?{]/)[0] || '.';
    if (pat.startsWith('/') || /^[A-Za-z]:/.test(pat) || pat.split('/').includes('..')) {
      escapedPatterns.push(rawPattern);
      continue;
    }
    const prefixResolved = resolveInsideDir(unitDir, literalPrefix === '.' ? '.' : literalPrefix, false);
    if (!prefixResolved) {
      escapedPatterns.push(rawPattern);
      continue;
    }

    const hadGlob = isGlobPattern(pat);
    const expandedSubPatterns = expandBraces(pat);

    for (const subPat of expandedSubPatterns) {
      if (isGlobPattern(subPat)) {
        const rx = globToRegExp(subPat);
        for (const rel of getAllUnitFiles()) {
          if (rx.test(rel) && !matchesAnyGlob(rel, excludePatterns)) {
            matchedSet.add(rel);
          }
        }
      } else {
        const resolved = resolveInsideDir(unitDir, subPat, true);
        if (!resolved) {
          escapedPatterns.push(rawPattern);
        } else if (!fs.existsSync(resolved)) {
          if (!hadGlob) {
            missingLiterals.push(rawPattern);
          }
        } else if (!matchesAnyGlob(subPat, excludePatterns)) {
          matchedSet.add(subPat);
        }
      }
    }
  }

  return {
    files: [...matchedSet].sort(),
    missingLiterals,
    escapedPatterns,
  };
}

// ---------------------------------------------------------------------------
// Document Parsing
// ---------------------------------------------------------------------------

function stripUnquotedComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
        return raw.slice(0, i).trim();
      }
    }
  }
  return raw.trim();
}

function splitInlineYamlArray(inner: string): string[] {
  const items: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote && inner[i - 1] !== '\\') {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      const val = cur.trim();
      if (val) items.push(val);
      cur = '';
    } else {
      cur += ch;
    }
  }
  const last = cur.trim();
  if (last) items.push(last);
  return items;
}

function unquoteYaml(val: string): string {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses optional YAML frontmatter (`--- ... ---`) at the top of a Markdown file
 * without truncating `---` horizontal rules inside the document body.
 */
export function parseFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  const metadata: Record<string, unknown> = {};
  const cleaned = content.replace(/^\uFEFF/, '');

  const match =
    cleaned.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/) ||
    cleaned.match(/^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/);

  if (!match) {
    return { metadata, body: cleaned };
  }

  const frontmatterText = match[1] || '';
  const body = cleaned.slice(match[0].length).trim();

  const lines = frontmatterText.split(/\r?\n/);
  let currentListKey: string | null = null;
  let blockKey: string | null = null;
  let blockMode: '|' | '>' | null = null;
  let blockIndent = 0;
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (!blockKey) return;
    if (blockMode === '>') {
      metadata[blockKey] = blockLines.map((l) => l.trim()).join(' ').trim();
    } else {
      metadata[blockKey] = blockLines.join('\n').trim();
    }
    blockKey = null;
    blockMode = null;
    blockIndent = 0;
    blockLines = [];
  };

  for (const line of lines) {
    if (blockKey) {
      const indentMatch = line.match(/^(\s*)(.*)$/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      if (!line.trim()) {
        blockLines.push('');
        continue;
      }
      if (indent > 0 && (blockIndent === 0 || indent >= blockIndent)) {
        if (blockIndent === 0) blockIndent = indent;
        blockLines.push(line.slice(blockIndent));
        continue;
      }
      flushBlock();
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentListKey && trimmed.startsWith('- ')) {
      const rawItem = stripUnquotedComment(trimmed.slice(2));
      const item = unquoteYaml(rawItem);
      if (item) (metadata[currentListKey] as string[]).push(item);
      continue;
    }
    currentListKey = null;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const rawAfterColon = trimmed.slice(colonIdx + 1);
      const rawValue = stripUnquotedComment(rawAfterColon);

      if (rawValue === '|' || rawValue === '|-' || rawValue === '>' || rawValue === '>-') {
        blockKey = key;
        blockMode = rawValue.startsWith('>') ? '>' : '|';
        blockIndent = 0;
        blockLines = [];
      } else if (!rawValue) {
        currentListKey = key;
        metadata[key] = [];
      } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        metadata[key] = splitInlineYamlArray(rawValue.slice(1, -1));
      } else {
        const value = unquoteYaml(rawValue);
        if (
          value.includes(',') &&
          ['tags', 'keywords', 'aliases'].includes(key) &&
          !(rawValue.startsWith('"') || rawValue.startsWith("'"))
        ) {
          metadata[key] = value
            .split(',')
            .map((v) => unquoteYaml(v))
            .filter(Boolean);
        } else {
          metadata[key] = value;
        }
      }
    }
  }

  flushBlock();
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
    if (!fenceChar) {
      const fenceOpen = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fenceOpen) {
        const marker = fenceOpen[1];
        const rest = fenceOpen[2];
        // Backtick code block info string cannot contain backticks (CommonMark §4.5)
        if (marker[0] === '~' || !rest.includes('`')) {
          fenceChar = marker[0];
          fenceLen = marker.length;
          continue;
        }
      }
    } else {
      const fenceClose = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (fenceClose) {
        const marker = fenceClose[1];
        if (marker[0] === fenceChar && marker.length >= fenceLen) {
          fenceChar = '';
          fenceLen = 0;
          continue;
        }
      }
      continue;
    }

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
