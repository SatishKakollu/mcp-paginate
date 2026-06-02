import { createHmac, timingSafeEqual } from "crypto";
import { MemoryBackend } from "./backends/memory.js";
import type { CursorPayload, StoreBackend } from "./types.js";

export interface PageResult {
  chunk: string;
  nextCursor: string | null;
  pageIndex: number;
  totalPages: number;
}

export class ChunkStore {
  private readonly backend: StoreBackend;
  private readonly ttlMs: number;
  private readonly signingSecret: string | undefined;

  constructor(ttlMs: number, backend?: StoreBackend, signingSecret?: string) {
    this.ttlMs = ttlMs;
    this.backend = backend ?? new MemoryBackend();
    this.signingSecret = signingSecret;
  }

  async save(chunks: string[]): Promise<string> {
    const id = crypto.randomUUID();
    await this.backend.set(id, chunks, this.ttlMs);
    return id;
  }

  /** Build a cursor, applying HMAC signing if a secret is configured. */
  createCursor(id: string, index: number): string {
    return encodeCursor({ id, index }, this.signingSecret);
  }

  async get(cursor: string): Promise<PageResult | null> {
    const payload = decodeCursor(cursor, this.signingSecret);
    if (!payload) return null;

    const chunks = await this.backend.get(payload.id);
    if (!chunks) return null;

    const chunk = chunks[payload.index];
    if (chunk === undefined) return null;

    const isLast = payload.index >= chunks.length - 1;
    const nextCursor = isLast ? null : this.createCursor(payload.id, payload.index + 1);

    // Free the entry as soon as all pages are served — don't wait for TTL.
    if (isLast) await this.backend.delete?.(payload.id);

    return { chunk, nextCursor, pageIndex: payload.index, totalPages: chunks.length };
  }
}

// ─── Cursor encoding / decoding ──────────────────────────────────────────────

export function encodeCursor(payload: CursorPayload, secret?: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  if (!secret) return encoded;
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function decodeCursor(cursor: string, secret?: string): CursorPayload | null {
  try {
    let encoded = cursor;

    if (secret) {
      const dotIdx = cursor.lastIndexOf(".");
      if (dotIdx === -1) return null; // signing required but cursor is unsigned
      encoded = cursor.slice(0, dotIdx);
      const sig = cursor.slice(dotIdx + 1);
      if (!verifyHmac(secret, encoded, sig)) return null;
    }

    const raw = Buffer.from(encoded, "base64url").toString("utf8");
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

function verifyHmac(secret: string, encoded: string, sig: string): boolean {
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal-length buffers; length mismatch is itself a failure.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
