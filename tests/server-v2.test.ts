/**
 * Tests for multi-layer knowledge directories, Manifest v1.1, Workflow v1.1,
 * enhanced search/resource/module tools, MCP resources, and security modes.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKnowledgeServer } from '../src/server.js';
import {
  clearIndexCache,
  parseFrontmatter,
  resolveKnowledgeDirs,
  scanSingleLayer,
  validateManifestUnitDir,
} from '../src/core.js';

async function connectServer(
  knowledgeDirs: string | string[],
  options: { readOnly?: boolean; strictTrust?: boolean } = {}
) {
  const server = createKnowledgeServer(knowledgeDirs, options);
  const client = new Client({ name: 'test-v2-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function getText(res: Awaited<ReturnType<Client['callTool']>>): string {
  const first = (res.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? '';
}

describe('Parser & Manifest v1.1 Validation', () => {
  it('should parse multi-line block scalars, inline comments, and quoted commas in frontmatter', () => {
    const md = [
      '---',
      'title: "Quoted Title" # trailing comment',
      'tags: [alpha, "beta, gamma", delta] # inline comment',
      'description: >',
      '  First line of summary',
      '  second line of summary',
      'notes: |',
      '  Line A',
      '  Line B',
      '---',
      '',
      '# Body',
    ].join('\n');

    const { metadata, body } = parseFrontmatter(md);
    expect(metadata.title).toBe('Quoted Title');
    expect(metadata.tags).toEqual(['alpha', 'beta, gamma', 'delta']);
    expect(metadata.description).toBe('First line of summary second line of summary');
    expect(metadata.notes).toBe('Line A\nLine B');
    expect(body).toBe('# Body');
  });

  it('should catch missing script/reference files, invalid interpreters, globs escaping root, and missing workflow files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-val-v2-'));
    try {
      const unitDir = path.join(tmp, 'bad-v2');
      fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(unitDir, 'manifest.json'),
        JSON.stringify({
          name: 'bad-v2',
          version: '1.0.0',
          type: 'boilerplate',
          description: 'Invalid unit',
          requires: ['missing-dep'],
          modules: {
            escaped: { files: ['../secret/*.txt'] },
          },
          scripts: {
            noFile: { description: 'Missing file field' },
            badInterp: { file: 'scripts/a.py', interpreter: 'ruby' },
          },
          references: {
            noFile: { description: 'Missing file field' },
          },
          workflows: {
            missingWf: { description: 'Missing workflow file' },
          },
        }),
        'utf-8'
      );

      const { errors, warnings } = validateManifestUnitDir(unitDir, {
        expectedUnitName: 'bad-v2',
        installedUnits: new Set(['bad-v2']),
      });

      expect(errors.some((e) => e.includes('modules.escaped.files: path escapes'))).toBe(true);
      expect(errors.some((e) => e.includes('scripts.noFile: missing required "file"'))).toBe(true);
      expect(errors.some((e) => e.includes("scripts.badInterp.interpreter: 'ruby' is not allowed"))).toBe(true);
      expect(errors.some((e) => e.includes('references.noFile: missing required "file"'))).toBe(true);
      expect(errors.some((e) => e.includes('workflows.missingWf: file not found'))).toBe(true);
      expect(warnings.some((w) => w.includes('Required knowledge unit "missing-dep"'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('should resolve multi-dir order from KNOWLEDGE_DIRS', () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-env1-'));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-env2-'));
    const prev = process.env.KNOWLEDGE_DIRS;
    try {
      process.env.KNOWLEDGE_DIRS = `${d1}${path.delimiter}${d2}`;
      const resolved = resolveKnowledgeDirs(undefined, { includeGlobal: false });
      expect(resolved).toEqual([path.resolve(d1), path.resolve(d2)]);
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_DIRS;
      else process.env.KNOWLEDGE_DIRS = prev;
      fs.rmSync(d1, { recursive: true, force: true });
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe('Multi-Layer, Search v2, Module Resolution, Resources & Workflow v1.1', () => {
  it('should support multi-layer shadowing, mtime cache invalidation, reference indexing, filtering, get_module, and resource slicing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-layer-'));
    const projectDir = path.join(root, 'project');
    const globalDir = path.join(root, 'global');

    try {
      // Project layer unit (shadows "shared-unit" in global)
      const projUnit = path.join(projectDir, 'shared-unit');
      fs.mkdirSync(path.join(projUnit, 'src', 'sub'), { recursive: true });
      fs.mkdirSync(path.join(projUnit, 'references'), { recursive: true });
      fs.writeFileSync(
        path.join(projUnit, 'overview.md'),
        '# Shared Unit (Project)\n\n## Setup\n\nProject override.',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(projUnit, 'references', 'deep-guide.md'),
        '# Deep Guide\n\n## Connection Pooling\n\nAlways tune pool size.\n\n## Retries\n\nExponential backoff.',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(projUnit, 'src', 'Base.java'),
        Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n'),
        'utf-8'
      );
      fs.writeFileSync(path.join(projUnit, 'src', 'sub', 'Helper.java'), '// helper', 'utf-8');
      fs.writeFileSync(path.join(projUnit, 'src', 'sub', 'Ignore.bak'), '// bak', 'utf-8');
      fs.writeFileSync(
        path.join(projUnit, 'manifest.json'),
        JSON.stringify({
          $schema: 'knowledge-manifest/1.1',
          name: 'shared-unit',
          version: '2.0.0',
          type: 'boilerplate',
          doc: 'overview.md',
          description: 'Project override unit',
          tags: ['java', 'database'],
          applies_to: { languages: ['java'], frameworks: { spring: '>=3.0.0' } },
          modules: {
            base: {
              description: 'Base classes',
              files: ['src/Base.java'],
            },
            pool: {
              description: 'Pooling helpers',
              guide: 'references/deep-guide.md',
              files: ['src/**/*.java'],
              exclude: ['**/*.bak'],
              dependencies: ['base'],
            },
          },
          references: {
            'deep-guide': {
              file: 'references/deep-guide.md',
              description: 'Pooling and retry configuration',
              tags: ['hikaricp'],
            },
          },
        }),
        'utf-8'
      );

      // Global layer: older "shared-unit" (should be shadowed) + unique "legacy-unit" (deprecated)
      const globalShadowed = path.join(globalDir, 'shared-unit');
      fs.mkdirSync(globalShadowed, { recursive: true });
      fs.writeFileSync(path.join(globalShadowed, 'overview.md'), '# Global Old', 'utf-8');
      fs.writeFileSync(path.join(globalShadowed, 'only-in-global.md'), 'Shadowed secret', 'utf-8');
      fs.writeFileSync(
        path.join(globalShadowed, 'manifest.json'),
        JSON.stringify({
          name: 'shared-unit',
          version: '1.0.0',
          type: 'cookbook',
          doc: 'overview.md',
          description: 'Global shadowed',
        }),
        'utf-8'
      );

      const globalDeprecated = path.join(globalDir, 'legacy-unit');
      fs.mkdirSync(globalDeprecated, { recursive: true });
      fs.writeFileSync(path.join(globalDeprecated, 'overview.md'), '# Legacy Java\n\nOld guide.', 'utf-8');
      fs.writeFileSync(
        path.join(globalDeprecated, 'manifest.json'),
        JSON.stringify({
          name: 'legacy-unit',
          version: '0.9.0',
          type: 'cookbook',
          doc: 'overview.md',
          status: 'deprecated',
          superseded_by: 'shared-unit',
          description: 'Legacy java database guide',
          tags: ['java', 'database'],
        }),
        'utf-8'
      );

      // Verify mtime cache hits and invalidates on write
      clearIndexCache();
      const firstScan = scanSingleLayer(projectDir);
      const secondScan = scanSingleLayer(projectDir);
      expect(firstScan).toBe(secondScan); // exact cached array reference

      const { client, close } = await connectServer([projectDir, globalDir]);
      try {
        // 1. list_docs merges layers and shadows duplicate
        const listRes = await client.callTool({ name: 'list_docs', arguments: {} });
        const listJson = JSON.parse(getText(listRes));
        expect(listJson.total).toBe(2);
        const shared = listJson.documents.find((d: { name: string }) => d.name === 'shared-unit');
        expect(shared.version).toBe('2.0.0');
        expect(shared.source_layer).toBe(projectDir);

        // 2. get_doc reads project override; shadowed unit does not leak global-only resources; deprecated unit shows banner
        const docRes = await client.callTool({ name: 'get_doc', arguments: { name: 'shared-unit' } });
        expect(getText(docRes)).toContain('Project override.');
        const shadowedRes = await client.callTool({
          name: 'get_resource',
          arguments: { name: 'shared-unit/only-in-global.md' },
        });
        expect(shadowedRes.isError).toBe(true);
        const depDocRes = await client.callTool({ name: 'get_doc', arguments: { name: 'legacy-unit' } });
        expect(getText(depDocRes)).toContain('WARNING (deprecated)');
        expect(getText(depDocRes)).toContain('shared-unit');

        // 3. search_docs indexes reference headings & down-ranks deprecated units
        const searchRef = await client.callTool({
          name: 'search_docs',
          arguments: { query: 'Connection Pooling', include_content: true },
        });
        const srJson = JSON.parse(getText(searchRef));
        expect(srJson.results[0].name).toBe('shared-unit');
        expect(srJson.results[0].matched_references?.[0].key).toBe('deep-guide');
        expect(srJson.results[0].content_snippets?.length).toBeGreaterThan(0);

        // Filter by type
        const onlyCookbook = await client.callTool({
          name: 'search_docs',
          arguments: { query: 'java', type: 'cookbook' },
        });
        const cbJson = JSON.parse(getText(onlyCookbook));
        expect(cbJson.results.map((r: { name: string }) => r.name)).toEqual(['legacy-unit']);

        // 4. get_module resolves transitive dependencies & expands globs (excluding *.bak)
        const modRes = await client.callTool({
          name: 'get_module',
          arguments: { name: 'shared-unit', module: 'pool' },
        });
        const modJson = JSON.parse(getText(modRes));
        expect(modJson.ordered_modules).toEqual(['base', 'pool']);
        expect(modJson.files).toEqual(['shared-unit/src/Base.java', 'shared-unit/src/sub/Helper.java']);
        expect(modJson.guides).toEqual([{ module: 'pool', file: 'shared-unit/references/deep-guide.md' }]);

        // 5. get_resource supports offset/limit and section extraction
        const sliceRes = await client.callTool({
          name: 'get_resource',
          arguments: { name: 'shared-unit/src/Base.java', offset: 5, limit: 3 },
        });
        expect(getText(sliceRes)).toContain('[lines 5-7 of 30]');
        expect(getText(sliceRes)).toContain('// line 5');
        expect(getText(sliceRes)).not.toContain('// line 8');

        const secRes = await client.callTool({
          name: 'get_resource',
          arguments: { name: 'shared-unit/references/deep-guide.md', section: 'Retries' },
        });
        expect(getText(secRes)).toContain('Exponential backoff.');
        expect(getText(secRes)).not.toContain('Connection Pooling');

        // 6. MCP Resources list & read
        const { resources } = await client.listResources();
        expect(resources.some((r) => r.uri === 'knowledge://shared-unit')).toBe(true);
        const readRes = await client.readResource({ uri: 'knowledge://shared-unit/references/deep-guide.md' });
        expect((readRes.contents[0] as { text?: string }).text).toContain('Connection Pooling');
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('should execute workflow v1.1 features: dry_run, copy_dir, patch, when, script_ref, cwd, and readOnly/strictTrust', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-wf-v2-'));
    const knowDir = path.join(root, 'know');
    const targetDir = path.join(root, 'target');
    fs.mkdirSync(targetDir, { recursive: true });

    try {
      const unitDir = path.join(knowDir, 'scaffold-v2');
      fs.mkdirSync(path.join(unitDir, 'templates', 'nested'), { recursive: true });
      fs.mkdirSync(path.join(unitDir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(unitDir, 'workflows'), { recursive: true });

      fs.writeFileSync(path.join(unitDir, 'templates', '{{NAME}}Service.ts'), 'export const svc = "{{NAME}}";', 'utf-8');
      fs.writeFileSync(path.join(unitDir, 'templates', 'nested', 'config.json'), '{"app":"{{NAME}}"}', 'utf-8');
      fs.writeFileSync(path.join(unitDir, 'templates', 'skip.bak'), 'skip me', 'utf-8');
      fs.writeFileSync(
        path.join(unitDir, 'scripts', 'check.js'),
        'console.log("CWD=" + process.cwd());',
        'utf-8'
      );

      fs.writeFileSync(
        path.join(unitDir, 'manifest.json'),
        JSON.stringify({
          name: 'scaffold-v2',
          version: '1.0.0',
          type: 'template',
          description: 'Workflow v1.1 test unit',
          scripts: {
            check: { file: 'scripts/check.js', interpreter: 'node' },
          },
          workflows: {
            apply: { description: 'Apply scaffold with copy_dir, patch, when, and script_ref' },
          },
        }),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(unitDir, 'workflows', 'apply.json'),
        JSON.stringify({
          name: 'apply',
          inputs: {
            TARGET: { required: true },
            NAME: { required: true },
            WITH_DOCKER: { required: false, default: 'false' },
          },
          steps: [
            {
              action: 'copy_dir',
              source: 'templates',
              target: '{{TARGET}}/src',
              exclude: ['**/*.bak'],
              render_filenames: true,
            },
            {
              action: 'patch',
              target: '{{TARGET}}/index.ts',
              mode: 'insert_before',
              anchor: '// [ANCHOR]',
              content: "import { svc } from './src/{{NAME}}Service';",
              skip_if_contains: './src/{{NAME}}Service',
            },
            {
              action: 'message',
              when: { input: 'WITH_DOCKER', equals: 'true' },
              text: 'DOCKER_ENABLED',
            },
            {
              action: 'run',
              script_ref: 'check',
              cwd: '{{TARGET}}',
            },
          ],
        }),
        'utf-8'
      );

      fs.writeFileSync(path.join(targetDir, 'index.ts'), '// header\n// [ANCHOR]\nconsole.log("ok");\n', 'utf-8');

      // Validate passes cleanly on v1.1 workflow
      const val = validateManifestUnitDir(unitDir, 'scaffold-v2');
      expect(val.errors).toEqual([]);

      // 1. Read-only mode blocks real run but allows dry_run
      const roConn = await connectServer(knowDir, { readOnly: true });
      try {
        const blocked = await roConn.client.callTool({
          name: 'run_workflow',
          arguments: {
            name: 'scaffold-v2',
            workflow: 'apply',
            inputs: { TARGET: targetDir, NAME: 'Order' },
          },
        });
        expect(blocked.isError).toBe(true);
        expect(getText(blocked)).toContain('read-only mode');

        const dryRes = await roConn.client.callTool({
          name: 'run_workflow',
          arguments: {
            name: 'scaffold-v2',
            workflow: 'apply',
            inputs: { TARGET: targetDir, NAME: 'Order' },
            dry_run: true,
          },
        });
        expect(dryRes.isError).toBeFalsy();
        const dryJson = JSON.parse(getText(dryRes));
        expect(dryJson.dry_run).toBe(true);
        expect(dryJson.files_created.some((f: string) => f.endsWith('OrderService.ts'))).toBe(true);
        expect(dryJson.files_patched).toEqual([path.join(targetDir, 'index.ts')]);
        expect(fs.existsSync(path.join(targetDir, 'src', 'OrderService.ts'))).toBe(false);
      } finally {
        await roConn.close();
      }

      // 2. Strict-trust blocks remote untrusted unit script execution
      fs.writeFileSync(
        path.join(knowDir, '.registry.json'),
        JSON.stringify({
          version: '1.0',
          sources: [
            {
              name: 'scaffold-v2',
              url: 'https://example.com/repo.git',
              commit: 'abc1234',
              installedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
        'utf-8'
      );

      const trustConn = await connectServer(knowDir, { strictTrust: true });
      try {
        const untrustedRes = await trustConn.client.callTool({
          name: 'run_workflow',
          arguments: {
            name: 'scaffold-v2',
            workflow: 'apply',
            inputs: { TARGET: targetDir, NAME: 'Order' },
          },
        });
        expect(untrustedRes.isError).toBe(true);
        expect(getText(untrustedRes)).toContain('strict trust policy');
      } finally {
        await trustConn.close();
      }

      // 3. Full normal execution: copy_dir, patch, when, script_ref + cwd
      const conn = await connectServer(knowDir);
      try {
        const execRes = await conn.client.callTool({
          name: 'run_workflow',
          arguments: {
            name: 'scaffold-v2',
            workflow: 'apply',
            inputs: { TARGET: targetDir, NAME: 'Order', WITH_DOCKER: 'false' },
          },
        });
        expect(execRes.isError).toBeFalsy();
        const execJson = JSON.parse(getText(execRes));
        expect(execJson.messages).toEqual([]); // when: WITH_DOCKER=false skipped message
        expect(fs.existsSync(path.join(targetDir, 'src', 'OrderService.ts'))).toBe(true);
        expect(fs.existsSync(path.join(targetDir, 'src', 'skip.bak'))).toBe(false);
        expect(fs.readFileSync(path.join(targetDir, 'index.ts'), 'utf-8')).toContain(
          "import { svc } from './src/OrderService';"
        );
        expect(execJson.scripts_run[0].stdout).toContain(`CWD=${fs.realpathSync(targetDir)}`);

        // Re-running patch is idempotent via skip_if_contains
        const reRun = await conn.client.callTool({
          name: 'run_workflow',
          arguments: {
            name: 'scaffold-v2',
            workflow: 'apply',
            inputs: { TARGET: targetDir, NAME: 'Order' },
          },
        });
        const reJson = JSON.parse(getText(reRun));
        expect(reJson.files_skipped).toContain(path.join(targetDir, 'index.ts'));
      } finally {
        await conn.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
