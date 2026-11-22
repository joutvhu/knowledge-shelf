/**
 * Knowledge Shelf MCP Server factory.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getPackageVersion,
  scanDocuments,
  toolGetDoc,
  toolGetDocSection,
  toolGetManifest,
  toolGetModule,
  toolGetResource,
  toolListDocs,
  toolRunWorkflow,
  toolSearchDocs,
  type ServerToolOptions,
  type ToolResponse,
} from './core.js';

function toMcpResult(res: ToolResponse) {
  return {
    content: [{ type: 'text' as const, text: res.text }],
    ...(res.isError ? { isError: true } : {}),
  };
}

export function createKnowledgeServer(
  knowledgeDirs: string | string[],
  options: ServerToolOptions = {}
): McpServer {
  const server = new McpServer(
    {
      name: 'knowledge-shelf',
      version: getPackageVersion(),
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: `You have access to a personal knowledge base via the knowledge-shelf tools. Use these tools proactively to find relevant documentation, code patterns, templates, and workflows before answering questions or starting implementation tasks.

## When to use these tools

- **Starting a task**: search_docs first to find relevant knowledge units, patterns, or guides.
- **Unfamiliar library or framework**: search_docs for docs, then get_doc or get_doc_section for details.
- **Scaffolding or boilerplate**: search_docs for templates/boilerplate, then inspect with get_module or run_workflow (use dry_run: true to preview).
- **Coding standards or conventions**: search_docs for team guides before writing code.
- **Unsure what's available**: list_docs to see everything in the knowledge base.

## Recommended workflow

1. **search_docs** — find relevant units by keyword (aliases, title, tags, type, modules, references, and optional filters/content search).
2. **get_manifest** — inspect a manifest-based unit to see its modules, workflows, scripts, references, compatibility, and placeholders.
3. **get_module** — resolve a specific module's files, guides, and transitive dependencies in topological order.
4. **get_doc** — read the main documentation of a unit or standalone .md file.
5. **get_doc_section** — read a specific section when you only need part of a document.
6. **get_resource** — retrieve a code file, template, config, or reference doc by path (supports offset/limit line slicing or section extraction).
7. **run_workflow** — execute a predefined workflow to scaffold files, patch host files, or run scripts. Always call get_manifest first, and consider dry_run: true to preview changes.
8. **list_docs** — enumerate all available documents and units when you need a full overview.

## Two knowledge formats

- **Manifest-based units** (folders with manifest.json): structured knowledge with modules, workflows, scripts, and references. Use get_manifest to understand structure before diving in.
- **Standalone .md files**: simple documentation. Use get_doc or get_doc_section to read them.

## Tips

- Search terms are space-separated; aliases and titles score highest.
- get_doc_section and get_resource (with offset/limit or section) save context on large files.
- run_workflow has side effects (creates/patches files, runs scripts) — use dry_run: true first if unsure.
- Paths passed to get_resource, get_doc, get_manifest, and get_module are relative to the knowledge directory root.`,
    }
  );

  server.registerTool(
    'list_docs',
    {
      description:
        'List all available knowledge base documents and units across configured layers. Returns manifest-based knowledge units (with modules, workflows, scripts, status, compatibility) and standalone .md documents.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => toMcpResult(toolListDocs(knowledgeDirs))
  );

  server.registerTool(
    'search_docs',
    {
      description:
        'Search knowledge base by keyword. Call this first before starting any task — it finds relevant documentation, code patterns, templates, and guides. Searches aliases, titles, tags, type, modules, references, compatibility, and headings. Optional filters: type, tags, unit, and include_content for full-text snippet search.',
      inputSchema: z.object({
        query: z.string().describe('Search keywords (space-separated)'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum results to return (1-100, default: 10)'),
        type: z
          .string()
          .min(1)
          .optional()
          .describe('Optional filter by knowledge type: any unit type, or "standalone"'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional tags filter (document must contain all specified tags)'),
        unit: z
          .string()
          .optional()
          .describe('Optional unit name filter to search within a single knowledge unit'),
        include_content: z
          .boolean()
          .optional()
          .describe('Also search full document & reference bodies and return matching snippets'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, max_results, type, tags, unit, include_content }) =>
      toMcpResult(
        toolSearchDocs(knowledgeDirs, query, max_results, {
          type,
          tags,
          unit,
          includeContent: include_content,
        })
      )
  );

  server.registerTool(
    'get_doc',
    {
      description:
        'Retrieve the main document content of a knowledge unit or standalone .md file. For manifest-based units: returns the file specified by the manifest "doc" field. For standalone .md files: returns the file content without frontmatter. Prefer get_doc_section when you only need a specific section of a large document.',
      inputSchema: z.object({
        name: z
          .string()
          .describe('Knowledge unit folder name or standalone .md path (relative to knowledge directory root)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }) => toMcpResult(toolGetDoc(knowledgeDirs, name))
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, section }) => toMcpResult(toolGetDocSection(knowledgeDirs, name, section))
  );

  server.registerTool(
    'get_resource',
    {
      description:
        'Retrieve any file from a knowledge unit as text — code files, templates, configs, reference docs, scripts. Supports optional line slicing (offset/limit) for large files or section extraction for Markdown references. Path is relative to the knowledge directory root (e.g. "my-unit/src/BasePage.java").',
      inputSchema: z.object({
        name: z
          .string()
          .describe('File path relative to knowledge directory root (e.g. "my-unit/references/guide.md")'),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Optional 1-based starting line number for large files'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe('Optional maximum number of lines to return (default when offset set: 200)'),
        section: z
          .string()
          .optional()
          .describe('Optional Markdown heading to extract from a .md reference resource'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, offset, limit, section }) =>
      toMcpResult(toolGetResource(knowledgeDirs, name, { offset, limit, section }))
  );

  server.registerTool(
    'get_manifest',
    {
      description:
        'Retrieve the manifest.json of a manifest-based knowledge unit. Returns structured metadata: modules (with files and dependencies), workflows, scripts, references, compatibility, and placeholders. Always call this before run_workflow to discover available workflows and their required inputs.',
      inputSchema: z.object({
        name: z.string().describe('Knowledge unit folder name (relative to knowledge directory root)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }) => toMcpResult(toolGetManifest(knowledgeDirs, name))
  );

  server.registerTool(
    'get_module',
    {
      description:
        'Resolve a specific module inside a manifest-based knowledge unit, expanding file globs and transitive module dependencies in topological order along with wiring guides and placeholders.',
      inputSchema: z.object({
        name: z.string().describe('Knowledge unit folder name'),
        module: z.string().describe('Module key from manifest.json "modules"'),
        include_dependencies: z
          .boolean()
          .optional()
          .describe('Include transitive module dependencies in topological order (default: true)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, module, include_dependencies }) =>
      toMcpResult(toolGetModule(knowledgeDirs, name, module, include_dependencies ?? true))
  );

  server.registerTool(
    'run_workflow',
    {
      description:
        'Execute a predefined workflow from a knowledge unit. Workflows automate multi-step tasks: creating directories, copying templates/directories, patching files, and running scripts. Supports dry_run: true to preview all operations safely without side effects. Always call get_manifest first to discover available workflows and required inputs.',
      inputSchema: z.object({
        name: z.string().describe('Knowledge unit folder name'),
        workflow: z.string().describe('Workflow name (from manifest workflows keys)'),
        inputs: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Input values for workflow placeholders (e.g. {"TARGET": "/path/to/project", "NAME": "my-app"})'
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe('Preview planned file creations, patches, and script commands without making changes'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, workflow, inputs, dry_run }) => {
      if (options.readOnly && !dry_run) {
        return toMcpResult({
          text: JSON.stringify(
            {
              error: 'Workflow execution is disabled in read-only mode. Pass dry_run: true to preview.',
            },
            null,
            2
          ),
          isError: true,
        });
      }
      return toMcpResult(
        await toolRunWorkflow(knowledgeDirs, name, workflow, inputs, {
          ...options,
          dryRun: dry_run,
        })
      );
    }
  );

  // Register MCP Resources (`knowledge://<path>`) for @-mention and direct client browsing
  server.registerResource(
    'knowledge-item',
    new ResourceTemplate('knowledge://{+path}', {
      list: async () => {
        const docs = scanDocuments(knowledgeDirs);
        return {
          resources: docs.map((d) => ({
            uri: `knowledge://${d.name}`,
            name: d.title || d.name,
            description: d.description || undefined,
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    {
      title: 'Knowledge Shelf Document / Resource',
      description: 'Read a knowledge unit overview or file resource by relative path.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const rawPath = Array.isArray(variables.path)
        ? variables.path.join('/')
        : String(variables.path || '');
      let relPath = '';
      try {
        relPath = decodeURIComponent(rawPath).replace(/^\/+/, '');
      } catch {
        relPath = rawPath.replace(/^\/+/, '');
      }
      const resDoc = toolGetDoc(knowledgeDirs, relPath);
      if (!resDoc.isError) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: resDoc.text,
            },
          ],
        };
      }
      const resFile = toolGetResource(knowledgeDirs, relPath);
      if (!resFile.isError) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: relPath.endsWith('.json')
                ? 'application/json'
                : relPath.endsWith('.md')
                  ? 'text/markdown'
                  : 'text/plain',
              text: resFile.text,
            },
          ],
        };
      }
      throw new Error(resFile.text);
    }
  );

  return server;
}
