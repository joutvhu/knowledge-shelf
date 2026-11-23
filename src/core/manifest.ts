/**
 * Manifest & workflow resolution, validation, dependency graph resolution, and security inspection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALLOWED_INTERPRETERS,
  ALLOWED_WORKFLOW_ACTIONS,
  MAX_WORKFLOW_TIMEOUT_MS,
  MIN_WORKFLOW_TIMEOUT_MS,
  ROOT_PLACEHOLDER_RE,
  resolveInsideDir,
} from './config.js';
import {
  Manifest,
  findManifestFolders,
  isGlobPattern,
  normalizeListField,
  parseFrontmatter,
  resolveUnitFiles,
  walkDir,
  walkUnitFiles,
} from './parser.js';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export interface ValidationContext {
  expectedUnitName?: string;
  installedUnits?: Set<string>;
  allowAnyName?: boolean;
}

export interface UnitSecuritySummary {
  hasExecutables: boolean;
  scriptFiles: string[];
  runWorkflows: string[];
}

const VALID_LIFECYCLE_STATUS = new Set(['active', 'deprecated', 'draft']);
const VALID_PATCH_MODES = new Set(['insert_before', 'insert_after', 'append', 'prepend', 'replace']);

export function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function isValidTimeoutMs(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_WORKFLOW_TIMEOUT_MS &&
    v <= MAX_WORKFLOW_TIMEOUT_MS
  );
}

/**
 * Resolves the workflow JSON file path for a workflow key in `manifest.workflows`.
 * Uses `manifest.workflows[wfName].file` if provided, otherwise `workflows/<wfName>.json`.
 */
export function resolveWorkflowFilePath(
  unitDir: string,
  manifest: Manifest | null,
  wfName: string
): { workflowPath: string | null; displayRel: string } {
  const wfEntry = manifest?.workflows && isRecord(manifest.workflows) ? manifest.workflows[wfName] : undefined;
  if (isRecord(wfEntry) && typeof wfEntry.file === 'string' && wfEntry.file.trim()) {
    const rel = wfEntry.file.trim();
    return {
      workflowPath: resolveInsideDir(unitDir, rel, true),
      displayRel: rel.replace(/\\/g, '/'),
    };
  }
  const workflowsDir = path.join(unitDir, 'workflows');
  return {
    workflowPath: resolveInsideDir(workflowsDir, `${wfName}.json`, true),
    displayRel: `workflows/${wfName}.json`,
  };
}

