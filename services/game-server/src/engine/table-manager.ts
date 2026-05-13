import { Server as SocketServer, Socket } from 'socket.io';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { shuffleDeck } from '../../../../packages/game-engine/src/deck';
import {
  TableState, HandState, PlayerState,
  buildHandState, validateAction, applyAction
} from '../../../../packages/game-engine/src/game-state';
import { evaluateBestHand, determineWinners } from '../../../../packages/game-engine/src/hand-evaluator';
import { EVENTS, C2S_PlayerAction } from '../socket/events';

const RECONNECT_WINDOW_MS = 30_000;
const NEXT_HAND_DELAY_MS = 5_000;
const ACTION_TIMEOUT_MS = 20_000;

/**
 * TableManager is the authoritative game controller.
 * One instance per game-server process, manages all active tables.
 * State is backed by Redis for horizontal scaling and crash recovery.
 */
export class TableManager {
  private tables = new Map<string, TableState>();
  private actionTimers = new Map<string, NodeJS.Timeout>(); // tableId → timer
  private io: SocketServer;
  private redis: ReturnType<typeof createClient>;
  private db: any; // PostgreSQL pool

  constructor(io: SocketServer, redis: ReturnType<typeof createClient>, db: any) {
    this.io = io;
    this.redis = redis;
    this.db = db;
  }

  async loadTable(tableId: string): Promise<TableState | null> {
    // Try in-memory first
    if (this.tables.has(tableId)) return this.tables.get(tableId)!;

    // Try Redis (for crash recovery)
    const cached = await this.redis.get(`table:${tableId}`);
    if (cached) {
      const state = JSON.parse(cached) as TableState;
      state.seats = new Map(Object.entries(state.seats as any));
      if (state.currentHand) {
        state.currentHand.players = new Map(Object.entries(state.currentHand.players as any));
      }
      this.tables.set(tableId, state);
      return state;
    }

    // Load from DB
    const result = await this.db.query(
      'SELECT * FROM poker_tables WHERE id = $1 AND status != $2',
      [tableId, 'closed']
    );
    if (!result.rows.length) return null;

    const row = result.rows[0];
    const table: TableState = {
      tableId,
      clubId: row.club_id,
      status: 'waiting',
      currentHand: null,
      seats: new Map(),
      smallBlind: parseFloat(row.small_blind),
      bigBlind: parseFloat(row.big_blind),
      ante: parseFloat(row.ante),
      minBuyIn: parseFloat(row.min_buy_in),
      maxBuyIn: parseFloat(row.max_buy_in),
      maxSeats: row.max_seats,
      actionTimeoutSecs: row.action_timeout,
      handNumber: 0,
    };

    this.tables.set(tableId, table);
    await this.persistTable(table);
    return table;
  }

  async handleJoinTable(socket: Socket, tableId: string, userId: string, buyIn: number, seatPreference?: number): Promise<void> {
    const table = await this.loadTable(tableId);
    if (!table) return socket.emit(EVENTS.ERROR, { code: 'TABLE_NOT_FOUND', message: 'Table not found' });

    if (table.seats.size >= table.maxSeats) {
      return socket.emit(EVENTS.ERROR, { code: 'TABLE_FULL', message: 'Table is full' });
    }

    if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
      return socket.emit(EVENTS.ERROR, { code: 'INVALID_BUY_IN', message: `Buy-in must be ${table.minBuyIn}–${table.maxBuyIn}` });
    }

    // Verify and lock balance via DB (never trust client stack amount)
    const balanceResult = await this.db.query(`
      SELECT balance_ton - locked_ton AS available
      FROM user_balances
      WHERE user_id = $1 AND club_id = $2
    `, [userId, table.clubId]);

