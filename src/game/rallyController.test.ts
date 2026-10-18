import { describe, expect, it } from 'vitest';
import { BallSimulation } from '../physics/ballPhysics';
import { RallyController } from './rallyController';

describe('RallyController', () => {
  const beginServe = (rally: RallyController, ball: BallSimulation) => {
    rally.start(ball, 0);
    expect(rally.state.phase).toBe('pre-serve');
    expect(ball.state.status).toBe('held');
    rally.update(1400, ball, []);
    expect(rally.state.phase).toBe('serve');
  };

  it('moves from serve to a legal player return', () => {
    const ball = new BallSimulation();
    const rally = new RallyController();
    beginServe(rally, ball);
    rally.update(1410, ball, [{ kind: 'table-bounce', side: 'player' }]);
    expect(rally.state.phase).toBe('player-turn');
    rally.update(1420, ball, [{ kind: 'paddle-hit', side: 'player' }]);
    expect(rally.state.phase).toBe('opponent-turn');
    expect(rally.state.rallyHits).toBe(1);
    expect(rally.state.stats.legalReturns).toBe(1);
  });

  it('awards a double bounce and automatically serves the next ball', () => {
    const ball = new BallSimulation();
    const rally = new RallyController();
    beginServe(rally, ball);
    rally.update(1410, ball, [{ kind: 'table-bounce', side: 'player' }]);
    rally.update(1420, ball, [{ kind: 'table-bounce', side: 'player' }]);
    expect(rally.state.opponentScore).toBe(1);
    expect(rally.state.message).toContain('Double bounce');
    rally.update(3019, ball, []);
    expect(rally.state.phase).toBe('point-over');
    expect(ball.state.status).toBe('out');
    rally.update(3020, ball, []);
    expect(rally.state.phase).toBe('serve');
    expect(ball.state.status).toBe('in-play');
  });

  it('returns a legal shot with the predictable opponent', () => {
    const ball = new BallSimulation();
    const rally = new RallyController();
    beginServe(rally, ball);
    rally.update(1410, ball, [{ kind: 'table-bounce', side: 'player' }, { kind: 'paddle-hit', side: 'player' }]);
    ball.state = {
      ...ball.state,
      position: { x: 0, y: 0.78, z: -0.65 },
      velocity: { x: 0, y: 2.2, z: -3.2 },
      status: 'in-play',
    };
    rally.update(1420, ball, [{ kind: 'table-bounce', side: 'opponent' }]);
    for (let i = 0; i < 200 && rally.state.phase === 'opponent-turn'; i++) {
      ball.step(1 / 240, {
        position: { x: 0, y: 1, z: 1.65 }, velocity: { x: 0, y: 0, z: 0 },
        normalized: { x: 0, y: 0, z: 0 }, roll: 0, pitch: 0, yaw: 0,
        tracked: false, status: 'searching', arm: null, playerRetreat: 0,
      });
      rally.update(1420 + i * (1000 / 240), ball, ball.consumeEvents());
    }
    expect(rally.state.phase).toBe('player-turn');
    expect(ball.state.velocity.z).toBeGreaterThan(0);
    expect(ball.state.lastEvent).toBe('Opponent return');
  });

  it('awards the player when a wide shot beats the physical CPU paddle', () => {
    const ball = new BallSimulation();
    const rally = new RallyController();
    beginServe(rally, ball);
    rally.update(1410, ball, [{ kind: 'table-bounce', side: 'player' }, { kind: 'paddle-hit', side: 'player' }]);
    ball.state = {
      ...ball.state,
      position: { x: 0.72, y: 0.78, z: -0.65 },
      velocity: { x: 2.2, y: 2.2, z: -3.2 },
      status: 'in-play',
    };
    rally.update(1420, ball, [{ kind: 'table-bounce', side: 'opponent' }]);
    const noPaddle = {
      position: { x: 0, y: 1, z: 1.65 }, velocity: { x: 0, y: 0, z: 0 },
      normalized: { x: 0, y: 0, z: 0 }, roll: 0, pitch: 0, yaw: 0,
      tracked: false as const, status: 'searching' as const, arm: null, playerRetreat: 0,
    };
    for (let i = 0; i < 800 && rally.state.phase === 'opponent-turn'; i++) {
      ball.step(1 / 240, noPaddle);
      rally.update(1420 + i * (1000 / 240), ball, ball.consumeEvents());
    }
    expect(rally.state.playerScore).toBe(1);
    expect(rally.state.message).toContain('Opponent missed');
    expect(rally.state.stats.opponentReturns).toBe(0);
  });

  it('calls a net fault against the side that struck the ball', () => {
    const ball = new BallSimulation();
    const rally = new RallyController();
    beginServe(rally, ball);
    rally.update(1410, ball, [{ kind: 'table-bounce', side: 'player' }, { kind: 'paddle-hit', side: 'player' }]);
    rally.update(1420, ball, [{ kind: 'net' }]);
    expect(rally.state.opponentScore).toBe(1);
    expect(rally.state.phase).toBe('point-over');
  });

  it('awards the CPU when a player return bounces on the player side', () => {
    const ball = new BallSimulation();
    const rally = new RallyController();
    beginServe(rally, ball);
    rally.update(1410, ball, [{ kind: 'table-bounce', side: 'player' }, { kind: 'paddle-hit', side: 'player' }]);
    expect(rally.state.phase).toBe('opponent-turn');
    rally.update(1420, ball, [{ kind: 'table-bounce', side: 'player' }]);
    expect(rally.state.playerScore).toBe(0);
    expect(rally.state.opponentScore).toBe(1);
    expect(rally.state.message).toContain('Your return bounced on your side');
  });
});