function collectPlaceholders(str: string, out: Set<string>): void {
  const re = /\{\{([A-Za-z0-9_]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    out.add(m[1]);
  }
}

/** Collects {{KEY}} names from the step fields validateManifestUnitDir already inspects. */
export function collectStepPlaceholders(step: Record<string, unknown>, out: Set<string>): void {
  if (!isRecord(step)) return;
  const w = isRecord(step.when) ? step.when : null;
  if (w) {
    if (typeof w.input === 'string' && w.input.trim()) out.add(w.input.trim());
    if (typeof w.exists === 'string') collectPlaceholders(w.exists, out);
    if (typeof w.not_exists === 'string') collectPlaceholders(w.not_exists, out);
  }
  switch (step.action) {
    case 'copy':
    case 'copy_dir':
      if (typeof step.target === 'string') collectPlaceholders(step.target, out);
      break;
    case 'patch':
      if (typeof step.target === 'string') collectPlaceholders(step.target, out);
      if (typeof step.content === 'string') collectPlaceholders(step.content, out);
      if (typeof step.anchor === 'string') collectPlaceholders(step.anchor, out);
      if (typeof step.skip_if_contains === 'string') collectPlaceholders(step.skip_if_contains, out);
      break;
    case 'mkdir':
      if (typeof step.path === 'string') collectPlaceholders(step.path, out);
      break;
    case 'run':
      if (typeof step.cwd === 'string') collectPlaceholders(step.cwd, out);
      if (Array.isArray(step.args)) {
        for (const arg of step.args) collectPlaceholders(String(arg), out);
      }
      break;
    case 'message':
      if (typeof step.text === 'string') collectPlaceholders(step.text, out);
      break;
  }
}

export function validateManifestUnitDir(
  unitDir: string,
  expectedUnitNameOrCtx?: string | ValidationContext
): ValidationResult {
  const ctx: ValidationContext =
    typeof expectedUnitNameOrCtx === 'string'
      ? { expectedUnitName: expectedUnitNameOrCtx }
      : expectedUnitNameOrCtx || {};

  const folderBase = path.basename(unitDir);
  const expectedName = ctx.expectedUnitName || folderBase;
  const manifestPath = path.join(unitDir, 'manifest.json');
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(manifestPath)) {
    errors.push('manifest.json not found');
    return { errors, warnings };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
  } catch (e) {
    errors.push(`manifest.json is invalid JSON: ${e}`);
    return { errors, warnings };
  }

  if (!isRecord(manifest)) {
    errors.push('manifest.json must be a JSON object');
    return { errors, warnings };
  }

  if (!manifest.name) errors.push('Missing required field: name');
  if (!manifest.version) errors.push('Missing required field: version');
  if (manifest.type === undefined || manifest.type === null) {
    errors.push('Missing required field: type');
  } else if (typeof manifest.type !== 'string' || manifest.type.trim().length === 0) {
    errors.push('Field "type" must be a non-empty string');
  }
  if (!manifest.description) errors.push('Missing required field: description');

  if (!ctx.allowAnyName && manifest.name && manifest.name !== expectedName && manifest.name !== folderBase) {
    errors.push(`manifest.name "${manifest.name}" does not match folder name "${expectedName}"`);
  }

  if (manifest.status !== undefined) {
    if (typeof manifest.status !== 'string' || !VALID_LIFECYCLE_STATUS.has(manifest.status)) {
      errors.push(`Invalid status "${String(manifest.status)}": expected one of active, deprecated, draft`);
    } else if (manifest.status === 'deprecated' && !manifest.superseded_by) {
      warnings.push('Unit is marked "deprecated" without "superseded_by" guidance');
    }
  }

  if (manifest.requires !== undefined) {
    if (!Array.isArray(manifest.requires)) {
      errors.push('Field "requires" must be an array of unit names');
    } else {
      for (const req of manifest.requires) {
        if (typeof req !== 'string' || !req.trim()) {
          errors.push('Field "requires" entries must be non-empty strings');
        } else if (ctx.installedUnits && !ctx.installedUnits.has(req)) {
          warnings.push(`Required knowledge unit "${req}" is not currently installed`);
        }
      }
    }
  }

  if (manifest.doc && typeof manifest.doc === 'string') {
    const docPath = resolveInsideDir(unitDir, manifest.doc, true);
    if (!docPath) {
      errors.push(`doc path escapes unit folder: ${manifest.doc}`);
    } else if (!fs.existsSync(docPath) || !fs.statSync(docPath).isFile()) {
      errors.push(`doc file not found: ${manifest.doc}`);
    }
  }

  // Modules validation (supports literal paths + glob patterns + exclude)
  if (manifest.modules !== undefined && !isRecord(manifest.modules)) {
    errors.push('Field "modules" must be an object');
  } else if (isRecord(manifest.modules)) {
    const modules = manifest.modules;
    const moduleNames = Object.keys(modules);
    for (const [modName, rawMod] of Object.entries(modules)) {
      if (!isRecord(rawMod)) {
        errors.push(`modules.${modName}: must be an object`);
        continue;
      }

      const excludeList: string[] = [];
      if (rawMod.exclude !== undefined) {
        if (!Array.isArray(rawMod.exclude) || rawMod.exclude.some((x) => typeof x !== 'string')) {
          errors.push(`modules.${modName}.exclude: must be an array of strings`);
        } else {
          excludeList.push(...(rawMod.exclude as string[]));
        }
      }

      if (rawMod.files !== undefined) {
        if (!Array.isArray(rawMod.files)) {
          errors.push(`modules.${modName}.files: must be an array`);
        } else {
          const validEntries: string[] = [];
          for (const file of rawMod.files) {
            if (typeof file !== 'string') {
              errors.push(`modules.${modName}.files: entry must be a string`);
            } else {
              validEntries.push(file);
            }
          }
          if (validEntries.length > 0) {
            for (const file of validEntries) {
              if (!isGlobPattern(file)) {
                const resolvedDirCheck = resolveInsideDir(unitDir, file, true);
                if (resolvedDirCheck && fs.existsSync(resolvedDirCheck) && fs.statSync(resolvedDirCheck).isDirectory()) {
                  errors.push(
                    `modules.${modName}.files: '${file}' is a directory (files list must contain file paths or glob patterns, not directories)`
                  );
                }
              }
            }
            const resolved = resolveUnitFiles(unitDir, validEntries, excludeList);
            for (const esc of resolved.escapedPatterns) {
              errors.push(`modules.${modName}.files: path escapes unit folder: ${esc}`);
            }
            for (const miss of resolved.missingLiterals) {
              errors.push(`modules.${modName}.files: file not found: ${miss}`);
            }
            if (
              validEntries.some(isGlobPattern) &&
              resolved.files.length === 0 &&
              resolved.escapedPatterns.length === 0
            ) {
              warnings.push(`modules.${modName}.files: glob pattern(s) matched 0 files`);
            }
          }
        }
      }

      if (typeof rawMod.guide === 'string' && rawMod.guide) {
        const guidePath = resolveInsideDir(unitDir, rawMod.guide, true);
        if (!guidePath) {
          errors.push(`modules.${modName}.guide: path escapes unit folder: ${rawMod.guide}`);
        } else if (!fs.existsSync(guidePath)) {
          warnings.push(`modules.${modName}.guide: file not found: ${rawMod.guide}`);
        }
      }

      if (rawMod.dependencies !== undefined) {
        if (!Array.isArray(rawMod.dependencies)) {
          errors.push(`modules.${modName}.dependencies: must be an array`);
        } else {
          for (const dep of rawMod.dependencies) {
            if (typeof dep !== 'string' || !moduleNames.includes(dep)) {
              errors.push(`modules.${modName}.dependencies: unknown module "${String(dep)}"`);
            }
          }
        }
      }
    }

    // Detect circular module dependencies
    const visitState = new Map<string, 'visiting' | 'done'>();
    const checkCycle = (modName: string, stack: string[]) => {
      if (visitState.get(modName) === 'done') return;
      if (visitState.get(modName) === 'visiting') {
        const start = stack.indexOf(modName);
        const cycle = [...stack.slice(start), modName].join(' -> ');
        errors.push(`modules.${modName}.dependencies: circular dependency detected (${cycle})`);
        return;
      }
      const mod = modules[modName];
      if (!isRecord(mod) || !Array.isArray(mod.dependencies)) {
        visitState.set(modName, 'done');
        return;
      }
      visitState.set(modName, 'visiting');
      for (const dep of mod.dependencies) {
        if (typeof dep === 'string' && Object.prototype.hasOwnProperty.call(modules, dep)) {
          checkCycle(dep, [...stack, modName]);
        }
      }
      visitState.set(modName, 'done');
    };
    for (const modName of moduleNames) {
      if (!visitState.has(modName)) checkCycle(modName, []);
    }
  }

  // Scripts validation
  if (manifest.scripts !== undefined && !isRecord(manifest.scripts)) {
    errors.push('Field "scripts" must be an object');
  } else if (isRecord(manifest.scripts)) {
    for (const [scriptName, rawScript] of Object.entries(manifest.scripts)) {
      if (!isRecord(rawScript)) {
        errors.push(`scripts.${scriptName}: must be an object`);
        continue;
      }
      if (typeof rawScript.file !== 'string' || !rawScript.file.trim()) {
        errors.push(`scripts.${scriptName}: missing required "file" path`);
      } else {
        const scriptPath = resolveInsideDir(unitDir, rawScript.file, true);
        if (!scriptPath) {
          errors.push(`scripts.${scriptName}.file: path escapes unit folder: ${rawScript.file}`);
        } else if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
          errors.push(`scripts.${scriptName}.file: not found: ${rawScript.file}`);
        }
      }
      if (typeof rawScript.interpreter === 'string' && rawScript.interpreter.trim()) {
        const rawInterp = rawScript.interpreter.trim().toLowerCase();
        const interp = rawInterp === 'cmd /c' ? 'cmd' : rawInterp;
        if (!ALLOWED_INTERPRETERS.has(interp)) {
          errors.push(`scripts.${scriptName}.interpreter: '${rawScript.interpreter}' is not allowed`);
        }
      }
      if (rawScript.timeout_ms !== undefined) {
        if (!isValidTimeoutMs(rawScript.timeout_ms)) {
          errors.push(
            `scripts.${scriptName}.timeout_ms must be an integer between ${MIN_WORKFLOW_TIMEOUT_MS} and ${MAX_WORKFLOW_TIMEOUT_MS}`
          );
        }
      }
      if (rawScript.args !== undefined) {
        if (typeof rawScript.args !== 'object' || rawScript.args === null || Array.isArray(rawScript.args)) {
          errors.push(`scripts.${scriptName}.args must be an object`);
        } else {
          for (const [argName, argDef] of Object.entries(rawScript.args)) {
            if (typeof argDef !== 'object' || argDef === null || Array.isArray(argDef)) {
              errors.push(`scripts.${scriptName}.args.${argName} must be an object`);
            } else {
              const def = argDef as Record<string, unknown>;
              if (def.required !== undefined && typeof def.required !== 'boolean') {
                errors.push(`scripts.${scriptName}.args.${argName}.required must be a boolean`);
              }
              if (def.type !== undefined && typeof def.type !== 'string') {
                errors.push(`scripts.${scriptName}.args.${argName}.type must be a string`);
              }
              if (def.description !== undefined && typeof def.description !== 'string') {
                errors.push(`scripts.${scriptName}.args.${argName}.description must be a string`);
              }
            }
          }
        }
      }
    }
  }

  // References validation
  if (manifest.references !== undefined && !isRecord(manifest.references)) {
    errors.push('Field "references" must be an object');
  } else if (isRecord(manifest.references)) {
    for (const [refName, rawRef] of Object.entries(manifest.references)) {
      if (!isRecord(rawRef)) {
        errors.push(`references.${refName}: must be an object`);
        continue;
      }
      if (typeof rawRef.file !== 'string' || !rawRef.file.trim()) {
        errors.push(`references.${refName}: missing required "file" path`);
      } else {
        const refPath = resolveInsideDir(unitDir, rawRef.file, true);
        if (!refPath) {
          errors.push(`references.${refName}.file: path escapes unit folder: ${rawRef.file}`);
        } else if (!fs.existsSync(refPath) || !fs.statSync(refPath).isFile()) {
          errors.push(`references.${refName}.file: not found: ${rawRef.file}`);
        }
      }
    }
  }

  // Placeholders validation
  if (manifest.placeholders !== undefined && isRecord(manifest.placeholders)) {
    for (const [phKey, phDef] of Object.entries(manifest.placeholders)) {
      if (isRecord(phDef) && typeof phDef.pattern === 'string') {
        try {
          new RegExp(phDef.pattern);
        } catch (e: any) {
          errors.push(`placeholders.${phKey}: invalid regex pattern '${phDef.pattern}': ${e?.message || e}`);
        }
      }
    }
  }

  // Workflows validation
  const declaredManifestPlaceholders = new Set(
    isRecord(manifest.placeholders) ? Object.keys(manifest.placeholders) : []
  );

  if (manifest.workflows !== undefined && !isRecord(manifest.workflows)) {
    errors.push('Field "workflows" must be an object');
  } else if (isRecord(manifest.workflows)) {
    for (const [wfName, rawWfEntry] of Object.entries(manifest.workflows)) {
      if (rawWfEntry !== undefined && !isRecord(rawWfEntry)) {
        errors.push(`workflows.${wfName}: must be an object`);
        continue;
      }
      const { workflowPath, displayRel } = resolveWorkflowFilePath(unitDir, manifest, wfName);
      if (!workflowPath) {
        errors.push(`workflows.${wfName}: invalid or escaping workflow path (${displayRel})`);
        continue;
      }
      if (!fs.existsSync(workflowPath) || !fs.statSync(workflowPath).isFile()) {
        errors.push(`workflows.${wfName}: file not found: ${displayRel}`);
        continue;
      }

      try {
        const wfContent = fs.readFileSync(workflowPath, 'utf-8');
        const wfDef = JSON.parse(wfContent) as Record<string, unknown>;
        if (!wfDef.steps || !Array.isArray(wfDef.steps)) {
          errors.push(`${displayRel}: missing or invalid "steps" array`);
          continue;
        }

        const wfInputs = new Set(isRecord(wfDef.inputs) ? Object.keys(wfDef.inputs) : []);
        if (isRecord(wfDef.inputs)) {
          for (const [inKey, inDef] of Object.entries(wfDef.inputs)) {
            if (isRecord(inDef) && typeof inDef.pattern === 'string') {
              try {
                new RegExp(inDef.pattern);
              } catch (e: any) {
                errors.push(
                  `${displayRel}: input '${inKey}' invalid regex pattern '${inDef.pattern}': ${e?.message || e}`
                );
              }
            }
          }
        }
        const usedPlaceholders = new Set<string>();

        for (let i = 0; i < wfDef.steps.length; i++) {
          const step = wfDef.steps[i] as Record<string, unknown>;
          const prefix = `${displayRel} step ${i + 1}`;
          const action = typeof step?.action === 'string' ? step.action : '';
          if (!ALLOWED_WORKFLOW_ACTIONS.has(action)) {
            errors.push(`${prefix}: unknown or missing action '${action}'`);
            continue;
          }

          collectStepPlaceholders(step, usedPlaceholders);

          if (step.when !== undefined) {
            if (!isRecord(step.when)) {
              errors.push(`${prefix}: "when" must be an object`);
            } else {
              const hasInputCond =
                typeof step.when.input === 'string' &&
                (step.when.equals !== undefined ||
                  step.when.not_equals !== undefined ||
                  Array.isArray(step.when.in));
              const hasFileCond =
                typeof step.when.exists === 'string' || typeof step.when.not_exists === 'string';
              if (!hasInputCond && !hasFileCond) {
                errors.push(
                  `${prefix}: "when" must specify input + (equals|not_equals|in) or exists/not_exists`
                );
              }
              if (typeof step.when.exists === 'string') {
                const cond = step.when.exists.trim();
                if (!ROOT_PLACEHOLDER_RE.test(cond)) {
                  errors.push(
                    `${prefix}: when.exists path '${step.when.exists}' must start with a root placeholder (e.g. {{TARGET}}/...)`
                  );
                }
              }
              if (typeof step.when.not_exists === 'string') {
                const cond = step.when.not_exists.trim();
                if (!ROOT_PLACEHOLDER_RE.test(cond)) {
                  errors.push(
                    `${prefix}: when.not_exists path '${step.when.not_exists}' must start with a root placeholder (e.g. {{TARGET}}/...)`
                  );
                }
              }
            }
          }

          if (action === 'copy') {
            const src = typeof step.source === 'string' ? step.source : '';
            const tgt = typeof step.target === 'string' ? step.target.trim() : '';
            if (!src) {
              errors.push(`${prefix} (copy): missing "source"`);
            } else {
              const srcPath = resolveInsideDir(unitDir, src, true);
              if (!srcPath) {
                errors.push(`${prefix} (copy): source escapes unit folder: ${src}`);
              } else if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
                errors.push(`${prefix} (copy): source not found: ${src}`);
              }
            }
            if (!tgt || !ROOT_PLACEHOLDER_RE.test(tgt)) {
              errors.push(`${prefix} (copy): target must start with a root placeholder (e.g. {{TARGET}}/...)`);
            }
          } else if (action === 'copy_dir') {
            const src = typeof step.source === 'string' ? step.source : '';
            const tgt = typeof step.target === 'string' ? step.target.trim() : '';
            if (!src) {
              errors.push(`${prefix} (copy_dir): missing "source"`);
            } else {
              const srcPath = resolveInsideDir(unitDir, src, true);
              if (!srcPath) {
                errors.push(`${prefix} (copy_dir): source escapes unit folder: ${src}`);
              } else if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isDirectory()) {
                errors.push(`${prefix} (copy_dir): source directory not found: ${src}`);
              }
            }
            if (!tgt || !ROOT_PLACEHOLDER_RE.test(tgt)) {
              errors.push(
                `${prefix} (copy_dir): target must start with a root placeholder (e.g. {{TARGET}}/...)`
              );
            }
          } else if (action === 'patch') {
            const tgt = typeof step.target === 'string' ? step.target.trim() : '';
            const mode = typeof step.mode === 'string' ? step.mode : 'append';
            if (!tgt || !ROOT_PLACEHOLDER_RE.test(tgt)) {
              errors.push(`${prefix} (patch): target must start with a root placeholder (e.g. {{TARGET}}/...)`);
            }
            if (!VALID_PATCH_MODES.has(mode)) {
              errors.push(`${prefix} (patch): invalid mode '${mode}'`);
            }
            if (typeof step.content !== 'string') {
              errors.push(`${prefix} (patch): missing string "content"`);
            }
            if (
              (mode === 'insert_before' || mode === 'insert_after' || mode === 'replace') &&
              (!step.anchor || typeof step.anchor !== 'string')
            ) {
              errors.push(`${prefix} (patch): mode '${mode}' requires non-empty "anchor"`);
            }
          } else if (action === 'mkdir') {
            const p = typeof step.path === 'string' ? step.path.trim() : '';
            if (!p || !ROOT_PLACEHOLDER_RE.test(p)) {
              errors.push(`${prefix} (mkdir): path must start with a root placeholder (e.g. {{TARGET}}/...)`);
            }
          } else if (action === 'run') {
            const scriptRef = typeof step.script_ref === 'string' ? step.script_ref.trim() : '';
            let script = typeof step.script === 'string' ? step.script : '';
            if (scriptRef) {
              const refDef =
                isRecord(manifest.scripts) && isRecord(manifest.scripts[scriptRef])
                  ? manifest.scripts[scriptRef]
                  : null;
              if (!refDef || typeof refDef.file !== 'string') {
                errors.push(`${prefix} (run): unknown script_ref '${scriptRef}'`);
              } else {
                script = refDef.file;
              }
            }
            if (!script) {
              errors.push(`${prefix} (run): missing "script" or "script_ref"`);
            } else {
              const scriptPath = resolveInsideDir(unitDir, script, true);
              if (!scriptPath) {
                errors.push(`${prefix} (run): script escapes unit folder: ${script}`);
              } else if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
                errors.push(`${prefix} (run): script not found: ${script}`);
              }
            }
            if (typeof step.interpreter === 'string' && step.interpreter.trim()) {
              const rawInterp = step.interpreter.trim().toLowerCase();
              const interp = rawInterp === 'cmd /c' ? 'cmd' : rawInterp;
              if (!ALLOWED_INTERPRETERS.has(interp)) {
                errors.push(`${prefix} (run): interpreter '${step.interpreter}' is not allowed`);
              }
            }
            if (typeof step.cwd === 'string' && step.cwd.trim()) {
              const cwdTemplate = step.cwd.trim();
              if (!ROOT_PLACEHOLDER_RE.test(cwdTemplate)) {
                errors.push(`${prefix} (run): cwd must start with a root placeholder (e.g. {{TARGET}})`);
              }
            }
            if (step.timeout_ms !== undefined) {
              if (!isValidTimeoutMs(step.timeout_ms)) {
                errors.push(
                  `${prefix} (run): timeout_ms must be an integer between ${MIN_WORKFLOW_TIMEOUT_MS} and ${MAX_WORKFLOW_TIMEOUT_MS}`
                );
              }
            }
          }
        }

        for (const ph of usedPlaceholders) {
          if (!wfInputs.has(ph) && !declaredManifestPlaceholders.has(ph)) {
            warnings.push(
              `${displayRel}: placeholder '{{${ph}}}' is not declared in workflow.inputs or manifest.placeholders`
            );
          }
        }
      } catch (e) {
        errors.push(`${displayRel}: invalid JSON: ${e}`);
      }
    }
  }

  return { errors, warnings };
}

