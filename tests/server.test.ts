/**
 * Integration & regression tests for the real Knowledge Shelf MCP Server.
 *
 * Connects an official MCP SDK Client directly to createKnowledgeServer() via
 * InMemoryTransport, plus an end-to-end stdio smoke test against dist/index.js.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createKnowledgeServer } from '../src/server.js';
import { parseFrontmatter, extractSections } from '../src/core.js';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'sample-knowledge');
const SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

async function createConnectedClient(knowledgeDir: string) {
  const server = createKnowledgeServer(knowledgeDir);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
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

describe('Test Fixtures', () => {
  it('should have sample-knowledge directory and required files', () => {
    expect(fs.existsSync(FIXTURES_DIR)).toBe(true);
    expect(fs.existsSync(path.join(FIXTURES_DIR, 'my-unit', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(FIXTURES_DIR, 'my-unit', 'src', 'Base.java'))).toBe(true);
    expect(fs.existsSync(path.join(FIXTURES_DIR, 'my-unit', 'scripts', 'validate.js'))).toBe(true);
    expect(fs.existsSync(path.join(FIXTURES_DIR, 'standalone.md'))).toBe(true);
  });
});

describe('Markdown Parsing Regressions', () => {
  it('should preserve horizontal rules (---) inside document body when parsing frontmatter', () => {
    const md = [
      '---',
      'title: "Multi Rule Doc"',
      'tags: [alpha, "beta"]',
      'aliases:',
      '  - mr',
      '  - multi-rule',
      '---',
      '',
      '# Heading One',
      '',
      'First part before horizontal rule.',
      '',
      '---',
      '',
      '## Heading Two',
      '',
      'Second part after first horizontal rule.',
      '',
      '---',
      '',
      '### Heading Three',
      '',
      'Final part.',
    ].join('\n');

    const { metadata, body } = parseFrontmatter(md);
    expect(metadata.title).toBe('Multi Rule Doc');
    expect(metadata.tags).toEqual(['alpha', 'beta']);
    expect(metadata.aliases).toEqual(['mr', 'multi-rule']);
    expect(body).toContain('First part before horizontal rule.');
    expect(body).toContain('## Heading Two');
    expect(body).toContain('Second part after first horizontal rule.');
    expect(body).toContain('### Heading Three');
    expect(body).toContain('Final part.');
  });

  it('should ignore # comments inside fenced code blocks when extracting sections', () => {
    const body = [
      '# Main Title',
      '',
      '## Setup',
      '',
      '```bash',
      '# Install dependencies (not a markdown heading!)',
      'npm install',
      '```',
      '',
      'After code block.',
      '',
      '## Next Steps',
      '',
      'Done.',
    ].join('\n');

    const sections = extractSections(body);
    expect(sections.map((s) => s.title)).toEqual(['Main Title', 'Setup', 'Next Steps']);
  });
});

describe('MCP Server Tools (Real McpServer + Client)', () => {
  let client: Client;
  let closeConn: () => Promise<void>;

  beforeAll(async () => {
    const conn = await createConnectedClient(FIXTURES_DIR);
    client = conn.client;
    closeConn = conn.close;
  });

  afterAll(async () => {
    await closeConn();
  });

  it('should expose all 7 registered tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'list_docs',
      'search_docs',
      'get_doc',
      'get_doc_section',
      'get_resource',
      'get_manifest',
      'run_workflow',
    ]);
  });

  describe('list_docs', () => {
    it('should list both manifest-based and standalone documents', async () => {
      const res = await client.callTool({ name: 'list_docs', arguments: {} });
      expect(res.isError).toBeFalsy();
      const result = JSON.parse(getText(res));
      expect(result.total).toBe(2);
      const names = result.documents.map((d: { name: string }) => d.name);
      expect(names).toContain('my-unit');
      expect(names).toContain('standalone.md');
    });

    it('should include manifest metadata for manifest-based units', async () => {
      const res = await client.callTool({ name: 'list_docs', arguments: {} });
      const result = JSON.parse(getText(res));
      const unit = result.documents.find((d: { name: string }) => d.name === 'my-unit');
      expect(unit.has_manifest).toBe(true);
      expect(unit.type).toBe('boilerplate');
      expect(unit.modules).toContain('base');
      expect(unit.workflows).toContain('setup');
    });

    it('should include frontmatter metadata for standalone docs', async () => {
      const res = await client.callTool({ name: 'list_docs', arguments: {} });
      const result = JSON.parse(getText(res));
      const doc = result.documents.find((d: { name: string }) => d.name === 'standalone.md');
      expect(doc.has_manifest).toBe(false);
      expect(doc.tags).toContain('cucumber');
      expect(doc.aliases).toContain('standalone-test');
    });
  });

  describe('search_docs', () => {
    it('should find documents by tag', async () => {
      const res = await client.callTool({ name: 'search_docs', arguments: { query: 'cucumber' } });
      const result = JSON.parse(getText(res));
      expect(result.total).toBeGreaterThan(0);
      expect(result.results[0].name).toBe('standalone.md');
    });

    it('should find documents by alias (highest score)', async () => {
      const res = await client.callTool({ name: 'search_docs', arguments: { query: 'st' } });
      const result = JSON.parse(getText(res));
      expect(result.total).toBeGreaterThan(0);
      const standalone = result.results.find((r: { name: string }) => r.name === 'standalone.md');
      expect(standalone).toBeDefined();
      expect(standalone.relevance_score).toBeGreaterThanOrEqual(12);
    });

    it('should find manifest-based units by type', async () => {
      const res = await client.callTool({ name: 'search_docs', arguments: { query: 'boilerplate' } });
      const result = JSON.parse(getText(res));
      expect(result.total).toBeGreaterThan(0);
      const unit = result.results.find((r: { name: string }) => r.name === 'my-unit');
      expect(unit).toBeDefined();
    });

    it('should return empty for non-matching query', async () => {
      const res = await client.callTool({ name: 'search_docs', arguments: { query: 'zzzznonexistent' } });
      const result = JSON.parse(getText(res));
      expect(result.total).toBe(0);
    });
  });

  describe('get_doc', () => {
    it('should return manifest doc file content for manifest-based unit', async () => {
      const res = await client.callTool({ name: 'get_doc', arguments: { name: 'my-unit' } });
      expect(res.isError).toBeFalsy();
      const text = getText(res);
      expect(text).toContain('directory:');
      expect(text).toContain('My Unit Overview');
      expect(text).toContain('Getting Started');
    });

    it('should return body without frontmatter for standalone doc', async () => {
      const res = await client.callTool({ name: 'get_doc', arguments: { name: 'standalone.md' } });
      expect(res.isError).toBeFalsy();
      const text = getText(res);
      expect(text).toContain('Standalone Test Document');
      expect(text).not.toContain('tags: cucumber');
    });

    it('should return isError=true for non-existent document', async () => {
      const res = await client.callTool({ name: 'get_doc', arguments: { name: 'nonexistent.md' } });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('not found');
    });

    it('should block path traversal outside knowledge directory', async () => {
      const res = await client.callTool({ name: 'get_doc', arguments: { name: '../../package.json' } });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('Access denied');
    });
  });

  describe('get_doc_section', () => {
    it('should return specific section content', async () => {
      const res = await client.callTool({
        name: 'get_doc_section',
        arguments: { name: 'standalone.md', section: 'Section One' },
      });
      expect(res.isError).toBeFalsy();
      const text = getText(res);
      expect(text).toContain('Section One');
      expect(text).toContain('Content of section one');
      expect(text).not.toContain('Section Two');
    });

    it('should return isError=true for non-existent section', async () => {
      const res = await client.callTool({
        name: 'get_doc_section',
        arguments: { name: 'standalone.md', section: 'Nonexistent' },
      });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('not found');
      expect(result.available_sections).toBeDefined();
    });
  });

  describe('get_resource', () => {
    it('should return file content', async () => {
      const res = await client.callTool({
        name: 'get_resource',
        arguments: { name: 'my-unit/references/guide.md' },
      });
      expect(res.isError).toBeFalsy();
      const text = getText(res);
      expect(text).toContain('Setup Guide');
      expect(text).toContain('Prerequisites');
    });

    it('should return isError=true for non-existent resource', async () => {
      const res = await client.callTool({
        name: 'get_resource',
        arguments: { name: 'my-unit/nonexistent.txt' },
      });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('not found');
    });

    it('should block path traversal', async () => {
      const res = await client.callTool({
        name: 'get_resource',
        arguments: { name: '../../package.json' },
      });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('Access denied');
    });
  });

  describe('get_manifest', () => {
    it('should return manifest content', async () => {
      const res = await client.callTool({ name: 'get_manifest', arguments: { name: 'my-unit' } });
      expect(res.isError).toBeFalsy();
      const result = JSON.parse(getText(res));
      expect(result.name).toBe('my-unit');
      expect(result.type).toBe('boilerplate');
      expect(result.modules.base).toBeDefined();
      expect(result._directory).toBeDefined();
    });

    it('should return isError=true for non-manifest folder', async () => {
      const res = await client.callTool({ name: 'get_manifest', arguments: { name: 'nonexistent' } });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('not found');
    });
  });

  describe('run_workflow', () => {
    it('should execute workflow steps with explicit inputs', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-wf-test-'));
      try {
        const res = await client.callTool({
          name: 'run_workflow',
          arguments: {
            name: 'my-unit',
            workflow: 'setup',
            inputs: { TARGET: tmpDir, NAME: 'test-app' },
          },
        });
        expect(res.isError).toBeFalsy();
        const result = JSON.parse(getText(res));
        expect(result.workflow).toBe('setup');
        expect(result.steps_executed).toBe(3);
        expect(result.messages).toContain(`Setting up test-app in ${tmpDir}...`);
        expect(result.messages).toContain('Done!');
        expect(result.errors.length).toBe(0);
        expect(fs.existsSync(path.join(tmpDir, 'src'))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should apply default workflow input values when optional input is omitted', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-wf-default-'));
      try {
        const res = await client.callTool({
          name: 'run_workflow',
          arguments: {
            name: 'my-unit',
            workflow: 'setup',
            inputs: { TARGET: tmpDir },
          },
        });
        expect(res.isError).toBeFalsy();
        const result = JSON.parse(getText(res));
        // setup.json defines default "my-app" for NAME
        expect(result.messages).toContain(`Setting up my-app in ${tmpDir}...`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return isError=true for missing required inputs', async () => {
      const res = await client.callTool({
        name: 'run_workflow',
        arguments: { name: 'my-unit', workflow: 'setup', inputs: {} },
      });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('Missing required inputs');
    });

    it('should return isError=true for non-existent workflow', async () => {
      const res = await client.callTool({
        name: 'run_workflow',
        arguments: { name: 'my-unit', workflow: 'nonexistent', inputs: {} },
      });
      expect(res.isError).toBe(true);
      const result = JSON.parse(getText(res));
      expect(result.error).toContain('not found');
    });
  });
});

describe('Security, Binary Detection & Script Execution Edge Cases', () => {
  it('should block manifest.doc path traversal, detect binary resources, handle code fences in sections, and run scripts', async () => {
    const tmpKnowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-sec-test-'));
    const secretFile = path.join(os.tmpdir(), `ks-secret-${Date.now()}.txt`);
    fs.writeFileSync(secretFile, 'TOP_SECRET_DATA', 'utf-8');

    try {
      // 1. Unit with malicious manifest.doc escaping unit folder
      const evilUnit = path.join(tmpKnowDir, 'evil-unit');
      fs.mkdirSync(path.join(evilUnit, 'workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(evilUnit, 'manifest.json'),
        JSON.stringify({
          name: 'evil-unit',
          version: '1.0.0',
          type: 'toolkit',
          description: 'Evil unit',
          doc: path.relative(evilUnit, secretFile),
        }),
        'utf-8'
      );

      // Workflow trying to copy outside unit folder + run a real JS script
      fs.mkdirSync(path.join(evilUnit, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(evilUnit, 'scripts', 'hello.js'),
        'console.log("HELLO_FROM_SCRIPT:" + process.argv[2]);',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(evilUnit, 'workflows', 'escape-copy.json'),
        JSON.stringify({
          name: 'escape-copy',
          description: 'Tries to copy outside unit',
          steps: [{ action: 'copy', source: path.relative(evilUnit, secretFile), target: path.join(tmpKnowDir, 'leaked.txt') }],
        }),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(evilUnit, 'workflows', 'run-js.json'),
        JSON.stringify({
          name: 'run-js',
          description: 'Runs node script',
          inputs: { WHO: { required: false, default: 'world' } },
          steps: [{ action: 'run', script: 'scripts/hello.js', args: ['{{WHO}}'] }],
        }),
        'utf-8'
      );

      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(evilUnit, 'scripts', 'hello.cmd'), '@echo off\r\necho CMD_OK:%1\r\n', 'utf-8');
        fs.writeFileSync(
          path.join(evilUnit, 'workflows', 'run-cmd.json'),
          JSON.stringify({
            name: 'run-cmd',
            description: 'Runs Windows cmd script',
            steps: [{ action: 'run', script: 'scripts/hello.cmd', args: ['win'] }],
          }),
          'utf-8'
        );
      }

      // 2. Binary file
      fs.writeFileSync(path.join(tmpKnowDir, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));

      // 3. Doc with # API and ## API Authentication + bash code fence with # comments + --- hr
      fs.writeFileSync(
        path.join(tmpKnowDir, 'api-guide.md'),
        [
          '---',
          'title: API',
          '---',
          '',
          '# API',
          '',
          'Overview.',
          '',
          '---',
          '',
          '## API Authentication',
          '',
          '```bash',
          '# Set token before calling API',
          'curl -H "Authorization: Bearer token" https://example.com',
          '```',
          '',
          'Token details after code block.',
          '',
          '## Errors',
          '',
          'Error codes.',
        ].join('\n'),
        'utf-8'
      );

      const { client, close } = await createConnectedClient(tmpKnowDir);
      try {
        // Malicious manifest.doc must be denied
        const docRes = await client.callTool({ name: 'get_doc', arguments: { name: 'evil-unit' } });
        expect(docRes.isError).toBe(true);
        expect(getText(docRes)).toContain('Access denied');

        // Malicious copy source must be blocked
        const escapeRes = await client.callTool({
          name: 'run_workflow',
          arguments: { name: 'evil-unit', workflow: 'escape-copy' },
        });
        expect(escapeRes.isError).toBe(true);
        expect(getText(escapeRes)).toContain('outside the knowledge unit folder');
        expect(fs.existsSync(path.join(tmpKnowDir, 'leaked.txt'))).toBe(false);

        // Workflow script execution + default input works
        const runRes = await client.callTool({
          name: 'run_workflow',
          arguments: { name: 'evil-unit', workflow: 'run-js' },
        });
        expect(runRes.isError).toBeFalsy();
        const runJson = JSON.parse(getText(runRes));
        expect(runJson.scripts_run[0].exit_code).toBe(0);
        expect(runJson.scripts_run[0].stdout).toContain('HELLO_FROM_SCRIPT:world');

        if (process.platform === 'win32') {
          const cmdRes = await client.callTool({
            name: 'run_workflow',
            arguments: { name: 'evil-unit', workflow: 'run-cmd' },
          });
          expect(cmdRes.isError).toBeFalsy();
          const cmdJson = JSON.parse(getText(cmdRes));
          expect(cmdJson.scripts_run[0].exit_code).toBe(0);
          expect(cmdJson.scripts_run[0].stdout).toContain('CMD_OK:win');
        }

        // Binary resource detected
        const binRes = await client.callTool({ name: 'get_resource', arguments: { name: 'image.bin' } });
        expect(binRes.isError).toBe(true);
        expect(getText(binRes)).toContain('binary');

        // Section matching finds ## API Authentication (not # API) and doesn't truncate at # comment in bash fence
        const secRes = await client.callTool({
          name: 'get_doc_section',
          arguments: { name: 'api-guide.md', section: 'API Authentication' },
        });
        expect(secRes.isError).toBeFalsy();
        const secText = getText(secRes);
        expect(secText).toContain('## API Authentication');
        expect(secText).toContain('curl -H "Authorization: Bearer token"');
        expect(secText).toContain('Token details after code block.');
        expect(secText).not.toContain('## Errors');
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmpKnowDir, { recursive: true, force: true });
      if (fs.existsSync(secretFile)) fs.unlinkSync(secretFile);
    }
  });

  it('should work end-to-end over StdioClientTransport with compiled dist/index.js', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH, '--dir', FIXTURES_DIR],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-e2e-client', version: '1.0.0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: 'list_docs', arguments: {} });
      const data = JSON.parse(getText(res));
      expect(data.total).toBe(2);
    } finally {
      await client.close();
    }
  });
});
