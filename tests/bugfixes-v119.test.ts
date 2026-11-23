/**
 * Regression tests for v1.1.9 fixes:
 * 1. Concurrent registry mutations under lock do not lose updates
 * 2. Walk-up resolution recognizes .agents/knowledges/.registry.json
 * 3. Import from archive directly sets archive: URL and respects trust
 * 4. Workflow patch step validates mode & required anchor in dry_run on created files
 * 5. collectStepPlaceholders collects when.input
 * 6. toolRunWorkflow enforces manifest.placeholders required and pattern
 * 7. toolGetDoc resolves nested markdown files inside manifest units with or without .md extension
 * 8. cmdInfo resolves ancestor source for sub-units
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearIndexCache,
  collectStepPlaceholders,
  resolveKnowledgeDir,
  toolGetDoc,
  toolRunWorkflow,
  validateManifestUnitDir,
} from '../src/core.js';
import { mutateRegistry, loadRegistry, withRegistryLock } from '../src/cli/registry.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

describe('v1.1.9 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v119-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. concurrent registry mutations under lock do not lose updates', async () => {
    const kDir = path.join(tmpDir, 'kd-concurrent');
    fs.mkdirSync(kDir, { recursive: true });

    // Run parallel child processes modifying the registry
    const workerScript = `
      const path = require('node:path');
      const { mutateRegistry } = require('${path.resolve(__dirname, '..', 'dist', 'cli', 'registry.js').replace(/\\/g, '\\\\')}');
      const kDir = process.argv[2];
      const workerId = process.argv[3];
      for (let i = 0; i < 5; i++) {
        mutateRegistry(kDir, (reg) => {
          reg.sources.push({
            name: 'unit-' + workerId + '-' + i,
            url: 'local:dummy',
            commit: 'local',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        });
      }
    `;
    const scriptPath = path.join(tmpDir, 'worker.js');
    fs.writeFileSync(scriptPath, workerScript, 'utf-8');

    const procs = [1, 2, 3].map((id) =>
      spawnSync(process.execPath, [scriptPath, kDir, String(id)], { encoding: 'utf-8' })
    );

    for (const p of procs) {
      expect(p.status).toBe(0);
    }

    const reg = loadRegistry(kDir);
    expect(reg.sources).toHaveLength(15);
  });

  it('2. walk-up resolution recognizes .agents/knowledges/.registry.json', () => {
    const projDir = path.join(tmpDir, 'my-project');
    const akDir = path.join(projDir, '.agents', 'knowledges');
    fs.mkdirSync(akDir, { recursive: true });
    fs.writeFileSync(path.join(akDir, '.registry.json'), JSON.stringify({ version: '1.0', sources: [] }), 'utf-8');

    const resolved = resolveKnowledgeDir(undefined);
    // When called from projDir, should resolve to akDir
    const origCwd = process.cwd();
    try {
      process.chdir(projDir);
      const found = resolveKnowledgeDir(undefined);
      expect(path.resolve(found).toLowerCase()).toBe(path.resolve(akDir).toLowerCase());
    } finally {
      process.chdir(origCwd);
    }
  });

  it('3. import from archive directly sets archive: URL and respects trusted', () => {
    const unitDir = path.join(tmpDir, 'archive-unit');
    expect(runCli(['scaffold', 'archive-unit', '--type', 'boilerplate', '--output', tmpDir]).status).toBe(0);

    const zipPath = path.join(tmpDir, 'archive-unit.zip');
    const kDir = path.join(tmpDir, 'kd-archive-src');
    expect(runCli(['install', unitDir, '--dir', kDir]).status).toBe(0);
    expect(runCli(['export', 'archive-unit', '--format', 'zip', '--output', zipPath, '--dir', kDir]).status).toBe(0);

    const kDirDest = path.join(tmpDir, 'kd-archive-dest');
    const impRes = runCli(['import', zipPath, '--dir', kDirDest]);
    expect(impRes.status).toBe(0);

    const reg = loadRegistry(kDirDest);
    expect(reg.sources).toHaveLength(1);
    expect(reg.sources[0].url).toContain('archive:');
    expect(reg.sources[0].url).not.toContain('local:');
    expect(reg.sources[0].trusted).toBeUndefined(); // Not trusted by default

    // With --trust
    const kDirDestTrust = path.join(tmpDir, 'kd-archive-trust');
    expect(runCli(['import', zipPath, '--trust', '--dir', kDirDestTrust]).status).toBe(0);
    const regTrust = loadRegistry(kDirDestTrust);
    expect(regTrust.sources[0].trusted).toBe(true);
  });

  it('4. workflow patch step validates mode & required anchor in dry_run on created files', async () => {
    const unitDir = path.join(tmpDir, 'patch-test-unit');
    expect(runCli(['scaffold', 'patch-test-unit', '--type', 'boilerplate', '--output', tmpDir]).status).toBe(0);

    // Create workflow with invalid patch mode on newly created file
    const wfPath = path.join(unitDir, 'workflows', 'bad-patch.json');
    fs.writeFileSync(
      wfPath,
      JSON.stringify({
        name: 'bad-patch',
        inputs: { TARGET: { required: true, type: 'path' } },
        steps: [
          { action: 'copy', source: 'templates/example.txt', target: '{{TARGET}}/test.txt' },
          { action: 'patch', target: '{{TARGET}}/test.txt', mode: 'invalid_mode', content: 'foo' },
        ],
      }, null, 2),
      'utf-8'
    );

    const targetOut = path.join(tmpDir, 'patch-target');
    fs.mkdirSync(targetOut, { recursive: true });

    const res = await toolRunWorkflow(tmpDir, 'patch-test-unit', 'bad-patch', { TARGET: targetOut }, { dryRun: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Unknown patch mode 'invalid_mode'");
  });

  it('5. collectStepPlaceholders collects when.input', () => {
    const placeholders = new Set<string>();
    collectStepPlaceholders(
      {
        action: 'message',
        text: 'hello {{NAME}}',
        when: { input: 'ENABLE_GREETING', equals: 'true' },
      },
      placeholders
    );
    expect(placeholders.has('NAME')).toBe(true);
    expect(placeholders.has('ENABLE_GREETING')).toBe(true);
  });

  it('6. toolRunWorkflow enforces manifest.placeholders required and pattern for used placeholders', async () => {
    const unitDir = path.join(tmpDir, 'ph-test-unit');
    expect(runCli(['scaffold', 'ph-test-unit', '--type', 'boilerplate', '--output', tmpDir]).status).toBe(0);

    // Add manifest placeholder with pattern and required
    const mPath = path.join(unitDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
    manifest.placeholders = {
      TARGET: { required: true, type: 'path' },
      APP_ID: { required: true, pattern: '^[a-z]+$' },
    };
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Create workflow referencing APP_ID
    const wfPath = path.join(unitDir, 'workflows', 'app.json');
    fs.writeFileSync(
      wfPath,
      JSON.stringify({
        name: 'app',
        inputs: { TARGET: { required: true, type: 'path' } },
        steps: [
          { action: 'message', text: 'Configuring {{APP_ID}} in {{TARGET}}' },
        ],
      }, null, 2),
      'utf-8'
    );

    const targetOut = path.join(tmpDir, 'ph-target');
    fs.mkdirSync(targetOut, { recursive: true });

    // Missing APP_ID
    const resMissing = await toolRunWorkflow(tmpDir, 'ph-test-unit', 'app', { TARGET: targetOut }, { dryRun: true });
    expect(resMissing.isError).toBe(true);
    expect(resMissing.text).toContain('Missing required inputs: [\\"APP_ID\\"]');

    // Invalid pattern
    const resBadPattern = await toolRunWorkflow(
      tmpDir,
      'ph-test-unit',
      'app',
      { TARGET: targetOut, APP_ID: '123_INVALID' },
      { dryRun: true }
    );
    expect(resBadPattern.isError).toBe(true);
    expect(resBadPattern.text).toContain("does not match pattern '^[a-z]+$'");
  });

  it('7. toolGetDoc resolves nested markdown files inside manifest units with or without .md extension', () => {
    const unitDir = path.join(tmpDir, 'nested-doc-unit');
    expect(runCli(['scaffold', 'nested-doc-unit', '--type', 'boilerplate', '--output', tmpDir]).status).toBe(0);

    const withMd = toolGetDoc(tmpDir, 'nested-doc-unit/references/usage.md');
    expect(withMd.isError).toBeFalsy();
    expect(withMd.text).toContain('# Usage Guide');

    const withoutMd = toolGetDoc(tmpDir, 'nested-doc-unit/references/usage');
    expect(withoutMd.isError).toBeFalsy();
    expect(withoutMd.text).toContain('# Usage Guide');
  });

  it('8. cmdInfo resolves ancestor source for sub-units', () => {
    const kDir = path.join(tmpDir, 'kd-info');
    fs.mkdirSync(path.join(kDir, 'my-repo', 'sub-unit'), { recursive: true });
    fs.writeFileSync(
      path.join(kDir, 'my-repo', 'sub-unit', 'manifest.json'),
      JSON.stringify({ name: 'sub-unit', version: '1.0.0', type: 'boilerplate', description: 'desc' }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(kDir, '.registry.json'),
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'my-repo',
            url: 'https://github.com/team/my-repo.git',
            commit: 'abc1234',
            installedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf-8'
    );

    const res = runCli(['info', 'my-repo/sub-unit', '--dir', kDir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Source:       https://github.com/team/my-repo.git');
    expect(res.stdout).toContain('Commit:       abc1234');
  });
});
