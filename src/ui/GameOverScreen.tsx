import type { RallySnapshot } from '../game/rallyController';
import { Confetti } from './Confetti';

interface Props {
  rally: RallySnapshot;
  onRematch: () => void;
  onExit: () => void;
}

/** Full-screen match result: a victory celebration or a defeat screen. */
export function GameOverScreen({ rally, onRematch, onExit }: Props) {
  const won = rally.playerScore > rally.opponentScore;
  const title = won ? 'YOU WON' : 'YOU LOST';
  const topSpeed = Math.round(rally.stats.peakReturnSpeed * 3.6);
  return (
    <div className={`game-over ${won ? 'win' : 'lose'}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="go-backdrop" />
      <Confetti mode={won ? 'win' : 'lose'} />
      <div className="go-banner">
        <div className="go-stripe"><span className="go-shine" /></div>
        <h1 className="go-title" aria-label={title}>
          {title.split('').map((letter, i) => (
            <span key={i} style={{ animationDelay: `${180 + i * 55}ms` }} aria-hidden="true">
              {letter === ' ' ? '\u00a0' : letter}
            </span>
          ))}
        </h1>
        <div className="go-score">
          You <strong>{rally.playerScore}</strong> – <strong>{rally.opponentScore}</strong> House
        </div>
      </div>
      <p className="go-stats">
        Best rally <strong>{rally.bestRally}</strong>
        {topSpeed > 0 && <> · Top speed <strong>{topSpeed} km/h</strong></>}
      </p>
      <div className="go-actions">
        <button className="go-primary" onClick={onRematch} autoFocus>{won ? 'Play again' : 'Rematch'}</button>
        <button className="go-secondary" onClick={onExit}>Exit</button>
      </div>
    </div>
  );
}
