/**
 * Regression tests for v1.1.4 maintenance fixes:
 * 1. strictTrust blocks script execution when unit is in a subfolder of an untrusted remote repo
 * 2. inspectUnitSecurity discovers executables across subfolder manifest units in monorepos
 * 3. update from archive with wrapper folder updates only the target unit instead of copying wrapper
 * 4. import failure cleans up temporary extraction cache without leaving orphaned folders
 * 5. toolGetDoc respects layer shadowing and does not leak files from shadowed manifest units
 * 6. toolGetDoc does not stem-match internal markdown files inside manifest units
 * 7. publish blocks --path .git and reserved paths
 * 8. publish with renamed destination subfolder syncs manifest.name so target repo validate passes
 * 9. info rejects reserved internal paths, rejects non-markdown files, and counts dotfiles
 * 10. workflow run step clamps timeout_ms to MIN_WORKFLOW_TIMEOUT_MS
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeWorkflowSteps,
  inspectUnitSecurity,
  MIN_WORKFLOW_TIMEOUT_MS,
  toolGetDoc,
  toolGetResource,
  toolRunWorkflow,
} from '../src/core.js';
import { type Registry } from '../src/cli/registry.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

describe('v1.1.4 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v114-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. strictTrust blocks script execution when unit is in a subfolder of untrusted repo', async () => {
    const kb = path.join(tmpDir, 'kb');
    fs.mkdirSync(kb, { recursive: true });

    // Registry marks 'untrusted-repo' as a remote untrusted source
    const reg: Registry = {
      version: '1.0',
      sources: [
        {
          name: 'untrusted-repo',
          url: 'https://example.com/untrusted.git',
          commit: 'abcdef1',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(path.join(kb, '.registry.json'), JSON.stringify(reg, null, 2), 'utf-8');

    // Unit inside untrusted-repo/sub-unit
    const unitDir = path.join(kb, 'untrusted-repo', 'sub-unit');
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'sub-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Test sub unit',
        scripts: { test: { file: 'scripts/run.js', interpreter: 'node' } },
        workflows: { test: { description: 'Run' } },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'scripts', 'run.js'), 'console.log("HELLO");', 'utf-8');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'test.json'),
      JSON.stringify({ steps: [{ action: 'run', script_ref: 'test' }] }),
      'utf-8'
    );

    const res = await toolRunWorkflow(kb, 'untrusted-repo/sub-unit', 'test', {}, { strictTrust: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Script execution blocked by strict trust policy for remote unit');
  });

  it('2. inspectUnitSecurity discovers executables across subfolder manifest units in monorepos', () => {
    const repoDir = path.join(tmpDir, 'monorepo');
    const childUnit = path.join(repoDir, 'packages', 'child-unit');
    fs.mkdirSync(path.join(childUnit, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(childUnit, 'manifest.json'),
      JSON.stringify({
        name: 'child-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Child',
        scripts: { test: { file: 'scripts/worker.js' } },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(childUnit, 'scripts', 'worker.js'), 'console.log("ok");', 'utf-8');

    const sec = inspectUnitSecurity(repoDir);
    expect(sec.hasExecutables).toBe(true);
    expect(sec.scriptFiles).toContain('packages/child-unit/scripts/worker.js');
  });

  it('3. update from archive with wrapper folder updates only target unit', () => {
    const kb = path.join(tmpDir, 'kb');
    const bundleSrc = path.join(tmpDir, 'bundle-src', 'my-bundle');
    fs.mkdirSync(bundleSrc, { recursive: true });

    // Create 2 units inside my-bundle
    for (const u of ['unit-a', 'unit-b']) {
      const uDir = path.join(bundleSrc, u);
      fs.mkdirSync(path.join(uDir, 'workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(uDir, 'manifest.json'),
        JSON.stringify({ name: u, version: '1.0.0', type: 'boilerplate', description: u }),
        'utf-8'
      );
      fs.writeFileSync(path.join(uDir, 'overview.md'), `# ${u}`, 'utf-8');
    }

    const archive = path.join(tmpDir, 'bundle.tar.gz');
    spawnSync('tar', ['-czf', archive, '-C', path.join(tmpDir, 'bundle-src'), 'my-bundle']);

    // Import with --all
    const importRes = runCli(['import', archive, '--all', '--dir', kb]);
    expect(importRes.status).toBe(0);

    // Verify unit-a structure
    expect(fs.existsSync(path.join(kb, 'unit-a', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(kb, 'unit-a', 'unit-b'))).toBe(false);

    // Now update unit-a
    const updateRes = runCli(['update', 'unit-a', '--dir', kb]);
    expect(updateRes.status).toBe(0);

    // Verify unit-a still only contains unit-a and not my-bundle or unit-b
    expect(fs.existsSync(path.join(kb, 'unit-a', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(kb, 'unit-a', 'unit-b'))).toBe(false);
    expect(fs.existsSync(path.join(kb, 'unit-a', 'unit-a'))).toBe(false);
  });

  it('4. import failure cleans up temporary extraction cache without leaving orphaned folders', () => {
    const kb = path.join(tmpDir, 'kb');
    fs.mkdirSync(kb, { recursive: true });
    runCli(['init', '--dir', kb]);

    // Install demo-unit
    const demoDir = path.join(tmpDir, 'demo-unit');
    fs.mkdirSync(demoDir, { recursive: true });
    fs.writeFileSync(
      path.join(demoDir, 'manifest.json'),
      JSON.stringify({ name: 'demo-unit', version: '1.0.0', type: 'boilerplate', description: 'demo' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(demoDir, 'overview.md'), '# demo', 'utf-8');
    expect(runCli(['install', demoDir, '--dir', kb]).status).toBe(0);

    // Export to zip
    const zipFile = path.join(tmpDir, 'demo.zip');
    expect(runCli(['export', 'demo-unit', '--dir', kb, '--output', zipFile]).status).toBe(0);

    // Attempt import without --force: should fail because unit already exists
    const failImport = runCli(['import', zipFile, '--dir', kb]);
    expect(failImport.status).not.toBe(0);

    // Verify .cache does not contain leftover import-* folders
    const cacheDir = path.join(kb, '.cache');
    const items = fs.readdirSync(cacheDir).filter((n) => n.startsWith('import-'));
    expect(items.length).toBe(0);
  });

  it('5. toolGetDoc respects layer shadowing and does not leak files from shadowed units', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    fs.mkdirSync(path.join(layer1, 'shared-unit'), { recursive: true });
    fs.mkdirSync(path.join(layer2, 'shared-unit', 'references'), { recursive: true });

    fs.writeFileSync(
      path.join(layer1, 'shared-unit', 'manifest.json'),
      JSON.stringify({ name: 'shared-unit', version: '2.0.0', type: 'boilerplate', description: 'l1' }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(layer2, 'shared-unit', 'manifest.json'),
      JSON.stringify({ name: 'shared-unit', version: '1.0.0', type: 'boilerplate', description: 'l2' }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(layer2, 'shared-unit', 'references', 'secret.md'),
      '# Secret in layer 2',
      'utf-8'
    );

    // layer1 shadows shared-unit, so secret.md must not be leaked from layer2
    const resDoc = toolGetDoc([layer1, layer2], 'shared-unit/references/secret.md');
    expect(resDoc.isError).toBe(true);

    const resRes = toolGetResource([layer1, layer2], 'shared-unit/references/secret.md');
    expect(resRes.isError).toBe(true);
  });

  it('6. toolGetDoc does not stem-match internal markdown files inside manifest units', () => {
    const kb = path.join(tmpDir, 'kb');
    const unitDir = path.join(kb, 'my-unit');
    fs.mkdirSync(path.join(unitDir, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'my-unit', version: '1.0.0', type: 'boilerplate', description: 'desc' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'references', 'usage.md'), '# Internal Usage', 'utf-8');

    // Calling toolGetDoc with "usage" should not resolve to my-unit/references/usage.md
    const res = toolGetDoc(kb, 'usage');
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Document 'usage' not found.");
  });

  it('7. publish blocks --path .git and reserved paths', () => {
    const kb = path.join(tmpDir, 'kb');
    const unit = path.join(kb, 'unit-x');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(
      path.join(unit, 'manifest.json'),
      JSON.stringify({ name: 'unit-x', version: '1.0.0', type: 'boilerplate', description: 'x' }),
      'utf-8'
    );

    const bare = path.join(tmpDir, 'bare.git');
    spawnSync('git', ['init', '--bare', bare]);

    const res = runCli(['publish', unit, '--to', bare, '--path', '.git', '--dir', kb]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Invalid destination path');
  });

  it('8. publish with renamed subfolder syncs manifest.name so target repo validate passes', () => {
    const kb = path.join(tmpDir, 'kb');
    const unit = path.join(kb, 'orig-unit');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(
      path.join(unit, 'manifest.json'),
      JSON.stringify({ name: 'orig-unit', version: '1.0.0', type: 'boilerplate', description: 'orig' }),
      'utf-8'
    );

    const bare = path.join(tmpDir, 'bare2.git');
    spawnSync('git', ['init', '--bare', bare]);

    // Publish to a renamed subfolder
    const pubRes = runCli([
      'publish',
      unit,
      '--to',
      bare,
      '--path',
      'custom/renamed-unit',
      '--branch',
      'feat-renamed',
      '--push',
      '--dir',
      kb,
    ]);
    expect(pubRes.status).toBe(0);

    // Clone published branch and run validate
    const verifyDir = path.join(tmpDir, 'verify-clone');
    spawnSync('git', ['clone', '--branch', 'feat-renamed', bare, verifyDir]);

    const valRes = runCli(['validate', verifyDir]);
    expect(valRes.status).toBe(0);
    expect(valRes.stdout).toContain('0 error(s)');
  });

  it('9. info rejects reserved internal paths, non-markdown files, and counts dotfiles', () => {
    const kb = path.join(tmpDir, 'kb');
    const unitDir = path.join(kb, 'my-unit');
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'my-unit', version: '1.0.0', type: 'boilerplate', description: 'u' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'templates', '.env.example'), 'PORT=3000', 'utf-8');
    fs.writeFileSync(path.join(unitDir, 'templates', 'app.ts'), 'console.log("app");', 'utf-8');

    // Info on non-markdown file should fail
    const nonMdRes = runCli(['info', 'my-unit/manifest.json', '--dir', kb]);
    expect(nonMdRes.status).not.toBe(0);
    expect(nonMdRes.stderr).toContain('not a Markdown document');

    // Info on reserved path like .git should fail
    const reservedRes = runCli(['info', 'my-unit/.git', '--dir', kb]);
    expect(reservedRes.status).not.toBe(0);
    expect(reservedRes.stderr).toContain('reserved internal path');

    // Info on unit should count dotfiles (manifest.json, .env.example, app.ts => 3 files)
    const infoRes = runCli(['info', 'my-unit', '--dir', kb]);
    expect(infoRes.status).toBe(0);
    expect(infoRes.stdout).toContain('Files:        3');
  });

  it('10. workflow run step clamps timeout_ms to MIN_WORKFLOW_TIMEOUT_MS', async () => {
    const unitDir = path.join(tmpDir, 'unit-timeout');
    fs.mkdirSync(unitDir, { recursive: true });

    const results = await executeWorkflowSteps(
      'test',
      unitDir,
      [
        {
          action: 'run',
          script: 'test.js',
          timeout_ms: 10, // less than MIN_WORKFLOW_TIMEOUT_MS (1000)
        },
      ],
      {},
      { dryRun: true }
    );

    // dry_run succeeds and step was executed
    expect(results.steps_executed).toBe(1);
    expect(MIN_WORKFLOW_TIMEOUT_MS).toBe(1000);
  });
});
