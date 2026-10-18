/** Timestamped values kept for a sliding window, for rates and percentiles. */
export class RollingWindow {
  private times: number[] = [];
  private values: number[] = [];

  constructor(private windowMs: number) {}

  push(t: number, value = 1): void {
    this.times.push(t);
    this.values.push(value);
    this.prune(t);
  }

  prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.times.length && this.times[i] < cutoff) i++;
    if (i) {
      this.times.splice(0, i);
      this.values.splice(0, i);
    }
  }

  /** Events per second over the window. */
  rate(now: number): number {
    this.prune(now);
    return (this.times.length * 1000) / this.windowMs;
  }

  mean(now: number): number {
    this.prune(now);
    return this.values.length ? this.values.reduce((a, b) => a + b, 0) / this.values.length : 0;
  }

  percentile(now: number, p: number): number {
    this.prune(now);
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }

  max(now: number): number {
    this.prune(now);
    return this.values.length ? Math.max(...this.values) : 0;
  }

  clear(): void {
    this.times = [];
    this.values = [];
  }
}

/**
 * Rate of a monotonically increasing counter (e.g. the video's presentedFrames).
 * Robust to stalls: a 5 s gap containing 100 frames reads 20 fps, not 100.
 */
export class CounterRate {
  private samples: { t: number; count: number }[] = [];

  constructor(private windowMs: number) {}

  push(t: number, count: number): void {
    this.samples.push({ t, count });
    // Keep at least two samples so a long stall still yields a rate.
    while (this.samples.length > 2 && this.samples[1].t < t - this.windowMs) this.samples.shift();
  }

  rate(): number {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    return b.t > a.t ? ((b.count - a.count) * 1000) / (b.t - a.t) : 0;
  }

  clear(): void {
    this.samples = [];
  }
}
