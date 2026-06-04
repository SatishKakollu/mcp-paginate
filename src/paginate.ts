import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ChunkStore } from "./chunk-store.js";
import { defaultTokenCounter, estimateContentTokens } from "./tokenize.js";
import type { PaginateEvent, PaginateOptions } from "./types.js";

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
  const onPaginate = options.onPaginate;

  const store = new ChunkStore(ttlMs, options.store, options.signingSecret);

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
        emit(onPaginate, { type: "cursor_expired" });
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
      const { chunk, nextCursor, pageIndex, totalPages } = result;
      emit(onPaginate, { type: "page_fetched", pageIndex, totalPages, hasMore: nextCursor !== null });
      return buildPageResponse(chunk, nextCursor, pageToolName, pageIndex, totalPages);
    }
  );

  // Override server.tool so every SUBSEQUENT registration gets a paginating handler.
  (server as unknown as Record<string, unknown>).tool = new Proxy(originalTool, {
    apply(target, thisArg, args: unknown[]) {
      const patched = patchArgs(args, store, maxTokens, tokenCounter, pageToolName, onPaginate);
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
  pageToolName: string,
  onPaginate: ((e: PaginateEvent) => void) | undefined
): unknown[] {
  if (args.length === 0) return args;

  // Tool name is always the first argument across all McpServer.tool() overloads.
  const toolName = typeof args[0] === "string" ? args[0] : "unknown";
  const lastIdx = args.length - 1;
  const originalCb = args[lastIdx];
  if (typeof originalCb !== "function") return args;

  const patched = async (...cbArgs: unknown[]) => {
    const result = await (originalCb as (...a: unknown[]) => Promise<unknown>)(...cbArgs);
    return maybePaginate(result, store, maxTokens, tokenCounter, pageToolName, toolName, onPaginate);
  };

  return [...args.slice(0, lastIdx), patched];
}

async function maybePaginate(
  result: unknown,
  store: ChunkStore,
  maxTokens: number,
  tokenCounter: (t: string) => number,
  pageToolName: string,
  toolName: string,
  onPaginate: ((e: PaginateEvent) => void) | undefined
): Promise<unknown> {
  if (!isToolResult(result)) return result;

  const totalTokens = estimateContentTokens(result.content, tokenCounter);
  if (totalTokens <= maxTokens) return result;

  const fullText = contentToText(result.content);
  const chunks = splitIntoChunks(fullText, maxTokens, tokenCounter);
  const id = await store.save(chunks);

  emit(onPaginate, { type: "chunked", toolName, totalTokens, totalChunks: chunks.length });

  const totalPages = chunks.length;
  const firstChunk = chunks[0] ?? "";
  const nextCursor = totalPages > 1 ? store.createCursor(id, 1) : null;
  return buildPageResponse(firstChunk, nextCursor, pageToolName, 0, totalPages);
}

function buildPageResponse(
  chunk: string,
  nextCursor: string | null,
  pageToolName: string,
  pageIndex: number,
  totalPages: number
) {
  const meta = nextCursor
    ? {
        hasMore: true,
        pageIndex,
        totalPages,
        remainingPages: totalPages - pageIndex - 1,
        nextCursor,
        instruction: `Call \`${pageToolName}\` with nextCursor to get the next page. Repeat until hasMore is false.`,
      }
    : {
        hasMore: false,
        pageIndex,
        totalPages,
        remainingPages: 0,
        instruction: "All pages have been retrieved.",
      };

  return {
    content: [
      { type: "text" as const, text: chunk },
      { type: "text" as const, text: `\n---\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`` },
    ],
  };
}

function splitIntoChunks(
  text: string,
  maxTokens: number,
  tokenCounter: (t: string) => number
): string[] {
  return (
    tryJsonArraySplit(text, maxTokens, tokenCounter) ??
    tryNestedArraySplit(text, maxTokens, tokenCounter) ??
    tryLineSplit(text, maxTokens, tokenCounter) ??
    charSplit(text, maxTokens, tokenCounter)
  );
}

/** Split a JSON array at record boundaries so chunks are always valid JSON. */
function tryJsonArraySplit(
  text: string,
  maxTokens: number,
  counter: (t: string) => number
): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

  let items: unknown[];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length <= 1) return null;
    items = parsed;
  } catch {
    return null;
  }

  const chunks: string[] = [];
  let batch: unknown[] = [];

  for (const item of items) {
    batch.push(item);
    if (counter(JSON.stringify(batch)) > maxTokens && batch.length > 1) {
      batch.pop();
      chunks.push(JSON.stringify(batch, null, 2));
      batch = [item];
    }
  }
  if (batch.length > 0) chunks.push(JSON.stringify(batch, null, 2));

  // Only use JSON splitting if we produced multiple chunks.
  return chunks.length > 1 ? chunks : null;
}

/**
 * Handle wrapped JSON objects like { "results": [...], "moves": [...] }.
 * Finds the largest array field, splits it, and reconstructs the wrapper.
 * Fixes edge case: deeply nested objects (e.g. Pokémon full detail) where
 * the top-level is an object, not a bare array.
 */
function tryNestedArraySplit(
  text: string,
  maxTokens: number,
  counter: (t: string) => number
): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // Find the largest array field to split on
  let bestKey: string | null = null;
  let bestLen = 0;
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val) && val.length > bestLen) {
      bestKey = key;
      bestLen = val.length;
    }
  }

  if (!bestKey || bestLen <= 1) return null;

  const items = obj[bestKey] as unknown[];
  const wrapper = { ...obj, [bestKey]: [] as unknown[] };

  // Binary-search how many items fit per chunk with the wrapper overhead
  const wrapperTokens = counter(JSON.stringify(wrapper));
  if (wrapperTokens >= maxTokens) return null; // wrapper alone exceeds budget

  const chunks: string[] = [];
  let batch: unknown[] = [];

  for (const item of items) {
    batch.push(item);
    const candidate = { ...wrapper, [bestKey]: batch };
    if (counter(JSON.stringify(candidate)) > maxTokens && batch.length > 1) {
      batch.pop();
      chunks.push(JSON.stringify({ ...wrapper, [bestKey]: batch }, null, 2));
      batch = [item];
    }
  }
  if (batch.length > 0) {
    chunks.push(JSON.stringify({ ...wrapper, [bestKey]: batch }, null, 2));
  }

  return chunks.length > 1 ? chunks : null;
}

/** Split at newline boundaries — good for logs, CSV, plain text. */
function tryLineSplit(
  text: string,
  maxTokens: number,
  counter: (t: string) => number
): string[] | null {
  if (!text.includes("\n")) return null;

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    current.push(line);
    if (counter(current.join("\n")) > maxTokens && current.length > 1) {
      current.pop();
      chunks.push(current.join("\n"));
      current = [line];
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks.length > 1 ? chunks : null;
}

/** Last-resort: binary-search character split. */
function charSplit(
  text: string,
  maxTokens: number,
  counter: (t: string) => number
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let lo = 1;
    let hi = text.length - start;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (counter(text.slice(start, start + mid)) <= maxTokens) lo = mid;
      else hi = mid - 1;
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

function emit(
  onPaginate: ((e: PaginateEvent) => void) | undefined,
  event: PaginateEvent
): void {
  try {
    onPaginate?.(event);
  } catch {
    // never let a logging callback crash the pagination pipeline
  }
}
