export interface OneEuroParams {
  /** Cutoff frequency (Hz) when the signal is still. */
  minCutoff: number;
  /** Cutoff increase per unit of speed. */
  beta: number;
  /** Cutoff frequency (Hz) for the derivative estimate. */
  dCutoff: number;
}

function alpha(dtSeconds: number, cutoffHz: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/**
 * One Euro filter (Casiez et al. 2012) over an N-dimensional vector.
 * Heavy smoothing when still (kills jitter), light smoothing when moving fast
 * (keeps swings responsive). Uses the magnitude of the vector's speed so all
 * axes share one cutoff and diagonal motion isn't distorted.
 */
export class OneEuroFilter {
  private prev: number[] | null = null;
  private prevDeriv: number[] = [];
  private prevT = 0;

  constructor(public params: OneEuroParams) {}

  reset(): void {
    this.prev = null;
  }

  filter(value: number[], tMs: number): number[] {
    if (!this.prev || tMs <= this.prevT) {
      if (!this.prev) {
        this.prev = value.slice();
        this.prevDeriv = value.map(() => 0);
        this.prevT = tMs;
      }
      return this.prev.slice();
    }
    const dt = (tMs - this.prevT) / 1000;
    const { minCutoff, beta, dCutoff } = this.params;

    const aD = alpha(dt, dCutoff);
    const deriv = value.map((v, i) => {
      const raw = (v - this.prev![i]) / dt;
      return this.prevDeriv[i] + aD * (raw - this.prevDeriv[i]);
    });
    const speed = Math.hypot(...deriv);
    const a = alpha(dt, minCutoff + beta * speed);
    const out = value.map((v, i) => this.prev![i] + a * (v - this.prev![i]));

    this.prev = out;
    this.prevDeriv = deriv;
    this.prevT = tMs;
    return out.slice();
  }
}