export function validateStandaloneMdFile(filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!filePath.toLowerCase().endsWith('.md')) {
    errors.push(`File is not a Markdown (.md) document: ${path.basename(filePath)}`);
    return { errors, warnings };
  }

  if (path.basename(filePath).toLowerCase() === 'readme.md') {
    errors.push('Standalone doc cannot be named README.md (ignored by knowledge scanner).');
    return { errors, warnings };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    errors.push(`Failed to read file: ${e}`);
    return { errors, warnings };
  }

  if (!content.trim()) {
    errors.push('Markdown file is empty');
    return { errors, warnings };
  }

  const { metadata, body } = parseFrontmatter(content);
  if (!body.trim()) {
    errors.push('Markdown body is empty');
  }
  if (!metadata.description) {
    warnings.push('Missing frontmatter "description" (recommended for search relevance)');
  }
  if (!metadata.tags && !metadata.keywords) {
    warnings.push('Missing frontmatter "tags" (recommended for search relevance)');
  }

  return { errors, warnings };
}

/**
 * Resolves a manifest module plus its transitive dependencies in topological order,
 * expanding file globs and reporting guides and placeholders.
 */
export function resolveModuleDetails(
  unitDir: string,
  manifest: Manifest,
  moduleName: string,
  includeDependencies = true
): {
  error?: string;
  ordered_modules: string[];
  files: string[];
  guides: Array<{ module: string; guide: string }>;
  descriptions: Record<string, string>;
} {
  if (!isRecord(manifest.modules) || !isRecord(manifest.modules[moduleName])) {
    const available = isRecord(manifest.modules) ? Object.keys(manifest.modules) : [];
    return {
      error: `Module '${moduleName}' not found. Available: ${available.join(', ') || 'none'}`,
      ordered_modules: [],
      files: [],
      guides: [],
      descriptions: {},
    };
  }

  const modules = manifest.modules;
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string): string | null => {
    if (visited.has(name)) return null;
    if (visiting.has(name)) {
      return `Circular dependency detected involving '${name}'`;
    }
    const mod = modules[name];
    if (!isRecord(mod)) {
      return `Module '${name}' is missing or malformed`;
    }
    visiting.add(name);
    if (includeDependencies && Array.isArray(mod.dependencies)) {
      for (const dep of mod.dependencies) {
        if (typeof dep === 'string') {
          const err = visit(dep);
          if (err) return err;
        }
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
    return null;
  };

  const err = visit(moduleName);
  if (err) {
    return {
      error: err,
      ordered_modules: [],
      files: [],
      guides: [],
      descriptions: {},
    };
  }

  const allFiles: string[] = [];
  const seenFiles = new Set<string>();
  const guides: Array<{ module: string; guide: string }> = [];
  const descriptions: Record<string, string> = {};

  for (const modKey of ordered) {
    const mod = modules[modKey]!;
    if (typeof mod.description === 'string') {
      descriptions[modKey] = mod.description;
    }
    if (typeof mod.guide === 'string' && mod.guide) {
      guides.push({ module: modKey, guide: mod.guide });
    }
    if (Array.isArray(mod.files)) {
      const exclude = Array.isArray(mod.exclude)
        ? mod.exclude.filter((x): x is string => typeof x === 'string')
        : [];
      const resolved = resolveUnitFiles(
        unitDir,
        mod.files.filter((x): x is string => typeof x === 'string'),
        exclude
      );
      for (const f of resolved.files) {
        if (!seenFiles.has(f)) {
          seenFiles.add(f);
          allFiles.push(f);
        }
      }
    }
  }

  return {
    ordered_modules: ordered,
    files: allFiles,
    guides,
    descriptions,
  };
}

/**
 * Inspects a unit directory for executable scripts or workflows containing `run` steps.
 */
export function inspectUnitSecurity(unitDir: string): UnitSecuritySummary {
  const scriptFiles = new Set<string>();
  const runWorkflows = new Set<string>();

  const scriptsDir = path.join(unitDir, 'scripts');
  if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
    walkDir(scriptsDir, (fp) => {
      scriptFiles.add(path.relative(unitDir, fp).replace(/\\/g, '/'));
    });
  }

  const manifestPath = path.join(unitDir, 'manifest.json');
  let manifest: Manifest | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
      if (isRecord(manifest.scripts)) {
        for (const s of Object.values(manifest.scripts)) {
          if (isRecord(s) && typeof s.file === 'string' && s.file) {
            scriptFiles.add(s.file.replace(/\\/g, '/'));
          }
        }
      }
    } catch {
      /* ignore invalid manifest here */
    }
  } else {
    // If unitDir has child manifest folders (e.g. monorepo checkout installed as a single folder)
    const childFolders = findManifestFolders(unitDir).filter(
      (f) => path.resolve(f) !== path.resolve(unitDir)
    );
    for (const child of childFolders) {
      const childSec = inspectUnitSecurity(child);
      const childRel = path.relative(unitDir, child).replace(/\\/g, '/');
      for (const s of childSec.scriptFiles) {
        scriptFiles.add(`${childRel}/${s}`);
      }
      for (const w of childSec.runWorkflows) {
        runWorkflows.add(`${childRel}/${w}`);
      }
    }
  }

  const wfNames = new Set<string>();
  if (manifest && isRecord(manifest.workflows)) {
    for (const k of Object.keys(manifest.workflows)) wfNames.add(k);
  }
  const wfDir = path.join(unitDir, 'workflows');
  if (fs.existsSync(wfDir) && fs.statSync(wfDir).isDirectory()) {
    for (const f of fs.readdirSync(wfDir)) {
      if (f.endsWith('.json')) wfNames.add(f.slice(0, -5));
    }
  }

  for (const wfName of wfNames) {
    const { workflowPath } = resolveWorkflowFilePath(unitDir, manifest, wfName);
    if (!workflowPath || !fs.existsSync(workflowPath)) continue;
    try {
      const wfDef = JSON.parse(fs.readFileSync(workflowPath, 'utf-8')) as { steps?: Array<{ action?: string }> };
      if (Array.isArray(wfDef.steps) && wfDef.steps.some((s) => s?.action === 'run')) {
        runWorkflows.add(wfName);
      }
    } catch {
      /* ignore */
    }
  }

  return {
    hasExecutables: scriptFiles.size > 0 || runWorkflows.size > 0,
    scriptFiles: [...scriptFiles].sort(),
    runWorkflows: [...runWorkflows].sort(),
  };
}

