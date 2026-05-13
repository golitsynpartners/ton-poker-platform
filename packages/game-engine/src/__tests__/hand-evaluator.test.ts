import { evaluateBestHand, determineWinners } from '../hand-evaluator';
import { Card } from '../deck';

function c(str: string): Card {
  return { rank: str[0] as any, suit: str[1] as any };
}

describe('Hand Evaluator', () => {
  it('detects royal flush', () => {
    const hole = [c('AS'), c('KS')];
    const community = [c('QS'), c('JS'), c('TS'), c('2H'), c('3D')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('royal_flush');
  });

  it('detects straight flush', () => {
    const hole = [c('9S'), c('8S')];
    const community = [c('7S'), c('6S'), c('5S'), c('2H'), c('3D')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('straight_flush');
  });

  it('detects four of a kind', () => {
    const hole = [c('AS'), c('AH')];
    const community = [c('AD'), c('AC'), c('2H'), c('3D'), c('4S')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('four_of_a_kind');
  });

  it('detects full house', () => {
    const hole = [c('AS'), c('AH')];
    const community = [c('AD'), c('KS'), c('KH'), c('2D'), c('5C')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('full_house');
  });

  it('detects flush', () => {
    const hole = [c('AS'), c('TS')];
    const community = [c('7S'), c('4S'), c('2S'), c('KH'), c('3D')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('flush');
  });

  it('detects straight', () => {
    const hole = [c('AS'), c('2H')];
    const community = [c('3D'), c('4C'), c('5S'), c('KH'), c('9D')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('straight');
  });

  it('detects wheel straight (A-2-3-4-5)', () => {
    const hole = [c('AS'), c('2H')];
    const community = [c('3D'), c('4C'), c('5S'), c('KH'), c('JD')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('straight');
  });

  it('detects one pair', () => {
    const hole = [c('AS'), c('AH')];
    const community = [c('2D'), c('3C'), c('4S'), c('7H'), c('9D')];
    const result = evaluateBestHand(hole, community);
    expect(result.rank).toBe('one_pair');
  });

  it('picks the winner correctly', () => {
    const players = [
      { userId: 'alice', holeCards: [c('AS'), c('KS')] },
      { userId: 'bob',   holeCards: [c('2H'), c('3D')] },
    ];
    const community = [c('QS'), c('JS'), c('TS'), c('4H'), c('5C')];
    const results = determineWinners(players, community);
    const alice = results.find(r => r.userId === 'alice')!;
    const bob   = results.find(r => r.userId === 'bob')!;
    expect(alice.isWinner).toBe(true);
    expect(bob.isWinner).toBe(false);
  });

  it('handles split pot correctly', () => {
    // Both players make same straight with community
    const players = [
      { userId: 'alice', holeCards: [c('2H'), c('3D')] },
      { userId: 'bob',   holeCards: [c('2S'), c('3C')] },
    ];
    const community = [c('4H'), c('5D'), c('6S'), c('KH'), c('QD')];
    const results = determineWinners(players, community);
    expect(results.every(r => r.isWinner)).toBe(true);
  });

  it('higher score beats lower score', () => {
    const highPair = evaluateBestHand([c('AS'), c('AH')], [c('2D'), c('3C'), c('4S'), c('7H'), c('9D')]);
    const lowPair  = evaluateBestHand([c('2S'), c('2H')], [c('3D'), c('4C'), c('5S'), c('7H'), c('9D')]);
    expect(highPair.score).toBeGreaterThan(lowPair.score);
  });
});