    const available = parseFloat(balanceResult.rows[0]?.available ?? '0');
    if (available < buyIn) {
      return socket.emit(EVENTS.ERROR, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' });
    }

    // Lock chips (atomic DB operation)
    await this.db.query(`
      UPDATE user_balances
      SET locked_ton = locked_ton + $1, updated_at = NOW()
      WHERE user_id = $2 AND club_id = $3
    `, [buyIn, userId, table.clubId]);

    // Assign seat
    const takenSeats = new Set(Array.from(table.seats.keys()));
    let seatNumber = seatPreference && !takenSeats.has(seatPreference) ? seatPreference : null;
    if (!seatNumber) {
      for (let i = 1; i <= table.maxSeats; i++) {
        if (!takenSeats.has(i)) { seatNumber = i; break; }
      }
    }

    const userResult = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    const playerState: PlayerState = {
      userId,
      seatNumber: seatNumber!,
      stack: buyIn,
      bet: 0,
      totalBetThisHand: 0,
      holeCards: [],
      isFolded: false,
      isAllIn: false,
      isActive: true,
      isConnected: true,
      timeBank: 30,
    };

    table.seats.set(seatNumber!, playerState);

    // Join socket room for this table
    socket.join(`table:${tableId}`);
    // Join private room for hole cards
    socket.join(`player:${userId}`);

    await this.persistTable(table);

    // Notify all at table
    this.io.to(`table:${tableId}`).emit(EVENTS.PLAYER_JOINED, {
      tableId,
      userId,
      username: user.telegram_username ?? user.telegram_first_name,
      seatNumber: seatNumber!,
      stack: buyIn,
    });

    // Send full table state to joining player
    socket.emit(EVENTS.TABLE_STATE, this.serializeTableState(table));

    // Start hand if enough players
    if (table.seats.size >= 2 && table.status === 'waiting') {
      setTimeout(() => this.startHand(table), 2000);
    }
  }

  async startHand(table: TableState): Promise<void> {
    if (table.status === 'paused') return;

    const activePlayers = Array.from(table.seats.values()).filter(p => p.isActive && p.stack > 0);
    if (activePlayers.length < 2) {
      table.status = 'waiting';
      await this.persistTable(table);
      return;
    }

    const { deck, seed, hash } = shuffleDeck();
    const handId = uuidv4();

    // Persist hand to DB before dealing (seed committed via hash)
    await this.db.query(`
      INSERT INTO hands (id, table_id, hand_number, status, deck_seed, deck_hash, button_seat)
      VALUES ($1, $2, $3, 'preflop', $4, $5, $6)
    `, [handId, table.tableId, table.handNumber + 1, seed, hash, activePlayers[0].seatNumber]);

    table.handNumber++;
    table.status = 'active';

    const hand = buildHandState(table, deck, seed, hash, handId);
    table.currentHand = hand;

    // Deal hole cards — post blinds
    await this.postBlinds(hand, table);

    // Deal 2 cards to each player
    let cardIdx = 0;
    for (const userId of hand.seatOrder) {
      const player = hand.players.get(userId)!;
      player.holeCards = [hand.deck[cardIdx++], hand.deck[cardIdx++]];
    }

    await this.persistTable(table);

    // Notify hand started (no hole cards in broadcast)
    this.io.to(`table:${table.tableId}`).emit(EVENTS.HAND_STARTED, {
      handId,
      handNumber: hand.handNumber,
      buttonSeat: hand.buttonSeat,
      smallBlindSeat: hand.smallBlindSeat,
      bigBlindSeat: hand.bigBlindSeat,
      deckHash: hash,
      players: Array.from(hand.players.values()).map(p => ({
        userId: p.userId,
        seatNumber: p.seatNumber,
        stack: p.stack,
      })),
    });

    // Send hole cards privately to each player
    for (const [userId, player] of hand.players) {
      this.io.to(`player:${userId}`).emit(EVENTS.HOLE_CARDS, {
        handId,
        cards: player.holeCards.map(c => `${c.rank}${c.suit}`) as [string, string],
      });
    }

    // Prompt first actor
    this.promptAction(hand, table);
  }

