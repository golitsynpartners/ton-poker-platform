import { Card, Rank, Suit } from './deck';

export type HandRank =
  | 'high_card'
  | 'one_pair'
  | 'two_pair'
  | 'three_of_a_kind'
  | 'straight'
  | 'flush'
  | 'full_house'
  | 'four_of_a_kind'
  | 'straight_flush'
  | 'royal_flush';

export interface EvaluatedHand {
  rank: HandRank;
  score: number;      // numeric score for comparison (higher = better)
  bestCards: Card[];  // the 5 cards making the best hand
  description: string;
}

const RANK_VALUES: Record<Rank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

const HAND_RANK_SCORES: Record<HandRank, number> = {
  high_card: 0,
  one_pair: 1_000_000,
  two_pair: 2_000_000,
  three_of_a_kind: 3_000_000,
  straight: 4_000_000,
  flush: 5_000_000,
  full_house: 6_000_000,
  four_of_a_kind: 7_000_000,
  straight_flush: 8_000_000,
  royal_flush: 9_000_000,
};

function getCombinations(cards: Card[], k: number): Card[][] {
  if (k === 0) return [[]];
  if (cards.length < k) return [];
  const [first, ...rest] = cards;
  const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = getCombinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function evaluate5Cards(cards: Card[]): EvaluatedHand {
  const values = cards.map(c => RANK_VALUES[c.rank]).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);

  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(values);
  const counts = countRanks(values);

  // Straight flush / Royal flush
  if (isFlush && isStraight) {
    const rank = values[0] === 14 ? 'royal_flush' : 'straight_flush';
    return { rank, score: HAND_RANK_SCORES[rank] + values[0], bestCards: sorted, description: `${rank.replace('_', ' ')} ${topRankName(sorted[0])} high` };
  }

  const quads = counts.filter(c => c.count === 4);
  if (quads.length) {
    const kicker = counts.find(c => c.count !== 4)!;
    const score = HAND_RANK_SCORES.four_of_a_kind + quads[0].value * 1000 + kicker.value;
    return { rank: 'four_of_a_kind', score, bestCards: sorted, description: `Four of a kind ${rankName(quads[0].value)}s` };
  }

  const trips = counts.filter(c => c.count === 3);
  const pairs = counts.filter(c => c.count === 2);

  if (trips.length && pairs.length) {
    const score = HAND_RANK_SCORES.full_house + trips[0].value * 100 + pairs[0].value;
    return { rank: 'full_house', score, bestCards: sorted, description: `Full house ${rankName(trips[0].value)}s full of ${rankName(pairs[0].value)}s` };
  }

  if (isFlush) {
    const score = HAND_RANK_SCORES.flush + values.reduce((acc, v, i) => acc + v * Math.pow(15, 4 - i), 0);
    return { rank: 'flush', score, bestCards: sorted, description: `Flush ${topRankName(sorted[0])} high` };
  }

  if (isStraight) {
    return { rank: 'straight', score: HAND_RANK_SCORES.straight + values[0], bestCards: sorted, description: `Straight ${topRankName(sorted[0])} high` };
  }

  if (trips.length) {
    const kickers = counts.filter(c => c.count === 1).slice(0, 2);
    const score = HAND_RANK_SCORES.three_of_a_kind + trips[0].value * 10000 + kickers[0]?.value * 100 + (kickers[1]?.value ?? 0);
    return { rank: 'three_of_a_kind', score, bestCards: sorted, description: `Three of a kind ${rankName(trips[0].value)}s` };
  }

  if (pairs.length >= 2) {
    const topPairs = pairs.slice(0, 2);
    const kicker = counts.find(c => c.count === 1)!;
    const score = HAND_RANK_SCORES.two_pair + topPairs[0].value * 10000 + topPairs[1].value * 100 + (kicker?.value ?? 0);
    return { rank: 'two_pair', score, bestCards: sorted, description: `Two pair ${rankName(topPairs[0].value)}s and ${rankName(topPairs[1].value)}s` };
  }

  if (pairs.length === 1) {
    const kickers = counts.filter(c => c.count === 1).slice(0, 3);
    const score = HAND_RANK_SCORES.one_pair + pairs[0].value * 100000 + kickers.reduce((acc, k, i) => acc + k.value * Math.pow(15, 2 - i), 0);
    return { rank: 'one_pair', score, bestCards: sorted, description: `One pair ${rankName(pairs[0].value)}s` };
  }

  const score = HAND_RANK_SCORES.high_card + values.reduce((acc, v, i) => acc + v * Math.pow(15, 4 - i), 0);
  return { rank: 'high_card', score, bestCards: sorted, description: `High card ${topRankName(sorted[0])}` };
}

function checkStraight(sortedValues: number[]): boolean {
  // Normal straight
  if (sortedValues[0] - sortedValues[4] === 4 && new Set(sortedValues).size === 5) return true;
  // Wheel: A-2-3-4-5
  if (sortedValues[0] === 14 && sortedValues[1] === 5 && sortedValues[2] === 4 && sortedValues[3] === 3 && sortedValues[4] === 2) return true;
  return false;
}

function countRanks(values: number[]): Array<{ value: number; count: number }> {
  const map = new Map<number, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);
}

function rankName(v: number): string {
  const names: Record<number, string> = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
  return names[v] ?? String(v);
}

function topRankName(card: Card): string {
  return rankName(RANK_VALUES[card.rank]);
}

/**
 * Evaluate best 5-card hand from 7 cards (2 hole + 5 community).
 */
export function evaluateBestHand(holeCards: Card[], communityCards: Card[]): EvaluatedHand {
  const all = [...holeCards, ...communityCards];
  const combos = getCombinations(all, 5);

  let best: EvaluatedHand | null = null;
  for (const combo of combos) {
    const evaluated = evaluate5Cards(combo);
    if (!best || evaluated.score > best.score) {
      best = evaluated;
    }
  }

  return best!;
}

/**
 * Determine winners from a list of players still in hand.
 * Handles split pots.
 */
export function determineWinners(
  players: Array<{ userId: string; holeCards: Card[] }>,
  communityCards: Card[]
): Array<{ userId: string; hand: EvaluatedHand; isWinner: boolean }> {
  const evaluated = players.map(p => ({
    userId: p.userId,
    hand: evaluateBestHand(p.holeCards, communityCards),
    isWinner: false,
  }));

  const maxScore = Math.max(...evaluated.map(e => e.hand.score));
  return evaluated.map(e => ({ ...e, isWinner: e.hand.score === maxScore }));
}
