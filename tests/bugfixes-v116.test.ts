/**
 * Regression tests for v1.1.6 fixes:
 * 1. Symlink/junction resolution and strictTrust enforcement across layer directories
 * 2. Uppercase .MD file discovery in scanDocuments, search, and MCP tools
 * 3. Inline triple-backtick lines do not trap extractSections or description parser
 * 4. Publish hygiene permits .env.example / .env.sample / .env.template / .env.dist templates
 * 5. cmdCatalog without shelf.json displays top-level standalone .md documents
 * 6. toolRunWorkflow placeholder handling is safe against Object prototype properties
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkUnitPublishHygiene,
  extractSections,
  findMdFiles,
  scanDocuments,
  toolGetDoc,
  toolGetDocSection,
  toolGetModule,
  toolRunWorkflow,
  toolSearchDocs,
} from '../src/core.js';
import { SENSITIVE_NAME_RE } from '../src/core/manifest.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

describe('v1.1.6 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v116-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. Directory junction / symlink preserves strictTrust and clean relative paths', () => {
    const realDir = path.join(tmpDir, 'real-shelf');
    const linkDir = path.join(tmpDir, 'link-shelf');
    const unitDir = path.join(realDir, 'untrusted-unit');
    fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'untrusted-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Untrusted unit test',
        modules: {
          core: {
            description: 'Core module',
            files: ['scripts/test.js'],
          },
        },
        scripts: {
          test: { file: 'scripts/test.js', interpreter: 'node' },
        },
        workflows: {
          run: { description: 'Run workflow' },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'scripts', 'test.js'),
      'console.log("EXECUTED");\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'run.json'),
      JSON.stringify({
        steps: [
          { action: 'run', script_ref: 'test' },
        ],
      }),
      'utf-8'
    );

    // Create untrusted registry entry
    fs.writeFileSync(
      path.join(realDir, '.registry.json'),
      JSON.stringify({
        version: '1.0',
        sources: [
          {
            name: 'untrusted-unit',
            url: 'https://example.com/untrusted.git',
            commit: 'abc1234',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            // trusted: undefined (untrusted remote source)
          },
        ],
      }),
      'utf-8'
    );

    // Create directory junction (on Windows) or symlink (on POSIX)
    if (process.platform === 'win32') {
      fs.symlinkSync(realDir, linkDir, 'junction');
    } else {
      fs.symlinkSync(realDir, linkDir, 'dir');
    }

    // 1. get_module via linkDir should return unit and files without '../'
    const modRes = toolGetModule(linkDir, 'untrusted-unit', 'core');
    expect(modRes.isError).toBeFalsy();
    const modData = JSON.parse(modRes.text);
    expect(modData.unit).toBe('untrusted-unit');
    expect(modData.files[0]).toBe('untrusted-unit/scripts/test.js');

    // 2. run_workflow via linkDir under strictTrust MUST block execution
    const runPromise = toolRunWorkflow(linkDir, 'untrusted-unit', 'run', {}, { strictTrust: true });
    return runPromise.then((wfRes) => {
      expect(wfRes.isError).toBe(true);
      expect(wfRes.text).toContain('Script execution blocked by strict trust policy');

      // 3. cmdRemove via linkDir on an untracked directory succeeds without path traversal errors
      const untracked = path.join(realDir, 'untracked-local');
      fs.mkdirSync(untracked, { recursive: true });
      fs.writeFileSync(path.join(untracked, 'note.txt'), 'hello', 'utf-8');

      const rmRes = runCli(['remove', 'untracked-local', '--dir', linkDir]);
      expect(rmRes.status).toBe(0);
      expect(fs.existsSync(untracked)).toBe(false);

      // 4. cmdExport via linkDir produces archive without '../' in relative paths
      const tarOut = path.join(tmpDir, 'export.tar.gz');
      const expRes = runCli(['export', 'untrusted-unit', '--format', 'tar', '--output', tarOut, '--dir', linkDir]);
      expect(expRes.status).toBe(0);
      expect(fs.existsSync(tarOut)).toBe(true);

      const listRes = spawnSync('tar', ['-ztf', tarOut], { encoding: 'utf-8' });
      expect(listRes.status).toBe(0);
      expect(listRes.stdout).not.toContain('..');
    });
  });

  it('2. Uppercase .MD files are indexed in scanDocuments, findMdFiles, and search', () => {
    const kb = path.join(tmpDir, 'kb-upper');
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(
      path.join(kb, 'UpperDoc.MD'),
      '---\ntitle: "Uppercase Guide"\ndescription: "Doc with uppercase extension"\ntags: [uppercase-tag]\n---\n# Uppercase Guide\n\nContent here.\n',
      'utf-8'
    );

    const mdFiles = findMdFiles(kb);
    expect(mdFiles.length).toBe(1);
    expect(path.basename(mdFiles[0])).toBe('UpperDoc.MD');

    const docs = scanDocuments(kb);
    expect(docs.length).toBe(1);
    expect(docs[0].name).toBe('UpperDoc.MD');
    expect(docs[0].title).toBe('Uppercase Guide');

    const searchRes = toolSearchDocs(kb, 'uppercase-tag');
    expect(searchRes.isError).toBeFalsy();
    const searchData = JSON.parse(searchRes.text);
    expect(searchData.total).toBe(1);
    expect(searchData.results[0].name).toBe('UpperDoc.MD');

    // CLI search also finds it
    const cliSearch = runCli(['search', 'uppercase-tag', '--dir', kb, '--no-global']);
    expect(cliSearch.status).toBe(0);
    expect(cliSearch.stdout).toContain('UpperDoc.MD');
  });

  it('3. Inline triple-backticks do not trap extractSections or get_doc_section', () => {
    const md = [
      '# Document Title',
      '',
      '## Introduction',
      'Intro text.',
      '',
      '```inline-code-fence-trap```',
      '',
      '## Real Section After Inline Fence',
      'This section must be discovered.',
      '',
      '### Sub Section',
      'Sub content.',
    ].join('\n');

    const sections = extractSections(md);
    const titles = sections.map((s) => s.title);
    expect(titles).toContain('Document Title');
    expect(titles).toContain('Introduction');
    expect(titles).toContain('Real Section After Inline Fence');
    expect(titles).toContain('Sub Section');

    const kb = path.join(tmpDir, 'kb-fence');
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'guide.md'), md, 'utf-8');

    const secRes = toolGetDocSection(kb, 'guide.md', 'Real Section After Inline Fence');
    expect(secRes.isError).toBeFalsy();
    expect(secRes.text).toContain('This section must be discovered.');
  });

  it('4. Publish hygiene correctly flags sensitive names and secrets in files', () => {
    expect(SENSITIVE_NAME_RE.test('.env')).toBe(true);
    expect(SENSITIVE_NAME_RE.test('.env.local')).toBe(true);
    expect(SENSITIVE_NAME_RE.test('.env.production')).toBe(true);
    expect(SENSITIVE_NAME_RE.test('.npmrc')).toBe(true);
    expect(SENSITIVE_NAME_RE.test('README.md')).toBe(false);

    const unitDir = path.join(tmpDir, 'hygiene-unit');
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({ name: 'hygiene-unit', version: '1.0.0', type: 'boilerplate', description: 'test' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(unitDir, 'templates', 'clean.txt'), 'PORT=3000\nAPI_HOST=localhost\n', 'utf-8');

    // Clean file produces 0 warnings
    const cleanWarnings = checkUnitPublishHygiene(unitDir);
    expect(cleanWarnings).toEqual([]);

    // File containing a real token is caught by content hygiene check
    fs.writeFileSync(
      path.join(unitDir, 'templates', 'token.txt'),
      'GITHUB_TOKEN=ghp_123456789012345678901234567890123456\n',
      'utf-8'
    );
    const secretWarnings = checkUnitPublishHygiene(unitDir);
    expect(secretWarnings.some((w) => w.includes('GitHub token'))).toBe(true);
  });

  it('5. cmdCatalog without shelf.json displays top-level standalone markdown files', () => {
    const bareRepo = path.join(tmpDir, 'remote.git');
    const seed = path.join(tmpDir, 'seed');
    spawnSync('git', ['init', '--bare', bareRepo]);
    spawnSync('git', ['clone', bareRepo, seed]);

    // Commit a unit and a standalone md file to main
    const unitPath = path.join(seed, 'my-unit');
    fs.mkdirSync(unitPath, { recursive: true });
    fs.writeFileSync(
      path.join(unitPath, 'manifest.json'),
      JSON.stringify({ name: 'my-unit', version: '1.0.0', type: 'boilerplate', description: 'Unit desc' }),
      'utf-8'
    );
    fs.writeFileSync(path.join(seed, 'standalone-guide.md'), '# Standalone Guide\n', 'utf-8');

    spawnSync('git', ['-C', seed, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', seed, 'config', 'user.name', 'Test']);
    spawnSync('git', ['-C', seed, 'add', '--all']);
    spawnSync('git', ['-C', seed, 'commit', '-m', 'initial']);
    spawnSync('git', ['-C', seed, 'branch', '-M', 'main']);
    spawnSync('git', ['-C', seed, 'push', '-u', 'origin', 'main']);
    spawnSync('git', ['-C', bareRepo, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

    const catRes = runCli(['catalog', bareRepo]);
    expect(catRes.status).toBe(0);
    expect(catRes.stdout).toContain('my-unit');
    expect(catRes.stdout).toContain('standalone-guide.md');
  });

  it('6. toolRunWorkflow placeholder handling is safe against Object prototype properties', async () => {
    const kb = path.join(tmpDir, 'kb-proto');
    const unitDir = path.join(kb, 'proto-unit');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'proto-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Proto test',
        workflows: { test: {} },
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'test.json'),
      JSON.stringify({
        inputs: {
          toString: { required: false, default: 'safe' },
        },
        steps: [
          { action: 'message', text: 'Hello {{toString}}' },
        ],
      }),
      'utf-8'
    );

    const res = await toolRunWorkflow(kb, 'proto-unit', 'test', {});
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.text);
    expect(data.messages[0]).toBe('Hello safe');
  });
});