export interface HygieneRule {
  kind: string;
  re: RegExp;
}

export const SENSITIVE_NAME_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.secret.*)$/i;

export const TOKEN_RULES: HygieneRule[] = [
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/ },
  { kind: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
];

export const SECRET_ASSIGN_RE =
  /(password|secret|api_key|apikey)[A-Za-z0-9_-]*["']?[^\S\r\n]*[:=][^\S\r\n]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"',;]+))/gi;

export function isPlaceholderValue(v: string): boolean {
  const t = v.trim();
  return t === '' || /^(?:\{\{|\$|<|%)/.test(t);
}

export function hasLiteralSecretAssignment(text: string): boolean {
  for (const m of text.matchAll(SECRET_ASSIGN_RE)) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (isPlaceholderValue(value)) continue;
    if (value.replace(/\s/g, '').length >= 4) return true;
  }
  return false;
}

const privateKeyRe = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const absUserPathRe = /(?:[A-Za-z]:\\Users\\[^\\\s"']+|\/(?:Users|home)\/[^/\s"']+)/;

export function scanTextForHygiene(text: string, rel: string, out: string[]): void {
  if (privateKeyRe.test(text)) out.push(`Potential private key detected in '${rel}'`);
  if (absUserPathRe.test(text)) out.push(`Hardcoded local home directory path detected in '${rel}'`);
  for (const r of TOKEN_RULES) {
    if (r.re.test(text)) out.push(`Potential ${r.kind} detected in '${rel}'`);
  }
  if (hasLiteralSecretAssignment(text)) {
    out.push(`Possible hardcoded secret assignment detected in '${rel}'`);
  }
}

export function scanFileForHygiene(fp: string, rel: string, out: string[]): void {
  if (SENSITIVE_NAME_RE.test(path.basename(fp))) {
    out.push(`Sensitive file found: ${rel}`);
  }
  try {
    const buf = fs.readFileSync(fp);
    if (buf.subarray(0, 8192).includes(0)) return;
    scanTextForHygiene(buf.toString('utf-8'), rel, out);
  } catch {
    /* unreadable: skip */
  }
}

/**
 * Checks a unit directory before publishing to Git for accidental secrets or hardcoded user paths.
 */
export function checkUnitPublishHygiene(unitDir: string): string[] {
  const out: string[] = [];
  walkUnitFiles(unitDir, (fp) => {
    scanFileForHygiene(fp, path.relative(unitDir, fp).replace(/\\/g, '/'), out);
  });
  return out;
}

/**
 * Checks a standalone file before publishing for accidental secrets or hardcoded user paths.
 */
export function checkFilePublishHygiene(filePath: string): string[] {
  const out: string[] = [];
  scanFileForHygiene(filePath, path.basename(filePath), out);
  return out;
}

export { normalizeListField, parseFrontmatter };
