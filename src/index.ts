#!/usr/bin/env node
/**
 * Knowledge Shelf MCP Server (Node.js / TypeScript)
 *
 * Provides AI-accessible documentation and automation from a knowledge/ folder.
 * Supports manifest-based knowledge units and legacy standalone .md files.
 *
 * Tools:
 * - list_docs:        List all available knowledge documents/units
 * - search_docs:      Search by keyword (title, tags, description, content)
 * - get_doc:          Retrieve doc content (manifest "doc" field or legacy .md)
 * - get_doc_section:  Retrieve a specific section from a document
 * - get_resource:     Retrieve any file from a knowledge folder
 * - get_manifest:     Retrieve manifest.json structured metadata
 * - run_workflow:     Execute a predefined workflow (copy, run, mkdir steps)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const KNOWLEDGE_DIR = resolveKnowledgeDir();
const IGNORED_FILES = new Set(['README.md', 'manifest.json']);

function resolveKnowledgeDir(): string {
  // Priority: KNOWLEDGE_DIR env var > first CLI arg > ~/.knowledge
  if (process.env.KNOWLEDGE_DIR) {
    return path.resolve(process.env.KNOWLEDGE_DIR);
  }
  const cliArg = process.argv[2];
  if (cliArg) {
    return path.resolve(cliArg);
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.resolve(home, '.knowledge');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocEntry {
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

interface Manifest {
  name?: string;
  description?: string;
  type?: string;
  version?: string;
  doc?: string;
  tags?: string[];
  modules?: Record<string, unknown>;
  workflows?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  references?: Record<string, unknown>;
  placeholders?: Record<string, unknown>;

  [key: string]: unknown;
}

interface WorkflowResults {
  workflow: string;
  steps_executed: number;
  files_created: string[];
  files_skipped: string[];
  scripts_run: Array<{ script: string; exit_code: number; stdout: string; stderr: string }>;
  messages: string[];
  errors: string[];
  summary?: string;
}

// ---------------------------------------------------------------------------
// Manifest Handling
// ---------------------------------------------------------------------------

function loadManifest(folder: string): Manifest | null {
  const manifestPath = path.join(folder, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as Manifest;
  } catch {
    return null;
  }
}

function findManifestFolders(): string[] {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  const folders: string[] = [];
  walkDir(KNOWLEDGE_DIR, (filePath) => {
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
// File System Helpers
// ---------------------------------------------------------------------------

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

function findMdFiles(dir: string): string[] {
  const files: string[] = [];
  walkDir(dir, (filePath) => {
    if (filePath.endsWith('.md') && !IGNORED_FILES.has(path.basename(filePath))) {
      files.push(filePath);
    }
  });
  return files.sort();
}

// ---------------------------------------------------------------------------
// Document Parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } {
  const metadata: Record<string, unknown> = {};
  let body = content;

  if (content.startsWith('---')) {
    const parts = content.split('---', 3);
    if (parts.length >= 3) {
      const frontmatterText = parts[1].trim();
      body = parts.slice(2).join('---').trim();

      for (const line of frontmatterText.split(/\r?\n/)) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const key = trimmed.slice(0, colonIdx).trim();
          let value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
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

function extractTitle(metadata: Record<string, unknown>, body: string, filename: string): string {
  if (metadata.title && typeof metadata.title === 'string') return metadata.title;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  return path.basename(filename, '.md').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractSections(body: string): Array<{ level: number; title: string; line: number; end_line: number }> {
  const sections: Array<{ level: number; title: string; line: number; end_line: number }> = [];
  const lines = body.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      sections.push({level: match[1].length, title: match[2].trim(), line: i, end_line: 0});
    }
  }

  for (let i = 0; i < sections.length; i++) {
    sections[i].end_line = i + 1 < sections.length ? sections[i + 1].line - 1 : lines.length - 1;
  }

  return sections;
}

function normalizeListField(metadata: Record<string, unknown>, ...keys: string[]): string[] {
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
// Scanning
// ---------------------------------------------------------------------------

function scanDocuments(): DocEntry[] {
  const docs: DocEntry[] = [];
  if (!fs.existsSync(KNOWLEDGE_DIR)) return docs;

  const manifestFolders = findManifestFolders();

  // Index manifest-based knowledge units
  for (const folder of manifestFolders) {
    const manifest = loadManifest(folder);
    if (!manifest) continue;

    const relFolder = path.relative(KNOWLEDGE_DIR, folder).replace(/\\/g, '/');
    const entry: DocEntry = {
      name: relFolder,
      title: manifest.name || relFolder,
      description: manifest.description || '',
      type: manifest.type || 'unknown',
      version: manifest.version || '',
      tags: manifest.tags || [],
      has_manifest: true,
    };

    if (manifest.modules) entry.modules = Object.keys(manifest.modules);
    if (manifest.workflows) entry.workflows = Object.keys(manifest.workflows);
    if (manifest.scripts) entry.scripts = Object.keys(manifest.scripts);
    if (manifest.references) entry.references = Object.keys(manifest.references);

    docs.push(entry);
  }

  // Index legacy .md files (not inside manifest folders)
  const mdFiles = findMdFiles(KNOWLEDGE_DIR);
  for (const filePath of mdFiles) {
    if (isInsideManifestFolder(filePath, manifestFolders)) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const {metadata, body} = parseFrontmatter(content);
    const relPath = path.relative(KNOWLEDGE_DIR, filePath).replace(/\\/g, '/');
    const title = extractTitle(metadata, body, path.basename(filePath));
    const tags = normalizeListField(metadata, 'tags', 'keywords');
    const aliases = normalizeListField(metadata, 'aliases');

    let description = typeof metadata.description === 'string' ? metadata.description : '';
    if (!description) {
      for (const line of body.split(/\r?\n/)) {
        const stripped = line.trim();
        if (stripped && !stripped.startsWith('#')) {
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

// ---------------------------------------------------------------------------
// Search Scoring
// ---------------------------------------------------------------------------

function searchScore(doc: DocEntry, queryTerms: string[]): number {
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
    if (aliasesLower.includes(t)) score += 12;
    if (titleLower.includes(t)) score += 10;
    if (tagsLower.includes(t)) score += 8;
    if (typeLower.includes(t)) score += 7;
    if (modulesLower.includes(t)) score += 6;
    if (nameLower.includes(t)) score += 6;
    if (sectionsLower.includes(t)) score += 4;
    if (descLower.includes(t)) score += 2;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Case-Insensitive Finders
// ---------------------------------------------------------------------------

function findCaseInsensitive(name: string): string | null {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return null;
  const nameLower = name.toLowerCase().replace(/\\/g, '/');

  const mdFiles = findMdFiles(KNOWLEDGE_DIR);
  for (const filePath of mdFiles) {
    const rel = path.relative(KNOWLEDGE_DIR, filePath).replace(/\\/g, '/');
    if (rel.toLowerCase() === nameLower) return filePath;
  }

  // Filename stem match
  const targetStem = path.basename(name, '.md').toLowerCase();
  for (const filePath of mdFiles) {
    if (path.basename(filePath, '.md').toLowerCase() === targetStem) return filePath;
  }

  return null;
}

function findResourceCaseInsensitive(name: string): string | null {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return null;
  const nameLower = name.toLowerCase().replace(/\\/g, '/');

  let found: string | null = null;
  walkDir(KNOWLEDGE_DIR, (filePath) => {
    if (found) return;
    const rel = path.relative(KNOWLEDGE_DIR, filePath).replace(/\\/g, '/');
    if (rel.toLowerCase() === nameLower) found = filePath;
  });

  return found;
}

// ---------------------------------------------------------------------------
// Security Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a user-supplied name/path relative to KNOWLEDGE_DIR and verifies
 * the result stays inside KNOWLEDGE_DIR. Returns the resolved absolute path,
 * or null if the path escapes the knowledge directory.
 * Uses realpathSync to follow symlinks and prevent symlink traversal attacks.
 */
