/**
 * Regression tests for bug fixes v1.2.8:
 * 1. toolRunWorkflow: manifest.placeholders.*.default does not override workflow.inputs.*.required: true.
 * 2. cmdOutdated across multiple layers checks sources across all layers.
 * 3. cmdPin and cmdUnpin across multiple layers update the target layer registry and checkout.
 * 4. cmdTrust across multiple layers marks source trusted in its own layer.
 * 5. cmdUpdate across multiple layers updates sources in their respective layers.
 * 6. cmdPublish discovers and publishes units located in secondary layers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearIndexCache, toolRunWorkflow } from '../src/core.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function git(dir: string, args: string[]) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout || '').trim();
}

describe('Bug fixes v1.2.8 regression tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-v128-'));
    clearIndexCache();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. toolRunWorkflow: manifest.placeholders.*.default does not bypass workflow.inputs.*.required: true', async () => {
    const kd = path.join(tmpDir, 'kd-ph');
    const u = path.join(kd, 'ph-unit');
    fs.mkdirSync(path.join(u, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(u, 'manifest.json'),
      JSON.stringify({
        name: 'ph-unit',
        version: '1.0.0',
        type: 'template',
        description: 'Testing placeholder precedence',
        placeholders: {
          TARGET: { required: true, type: 'path' },
          ENV: { type: 'string', default: 'dev' },
        },
      }),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(u, 'workflows', 'deploy.json'),
      JSON.stringify({
        inputs: {
          TARGET: { required: true },
          ENV: { required: true },
        },
        steps: [{ action: 'message', text: 'Deploying to {{ENV}}' }],
      }),
      'utf-8'
    );

    const outDir = path.join(tmpDir, 'out-ph');
    // Calling without ENV must fail with missing required inputs: ["ENV"]
    const res = await toolRunWorkflow(kd, 'ph-unit', 'deploy', { TARGET: outDir }, { dryRun: true });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed.error).toContain('Missing required inputs: ["ENV"]');

    // Calling with explicit ENV must succeed
    const resOk = await toolRunWorkflow(kd, 'ph-unit', 'deploy', { TARGET: outDir, ENV: 'prod' }, { dryRun: true });
    expect(resOk.isError).toBeFalsy();
    const parsedOk = JSON.parse(resOk.text);
    expect(parsedOk.messages[0]).toBe('Deploying to prod');
  });

  it('2. cmdOutdated across multiple layers checks sources across all layers', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    runCli(['init', '--dir', layer1, '--no-global']);
    runCli(['init', '--dir', layer2, '--no-global']);

    // Install unit in layer2
    const draft = path.join(tmpDir, 'draft');
    fs.mkdirSync(draft, { recursive: true });
    fs.writeFileSync(
      path.join(draft, 'manifest.json'),
      JSON.stringify({ name: 'l2-unit', version: '1.0.0', type: 'boilerplate', description: 'Desc' })
    );
    runCli(['install', draft, '--dir', layer2]);

    const res = runCli(['outdated', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Checking 1 source(s)');
    expect(res.stdout).toContain('l2-unit: local');
  });

  it('3. cmdPin and cmdUnpin across multiple layers update unit in secondary layer', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    runCli(['init', '--dir', layer1, '--no-global']);
    runCli(['init', '--dir', layer2, '--no-global']);

    const draft = path.join(tmpDir, 'draft');
    fs.mkdirSync(draft, { recursive: true });
    fs.writeFileSync(
      path.join(draft, 'manifest.json'),
      JSON.stringify({ name: 'l2-unit', version: '1.0.0', type: 'boilerplate', description: 'Desc' })
    );
    runCli(['install', draft, '--dir', layer2]);

    // Pin with layer1 as primary, layer2 as secondary
    const resPin = runCli(['pin', 'l2-unit', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(resPin.status).toBe(0);
    expect(resPin.stdout).toContain("✓ Pinned 'l2-unit'");

    const reg2 = JSON.parse(fs.readFileSync(path.join(layer2, '.registry.json'), 'utf-8'));
    expect(reg2.sources[0].pin).toBe('local');

    // Unpin across layers
    const resUnpin = runCli(['unpin', 'l2-unit', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(resUnpin.status).toBe(0);
    expect(resUnpin.stdout).toContain("✓ Unpinned 'l2-unit'");

    const reg2After = JSON.parse(fs.readFileSync(path.join(layer2, '.registry.json'), 'utf-8'));
    expect(reg2After.sources[0].pin).toBeUndefined();
  });

  it('4. cmdTrust across multiple layers updates trust state in target layer registry', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    runCli(['init', '--dir', layer1, '--no-global']);
    runCli(['init', '--dir', layer2, '--no-global']);

    const draft = path.join(tmpDir, 'draft');
    fs.mkdirSync(draft, { recursive: true });
    fs.writeFileSync(
      path.join(draft, 'manifest.json'),
      JSON.stringify({ name: 'l2-unit', version: '1.0.0', type: 'boilerplate', description: 'Desc' })
    );
    runCli(['install', draft, '--dir', layer2]);

    // Untrust
    const resUntrust = runCli(['untrust', 'l2-unit', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(resUntrust.status).toBe(0);
    expect(resUntrust.stdout).toContain("✓ Removed explicit trust for 'l2-unit'");

    const reg2 = JSON.parse(fs.readFileSync(path.join(layer2, '.registry.json'), 'utf-8'));
    expect(reg2.sources[0].trusted).toBe(false);

    // Trust
    const resTrust = runCli(['trust', 'l2-unit', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(resTrust.status).toBe(0);
    expect(resTrust.stdout).toContain("✓ Marked 'l2-unit' as trusted");

    const reg2After = JSON.parse(fs.readFileSync(path.join(layer2, '.registry.json'), 'utf-8'));
    expect(reg2After.sources[0].trusted).toBe(true);
  });

  it('5. cmdUpdate across multiple layers updates units in their respective layers', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    runCli(['init', '--dir', layer1, '--no-global']);
    runCli(['init', '--dir', layer2, '--no-global']);

    const draft = path.join(tmpDir, 'draft');
    fs.mkdirSync(draft, { recursive: true });
    fs.writeFileSync(
      path.join(draft, 'manifest.json'),
      JSON.stringify({ name: 'l2-unit', version: '1.0.0', type: 'boilerplate', description: 'Version 1' })
    );
    runCli(['install', draft, '--dir', layer2]);

    // Update draft content
    fs.writeFileSync(
      path.join(draft, 'manifest.json'),
      JSON.stringify({ name: 'l2-unit', version: '1.0.1', type: 'boilerplate', description: 'Version 2' })
    );

    // Run update with layer1 as primary, layer2 as secondary
    const resUpdate = runCli(['update', 'l2-unit', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(resUpdate.status).toBe(0);
    expect(resUpdate.stdout).toContain("Updating 'l2-unit' from local path");
    expect(resUpdate.stdout).toContain('✓ Updated from local path');

    const updatedManifest = JSON.parse(fs.readFileSync(path.join(layer2, 'l2-unit', 'manifest.json'), 'utf-8'));
    expect(updatedManifest.version).toBe('1.0.1');
  });

  it('6. cmdPublish finds and publishes units located in secondary layers', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    fs.mkdirSync(layer1, { recursive: true });
    fs.mkdirSync(layer2, { recursive: true });

    const bareRepo = path.join(tmpDir, 'pub.git');
    git(tmpDir, ['init', '--bare', bareRepo]);

    const unitDir = path.join(layer2, 'sec-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'sec-unit', version: '1.0.0', type: 'boilerplate', description: 'Secondary layer unit' })
    );
    fs.writeFileSync(path.join(unitDir, 'overview.md'), '# Sec Unit\n');

    // Publish with layer1 as primary, layer2 as secondary
    const res = runCli(['publish', 'sec-unit', '--to', bareRepo, '--branch', 'main', '--dir', layer1, '--dir', layer2, '--no-global']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Committed 'sec-unit'");
  });
});
