/**
 * Workflow execution engine with path containment security, dry-run, copy_dir, patch, and script execution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ALLOWED_INTERPRETERS,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  MAX_WORKFLOW_TIMEOUT_MS,
  MIN_WORKFLOW_TIMEOUT_MS,
  canonicalizePath,
  resolveInsideDir,
} from './config.js';
import { Manifest, matchesAnyGlob, walkUnitFiles } from './parser.js';

export interface WorkflowResults {
  workflow: string;
  dry_run?: boolean;
  steps_executed: number;
  files_created: string[];
  files_skipped: string[];
  files_patched?: string[];
  scripts_run: Array<{ script: string; exit_code: number; stdout: string; stderr: string }>;
  messages: string[];
  errors: string[];
  summary?: string;
}

export interface WorkflowExecutionOptions {
  dryRun?: boolean;
  readOnly?: boolean;
  blockRunReason?: string;
  manifest?: Manifest | null;
}

export function replacePlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

/**
 * Validates that a workflow output path (`copy` target, `mkdir` path, `patch` target, or `run` cwd)
 * does not contain unresolved placeholders, starts with a root path placeholder (`{{KEY}}/...`),
 * and stays inside that root input directory.
 */
export function resolveSafeOutputTarget(
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

  const rootBase = canonicalizePath(rootVal);
  const subRel = replacePlaceholders(prefixMatch[2] || '', inputs).trim();
  if (!subRel || subRel === '.' || subRel === './' || subRel === '.\\') {
    return { resolvedPath: rootBase };
  }

  const safe = resolveInsideDir(rootBase, subRel, true);
  if (!safe) {
    return { error: `Target path '${rendered}' escapes base directory '${rootBase}'.` };
  }
  return { resolvedPath: safe };
}

/**
 * cmd.exe cannot escape every metacharacter reliably: `%VAR%` is expanded even inside quotes,
 * and a `"` ends the quoted section so the rest is parsed as commands. Batch scripts also
 * re-expand `%~1` unquoted. Instead of trying to escape, accept only arguments free of these
 * characters (BatBadBut class of issues).
 */