  async handlePlayerAction(socket: Socket, userId: string, payload: C2S_PlayerAction): Promise<void> {
    const table = this.tables.get(payload.tableId);
    if (!table?.currentHand) {
      return socket.emit(EVENTS.ERROR, { code: 'NO_ACTIVE_HAND', message: 'No active hand' });
    }

    const hand = table.currentHand;

    if (hand.handId !== payload.handId) {
      return socket.emit(EVENTS.ERROR, { code: 'WRONG_HAND', message: 'Hand ID mismatch' });
    }

    const validation = validateAction(hand, userId, payload.action, payload.amount);
    if (!validation.valid) {
      return socket.emit(EVENTS.ERROR, { code: 'INVALID_ACTION', message: validation.reason });
    }

    // Clear action timer
    this.clearActionTimer(table.tableId);

    const updatedHand = applyAction(hand, userId, payload.action, payload.amount);
    table.currentHand = updatedHand;

    const player = updatedHand.players.get(userId)!;
    const potTotal = updatedHand.pots.reduce((s, p) => s + p.amount, 0);

    // Persist action to DB
    await this.db.query(`
      INSERT INTO hand_actions (hand_id, user_id, seat_number, street, action, amount, pot_before, sequence_num)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [hand.handId, userId, player.seatNumber, hand.street, payload.action, payload.amount, potTotal - payload.amount, hand.actionCount]);

    // Broadcast action to table
    this.io.to(`table:${table.tableId}`).emit(EVENTS.PLAYER_ACTED, {
      handId: hand.handId,
      userId,
      seatNumber: player.seatNumber,
      action: payload.action,
      amount: payload.amount,
      stackAfter: player.stack,
      potTotal,
      sequenceNum: updatedHand.actionCount,
    });

    await this.persistTable(table);
    await this.advanceHand(table, updatedHand);
  }

  private async advanceHand(table: TableState, hand: HandState): Promise<void> {
    const activePlayers = Array.from(hand.players.values()).filter(p => !p.isFolded && !p.isAllIn);
    const foldedAll = Array.from(hand.players.values()).filter(p => !p.isFolded);

    // Check if hand is over (all but one folded)
    if (foldedAll.length === 1) {
      await this.endHand(table, hand, true);
      return;
    }

    // Check if street is complete (everyone has acted, bets are equal)
    const allBetsEqual = activePlayers.every(p => p.bet === hand.currentBet);
    const streetComplete = hand.currentActorIndex === -1 || (allBetsEqual && hand.actionCount > 0);

    if (!streetComplete) {
      this.promptAction(hand, table);
      return;
    }

    // Advance to next street
    switch (hand.street) {
      case 'preflop': await this.dealFlop(table, hand); break;
      case 'flop':    await this.dealTurn(table, hand); break;
      case 'turn':    await this.dealRiver(table, hand); break;
      case 'river':   await this.endHand(table, hand, false); break;
    }
  }

  private async dealFlop(table: TableState, hand: HandState): Promise<void> {
    const flop = [hand.deck[52 - 3], hand.deck[52 - 4], hand.deck[52 - 5]]; // burn 1, deal 3
    hand.communityCards = [...flop];
    (hand as any).street = 'flop';
    this.resetStreetBetting(hand);
    await this.persistTable(table);
    this.io.to(`table:${table.tableId}`).emit(EVENTS.STREET_DEALT, {
      handId: hand.handId,
      street: 'flop',
      communityCards: hand.communityCards.map(c => `${c.rank}${c.suit}`),
      pots: hand.pots.map((p, i) => ({ amount: p.amount, label: i === 0 ? 'Main Pot' : `Side Pot ${i}` })),
    });
    this.promptAction(hand, table);
  }

  private async dealTurn(table: TableState, hand: HandState): Promise<void> {
    hand.communityCards.push(hand.deck[52 - 7]);
    (hand as any).street = 'turn';
    this.resetStreetBetting(hand);
    await this.persistTable(table);
    this.io.to(`table:${table.tableId}`).emit(EVENTS.STREET_DEALT, {
      handId: hand.handId,
      street: 'turn',
      communityCards: hand.communityCards.map(c => `${c.rank}${c.suit}`),
      pots: hand.pots.map((p, i) => ({ amount: p.amount, label: i === 0 ? 'Main Pot' : `Side Pot ${i}` })),
    });
    this.promptAction(hand, table);
  }

  private async dealRiver(table: TableState, hand: HandState): Promise<void> {
    hand.communityCards.push(hand.deck[52 - 9]);
    (hand as any).street = 'river';
    this.resetStreetBetting(hand);
    await this.persistTable(table);
    this.io.to(`table:${table.tableId}`).emit(EVENTS.STREET_DEALT, {
      handId: hand.handId,
      street: 'river',
      communityCards: hand.communityCards.map(c => `${c.rank}${c.suit}`),
      pots: hand.pots.map((p, i) => ({ amount: p.amount, label: i === 0 ? 'Main Pot' : `Side Pot ${i}` })),
    });
    this.promptAction(hand, table);
  }

  private async endHand(table: TableState, hand: HandState, singleWinner: boolean): Promise<void> {
    this.clearActionTimer(table.tableId);

    const activePlayers = Array.from(hand.players.values()).filter(p => !p.isFolded);
    const totalPot = hand.pots.reduce((s, p) => s + p.amount, 0);

    // Calculate rake
    const rakeAmount = Math.min(totalPot * hand.rakeConfig.rakePct, hand.rakeConfig.rakeCap);
    const potAfterRake = totalPot - rakeAmount;
    const clubRake = rakeAmount * hand.rakeConfig.clubSharePct;
    const platformRake = rakeAmount - clubRake;

    let winners: Array<{ userId: string; hand: any; isWinner: boolean }>;
    if (singleWinner) {
      winners = activePlayers.map(p => ({ userId: p.userId, hand: null, isWinner: true }));
    } else {
      winners = determineWinners(
        activePlayers.map(p => ({ userId: p.userId, holeCards: p.holeCards })),
        hand.communityCards
      );
    }

    const winnerList = winners.filter(w => w.isWinner);
    const sharePerWinner = potAfterRake / winnerList.length;

    // Update stacks
    const stackChanges: Array<{ userId: string; stackAfter: number }> = [];
    for (const [uid, player] of hand.players) {
      let stackAfter = player.stack;
      if (winnerList.find(w => w.userId === uid)) {
        stackAfter += sharePerWinner;
        player.stack = stackAfter;
      }
      stackChanges.push({ userId: uid, stackAfter });

      // Update seat stack in table
      const seat = Array.from(table.seats.values()).find(s => s.userId === uid);
      if (seat) seat.stack = stackAfter;
    }

    // Showdown reveal (not shown if one player wins without showdown)
    if (!singleWinner) {
      this.io.to(`table:${table.tableId}`).emit(EVENTS.SHOWDOWN, {
        handId: hand.handId,
        players: activePlayers.map(p => {
          const result = winners.find(w => w.userId === p.userId)!;
          return {
            userId: p.userId,
            seatNumber: p.seatNumber,
            holeCards: p.holeCards.map(c => `${c.rank}${c.suit}`) as [string, string],
            handDescription: result.hand?.description ?? '',
            isWinner: result.isWinner,
            amountWon: result.isWinner ? sharePerWinner : 0,
          };
        }),
        communityCards: hand.communityCards.map(c => `${c.rank}${c.suit}`),
        deckSeed: hand.deckSeed,  // reveal seed for fairness verification
        deckHash: hand.deckHash,
      });
    }

    // Distribute rake via ledger service
    await this.db.query(`
      UPDATE hands SET status = 'complete', ended_at = NOW(), pot_total = $1, rake_total = $2, rake_club = $3, rake_platform = $4
      WHERE id = $5
    `, [totalPot, rakeAmount, clubRake, platformRake, hand.handId]);

    this.io.to(`table:${table.tableId}`).emit(EVENTS.HAND_COMPLETE, {
      handId: hand.handId,
      winners: winnerList.map(w => ({
        userId: w.userId,
        amount: sharePerWinner,
        potLabel: 'Main Pot',
      })),
      rake: { total: rakeAmount, club: clubRake, platform: platformRake },
      stackChanges,
      nextHandIn: NEXT_HAND_DELAY_MS,
    });

    table.currentHand = null;
    await this.persistTable(table);

    // Schedule next hand
    setTimeout(() => this.startHand(table), NEXT_HAND_DELAY_MS);
  }

  private promptAction(hand: HandState, table: TableState): void {
    if (hand.currentActorIndex === -1) return;

    const userId = hand.seatOrder[hand.currentActorIndex];
    const player = hand.players.get(userId)!;
    const callAmount = hand.currentBet - player.bet;

    const availableActions: string[] = ['fold'];
    if (callAmount === 0) availableActions.push('check');
    else availableActions.push('call');
    if (player.stack > callAmount) availableActions.push('raise');
    availableActions.push('all_in');

    const payload = {
      handId: hand.handId,
      userId,
      seatNumber: player.seatNumber,
      timeoutSecs: table.actionTimeoutSecs,
      timeBankSecs: player.timeBank,
      availableActions,
      callAmount,
      minRaise: hand.minRaise,
      maxRaise: player.stack,
      currentPot: hand.pots.reduce((s, p) => s + p.amount, 0),
    };

    this.io.to(`table:${table.tableId}`).emit(EVENTS.ACTION_REQUIRED, payload);

    // Auto-fold on timeout
    this.clearActionTimer(table.tableId);
    const timer = setTimeout(async () => {
      await this.handlePlayerAction(
        null as any,
        userId,
        { tableId: table.tableId, handId: hand.handId, action: 'fold', amount: 0, sequenceNum: 0 }
      );
    }, (table.actionTimeoutSecs + player.timeBank) * 1000);

    this.actionTimers.set(table.tableId, timer);
  }

  private clearActionTimer(tableId: string): void {
    const timer = this.actionTimers.get(tableId);
    if (timer) { clearTimeout(timer); this.actionTimers.delete(tableId); }
  }

  private resetStreetBetting(hand: HandState): void {
    for (const player of hand.players.values()) {
      player.bet = 0;
    }
    (hand as any).currentBet = 0;
    (hand as any).minRaise = hand.deck.length > 0 ? /* big blind */ 0 : 0; // set per table
    (hand as any).actionCount = 0;
    // First to act post-flop: first active player left of button
    (hand as any).currentActorIndex = 0;
  }

  private async postBlinds(hand: HandState, table: TableState): Promise<void> {
    // Handled as part of preflop betting — SB and BB are forced bets
    const sbPlayer = Array.from(hand.players.values()).find(p => p.seatNumber === hand.smallBlindSeat)!;
    const bbPlayer = Array.from(hand.players.values()).find(p => p.seatNumber === hand.bigBlindSeat)!;

    sbPlayer.bet = Math.min(table.smallBlind, sbPlayer.stack);
    sbPlayer.stack -= sbPlayer.bet;
    sbPlayer.totalBetThisHand += sbPlayer.bet;

    bbPlayer.bet = Math.min(table.bigBlind, bbPlayer.stack);
    bbPlayer.stack -= bbPlayer.bet;
    bbPlayer.totalBetThisHand += bbPlayer.bet;

    hand.pots[0].amount = sbPlayer.bet + bbPlayer.bet;
  }

  private async persistTable(table: TableState): Promise<void> {
    const serialized = JSON.stringify({
      ...table,
      seats: Object.fromEntries(table.seats),
      currentHand: table.currentHand ? {
        ...table.currentHand,
        players: Object.fromEntries(table.currentHand.players),
      } : null,
    });
    await this.redis.setEx(`table:${table.tableId}`, 3600, serialized);
  }

  private serializeTableState(table: TableState) {
    return {
      tableId: table.tableId,
      status: table.status,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      handNumber: table.handNumber,
      seats: Array.from(table.seats.values()).map(p => ({
        seatNumber: p.seatNumber,
        userId: p.userId,
        stack: p.stack,
        isSittingOut: !p.isActive,
        isConnected: p.isConnected,
      })),
    };
  }
}
