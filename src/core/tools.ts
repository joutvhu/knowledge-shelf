/**
 * MCP Tool implementations supporting single or multi-layer knowledge directories.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isReservedPath, resolveInsideDir } from './config.js';
import { scanDocuments } from './index-cache.js';
import { resolveModuleDetails, resolveWorkflowFilePath } from './manifest.js';
import {
  extractSections,
  findManifestFolders,
  findMdFiles,
  loadManifest,
  parseFrontmatter,
  walkDir,
} from './parser.js';
import { SearchOptions, rankDocuments } from './search.js';
import { executeWorkflowSteps } from './workflow.js';

export interface ToolResponse {
  text: string;
  isError?: boolean;
}

export interface ServerToolOptions {
  readOnly?: boolean;
  strictTrust?: boolean;
}

function toDirs(knowledgeDirs: string | string[]): string[] {
  return Array.isArray(knowledgeDirs) ? knowledgeDirs : [knowledgeDirs];
}

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

function findManifestFolderCaseInsensitive(knowledgeDir: string, name: string): string | null {
  const nameLower = name.toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!nameLower) return null;
  for (const folder of findManifestFolders(knowledgeDir)) {
    const rel = path.relative(knowledgeDir, folder).replace(/\\/g, '/').toLowerCase();
    if (rel === nameLower) return folder;
  }
  return null;
}

function resolveManifestFolderAcrossLayers(
  dirs: string[],
  name: string
): { folder?: string; layerDir?: string; error?: ToolResponse } {
  for (const dir of dirs) {
    const resolvedTarget = resolveInsideDir(dir, name, true);
    if (!resolvedTarget) {
      return {
        error: {
          text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
          isError: true,
        },
      };
    }
    if (isReservedPath(dir, resolvedTarget)) {
      return {
        error: {
          text: JSON.stringify({ error: 'Access denied. Reserved internal path.' }, null, 2),
          isError: true,
        },
      };
    }

    if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
      return { folder: resolvedTarget, layerDir: dir };
    }
    const ci = findManifestFolderCaseInsensitive(dir, name);
    if (ci) {
      return { folder: ci, layerDir: dir };
    }
  }
  return {};
}

function isUnitTrusted(layerDir: string, unitName: string): { trusted: boolean; reason?: string } {
  const registryPath = path.join(layerDir, '.registry.json');
  if (!fs.existsSync(registryPath)) {
    return { trusted: true };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as {
      sources?: Array<{ name?: string; url?: string; trusted?: boolean }>;
    };
    const entry = parsed.sources?.find((s) => s.name?.toLowerCase() === unitName.toLowerCase());
    if (!entry) return { trusted: true };
    if (entry.url?.startsWith('local:')) return { trusted: true };
    if (entry.trusted === true) return { trusted: true };
    return {
      trusted: false,
      reason:
        `Script execution blocked by strict trust policy for remote unit '${unitName}'. ` +
        `Run 'knowledge-shelf trust ${unitName}' to allow running its scripts.`,
    };
  } catch {
    return { trusted: false, reason: `Cannot verify trust state for '${unitName}'.` };
  }
}

export function toolListDocs(knowledgeDirs: string | string[]): ToolResponse {
  const dirs = toDirs(knowledgeDirs);
  const docs = scanDocuments(dirs);
  if (docs.length === 0) {
    return {
      text: JSON.stringify(
        {
          total: 0,
          knowledge_dir: dirs[0],
          ...(dirs.length > 1 ? { knowledge_dirs: dirs } : {}),
          message: 'No documents found.',
        },
        null,
        2
      ),
    };
  }
  return {
    text: JSON.stringify({ total: docs.length, documents: docs }, null, 2),
  };
}

export function toolSearchDocs(
  knowledgeDirs: string | string[],
  query: string,
  maxResults = 10,
  options: SearchOptions = {}
): ToolResponse {
  const dirs = toDirs(knowledgeDirs);
  const docs = scanDocuments(dirs);
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

  const scored = rankDocuments(docs, query, options);
  const results = scored.slice(0, maxResults);

  return {
    text: JSON.stringify({ query, total: results.length, results }, null, 2),
  };
}

export function toolGetDoc(knowledgeDirs: string | string[], name: string): ToolResponse {
  const dirs = toDirs(knowledgeDirs);

  // Check path containment on the primary pattern first
  for (const dir of dirs) {
    const resolvedTarget = resolveInsideDir(dir, name, true);
    if (!resolvedTarget) {
      return {
        text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
        isError: true,
      };
    }
    if (isReservedPath(dir, resolvedTarget)) {
      return {
        text: JSON.stringify({ error: 'Access denied. Reserved internal path.' }, null, 2),
        isError: true,
      };
    }
  }

  // 1. Try manifest-based folder across layers (exact or case-insensitive)
  const { folder: manifestFolder, error: folderErr } = resolveManifestFolderAcrossLayers(dirs, name);
  if (folderErr) return folderErr;

  if (manifestFolder) {
    const manifest = loadManifest(manifestFolder);
    if (manifest) {
      const deprecatedBanner =
        manifest.status === 'deprecated'
          ? `> **WARNING (deprecated):** This knowledge unit is deprecated.${
              manifest.superseded_by ? ` Superseded by \`${manifest.superseded_by}\`.` : ''
            }\n\n`
          : '';

      const docFile = manifest.doc;
      if (docFile && typeof docFile === 'string') {
        const docPath = resolveInsideDir(manifestFolder, docFile, true);
        if (!docPath) {
          return {
            text: JSON.stringify(
              { error: 'Access denied. Manifest doc path outside knowledge unit.' },
              null,
              2
            ),
            isError: true,
          };
        }
        if (fs.existsSync(docPath) && fs.statSync(docPath).isFile()) {
          try {
            const content = fs.readFileSync(docPath, 'utf-8');
            const { body } = parseFrontmatter(content);
            return { text: `directory: ${manifestFolder}\n---\n\n${deprecatedBanner}${body}` };
          } catch (e) {
            return {
              text: JSON.stringify({ error: `Failed to read ${docFile}: ${e}` }, null, 2),
              isError: true,
            };
          }
        }
      }
      const desc = manifest.description || 'No description available.';
      return { text: `directory: ${manifestFolder}\n---\n\n${deprecatedBanner}${desc}` };
    }
  }

  // 2. Try standalone .md file across layers
  let foundFilePath: string | null = null;
  for (const dir of dirs) {
    const resolvedTarget = resolveInsideDir(dir, name, true)!;
    if (fs.existsSync(resolvedTarget) && !fs.statSync(resolvedTarget).isDirectory()) {
      foundFilePath = resolvedTarget;
      break;
    }
    const found = findCaseInsensitive(dir, name);
    if (found) {
      const relFound = path.relative(dir, found);
      const safeFound = resolveInsideDir(dir, relFound, true);
      if (!safeFound || isReservedPath(dir, safeFound)) {
        return {
          text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
          isError: true,
        };
      }
      foundFilePath = safeFound;
      break;
    }
  }

  if (!foundFilePath) {
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

  try {
    const buf = fs.readFileSync(foundFilePath);
    if (buf.subarray(0, 8192).includes(0)) {
      return {
        text: JSON.stringify({ error: `Document '${name}' is binary and cannot be read as text.` }, null, 2),
        isError: true,
      };
    }
    const { body } = parseFrontmatter(buf.toString('utf-8'));
    return { text: `directory: ${path.dirname(foundFilePath)}\n---\n\n${body}` };
  } catch (e) {
    return {
      text: JSON.stringify({ error: `Failed to read: ${e}` }, null, 2),
      isError: true,
    };
  }
}

function extractMatchingSection(body: string, section: string): ToolResponse {
  const sections = extractSections(body);
  const sectionLower = section.toLowerCase().trim();

  if (!sectionLower) {
    return {
      text: JSON.stringify(
        {
          error: 'Section name cannot be empty.',
          available_sections: sections.map((s) => s.title),
        },
        null,
        2
      ),
      isError: true,
    };
  }

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

export function toolGetDocSection(
  knowledgeDirs: string | string[],
  name: string,
  section: string
): ToolResponse {
  const docResponse = toolGetDoc(knowledgeDirs, name);
  if (docResponse.isError) return docResponse;

  const docContent = docResponse.text;
  const separator = '\n---\n\n';
  const sepIdx = docContent.indexOf(separator);
  const body = sepIdx >= 0 ? docContent.slice(sepIdx + separator.length) : docContent;

  return extractMatchingSection(body, section);
}

export interface GetResourceOptions {
  offset?: number;
  limit?: number;
  section?: string;
}

export function toolGetResource(
  knowledgeDirs: string | string[],
  name: string,
  options: GetResourceOptions = {}
): ToolResponse {
  const dirs = toDirs(knowledgeDirs);

  for (const dir of dirs) {
    const resolvedCandidate = resolveInsideDir(dir, name, true);
    if (!resolvedCandidate) {
      return {
        text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
        isError: true,
      };
    }
    if (isReservedPath(dir, resolvedCandidate)) {
      return {
        text: JSON.stringify({ error: 'Access denied. Reserved internal path.' }, null, 2),
        isError: true,
      };
    }
  }

  let filePath: string | null = null;
  for (const dir of dirs) {
    const resolvedCandidate = resolveInsideDir(dir, name, true)!;
    if (fs.existsSync(resolvedCandidate)) {
      filePath = resolvedCandidate;
      break;
    }
    const found = findResourceCaseInsensitive(dir, name);
    if (found) {
      const relFound = path.relative(dir, found);
      const safeFound = resolveInsideDir(dir, relFound, true);
      if (!safeFound || isReservedPath(dir, safeFound)) {
        return {
          text: JSON.stringify({ error: 'Access denied. Path outside knowledge directory.' }, null, 2),
          isError: true,
        };
      }
      filePath = safeFound;
      break;
    }
  }

  if (!filePath) {
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

    const rawText = buf.toString('utf-8');

    if (options.section !== undefined) {
      const { body } = parseFrontmatter(rawText);
      return extractMatchingSection(body, options.section);
    }

    if (options.offset !== undefined || options.limit !== undefined) {
      const lines = rawText.split(/\r?\n/);
      const totalLines = lines.length;
      const startLine = Math.max(1, options.offset ?? 1);
      const maxLines = Math.max(1, options.limit ?? 200);
      const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);
      const endLine = startLine - 1 + slice.length;
      const header = `[lines ${startLine}-${endLine} of ${totalLines}]`;
      return { text: `${header}\n${slice.join('\n')}` };
    }

    return { text: rawText };
  } catch (e) {
    return {
      text: JSON.stringify({ error: `Failed to read: ${e}` }, null, 2),
      isError: true,
    };
  }
}

export function toolGetManifest(knowledgeDirs: string | string[], name: string): ToolResponse {
  const dirs = toDirs(knowledgeDirs);
  const { folder, error } = resolveManifestFolderAcrossLayers(dirs, name);
  if (error) return error;

  if (!folder) {
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
          hint: 'This is a standalone knowledge folder without structured metadata.',
        },
        null,
        2
      ),
      isError: true,
    };
  }

  const copy = { ...manifest } as Record<string, unknown>;
  copy._directory = folder;
  return { text: JSON.stringify(copy, null, 2) };
}

export function toolGetModule(
  knowledgeDirs: string | string[],
  name: string,
  moduleName: string,
  includeDependencies = true
): ToolResponse {
  const dirs = toDirs(knowledgeDirs);
  const { folder, error } = resolveManifestFolderAcrossLayers(dirs, name);
  if (error) return error;

  if (!folder) {
    return {
      text: JSON.stringify({ error: `Knowledge folder '${name}' not found.` }, null, 2),
      isError: true,
    };
  }

  const manifest = loadManifest(folder);
  if (!manifest) {
    return {
      text: JSON.stringify({ error: `No manifest.json in '${name}'.` }, null, 2),
      isError: true,
    };
  }

  const resolved = resolveModuleDetails(folder, manifest, moduleName, includeDependencies);
  if (resolved.error) {
    return {
      text: JSON.stringify({ error: resolved.error }, null, 2),
      isError: true,
    };
  }

  const unitRel = manifest.name || path.basename(folder);
  return {
    text: JSON.stringify(
      {
        unit: unitRel,
        module: moduleName,
        ordered_modules: resolved.ordered_modules,
        descriptions: resolved.descriptions,
        files: resolved.files.map((f) => `${unitRel}/${f}`),
        guides: resolved.guides.map((g) => ({ module: g.module, file: `${unitRel}/${g.guide}` })),
        ...(manifest.placeholders ? { placeholders: manifest.placeholders } : {}),
      },
      null,
      2
    ),
  };
}

export async function toolRunWorkflow(
  knowledgeDirs: string | string[],
  name: string,
  workflow: string,
  inputsArg: unknown,
  options: ServerToolOptions & { dryRun?: boolean } = {}
): Promise<ToolResponse> {
  const dirs = toDirs(knowledgeDirs);
  const { folder, layerDir, error } = resolveManifestFolderAcrossLayers(dirs, name);
  if (error) return error;

  if (!folder || !layerDir) {
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

  const manifest = loadManifest(folder);
  const workflowsDir = path.join(folder, 'workflows');
  const { workflowPath } = resolveWorkflowFilePath(folder, manifest, workflow);
  if (!workflowPath) {
    return {
      text: JSON.stringify({ error: 'Access denied. Invalid workflow name.' }, null, 2),
      isError: true,
    };
  }

  if (!fs.existsSync(workflowPath) || !fs.statSync(workflowPath).isFile()) {
    const availableSet = new Set<string>();
    if (manifest?.workflows && typeof manifest.workflows === 'object') {
      for (const k of Object.keys(manifest.workflows)) availableSet.add(k);
    }
    if (fs.existsSync(workflowsDir)) {
      for (const f of fs.readdirSync(workflowsDir)) {
        if (f.endsWith('.json')) availableSet.add(f.slice(0, -5));
      }
    }
    return {
      text: JSON.stringify(
        { error: `Workflow '${workflow}' not found.`, available_workflows: [...availableSet].sort() },
        null,
        2
      ),
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

  let blockRunReason: string | undefined;
  if (options.strictTrust) {
    const unitRel = path.relative(layerDir, folder).replace(/\\/g, '/');
    const trustCheck = isUnitTrusted(layerDir, unitRel);
    if (!trustCheck.trusted) {
      blockRunReason = trustCheck.reason;
    }
  }

  const steps = (workflowDef.steps || []) as Array<Record<string, unknown>>;
  const results = await executeWorkflowSteps(workflow, folder, steps, inputValues, {
    dryRun: options.dryRun,
    readOnly: options.readOnly,
    blockRunReason,
    manifest,
  });

  return {
    text: JSON.stringify(results, null, 2),
    isError: results.errors.length > 0,
  };
}