export function isSafeCmdArg(arg: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/["%!^&|<>\x00-\x1f]/.test(arg);
}

function runProcessAsync(
  bin: string,
  spawnArgs: string[],
  cwd: string,
  windowsVerbatimArguments: boolean,
  timeoutMs = DEFAULT_WORKFLOW_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(bin, spawnArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments,
    });
    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        stdout,
        stderr,
        status: 1,
        error: new Error(`Process timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf-8')).slice(-4000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf-8')).slice(-2000);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status: null, error: err });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code });
    });
  });
}

function evaluateWhenCondition(
  when: unknown,
  inputs: Record<string, string>,
  results: WorkflowResults
): boolean {
  if (!when || typeof when !== 'object' || Array.isArray(when)) return true;
  const w = when as Record<string, unknown>;

  if (typeof w.input === 'string') {
    const val = inputs[w.input] ?? '';
    if (w.equals !== undefined && val !== String(w.equals)) return false;
    if (w.not_equals !== undefined && val === String(w.not_equals)) return false;
    if (Array.isArray(w.in) && !w.in.map(String).includes(val)) return false;
  }

  if (typeof w.exists === 'string') {
    const check = resolveSafeOutputTarget(w.exists, inputs);
    if (!check.resolvedPath) {
      results.errors.push(check.error || `Invalid 'when.exists' path: ${w.exists}`);
      return false;
    }
    const existsOnDisk = fs.existsSync(check.resolvedPath);
    const normCheck = check.resolvedPath.replace(/\\/g, '/');
    const checkKey = process.platform === 'win32' ? normCheck.toLowerCase() : normCheck;
    const existsInDryRun =
      Boolean(results.dry_run) &&
      results.files_created.some((f) => {
        const normF = f.replace(/\\/g, '/');
        const fKey = process.platform === 'win32' ? normF.toLowerCase() : normF;
        return fKey === checkKey || fKey.startsWith(checkKey + '/');
      });
    if (!existsOnDisk && !existsInDryRun) return false;
  }

  if (typeof w.not_exists === 'string') {
    const check = resolveSafeOutputTarget(w.not_exists, inputs);
    if (!check.resolvedPath) {
      results.errors.push(check.error || `Invalid 'when.not_exists' path: ${w.not_exists}`);
      return false;
    }
    const existsOnDisk = fs.existsSync(check.resolvedPath);
    const normCheck = check.resolvedPath.replace(/\\/g, '/');
    const checkKey = process.platform === 'win32' ? normCheck.toLowerCase() : normCheck;
    const existsInDryRun =
      Boolean(results.dry_run) &&
      results.files_created.some((f) => {
        const normF = f.replace(/\\/g, '/');
        const fKey = process.platform === 'win32' ? normF.toLowerCase() : normF;
        return fKey === checkKey || fKey.startsWith(checkKey + '/');
      });
    if (existsOnDisk || existsInDryRun) return false;
  }

  return true;
}

function writeRenderedFile(sourcePath: string, targetPath: string, inputs: Record<string, string>): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const buf = fs.readFileSync(sourcePath);
  if (buf.subarray(0, 8192).includes(0)) {
    fs.writeFileSync(targetPath, buf);
  } else {
    const content = replacePlaceholders(buf.toString('utf-8'), inputs);
    fs.writeFileSync(targetPath, content, 'utf-8');
  }
}

function executeCopyStep(
  step: Record<string, unknown>,
  folder: string,
  inputs: Record<string, string>,
  results: WorkflowResults,
  dryRun: boolean
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

  if (!dryRun) {
    writeRenderedFile(sourcePath, targetPath, inputs);
  }
  results.files_created.push(targetPath);
}

function executeCopyDirStep(
  step: Record<string, unknown>,
  folder: string,
  inputs: Record<string, string>,
  results: WorkflowResults,
  dryRun: boolean
): void {
  const sourceRel = String(step.source || '');
  const targetTemplate = String(step.target || '');
  const skipIfExists = Boolean(step.skip_if_exists);
  const renderFilenames = step.render_filenames !== false;
  const exclude = Array.isArray(step.exclude)
    ? step.exclude.filter((x): x is string => typeof x === 'string')
    : [];

  if (!sourceRel) {
    results.errors.push('copy_dir step missing source directory.');
    return;
  }
  if (!targetTemplate) {
    results.errors.push(`copy_dir step for '${sourceRel}' missing target path.`);
    return;
  }

  const sourceDir = resolveInsideDir(folder, sourceRel, true);
  if (!sourceDir) {
    results.errors.push(`Source directory '${sourceRel}' is outside the knowledge unit folder.`);
    return;
  }
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    results.errors.push(`Source directory not found: ${sourceRel}`);
    return;
  }

  const targetCheck = resolveSafeOutputTarget(targetTemplate, inputs);
  if (!targetCheck.resolvedPath) {
    results.errors.push(targetCheck.error || `Invalid target directory for '${sourceRel}'.`);
    return;
  }
  const targetRoot = targetCheck.resolvedPath;

  const files: string[] = [];
  walkUnitFiles(sourceDir, (fp) => {
    const rel = path.relative(sourceDir, fp).replace(/\\/g, '/');
    if (exclude.length > 0 && matchesAnyGlob(rel, exclude)) return;
    files.push(fp);
  });
  files.sort();

  for (const srcFile of files) {
    const rel = path.relative(sourceDir, srcFile).replace(/\\/g, '/');
    const targetRel = renderFilenames ? replacePlaceholders(rel, inputs) : rel;
    if (/\{\{[A-Za-z0-9_]+\}\}/.test(targetRel)) {
      results.errors.push(`Rendered filename '${targetRel}' contains unresolved placeholder(s).`);
      return;
    }
    const destFile = resolveInsideDir(targetRoot, targetRel, true);
    if (!destFile) {
      results.errors.push(`Rendered target '${targetRel}' escapes target directory '${targetRoot}'.`);
      return;
    }

    if (skipIfExists && fs.existsSync(destFile)) {
      results.files_skipped.push(path.posix.join(sourceRel.replace(/\\/g, '/'), rel));
      continue;
    }

    if (!dryRun) {
      writeRenderedFile(srcFile, destFile, inputs);
    }
    results.files_created.push(destFile);
  }
}

function executePatchStep(
  step: Record<string, unknown>,
  inputs: Record<string, string>,
  results: WorkflowResults,
  dryRun: boolean
): void {
  const targetTemplate = String(step.target || '');
  const mode = typeof step.mode === 'string' ? step.mode : 'append';
  const anchorTemplate = typeof step.anchor === 'string' ? step.anchor : '';
  const contentTemplate = typeof step.content === 'string' ? step.content : '';
  const skipIfContainsTemplate =
    typeof step.skip_if_contains === 'string' ? step.skip_if_contains : '';
  const createIfMissing = Boolean(step.create_if_missing);

  if (!targetTemplate) {
    results.errors.push('Patch step missing target path.');
    return;
  }

  const targetCheck = resolveSafeOutputTarget(targetTemplate, inputs);
  if (!targetCheck.resolvedPath) {
    results.errors.push(targetCheck.error || 'Invalid patch target path.');
    return;
  }
  const targetPath = targetCheck.resolvedPath;

  const renderedContent = replacePlaceholders(contentTemplate, inputs);
  const renderedAnchor = replacePlaceholders(anchorTemplate, inputs);
  const skipMarker = skipIfContainsTemplate ? replacePlaceholders(skipIfContainsTemplate, inputs) : '';

  const VALID_PATCH_MODES = new Set(['insert_before', 'insert_after', 'append', 'prepend', 'replace']);
  if (!VALID_PATCH_MODES.has(mode)) {
    results.errors.push(`Unknown patch mode '${mode}'.`);
    return;
  }
  if (
    (mode === 'insert_before' || mode === 'insert_after' || mode === 'replace') &&
    !renderedAnchor
  ) {
    results.errors.push(`Patch mode '${mode}' requires a non-empty anchor.`);
    return;
  }

  let existing = '';
  if (fs.existsSync(targetPath)) {
    if (!fs.statSync(targetPath).isFile()) {
      results.errors.push(`Patch target '${targetPath}' is not a file.`);
      return;
    }
    existing = fs.readFileSync(targetPath, 'utf-8');
  } else if (dryRun && results.files_created.includes(targetPath)) {
    if (!results.files_patched) results.files_patched = [];
    results.files_patched.push(targetPath);
    return;
  } else if (createIfMissing && (mode === 'append' || mode === 'prepend')) {
    existing = '';
  } else {
    results.errors.push(`Patch target file not found: ${targetPath}`);
    return;
  }

  if (skipMarker && existing.includes(skipMarker)) {
    results.files_skipped.push(targetPath);
    return;
  }

  let updated: string;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';

  if (mode === 'append') {
    const sep = existing && !existing.endsWith('\n') ? eol : '';
    updated = `${existing}${sep}${renderedContent}`;
  } else if (mode === 'prepend') {
    const sep = existing && !renderedContent.endsWith('\n') ? eol : '';
    updated = `${renderedContent}${sep}${existing}`;
  } else if (mode === 'insert_before' || mode === 'insert_after' || mode === 'replace') {
    if (!renderedAnchor) {
      results.errors.push(`Patch mode '${mode}' requires a non-empty anchor.`);
      return;
    }
    const idx = existing.indexOf(renderedAnchor);
    if (idx === -1) {
      results.errors.push(`Patch anchor not found in '${targetPath}': ${renderedAnchor}`);
      return;
    }
    if (mode === 'insert_before') {
      const sep = renderedContent.endsWith('\n') ? '' : eol;
      updated = `${existing.slice(0, idx)}${renderedContent}${sep}${existing.slice(idx)}`;
    } else if (mode === 'insert_after') {
      const afterIdx = idx + renderedAnchor.length;
      const needsSep =
        !renderedAnchor.endsWith('\n') &&
        !renderedContent.startsWith('\n') &&
        !renderedContent.startsWith('\r\n');
      const sep = needsSep ? eol : '';
      updated = `${existing.slice(0, afterIdx)}${sep}${renderedContent}${existing.slice(afterIdx)}`;
    } else {
      updated = `${existing.slice(0, idx)}${renderedContent}${existing.slice(idx + renderedAnchor.length)}`;
    }
  } else {
    results.errors.push(`Unknown patch mode '${mode}'.`);
    return;
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, updated, 'utf-8');
  }
  if (!results.files_patched) results.files_patched = [];
  results.files_patched.push(targetPath);
}

async function executeRunStep(
  step: Record<string, unknown>,
  folder: string,
  inputs: Record<string, string>,
  results: WorkflowResults,
  options: WorkflowExecutionOptions
): Promise<void> {
  if (!options.dryRun && options.readOnly) {
    results.errors.push('Workflow script execution is disabled in read-only mode.');
    return;
  }
  if (!options.dryRun && options.blockRunReason) {
    results.errors.push(options.blockRunReason);
    return;
  }

  let scriptRel = typeof step.script === 'string' ? step.script : '';
  let rawInterpreter = typeof step.interpreter === 'string' ? step.interpreter.trim() : '';
  let timeoutMs =
    typeof step.timeout_ms === 'number' && step.timeout_ms > 0
      ? Math.max(MIN_WORKFLOW_TIMEOUT_MS, Math.min(step.timeout_ms, MAX_WORKFLOW_TIMEOUT_MS))
      : DEFAULT_WORKFLOW_TIMEOUT_MS;

  if (typeof step.script_ref === 'string' && step.script_ref.trim()) {
    const refKey = step.script_ref.trim();
    const scriptDef = options.manifest?.scripts?.[refKey];
    if (!scriptDef || typeof scriptDef.file !== 'string') {
      results.errors.push(`Unknown script_ref '${refKey}' in manifest.scripts.`);
      return;
    }
    scriptRel = scriptDef.file;
    if (!rawInterpreter && typeof scriptDef.interpreter === 'string') {
      rawInterpreter = scriptDef.interpreter.trim();
    }
    if (
      step.timeout_ms === undefined &&
      typeof scriptDef.timeout_ms === 'number' &&
      scriptDef.timeout_ms > 0
    ) {
      timeoutMs = Math.max(MIN_WORKFLOW_TIMEOUT_MS, Math.min(scriptDef.timeout_ms, MAX_WORKFLOW_TIMEOUT_MS));
    }
  }

  const argsTemplate = Array.isArray(step.args) ? (step.args as string[]) : [];

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
  const unresolvedArg = args.find((a) => /\{\{[A-Za-z0-9_]+\}\}/.test(a));
  if (unresolvedArg) {
    results.errors.push(`Script argument '${unresolvedArg}' contains unresolved placeholder(s).`);
    return;
  }

  let cwd = folder;
  if (typeof step.cwd === 'string' && step.cwd.trim()) {
    const cwdCheck = resolveSafeOutputTarget(step.cwd.trim(), inputs);
    if (!cwdCheck.resolvedPath) {
      results.errors.push(cwdCheck.error || `Invalid cwd '${step.cwd}'.`);
      return;
    }
    cwd = cwdCheck.resolvedPath;
    if (!options.dryRun && (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) {
      results.errors.push(`Working directory not found: ${cwd}`);
      return;
    }
  }

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

  const normalizedInterp = interpreter.toLowerCase();
  if (!ALLOWED_INTERPRETERS.has(normalizedInterp)) {
    results.errors.push(`Interpreter '${interpreter}' is not allowed.`);
    return;
  }

  if (normalizedInterp === 'cmd') {
    const unsafe = !isSafeCmdArg(resolvedScript) || args.some((a) => !isSafeCmdArg(a));
    if (unsafe) {
      results.errors.push(
        `Refusing to run '${scriptRel}' with cmd.exe: the script path or an argument contains characters ` +
          `cmd.exe cannot pass safely (one of " % ! ^ & | < > or a control character).`
      );
      return;
    }
  }

  if (options.dryRun) {
    results.scripts_run.push({
      script: scriptRel,
      exit_code: 0,
      stdout: `[dry-run] Would run: ${normalizedInterp} ${scriptRel} ${args.join(' ')} (cwd: ${cwd})`.trim(),
      stderr: '',
    });
    return;
  }

  const buildSpawnArgs = (interp: string): [string, string[], boolean] => {
    if (interp === 'cmd') {
      const cmdLine = `"${[resolvedScript, ...args].map((a) => `"${a}"`).join(' ')}"`;
      return ['cmd.exe', ['/d', '/s', '/c', cmdLine], true];
    }
    if (interp === 'pwsh' || interp === 'powershell') {
      return [interp, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedScript, ...args], false];
    }
    return [interp, [resolvedScript, ...args], false];
  };

  let [bin, spawnArgs, verbatim] = buildSpawnArgs(normalizedInterp);
  let result = await runProcessAsync(bin, spawnArgs, cwd, verbatim, timeoutMs);

  // Fallback from pwsh to Windows PowerShell if pwsh is not installed
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === 'ENOENT' &&
    normalizedInterp === 'pwsh' &&
    !rawInterpreter &&
    process.platform === 'win32'
  ) {
    [bin, spawnArgs, verbatim] = buildSpawnArgs('powershell');
    result = await runProcessAsync(bin, spawnArgs, cwd, verbatim, timeoutMs);
  }

  // Fallback from python to python3 if python is not installed
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === 'ENOENT' &&
    normalizedInterp === 'python' &&
    !rawInterpreter
  ) {
    [bin, spawnArgs, verbatim] = buildSpawnArgs('python3');
    result = await runProcessAsync(bin, spawnArgs, cwd, verbatim, timeoutMs);
  }

  const stdout = result.stdout.slice(-2000);
  const stderr = (result.stderr || (result.error ? result.error.message : '')).slice(-1000);
  const exitCode = result.error ? 1 : (result.status ?? 1);

  results.scripts_run.push({ script: scriptRel, exit_code: exitCode, stdout, stderr });

  if (result.error) {
    results.errors.push(`Failed to execute '${bin}' for '${scriptRel}': ${result.error.message}`);
  } else if (exitCode !== 0) {
    results.errors.push(`Script '${scriptRel}' exited with code ${exitCode}: ${stderr.slice(-200)}`);
  }
}