function resolveInsideKnowledgeDir(name: string): string | null {
  try {
    const candidate = path.resolve(KNOWLEDGE_DIR, name);
    const canonicalBase = fs.realpathSync(KNOWLEDGE_DIR);
    const canonical = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
    if (canonical !== canonicalBase && !canonical.startsWith(canonicalBase + path.sep)) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workflow Execution
// ---------------------------------------------------------------------------

function replacePlaceholders(text: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
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

  const sourcePath = path.join(folder, sourceRel);
  const targetPath = replacePlaceholders(targetTemplate, inputs);

  if (skipIfExists && fs.existsSync(targetPath)) {
    results.files_skipped.push(sourceRel);
    return;
  }

  if (!fs.existsSync(sourcePath)) {
    results.errors.push(`Source not found: ${sourceRel}`);
    return;
  }

  let content = fs.readFileSync(sourcePath, 'utf-8');
  content = replacePlaceholders(content, inputs);

  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  fs.writeFileSync(targetPath, content, 'utf-8');
  results.files_created.push(targetPath);
}

function executeRunStep(
  step: Record<string, unknown>,
  folder: string,
  inputs: Record<string, string>,
  results: WorkflowResults
): void {
  const scriptRel = String(step.script || '');
  const argsTemplate = (step.args as string[]) || [];
  let interpreter = step.interpreter as string | undefined;

  const scriptPath = path.join(folder, scriptRel);

  // Ensure script is inside the workflow's folder — prevent ../traversal via workflow JSON
  const resolvedScript = path.resolve(scriptPath);
  const resolvedFolder = path.resolve(folder);
  if (!resolvedScript.startsWith(resolvedFolder + path.sep) && resolvedScript !== resolvedFolder) {
    results.errors.push(`Script path '${scriptRel}' is outside the knowledge unit folder.`);
    return;
  }

  if (!fs.existsSync(scriptPath)) {
    results.errors.push(`Script not found: ${scriptRel}`);
    return;
  }

  const args = argsTemplate.map((a) => replacePlaceholders(a, inputs));

  if (!interpreter) {
    const ext = path.extname(scriptPath).toLowerCase();
    const interpreterMap: Record<string, string> = {
      '.py': 'python',
      '.js': 'node',
      '.ps1': 'pwsh',
      '.sh': 'bash',
    };
    interpreter = interpreterMap[ext] || 'node';
  }

  // Whitelist allowed interpreters to prevent injection via the interpreter field
  const allowedInterpreters = new Set(['python', 'python3', 'node', 'pwsh', 'powershell', 'bash', 'sh']);
  if (!allowedInterpreters.has(interpreter.toLowerCase())) {
    results.errors.push(`Interpreter '${interpreter}' is not allowed.`);
    return;
  }

  // Use spawnSync with array args — never shell: true — to prevent command injection
  const result = spawnSync(interpreter, [scriptPath, ...args], {
    cwd: folder,
    timeout: 120_000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = (result.stdout || '').slice(0, 2000);
  const stderr = (result.stderr || '').slice(0, 1000);
  const exitCode = result.status ?? 1;

  results.scripts_run.push({script: scriptRel, exit_code: exitCode, stdout, stderr});

  if (exitCode !== 0) {
    results.errors.push(`Script '${scriptRel}' exited with code ${exitCode}: ${stderr.slice(0, 200)}`);
  }
}

function executeMkdirStep(step: Record<string, unknown>, inputs: Record<string, string>): void {
  const pathTemplate = String(step.path || '');
  const dirPath = replacePlaceholders(pathTemplate, inputs);
  fs.mkdirSync(dirPath, {recursive: true});
}

// ---------------------------------------------------------------------------
// Tool Implementations
// ---------------------------------------------------------------------------

function toolListDocs(): string {
  const docs = scanDocuments();
  if (docs.length === 0) {
    return JSON.stringify({total: 0, knowledge_dir: KNOWLEDGE_DIR, message: 'No documents found.'}, null, 2);
  }
  return JSON.stringify({total: docs.length, documents: docs}, null, 2);
}

function toolSearchDocs(query: string, maxResults = 10): string {
  const docs = scanDocuments();
  if (docs.length === 0) {
    return JSON.stringify({query, total: 0, message: 'No documents.'}, null, 2);
  }

  const queryTerms = query.trim().split(/\s+/);
  if (queryTerms.length === 0 || (queryTerms.length === 1 && queryTerms[0] === '')) {
    return JSON.stringify({query, total: 0, message: 'Empty query.'}, null, 2);
  }

  const scored: Array<DocEntry & { relevance_score: number }> = [];
  for (const doc of docs) {
    const score = searchScore(doc, queryTerms);
    if (score > 0) scored.push({...doc, relevance_score: score});
  }

  scored.sort((a, b) => b.relevance_score - a.relevance_score);
  const results = scored.slice(0, maxResults);

  return JSON.stringify({query, total: results.length, results}, null, 2);
}

function toolGetDoc(name: string): string {
  // Validate path stays inside KNOWLEDGE_DIR
  const resolvedFolder = resolveInsideKnowledgeDir(name);
  if (!resolvedFolder) {
    return JSON.stringify({error: 'Access denied. Path outside knowledge directory.'}, null, 2);
  }

  // Try as manifest-based folder first
  const folder = path.join(KNOWLEDGE_DIR, name);
  if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
    const manifest = loadManifest(folder);

    if (manifest) {
      const docFile = manifest.doc;
      if (docFile && typeof docFile === 'string') {
        const docPath = path.join(folder, docFile);
        if (fs.existsSync(docPath)) {
          try {
            const content = fs.readFileSync(docPath, 'utf-8');
            const {body} = parseFrontmatter(content);
            return `directory: ${folder}\n---\n\n${body}`;
          } catch (e) {
            return `directory: ${folder}\n---\n\nError reading ${docFile}: ${e}`;
          }
        }
      }
      const desc = manifest.description || 'No description available.';
      return `directory: ${folder}\n---\n\n${desc}`;
    }
  }

  // Try as legacy .md file
  let filePath = path.join(KNOWLEDGE_DIR, name);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const found = findCaseInsensitive(name);
    if (!found) {
      return JSON.stringify({
        error: `Document '${name}' not found.`,
        hint: 'Use list_docs() to see available documents.'
      }, null, 2);
    }
    filePath = found;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const {body} = parseFrontmatter(content);
    return `directory: ${path.dirname(filePath)}\n---\n\n${body}`;
  } catch (e) {
    return JSON.stringify({error: `Failed to read: ${e}`}, null, 2);
  }
}

function toolGetDocSection(name: string, section: string): string {
  const docContent = toolGetDoc(name);

  // If it's an error response (JSON), return it
  if (docContent.startsWith('{')) return docContent;

  // Strip the directory header
  let body: string;
  if (docContent.includes('\n---\n\n')) {
    body = docContent.split('\n---\n\n').slice(1).join('\n---\n\n');
  } else {
    body = docContent;
  }

  const lines = body.split(/\r?\n/);
  const sectionLower = section.toLowerCase().trim();
  let startLine: number | null = null;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const headingText = match[2].trim().toLowerCase();
      if (headingText.includes(sectionLower) || sectionLower.includes(headingText)) {
        startLine = i;
        startLevel = match[1].length;
        break;
      }
    }
  }

  if (startLine === null) {
    const sections = extractSections(body);
    return JSON.stringify({
      error: `Section '${section}' not found.`,
      available_sections: sections.map((s) => s.title)
    }, null, 2);
  }

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= startLevel) {
      endLine = i;
      break;
    }
  }

  return lines.slice(startLine, endLine).join('\n').trim();
}

