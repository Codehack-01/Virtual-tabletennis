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

  /** End-of-match fanfare: a bright major arpeggio for a win, a falling minor line for a loss. */
  playGameOver(playerWon: boolean): void {
    if (playerWon) {
      this.playNotes([[523, 0, 0.16], [659, 0.13, 0.16], [784, 0.26, 0.16], [1047, 0.39, 0.7], [784, 0.39, 0.7], [659, 0.39, 0.7]], 'triangle', 0.18);
      this.playApplause(3.4, 0.5);
    } else {
      this.playNotes([[392, 0, 0.3], [370, 0.28, 0.3], [349, 0.56, 0.3], [262, 0.84, 1.1]], 'sawtooth', 0.06);
      this.playApplause(1.4, 0.12);
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

  /** Synthesized notes as [frequency Hz, start offset s, duration s]. */
  private playNotes(notes: Array<[number, number, number]>, type: OscillatorType, volume: number): void {
    const ctx = this.context;
    const master = this.master;
    if (!ctx || ctx.state !== 'running' || !master) return;
    const t0 = ctx.currentTime + 0.01;
    for (const [frequency, offset, duration] of notes) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      const start = t0 + offset;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    }
  }

  /** Crowd applause: many short, randomly timed noise "claps" through a band-pass. */
  private playApplause(seconds: number, volume: number): void {
    const ctx = this.context;
    const master = this.master;
    if (!ctx || ctx.state !== 'running' || !master) return;
    const rate = ctx.sampleRate;
    const length = Math.floor(seconds * rate);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      const claps = Math.floor(seconds * 70);
      for (let i = 0; i < claps; i++) {
        // Dense at the start, thinning out as the cheer fades.
        const at = Math.floor(Math.pow(Math.random(), 1.6) * (length - 0.03 * rate));
        const clapLength = Math.floor((0.008 + Math.random() * 0.012) * rate);
        const loudness = 0.25 + Math.random() * 0.75;
        for (let j = 0; j < clapLength; j++) {
          data[at + j] += (Math.random() * 2 - 1) * loudness * Math.exp(-j / (clapLength * 0.25));
        }
      }
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1800;
    band.Q.value = 0.6;
    const gain = ctx.createGain();
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.setValueAtTime(volume, t0 + seconds * 0.4);
    gain.gain.linearRampToValueAtTime(0, t0 + seconds);
    source.connect(band).connect(gain).connect(master);
    source.start();
  }
}
