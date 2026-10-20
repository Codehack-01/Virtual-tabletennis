import { useEffect, useRef } from 'react';

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  wobble: number;
  colour: string;
  shape: 'rect' | 'circle';
}

const WIN_COLOURS = ['#ffd166', '#ffe9a3', '#22d3ee', '#38bdf8', '#f472b6', '#a3e635', '#ffffff'];
const LOSE_COLOURS = ['rgba(255,90,100,0.55)', 'rgba(160,170,185,0.45)', 'rgba(255,140,120,0.4)'];

/**
 * Canvas particles behind the game-over screen: celebratory confetti cannons
 * for a win, slow drifting embers for a loss. Disabled for reduced motion.
 */
export function Confetti({ mode }: { mode: 'win' | 'lose' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const pieces: Piece[] = [];
    const colours = mode === 'win' ? WIN_COLOURS : LOSE_COLOURS;
    const spawn = (x: number, y: number, vx: number, vy: number, size: number): Piece => ({
      x, y, vx, vy, size,
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 12,
      wobble: Math.random() * Math.PI * 2,
      colour: colours[Math.floor(Math.random() * colours.length)],
      shape: mode === 'lose' || Math.random() < 0.25 ? 'circle' : 'rect',
    });
    const cannon = (fromLeft: boolean) => {
      for (let i = 0; i < 90; i++) {
        const angle = (fromLeft ? -Math.PI / 3 : -2 * Math.PI / 3) + (Math.random() - 0.5) * 0.7;
        const speed = 650 + Math.random() * 650;
        pieces.push(spawn(fromLeft ? -10 : width + 10, height * 0.85, Math.cos(angle) * speed, Math.sin(angle) * speed, 6 + Math.random() * 7));
      }
    };
    if (mode === 'win') {
      cannon(true);
      cannon(false);
    }

    let raf = 0;
    let last = performance.now();
    const started = last;
    let rainCarry = 0;
    let secondVolley = false;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const elapsed = (now - started) / 1000;
      if (mode === 'win' && !secondVolley && elapsed > 0.9) {
        secondVolley = true;
        cannon(true);
        cannon(false);
      }
      // Gentle continuous fall: confetti rain for a win, embers for a loss.
      const rate = mode === 'win' ? (elapsed < 6 ? 45 : 14) : 22;
      rainCarry += rate * dt;
      while (rainCarry >= 1) {
        rainCarry--;
        pieces.push(mode === 'win'
          ? spawn(Math.random() * width, -20, (Math.random() - 0.5) * 60, 60 + Math.random() * 90, 5 + Math.random() * 6)
          : spawn(Math.random() * width, height + 10, (Math.random() - 0.5) * 30, -(30 + Math.random() * 50), 1.5 + Math.random() * 3));
      }

      ctx.clearRect(0, 0, width, height);
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        if (mode === 'win') {
          p.vy += 900 * dt;
          p.vx *= 1 - 1.6 * dt;
          p.vy = Math.min(p.vy, 140 + p.size * 8);
        }
        p.wobble += dt * 4;
        p.x += (p.vx + Math.sin(p.wobble) * 30) * dt;
        p.y += p.vy * dt;
        p.rotation += p.spin * dt;
        if (p.y > height + 40 || p.y < -60) {
          pieces.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.colour;
        if (p.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Squash one axis to fake the flutter of a flat paper strip.
          ctx.scale(1, Math.abs(Math.cos(p.wobble)) * 0.8 + 0.2);
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [mode]);

  return <canvas ref={canvasRef} className="confetti" aria-hidden="true" />;
}
