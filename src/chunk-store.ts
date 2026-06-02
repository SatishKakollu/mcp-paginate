import { MemoryBackend } from "./backends/memory.js";
import type { CursorPayload, StoreBackend } from "./types.js";

export class ChunkStore {
  private readonly backend: StoreBackend;
  private readonly ttlMs: number;

  constructor(ttlMs: number, backend?: StoreBackend) {
    this.ttlMs = ttlMs;
    this.backend = backend ?? new MemoryBackend();
  }

  async save(chunks: string[]): Promise<string> {
    const id = crypto.randomUUID();
    await this.backend.set(id, chunks, this.ttlMs);
    return id;
  }

  async get(cursor: string): Promise<{ chunk: string; nextCursor: string | null } | null> {
    const payload = decodeCursor(cursor);
    if (!payload) return null;

    const chunks = await this.backend.get(payload.id);
    if (!chunks) return null;

    const chunk = chunks[payload.index];
    if (chunk === undefined) return null;

    const isLast = payload.index >= chunks.length - 1;
    const nextCursor = isLast
      ? null
      : encodeCursor({ id: payload.id, index: payload.index + 1 });

    // Free the entry as soon as all pages are served — don't wait for TTL.
    if (isLast) await this.backend.delete?.(payload.id);

    return { chunk, nextCursor };
  }
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      "index" in parsed &&
      typeof (parsed as Record<string, unknown>).id === "string" &&
      typeof (parsed as Record<string, unknown>).index === "number"
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}