function executeMkdirStep(
  step: Record<string, unknown>,
  inputs: Record<string, string>,
  results: WorkflowResults,
  dryRun: boolean
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
  if (!dryRun) {
    fs.mkdirSync(targetCheck.resolvedPath, { recursive: true });
  }
  if (!results.files_created.includes(targetCheck.resolvedPath)) {
    results.files_created.push(targetCheck.resolvedPath);
  }
}

export async function executeWorkflowSteps(
  workflowName: string,
  folder: string,
  steps: Array<Record<string, unknown>>,
  inputValues: Record<string, string>,
  options: WorkflowExecutionOptions = {}
): Promise<WorkflowResults> {
  const dryRun = Boolean(options.dryRun);
  const results: WorkflowResults = {
    workflow: workflowName,
    ...(dryRun ? { dry_run: true } : {}),
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
    const prevErrors = results.errors.length;

    if (step.when !== undefined && !evaluateWhenCondition(step.when, inputValues, results)) {
      if (results.errors.length > prevErrors && !step.continue_on_error) break;
      continue;
    }

    try {
      if (action === 'copy') {
        executeCopyStep(step, folder, inputValues, results, dryRun);
      } else if (action === 'copy_dir') {
        executeCopyDirStep(step, folder, inputValues, results, dryRun);
      } else if (action === 'patch') {
        executePatchStep(step, inputValues, results, dryRun);
      } else if (action === 'run') {
        await executeRunStep(step, folder, inputValues, results, options);
      } else if (action === 'mkdir') {
        executeMkdirStep(step, inputValues, results, dryRun);
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
    if (results.errors.length > prevErrors && !step.continue_on_error) {
      break;
    }
  }

  const patchedSummary =
    results.files_patched && results.files_patched.length > 0
      ? `${results.files_patched.length} patched, `
      : '';

  results.summary =
    `${dryRun ? '[DRY RUN] ' : ''}` +
    `${results.files_created.length} files created, ` +
    `${patchedSummary}` +
    `${results.files_skipped.length} skipped, ` +
    `${results.scripts_run.length} scripts run, ` +
    `${results.errors.length} errors`;

  return results;
}
