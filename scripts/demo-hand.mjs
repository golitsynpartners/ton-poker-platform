/**
 * Self-contained demo of the poker engine.
 * Runs with: node scripts/demo-hand.mjs
 * No database, no Redis, no dependencies needed.
 * Copies the core logic inline so it works immediately.
 */

import crypto from 'crypto';

// ─── Deck ────────────────────────────────────────────────────────────────────

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['S','H','D','C'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };

function buildDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit })));
}

function shuffleDeck(seed) {
  const seedBuffer = seed ?? crypto.randomBytes(32);
  const seedHex = seedBuffer.toString('hex');
  const deck = buildDeck();
  let counter = 0;

  const getRand = () => crypto.createHmac('sha256', seedBuffer).update(Buffer.from([counter++])).digest()[0];

  for (let i = deck.length - 1; i > 0; i--) {
    const maxValid = Math.floor(256 / (i + 1)) * (i + 1);
    let r;
    do { r = getRand(); } while (r >= maxValid);
    const j = r % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  const hash = crypto.createHash('sha256').update(seedHex).digest('hex');
  return { deck, seed: seedHex, hash };
}

function cardStr(c) {
  const suits = { S:'♠', H:'♥', D:'♦', C:'♣' };
  const red = ['H','D'].includes(c.suit);
  const rank = c.rank === 'T' ? '10' : c.rank;
  return `${rank}${suits[c.suit]}`;
}

// ─── Hand Evaluator ───────────────────────────────────────────────────────────

function getCombos(cards, k) {
  if (k === 0) return [[]];
  if (cards.length < k) return [];
  const [first, ...rest] = cards;
  return [...getCombos(rest, k - 1).map(c => [first, ...c]), ...getCombos(rest, k)];
}

function evaluate5(cards) {
  const vals = cards.map(c => RANK_VALUES[c.rank]).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const sorted = [...cards].sort((a,b) => RANK_VALUES[b.rank]-RANK_VALUES[a.rank]);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = (vals[0]-vals[4]===4 && new Set(vals).size===5) ||
    (vals[0]===14 && vals[1]===5 && vals[2]===4 && vals[3]===3 && vals[4]===2);

  const map = new Map();
  for (const v of vals) map.set(v, (map.get(v)??0)+1);
  const counts = [...map.entries()].map(([v,c])=>({v,c})).sort((a,b)=>b.c-a.c||b.v-a.v);

  const score = (base, ...tiebreakers) => base + tiebreakers.reduce((acc,v,i)=>acc+v*Math.pow(100,4-i),0);

  if (isFlush && isStraight) return { rank: vals[0]===14?'Royal Flush':'Straight Flush', score: score(8e6, vals[0]), sorted };
  if (counts[0].c===4) return { rank:'Four of a Kind', score: score(7e6, counts[0].v, counts[1].v), sorted };
  if (counts[0].c===3 && counts[1].c===2) return { rank:'Full House', score: score(6e6, counts[0].v, counts[1].v), sorted };
  if (isFlush) return { rank:'Flush', score: score(5e6, ...vals), sorted };
  if (isStraight) return { rank:'Straight', score: score(4e6, vals[0]), sorted };
  if (counts[0].c===3) return { rank:'Three of a Kind', score: score(3e6, counts[0].v, counts[1].v, counts[2].v), sorted };
  if (counts[0].c===2 && counts[1].c===2) return { rank:'Two Pair', score: score(2e6, counts[0].v, counts[1].v, counts[2].v), sorted };
  if (counts[0].c===2) return { rank:'One Pair', score: score(1e6, counts[0].v, ...counts.slice(1).map(c=>c.v)), sorted };
  return { rank:'High Card', score: score(0, ...vals), sorted };
}

function bestHand(hole, community) {
  const all = [...hole, ...community];
  return getCombos(all, 5).map(evaluate5).reduce((best, h) => h.score > best.score ? h : best);
}

// ─── Demo Game ────────────────────────────────────────────────────────────────

function runDemo() {
  console.log('\n' + '═'.repeat(60));
  console.log('  TON POKER PLATFORM — GAME ENGINE DEMO');
  console.log('═'.repeat(60));

  const { deck, seed, hash } = shuffleDeck();

  console.log(`\n🔐 Provably Fair:`);
  console.log(`   Deck hash (committed): ${hash.slice(0,32)}...`);
  console.log(`   (Seed revealed at showdown for verification)\n`);

  const players = [
    { name: 'Alice', stack: 100 },
    { name: 'Bob',   stack: 100 },
    { name: 'Carol', stack: 100 },
  ];

  // Deal 2 hole cards each
  let cardIdx = 0;
  for (const p of players) {
    p.hole = [deck[cardIdx++], deck[cardIdx++]];
  }

  // Community: burn 1, flop 3, burn 1, turn 1, burn 1, river 1
  const community = [];
  cardIdx++; // burn
  community.push(deck[cardIdx++], deck[cardIdx++], deck[cardIdx++]); // flop
  cardIdx++; // burn
  community.push(deck[cardIdx++]); // turn
  cardIdx++; // burn
  community.push(deck[cardIdx++]); // river

  // ─── Preflop ──────────────────────────────────────────────────────────────
  console.log('PREFLOP');
  console.log('───────');
  for (const p of players) {
    console.log(`  ${p.name.padEnd(6)}: ${p.hole.map(cardStr).join(' ')}`);
  }

  const sb = 0.5, bb = 1;
  players[0].stack -= sb; // small blind
  players[1].stack -= bb; // big blind
  let pot = sb + bb;
  console.log(`\n  Blinds posted — Pot: ${pot} TON`);

  // Simulate simple action: everyone calls
  for (const p of players) {
    const toCall = bb - (p === players[0] ? sb : p === players[1] ? bb : 0);
    if (toCall > 0) {
      p.stack -= toCall;
      pot += toCall;
      console.log(`  ${p.name} calls ${toCall}`);
    }
  }
  console.log(`  Pot after preflop: ${pot} TON`);

  // ─── Flop ─────────────────────────────────────────────────────────────────
  console.log(`\nFLOP: ${community.slice(0,3).map(cardStr).join('  ')}`);
  console.log('─'.repeat(30));

  // Simulate: Alice bets 2, Bob folds, Carol calls
  const bet = 2;
  players[0].stack -= bet; pot += bet;
  console.log(`  Alice bets ${bet}`);
  console.log(`  Bob folds`);
  players[2].stack -= bet; pot += bet;
  console.log(`  Carol calls ${bet}`);
  console.log(`  Pot: ${pot} TON`);

  // ─── Turn ─────────────────────────────────────────────────────────────────
  console.log(`\nTURN: ${cardStr(community[3])}`);
  console.log('─'.repeat(30));
  console.log(`  Alice checks`);
  console.log(`  Carol checks`);

  // ─── River ────────────────────────────────────────────────────────────────
  console.log(`\nRIVER: ${cardStr(community[4])}`);
  console.log('─'.repeat(30));
  console.log(`  Alice bets 5`);
  players[0].stack -= 5; pot += 5;
  console.log(`  Carol calls 5`);
  players[2].stack -= 5; pot += 5;
  console.log(`  Pot: ${pot} TON`);

  // ─── Showdown ─────────────────────────────────────────────────────────────
  console.log(`\nSHOWDOWN`);
  console.log('─'.repeat(30));
  console.log(`  Community: ${community.map(cardStr).join('  ')}\n`);

  const contenders = [players[0], players[2]]; // Bob folded
  const results = contenders.map(p => {
    const hand = bestHand(p.hole, community);
    return { ...p, hand };
  });

  for (const r of results) {
    console.log(`  ${r.name.padEnd(6)}: ${r.hole.map(cardStr).join(' ')} → ${r.hand.rank}`);
  }

  // ─── Rake + Winner ────────────────────────────────────────────────────────
  const rakePct = 0.05;
  const rake = Math.min(pot * rakePct, 5);
  const clubRake = rake * 0.6;
  const platformRake = rake * 0.4;
  const potAfterRake = pot - rake;

  const winner = results.reduce((best, r) => r.hand.score > best.hand.score ? r : best);
  winner.stack += potAfterRake;

  console.log(`\n  Pot: ${pot} TON`);
  console.log(`  Rake: ${rake.toFixed(4)} TON (club: ${clubRake.toFixed(4)}, platform: ${platformRake.toFixed(4)})`);
  console.log(`  🏆 ${winner.name} wins ${potAfterRake.toFixed(4)} TON with ${winner.hand.rank}!`);

  console.log(`\nFINAL STACKS`);
  console.log('─'.repeat(30));
  for (const p of players) {
    const profit = p.stack - 100;
    const sign = profit >= 0 ? '+' : '';
    console.log(`  ${p.name.padEnd(6)}: ${p.stack.toFixed(2)} TON  (${sign}${profit.toFixed(2)})`);
  }

  // ─── Fairness Proof ───────────────────────────────────────────────────────
  console.log(`\n🔐 Fairness Verification:`);
  console.log(`   Seed: ${seed.slice(0,32)}...`);
  const verify = crypto.createHash('sha256').update(seed).digest('hex');
  console.log(`   Hash matches: ${verify === hash ? '✅ YES' : '❌ NO'}`);
  console.log(`   (Anyone can verify: SHA256(seed) === committed hash)`);

  console.log('\n' + '═'.repeat(60) + '\n');
}

runDemo();
