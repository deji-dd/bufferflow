export class TokenBucketRateLimiter {
  private capacity: number;
  private refillRate: number; // tokens per millisecond
  private tokens: number;
  private lastRefillTimestamp: number;

  constructor(ratePerSec: number = 3000, burstCapacity: number = 5000) {
    this.capacity = burstCapacity;
    this.refillRate = ratePerSec / 1000;
    this.tokens = burstCapacity;
    this.lastRefillTimestamp = performance.now();
  }

  public updateConfig(ratePerSec: number, burstCapacity: number): void {
    this.refill();
    this.capacity = burstCapacity;
    this.refillRate = ratePerSec / 1000;
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  private refill(): void {
    const now = performance.now();
    const elapsed = now - this.lastRefillTimestamp;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
      this.lastRefillTimestamp = now;
    }
  }

  public tryConsume(tokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  public getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  public getCapacity(): number {
    return this.capacity;
  }
}
