export class IdempotencyStore {
  private cache: Map<string, number>;
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries: number = 100000, ttlMs: number = 60000) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Checks if an idempotency key is already recorded.
   * If recorded and not expired, returns isDuplicate = true.
   * If not recorded, stores it and returns isDuplicate = false.
   */
  public checkAndRecord(key: string): { isDuplicate: boolean } {
    const now = Date.now();
    const existing = this.cache.get(key);

    if (existing !== undefined) {
      if (now - existing < this.ttlMs) {
        return { isDuplicate: true };
      }
      // Expired entry, re-record
    }

    // Maintain max size (FIFO eviction of oldest keys)
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, now);
    return { isDuplicate: false };
  }

  public has(key: string): boolean {
    const existing = this.cache.get(key);
    if (existing === undefined) return false;
    return Date.now() - existing < this.ttlMs;
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
  }
}