function toolGetResource(name: string): string {
  let filePath = path.join(KNOWLEDGE_DIR, name);

  if (!fs.existsSync(filePath)) {
    const found = findResourceCaseInsensitive(name);
    if (!found) {
      return JSON.stringify({
        error: `Resource '${name}' not found.`,
        hint: 'Use get_manifest() to see available resources.'
      }, null, 2);
    }
    filePath = found;
  }

  // Security check — ensure path is inside KNOWLEDGE_DIR
  const resolved = fs.existsSync(filePath) ? fs.realpathSync(filePath) : path.resolve(filePath);
  const resolvedBase = fs.realpathSync(KNOWLEDGE_DIR);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return JSON.stringify({error: 'Access denied. Path outside knowledge directory.'}, null, 2);
  }

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (e instanceof Error && e.message.includes('encoding')) {
      return JSON.stringify({
        error: `Resource '${name}' is binary and cannot be read as text.`,
        path: filePath
      }, null, 2);
    }
    return JSON.stringify({error: `Failed to read: ${e}`}, null, 2);
  }
}

function toolGetManifest(name: string): string {
  // Validate path stays inside KNOWLEDGE_DIR
  if (!resolveInsideKnowledgeDir(name)) {
    return JSON.stringify({error: 'Access denied. Path outside knowledge directory.'}, null, 2);
  }

  const folder = path.join(KNOWLEDGE_DIR, name);

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return JSON.stringify({
      error: `Knowledge folder '${name}' not found.`,
      hint: 'Use list_docs() to see available knowledge units.'
    }, null, 2);
  }

  const manifest = loadManifest(folder);
  if (!manifest) {
    return JSON.stringify({
      error: `No manifest.json in '${name}'.`,
      hint: 'This is a legacy knowledge folder without structured metadata.'
    }, null, 2);
  }

  (manifest as Record<string, unknown>)._directory = folder;
  return JSON.stringify(manifest, null, 2);
}

