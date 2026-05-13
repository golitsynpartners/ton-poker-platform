import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { Address } from '@ton/ton';

export async function walletRoutes(app: FastifyInstance) {
  // ─── Connect TON Wallet ───────────────────────────────────────────────────

  app.post<{ Body: { tonAddress: string; proof?: any } }>('/wallet/connect', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { tonAddress } = req.body;

    // Validate TON address format
    try {
      Address.parse(tonAddress);
    } catch {
      return reply.status(400).send({ error: 'Invalid TON address' });
    }

    // Check address isn't already bound to another user
    const existing = await app.db.query(
      'SELECT id FROM users WHERE ton_address = $1 AND id != $2',
      [tonAddress, user.userId]
    );
    if (existing.rows.length) {
      return reply.status(409).send({ error: 'TON address already connected to another account' });
    }

    // TODO: Verify TON Connect proof signature here for production security
    // The proof verifies the user actually owns this wallet

    await app.db.query(
      'UPDATE users SET ton_address = $1, updated_at = NOW() WHERE id = $2',
      [tonAddress, user.userId]
    );

    return reply.send({ message: 'Wallet connected' });
  });

  // ─── Get Deposit Info ─────────────────────────────────────────────────────

  app.get('/wallet/deposit-info', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;
    const depositInfo = app.tonService.getDepositInfo(user.userId);
    return reply.send(depositInfo);
  });

  // ─── Get Balances ─────────────────────────────────────────────────────────

  app.get('/wallet/balances', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;

    const result = await app.db.query(`
      SELECT ub.*, c.name as club_name
      FROM user_balances ub
      LEFT JOIN clubs c ON c.id = ub.club_id
      WHERE ub.user_id = $1
      ORDER BY c.name NULLS FIRST
    `, [user.userId]);

    return reply.send({
      balances: result.rows.map(r => ({
        clubId: r.club_id,
        clubName: r.club_name ?? 'Platform',
        available: parseFloat(r.balance_ton) - parseFloat(r.locked_ton),
        locked: parseFloat(r.locked_ton),
        total: parseFloat(r.balance_ton),
      })),
    });
  });

  // ─── Request Withdrawal ───────────────────────────────────────────────────

  app.post<{
    Body: { amountTon: number; toAddress: string; clubId?: string }
  }>('/wallet/withdraw', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { amountTon, toAddress, clubId } = req.body;

    // Validate address
    try {
      Address.parse(toAddress);
    } catch {
      return reply.status(400).send({ error: 'Invalid withdrawal address' });
    }

    if (amountTon < 0.5) {
      return reply.status(400).send({ error: 'Minimum withdrawal is 0.5 TON' });
    }

    // Check available balance
    const balResult = await app.db.query(`
      SELECT balance_ton - locked_ton AS available
      FROM user_balances
      WHERE user_id = $1 AND club_id IS NOT DISTINCT FROM $2
    `, [user.userId, clubId ?? null]);

    const available = parseFloat(balResult.rows[0]?.available ?? '0');
    if (available < amountTon) {
      return reply.status(400).send({ error: `Insufficient balance. Available: ${available.toFixed(4)} TON` });
    }

    // Lock the funds
    const client = await app.db.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        UPDATE user_balances
        SET locked_ton = locked_ton + $1, updated_at = NOW()
        WHERE user_id = $2 AND club_id IS NOT DISTINCT FROM $3
      `, [amountTon, user.userId, clubId ?? null]);

      const config = await client.query('SELECT * FROM platform_config WHERE id = 1');
      const requiresApproval = config.rows[0]?.withdrawal_requires_approval ?? true;

      const withdrawal = await client.query(`
        INSERT INTO withdrawal_requests (user_id, club_id, amount_ton, to_address, status)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, status
      `, [user.userId, clubId ?? null, amountTon, toAddress, requiresApproval ? 'pending' : 'approved']);

      await client.query('COMMIT');

      // If auto-approved, queue for immediate processing
      if (!requiresApproval) {
        await app.redis.lPush('withdrawal_queue', withdrawal.rows[0].id);
      }

      return reply.status(201).send({
        withdrawal: withdrawal.rows[0],
        message: requiresApproval
          ? 'Withdrawal submitted — awaiting approval'
          : 'Withdrawal queued for processing',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ─── Transaction History ───────────────────────────────────────────────────

  app.get<{ Querystring: { page?: number; limit?: number; clubId?: string } }>('/wallet/history', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { page = 1, limit = 20, clubId } = req.query;
    const offset = (page - 1) * limit;

    const result = await app.db.query(`
      SELECT l.*, c.name as club_name
      FROM ledger l
      LEFT JOIN clubs c ON c.id = l.club_id
      WHERE l.user_id = $1
        AND ($4::uuid IS NULL OR l.club_id = $4)
      ORDER BY l.created_at DESC
      LIMIT $2 OFFSET $3
    `, [user.userId, Math.min(limit, 100), offset, clubId ?? null]);

    return reply.send({ transactions: result.rows });
  });
}
