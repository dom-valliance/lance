import type { Clock } from './rateLimit.js';

/** A clock that advances only when told, for deterministic timing tests. */
export class FakeClock implements Clock {
  private current = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    await Promise.resolve();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
