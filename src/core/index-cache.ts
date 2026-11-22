/**
 * Document & manifest scanning with multi-layer precedence and mtime-based caching.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveInsideDir } from './config.js';
import {
  Manifest,
  extractSections,
  extractTitle,
  findManifestFolders,
  findMdFiles,
  loadManifest,
  normalizeListField,
  parseFrontmatter,
  walkDir,
} from './parser.js';

export const SEARCH_EXTRAS = Symbol('searchExtras');
export const ENTRY_INTERNALS = Symbol('entryInternals');

export interface ReferenceIndexInfo {
  key: string;
  file: string;
  description: string;
  tags: string[];
  sections: string[];
  body: string;
}

export interface SearchExtras {
  moduleTags: string;
  moduleTagsList: string[];
  capabilityKeys: string;
  capabilityDescriptions: string;
  appliesToText: string;
  referenceTags: string;
  referenceTagsList: string[];
  referenceSections: string[];
  references: ReferenceIndexInfo[];
  docBody: string;
}

export interface EntryInternals {
  layerDir: string;
  fullPath: string;
}

export interface DocEntry {
  name: string;
  title: string;
  description: string;
  tags: string[];
  has_manifest: boolean;
  type?: string;
  version?: string;
  status?: string;
  superseded_by?: string | null;
  applies_to?: Manifest['applies_to'];
  source_layer?: string;
  modules?: string[];
  workflows?: string[];
  scripts?: string[];
  references?: string[];
  aliases?: string[];
  sections?: string[];
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
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

function collectManifestSearchExtras(manifest: Manifest, folder: string, docBody: string): SearchExtras {
  const moduleTags: string[] = [];
  const capabilityKeys: string[] = [];
  const capabilityDescriptions: string[] = [];
  const appliesToTokens: string[] = [];
  const referenceTags: string[] = [];
  const referenceSections: string[] = [];
  const references: ReferenceIndexInfo[] = [];

  if (isPlainRecord(manifest.modules)) {
    for (const mod of Object.values(manifest.modules)) {
      if (!isPlainRecord(mod)) continue;
      if (Array.isArray(mod.tags)) moduleTags.push(...mod.tags.map(String));
      if (typeof mod.description === 'string') capabilityDescriptions.push(mod.description);
    }
  }

  for (const section of [manifest.workflows, manifest.scripts]) {
    if (!isPlainRecord(section)) continue;
    for (const [key, item] of Object.entries(section)) {
      capabilityKeys.push(key);
      if (isPlainRecord(item) && typeof item.description === 'string') {
        capabilityDescriptions.push(item.description);
      }
    }
  }

  if (isPlainRecord(manifest.references)) {
    for (const [key, item] of Object.entries(manifest.references)) {
      capabilityKeys.push(key);
      if (!isPlainRecord(item)) continue;
      const desc = typeof item.description === 'string' ? item.description : '';
      if (desc) capabilityDescriptions.push(desc);
      const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
      referenceTags.push(...tags);

      const fileRel = typeof item.file === 'string' ? item.file : '';
      let refSections: string[] = [];
      let refBody = '';
      if (fileRel) {
        const refPath = resolveInsideDir(folder, fileRel, true);
        if (refPath && fs.existsSync(refPath) && fs.statSync(refPath).isFile()) {
          try {
            const raw = fs.readFileSync(refPath, 'utf-8');
            const parsed = parseFrontmatter(raw);
            refBody = parsed.body;
            refSections = extractSections(refBody).map((s) => s.title);
            referenceSections.push(...refSections);
          } catch {
            /* skip unreadable ref */
          }
        }
      }
      references.push({
        key,
        file: fileRel,
        description: desc,
        tags,
        sections: refSections,
        body: refBody,
      });
    }
  }

  if (isPlainRecord(manifest.applies_to)) {
    if (Array.isArray(manifest.applies_to.languages)) {
      appliesToTokens.push(...manifest.applies_to.languages.map(String));
    }
    if (isPlainRecord(manifest.applies_to.frameworks)) {
      appliesToTokens.push(...Object.keys(manifest.applies_to.frameworks));
    }
  }

  return {
    moduleTags: moduleTags.join(' ').toLowerCase(),
    moduleTagsList: moduleTags,
    capabilityKeys: capabilityKeys.join(' ').toLowerCase(),
    capabilityDescriptions: capabilityDescriptions.join(' ').toLowerCase(),
    appliesToText: appliesToTokens.join(' ').toLowerCase(),
    referenceTags: referenceTags.join(' ').toLowerCase(),
    referenceTagsList: referenceTags,
    referenceSections,
    references,
    docBody,
  };
}

