#!/usr/bin/env node
/**
 * Test helper — calls knowledge-shelf tool functions directly.
 *
 * Usage: node tool-helper.mjs <toolName> [--arg value ...]
 *
 * Requires KNOWLEDGE_DIR env var to be set.
 * Outputs the tool result to stdout.
 *
 * This avoids starting the MCP server (which needs stdio transport).
 * Instead, we replicate the tool dispatch logic from index.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const toolName = args[0];
const params = {};

for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith("--") && i + 1 < args.length) {
    const key = args[i].slice(2);
    let value = args[++i];
    // Support passing complex values via env var
    if (value === "__ENV_TOOL_INPUTS__") {
      value = process.env.TOOL_INPUTS || "";
    }
    params[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Configuration (mirrors index.ts)
// ---------------------------------------------------------------------------

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.resolve(process.cwd(), "knowledge");
const IGNORED_FILES = new Set(["README.md", "manifest.json"]);

// ---------------------------------------------------------------------------
// Core functions (copied from compiled output for test isolation)
// ---------------------------------------------------------------------------

function walkDir(dir, callback) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

function findMdFiles(dir) {
  const files = [];
  walkDir(dir, (filePath) => {
    if (filePath.endsWith(".md") && !IGNORED_FILES.has(path.basename(filePath))) {
      files.push(filePath);
    }
  });
  return files.sort();
}

function loadManifest(folder) {
  const manifestPath = path.join(folder, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch { return null; }
}

function findManifestFolders() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  const folders = [];
  walkDir(KNOWLEDGE_DIR, (filePath) => {
    if (path.basename(filePath) === "manifest.json") {
      folders.push(path.dirname(filePath));
    }
  });
  return folders.sort();
}

function isInsideManifestFolder(filePath, manifestFolders) {
  const normalized = path.resolve(filePath);
  for (const mf of manifestFolders) {
    const normalizedMf = path.resolve(mf);
    if (normalized === normalizedMf || normalized.startsWith(normalizedMf + path.sep)) return true;
  }
  return false;
}

function parseFrontmatter(content) {
  const metadata = {};
  let body = content;
  if (content.startsWith("---")) {
    const parts = content.split("---", 3);
    if (parts.length >= 3) {
      const frontmatterText = parts[1].trim();
      body = parts.slice(2).join("---").trim();
      for (const line of frontmatterText.split("\n")) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
          const key = trimmed.slice(0, colonIdx).trim();
          let value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (value.includes(",") && ["tags", "keywords", "aliases"].includes(key)) {
            metadata[key] = value.split(",").map(v => v.trim());
          } else {
            metadata[key] = value;
          }
        }
      }
    }
  }
  return { metadata, body };
}

function extractTitle(metadata, body, filename) {
  if (metadata.title && typeof metadata.title === "string") return metadata.title;
  for (const line of body.split("\n")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return path.basename(filename, ".md").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function extractSections(body) {
  const sections = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,4})\s+(.+)$/);
    if (match) sections.push({ level: match[1].length, title: match[2].trim(), line: i, end_line: 0 });
  }
  for (let i = 0; i < sections.length; i++) {
    sections[i].end_line = i + 1 < sections.length ? sections[i + 1].line - 1 : lines.length - 1;
  }
  return sections;
}

function normalizeListField(metadata, ...keys) {
  for (const key of keys) {
    const value = metadata[key];
    if (value != null) {
      if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
      if (typeof value === "string" && value.trim()) return value.split(",").map(v => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function scanDocuments() {
  const docs = [];
  if (!fs.existsSync(KNOWLEDGE_DIR)) return docs;
  const manifestFolders = findManifestFolders();

  for (const folder of manifestFolders) {
    const manifest = loadManifest(folder);
    if (!manifest) continue;
    const relFolder = path.relative(KNOWLEDGE_DIR, folder).replace(/\\/g, "/");
    const entry = {
      name: relFolder, title: manifest.name || relFolder,
      description: manifest.description || "", type: manifest.type || "unknown",
      version: manifest.version || "", tags: manifest.tags || [], has_manifest: true,
    };
    if (manifest.modules) entry.modules = Object.keys(manifest.modules);
    if (manifest.workflows) entry.workflows = Object.keys(manifest.workflows);
    if (manifest.scripts) entry.scripts = Object.keys(manifest.scripts);
    if (manifest.references) entry.references = Object.keys(manifest.references);
    docs.push(entry);
  }

  const mdFiles = findMdFiles(KNOWLEDGE_DIR);
  for (const filePath of mdFiles) {
    if (isInsideManifestFolder(filePath, manifestFolders)) continue;
    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }
    const { metadata, body } = parseFrontmatter(content);
    const relPath = path.relative(KNOWLEDGE_DIR, filePath).replace(/\\/g, "/");
    const title = extractTitle(metadata, body, path.basename(filePath));
    const tags = normalizeListField(metadata, "tags", "keywords");
    const aliases = normalizeListField(metadata, "aliases");
    let description = typeof metadata.description === "string" ? metadata.description : "";
    if (!description) {
      for (const line of body.split("\n")) {
        const stripped = line.trim();
        if (stripped && !stripped.startsWith("#")) { description = stripped.slice(0, 200); break; }
      }
    }
    const sections = extractSections(body);
    docs.push({ name: relPath, title, description, tags, aliases, sections: sections.map(s => s.title), has_manifest: false });
  }
  return docs;
}

function searchScore(doc, queryTerms) {
  let score = 0;
  const titleLower = (doc.title || "").toLowerCase();
  const descLower = (doc.description || "").toLowerCase();
  const tagsLower = (doc.tags || []).join(" ").toLowerCase();
  const aliasesLower = (doc.aliases || []).join(" ").toLowerCase();
  const nameLower = (doc.name || "").toLowerCase();
  const sectionsLower = (doc.sections || []).join(" ").toLowerCase();
  const modulesLower = (doc.modules || []).join(" ").toLowerCase();
  const typeLower = (doc.type || "").toLowerCase();
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

function findCaseInsensitive(name) {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return null;
  const nameLower = name.toLowerCase().replace(/\\/g, "/");
  const mdFiles = findMdFiles(KNOWLEDGE_DIR);
  for (const filePath of mdFiles) {
    const rel = path.relative(KNOWLEDGE_DIR, filePath).replace(/\\/g, "/");
    if (rel.toLowerCase() === nameLower) return filePath;
  }
  const targetStem = path.basename(name, ".md").toLowerCase();
  for (const filePath of mdFiles) {
    if (path.basename(filePath, ".md").toLowerCase() === targetStem) return filePath;
  }
  return null;
}

function findResourceCaseInsensitive(name) {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return null;
  const nameLower = name.toLowerCase().replace(/\\/g, "/");
  let found = null;
  walkDir(KNOWLEDGE_DIR, (filePath) => {
    if (found) return;
    const rel = path.relative(KNOWLEDGE_DIR, filePath).replace(/\\/g, "/");
    if (rel.toLowerCase() === nameLower) found = filePath;
  });
  return found;
}

function replacePlaceholders(text, values) {
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolListDocs() {
  const docs = scanDocuments();
  if (docs.length === 0) return JSON.stringify({ total: 0, knowledge_dir: KNOWLEDGE_DIR, message: "No documents found." }, null, 2);
  return JSON.stringify({ total: docs.length, documents: docs }, null, 2);
}

function toolSearchDocs(query, maxResults = 10) {
  const docs = scanDocuments();
  if (docs.length === 0) return JSON.stringify({ query, total: 0, message: "No documents." }, null, 2);
  const queryTerms = query.trim().split(/\s+/);
  if (queryTerms.length === 0 || (queryTerms.length === 1 && queryTerms[0] === "")) {
    return JSON.stringify({ query, total: 0, message: "Empty query." }, null, 2);
  }
  const scored = [];
  for (const doc of docs) {
    const score = searchScore(doc, queryTerms);
    if (score > 0) scored.push({ ...doc, relevance_score: score });
  }
  scored.sort((a, b) => b.relevance_score - a.relevance_score);
  return JSON.stringify({ query, total: scored.slice(0, maxResults).length, results: scored.slice(0, maxResults) }, null, 2);
}

function toolGetDoc(name) {
  const folder = path.join(KNOWLEDGE_DIR, name);
  if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
    const manifest = loadManifest(folder);
    if (manifest) {
      const docFile = manifest.doc;
      if (docFile && typeof docFile === "string") {
        const docPath = path.join(folder, docFile);
        if (fs.existsSync(docPath)) {
          try {
            const content = fs.readFileSync(docPath, "utf-8");
            const { body } = parseFrontmatter(content);
            return `directory: ${folder}\n---\n\n${body}`;
          } catch (e) { return `directory: ${folder}\n---\n\nError reading ${docFile}: ${e}`; }
        }
      }
      return `directory: ${folder}\n---\n\n${manifest.description || "No description available."}`;
    }
  }
  let filePath = path.join(KNOWLEDGE_DIR, name);
  if (!fs.existsSync(filePath)) {
    const found = findCaseInsensitive(name);
    if (!found) return JSON.stringify({ error: `Document '${name}' not found.`, hint: "Use list_docs() to see available documents." }, null, 2);
    filePath = found;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { body } = parseFrontmatter(content);
    return `directory: ${path.dirname(filePath)}\n---\n\n${body}`;
  } catch (e) { return JSON.stringify({ error: `Failed to read: ${e}` }, null, 2); }
}

function toolGetDocSection(name, section) {
  const docContent = toolGetDoc(name);
  if (docContent.startsWith("{")) return docContent;
  let body;
  if (docContent.includes("\n---\n\n")) { body = docContent.split("\n---\n\n").slice(1).join("\n---\n\n"); }
  else { body = docContent; }
  const lines = body.split(/\r?\n/);
  const sectionLower = section.toLowerCase().trim();
  let startLine = null, startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const headingText = match[2].trim().toLowerCase();
      if (headingText.includes(sectionLower) || sectionLower.includes(headingText)) {
        startLine = i; startLevel = match[1].length; break;
      }
    }
  }
  if (startLine === null) {
    const sections = extractSections(body);
    return JSON.stringify({ error: `Section '${section}' not found.`, available_sections: sections.map(s => s.title) }, null, 2);
  }
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= startLevel) { endLine = i; break; }
  }
  return lines.slice(startLine, endLine).join("\n").trim();
}

function toolGetResource(name) {
  let filePath = path.join(KNOWLEDGE_DIR, name);
  if (!fs.existsSync(filePath)) {
    const found = findResourceCaseInsensitive(name);
    if (!found) return JSON.stringify({ error: `Resource '${name}' not found.`, hint: "Use get_manifest() to see available resources." }, null, 2);
    filePath = found;
  }
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(KNOWLEDGE_DIR);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return JSON.stringify({ error: "Access denied.  Path outside knowledge directory." }, null, 2);
  }
  try { return fs.readFileSync(filePath, "utf-8"); }
  catch (e) { return JSON.stringify({ error: `Failed to read: ${e}` }, null, 2); }
}

function toolGetManifest(name) {
  const folder = path.join(KNOWLEDGE_DIR, name);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return JSON.stringify({ error: `Knowledge folder '${name}' not found.`, hint: "Use list_docs() to see available knowledge units." }, null, 2);
  }
  const manifest = loadManifest(folder);
  if (!manifest) return JSON.stringify({ error: `No manifest.json in '${name}'.`, hint: "This is a legacy knowledge folder without structured metadata." }, null, 2);
  manifest._directory = folder;
  return JSON.stringify(manifest, null, 2);
}

function toolRunWorkflow(name, workflow, inputsJson) {
  const folder = path.join(KNOWLEDGE_DIR, name);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return JSON.stringify({ error: `Knowledge folder '${name}' not found.` }, null, 2);
  }
  let inputValues;
  try { inputValues = inputsJson ? JSON.parse(inputsJson) : {}; }
  catch (e) { return JSON.stringify({ error: `Invalid inputs JSON: ${e}` }, null, 2); }

  const workflowPath = path.join(folder, "workflows", `${workflow}.json`);
  if (!fs.existsSync(workflowPath)) {
    const workflowsDir = path.join(folder, "workflows");
    let available = [];
    if (fs.existsSync(workflowsDir)) available = fs.readdirSync(workflowsDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
    return JSON.stringify({ error: `Workflow '${workflow}' not found.`, available_workflows: available }, null, 2);
  }

  let workflowDef;
  try { workflowDef = JSON.parse(fs.readFileSync(workflowPath, "utf-8")); }
  catch (e) { return JSON.stringify({ error: `Failed to load workflow: ${e}` }, null, 2); }

  const workflowInputs = workflowDef.inputs || {};
  const missing = Object.entries(workflowInputs).filter(([, v]) => v.required).map(([k]) => k).filter(k => !(k in inputValues));
  if (missing.length > 0) return JSON.stringify({ error: `Missing required inputs: ${JSON.stringify(missing)}`, workflow_inputs: workflowInputs }, null, 2);

  const steps = workflowDef.steps || [];
  const results = { workflow, steps_executed: 0, files_created: [], files_skipped: [], scripts_run: [], messages: [], errors: [] };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const action = String(step.action || "");
    try {
      if (action === "mkdir") {
        const dirPath = replacePlaceholders(String(step.path || ""), inputValues);
        fs.mkdirSync(dirPath, { recursive: true });
      } else if (action === "message") {
        results.messages.push(replacePlaceholders(String(step.text || ""), inputValues));
      } else if (action === "copy") {
        const sourceRel = String(step.source || "");
        const targetPath = replacePlaceholders(String(step.target || ""), inputValues);
        const sourcePath = path.join(folder, sourceRel);
        if (step.skip_if_exists && fs.existsSync(targetPath)) { results.files_skipped.push(sourceRel); }
        else if (!fs.existsSync(sourcePath)) { results.errors.push(`Source not found: ${sourceRel}`); }
        else {
          let content = fs.readFileSync(sourcePath, "utf-8");
          content = replacePlaceholders(content, inputValues);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, content, "utf-8");
          results.files_created.push(targetPath);
        }
      } else {
        results.errors.push(`Step ${i + 1}: Unknown action '${action}'`);
      }
    } catch (e) { results.errors.push(`Step ${i + 1} (${action}): ${e}`); }
    results.steps_executed++;
  }

  results.summary = `${results.files_created.length} files created, ${results.files_skipped.length} skipped, ${results.scripts_run.length} scripts run, ${results.errors.length} errors`;
  return JSON.stringify(results, null, 2);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

let output;
switch (toolName) {
  case "list_docs": output = toolListDocs(); break;
  case "search_docs": output = toolSearchDocs(params.query || "", Number(params.max_results) || 10); break;
  case "get_doc": output = toolGetDoc(params.name || ""); break;
  case "get_doc_section": output = toolGetDocSection(params.name || "", params.section || ""); break;
  case "get_resource": output = toolGetResource(params.name || ""); break;
  case "get_manifest": output = toolGetManifest(params.name || ""); break;
  case "run_workflow": output = toolRunWorkflow(params.name || "", params.workflow || "", params.inputs || ""); break;
  default: output = JSON.stringify({ error: `Unknown tool: ${toolName}` }); break;
}

process.stdout.write(output);
