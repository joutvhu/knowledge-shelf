/**
 * Regression tests for v1.1.1 bug fixes:
 * 1. add --path <file.md> for standalone markdown docs in git repositories
 * 2. import on flat archives (manifest.json at archive root) with/without --name
 * 3. install <folder> --name <alias> when manifest.name matches alias
 * 4. sync --file with non-existent config path fails with exit code 1
 * 5. isReservedPath allows unit-internal dotfiles (.eslintrc.json, .gitignore)
 * 6. resolveUnitFiles and copy_dir include dotfiles inside units
 * 7. toolGetDoc rejects non-markdown files like manifest.json
 * 8. toolRunWorkflow applies default values from manifest.placeholders in copied files
 * 9. search_docs tag filter matches multi-word module tags and reference tags
 * 10. resolveManifestFolderAcrossLayers avoids shadowing by non-manifest folders
 * 11. Subcommands support --help and -h
 * 12. cmdUpdate with local: or archive: skips modified files unless --force
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isReservedPath,
  resolveUnitFiles,
  toolGetDoc,
  toolGetResource,
  toolRunWorkflow,
  toolSearchDocs,
} from '../src/core.js';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

describe('v1.1.1 Bug Fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fixes-v111-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. isReservedPath allows dotfiles inside units while blocking internal shelf paths', () => {
    const kdir = path.join(tmpDir, 'k1');
    fs.mkdirSync(kdir, { recursive: true });

    // Internal shelf paths should be blocked
    expect(isReservedPath(kdir, path.join(kdir, '.registry.json'))).toBe(true);
    expect(isReservedPath(kdir, path.join(kdir, '.cache'))).toBe(true);
    expect(isReservedPath(kdir, path.join(kdir, '.cache', 'secret.txt'))).toBe(true);
    expect(isReservedPath(kdir, path.join(kdir, 'my-unit', '.git', 'config'))).toBe(true);

    // Unit-internal template dotfiles should be allowed
    expect(isReservedPath(kdir, path.join(kdir, 'my-unit', 'templates', '.eslintrc.json'))).toBe(false);
    expect(isReservedPath(kdir, path.join(kdir, 'my-unit', '.gitignore'))).toBe(false);
  });

  it('2. resolveUnitFiles and toolGetResource support dotfiles inside a unit', () => {
    const kdir = path.join(tmpDir, 'k1');
    const unitDir = path.join(kdir, 'my-unit');
    const templatesDir = path.join(unitDir, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.eslintrc.json'), '{"semi": false}', 'utf-8');
    fs.writeFileSync(path.join(templatesDir, 'app.ts'), 'export const x = 1;', 'utf-8');

    const resolved = resolveUnitFiles(unitDir, ['templates/**/*']);
    expect(resolved.files).toContain('templates/.eslintrc.json');
    expect(resolved.files).toContain('templates/app.ts');

    const res = toolGetResource(kdir, 'my-unit/templates/.eslintrc.json');
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('"semi": false');
  });

  it('3. toolGetDoc rejects non-markdown files and returns error', () => {
    const kdir = path.join(tmpDir, 'k1');
    const unitDir = path.join(kdir, 'my-unit');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'manifest.json'), '{"name":"my-unit"}', 'utf-8');
    fs.writeFileSync(path.join(unitDir, 'data.json'), '{"key":"value"}', 'utf-8');

    const res = toolGetDoc(kdir, 'my-unit/data.json');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('not found');
  });

  it('4. toolRunWorkflow populates placeholder defaults declared in manifest.placeholders', async () => {
    const kdir = path.join(tmpDir, 'k1');
    const unitDir = path.join(kdir, 'my-unit');
    fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(unitDir, 'templates'), { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'my-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Test unit',
        workflows: { setup: { description: 'Setup' } },
        placeholders: {
          TARGET: { type: 'path', required: true },
          APP_NAME: { type: 'string', default: 'my-default-app' },
        },
      }),
      'utf-8'
    );

    fs.writeFileSync(path.join(unitDir, 'templates', 'greeting.txt'), 'Hello {{APP_NAME}}!', 'utf-8');

    fs.writeFileSync(
      path.join(unitDir, 'workflows', 'setup.json'),
      JSON.stringify({
        name: 'setup',
        steps: [
          { action: 'copy_dir', source: 'templates', target: '{{TARGET}}/output' },
        ],
      }),
      'utf-8'
    );

    const targetDir = path.join(tmpDir, 'target');
    const res = await toolRunWorkflow(kdir, 'my-unit', 'setup', { TARGET: targetDir });
    expect(res.isError).toBeFalsy();

    const createdContent = fs.readFileSync(path.join(targetDir, 'output', 'greeting.txt'), 'utf-8');
    expect(createdContent).toBe('Hello my-default-app!');
  });

  it('5. search_docs tag filter matches multi-word module tags and reference tags', () => {
    const kdir = path.join(tmpDir, 'k1');
    const unitDir = path.join(kdir, 'multi-tag-unit');
    fs.mkdirSync(unitDir, { recursive: true });

    fs.writeFileSync(
      path.join(unitDir, 'manifest.json'),
      JSON.stringify({
        name: 'multi-tag-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Unit with multi-word tags',
        tags: ['base-tag'],
        modules: {
          core: {
            description: 'Core module',
            tags: ['spring boot', 'cloud security'],
          },
        },
        references: {
          guide: {
            file: 'guide.md',
            description: 'Ref guide',
            tags: ['oauth2 ref'],
          },
        },
      }),
      'utf-8'
    );

    // Search with multi-word tag
    const res1 = toolSearchDocs(kdir, 'multi', 10, { tags: ['spring boot'] });
    const parsed1 = JSON.parse(res1.text);
    expect(parsed1.total).toBe(1);
    expect(parsed1.results[0].name).toBe('multi-tag-unit');

    // Search with reference tag
    const res2 = toolSearchDocs(kdir, 'multi', 10, { tags: ['oauth2 ref'] });
    const parsed2 = JSON.parse(res2.text);
    expect(parsed2.total).toBe(1);
    expect(parsed2.results[0].name).toBe('multi-tag-unit');
  });

  it('6. CLI sync --file fails with exit code 1 when config file does not exist', () => {
    const kdir = path.join(tmpDir, 'k1');
    expect(runCli(['init', '--dir', kdir]).status).toBe(0);

    const res = runCli(['sync', '--file', path.join(tmpDir, 'nonexistent.json'), '--dir', kdir]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Config file not found');
  });

  it('7. CLI install with --name succeeds when manifest.name matches --name but differs from folder name', () => {
    const kdir = path.join(tmpDir, 'k1');
    expect(runCli(['init', '--dir', kdir]).status).toBe(0);

    const sourceDir = path.join(tmpDir, 'my-folder-v2');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'manifest.json'),
      JSON.stringify({
        name: 'my-alias',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Sample unit',
      }),
      'utf-8'
    );

    const res = runCli(['install', sourceDir, '--name', 'my-alias', '--dir', kdir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("✓ Installed 'my-alias'");
  });

  it('8. CLI subcommands accept --help and -h without unknown option errors', () => {
    for (const sub of ['add', 'install', 'sync', 'validate', 'remove', 'pin', 'info']) {
      const res = runCli([sub, '--help']);
      expect(res.status, sub).toBe(0);
      expect(res.stdout).toContain('Knowledge Shelf');
    }
  });

  it('9. CLI update with local: source skips modified directory unless --force is given', () => {
    const kdir = path.join(tmpDir, 'k1');
    expect(runCli(['init', '--dir', kdir]).status).toBe(0);

    const srcDir = path.join(tmpDir, 'source-unit');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'manifest.json'),
      JSON.stringify({
        name: 'source-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Original description',
      }),
      'utf-8'
    );

    expect(runCli(['install', srcDir, '--dir', kdir]).status).toBe(0);

    // Modify installed unit locally
    const installedFile = path.join(kdir, 'source-unit', 'manifest.json');
    fs.writeFileSync(installedFile, fs.readFileSync(installedFile, 'utf-8') + '\n// edit', 'utf-8');

    // Update without --force: should skip
    const updateRes1 = runCli(['update', 'source-unit', '--dir', kdir]);
    expect(updateRes1.stdout).toContain('local modifications detected');

    // Update with --force: should update
    const updateRes2 = runCli(['update', 'source-unit', '--force', '--dir', kdir]);
    expect(updateRes2.stdout).toContain('✓ Updated from local path');
  });

  it('10. CLI add --path <file.md> installs a standalone markdown file from git repo', () => {
    const kdir = path.join(tmpDir, 'k1');
    expect(runCli(['init', '--dir', kdir]).status).toBe(0);

    const repoDir = path.join(tmpDir, 'git-repo');
    const guidesDir = path.join(repoDir, 'guides');
    fs.mkdirSync(guidesDir, { recursive: true });
    fs.writeFileSync(
      path.join(guidesDir, 'deploy.md'),
      '---\ntitle: Deploy Guide\ndescription: Deployment instructions\ntags: [deploy]\n---\n# Deploy\nContent here.\n',
      'utf-8'
    );

    spawnSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'pipe' });

    const addRes = runCli(['add', repoDir, '--path', 'guides/deploy.md', '--dir', kdir]);
    expect(addRes.status).toBe(0);
    expect(addRes.stdout).toContain("✓ Installed 'deploy.md'");
    expect(fs.existsSync(path.join(kdir, 'deploy.md'))).toBe(true);
  });

  it('11. CLI import succeeds on flat archive with manifest.json at root', () => {
    const kdir = path.join(tmpDir, 'k1');
    expect(runCli(['init', '--dir', kdir]).status).toBe(0);

    const flatDir = path.join(tmpDir, 'flat-source');
    fs.mkdirSync(flatDir, { recursive: true });
    fs.writeFileSync(
      path.join(flatDir, 'manifest.json'),
      JSON.stringify({
        name: 'flat-unit',
        version: '1.0.0',
        type: 'boilerplate',
        description: 'Flat archive unit',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(flatDir, 'overview.md'), '# Flat Unit\n', 'utf-8');

    const zipPath = path.join(tmpDir, 'flat-unit.zip');
    // Create zip
    if (process.platform === 'win32') {
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path '${flatDir}\\*' -DestinationPath '${zipPath}' -Force`,
        ],
        { stdio: 'pipe' }
      );
    } else {
      spawnSync('zip', ['-r', zipPath, '.'], { cwd: flatDir, stdio: 'pipe' });
    }

    const importRes = runCli(['import', zipPath, '--dir', kdir]);
    expect(importRes.status).toBe(0);
    expect(importRes.stdout).toContain("✓ Installed 'flat-unit'");
    expect(fs.existsSync(path.join(kdir, 'flat-unit', 'manifest.json'))).toBe(true);
  });
});
