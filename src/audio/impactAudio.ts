import type { BallPhysicsEvent } from '../physics/ballPhysics';

type SampleName = 'paddle' | 'table';

const SAMPLE_URLS: Record<SampleName, string> = {
  paddle: '/audio/pingpongbat.ogg',
  table: '/audio/pingpongboard.ogg',
};

/**
 * Plays recorded table-tennis impacts after physics has emitted a collision.
 * Audio remains an observer: it cannot affect trajectory, timing, or scoring.
 */
export class ImpactAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private samples = new Map<SampleName, AudioBuffer>();

  unlock(): void {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.gain.value = 0.95;
      this.limiter = this.context.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 7;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.08;
      this.master.connect(this.limiter).connect(this.context.destination);
      void this.loadSamples();
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
  }

  play(events: BallPhysicsEvent[]): void {
    if (!this.context || this.context.state !== 'running' || !this.master) return;
    for (const event of events) {
      if (event.kind === 'table-bounce') {
        const strength = Math.max(0.72, Math.min(1.12, (event.speed ?? 2.2) / 2.6));
        this.playSample('table', event.side === 'player' ? 0.22 : -0.22, strength, 0.97, 1.035);
      } else if (event.kind === 'paddle-hit') {
        const strength = Math.max(0.82, Math.min(1.18, (event.speed ?? 3.2) / 3.8));
        this.playSample('paddle', 0.3, strength, 0.965, 1.025);
      } else if (event.kind === 'opponent-hit') {
        const strength = Math.max(0.78, Math.min(1.12, (event.speed ?? 3.4) / 4));
        this.playSample('paddle', -0.3, strength, 0.98, 1.04);
      }
    }
  }

  dispose(): void {
    if (this.context) void this.context.close();
    this.context = null;
    this.master = null;
    this.limiter = null;
    this.samples.clear();
  }

  private async loadSamples(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;
    await Promise.all((Object.entries(SAMPLE_URLS) as Array<[SampleName, string]>).map(async ([name, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Unable to load ${name} impact sound`);
      const encoded = await response.arrayBuffer();
      const decoded = await ctx.decodeAudioData(encoded);
      if (this.context === ctx) this.samples.set(name, decoded);
    })).catch(() => {
      // Sound is an enhancement; a decoding/network failure must never stop play.
    });
  }

  private playSample(name: SampleName, pan: number, volume: number, minRate: number, maxRate: number): void {
    const ctx = this.context;
    const master = this.master;
    const buffer = this.samples.get(name);
    if (!ctx || !master || !buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Tiny variation preserves the natural differences between successive hits.
    source.playbackRate.value = minRate + Math.random() * (maxRate - minRate);
    const gain = ctx.createGain();
    gain.gain.value = volume;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    source.connect(gain).connect(panner).connect(master);
    source.start();
  }
}
