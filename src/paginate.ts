import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ChunkStore, encodeCursor } from "./chunk-store.js";
import { defaultTokenCounter, estimateContentTokens } from "./tokenize.js";
import type { PaginateOptions } from "./types.js";

const DEFAULTS = {
  maxTokens: 4000,
  ttlMs: 5 * 60 * 1000,
  pageToolName: "get_next_page",
} as const;

/**
 * Wraps an McpServer with transparent cursor-based pagination.
 * Oversized tool responses are chunked and stored; the LLM retrieves
 * subsequent pages via the injected `get_next_page` tool.
 */
export function paginate(server: McpServer, options: PaginateOptions = {}): McpServer {
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;
  const ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
  const tokenCounter = options.tokenCounter ?? defaultTokenCounter;
  const pageToolName = options.pageToolName ?? DEFAULTS.pageToolName;

  const store = new ChunkStore(ttlMs, options.store);

  const originalTool = server.tool.bind(server);

  // Register get_next_page via the ORIGINAL method BEFORE proxying, so its
  // own response is never re-paginated by the wrapper.
  originalTool(
    pageToolName,
    "Retrieve the next page of a paginated tool response.",
    { cursor: z.string().describe("Cursor returned by a previous tool call.") },
    async ({ cursor }) => {
      const result = await store.get(cursor);
      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Cursor not found or expired. Please re-invoke the original tool.",
            },
          ],
          isError: true,
        };
      }
      const { chunk, nextCursor } = result;
      return buildPageResponse(chunk, nextCursor, pageToolName);
    }
  );

  // Override server.tool so every SUBSEQUENT registration gets a paginating handler.
  // args signature variants (McpServer.tool overloads):
  //   (name, cb)
  //   (name, description, cb)
  //   (name, paramsSchema, cb)
  //   (name, description, paramsSchema, cb)
  (server as unknown as Record<string, unknown>).tool = new Proxy(originalTool, {
    apply(target, thisArg, args: unknown[]) {
      const patched = patchArgs(args, store, maxTokens, tokenCounter, pageToolName);
      return Reflect.apply(target, thisArg, patched);
    },
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patchArgs(
  args: unknown[],
  store: ChunkStore,
  maxTokens: number,
  tokenCounter: (t: string) => number,
  pageToolName: string
): unknown[] {
  if (args.length === 0) return args;

  const lastIdx = args.length - 1;
  const originalCb = args[lastIdx];
  if (typeof originalCb !== "function") return args;

  const patched = async (...cbArgs: unknown[]) => {
    const result = await (originalCb as (...a: unknown[]) => Promise<unknown>)(...cbArgs);
    return maybePaginate(result, store, maxTokens, tokenCounter, pageToolName);
  };

  return [...args.slice(0, lastIdx), patched];
}

async function maybePaginate(
  result: unknown,
  store: ChunkStore,
  maxTokens: number,
  tokenCounter: (t: string) => number,
  pageToolName: string
): Promise<unknown> {
  if (!isToolResult(result)) return result;

  const tokens = estimateContentTokens(result.content, tokenCounter);
  if (tokens <= maxTokens) return result;

  const fullText = contentToText(result.content);
  const chunks = splitIntoChunks(fullText, maxTokens, tokenCounter);
  const id = await store.save(chunks);
  const firstChunk = chunks[0] ?? "";
  const nextCursor = chunks.length > 1
    ? encodeCursor({ id, index: 1 })
    : null;

  return buildPageResponse(firstChunk, nextCursor, pageToolName);
}

function buildPageResponse(
  chunk: string,
  nextCursor: string | null,
  pageToolName: string
) {
  const parts: Array<{ type: "text"; text: string }> = [
    { type: "text", text: chunk },
  ];
  if (nextCursor) {
    parts.push({
      type: "text",
      text: `\n---\n_More results available. Call \`${pageToolName}\` with cursor: \`${nextCursor}\`_`,
    });
  }
  return { content: parts };
}

function splitIntoChunks(
  text: string,
  maxTokens: number,
  tokenCounter: (t: string) => number
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let lo = 1;
    let hi = text.length - start;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (tokenCounter(text.slice(start, start + mid)) <= maxTokens) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    chunks.push(text.slice(start, start + lo));
    start += lo;
  }
  return chunks;
}

function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "object" && item !== null && "text" in item) {
          return String((item as Record<string, unknown>).text);
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

interface ToolResult {
  content: unknown;
  isError?: boolean;
}

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && "content" in value;
}
