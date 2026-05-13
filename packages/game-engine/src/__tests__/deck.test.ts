import crypto from 'crypto';
import { shuffleDeck, cardToString } from '../deck';

describe('Deck', () => {
  it('produces 52 unique cards', () => {
    const { deck } = shuffleDeck();
    expect(deck).toHaveLength(52);
    const strs = deck.map(cardToString);
    expect(new Set(strs).size).toBe(52);
  });

  it('is deterministic given the same seed', () => {
    const seed = crypto.randomBytes(32);
    const { deck: d1 } = shuffleDeck(seed);
    const { deck: d2 } = shuffleDeck(seed);
    expect(d1.map(cardToString)).toEqual(d2.map(cardToString));
  });

  it('produces different results for different seeds', () => {
    const { deck: d1 } = shuffleDeck();
    const { deck: d2 } = shuffleDeck();
    expect(d1.map(cardToString)).not.toEqual(d2.map(cardToString));
  });

  it('returns matching seed and hash', () => {
    const { seed, hash } = shuffleDeck();
    const expectedHash = crypto.createHash('sha256').update(seed).digest('hex');
    expect(hash).toBe(expectedHash);
  });
});
