import http from 'http';
import { Server as SocketServer } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { Pool } from 'pg';
import { verifyToken } from './auth';
import { TableManager } from './engine/table-manager';
import { EVENTS } from './socket/events';

const PORT = parseInt(process.env.GAME_SERVER_PORT ?? '3002', 10);
const DATABASE_URL = process.env.DATABASE_URL!;
const REDIS_URL = process.env.REDIS_URL!;

const sslOpts = DATABASE_URL.includes('.render.com') ? { rejectUnauthorized: false } : false;
const redisTls = REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined;

async function start() {
  const db = new Pool({ connectionString: DATABASE_URL, max: 10, ssl: sslOpts });

  // Two Redis clients required by socket.io redis adapter (pub + sub)
  const pubClient = createClient({ url: REDIS_URL, socket: { tls: !!redisTls, ...(redisTls ?? {}) } });
  const subClient = pubClient.duplicate();
  const stateClient = createClient({ url: REDIS_URL, socket: { tls: !!redisTls, ...(redisTls ?? {}) } });
  await Promise.all([pubClient.connect(), subClient.connect(), stateClient.connect()]);

  const httpServer = http.createServer();

  const io = new SocketServer(httpServer, {
    cors: { origin: '*', credentials: true },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket'],
    // Reject connections over 50KB (prevent packet amplification)
    maxHttpBufferSize: 50_000,
  });

  // Scale horizontally with Redis adapter
  io.adapter(createAdapter(pubClient, subClient));

  const tableManager = new TableManager(io, stateClient, db);

  // ─── Auth middleware ────────────────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = verifyToken(token);
      if (payload.role === undefined) return next(new Error('Invalid token'));

      // Check if user is banned via Redis cache
      stateClient.get(`ban:${payload.userId}`).then(banned => {
        if (banned) return next(new Error('Account suspended'));
        (socket as any).user = payload;
        next();
      });
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ─── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const user = (socket as any).user;
    console.log(`[WS] Connect: user=${user.userId} socket=${socket.id}`);

    // Always join personal room for private messages (hole cards)
    socket.join(`player:${user.userId}`);

    // Handle reconnect — restore table membership if player was at a table
    restorePlayerSession(socket, user.userId, tableManager);

    socket.on(EVENTS.JOIN_TABLE, async (payload) => {
      try {
        await tableManager.handleJoinTable(socket, payload.tableId, user.userId, payload.buyIn, payload.seatNumber);
      } catch (err: any) {
        socket.emit(EVENTS.ERROR, { code: 'INTERNAL', message: err.message });
      }
    });

    socket.on(EVENTS.PLAYER_ACTION, async (payload) => {
      try {
        await tableManager.handlePlayerAction(socket, user.userId, payload);
      } catch (err: any) {
        socket.emit(EVENTS.ERROR, { code: 'INTERNAL', message: err.message });
      }
    });

    socket.on(EVENTS.LEAVE_TABLE, async (payload) => {
      try {
        await handleLeaveTable(socket, user.userId, payload.tableId, tableManager, db);
      } catch (err: any) {
        socket.emit(EVENTS.ERROR, { code: 'INTERNAL', message: err.message });
      }
    });

    socket.on(EVENTS.SIT_OUT, async (payload) => {
      // Mark player as sitting out — they stay at table but skip hands
      const table = await tableManager.loadTable(payload.tableId);
      if (!table) return;
      const seat = Array.from(table.seats.values()).find(s => s.userId === user.userId);
      if (seat) {
        seat.isActive = !payload.sitOut;
        io.to(`table:${payload.tableId}`).emit('s2c:sit_out', {
          userId: user.userId,
          isSittingOut: payload.sitOut,
        });
      }
    });

    socket.on(EVENTS.CHAT_MESSAGE, (payload) => {
      // Sanitize and broadcast — no server secrets in chat
      const message = String(payload.message).substring(0, 200).trim();
      if (!message) return;
      io.to(`table:${payload.tableId}`).emit('s2c:chat', {
        userId: user.userId,
        message,
        timestamp: Date.now(),
      });
    });

    socket.on('disconnect', async (reason) => {
      console.log(`[WS] Disconnect: user=${user.userId} reason=${reason}`);
      await markPlayerDisconnected(user.userId, io, stateClient, db);
    });
  });

  // ─── Admin ban subscription ─────────────────────────────────────────────────
  // Listen for ban events from API server
  stateClient.subscribe('admin:ban_user', (message) => {
    const { userId } = JSON.parse(message);
    // Cache ban status for 24h
    stateClient.setEx(`ban:${userId}`, 86400, '1');
    // Kick all sockets for this user
    io.in(`player:${userId}`).disconnectSockets(true);
  });

  httpServer.listen(PORT, () => {
    console.log(`[Game Server] Listening on port ${PORT}`);
  });
}

