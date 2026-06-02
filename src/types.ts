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
  /**
   * Secret key for HMAC-signing cursors (sha256).
   * When set, cursors are signed and verified on every read.
   * Recommended for multi-tenant or shared-infrastructure deployments.
   */
  signingSecret?: string;
  /**
   * Optional callback fired on every pagination lifecycle event.
   * Use for structured logging, metrics, or debugging.
   *
   * @example
   * paginate(server, {
   *   onPaginate: (e) => logger.info(e),
   * });
   */
  onPaginate?: (event: PaginateEvent) => void;
}

// ─── Pagination lifecycle events ─────────────────────────────────────────────

/** Fired when a tool response is split into pages. */
export interface ChunkedEvent {
  type: "chunked";
  /** Name of the tool whose response was paginated. */
  toolName: string;
  /** Estimated token count of the full response. */
  totalTokens: number;
  /** Number of chunks the response was split into. */
  totalChunks: number;
}

/** Fired each time get_next_page is called successfully. */
export interface PageFetchedEvent {
  type: "page_fetched";
  /** Zero-based index of the page returned. */
  pageIndex: number;
  /** Total number of pages in this session. */
  totalPages: number;
  /** True if there are more pages after this one. */
  hasMore: boolean;
}

/** Fired when get_next_page is called with an expired or invalid cursor. */
export interface CursorExpiredEvent {
  type: "cursor_expired";
}

export type PaginateEvent = ChunkedEvent | PageFetchedEvent | CursorExpiredEvent;

// ─── Storage ─────────────────────────────────────────────────────────────────

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
  /**
   * Reset the TTL for an existing entry (sliding window).
   * Called automatically after each successful page fetch so long-running
   * LLM sessions don't expire mid-pagination.
   * Optional — if not implemented, TTL is fixed from the initial store.
   */
  refresh?(id: string, ttlMs: number): Promise<void>;
}

/** @deprecated Internal shape used by MemoryBackend. Will be removed in v1.0. */
export interface StoredPage {
  chunks: string[];
  expiresAt: number;
}