function toolRunWorkflow(name: string, workflow: string, inputsArg: unknown): string {
  // Validate path stays inside KNOWLEDGE_DIR
  if (!resolveInsideKnowledgeDir(name)) {
    return JSON.stringify({error: 'Access denied. Path outside knowledge directory.'}, null, 2);
  }

  const folder = path.join(KNOWLEDGE_DIR, name);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return JSON.stringify({error: `Knowledge folder '${name}' not found.`}, null, 2);
  }

  let inputValues: Record<string, string>;
  try {
    if (!inputsArg || typeof inputsArg !== 'object' || Array.isArray(inputsArg)) {
      inputValues = {};
    } else {
      // Coerce all values to string (workflow placeholders are always strings)
      inputValues = Object.fromEntries(
        Object.entries(inputsArg as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      );
    }
  } catch (e) {
    return JSON.stringify({error: `Invalid inputs: ${e}`}, null, 2);
  }

  const workflowPath = path.join(folder, 'workflows', `${workflow}.json`);
  if (!fs.existsSync(workflowPath)) {
    const workflowsDir = path.join(folder, 'workflows');
    let available: string[] = [];
    if (fs.existsSync(workflowsDir)) {
      available = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    }
    return JSON.stringify({error: `Workflow '${workflow}' not found.`, available_workflows: available}, null, 2);
  }

  let workflowDef: Record<string, unknown>;
  try {
    workflowDef = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
  } catch (e) {
    return JSON.stringify({error: `Failed to load workflow: ${e}`}, null, 2);
  }

  // Validate required inputs
  const workflowInputs = (workflowDef.inputs || {}) as Record<string, { required?: boolean }>;
  const missing = Object.entries(workflowInputs)
    .filter(([, v]) => v.required)
    .map(([k]) => k)
    .filter((k) => !(k in inputValues));

  if (missing.length > 0) {
    return JSON.stringify({
      error: `Missing required inputs: ${JSON.stringify(missing)}`,
      workflow_inputs: workflowInputs
    }, null, 2);
  }

  // Execute steps
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
        executeMkdirStep(step, inputValues);
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

  return JSON.stringify(results, null, 2);
}

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: 'knowledge-shelf',
    version: '1.0.2'
  },
  {
    capabilities: {tools: {}},
    instructions: `You have access to a personal knowledge base via the knowledge-shelf tools. Use these tools proactively to find relevant documentation, code patterns, templates, and workflows before answering questions or starting implementation tasks.

## When to use these tools

- **Starting a task**: search_docs first to find relevant knowledge units, patterns, or guides.
- **Unfamiliar library or framework**: search_docs for docs, then get_doc or get_doc_section for details.
- **Scaffolding or boilerplate**: search_docs for templates/boilerplate, then run_workflow to automate setup.
- **Coding standards or conventions**: search_docs for team guides before writing code.
- **Unsure what's available**: list_docs to see everything in the knowledge base.

## Recommended workflow

1. **search_docs** — find relevant units by keyword (title, tags, type, modules, aliases all scored).
2. **get_manifest** — inspect a manifest-based unit to see its modules, workflows, scripts, and references.
3. **get_doc** — read the main documentation of a unit or standalone .md file.
4. **get_doc_section** — read a specific section when you only need part of a document.
5. **get_resource** — retrieve a code file, template, config, or reference doc by path.
6. **run_workflow** — execute a predefined workflow to scaffold files, run scripts, or automate setup. Always call get_manifest first to discover available workflows and their required inputs.
7. **list_docs** — enumerate all available documents and units when you need a full overview.

## Two knowledge formats

- **Manifest-based units** (folders with manifest.json): structured knowledge with modules, workflows, scripts, and references. Use get_manifest to understand structure before diving in.
- **Standalone .md files**: simple documentation. Use get_doc or get_doc_section to read them.

## Tips

- Search terms are space-separated; aliases and titles score highest.
- get_doc_section is more efficient than get_doc when you only need one section of a large document.
- run_workflow has side effects (creates files, runs scripts) — confirm required inputs with get_manifest before calling it.
- Paths passed to get_resource, get_doc, and get_manifest are relative to the knowledge directory root.`
  }
);