function scanSingleLayerUncached(knowledgeDir: string): DocEntry[] {
  const docs: DocEntry[] = [];
  if (!fs.existsSync(knowledgeDir)) return docs;

  const rootResolved = path.resolve(knowledgeDir);
  const allManifestFolders = findManifestFolders(knowledgeDir).filter(
    (folder) => path.resolve(folder) !== rootResolved
  );
  // Nested units inside another manifest unit belong to the parent unit
  const manifestFolders = allManifestFolders.filter((folder) => {
    const resolved = path.resolve(folder);
    return !allManifestFolders.some((other) => {
      const resolvedOther = path.resolve(other);
      return resolvedOther !== resolved && resolved.startsWith(resolvedOther + path.sep);
    });
  });

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

    if (typeof manifest.status === 'string' && manifest.status) {
      entry.status = manifest.status;
    }
    if (manifest.superseded_by !== undefined && manifest.superseded_by !== null) {
      entry.superseded_by = manifest.superseded_by;
    }
    if (isPlainRecord(manifest.applies_to)) {
      entry.applies_to = manifest.applies_to;
    }
    if (Array.isArray(manifest.aliases)) entry.aliases = manifest.aliases;
    if (isPlainRecord(manifest.modules)) entry.modules = Object.keys(manifest.modules);
    if (isPlainRecord(manifest.workflows)) entry.workflows = Object.keys(manifest.workflows);
    if (isPlainRecord(manifest.scripts)) entry.scripts = Object.keys(manifest.scripts);
    if (isPlainRecord(manifest.references)) entry.references = Object.keys(manifest.references);

    let docBody = '';
    if (typeof manifest.doc === 'string' && manifest.doc) {
      const docPath = resolveInsideDir(folder, manifest.doc, true);
      if (docPath && fs.existsSync(docPath) && fs.statSync(docPath).isFile()) {
        try {
          const { body } = parseFrontmatter(fs.readFileSync(docPath, 'utf-8'));
          docBody = body;
          const sections = extractSections(body);
          if (sections.length > 0) entry.sections = sections.map((s) => s.title);
        } catch {
          /* skip unreadable doc */
        }
      }
    }

    Object.defineProperty(entry, SEARCH_EXTRAS, {
      value: collectManifestSearchExtras(manifest, folder, docBody),
      enumerable: false,
    });
    Object.defineProperty(entry, ENTRY_INTERNALS, {
      value: { layerDir: knowledgeDir, fullPath: folder } satisfies EntryInternals,
      enumerable: false,
    });

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

    const entry: DocEntry = {
      name: relPath,
      title,
      description,
      tags,
      aliases,
      sections: sections.map((s) => s.title),
      has_manifest: false,
    };

    Object.defineProperty(entry, SEARCH_EXTRAS, {
      value: {
        moduleTags: '',
        moduleTagsList: [],
        referenceTagsList: [],
        capabilityKeys: '',
        capabilityDescriptions: '',
        appliesToText: '',
        referenceTags: '',
        referenceSections: [],
        references: [],
        docBody: body,
      } satisfies SearchExtras,
      enumerable: false,
    });
    Object.defineProperty(entry, ENTRY_INTERNALS, {
      value: { layerDir: knowledgeDir, fullPath: filePath } satisfies EntryInternals,
      enumerable: false,
    });

    docs.push(entry);
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Snapshot Cache (mtimeMs + size fingerprint)
// ---------------------------------------------------------------------------

interface CachedLayer {
  signature: string;
  docs: DocEntry[];
}

const layerCache = new Map<string, CachedLayer>();

function computeDirSignature(knowledgeDir: string): string {
  if (!fs.existsSync(knowledgeDir)) return 'MISSING';
  const parts: string[] = [];
  walkDir(knowledgeDir, (fp) => {
    const base = path.basename(fp);
    if (base === 'manifest.json' || fp.endsWith('.md')) {
      try {
        const st = fs.statSync(fp);
        parts.push(`${path.relative(knowledgeDir, fp)}:${st.mtimeMs}:${st.size}`);
      } catch {
        /* skip */
      }
    }
  });
  parts.sort();
  return parts.join('|');
}

export function clearIndexCache(): void {
  layerCache.clear();
}

export function scanSingleLayer(knowledgeDir: string): DocEntry[] {
  const resolved = path.resolve(knowledgeDir);
  const sig = computeDirSignature(resolved);
  const cached = layerCache.get(resolved);
  if (cached && cached.signature === sig) {
    return cached.docs;
  }
  const docs = scanSingleLayerUncached(resolved);
  layerCache.set(resolved, { signature: sig, docs });
  return docs;
}

/**
 * Scans one or multiple knowledge directories (ordered highest priority first).
 * When multiple directories are supplied, earlier layers shadow duplicate unit names
 * and `source_layer` is populated on entries.
 */
export function scanDocuments(knowledgeDirs: string | string[]): DocEntry[] {
  const dirs = Array.isArray(knowledgeDirs) ? knowledgeDirs : [knowledgeDirs];
  if (dirs.length <= 1) {
    return dirs.length === 1 ? scanSingleLayer(dirs[0]) : [];
  }

  const seen = new Set<string>();
  const merged: DocEntry[] = [];

  for (const dir of dirs) {
    const layerDocs = scanSingleLayer(dir);
    for (const doc of layerDocs) {
      const key = doc.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Shallow-clone to attach source_layer without mutating cached object
      const copy: DocEntry = { ...doc, source_layer: dir };
      const extras = (doc as unknown as { [SEARCH_EXTRAS]?: SearchExtras })[SEARCH_EXTRAS];
      const internals = (doc as unknown as { [ENTRY_INTERNALS]?: EntryInternals })[ENTRY_INTERNALS];
      if (extras) {
        Object.defineProperty(copy, SEARCH_EXTRAS, { value: extras, enumerable: false });
      }
      if (internals) {
        Object.defineProperty(copy, ENTRY_INTERNALS, { value: internals, enumerable: false });
      }
      merged.push(copy);
    }
  }

  return merged;
}

export function getEntryInternals(doc: DocEntry): EntryInternals | undefined {
  return (doc as unknown as { [ENTRY_INTERNALS]?: EntryInternals })[ENTRY_INTERNALS];
}

export function getSearchExtras(doc: DocEntry): SearchExtras | undefined {
  return (doc as unknown as { [SEARCH_EXTRAS]?: SearchExtras })[SEARCH_EXTRAS];
}
