export interface PaginateOptions {
  /** Maximum tokens per page. Default: 4000 */
  maxTokens?: number;
  /** Cursor TTL in milliseconds. Default: 300_000 (5 min) */
  ttlMs?: number;
  /** Custom token counter. Default: chars/4 heuristic */
  tokenCounter?: (text: string) => number;
  /** Name of the injected pagination tool. Default: "get_next_page" */
  pageToolName?: string;
  /** Custom storage backend. Default: in-memory. Use RedisBackend for production. */
  store?: StoreBackend;
}

export interface CursorPayload {
  id: string;
  index: number;
}

/**
 * Implement this interface to provide a custom storage backend for pagination chunks.
 * The backend is responsible for TTL enforcement (use Redis SETEX, DynamoDB TTL, etc.).
 */
export interface StoreBackend {
  /** Return chunks for the given id, or null if not found / expired. */
  get(id: string): Promise<string[] | null>;
  /** Persist chunks with a TTL hint in milliseconds. */
  set(id: string, chunks: string[], ttlMs: number): Promise<void>;
  /**
   * Remove an entry immediately.
   * Called automatically when the last page of a session is served so memory
   * is freed without waiting for TTL expiry. Optional — backends that rely on
   * native TTL (Redis, DynamoDB) may leave this unimplemented.
   */
  delete?(id: string): Promise<void>;
}

/** @deprecated Internal shape used by MemoryBackend. Will be removed in v1.0. */
export interface StoredPage {
  chunks: string[];
  expiresAt: number;
}
