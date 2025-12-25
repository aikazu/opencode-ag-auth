/**
 * Signature cache for persisting thinking block signatures to disk.
 * 
 * Features (based on LLM-API-Key-Proxy's ProviderCache):
 * - Dual-TTL system: short memory TTL, longer disk TTL
 * - Background disk persistence with batched writes
 * - Atomic writes with temp file + move pattern
 * - Automatic cleanup of expired entries
 * 
 * Cache key format: `${sessionId}:${modelId}`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import type { SignatureCacheConfig } from "../config";

// =============================================================================
// Types
// =============================================================================

interface CacheEntry {
  value: string;
  timestamp: number;
}

interface CacheData {
  version: "1.0";
  memory_ttl_seconds: number;
  disk_ttl_seconds: number;
  entries: Record<string, CacheEntry>;
  statistics: {
    memory_hits: number;
    disk_hits: number;
    misses: number;
    writes: number;
    last_write: number;
  };
}

interface CacheStats {
  memoryHits: number;
  diskHits: number;
  misses: number;
  writes: number;
  memoryEntries: number;
  dirty: boolean;
  diskEnabled: boolean;
}

// =============================================================================
// Path Utilities
// =============================================================================

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

function getCacheFilePath(): string {
  return join(getConfigDir(), "antigravity-signature-cache.json");
}

// =============================================================================
// Signature Cache Class
// =============================================================================

export class SignatureCache {
  // In-memory cache: key -> (value, timestamp)
  private cache: Map<string, { value: string; timestamp: number }> = new Map();
  
  // Configuration
  private memoryTtlMs: number;
  private diskTtlMs: number;
  private writeIntervalMs: number;
  private cacheFilePath: string;
  private enabled: boolean;
  
  // State
  private dirty: boolean = false;
  private writeTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // Statistics
  private stats = {
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    writes: 0,
  };

  constructor(config: SignatureCacheConfig) {
    this.enabled = config.enabled;
    this.memoryTtlMs = config.memory_ttl_seconds * 1000;
    this.diskTtlMs = config.disk_ttl_seconds * 1000;
    this.writeIntervalMs = config.write_interval_seconds * 1000;
    this.cacheFilePath = getCacheFilePath();

    if (this.enabled) {
      this.loadFromDisk();
      this.startBackgroundTasks();
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Generate a cache key from sessionId and modelId.
   */
  static makeKey(sessionId: string, modelId: string): string {
    return `${sessionId}:${modelId}`;
  }

  /**
   * Store a signature in the cache.
   */
  store(key: string, signature: string): void {
    if (!this.enabled) return;

    this.cache.set(key, {
      value: signature,
      timestamp: Date.now(),
    });
    this.dirty = true;
  }

  /**
   * Retrieve a signature from the cache.
   * Returns null if not found or expired.
   */
  retrieve(key: string): string | null {
    if (!this.enabled) return null;

    const entry = this.cache.get(key);
    if (entry) {
      const age = Date.now() - entry.timestamp;
      if (age <= this.memoryTtlMs) {
        this.stats.memoryHits++;
        return entry.value;
      }
      // Expired from memory, remove it
      this.cache.delete(key);
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Check if a key exists in the cache (without updating stats).
   */
  has(key: string): boolean {
    if (!this.enabled) return false;

    const entry = this.cache.get(key);
    if (!entry) return false;

    const age = Date.now() - entry.timestamp;
    return age <= this.memoryTtlMs;
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return {
      ...this.stats,
      memoryEntries: this.cache.size,
      dirty: this.dirty,
      diskEnabled: this.enabled,
    };
  }

  /**
   * Manually trigger a disk save.
   */
  async flush(): Promise<boolean> {
    if (!this.enabled) return true;
    return this.saveToDisk();
  }

  /**
   * Graceful shutdown: stop timers and flush to disk.
   */
  shutdown(): void {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.dirty && this.enabled) {
      this.saveToDisk();
    }
  }

  // ===========================================================================
  // Disk Operations
  // ===========================================================================

  /**
   * Load cache from disk file with TTL validation.
   */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.cacheFilePath)) {
        return;
      }

      const content = readFileSync(this.cacheFilePath, "utf-8");
      const data = JSON.parse(content) as CacheData;

      if (data.version !== "1.0") {
        console.warn("[SignatureCache] Version mismatch, starting fresh");
        return;
      }

      const now = Date.now();
      let loaded = 0;
      let expired = 0;

      for (const [key, entry] of Object.entries(data.entries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          this.cache.set(key, {
            value: entry.value,
            timestamp: entry.timestamp,
          });
          loaded++;
        } else {
          expired++;
        }
      }

      if (loaded > 0 || expired > 0) {
        console.log(`[SignatureCache] Loaded ${loaded} entries (${expired} expired)`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn("[SignatureCache] Cache file corrupted, starting fresh");
      }
      // Ignore other errors (file not found, etc.)
    }
  }

  /**
   * Save cache to disk with atomic write pattern.
   * Merges with existing disk entries that haven't expired.
   */
  private saveToDisk(): boolean {
    try {
      // Ensure directory exists
      const dir = dirname(this.cacheFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const now = Date.now();

      // Step 1: Load existing disk entries (if any)
      let existingEntries: Record<string, CacheEntry> = {};
      if (existsSync(this.cacheFilePath)) {
        try {
          const content = readFileSync(this.cacheFilePath, "utf-8");
          const data = JSON.parse(content) as CacheData;
          existingEntries = data.entries || {};
        } catch {
          // Start fresh if corrupted
        }
      }

      // Step 2: Filter existing disk entries by disk_ttl
      const validDiskEntries: Record<string, CacheEntry> = {};
      for (const [key, entry] of Object.entries(existingEntries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          validDiskEntries[key] = entry;
        }
      }

      // Step 3: Merge - memory entries take precedence
      const mergedEntries: Record<string, CacheEntry> = { ...validDiskEntries };
      for (const [key, entry] of this.cache.entries()) {
        mergedEntries[key] = {
          value: entry.value,
          timestamp: entry.timestamp,
        };
      }

      // Step 4: Build cache data
      const cacheData: CacheData = {
        version: "1.0",
        memory_ttl_seconds: this.memoryTtlMs / 1000,
        disk_ttl_seconds: this.diskTtlMs / 1000,
        entries: mergedEntries,
        statistics: {
          memory_hits: this.stats.memoryHits,
          disk_hits: this.stats.diskHits,
          misses: this.stats.misses,
          writes: this.stats.writes + 1,
          last_write: now,
        },
      };

      // Step 5: Atomic write (temp file + rename)
      const tmpPath = join(tmpdir(), `antigravity-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2), "utf-8");

      try {
        renameSync(tmpPath, this.cacheFilePath);
      } catch {
        // On Windows, rename across volumes may fail
        // Fall back to copy + delete
        writeFileSync(this.cacheFilePath, readFileSync(tmpPath));
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
      }

      this.stats.writes++;
      this.dirty = false;
      return true;
    } catch (error) {
      console.warn("[SignatureCache] Failed to save to disk:", error);
      return false;
    }
  }

  // ===========================================================================
  // Background Tasks
  // ===========================================================================

  /**
   * Start background write and cleanup timers.
   */
  private startBackgroundTasks(): void {
    // Periodic disk writes
    this.writeTimer = setInterval(() => {
      if (this.dirty) {
        this.saveToDisk();
      }
    }, this.writeIntervalMs);

    // Periodic memory cleanup (every 30 minutes)
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 30 * 60 * 1000);
  }

  /**
   * Remove expired entries from memory.
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age > this.memoryTtlMs) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[SignatureCache] Cleaned ${cleaned} expired entries from memory`);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a signature cache with the given configuration.
 * Returns null if caching is disabled.
 */
export function createSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null {
  if (!config || !config.enabled) {
    return null;
  }

  return new SignatureCache(config);
}
