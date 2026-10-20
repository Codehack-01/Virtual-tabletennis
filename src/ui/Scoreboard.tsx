import { WIN_SCORE, type PointResult, type RallySnapshot } from '../game/rallyController';

/** Who the ball is travelling toward, for the serve/turn indicator. */
function turnSide(phase: RallySnapshot['phase']): 'player' | 'opponent' | null {
  if (phase === 'serve' || phase === 'player-turn') return 'player';
  if (phase === 'opponent-turn' || phase === 'pre-serve') return 'opponent';
  return null;
}

function matchBadge(you: number, house: number): { text: string; side: 'player' | 'opponent' | 'even' } | null {
  if (Math.max(you, house) < WIN_SCORE - 1) return null;
  if (you === house) return { text: 'Deuce', side: 'even' };
  return { text: 'Match point', side: you > house ? 'player' : 'opponent' };
}

function ScorePanel({ side, score, point }: { side: 'player' | 'opponent'; score: number; point: PointResult | null }) {
  const scored = point && point.winner === side ? point.id : null;
  return (
    <div className={`sb-score sb-score-${side === 'player' ? 'you' : 'house'}`}>
      {/* Keys remount the elements so the pop/flash animations replay on every point. */}
      <span key={score} className={`sb-digit${scored ? ' sb-digit-pop' : ''}`}>{score}</span>
      {scored && <span key={`f${scored}`} className="sb-flash" aria-hidden="true" />}
      {scored && <span key={`p${scored}`} className="sb-plus" aria-hidden="true">+1</span>}
    </div>
  );
}

/** Broadcast-style match scoreboard with animated score changes. */
export function Scoreboard({ rally }: { rally: RallySnapshot }) {
  const active = rally.phase !== 'idle';
  const turn = turnSide(rally.phase);
  const badge = active && rally.phase !== 'game-over' ? matchBadge(rally.playerScore, rally.opponentScore) : null;
  const showRally = active && rally.rallyHits >= 3 && rally.phase !== 'point-over' && rally.phase !== 'game-over';
  return (
    <div className="sb" aria-label={`Score: you ${rally.playerScore}, house ${rally.opponentScore}`}>
      <div className="sb-main">
        <div className="sb-team sb-you">
          <span className={`sb-turn${turn === 'player' ? ' on' : ''}`} />
          <span className="sb-name">You</span>
        </div>
        <ScorePanel side="player" score={rally.playerScore} point={rally.lastPoint} />
        <ScorePanel side="opponent" score={rally.opponentScore} point={rally.lastPoint} />
        <div className="sb-team sb-house">
          <span className="sb-name">House</span>
          <span className={`sb-turn${turn === 'opponent' ? ' on' : ''}`} />
        </div>
      </div>
      <div className="sb-sub">
        {badge && <span key={badge.text + badge.side} className={`sb-chip sb-badge ${badge.side}`}>{badge.text}</span>}
        {showRally && <span key={rally.rallyHits} className="sb-chip sb-rally">Rally ×{rally.rallyHits}</span>}
      </div>
    </div>
  );
}
