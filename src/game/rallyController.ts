import { BallSimulation, type BallPhysicsEvent } from '../physics/ballPhysics';

export type RallyPhase = 'idle' | 'pre-serve' | 'serve' | 'player-turn' | 'opponent-turn' | 'point-over' | 'game-over';

export interface RallySnapshot {
  phase: RallyPhase;
  playerScore: number;
  opponentScore: number;
  rallyHits: number;
  bestRally: number;
  message: string;
  autoServeAt: number | null;
  serveAt: number | null;
  stats: RallyStats;
  /** The most recent point; `id` increases with every point so the UI can react once. */
  lastPoint: PointResult | null;
}

export interface PointResult {
  id: number;
  winner: 'player' | 'opponent';
  reason: string;
  /** Rally length (legal player returns) of the exchange that just ended. */
  rallyHits: number;
  gameOver: boolean;
}

export interface RallyStats {
  serves: number;
  contacts: number;
  legalReturns: number;
  misses: number;
  netFaults: number;
  longFaults: number;
  doubleBounces: number;
  opponentReturns: number;
  averageReturnSpeed: number;
  peakReturnSpeed: number;
}

export const WIN_SCORE = 11;
const emptyStats = (): RallyStats => ({
  serves: 0, contacts: 0, legalReturns: 0, misses: 0, netFaults: 0,
  longFaults: 0, doubleBounces: 0, opponentReturns: 0, averageReturnSpeed: 0, peakReturnSpeed: 0,
});

export class RallyController {
  private snapshot: RallySnapshot = {
    phase: 'idle', playerScore: 0, opponentScore: 0, rallyHits: 0, bestRally: 0,
    message: 'Start a rally when you are ready', autoServeAt: null, serveAt: null, stats: emptyStats(), lastPoint: null,
  };
  private playerBounces = 0;
  private opponentBounces = 0;
  private opponentReturnPending = false;
  private returnSpeedTotal = 0;
  private nextPointId = 1;

  get state(): RallySnapshot {
    return {
      ...this.snapshot,
      stats: { ...this.snapshot.stats },
      lastPoint: this.snapshot.lastPoint && { ...this.snapshot.lastPoint },
    };
  }

  start(ball: BallSimulation, now = performance.now()): void {
    ball.setOpponentActive(true);
    ball.holdForServe();
    this.resetExchange();
    // Start/Restart always begins a fresh match. Keeping the old score let a
    // restart after game over end again on the very next point.
    this.snapshot.playerScore = 0;
    this.snapshot.opponentScore = 0;
    this.snapshot.bestRally = 0;
    this.snapshot.stats = emptyStats();
    this.snapshot.lastPoint = null;
    this.returnSpeedTotal = 0;
    this.snapshot.phase = 'pre-serve';
    this.snapshot.rallyHits = 0;
    this.snapshot.autoServeAt = null;
    this.snapshot.serveAt = now + 1400;
    this.snapshot.message = 'CPU preparing to serve';
  }

  reset(ball: BallSimulation): void {
    ball.reset();
    ball.setOpponentActive(false);
    this.snapshot = {
      phase: 'idle', playerScore: 0, opponentScore: 0, rallyHits: 0, bestRally: 0,
      message: 'Start a rally when you are ready', autoServeAt: null, serveAt: null, stats: emptyStats(), lastPoint: null,
    };
    this.returnSpeedTotal = 0;
    this.resetExchange();
  }

  update(now: number, ball: BallSimulation, events: BallPhysicsEvent[]): void {
    if (this.snapshot.phase === 'point-over' && this.snapshot.autoServeAt !== null && now >= this.snapshot.autoServeAt) {
      this.beginServe(ball);
    }
    if (this.snapshot.phase === 'pre-serve' && this.snapshot.serveAt !== null && now >= this.snapshot.serveAt) {
      this.beginServe(ball);
    }
    if (this.snapshot.phase === 'idle' || this.snapshot.phase === 'pre-serve' || this.snapshot.phase === 'game-over' || this.snapshot.phase === 'point-over') return;

    for (const event of events) {
      if (event.kind === 'table-bounce') this.onBounce(now, event.side!, ball);
      else if (event.kind === 'paddle-hit') this.onPlayerHit(now, event.speed ?? 0);
      else if (event.kind === 'opponent-hit') this.onOpponentHit(ball);
      else if (event.kind === 'net') {
        if (this.snapshot.phase === 'opponent-turn') this.snapshot.stats.netFaults++;
        const playerShot = this.snapshot.phase === 'opponent-turn';
        this.award(now, playerShot ? 'opponent' : 'player', playerShot ? 'Your shot hit the net' : 'Opponent hit the net');
      }
      else if (event.kind === 'out') this.onOut(now);
      if (this.pointHasEnded()) break;
    }

    if (this.pointHasEnded()) {
      ball.endPoint();
      return;
    }

  }

  private onOpponentHit(ball: BallSimulation): void {
    if (!this.opponentReturnPending || this.snapshot.phase !== 'opponent-turn') return;
    this.opponentReturnPending = false;
    ball.setOpponentReady(false);
    this.snapshot.phase = 'player-turn';
    this.snapshot.stats.opponentReturns++;
    this.playerBounces = 0;
    this.snapshot.message = 'Opponent returned — let it bounce, then hit';
  }

