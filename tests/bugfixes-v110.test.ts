/**
 * Regression tests for v1.1.0 maintenance fixes:
 * 1. archive: URL handling in outdated, update, pin, sync
 * 2. KNOWLEDGE_DIRS vs KNOWLEDGE_DIR precedence
 * 3. Multi-layer nested unit shadowing in toolGetResource
 * 4. collectStepPlaceholders collecting patch anchor and skip_if_contains
 * 5. expandBraces and glob brace expansion {ts,js}
 * 6. CLI global flags (--include-global, --no-global, --read-only, --strict-trust) with subcommands
 * 7. Clear error message when workflow run step has non-existent cwd
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectStepPlaceholders,
  expandBraces,
  resolveKnowledgeDir,
  resolveKnowledgeDirs,
  resolveUnitFiles,
  toolGetResource,
  toolRunWorkflow,
} from '../src/core.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 25_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

describe('v1.1.0 Bug Fixes & Edge Cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. archive: sources should not trigger git SSH errors in outdated, update, pin, or sync', () => {
    const kdir = path.join(tmpDir, 'k1');
    const work = path.join(tmpDir, 'work');
    fs.mkdirSync(work, { recursive: true });

    expect(runCli(['init', '--dir', kdir]).status).toBe(0);
    expect(runCli(['scaffold', 'demo-unit', '--type', 'boilerplate', '--output', work]).status).toBe(0);
    expect(runCli(['install', path.join(work, 'demo-unit'), '--dir', kdir]).status).toBe(0);

    const zipPath = path.join(tmpDir, 'demo-unit.zip');
    expect(runCli(['export', 'demo-unit', '--dir', kdir, '--output', zipPath, '--format', 'zip']).status).toBe(0);

    const kdir2 = path.join(tmpDir, 'k2');
    expect(runCli(['init', '--dir', kdir2]).status).toBe(0);
    expect(runCli(['import', zipPath, '--dir', kdir2]).status).toBe(0);

    // Check outdated
    const outRes = runCli(['outdated', '--dir', kdir2]);
    expect(outRes.status).toBe(0);
    expect(outRes.stdout).toContain('demo-unit: archive');

    // Check update
    const upRes = runCli(['update', '--dir', kdir2]);
    expect(upRes.status).toBe(0);
    expect(upRes.stdout).toContain('Updated from archive');
    expect(upRes.stderr).not.toContain('Could not resolve hostname archive');

    // Check sync
    const syncRes = runCli(['sync', '--dir', kdir2]);
    expect(syncRes.status).toBe(0);
    expect(syncRes.stdout).toContain('No remote sources to sync');

    // Check pin with version
    const pinRes = runCli(['pin', 'demo-unit', 'v1.0.0', '--dir', kdir2]);
    expect(pinRes.status).toBe(1);
    expect(pinRes.stderr).toContain("was installed from a archive and has no git history");
  });

  it('2. resolveKnowledgeDir should prioritize KNOWLEDGE_DIRS before KNOWLEDGE_DIR', () => {
    const dirA = path.join(tmpDir, 'envA');
    const dirB = path.join(tmpDir, 'envB');
    const originalDirs = process.env.KNOWLEDGE_DIRS;
    const originalDir = process.env.KNOWLEDGE_DIR;

    try {
      process.env.KNOWLEDGE_DIRS = dirA;
      process.env.KNOWLEDGE_DIR = dirB;

      const single = resolveKnowledgeDir();
      const multi = resolveKnowledgeDirs();

      expect(single).toBe(path.resolve(dirA));
      expect(multi[0]).toBe(path.resolve(dirA));
    } finally {
      if (originalDirs !== undefined) process.env.KNOWLEDGE_DIRS = originalDirs;
      else delete process.env.KNOWLEDGE_DIRS;
      if (originalDir !== undefined) process.env.KNOWLEDGE_DIR = originalDir;
      else delete process.env.KNOWLEDGE_DIR;
    }
  });

  it('3. toolGetResource should not leak files from shadowed nested units across layers', () => {
    const layer0 = path.join(tmpDir, 'layer0');
    const layer1 = path.join(tmpDir, 'layer1');

    const nestedL0 = path.join(layer0, 'java', 'spring-kit');
    const nestedL1 = path.join(layer1, 'java', 'spring-kit');
    fs.mkdirSync(nestedL0, { recursive: true });
    fs.mkdirSync(nestedL1, { recursive: true });

    fs.writeFileSync(path.join(nestedL0, 'manifest.json'), JSON.stringify({
      name: 'spring-kit', version: '2.0.0', type: 'toolkit', description: 'v2'
    }));
    fs.writeFileSync(path.join(nestedL1, 'manifest.json'), JSON.stringify({
      name: 'spring-kit', version: '1.0.0', type: 'toolkit', description: 'v1'
    }));
    fs.writeFileSync(path.join(nestedL1, 'legacy-secret.txt'), 'OLD_SECRET');

    const res = toolGetResource([layer0, layer1], 'java/spring-kit/legacy-secret.txt');
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Resource 'java/spring-kit/legacy-secret.txt' not found");
  });

  it('4. collectStepPlaceholders should collect patch anchor and skip_if_contains', () => {
    const out = new Set<string>();
    collectStepPlaceholders(
      {
        action: 'patch',
        target: '{{TARGET}}/file.txt',
        mode: 'insert_after',
        anchor: '{{ANCHOR_TAG}}',
        content: '{{INJECTED_CODE}}',
        skip_if_contains: '{{MARKER_TEXT}}',
      },
      out
    );

    expect(out.has('TARGET')).toBe(true);
    expect(out.has('ANCHOR_TAG')).toBe(true);
    expect(out.has('INJECTED_CODE')).toBe(true);
    expect(out.has('MARKER_TEXT')).toBe(true);
  });

  it('5. expandBraces should expand patterns and resolveUnitFiles should match {ts,js}', () => {
    expect(expandBraces('src/**/*.{ts,js}')).toEqual(['src/**/*.ts', 'src/**/*.js']);
    expect(expandBraces('plain/path.txt')).toEqual(['plain/path.txt']);

    const unitDir = path.join(tmpDir, 'glob-unit');
    fs.mkdirSync(path.join(unitDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'src', 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(unitDir, 'src', 'b.js'), 'export const b = 2;');
    fs.writeFileSync(path.join(unitDir, 'src', 'c.css'), 'body {}');

    const res = resolveUnitFiles(unitDir, ['src/**/*.{ts,js}']);
    expect(res.files).toEqual(['src/a.ts', 'src/b.js']);
    expect(res.missingLiterals).toEqual([]);
    expect(res.escapedPatterns).toEqual([]);
  });

  it('6. CLI global flags should work seamlessly when placed before subcommands', () => {
    const kdir = path.join(tmpDir, 'k-flags');
    expect(runCli(['init', '--dir', kdir]).status).toBe(0);

    const res1 = runCli(['--include-global', 'list', '--dir', kdir]);
    expect(res1.status).toBe(0);

    const res2 = runCli(['--no-global', 'list', '--dir', kdir]);
    expect(res2.status).toBe(0);

    const res3 = runCli(['--read-only', 'list', '--dir', kdir]);
    expect(res3.status).toBe(0);

    const res4 = runCli(['search', '--type', 'boilerplate', 'test', '--dir', kdir]);
    expect(res4.status).toBe(0);
  });

  it('7. Workflow run step should report clear error when cwd does not exist', async () => {
    const unitDir = path.join(tmpDir, 'workflow-unit');
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'workflow-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Test cwd',
      })
    );
    fs.writeFileSync(path.join(unitDir, 'scripts', 'test.js'), 'console.log("ok");');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'bad-cwd.json'),
      JSON.stringify({
        name: 'bad-cwd',
        inputs: { TARGET: { required: true, type: 'path' } },
        steps: [
          {
            action: 'run',
            script: 'scripts/test.js',
            cwd: '{{TARGET}}/does-not-exist',
          },
        ],
      })
    );

    const targetDir = path.join(tmpDir, 'target');
    fs.mkdirSync(targetDir, { recursive: true });

    const res = await toolRunWorkflow(tmpDir, 'workflow-unit', 'bad-cwd', {
      TARGET: targetDir,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Working directory not found');
  });
});
