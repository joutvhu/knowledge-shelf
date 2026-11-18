/**
 * Knowledge Shelf MCP Server factory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getPackageVersion,
  toolGetDoc,
  toolGetDocSection,
  toolGetManifest,
  toolGetResource,
  toolListDocs,
  toolRunWorkflow,
  toolSearchDocs,
  type ToolResponse,
} from './core.js';

function toMcpResult(res: ToolResponse) {
  return {
    content: [{ type: 'text' as const, text: res.text }],
    ...(res.isError ? { isError: true } : {}),
  };
}

export function createKnowledgeServer(knowledgeDir: string): McpServer {
  const server = new McpServer(
    {
      name: 'knowledge-shelf',
      version: getPackageVersion(),
    },
    {
      capabilities: { tools: {} },
      instructions: `You have access to a personal knowledge base via the knowledge-shelf tools. Use these tools proactively to find relevant documentation, code patterns, templates, and workflows before answering questions or starting implementation tasks.

## When to use these tools

- **Starting a task**: search_docs first to find relevant knowledge units, patterns, or guides.
- **Unfamiliar library or framework**: search_docs for docs, then get_doc or get_doc_section for details.
- **Scaffolding or boilerplate**: search_docs for templates/boilerplate, then run_workflow to automate setup.
- **Coding standards or conventions**: search_docs for team guides before writing code.
- **Unsure what's available**: list_docs to see everything in the knowledge base.

## Recommended workflow

1. **search_docs** — find relevant units by keyword (title, tags, type, modules, aliases all scored).
2. **get_manifest** — inspect a manifest-based unit to see its modules, workflows, scripts, and references.
3. **get_doc** — read the main documentation of a unit or standalone .md file.
4. **get_doc_section** — read a specific section when you only need part of a document.
5. **get_resource** — retrieve a code file, template, config, or reference doc by path.
6. **run_workflow** — execute a predefined workflow to scaffold files, run scripts, or automate setup. Always call get_manifest first to discover available workflows and their required inputs.
7. **list_docs** — enumerate all available documents and units when you need a full overview.

## Two knowledge formats

- **Manifest-based units** (folders with manifest.json): structured knowledge with modules, workflows, scripts, and references. Use get_manifest to understand structure before diving in.
- **Standalone .md files**: simple documentation. Use get_doc or get_doc_section to read them.

## Tips

- Search terms are space-separated; aliases and titles score highest.
- get_doc_section is more efficient than get_doc when you only need one section of a large document.
- run_workflow has side effects (creates files, runs scripts) — confirm required inputs with get_manifest before calling it.
- Paths passed to get_resource, get_doc, and get_manifest are relative to the knowledge directory root.`,
    }
  );

  server.registerTool(
    'list_docs',
    {
      description:
        'List all available knowledge base documents and units. Returns manifest-based knowledge units (with modules, workflows, scripts) and legacy .md documents. Use when you need a full overview of what knowledge is available.',
    },
    async () => toMcpResult(toolListDocs(knowledgeDir))
  );

  server.registerTool(
    'search_docs',
    {
      description:
        'Search knowledge base by keyword. Call this first before starting any task — it finds relevant documentation, code patterns, templates, and guides. Searches titles, tags, descriptions, module names, type, and aliases. Returns ranked results. Aliases and titles score highest; terms are space-separated.',
      inputSchema: z.object({
        query: z.string().describe('Search keywords (space-separated)'),
        max_results: z.number().optional().describe('Maximum results to return (default: 10)'),
      }),
    },
    async ({ query, max_results }) => toMcpResult(toolSearchDocs(knowledgeDir, query, max_results))
  );

  server.registerTool(
    'get_doc',
    {
      description:
        'Retrieve the main document content of a knowledge unit or legacy .md file. For manifest-based units: returns the file specified by the manifest "doc" field. For legacy .md files: returns the file content without frontmatter. Prefer get_doc_section when you only need a specific section of a large document.',
      inputSchema: z.object({
        name: z
          .string()
          .describe('Knowledge unit folder name or legacy .md path (relative to knowledge directory root)'),
      }),
    },
    async ({ name }) => toMcpResult(toolGetDoc(knowledgeDir, name))
  );

  server.registerTool(
    'get_doc_section',
    {
      description:
        'Retrieve a specific section from a document by heading text. More efficient than get_doc when you only need part of a large document — saves context. Returns content under the matched heading up to the next heading of the same or higher level. Heading match is case-insensitive and partial.',
      inputSchema: z.object({
        name: z.string().describe('Document path or knowledge unit name (relative to knowledge directory root)'),
        section: z.string().describe('Section heading text (case-insensitive, partial match supported)'),
      }),
    },
    async ({ name, section }) => toMcpResult(toolGetDocSection(knowledgeDir, name, section))
  );

  server.registerTool(
    'get_resource',
    {
      description:
        'Retrieve any file from a knowledge unit as text — code files, templates, configs, reference docs, scripts. Use get_manifest first to discover available file paths within a unit. Path is relative to the knowledge directory root (e.g. "my-unit/src/BasePage.java").',
      inputSchema: z.object({
        name: z
          .string()
          .describe('File path relative to knowledge directory root (e.g. "my-unit/references/guide.md")'),
      }),
    },
    async ({ name }) => toMcpResult(toolGetResource(knowledgeDir, name))
  );

  server.registerTool(
    'get_manifest',
    {
      description:
        'Retrieve the manifest.json of a manifest-based knowledge unit. Returns structured metadata: modules (with files and dependencies), workflows, scripts, references, and placeholders. Always call this before run_workflow to discover available workflows and their required inputs.',
      inputSchema: z.object({
        name: z.string().describe('Knowledge unit folder name (relative to knowledge directory root)'),
      }),
    },
    async ({ name }) => toMcpResult(toolGetManifest(knowledgeDir, name))
  );

  server.registerTool(
    'run_workflow',
    {
      description:
        'Execute a predefined workflow from a knowledge unit. Workflows automate multi-step tasks: copying templates, running scripts, creating directories. Has side effects — creates files and runs scripts. Always call get_manifest first to discover available workflows and their required inputs before calling this tool.',
      inputSchema: z.object({
        name: z.string().describe('Knowledge unit folder name'),
        workflow: z.string().describe('Workflow name (from manifest workflows keys)'),
        inputs: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Input values for workflow placeholders (e.g. {"TARGET": "/path/to/project", "NAME": "my-app"})'
          ),
      }),
    },
    async ({ name, workflow, inputs }) => toMcpResult(toolRunWorkflow(knowledgeDir, name, workflow, inputs))
  );

  return server;
}