  private beginServe(ball: BallSimulation): void {
    ball.launch();
    this.resetExchange();
    this.snapshot.phase = 'serve';
    this.snapshot.rallyHits = 0;
    this.snapshot.autoServeAt = null;
    this.snapshot.serveAt = null;
    this.snapshot.message = 'Opponent serve — wait for your bounce';
    this.snapshot.stats.serves++;
  }

  private resetExchange(): void {
    this.playerBounces = 0;
    this.opponentBounces = 0;
    this.opponentReturnPending = false;
  }

  private pointHasEnded(): boolean {
    return this.snapshot.phase === 'point-over' || this.snapshot.phase === 'game-over';
  }

  private onBounce(now: number, side: 'player' | 'opponent', ball: BallSimulation): void {
    if (side === 'player') {
      this.playerBounces++;
      if ((this.snapshot.phase === 'serve' || this.snapshot.phase === 'player-turn') && this.playerBounces === 1) {
        this.snapshot.phase = 'player-turn';
        this.snapshot.message = 'Your return';
      } else if (this.snapshot.phase === 'player-turn' && this.playerBounces >= 2) {
        this.snapshot.stats.doubleBounces++;
        this.snapshot.stats.misses++;
        this.award(now, 'opponent', 'Double bounce');
      } else if (this.snapshot.phase === 'opponent-turn') {
        // `opponent-turn` means the player has already struck the ball and it
        // is travelling toward the CPU. If that return falls back onto the
        // player's half, it is the player's fault—not a successful return.
        this.snapshot.stats.misses++;
        this.award(now, 'opponent', 'Your return bounced on your side');
      }
    } else {
      this.opponentBounces++;
      if (this.snapshot.phase === 'opponent-turn' && this.opponentBounces === 1) {
        this.opponentReturnPending = true;
        // The CPU may strike only after a legal bounce on its own side. Its
        // visible paddle still tracks the incoming shot before this point.
        // A wide ball beyond its physical reach now produces a genuine miss.
        ball.setOpponentReady(true);
        this.snapshot.message = 'Opponent preparing return';
      } else if (this.snapshot.phase === 'opponent-turn' && this.opponentBounces >= 2) {
        this.award(now, 'player', 'Double bounce on opponent side');
      } else if (this.snapshot.phase === 'player-turn' || this.snapshot.phase === 'serve') {
        this.award(now, 'opponent', 'Wrong-side bounce');
      }
    }
  }

  private onPlayerHit(now: number, speed: number): void {
    this.snapshot.stats.contacts++;
    if (this.snapshot.phase !== 'player-turn' || this.playerBounces < 1) {
      this.snapshot.stats.misses++;
      this.award(now, 'opponent', 'Hit before a legal bounce');
      return;
    }
    this.snapshot.phase = 'opponent-turn';
    this.opponentBounces = 0;
    this.snapshot.rallyHits++;
    this.snapshot.stats.legalReturns++;
    this.returnSpeedTotal += speed;
    this.snapshot.stats.averageReturnSpeed = this.returnSpeedTotal / this.snapshot.stats.legalReturns;
    this.snapshot.stats.peakReturnSpeed = Math.max(this.snapshot.stats.peakReturnSpeed, speed);
    this.snapshot.bestRally = Math.max(this.snapshot.bestRally, this.snapshot.rallyHits);
    this.snapshot.message = 'Return in flight';
  }

  private onOut(now: number): void {
    if (this.snapshot.phase === 'opponent-turn') {
      if (this.opponentBounces === 0) this.snapshot.stats.longFaults++;
      this.award(now, this.opponentBounces > 0 ? 'player' : 'opponent', this.opponentBounces > 0 ? 'Opponent missed' : 'Your return went long');
    } else {
      if (this.playerBounces > 0) this.snapshot.stats.misses++;
      const opponentFault = this.snapshot.rallyHits > 0 ? 'Opponent hit out' : 'Opponent serve went out';
      this.award(now, this.playerBounces > 0 ? 'opponent' : 'player', this.playerBounces > 0 ? 'Missed return' : opponentFault);
    }
  }

  private award(now: number, winner: 'player' | 'opponent', reason: string): void {
    if (this.snapshot.phase === 'point-over' || this.snapshot.phase === 'game-over') return;
    if (winner === 'player') this.snapshot.playerScore++;
    else this.snapshot.opponentScore++;
    const a = this.snapshot.playerScore;
    const b = this.snapshot.opponentScore;
    const gameWon = Math.max(a, b) >= WIN_SCORE && Math.abs(a - b) >= 2;
    this.snapshot.phase = gameWon ? 'game-over' : 'point-over';
    this.snapshot.message = gameWon
      ? `${winner === 'player' ? 'You win' : 'Opponent wins'} · ${reason}`
      : `${winner === 'player' ? 'Your point' : 'Opponent point'} · ${reason} · next serve soon`;
    this.snapshot.lastPoint = { id: this.nextPointId++, winner, reason, rallyHits: this.snapshot.rallyHits, gameOver: gameWon };
    this.snapshot.autoServeAt = gameWon ? null : now + 2000;
    this.snapshot.serveAt = null;
    this.opponentReturnPending = false;
  }
}
