/**
 * Canonical WebSocket event definitions.
 * Single source of truth — shared between server and client via @poker/shared package.
 *
 * SECURITY RULE: Client → Server events are COMMANDS (may be rejected).
 *                Server → Client events are FACTS (authoritative state).
 */

// ─── Client → Server (commands) ───────────────────────────────────────────────

export interface C2S_JoinTable {
  tableId: string;
  buyIn: number;         // in TON
  seatNumber?: number;   // optional seat preference
}

export interface C2S_LeaveTable {
  tableId: string;
}

export interface C2S_PlayerAction {
  tableId: string;
  handId: string;        // client must confirm which hand it's acting on
  action: 'fold' | 'check' | 'call' | 'raise' | 'all_in';
  amount: number;        // 0 for fold/check/call/all_in (server computes exact amount)
  sequenceNum: number;   // client action sequence, server validates monotonic
}

export interface C2S_SitOut {
  tableId: string;
  sitOut: boolean;
}

export interface C2S_AddChips {
  tableId: string;
  amount: number;
}

export interface C2S_ChatMessage {
  tableId: string;
  message: string;       // max 200 chars, sanitized server-side
}

// ─── Server → Client (authoritative state) ─────────────────────────────────

export interface S2C_TableState {
  tableId: string;
  seats: Array<{
    seatNumber: number;
    userId: string;
    username: string;
    avatarUrl?: string;
    stack: number;
    isSittingOut: boolean;
    isConnected: boolean;
  }>;
  status: 'waiting' | 'active' | 'paused';
  smallBlind: number;
  bigBlind: number;
  handNumber: number;
}

export interface S2C_HandStarted {
  handId: string;
  handNumber: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  deckHash: string;      // SHA256 commitment — revealed at hand end
  players: Array<{
    userId: string;
    seatNumber: number;
    stack: number;
  }>;
  yourCards: [string, string] | null; // only sent to the requesting player
}

export interface S2C_HoleCards {
  // Sent privately to each player (via userId-namespaced room)
  handId: string;
  cards: [string, string]; // e.g. ['AS', 'KH']
}

export interface S2C_ActionRequired {
  handId: string;
  userId: string;          // whose turn it is
  seatNumber: number;
  timeoutSecs: number;
  timeBankSecs: number;
  availableActions: Array<'fold' | 'check' | 'call' | 'raise' | 'all_in'>;
  callAmount: number;
  minRaise: number;
  maxRaise: number;        // player stack
  currentPot: number;
}

export interface S2C_PlayerActed {
  handId: string;
  userId: string;
  seatNumber: number;
  action: string;
  amount: number;
  stackAfter: number;
  potTotal: number;
  sequenceNum: number;
}

export interface S2C_StreetDealt {
  handId: string;
  street: 'flop' | 'turn' | 'river';
  communityCards: string[];  // all community cards so far
  pots: Array<{ amount: number; label: string }>;
}

export interface S2C_Showdown {
  handId: string;
  players: Array<{
    userId: string;
    seatNumber: number;
    holeCards: [string, string];
    handDescription: string;
    isWinner: boolean;
    amountWon: number;
  }>;
  communityCards: string[];
  deckSeed: string;    // reveal seed for provably fair verification
  deckHash: string;
}

export interface S2C_HandComplete {
  handId: string;
  winners: Array<{ userId: string; amount: number; potLabel: string }>;
  rake: { total: number; club: number; platform: number };
  stackChanges: Array<{ userId: string; stackAfter: number }>;
  nextHandIn: number;  // milliseconds
}

export interface S2C_PlayerJoined {
  tableId: string;
  userId: string;
  username: string;
  seatNumber: number;
  stack: number;
}

export interface S2C_PlayerLeft {
  tableId: string;
  userId: string;
  seatNumber: number;
}

export interface S2C_PlayerDisconnected {
  tableId: string;
  userId: string;
  reconnectWindowSecs: number;
}

export interface S2C_Error {
  code: string;
  message: string;
}

// ─── Event name constants ─────────────────────────────────────────────────────

export const EVENTS = {
  // C2S
  JOIN_TABLE: 'c2s:join_table',
  LEAVE_TABLE: 'c2s:leave_table',
  PLAYER_ACTION: 'c2s:player_action',
  SIT_OUT: 'c2s:sit_out',
  ADD_CHIPS: 'c2s:add_chips',
  CHAT_MESSAGE: 'c2s:chat',

  // S2C
  TABLE_STATE: 's2c:table_state',
  HAND_STARTED: 's2c:hand_started',
  HOLE_CARDS: 's2c:hole_cards',
  ACTION_REQUIRED: 's2c:action_required',
  PLAYER_ACTED: 's2c:player_acted',
  STREET_DEALT: 's2c:street_dealt',
  SHOWDOWN: 's2c:showdown',
  HAND_COMPLETE: 's2c:hand_complete',
  PLAYER_JOINED: 's2c:player_joined',
  PLAYER_LEFT: 's2c:player_left',
  PLAYER_DISCONNECTED: 's2c:player_disconnected',
  ERROR: 's2c:error',
} as const;
