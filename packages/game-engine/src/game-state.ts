import { Card } from './deck';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type PlayerActionType = 'fold' | 'check' | 'call' | 'raise' | 'all_in';

export interface PlayerState {
  userId: string;
  seatNumber: number;
  stack: number;          // current chips
  bet: number;            // chips bet in current street
  totalBetThisHand: number;
  holeCards: Card[];      // server-only until showdown
  isFolded: boolean;
  isAllIn: boolean;
  isActive: boolean;      // sitting in (not sitting out)
  isConnected: boolean;
  timeBank: number;       // remaining time bank seconds
}

export interface Pot {
  amount: number;
  eligiblePlayers: string[]; // userIds eligible to win this pot
}

export interface HandState {
  handId: string;
  tableId: string;
  handNumber: number;
  street: Street;
  deck: Card[];
  communityCards: Card[];
  players: Map<string, PlayerState>;  // userId → state
  seatOrder: string[];                // userId in seat order
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentActorIndex: number;
  pots: Pot[];
  currentBet: number;                 // highest bet on the street
  minRaise: number;
  actionCount: number;                // actions taken this street (for folding to uncontested)
  deckSeed: string;
  deckHash: string;
  startedAt: Date;
  rakeConfig: { rakePct: number; rakeCap: number; clubSharePct: number };
}

export interface TableState {
  tableId: string;
  clubId: string;
  status: 'waiting' | 'active' | 'paused';
  currentHand: HandState | null;
  seats: Map<number, PlayerState>;    // seat# → player
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxSeats: number;
  actionTimeoutSecs: number;
  handNumber: number;
}

/**
 * Builds the initial hand state from table state.
 * Called at the start of each hand.
 */
export function buildHandState(
  table: TableState,
  deck: Card[],
  deckSeed: string,
  deckHash: string,
  handId: string
): HandState {
  const activePlayers = Array.from(table.seats.values())
    .filter(p => p.isActive && !p.isAllIn && p.stack > 0)
    .sort((a, b) => a.seatNumber - b.seatNumber);

  if (activePlayers.length < 2) throw new Error('Need at least 2 active players');

  const players = new Map<string, PlayerState>();
  for (const p of activePlayers) {
    players.set(p.userId, { ...p, bet: 0, totalBetThisHand: 0, isFolded: false, holeCards: [] });
  }

  const buttonIdx = table.handNumber % activePlayers.length;
  const buttonSeat = activePlayers[buttonIdx].seatNumber;
  const sbIdx = (buttonIdx + 1) % activePlayers.length;
  const bbIdx = (buttonIdx + 2) % activePlayers.length;

  return {
    handId,
    tableId: table.tableId,
    handNumber: table.handNumber + 1,
    street: 'preflop',
    deck: [...deck],
    communityCards: [],
    players,
    seatOrder: activePlayers.map(p => p.userId),
    buttonSeat,
    smallBlindSeat: activePlayers[sbIdx].seatNumber,
    bigBlindSeat: activePlayers[bbIdx].seatNumber,
    currentActorIndex: (bbIdx + 1) % activePlayers.length, // UTG acts first preflop
    pots: [{ amount: 0, eligiblePlayers: activePlayers.map(p => p.userId) }],
    currentBet: table.bigBlind,
    minRaise: table.bigBlind * 2,
    actionCount: 0,
    deckSeed,
    deckHash,
    startedAt: new Date(),
    rakeConfig: {
      rakePct: 0.05,
      rakeCap: 5 * table.bigBlind,
      clubSharePct: 0.60,
    },
  };
}

/**
 * Validates whether an action is legal given current hand state.
 * Server-side only — never trust client action validity.
 */
export function validateAction(
  hand: HandState,
  userId: string,
  action: PlayerActionType,
  amount: number
): { valid: boolean; reason?: string } {
  const player = hand.players.get(userId);
  if (!player) return { valid: false, reason: 'Player not in hand' };
  if (player.isFolded) return { valid: false, reason: 'Player already folded' };
  if (player.isAllIn) return { valid: false, reason: 'Player is all-in' };

  const currentActor = hand.seatOrder[hand.currentActorIndex];
  if (currentActor !== userId) return { valid: false, reason: 'Not your turn' };

  const callAmount = hand.currentBet - player.bet;

  switch (action) {
    case 'fold':
      return { valid: true };

    case 'check':
      if (callAmount > 0) return { valid: false, reason: `Must call ${callAmount} or fold` };
      return { valid: true };

    case 'call':
      if (callAmount <= 0) return { valid: false, reason: 'Nothing to call — check instead' };
      return { valid: true };

    case 'raise': {
      if (amount < hand.minRaise && amount < player.stack) {
        return { valid: false, reason: `Minimum raise is ${hand.minRaise}` };
      }
      if (amount > player.stack) return { valid: false, reason: 'Cannot raise more than your stack' };
      return { valid: true };
    }

    case 'all_in':
      return { valid: true };

    default:
      return { valid: false, reason: 'Unknown action' };
  }
}

/**
 * Apply a player action to hand state. Returns next state (immutable update).
 */
export function applyAction(
  hand: HandState,
  userId: string,
  action: PlayerActionType,
  amount: number
): HandState {
  const next = deepCloneHand(hand);
  const player = next.players.get(userId)!;

  switch (action) {
    case 'fold':
      player.isFolded = true;
      // Remove from all pots
      for (const pot of next.pots) {
        pot.eligiblePlayers = pot.eligiblePlayers.filter(id => id !== userId);
      }
      break;

    case 'check':
      break;

    case 'call': {
      const toCall = Math.min(next.currentBet - player.bet, player.stack);
      player.stack -= toCall;
      player.bet += toCall;
      player.totalBetThisHand += toCall;
      next.pots[next.pots.length - 1].amount += toCall;
      if (player.stack === 0) player.isAllIn = true;
      break;
    }

    case 'raise':
    case 'all_in': {
      const raiseAmount = action === 'all_in' ? player.stack : amount;
      const callPortion = next.currentBet - player.bet;
      const raisePortion = raiseAmount - callPortion;

      player.stack -= raiseAmount;
      player.bet += raiseAmount;
      player.totalBetThisHand += raiseAmount;
      next.pots[next.pots.length - 1].amount += raiseAmount;

      if (player.stack === 0) player.isAllIn = true;

      next.currentBet = player.bet;
      next.minRaise = next.currentBet + raisePortion;
      break;
    }
  }

  next.actionCount++;
  next.currentActorIndex = getNextActorIndex(next);

  return next;
}

function getNextActorIndex(hand: HandState): number {
  const activeCount = hand.seatOrder.filter(uid => {
    const p = hand.players.get(uid)!;
    return !p.isFolded && !p.isAllIn;
  }).length;

  if (activeCount <= 1) return -1; // street/hand over

  let idx = (hand.currentActorIndex + 1) % hand.seatOrder.length;
  let checked = 0;
  while (checked < hand.seatOrder.length) {
    const uid = hand.seatOrder[idx];
    const p = hand.players.get(uid)!;
    if (!p.isFolded && !p.isAllIn) return idx;
    idx = (idx + 1) % hand.seatOrder.length;
    checked++;
  }
  return -1;
}

function deepCloneHand(hand: HandState): HandState {
  return {
    ...hand,
    players: new Map(Array.from(hand.players.entries()).map(([k, v]) => [k, { ...v, holeCards: [...v.holeCards] }])),
    communityCards: [...hand.communityCards],
    pots: hand.pots.map(p => ({ ...p, eligiblePlayers: [...p.eligiblePlayers] })),
    deck: [...hand.deck],
    seatOrder: [...hand.seatOrder],
  };
}