async function restorePlayerSession(socket: any, userId: string, tableManager: TableManager): Promise<void> {
  const tableId = await (tableManager as any).redis.get(`player:table:${userId}`);
  if (!tableId) return;

  const table = await tableManager.loadTable(tableId);
  if (!table) return;

  const seat = Array.from(table.seats.values()).find(s => s.userId === userId);
  if (!seat) return;

  seat.isConnected = true;
  socket.join(`table:${tableId}`);

  // Re-send current table state + hand state if in progress
  socket.emit(EVENTS.TABLE_STATE, {
    tableId,
    seats: Array.from(table.seats.values()),
    status: table.status,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    handNumber: table.handNumber,
  });

  console.log(`[WS] Restored session: user=${userId} table=${tableId}`);
}

async function markPlayerDisconnected(
  userId: string,
  io: SocketServer,
  redis: ReturnType<typeof createClient>,
  db: Pool
): Promise<void> {
  const tableId = await redis.get(`player:table:${userId}`);
  if (!tableId) return;

  io.to(`table:${tableId}`).emit(EVENTS.PLAYER_DISCONNECTED, {
    tableId,
    userId,
    reconnectWindowSecs: 30,
  });

  // Set disconnected timestamp — if player doesn't reconnect within window, auto-fold/sit-out
  await redis.setEx(`disconnected:${userId}`, 30, tableId);
}

async function handleLeaveTable(
  socket: any,
  userId: string,
  tableId: string,
  tableManager: TableManager,
  db: Pool
): Promise<void> {
  const table = await tableManager.loadTable(tableId);
  if (!table) return;

  const seat = Array.from(table.seats.values()).find(s => s.userId === userId);
  if (!seat) return;

  // Cannot leave mid-hand (must wait for hand to complete or fold)
  if (table.currentHand?.players.has(userId)) {
    const player = table.currentHand.players.get(userId)!;
    if (!player.isFolded && !player.isAllIn) {
      socket.emit(EVENTS.ERROR, { code: 'MID_HAND', message: 'Wait for current hand to complete before leaving' });
      return;
    }
  }

  // Settle session — return chips to balance
  const initialBuyIn = seat.stack; // simplified; track actual buy-in in production
  await db.query(`
    UPDATE user_balances
    SET balance_ton = balance_ton + $1, locked_ton = GREATEST(0, locked_ton - $1), updated_at = NOW()
    WHERE user_id = $2 AND club_id = (SELECT club_id FROM poker_tables WHERE id = $3)
  `, [seat.stack, userId, tableId]);

  table.seats.delete(seat.seatNumber);
  socket.leave(`table:${tableId}`);

  socket.to(`table:${tableId}`).emit(EVENTS.PLAYER_LEFT, {
    tableId,
    userId,
    seatNumber: seat.seatNumber,
  });
}

start().catch(err => {
  console.error('[Game Server] Fatal error:', err);
  process.exit(1);
});