// Register tools
server.registerTool(
  'list_docs',
  {
    description: 'List all available knowledge base documents and units. Returns manifest-based knowledge units (with modules, workflows, scripts) and legacy .md documents. Use when you need a full overview of what knowledge is available.'
  },
  async () => {
    return {
      content: [{ type: 'text', text: toolListDocs() }]
    };
  }
);

server.registerTool(
  'search_docs',
  {
    description: 'Search knowledge base by keyword. Call this first before starting any task — it finds relevant documentation, code patterns, templates, and guides. Searches titles, tags, descriptions, module names, type, and aliases. Returns ranked results. Aliases and titles score highest; terms are space-separated.',
    inputSchema: z.object({
      query: z.string().describe('Search keywords (space-separated)'),
      max_results: z.number().optional().describe('Maximum results to return (default: 10)')
    })
  },
  async ({ query, max_results }) => {
    return {
      content: [{ type: 'text', text: toolSearchDocs(query, max_results) }]
    };
  }
);

server.registerTool(
  'get_doc',
  {
    description: 'Retrieve the main document content of a knowledge unit or legacy .md file. For manifest-based units: returns the file specified by the manifest "doc" field. For legacy .md files: returns the file content without frontmatter. Prefer get_doc_section when you only need a specific section of a large document.',
    inputSchema: z.object({
      name: z.string().describe('Knowledge unit folder name or legacy .md path (relative to knowledge directory root)')
    })
  },
  async ({ name }) => {
    return {
      content: [{ type: 'text', text: toolGetDoc(name) }]
    };
  }
);

