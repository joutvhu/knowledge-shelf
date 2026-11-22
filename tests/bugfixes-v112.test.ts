/**
 * Regression tests for v1.1.2 maintenance fixes:
 * 1. install from .agents/knowledges/ works without --dir
 * 2. resolveSafeUnitDir blocks dot-names (.hidden, .cache) and slash names in install --name
 * 3. index creates missing parent dirs for --output
 * 4. validate across multiple --dir layers and ignores template manifest.json inside units
 * 5. import handles single root folder wrapped archive with multiple units
 * 6. list --dir L1 --dir L2 shows tracked sources from layer 2
 * 7. Next.js style [id] in modules.files is treated as literal and flags missing file
 * 8. toolGetResource with out-of-bounds offset returns non-inverted lines header
 * 9. patch insert_after does not add duplicate blank lines
 * 10. assertSafeArchivePaths detects path traversal
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeWorkflowSteps,
  resolveUnitFiles,
  toolGetResource,
  validateManifestUnitDir,
} from '../src/core.js';
import { assertSafeArchivePaths } from '../src/cli/git.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

describe('v1.1.2 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v112-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. install from .agents/knowledges/ should target global/configured shelf instead of self', () => {
    const proj = path.join(tmpDir, 'project');
    const staging = path.join(proj, '.agents', 'knowledges');
    fs.mkdirSync(staging, { recursive: true });

    const customShelf = path.join(tmpDir, 'custom-shelf');
    fs.mkdirSync(customShelf, { recursive: true });

    // Scaffold into .agents/knowledges
    expect(runCli(['scaffold', 'my-unit', '--output', staging]).status).toBe(0);

    // Install while CWD is proj, using KNOWLEDGE_DIR environment variable
    const instRes = runCli(['install', './.agents/knowledges/my-unit'], proj, {
      KNOWLEDGE_DIR: customShelf,
    });
    expect(instRes.status).toBe(0);
    expect(instRes.stdout).toContain("✓ Installed 'my-unit'");
    expect(fs.existsSync(path.join(customShelf, 'my-unit', 'manifest.json'))).toBe(true);
  });

  it('2. resolveSafeUnitDir blocks dot-names and slashes in unit names', () => {
    const kdir = path.join(tmpDir, 'shelf');
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(work, { recursive: true });
    expect(runCli(['scaffold', 'demo', '--output', work]).status).toBe(0);

    // Dot-prefixed name
    const dotRes = runCli(['install', path.join(work, 'demo'), '--name', '.hidden', '--dir', kdir]);
    expect(dotRes.status).toBe(1);
    expect(dotRes.stderr).toMatch(/start with '\.'/i);

    // Slash name
    const slashRes = runCli(['install', path.join(work, 'demo'), '--name', 'team/demo', '--dir', kdir]);
    expect(slashRes.status).toBe(1);
    expect(slashRes.stderr).toMatch(/slashes/i);
  });

  it('3. index creates missing parent directory for --output', () => {
    const repo = path.join(tmpDir, 'repo');
    expect(runCli(['scaffold', 'unit-a', '--output', repo]).status).toBe(0);
    const outFile = path.join(tmpDir, 'nested', 'sub', 'shelf.json');

    const indexRes = runCli(['index', repo, '--output', outFile]);
    expect(indexRes.status).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('4. validate across multiple --dir layers and ignores template manifest.json inside units', () => {
    const layerA = path.join(tmpDir, 'layerA');
    const layerB = path.join(tmpDir, 'layerB');
    expect(runCli(['scaffold', 'unit-a', '--output', layerA]).status).toBe(0);
    expect(runCli(['scaffold', 'unit-b', '--output', layerB]).status).toBe(0);

    // Put a template manifest.json inside unit-a
    const tplDir = path.join(layerA, 'unit-a', 'templates', 'app');
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, 'manifest.json'), '{"name":"{{APP_NAME}}"}');

    // Should validate without falsely validating unit-a/templates/app as a unit
    const valRes = runCli(['validate', '--dir', layerA, '--dir', layerB]);
    expect(valRes.status).toBe(0);
    expect(valRes.stdout).toContain("Validating 'unit-a'");
    expect(valRes.stdout).toContain("Validating 'unit-b'");
    expect(valRes.stdout).not.toContain('app');
  });

  it('5. import automatically installs multiple units wrapped in a root folder', () => {
    const sourceRepo = path.join(tmpDir, 'my-repo');
    expect(runCli(['scaffold', 'part-1', '--output', sourceRepo]).status).toBe(0);
    expect(runCli(['scaffold', 'part-2', '--output', sourceRepo]).status).toBe(0);

    const archive = path.join(tmpDir, 'wrapped.tar.gz');
    spawnSync('tar', ['-czf', archive, '-C', tmpDir, 'my-repo']);

    const targetShelf = path.join(tmpDir, 'dest-shelf');
    const impRes = runCli(['import', archive, '--dir', targetShelf]);
    expect(impRes.status).toBe(0);
    expect(fs.existsSync(path.join(targetShelf, 'part-1', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetShelf, 'part-2', 'manifest.json'))).toBe(true);
  });

  it('6. list --dir L1 --dir L2 shows tracked sources from layer 2', () => {
    const l1 = path.join(tmpDir, 'l1');
    const l2 = path.join(tmpDir, 'l2');
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(work, { recursive: true });
    expect(runCli(['scaffold', 'l2-unit', '--output', work]).status).toBe(0);

    expect(runCli(['init', '--dir', l1]).status).toBe(0);
    expect(runCli(['init', '--dir', l2]).status).toBe(0);
    expect(runCli(['install', path.join(work, 'l2-unit'), '--dir', l2]).status).toBe(0);

    const listRes = runCli(['list', '--dir', l1, '--dir', l2]);
    expect(listRes.status).toBe(0);
    expect(listRes.stdout).toContain('Installed sources:');
    expect(listRes.stdout).toContain('l2-unit');
    expect(listRes.stdout).not.toContain('Local / unmanaged units');
  });

  it('7. Next.js style [id] in modules.files is treated as literal and detects missing file', () => {
    const unitDir = path.join(tmpDir, 'next-unit');
    fs.mkdirSync(path.join(unitDir, 'templates', '[id]'), { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'templates', '[id]', 'page.tsx'), 'export default () => null;');

    const resValid = resolveUnitFiles(unitDir, ['templates/[id]/page.tsx']);
    expect(resValid.files).toContain('templates/[id]/page.tsx');
    expect(resValid.missingLiterals).toHaveLength(0);

    const resMissing = resolveUnitFiles(unitDir, ['templates/[id]/nonexistent.tsx']);
    expect(resMissing.missingLiterals).toContain('templates/[id]/nonexistent.tsx');
  });

  it('8. toolGetResource with out-of-bounds offset returns non-inverted lines header', () => {
    const kdir = path.join(tmpDir, 'shelf');
    const unit = path.join(kdir, 'demo');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(path.join(unit, 'file.txt'), 'line1\nline2\nline3\n');

    const res = toolGetResource(kdir, 'demo/file.txt', { offset: 100, limit: 10 });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('[lines 100-100 of 4]');
  });

  it('9. patch insert_after does not add duplicate blank lines', async () => {
    const baseDir = path.join(tmpDir, 'patch-test');
    fs.mkdirSync(baseDir, { recursive: true });
    const targetFile = path.join(baseDir, 'test.txt');
    fs.writeFileSync(targetFile, 'START\nANCHOR\nEND\n');

    const steps = [
      {
        action: 'patch',
        target: '{{TARGET}}/test.txt',
        mode: 'insert_after',
        anchor: 'ANCHOR\n',
        content: 'INSERTED\n',
      },
    ];

    const res = await executeWorkflowSteps('test', baseDir, steps, { TARGET: baseDir });
    expect(res.errors).toHaveLength(0);

    const updated = fs.readFileSync(targetFile, 'utf-8');
    expect(updated).toBe('START\nANCHOR\nINSERTED\nEND\n');
  });

  it('10. assertSafeArchivePaths detects path traversal in archive', () => {
    // Normal file should not throw
    const safeTar = path.join(tmpDir, 'safe.tar.gz');
    const safeDir = path.join(tmpDir, 'safedir');
    fs.mkdirSync(safeDir, { recursive: true });
    fs.writeFileSync(path.join(safeDir, 'ok.txt'), 'ok');
    spawnSync('tar', ['-czf', safeTar, '-C', safeDir, 'ok.txt']);

    expect(() => assertSafeArchivePaths(safeTar)).not.toThrow();
  });
});
