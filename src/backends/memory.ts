import type { StoreBackend } from "../types.js";

interface Entry {
  chunks: string[];
  expiresAt: number;
}

export class MemoryBackend implements StoreBackend {
  private readonly store = new Map<string, Entry>();

  async get(id: string): Promise<string[] | null> {
    const entry = this.store.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(id);
      return null;
    }
    return entry.chunks;
  }

  async set(id: string, chunks: string[], ttlMs: number): Promise<void> {
    this.evict();
    this.store.set(id, { chunks, expiresAt: Date.now() + ttlMs });
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(id);
    }
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  /** Visible for testing. */
  get size(): number {
    return this.store.size;
  }
}
