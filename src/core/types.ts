export type GameMode = 'endless' | 'sprint' | 'daily';

export type DeathCause = 'trail' | 'wall' | 'hazard' | 'timeout';

export interface RunResult {
  mode: GameMode;
  score: number;
  time: number;
  distance: number;
  bestCombo: number;
  grazes: number;
  cores: number;
  cause: DeathCause;
  isNewBest: boolean;
  seed: number;
}

export interface RunOptions {
  mode: GameMode;
  seed: number;
}
