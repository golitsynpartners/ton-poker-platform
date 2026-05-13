import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
// Event name constants (mirrors services/game-server/src/socket/events.ts)
const EVENTS = {
  JOIN_TABLE: 'c2s:join_table', LEAVE_TABLE: 'c2s:leave_table',
  PLAYER_ACTION: 'c2s:player_action', SIT_OUT: 'c2s:sit_out',
  ADD_CHIPS: 'c2s:add_chips', CHAT_MESSAGE: 'c2s:chat',
  TABLE_STATE: 's2c:table_state', HAND_STARTED: 's2c:hand_started',
  HOLE_CARDS: 's2c:hole_cards', ACTION_REQUIRED: 's2c:action_required',
  PLAYER_ACTED: 's2c:player_acted', STREET_DEALT: 's2c:street_dealt',
  SHOWDOWN: 's2c:showdown', HAND_COMPLETE: 's2c:hand_complete',
  PLAYER_JOINED: 's2c:player_joined', PLAYER_LEFT: 's2c:player_left',
  PLAYER_DISCONNECTED: 's2c:player_disconnected', ERROR: 's2c:error',
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TableSeat {
  seatNumber: number;
  userId: string;
  username: string;
  stack: number;
  bet: number;
  isSittingOut: boolean;
  isConnected: boolean;
  isDealer: boolean;
  cards?: [string, string] | null; // only visible for own cards or at showdown
  isFolded: boolean;
  isAllIn: boolean;
}

export interface PotInfo {
  amount: number;
  label: string;
}

export interface ActionInfo {
  userId: string;
  timeoutSecs: number;
  timeBankSecs: number;
  availableActions: string[];
  callAmount: number;
  minRaise: number;
  maxRaise: number;
  currentPot: number;
}

export interface TableState {
  tableId: string;
  status: 'waiting' | 'active' | 'paused';
  seats: TableSeat[];
  communityCards: string[];
  pots: PotInfo[];
  handId: string | null;
  handNumber: number;
  smallBlind: number;
  bigBlind: number;
  currentAction: ActionInfo | null;
  lastAction: { userId: string; action: string; amount: number } | null;
  winners: Array<{ userId: string; amount: number }> | null;
  showdownCards: Map<string, [string, string]>;
}

interface GameStore {
  socket: Socket | null;
  connected: boolean;
  tableState: TableState | null;
  myCards: [string, string] | null;
  error: string | null;

  connect: (token: string, gameServerUrl: string) => void;
  disconnect: () => void;
  joinTable: (tableId: string, buyIn: number, seatNumber?: number) => void;
  leaveTable: () => void;
  sendAction: (action: string, amount?: number) => void;
  sitOut: (sitOut: boolean) => void;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useGameStore = create<GameStore>((set, get) => ({
  socket: null,
  connected: false,
  tableState: null,
  myCards: null,
  error: null,

  connect(token: string, gameServerUrl: string) {
    const socket = io(gameServerUrl, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => {
      console.log('[Socket] Connected');
      set({ connected: true, error: null });
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      set({ connected: false });
    });

    socket.on(EVENTS.TABLE_STATE, (data) => {
      set(state => ({
        tableState: {
          ...state.tableState,
          ...data,
          communityCards: state.tableState?.communityCards ?? [],
          pots: state.tableState?.pots ?? [],
          handId: state.tableState?.handId ?? null,
          currentAction: state.tableState?.currentAction ?? null,
          lastAction: null,
          winners: null,
          showdownCards: new Map(),
        },
      }));
    });

    socket.on(EVENTS.HAND_STARTED, (data) => {
      set(state => ({
        myCards: null,
        tableState: state.tableState ? {
          ...state.tableState,
          handId: data.handId,
          handNumber: data.handNumber,
          communityCards: [],
          pots: [{ amount: 0, label: 'Pot' }],
          currentAction: null,
          winners: null,
          showdownCards: new Map(),
          seats: state.tableState.seats.map(s => ({
            ...s,
            bet: 0,
            isFolded: false,
            isAllIn: false,
            isDealer: s.seatNumber === data.buttonSeat,
            cards: null,
          })),
        } : null,
      }));
    });

    socket.on(EVENTS.HOLE_CARDS, (data) => {
      set({ myCards: data.cards });
    });

    socket.on(EVENTS.ACTION_REQUIRED, (data) => {
      set(state => ({
        tableState: state.tableState ? {
          ...state.tableState,
          currentAction: data,
        } : null,
      }));
    });

    socket.on(EVENTS.PLAYER_ACTED, (data) => {
      set(state => {
        if (!state.tableState) return {};
        return {
          tableState: {
            ...state.tableState,
            currentAction: null,
            lastAction: { userId: data.userId, action: data.action, amount: data.amount },
            pots: [{ amount: data.potTotal, label: 'Pot' }],
            seats: state.tableState.seats.map(s =>
              s.userId === data.userId
                ? { ...s, stack: data.stackAfter, bet: data.action === 'fold' ? 0 : s.bet + data.amount, isFolded: data.action === 'fold', isAllIn: data.action === 'all_in' }
                : s
            ),
          },
        };
      });
    });

    socket.on(EVENTS.STREET_DEALT, (data) => {
      set(state => ({
        tableState: state.tableState ? {
          ...state.tableState,
          communityCards: data.communityCards,
          pots: data.pots,
          currentAction: null,
          seats: state.tableState.seats.map(s => ({ ...s, bet: 0 })),
        } : null,
      }));
    });

    socket.on(EVENTS.SHOWDOWN, (data) => {
      const showdownCards = new Map<string, [string, string]>();
      for (const p of data.players) {
        showdownCards.set(p.userId, p.holeCards);
      }
      set(state => ({
        tableState: state.tableState ? { ...state.tableState, showdownCards } : null,
      }));
    });

    socket.on(EVENTS.HAND_COMPLETE, (data) => {
      set(state => ({
        myCards: null,
        tableState: state.tableState ? {
          ...state.tableState,
          winners: data.winners,
          currentAction: null,
          seats: state.tableState.seats.map(s => {
            const change = data.stackChanges.find((c: any) => c.userId === s.userId);
            return change ? { ...s, stack: change.stackAfter } : s;
          }),
        } : null,
      }));
    });

    socket.on(EVENTS.PLAYER_JOINED, (data) => {
      set(state => {
        if (!state.tableState) return {};
        const existing = state.tableState.seats.find(s => s.userId === data.userId);
        if (existing) return {};
        return {
          tableState: {
            ...state.tableState,
            seats: [...state.tableState.seats, {
              seatNumber: data.seatNumber,
              userId: data.userId,
              username: data.username,
              stack: data.stack,
              bet: 0,
              isSittingOut: false,
              isConnected: true,
              isDealer: false,
              cards: null,
              isFolded: false,
              isAllIn: false,
            }],
          },
        };
      });
    });

    socket.on(EVENTS.PLAYER_LEFT, (data) => {
      set(state => ({
        tableState: state.tableState ? {
          ...state.tableState,
          seats: state.tableState.seats.filter(s => s.userId !== data.userId),
        } : null,
      }));
    });

    socket.on(EVENTS.ERROR, (data) => {
      set({ error: data.message });
      setTimeout(() => set({ error: null }), 5000);
    });

    set({ socket });
  },

  disconnect() {
    get().socket?.disconnect();
    set({ socket: null, connected: false, tableState: null, myCards: null });
  },

  joinTable(tableId: string, buyIn: number, seatNumber?: number) {
    get().socket?.emit(EVENTS.JOIN_TABLE, { tableId, buyIn, seatNumber });
  },

  leaveTable() {
    const tableId = get().tableState?.tableId;
    if (tableId) get().socket?.emit(EVENTS.LEAVE_TABLE, { tableId });
  },

  sendAction(action: string, amount = 0) {
    const state = get();
    const tableId = state.tableState?.tableId;
    const handId = state.tableState?.handId;
    if (!tableId || !handId) return;

    state.socket?.emit(EVENTS.PLAYER_ACTION, {
      tableId,
      handId,
      action,
      amount,
      sequenceNum: Date.now(), // monotonic approximation
    });
  },

  sitOut(sitOut: boolean) {
    const tableId = get().tableState?.tableId;
    if (tableId) get().socket?.emit(EVENTS.SIT_OUT, { tableId, sitOut });
  },
}));
