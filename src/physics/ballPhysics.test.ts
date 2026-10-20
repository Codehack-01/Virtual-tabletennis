import { describe, expect, it } from 'vitest';
import type { PaddlePose } from '../control/paddleController';
import { BALL_RADIUS, BallSimulation, TABLE_PHYSICS, bladeCenter } from './ballPhysics';

const paddle: PaddlePose = {
  position: { x: 0, y: 1, z: 1.65 }, velocity: { x: 1, y: 0.5, z: 0 },
  normalized: { x: 0, y: 0, z: 0 }, roll: 0, pitch: 0, yaw: 0, tracked: true, status: 'tracking',
  arm: null, playerRetreat: 0,
};

describe('BallSimulation', () => {
  it('applies configurable feed speed', () => {
    const sim = new BallSimulation();
    sim.configure({ feedSpeed: 4.6, drag: 0.1, tableRestitution: 0.88, paddleRestitution: 0.86, swingTransfer: 0.65 });
    sim.launch();
    expect(sim.state.velocity.z).toBe(4.6);
  });

  it('lands a slow training feed well inside the player half', () => {
    const sim = new BallSimulation();
    sim.launch(2.8);
    const noPaddle = { ...paddle, tracked: false };
    for (let i = 0; i < 400 && sim.state.bounces === 0; i++) sim.step(1 / 240, noPaddle);
    expect(sim.state.bounces).toBe(1);
    expect(sim.state.position.z).toBeGreaterThan(0.35);
    expect(sim.state.position.z).toBeLessThan(0.6);
    expect(sim.state.position.z).toBeLessThan(TABLE_PHYSICS.length / 2);
  });

  it('brings the opening feed through the normal ready-height strike zone', () => {
    const sim = new BallSimulation();
    const readyPaddle = { ...paddle, position: { x: 0, y: 1.04, z: 1.5 }, velocity: { x: 0, y: 0, z: 0 } };
    sim.launch(2.8);
    const noPaddle = { ...readyPaddle, tracked: false };
    for (let i = 0; i < 600 && sim.state.position.z < readyPaddle.position.z; i++) sim.step(1 / 240, noPaddle);
    const blade = bladeCenter(readyPaddle);
    expect(sim.state.position.z).toBeGreaterThanOrEqual(readyPaddle.position.z);
    expect(Math.abs(sim.state.position.y - blade.y)).toBeLessThan(0.14 + 0.02);
  });

  it('makes an ordinary opening contact land on the opponent half', () => {
    const sim = new BallSimulation();
    const readyPaddle = { ...paddle, position: { x: 0, y: 1.04, z: 1.5 }, velocity: { x: 0, y: 0, z: 0 } };
    sim.launch(2.8);
    for (let i = 0; i < 800 && sim.state.paddleHits === 0; i++) sim.step(1 / 240, readyPaddle, { collision: 0.65, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(1);
    for (let i = 0; i < 800 && sim.state.bounces < 2 && sim.state.status === 'in-play'; i++) {
      sim.step(1 / 240, { ...readyPaddle, tracked: false }, { collision: 0.65, netClearance: 0.4 });
    }
    const events = sim.consumeEvents();
    const bounce = [...events].reverse().find((event) => event.kind === 'table-bounce');
    expect(bounce?.side).toBe('opponent');
  });

  it('makes a neutral later rally contact land on the opponent half', () => {
    const sim = new BallSimulation();
    const readyPaddle = { ...paddle, position: { x: 0, y: 1.04, z: 1.5 }, velocity: { x: 0, y: 0, z: 0 } };
    // Consume the one-time opening-return assistance first.
    sim.launch(2.8);
    for (let i = 0; i < 800 && sim.state.paddleHits === 0; i++) {
      sim.step(1 / 240, readyPaddle, { collision: 0.65, netClearance: 0.4 });
    }
    expect(sim.state.paddleHits).toBe(1);
    sim.consumeEvents();
    for (let i = 0; i < 30; i++) sim.step(1 / 240, { ...readyPaddle, tracked: false });

    const blade = bladeCenter(readyPaddle);
    sim.state = {
      position: { x: blade.x, y: blade.y, z: blade.z - 0.01 },
      velocity: { x: 0, y: -1, z: 3.2 }, status: 'in-play', bounces: 2, paddleHits: 1, lastEvent: '',
    };
    sim.step(0.01, readyPaddle, { collision: 0.65, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(2);
    for (let i = 0; i < 800 && sim.state.bounces < 3 && sim.state.status === 'in-play'; i++) {
      sim.step(1 / 240, { ...readyPaddle, tracked: false }, { collision: 0.65, netClearance: 0.4 });
    }
    const bounce = sim.consumeEvents().find((event) => event.kind === 'table-bounce');
    expect(bounce?.side).toBe('opponent');
  });

  it('keeps a CPU rally return in the natural ready-position strike zone', () => {
    const sim = new BallSimulation();
    sim.state = {
      position: { x: 0, y: 1, z: -0.9 }, velocity: { x: 0, y: 1.5, z: -3 },
      status: 'in-play', bounces: 1, paddleHits: 1, lastEvent: '',
    };
    sim.opponentReturn();
    const noPaddle = { ...paddle, tracked: false };
    let peakY = sim.state.position.y;
    for (let i = 0; i < 500 && sim.state.bounces < 2; i++) {
      sim.step(1 / 240, noPaddle);
      peakY = Math.max(peakY, sim.state.position.y);
    }
    expect(sim.state.position.z).toBeGreaterThan(0.35);
    expect(sim.state.position.z).toBeLessThan(0.6);
    expect(peakY).toBeLessThan(1.3);

    for (let i = 0; i < 300 && sim.state.position.z < 1.18; i++) sim.step(1 / 240, noPaddle);
    expect(sim.state.position.y).toBeGreaterThan(0.88);
    expect(sim.state.position.y).toBeLessThan(1.2);
  });

  it.each([-0.7, 0.7])('keeps an angled CPU return reachable at the player strike zone from x=%s', (x) => {
    const sim = new BallSimulation();
    sim.state = {
      position: { x, y: 1, z: -0.9 }, velocity: { x: 0, y: 1.5, z: -3 },
      status: 'in-play', bounces: 1, paddleHits: 1, lastEvent: '',
    };
    sim.opponentReturn();
    const noPaddle = { ...paddle, tracked: false };
    for (let i = 0; i < 500 && sim.state.position.z < 1.18; i++) sim.step(1 / 240, noPaddle);
    expect(Math.abs(sim.state.position.x)).toBeLessThan(0.62);
  });

  it('physically returns a normal player shot after its legal opponent-side bounce', () => {
    const sim = new BallSimulation();
    sim.setOpponentActive(true);
    const playerPaddle = {
      ...paddle,
      position: { x: 0, y: 1.04, z: 1.5 },
      velocity: { x: 0, y: 0.5, z: 0 },
      roll: -Math.PI / 2,
    };
    const playerBlade = bladeCenter(playerPaddle);
    sim.state = {
      position: { x: playerBlade.x, y: playerBlade.y, z: playerBlade.z - 0.01 },
      velocity: { x: 0, y: -1, z: 3.2 }, status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, playerPaddle, { collision: 0.65, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(1);

    const noPaddle = { ...playerPaddle, tracked: false };
    let opponentHit = false;
    for (let i = 0; i < 1000 && sim.state.status === 'in-play'; i++) {
      sim.step(1 / 240, noPaddle, { collision: 0.65, netClearance: 0.4 });
      const events = sim.consumeEvents();
      if (events.some((event) => event.kind === 'table-bounce' && event.side === 'opponent')) {
        sim.setOpponentReady(true);
      }
      if (events.some((event) => event.kind === 'opponent-hit')) {
        opponentHit = true;
        break;
      }
    }
    expect(opponentHit).toBe(true);
    expect(sim.state.velocity.z).toBeGreaterThan(0);
  });

  // Webcam strokes are mostly upward brushes: the tracked wrist can rise at
  // several m/s while barely moving toward the table.
  const upwardStroke = (swingY: number) => {
    const sim = new BallSimulation();
    sim.setOpponentActive(true);
    const playerPaddle = { ...paddle, position: { x: 0, y: 1.04, z: 1.5 }, velocity: { x: 0, y: swingY, z: -0.6 }, roll: -Math.PI / 2 };
    const playerBlade = bladeCenter(playerPaddle);
    sim.state = {
      position: { x: playerBlade.x, y: playerBlade.y, z: playerBlade.z - 0.01 },
      velocity: { x: 0, y: -1, z: 3.2 }, status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, playerPaddle, { collision: 0.65, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(1);
    return { sim, noPaddle: { ...playerPaddle, tracked: false } };
  };

  it.each([3, 5, 7])('lands a strong upward webcam stroke (%s m/s) on the opponent table', (swingY) => {
    const { sim, noPaddle } = upwardStroke(swingY);
    let bounce: { side?: string } | undefined;
    for (let i = 0; i < 1000 && !bounce && sim.state.status === 'in-play'; i++) {
      sim.step(1 / 240, noPaddle, { collision: 0.65, netClearance: 0.4 });
      bounce = sim.consumeEvents().find((event) => event.kind === 'table-bounce');
    }
    expect(bounce?.side).toBe('opponent');
  });

  it.each([3, 5, 7])('lets the CPU reach and return a high, deep ball from a %s m/s upward stroke', (swingY) => {
    const { sim, noPaddle } = upwardStroke(swingY);
    let opponentHit = false;
    for (let i = 0; i < 1000 && sim.state.status === 'in-play' && !opponentHit; i++) {
      sim.step(1 / 240, noPaddle, { collision: 0.65, netClearance: 0.4 });
      const events = sim.consumeEvents();
      if (events.some((event) => event.kind === 'table-bounce' && event.side === 'opponent')) sim.setOpponentReady(true);
      opponentHit = events.some((event) => event.kind === 'opponent-hit');
    }
    expect(opponentHit).toBe(true);
    // ...and its reply lands legally on the player's half.
    let reply: { side?: string } | undefined;
    for (let i = 0; i < 1000 && !reply && sim.state.status === 'in-play'; i++) {
      sim.step(1 / 240, noPaddle, { collision: 0.65, netClearance: 0.4 });
      reply = sim.consumeEvents().find((event) => event.kind === 'table-bounce' || event.kind === 'net');
    }
    expect(reply).toMatchObject({ kind: 'table-bounce', side: 'player' });
  });

  it.each([
    { x: -0.5, stroke: 'forehand' as const, rollSign: 1 },
    { x: 0.5, stroke: 'backhand' as const, rollSign: -1 },
  ])('turns the CPU blade into a $stroke for an x=$x interception', ({ x, stroke, rollSign }) => {
    const sim = new BallSimulation();
    sim.setOpponentActive(true);
    sim.state = {
      position: { x, y: 1.15, z: -0.35 }, velocity: { x: 0, y: 0.2, z: -2.4 },
      status: 'in-play', bounces: 1, paddleHits: 1, lastEvent: '',
    };
    for (let i = 0; i < 60; i++) sim.step(1 / 240, { ...paddle, tracked: false });
    expect(sim.opponentPaddle.stroke).toBe(stroke);
    expect(Math.sign(sim.opponentPaddle.roll)).toBe(rollSign);
    expect(Math.abs(sim.opponentPaddle.roll)).toBeGreaterThan(0.35);
  });

  it('bounces from the table surface', () => {
    const sim = new BallSimulation();
    sim.state = {
      position: { x: 0, y: TABLE_PHYSICS.height + 0.025, z: 0.5 },
      velocity: { x: 0, y: -1, z: 0 }, status: 'in-play', bounces: 0, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, paddle);
    expect(sim.state.velocity.y).toBeGreaterThan(0);
    expect(sim.state.bounces).toBe(1);
  });

  it('applies configurable table restitution', () => {
    const bounce = (restitution: number) => {
      const sim = new BallSimulation();
      sim.configure({ feedSpeed: 3.2, drag: 0, tableRestitution: restitution, paddleRestitution: 0.86, swingTransfer: 0.65 });
      sim.state = {
        position: { x: 0, y: TABLE_PHYSICS.height + 0.021, z: 0.5 }, velocity: { x: 0, y: -2, z: 0 },
        status: 'in-play', bounces: 0, paddleHits: 0, lastEvent: '',
      };
      sim.step(0.005, paddle);
      return sim.state.velocity.y;
    };
    expect(bounce(0.95)).toBeGreaterThan(bounce(0.6));
  });

  it('uses a swept test so a fast ball cannot tunnel through the paddle', () => {
    const sim = new BallSimulation();
    const blade = bladeCenter(paddle);
    sim.state = {
      position: { x: blade.x, y: blade.y, z: 1.4 }, velocity: { x: 0, y: 0, z: 20 },
      status: 'in-play', bounces: 0, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.02, paddle);
    expect(sim.state.velocity.z).toBeLessThan(0);
    expect(sim.state.paddleHits).toBe(1);
  });

  it('does not hit when the ball misses the blade radius', () => {
    const sim = new BallSimulation();
    const blade = bladeCenter(paddle);
    sim.state = {
      position: { x: blade.x + 0.3, y: blade.y, z: 1.4 }, velocity: { x: 0, y: 0, z: 20 },
      status: 'in-play', bounces: 0, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.02, paddle);
    expect(sim.state.velocity.z).toBeGreaterThan(0);
    expect(sim.state.paddleHits).toBe(0);
  });

  it('allows a delayed webcam pose within the assisted depth window', () => {
    const sim = new BallSimulation();
    const blade = bladeCenter(paddle);
    sim.state = {
      position: { x: blade.x + 0.1, y: blade.y, z: blade.z - 0.3 },
      velocity: { x: 0, y: 0, z: 3.2 }, status: 'in-play', bounces: 0, paddleHits: 0, lastEvent: '',
    };
    sim.step(1 / 240, paddle, { collision: 1, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(1);
    expect(sim.state.velocity.z).toBeLessThan(0);
  });

  it.each([
    { side: 'right', x: 0.63, roll: -Math.PI / 2, swingX: 3, incomingX: 0.25 },
    { side: 'left/backhand', x: -0.63, roll: Math.PI / 2, swingX: -3, incomingX: -0.25 },
  ])('keeps an assisted $side edge return on the opponent table', ({ x, roll, swingX, incomingX }) => {
    const sim = new BallSimulation();
    const edgePaddle = {
      ...paddle,
      position: { x, y: 1, z: 1.65 },
      velocity: { x: swingX, y: 0.5, z: 0 },
      roll,
    };
    const blade = bladeCenter(edgePaddle);
    sim.state = {
      position: { x: blade.x, y: blade.y, z: blade.z - 0.01 },
      velocity: { x: incomingX, y: -1, z: 3.2 }, status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, edgePaddle, { collision: 0.65, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(1);
    for (let i = 0; i < 800 && sim.state.bounces < 2 && sim.state.status === 'in-play'; i++) {
      sim.step(1 / 240, { ...edgePaddle, tracked: false }, { collision: 0.65, netClearance: 0.4 });
    }
    const bounce = sim.consumeEvents().find((event) => event.kind === 'table-bounce');
    expect(bounce?.side).toBe('opponent');
    expect(Math.abs(sim.state.position.x)).toBeLessThan(TABLE_PHYSICS.width / 2 - BALL_RADIUS);
  });

  it('sweeps the blade itself across a fast backhand edge reach', () => {
    const sim = new BallSimulation();
    const backhandStart = {
      ...paddle,
      position: { x: -0.35, y: 1, z: 1.65 },
      velocity: { x: -3, y: 0, z: 0 },
      roll: Math.PI / 2,
    };
    const backhand = {
      ...paddle,
      position: { x: -0.58, y: 1, z: 1.65 },
      velocity: { x: -3, y: 0, z: 0 },
      roll: Math.PI / 2,
    };
    const blade = bladeCenter(backhand);
    // Establish the previous visual blade pose away from the incoming ball.
    sim.state = {
      position: { x: -0.53, y: blade.y, z: blade.z - 0.4 },
      velocity: { x: 0, y: 0, z: 3.2 }, status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(1 / 240, backhandStart, { collision: 0.65, netClearance: 0.4 });
    sim.state = {
      position: { x: -0.53, y: blade.y, z: blade.z - 0.01 },
      velocity: { x: 0, y: -1, z: 3.2 }, status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, backhand, { collision: 0.65, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(1);
  });

  it('does not turn fast paddle velocity into an invisible oversized blade', () => {
    const sim = new BallSimulation();
    const fastPaddle = {
      ...paddle,
      position: { x: -0.58, y: 1, z: 1.65 },
      velocity: { x: -3, y: 0, z: 0 },
      roll: Math.PI / 2,
    };
    const blade = bladeCenter(fastPaddle);
    sim.state = {
      position: { x: blade.x - 0.15, y: blade.y, z: blade.z - 0.01 },
      velocity: { x: 0, y: -1, z: 3.2 }, status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, fastPaddle, { collision: 0.65, netClearance: 0.4 });
    expect(sim.state.paddleHits).toBe(0);
  });

  it('gives a return enough lift to clear the net', () => {
    const sim = new BallSimulation();
    const blade = bladeCenter(paddle);
    sim.state = {
      position: { x: blade.x, y: blade.y, z: blade.z - 0.1 },
      velocity: { x: 0, y: -2, z: 3.2 }, status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(1 / 240, paddle, { collision: 0.65, netClearance: 1 });
    expect(sim.state.paddleHits).toBe(1);
    for (let i = 0; i < 180 && sim.state.position.z > 0; i++) sim.step(1 / 240, paddle, { collision: 0.65, netClearance: 1 });
    expect(sim.state.lastEvent).not.toBe('Net contact');
    expect(sim.state.position.y).toBeGreaterThan(TABLE_PHYSICS.height + TABLE_PHYSICS.netHeight);
  });

  it('uses upward swing velocity and face pitch to create lift with assistance off', () => {
    const sim = new BallSimulation();
    const upward = { ...paddle, pitch: 0.35, velocity: { x: 0, y: 2.2, z: 0 } };
    const blade = bladeCenter(upward);
    sim.state = {
      position: { x: blade.x, y: blade.y, z: blade.z - 0.01 }, velocity: { x: 0, y: -1, z: 3 },
      status: 'in-play', bounces: 1, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, upward, { collision: 0, netClearance: 0 });
    expect(sim.state.paddleHits).toBe(1);
    expect(sim.state.velocity.y).toBeGreaterThan(1);
  });

  it('blocks a low ball crossing the net', () => {
    const sim = new BallSimulation();
    sim.state = {
      position: { x: 0, y: 0.85, z: -0.02 }, velocity: { x: 0, y: 0, z: 4 },
      status: 'in-play', bounces: 0, paddleHits: 0, lastEvent: '',
    };
    sim.step(0.01, paddle);
    expect(sim.state.velocity.z).toBeLessThan(0);
    expect(sim.state.lastEvent).toBe('Net contact');
  });
});
