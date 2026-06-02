/**
 * Redis-backed storage for mcp-pager.
 *
 * Requires `ioredis` as a peer dependency:
 *   npm install ioredis
 *
 * Usage:
 *   import Redis from "ioredis";
 *   import { paginate } from "mcp-pager";
 *   import { RedisBackend } from "mcp-pager/redis";
 *
 *   const redis = new Redis(process.env.REDIS_URL);
 *   paginate(server, { store: new RedisBackend(redis) });
 */
import type { StoreBackend } from "../types.js";

/** Minimal subset of the ioredis Redis interface we actually use. */
interface RedisClient {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class RedisBackend implements StoreBackend {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisClient,
    /** Key prefix to namespace paginate entries. Default: "mcp-pager:" */
    prefix = "mcp-pager:"
  ) {
    this.prefix = prefix;
  }

  async get(id: string): Promise<string[] | null> {
    const raw = await this.redis.get(this.prefix + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return null;
    }
  }

  async set(id: string, chunks: string[], ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.setex(this.prefix + id, ttlSeconds, JSON.stringify(chunks));
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(this.prefix + id);
  }

  async refresh(id: string, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.expire(this.prefix + id, ttlSeconds);
  }
}
