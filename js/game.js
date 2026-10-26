// Pure Kniffel rules shared by host and guests. No DOM, no network.
// The host is the only one that calls applyAction; guests just render the state it sends.

export const UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
export const LOWER = ['threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight', 'kniffel', 'chance'];
export const CATEGORIES = [...UPPER, ...LOWER];

export const DICE_COUNT = 5;
export const ROLLS_PER_TURN = 3;
export const MAX_PLAYERS = 6;
export const BONUS_THRESHOLD = 63;
export const BONUS = 35;
export const FIXED_SCORES = { fullHouse: 25, smallStraight: 30, largeStraight: 40, kniffel: 50 };

export class GameError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const sum = (dice) => dice.reduce((a, b) => a + b, 0);

function faceCounts(dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) counts[d]++;
  return counts;
}

function hasRun(dice, length) {
  const faces = new Set(dice);
  for (let start = 1; start + length - 1 <= 6; start++) {
    let run = true;
    for (let v = start; v < start + length; v++) {
      if (!faces.has(v)) { run = false; break; }
    }
    if (run) return true;
  }
  return false;
}

export function scoreFor(cat, dice) {
  const counts = faceCounts(dice);
  const upperIndex = UPPER.indexOf(cat);
  if (upperIndex >= 0) return counts[upperIndex + 1] * (upperIndex + 1);

  const most = Math.max(...counts);
  switch (cat) {
    case 'threeKind': return most >= 3 ? sum(dice) : 0;
    case 'fourKind': return most >= 4 ? sum(dice) : 0;
    case 'fullHouse': return counts.includes(3) && counts.includes(2) ? FIXED_SCORES.fullHouse : 0;
    case 'smallStraight': return hasRun(dice, 4) ? FIXED_SCORES.smallStraight : 0;
    case 'largeStraight': return hasRun(dice, 5) ? FIXED_SCORES.largeStraight : 0;
    case 'kniffel': return most === 5 ? FIXED_SCORES.kniffel : 0;
    case 'chance': return sum(dice);
    default: throw new GameError('bad-category');
  }
}

export function totals(scores) {
  const upper = UPPER.reduce((s, k) => s + (scores[k] ?? 0), 0);
  const lower = LOWER.reduce((s, k) => s + (scores[k] ?? 0), 0);
  const bonus = upper >= BONUS_THRESHOLD ? BONUS : 0;
  return { upper, bonus, lower, total: upper + bonus + lower };
}

export function filledCount(scores) {
  return CATEGORIES.filter((k) => scores[k] != null).length;
}

export function currentRound(state) {
  const player = state.players[state.turn];
  return player ? Math.min(CATEGORIES.length, filledCount(player.scores) + 1) : 1;
}

export function ranking(state) {
  return state.players
    .map((p) => ({ ...p, ...totals(p.scores) }))
    .sort((a, b) => b.total - a.total);
}

export function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// Uniform 1–6 from the platform CSPRNG, rejecting the top sliver of the range to avoid modulo bias.
export function randomDie() {
  const buf = new Uint32Array(1);
  const limit = 2 ** 32 - (2 ** 32 % 6);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return (buf[0] % 6) + 1;
}

export function newGame(hostId, hostName) {
  return {
    phase: 'lobby',
    hostId,
    players: [{ id: hostId, name: cleanName(hostName) || 'Host', connected: true, scores: {} }],
    starter: 0,
    turn: 0,
    dice: [6, 6, 6, 6, 6],
    held: [false, false, false, false, false],
    rolls: 0,
    rollSeq: 0,
    last: null,
  };
}

export function addPlayer(state, id, name) {
  const s = structuredClone(state);
  const existing = s.players.find((p) => p.id === id);
  if (existing) {
    existing.connected = true;
    if (s.phase === 'lobby' && cleanName(name)) existing.name = cleanName(name);
    return s;
  }
  if (s.phase !== 'lobby') throw new GameError('already-started');
  if (s.players.length >= MAX_PLAYERS) throw new GameError('full');
  s.players.push({ id, name: cleanName(name) || `Player ${s.players.length + 1}`, connected: true, scores: {} });
  return s;
}

// A player dropping out of the lobby simply leaves; mid-game we keep their seat so they can rejoin.
export function dropPlayer(state, id) {
  const s = structuredClone(state);
  if (s.phase === 'lobby' && id !== s.hostId) {
    s.players = s.players.filter((p) => p.id !== id);
  } else {
    const player = s.players.find((p) => p.id === id);
    if (player) player.connected = false;
  }
  return s;
}

function resetTurn(s) {
  s.rolls = 0;
  s.held = [false, false, false, false, false];
}

export function applyAction(state, actorId, action, rollDie = randomDie) {
  const s = structuredClone(state);
  const current = s.players[s.turn];
  const isMyTurn = s.phase === 'playing' && current?.id === actorId;

  switch (action?.type) {
    case 'start': {
      if (actorId !== s.hostId) throw new GameError('not-host');
      if (s.phase === 'playing') throw new GameError('already-started');
      if (s.phase === 'finished') s.starter = (s.starter + 1) % s.players.length;
      for (const p of s.players) p.scores = {};
      s.phase = 'playing';
      s.turn = s.starter % s.players.length;
      s.last = null;
      resetTurn(s);
      return s;
    }

    case 'roll': {
      if (!isMyTurn) throw new GameError('not-your-turn');
      if (s.rolls >= ROLLS_PER_TURN) throw new GameError('no-rolls-left');
      s.dice = s.dice.map((d, i) => (s.rolls > 0 && s.held[i] ? d : rollDie()));
      s.rolls++;
      s.rollSeq++;
      return s;
    }

    case 'hold': {
      if (!isMyTurn) throw new GameError('not-your-turn');
      const i = action.index;
      if (!Number.isInteger(i) || i < 0 || i >= DICE_COUNT) throw new GameError('bad-die');
      if (s.rolls === 0 || s.rolls >= ROLLS_PER_TURN) throw new GameError('cannot-hold');
      s.held[i] = !s.held[i];
      return s;
    }

    case 'score': {
      if (!isMyTurn) throw new GameError('not-your-turn');
      if (!CATEGORIES.includes(action.cat)) throw new GameError('bad-category');
      if (s.rolls === 0) throw new GameError('roll-first');
      if (current.scores[action.cat] != null) throw new GameError('already-scored');
      const value = scoreFor(action.cat, s.dice);
      current.scores[action.cat] = value;
      s.last = { pid: current.id, cat: action.cat, value, seq: (s.last?.seq ?? 0) + 1 };
      resetTurn(s);
      if (s.players.every((p) => filledCount(p.scores) === CATEGORIES.length)) {
        s.phase = 'finished';
      } else {
        s.turn = (s.turn + 1) % s.players.length;
      }
      return s;
    }

    default:
      throw new GameError('bad-action');
  }
}
