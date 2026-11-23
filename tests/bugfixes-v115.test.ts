/**
 * Regression tests for v1.1.5 fixes:
 * 1. update --force overwrites locally modified unit even when remote commit is unchanged
 * 2. list and init reject unknown flags, and --dir=<path> syntax is parsed properly
 * 3. add --all --trust marks standalone .md entries as trusted
 * 4. remove <name> resolves and deletes standalone <name>.md without requiring .md extension
 * 5. workflow dry_run recognizes files created in earlier steps when evaluating when.exists / when.not_exists
 * 6. export --format tar appends .tar.gz when output path has no extension
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toolRunWorkflow } from '../src/core.js';
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

describe('v1.1.5 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v115-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. update --force resets local modifications even when remote commit is unchanged', () => {
    const repo = path.join(tmpDir, 'remote-repo');
    fs.mkdirSync(repo, { recursive: true });
    const scaffoldRes = runCli(['scaffold', 'unit-a', '--type', 'boilerplate', '--output', repo]);
    expect(scaffoldRes.status).toBe(0);

    spawnSync('git', ['init', '-b', 'main'], { cwd: repo });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    const kb = path.join(tmpDir, 'kb');
    const addRes = runCli(['add', repo, '--path', 'unit-a', '--name', 'unit-a', '--dir', kb]);
    expect(addRes.status).toBe(0);

    const targetDoc = path.join(kb, 'unit-a', 'overview.md');
    fs.appendFileSync(targetDoc, '\nLOCAL DRIFT MODIFICATION\n', 'utf-8');

    // Without --force, update skips
    const updateNoForce = runCli(['update', 'unit-a', '--dir', kb]);
    expect(updateNoForce.stdout).toContain('local modifications detected');
    expect(fs.readFileSync(targetDoc, 'utf-8')).toContain('LOCAL DRIFT MODIFICATION');

    // With --force, update resets even when commit has not changed
    const updateForce = runCli(['update', 'unit-a', '--force', '--dir', kb]);
    expect(updateForce.status).toBe(0);
    expect(updateForce.stdout).toContain('Updated to');
    expect(fs.readFileSync(targetDoc, 'utf-8')).not.toContain('LOCAL DRIFT MODIFICATION');
  });

  it('2. list and init reject unknown flags, and --dir=<path> syntax is parsed properly', () => {
    const kb = path.join(tmpDir, 'kb');
    runCli(['init', '--dir', kb]);

    // Unknown flag rejection
    const listUnknown = runCli(['list', '--bogus-flag', '--dir', kb]);
    expect(listUnknown.status).toBe(1);
    expect(listUnknown.stderr).toContain("Unknown option '--bogus-flag' for 'list'");

    const initUnknown = runCli(['init', '--bogus-flag', '--dir', kb]);
    expect(initUnknown.status).toBe(1);
    expect(initUnknown.stderr).toContain("Unknown option '--bogus-flag' for 'init'");

    // --dir=<path> syntax works properly
    const customKb = path.join(tmpDir, 'custom-kb');
    const initEquals = runCli([`--dir=${customKb}`, 'init']);
    expect(initEquals.status).toBe(0);
    expect(fs.existsSync(path.join(customKb, '.registry.json'))).toBe(true);

    const listEquals = runCli(['list', `--dir=${customKb}`]);
    expect(listEquals.status).toBe(0);
    expect(listEquals.stdout).toContain(customKb);
  });

  it('3. add --all --trust marks standalone .md entries as trusted', () => {
    const repo = path.join(tmpDir, 'repo-trust');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'guide.md'),
      '---\ndescription: Guide\ntags: [guide]\n---\n# Guide\nBody\n',
      'utf-8'
    );
    spawnSync('git', ['init', '-b', 'main'], { cwd: repo });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const kb = path.join(tmpDir, 'kb-trust');
    const addRes = runCli(['add', repo, '--all', '--trust', '--dir', kb]);
    expect(addRes.status).toBe(0);

    const reg = JSON.parse(fs.readFileSync(path.join(kb, '.registry.json'), 'utf-8')) as Registry;
    const entry = reg.sources.find((s) => s.name === 'guide.md');
    expect(entry).toBeDefined();
    expect(entry?.trusted).toBe(true);

    const listRes = runCli(['list', '--dir', kb]);
    expect(listRes.stdout).toContain('guide.md');
    expect(listRes.stdout).toContain('[trusted]');
  });

  it('4. remove <name> resolves and deletes standalone <name>.md without .md extension', () => {
    const kb = path.join(tmpDir, 'kb-remove');
    const mdFile = path.join(tmpDir, 'spring-guide.md');
    fs.writeFileSync(
      mdFile,
      '---\ndescription: Spring guide\ntags: [spring]\n---\n# Spring Guide\nContent\n',
      'utf-8'
    );

    const installRes = runCli(['install', mdFile, '--dir', kb]);
    expect(installRes.status).toBe(0);
    expect(fs.existsSync(path.join(kb, 'spring-guide.md'))).toBe(true);

    // info without .md works
    const infoRes = runCli(['info', 'spring-guide', '--dir', kb]);
    expect(infoRes.status).toBe(0);
    expect(infoRes.stdout).toContain('spring-guide.md');

    // remove without .md works
    const removeRes = runCli(['remove', 'spring-guide', '--dir', kb]);
    expect(removeRes.status).toBe(0);
    expect(removeRes.stdout).toContain("✓ Removed 'spring-guide.md'");
    expect(fs.existsSync(path.join(kb, 'spring-guide.md'))).toBe(false);

    const reg = JSON.parse(fs.readFileSync(path.join(kb, '.registry.json'), 'utf-8')) as Registry;
    expect(reg.sources.find((s) => s.name === 'spring-guide.md')).toBeUndefined();
  });

  it('5. workflow dry_run recognizes files created in earlier steps when evaluating when.exists', async () => {
    const kb = path.join(tmpDir, 'kb-wf');
    const unit = path.join(kb, 'demo-wf');
    fs.mkdirSync(path.join(unit, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(unit, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(unit, 'manifest.json'),
      JSON.stringify({
        name: 'demo-wf',
        version: '1.0.0',
        type: 'template',
        description: 'Testing dry run when.exists',
        workflows: { test: { description: 'test' } },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unit, 'templates', 'sample.txt'), 'Hello {{TARGET}}\n', 'utf-8');
    fs.writeFileSync(
      path.join(unit, 'workflows', 'test.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true } },
        steps: [
          { action: 'copy', source: 'templates/sample.txt', target: '{{TARGET}}/out.txt' },
          {
            action: 'message',
            when: { exists: '{{TARGET}}/out.txt' },
            text: 'STEP_TWO_EXECUTED',
          },
        ],
      }),
      'utf-8'
    );

    const targetProject = path.join(tmpDir, 'project');
    fs.mkdirSync(targetProject, { recursive: true });

    // dry_run: true must recognize that out.txt was created in step 1
    const dryRunRes = await toolRunWorkflow(
      kb,
      'demo-wf',
      'test',
      { TARGET: targetProject },
      { dryRun: true }
    );
    expect(dryRunRes.isError).toBeFalsy();
    const dryParsed = JSON.parse(dryRunRes.text);
    expect(dryParsed.messages).toContain('STEP_TWO_EXECUTED');
    expect(dryParsed.steps_executed).toBe(2);

    // real run also executes step 2
    const realRunRes = await toolRunWorkflow(
      kb,
      'demo-wf',
      'test',
      { TARGET: targetProject },
      { dryRun: false }
    );
    expect(realRunRes.isError).toBeFalsy();
    const realParsed = JSON.parse(realRunRes.text);
    expect(realParsed.messages).toContain('STEP_TWO_EXECUTED');
    expect(realParsed.steps_executed).toBe(2);
  });

  it('6. export --format tar appends .tar.gz when output path has no extension', () => {
    const kb = path.join(tmpDir, 'kb-export');
    const unit = path.join(kb, 'my-unit');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(
      path.join(unit, 'manifest.json'),
      JSON.stringify({
        name: 'my-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Test export',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unit, 'overview.md'), '# Overview\n', 'utf-8');

    const outTar = path.join(tmpDir, 'exported-archive');
    const exportRes = runCli(['export', 'my-unit', '--format', 'tar', '--output', outTar, '--dir', kb]);
    expect(exportRes.status).toBe(0);

    expect(fs.existsSync(`${outTar}.tar.gz`)).toBe(true);

    // Verify it imports cleanly from the generated .tar.gz archive
    const kb2 = path.join(tmpDir, 'kb-import');
    const importRes = runCli(['import', `${outTar}.tar.gz`, '--dir', kb2]);
    expect(importRes.status).toBe(0);
    expect(fs.existsSync(path.join(kb2, 'my-unit', 'manifest.json'))).toBe(true);
  });
});
