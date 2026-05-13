import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { TonClient } from '@ton/ton';
import { loadConfig } from './config';
import { authRoutes } from './routes/auth';
import { clubRoutes } from './routes/clubs';
import { walletRoutes } from './routes/wallet';
import { adminRoutes } from './routes/admin';
import { TonWalletService } from '../../packages/ton-sdk/src/ton-client';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    redis: ReturnType<typeof createClient>;
    tonService: TonWalletService;
  }
}

async function buildServer() {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'warn' : 'info',
      redact: ['req.headers.authorization'],
    },
    trustProxy: true,
  });

  // ─── Database ──────────────────────────────────────────────────────────────
  const db = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // ─── Redis ─────────────────────────────────────────────────────────────────
  const redis = createClient({ url: config.REDIS_URL });
  await redis.connect();

  // ─── TON Client ────────────────────────────────────────────────────────────
  const tonClient = new TonClient({
    endpoint: config.TON_RPC_URL,
    apiKey: config.TON_API_KEY,
  });

  const tonService = new TonWalletService(tonClient, redis, db, {
    platformWallet: config.PLATFORM_WALLET_ADDRESS,
    rpcUrl: config.TON_RPC_URL,
    apiKey: config.TON_API_KEY,
    pollIntervalMs: 10_000,
  });

  // Attach to fastify instance
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('tonService', tonService);

  // ─── Security plugins ──────────────────────────────────────────────────────
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://telegram.org'],
        connectSrc: ["'self'", 'wss:', 'https:'],
      },
    },
  });

  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  });

  await app.register(fastifyRateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis,
    keyGenerator: (req) => {
      const user = (req as any).user;
      return user?.userId ?? req.ip;
    },
  });

  // ─── Routes ────────────────────────────────────────────────────────────────
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(clubRoutes, { prefix: '/api/v1' });
  await app.register(walletRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });

  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/health', async () => {
    await db.query('SELECT 1');
    await redis.ping();
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ─── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async () => {
    app.log.info('Shutting down...');
    await app.close();
    await db.end();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { app, tonService };
}

async function start() {
  const config = loadConfig();
  const { app, tonService } = await buildServer();

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`API server listening on port ${config.PORT}`);

  // Start TON deposit monitor
  tonService.startDepositMonitor().catch(err => {
    app.log.error('TON monitor failed to start:', err);
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
