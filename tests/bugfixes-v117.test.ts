/**
 * Regression tests for v1.1.7 fixes:
 * 1. toolGetDoc & toolGetDocSection can read .md files inside manifest units across layers
 * 2. Non-TTY unknown command exits 1 with error, does not hang on StdioServerTransport
 * 3. collectUnitFolders & cmdAdd --all on single-unit repo (root manifest.json)
 * 4. validateManifestUnitDir: checks directories in modules.files, root placeholders in when.exists, and regex pattern validity
 * 5. Case-insensitive .MD in cmdInstall --name, extractTitle, and findCaseInsensitive
 * 6. cmdList suppresses child units of tracked monorepos from unmanaged list
 * 7. Extra positional arguments are rejected on CLI subcommands
 * 8. search_docs with include_content filters short terms (<= 2 chars) on token boundaries
 * 9. toolRunWorkflow fails atomic pre-flight when strictTrust blocks untrusted run step
 * 10. cmdAdd --ref <branch> --pin locks to commit SHA instead of branch name
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractTitle,
  loadManifest,
  toolGetDoc,
  toolGetDocSection,
  toolRunWorkflow,
  toolSearchDocs,
  validateManifestUnitDir,
} from '../src/core.js';
import { collectUnitFolders } from '../src/cli/git.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function git(cwd: string, args: string[]) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout || '').trim();
}

describe('v1.1.7 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v117-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. toolGetDoc and toolGetDocSection can read .md files inside manifest units', () => {
    const layer1 = path.join(tmpDir, 'layer1');
    const layer2 = path.join(tmpDir, 'layer2');
    const unit1 = path.join(layer1, 'my-unit');
    fs.mkdirSync(path.join(unit1, 'references'), { recursive: true });
    fs.mkdirSync(layer2, { recursive: true });

    fs.writeFileSync(
      path.join(unit1, 'manifest.json'),
      JSON.stringify({
        name: 'my-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'My unit',
        doc: 'overview.md',
      })
    );
    fs.writeFileSync(path.join(unit1, 'overview.md'), '# Overview\nOverview text\n');
    fs.writeFileSync(
      path.join(unit1, 'references', 'guide.md'),
      '# Guide\nDetailed guide content.\n\n## Section A\nSection A details.\n'
    );

    // Read doc file inside unit
    const resDoc = toolGetDoc([layer1, layer2], 'my-unit/references/guide.md');
    expect(resDoc.isError).toBeFalsy();
    expect(resDoc.text).toContain('Detailed guide content');

    // Read doc section inside unit
    const resSec = toolGetDocSection([layer1, layer2], 'my-unit/references/guide.md', 'Section A');
    expect(resSec.isError).toBeFalsy();
    expect(resSec.text).toContain('Section A details');
  });

  it('2. Non-TTY unknown command exits 1 promptly without hanging on MCP server', () => {
    const res = spawnSync(process.execPath, [CLI_PATH, 'nonexistent-command-xyz'], {
      cwd: tmpDir,
      encoding: 'utf-8',
      input: '',
      timeout: 4_000,
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Unknown command: nonexistent-command-xyz');
  });

  it('3. collectUnitFolders detects single-unit repo with root manifest', () => {
    const repoDir = path.join(tmpDir, 'root-repo');
    fs.mkdirSync(path.join(repoDir, 'sub'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'manifest.json'),
      JSON.stringify({ name: 'root-repo', version: '1.0.0', type: 'boilerplate', description: 'desc' })
    );
    fs.writeFileSync(
      path.join(repoDir, 'sub', 'manifest.json'),
      JSON.stringify({ name: 'nested', version: '1.0.0', type: 'boilerplate', description: 'nested' })
    );

    const result = collectUnitFolders(repoDir);
    expect(result.units).toEqual([path.resolve(repoDir)]);
  });

  it('4. validateManifestUnitDir rejects directory in modules.files and when.exists without placeholder', () => {
    const unitDir = path.join(tmpDir, 'invalid-unit');
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'invalid-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Test unit',
        modules: {
          core: {
            description: 'Core',
            files: ['templates'], // Directory!
          },
        },
        workflows: {
          setup: { file: 'workflows/setup.json' },
        },
        placeholders: {
          BAD_PH: { pattern: '[a-z' }, // Invalid regex!
        },
      })
    );

    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        steps: [
          {
            action: 'message',
            text: 'hi',
            when: { exists: 'file-without-placeholder.txt' },
          },
        ],
      })
    );

    const val = validateManifestUnitDir(unitDir);
    expect(val.errors.some((e) => e.includes('is a directory'))).toBe(true);
    expect(val.errors.some((e) => e.includes('must start with a root placeholder'))).toBe(true);
    expect(val.errors.some((e) => e.includes('invalid regex pattern'))).toBe(true);
  });

  it('5. Case-insensitive .MD handling in cmdInstall --name and extractTitle', () => {
    const kDir = path.join(tmpDir, 'k');
    runCli(['init', '--dir', kDir]);

    const upperMd = path.join(tmpDir, 'SOURCE.MD');
    fs.writeFileSync(upperMd, '---\ndescription: test\ntags: [a]\n---\nBody here\n');

    const res = runCli(['install', upperMd, '--name', 'MYDOC.MD', '--dir', kDir]);
    expect(res.status).toBe(0);
    const installedFiles = fs.readdirSync(kDir);
    expect(installedFiles).toContain('MYDOC.MD');
    expect(installedFiles).not.toContain('MYDOC.MD.md');

    const title = extractTitle({}, 'Body', 'FILE.MD');
    expect(title).toBe('FILE');
  });

  it('6. cmdList suppresses child units of tracked monorepos from unmanaged list', () => {
    const kDir = path.join(tmpDir, 'k');
    runCli(['init', '--dir', kDir]);

    const monoDir = path.join(kDir, 'monorepo');
    fs.mkdirSync(path.join(monoDir, 'sub-a'), { recursive: true });
    fs.writeFileSync(
      path.join(monoDir, 'sub-a', 'manifest.json'),
      JSON.stringify({ name: 'sub-a', version: '1.0.0', type: 'boilerplate', description: 'sub' })
    );

    // Record monorepo itself as installed source
    const reg = {
      version: '1.0',
      sources: [
        {
          name: 'monorepo',
          url: 'https://example.com/mono.git',
          commit: 'abc1234',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(path.join(kDir, '.registry.json'), JSON.stringify(reg, null, 2));

    const res = runCli(['list', '--dir', kDir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Installed sources:');
    expect(res.stdout).toContain('monorepo');
    expect(res.stdout).not.toContain('Local / unmanaged');
  });

  it('7. Subcommands reject unexpected extra positional arguments', () => {
    const kDir = path.join(tmpDir, 'k');
    runCli(['init', '--dir', kDir]);

    const resInit = runCli(['init', 'unexpected-arg', '--dir', kDir]);
    expect(resInit.status).toBe(1);
    expect(resInit.stderr).toContain('Unexpected argument');

    const resRemove = runCli(['remove', 'a', 'b', '--dir', kDir]);
    expect(resRemove.status).toBe(1);
    expect(resRemove.stderr).toContain('Unexpected argument');

    const resInfo = runCli(['info', 'a', 'b', '--dir', kDir]);
    expect(resInfo.status).toBe(1);
    expect(resInfo.stderr).toContain('Unexpected argument');

    const resPin = runCli(['pin', 'a', 'b', 'c', '--dir', kDir]);
    expect(resPin.status).toBe(1);
    expect(resPin.stderr).toContain('Unexpected argument');

    const resUnpin = runCli(['unpin', 'a', 'b', '--dir', kDir]);
    expect(resUnpin.status).toBe(1);
    expect(resUnpin.stderr).toContain('Unexpected argument');
  });

  it('8. search_docs with include_content filters short words (<= 2 chars) by token boundary', () => {
    const kDir = path.join(tmpDir, 'k');
    const unitDir = path.join(kDir, 'search-unit');
    fs.mkdirSync(unitDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'search-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Testing search token matching',
        doc: 'doc.md',
      })
    );
    // Contains "inside" and "instructions", but NOT standalone "in"
    fs.writeFileSync(path.join(unitDir, 'doc.md'), '# Search Unit\nInstructions are inside the box.\n');

    const res = toolSearchDocs(kDir, 'in', 10, { includeContent: true });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.text);
    expect(data.total).toBe(0);
  });

  it('9. toolRunWorkflow fails atomic pre-flight under strictTrust for untrusted units with run step', async () => {
    const kDir = path.join(tmpDir, 'k');
    const unitDir = path.join(kDir, 'untrusted-script-unit');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'untrusted-script-unit',
        version: '1.0.0',
        type: 'toolkit',
        description: 'Untrusted unit',
        workflows: {
          setup: { file: 'workflows/setup.json' },
        },
      })
    );
    fs.writeFileSync(path.join(unitDir, 'scripts', 'test.js'), 'console.log("ok");');
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        inputs: { TARGET: { required: true, type: 'path' } },
        steps: [
          { action: 'mkdir', path: '{{TARGET}}/created-dir' },
          { action: 'run', script: 'scripts/test.js' },
        ],
      })
    );

    // Register unit as untrusted remote
    const reg = {
      version: '1.0',
      sources: [
        {
          name: 'untrusted-script-unit',
          url: 'https://example.com/untrusted.git',
          commit: 'abc1234',
          trusted: false,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(path.join(kDir, '.registry.json'), JSON.stringify(reg, null, 2));

    const outDir = path.join(tmpDir, 'target-out');
    const res = await toolRunWorkflow(
      kDir,
      'untrusted-script-unit',
      'setup',
      { TARGET: outDir },
      { strictTrust: true, dryRun: false }
    );
    expect(res.isError).toBe(true);
    // Ensure mkdir was NOT executed prior to the block
    expect(fs.existsSync(path.join(outDir, 'created-dir'))).toBe(false);
  });

  it('10. cmdAdd --ref <branch> --pin locks to commit SHA', () => {
    const repo = path.join(tmpDir, 'branch-repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'manifest.json'),
      JSON.stringify({ name: 'branch-unit', version: '1.0.0', type: 'boilerplate', description: 'test' })
    );
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@test.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
    const sha = git(repo, ['rev-parse', '--short', 'HEAD']);

    const kDir = path.join(tmpDir, 'k');
    const res = runCli(['add', repo, '--ref', 'main', '--pin', '--dir', kDir]);
    expect(res.status).toBe(0);

    const reg = JSON.parse(fs.readFileSync(path.join(kDir, '.registry.json'), 'utf-8'));
    const entry = reg.sources.find((s: any) => s.name === 'branch-unit');
    expect(entry).toBeDefined();
    expect(entry.branch).toBe('main');
    expect(entry.pin).toBe(sha);
    expect(entry.pin).not.toBe('main');
  });
});