server.registerTool(
  'get_doc_section',
  {
    description: 'Retrieve a specific section from a document by heading text. More efficient than get_doc when you only need part of a large document — saves context. Returns content under the matched heading up to the next heading of the same or higher level. Heading match is case-insensitive and partial.',
    inputSchema: z.object({
      name: z.string().describe('Document path or knowledge unit name (relative to knowledge directory root)'),
      section: z.string().describe('Section heading text (case-insensitive, partial match supported)')
    })
  },
  async ({ name, section }) => {
    return {
      content: [{ type: 'text', text: toolGetDocSection(name, section) }]
    };
  }
);

server.registerTool(
  'get_resource',
  {
    description: 'Retrieve any file from a knowledge unit as text — code files, templates, configs, reference docs, scripts. Use get_manifest first to discover available file paths within a unit. Path is relative to the knowledge directory root (e.g. "my-unit/src/BasePage.java").',
    inputSchema: z.object({
      name: z.string().describe('File path relative to knowledge directory root (e.g. "my-unit/references/guide.md")')
    })
  },
  async ({ name }) => {
    return {
      content: [{ type: 'text', text: toolGetResource(name) }]
    };
  }
);

server.registerTool(
  'get_manifest',
  {
    description: 'Retrieve the manifest.json of a manifest-based knowledge unit. Returns structured metadata: modules (with files and dependencies), workflows, scripts, references, and placeholders. Always call this before run_workflow to discover available workflows and their required inputs.',
    inputSchema: z.object({
      name: z.string().describe('Knowledge unit folder name (relative to knowledge directory root)')
    })
  },
  async ({ name }) => {
    return {
      content: [{ type: 'text', text: toolGetManifest(name) }]
    };
  }
);

server.registerTool(
  'run_workflow',
  {
    description: 'Execute a predefined workflow from a knowledge unit. Workflows automate multi-step tasks: copying templates, running scripts, creating directories. Has side effects — creates files and runs scripts. Always call get_manifest first to discover available workflows and their required inputs before calling this tool.',
    inputSchema: z.object({
      name: z.string().describe('Knowledge unit folder name'),
      workflow: z.string().describe('Workflow name (from manifest workflows keys)'),
      inputs: z.record(z.string(), z.string()).optional().describe('Input values for workflow placeholders (e.g. {"TARGET": "/path/to/project", "NAME": "my-app"})')
    })
  },
  async ({ name, workflow, inputs }) => {
    return {
      content: [{ type: 'text', text: toolRunWorkflow(name, workflow, inputs) }]
    };
  }
);

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

const CLI_COMMANDS = new Set(['add', 'info', 'search', 'list', 'ls', 'update', 'up', 'pin', 'unpin', 'export', 'remove', 'rm', 'init', 'validate', 'help', '--help', '-h']);

async function main() {
  // Detect CLI mode: if first non-path arg is a known command, run CLI
  const firstArg = process.argv[2];
  if (firstArg && CLI_COMMANDS.has(firstArg)) {
    const {runCli} = await import('./cli.js');
    runCli(process.argv.slice(2));
    return;
  }

  // Otherwise, start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Knowledge Shelf MCP server running (knowledge_dir: ${KNOWLEDGE_DIR})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
