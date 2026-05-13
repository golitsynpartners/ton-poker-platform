import crypto from 'crypto';

export type Suit = 'S' | 'H' | 'D' | 'C'; // Spades, Hearts, Diamonds, Clubs
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: Rank;
  suit: Suit;
}

const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Cryptographically secure Fisher-Yates shuffle.
 * Uses crypto.randomBytes for unbiased random index selection.
 *
 * Security: The seed is generated server-side and never sent to clients
 * until the hand is complete (provably fair commitment scheme).
 */
export function shuffleDeck(seed?: Buffer): { deck: Card[]; seed: string; hash: string } {
  const seedBuffer = seed ?? crypto.randomBytes(32);
  const seedHex = seedBuffer.toString('hex');

  // Deterministic PRNG from seed using HMAC-SHA256 counter mode
  const deck = buildDeck();
  let counter = 0;

  const getRandomBytes = (n: number): Buffer => {
    const result = crypto
      .createHmac('sha256', seedBuffer)
      .update(Buffer.from([counter++]))
      .digest();
    return result.subarray(0, n);
  };

  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    // Need random index in [0, i] without modulo bias
    const maxValid = Math.floor(256 / (i + 1)) * (i + 1);
    let randomByte: number;
    do {
      randomByte = getRandomBytes(1)[0];
    } while (randomByte >= maxValid);

    const j = randomByte % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  const hash = crypto.createHash('sha256').update(seedHex).digest('hex');

  return { deck, seed: seedHex, hash };
}

export function cardToString(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function parseCard(str: string): Card {
  return { rank: str[0] as Rank, suit: str[1] as Suit };
}
