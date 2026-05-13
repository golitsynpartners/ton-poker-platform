import { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../middleware/auth';

export async function adminRoutes(app: FastifyInstance) {
  // All admin routes require platform_owner role
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireRole('platform_owner'));

  // ─── Platform Overview ────────────────────────────────────────────────────

  app.get('/overview', async (req, reply) => {
    const [clubs, players, revenue, activeHands] = await Promise.all([
      app.db.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = $1) as active FROM clubs', ['active']),
      app.db.query('SELECT COUNT(*) as total FROM users WHERE role = $1', ['player']),
      app.db.query(`
        SELECT
          COALESCE(SUM(rake_platform), 0) as total_platform_rake,
          COALESCE(SUM(rake_platform) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours'), 0) as rake_24h,
          COALESCE(SUM(rake_platform) FILTER (WHERE started_at >= DATE_TRUNC('month', NOW())), 0) as rake_month
        FROM hands
        WHERE status = 'complete'
      `),
      app.db.query(`
        SELECT COUNT(*) as active_hands
        FROM hands WHERE status NOT IN ('complete', 'cancelled')
      `),
    ]);

    return reply.send({
      clubs: { total: parseInt(clubs.rows[0].total), active: parseInt(clubs.rows[0].active) },
      players: { total: parseInt(players.rows[0].total) },
      revenue: revenue.rows[0],
      activeHands: parseInt(activeHands.rows[0].active_hands),
    });
  });

  // ─── All Clubs ────────────────────────────────────────────────────────────

  app.get<{ Querystring: { page?: number; status?: string } }>('/clubs', async (req, reply) => {
    const { page = 1, status } = req.query;
    const offset = (page - 1) * 20;

    const result = await app.db.query(`
      SELECT c.*,
        u.telegram_username as owner_username,
        COUNT(DISTINCT cm.user_id) as member_count,
        COALESCE(SUM(h.rake_platform), 0) as total_platform_rake
      FROM clubs c
      JOIN users u ON u.id = c.owner_id
      LEFT JOIN club_members cm ON cm.club_id = c.id
      LEFT JOIN poker_tables pt ON pt.club_id = c.id
      LEFT JOIN hands h ON h.table_id = pt.id AND h.status = 'complete'
      WHERE ($1::text IS NULL OR c.status = $1)
      GROUP BY c.id, u.telegram_username
      ORDER BY c.created_at DESC
      LIMIT 20 OFFSET $2
    `, [status ?? null, offset]);

    return reply.send({ clubs: result.rows });
  });

  // ─── Freeze / Unfreeze Club ───────────────────────────────────────────────

  app.patch<{ Params: { clubId: string }; Body: { status: 'active' | 'suspended'; reason?: string } }>(
    '/clubs/:clubId/status', async (req, reply) => {
      const user = (req as any).user;
      const { clubId } = req.params;
      const { status, reason } = req.body;

      await app.db.query(
        'UPDATE clubs SET status = $1, updated_at = NOW() WHERE id = $2',
        [status, clubId]
      );

      await app.db.query(`
        INSERT INTO audit_log (actor_id, action, target_type, target_id, new_value)
        VALUES ($1, $2, 'club', $3, $4)
      `, [user.userId, `club_${status}`, clubId, JSON.stringify({ status, reason })]);

      return reply.send({ message: `Club ${status}` });
    }
  );

  // ─── Ban / Unban User ─────────────────────────────────────────────────────

  app.patch<{ Params: { userId: string }; Body: { banned: boolean; reason?: string } }>(
    '/users/:userId/ban', async (req, reply) => {
      const actor = (req as any).user;
      const { userId } = req.params;
      const { banned, reason } = req.body;

      await app.db.query(`
        UPDATE users SET is_banned = $1, ban_reason = $2, banned_at = $3, banned_by = $4, updated_at = NOW()
        WHERE id = $5
      `, [banned, reason, banned ? new Date() : null, banned ? actor.userId : null, userId]);

      // If banning, kick from all active tables (game server will handle via event)
      if (banned) {
        await app.redis.publish('admin:ban_user', JSON.stringify({ userId, reason }));
      }

      await app.db.query(`
        INSERT INTO audit_log (actor_id, action, target_type, target_id, new_value)
        VALUES ($1, $2, 'user', $3, $4)
      `, [actor.userId, banned ? 'user_banned' : 'user_unbanned', userId, JSON.stringify({ reason })]);

      return reply.send({ message: banned ? 'User banned' : 'User unbanned' });
    }
  );

  // ─── Fraud Signals Dashboard ──────────────────────────────────────────────

  app.get<{ Querystring: { resolved?: boolean } }>('/fraud-signals', async (req, reply) => {
    const { resolved = false } = req.query;

    const result = await app.db.query(`
      SELECT fs.*, u.telegram_username, u.telegram_id
      FROM fraud_signals fs
      JOIN users u ON u.id = fs.user_id
      WHERE fs.resolved = $1
      ORDER BY fs.created_at DESC
      LIMIT 50
    `, [resolved]);

    return reply.send({ signals: result.rows });
  });

  // ─── Platform Config Update ───────────────────────────────────────────────

  app.patch<{
    Body: { platformRakePct?: number; withdrawalRequiresApproval?: boolean; maintenanceMode?: boolean }
  }>('/config', async (req, reply) => {
    const user = (req as any).user;
    const { platformRakePct, withdrawalRequiresApproval, maintenanceMode } = req.body;

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (platformRakePct !== undefined) {
      if (platformRakePct < 0 || platformRakePct > 1) {
        return reply.status(400).send({ error: 'Platform rake must be 0–100%' });
      }
      updates.push(`platform_rake_pct = $${idx++}`);
      values.push(platformRakePct);
    }
    if (withdrawalRequiresApproval !== undefined) {
      updates.push(`withdrawal_requires_approval = $${idx++}`);
      values.push(withdrawalRequiresApproval);
    }
    if (maintenanceMode !== undefined) {
      updates.push(`maintenance_mode = $${idx++}`);
      values.push(maintenanceMode);
    }

    if (!updates.length) return reply.status(400).send({ error: 'No fields to update' });

    updates.push(`updated_at = NOW()`, `updated_by = $${idx++}`);
    values.push(user.userId);

    await app.db.query(
      `UPDATE platform_config SET ${updates.join(', ')} WHERE id = 1`,
      values
    );

    return reply.send({ message: 'Config updated' });
  });

  // ─── Approve Withdrawal ───────────────────────────────────────────────────

  app.post<{ Params: { withdrawalId: string }; Body: { approved: boolean; rejectReason?: string } }>(
    '/withdrawals/:withdrawalId/review', async (req, reply) => {
      const user = (req as any).user;
      const { withdrawalId } = req.params;
      const { approved, rejectReason } = req.body;

      const withdrawal = await app.db.query(
        'SELECT * FROM withdrawal_requests WHERE id = $1 AND status = $2',
        [withdrawalId, 'pending']
      );

      if (!withdrawal.rows.length) {
        return reply.status(404).send({ error: 'Withdrawal not found or already reviewed' });
      }

      if (approved) {
        await app.db.query(`
          UPDATE withdrawal_requests
          SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
          WHERE id = $2
        `, [user.userId, withdrawalId]);

        await app.redis.lPush('withdrawal_queue', withdrawalId);
      } else {
        const wr = withdrawal.rows[0];
        // Unlock funds
        await app.db.query(`
          UPDATE user_balances
          SET locked_ton = locked_ton - $1, updated_at = NOW()
          WHERE user_id = $2 AND club_id IS NOT DISTINCT FROM $3
        `, [wr.amount_ton, wr.user_id, wr.club_id]);

        await app.db.query(`
          UPDATE withdrawal_requests
          SET status = 'rejected', reject_reason = $1, updated_at = NOW()
          WHERE id = $2
        `, [rejectReason, withdrawalId]);
      }

      return reply.send({ message: approved ? 'Withdrawal approved' : 'Withdrawal rejected' });
    }
  );

  // ─── Hand History (for audit) ─────────────────────────────────────────────

  app.get<{ Params: { handId: string } }>('/hands/:handId', async (req, reply) => {
    const { handId } = req.params;

    const [hand, players, actions] = await Promise.all([
      app.db.query('SELECT * FROM hands WHERE id = $1', [handId]),
      app.db.query('SELECT * FROM hand_players WHERE hand_id = $1', [handId]),
      app.db.query('SELECT * FROM hand_actions WHERE hand_id = $1 ORDER BY sequence_num', [handId]),
    ]);

    if (!hand.rows.length) return reply.status(404).send({ error: 'Hand not found' });

    return reply.send({ hand: hand.rows[0], players: players.rows, actions: actions.rows });
  });
}
