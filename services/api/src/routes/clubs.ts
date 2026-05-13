import { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../middleware/auth';

export async function clubRoutes(app: FastifyInstance) {
  // ─── Create Club (club_owner or platform_owner only) ─────────────────────

  app.post<{
    Body: { name: string; description?: string; rakePct: number; clubRakeShare: number; isPublic: boolean }
  }>('/clubs', {
    preHandler: [requireAuth, requireRole('club_owner', 'platform_owner')],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { name, description, rakePct, clubRakeShare, isPublic } = req.body;

    if (rakePct < 0 || rakePct > 0.1) {
      return reply.status(400).send({ error: 'Rake must be between 0% and 10%' });
    }
    if (clubRakeShare < 0.5 || clubRakeShare > 0.9) {
      return reply.status(400).send({ error: 'Club share must be 50%–90%' });
    }

    const result = await app.db.query(`
      INSERT INTO clubs (owner_id, name, description, rake_pct, club_rake_share, is_public)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [user.userId, name, description, rakePct, clubRakeShare, isPublic]);

    const club = result.rows[0];

    // Auto-add owner as manager member
    await app.db.query(`
      INSERT INTO club_members (club_id, user_id, role)
      VALUES ($1, $2, 'manager')
    `, [club.id, user.userId]);

    return reply.status(201).send({ club });
  });

  // ─── Join Club by Invite Code ─────────────────────────────────────────────

  app.post<{ Body: { inviteCode: string } }>('/clubs/join', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { inviteCode } = req.body;

    const clubResult = await app.db.query(
      'SELECT * FROM clubs WHERE invite_code = $1 AND status = $2',
      [inviteCode, 'active']
    );

    if (!clubResult.rows.length) {
      return reply.status(404).send({ error: 'Invalid invite code' });
    }

    const club = clubResult.rows[0];

    const memberCount = await app.db.query(
      'SELECT COUNT(*) FROM club_members WHERE club_id = $1',
      [club.id]
    );

    if (parseInt(memberCount.rows[0].count) >= club.max_players) {
      return reply.status(400).send({ error: 'Club is full' });
    }

    await app.db.query(`
      INSERT INTO club_members (club_id, user_id, role)
      VALUES ($1, $2, 'player')
      ON CONFLICT (club_id, user_id) DO NOTHING
    `, [club.id, user.userId]);

    // Initialize club balance for user
    await app.db.query(`
      INSERT INTO user_balances (user_id, club_id, balance_ton, locked_ton)
      VALUES ($1, $2, 0, 0)
      ON CONFLICT DO NOTHING
    `, [user.userId, club.id]);

    return reply.send({ message: 'Joined club', club: { id: club.id, name: club.name } });
  });

  // ─── Get My Clubs ─────────────────────────────────────────────────────────

  app.get('/clubs/mine', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;

    const result = await app.db.query(`
      SELECT c.*, cm.role as member_role, ub.balance_ton, ub.locked_ton,
             (SELECT COUNT(*) FROM club_members WHERE club_id = c.id) as member_count,
             (SELECT COUNT(*) FROM poker_tables WHERE club_id = c.id AND status != 'closed') as table_count
      FROM clubs c
      JOIN club_members cm ON cm.club_id = c.id AND cm.user_id = $1
      LEFT JOIN user_balances ub ON ub.user_id = $1 AND ub.club_id = c.id
      WHERE c.status = 'active'
      ORDER BY c.name
    `, [user.userId]);

    return reply.send({ clubs: result.rows });
  });

  // ─── Club Analytics (club owner) ─────────────────────────────────────────

  app.get<{ Params: { clubId: string } }>('/clubs/:clubId/analytics', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { clubId } = req.params;

    // Verify access
    const accessResult = await app.db.query(`
      SELECT role FROM club_members WHERE club_id = $1 AND user_id = $2
    `, [clubId, user.userId]);

    const isOwner = await app.db.query('SELECT 1 FROM clubs WHERE id = $1 AND owner_id = $2', [clubId, user.userId]);

    if (!isOwner.rows.length && !['manager'].includes(accessResult.rows[0]?.role)) {
      if (user.role !== 'platform_owner') {
        return reply.status(403).send({ error: 'Access denied' });
      }
    }

    const [rakeStats, playerStats, handStats] = await Promise.all([
      app.db.query(`
        SELECT
          COALESCE(SUM(rake_total), 0) as total_rake,
          COALESCE(SUM(rake_club), 0) as club_rake,
          COUNT(*) as total_hands,
          DATE_TRUNC('day', started_at) as day
        FROM hands h
        JOIN poker_tables pt ON pt.id = h.table_id
        WHERE pt.club_id = $1
          AND h.started_at >= NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day DESC
      `, [clubId]),

      app.db.query(`
        SELECT COUNT(DISTINCT user_id) as unique_players
        FROM club_members WHERE club_id = $1
      `, [clubId]),

      app.db.query(`
        SELECT COUNT(*) as total_hands_today
        FROM hands h
        JOIN poker_tables pt ON pt.id = h.table_id
        WHERE pt.club_id = $1 AND DATE(h.started_at) = CURRENT_DATE
      `, [clubId]),
    ]);

    return reply.send({
      rakeByDay: rakeStats.rows,
      totalPlayers: parseInt(playerStats.rows[0].unique_players),
      handsToday: parseInt(handStats.rows[0].total_hands_today),
    });
  });

  // ─── Create Table ─────────────────────────────────────────────────────────

  app.post<{
    Params: { clubId: string };
    Body: {
      name: string;
      smallBlind: number;
      bigBlind: number;
      minBuyIn: number;
      maxBuyIn: number;
      maxSeats: number;
      rakePct?: number;
      rakeCap?: number;
    }
  }>('/clubs/:clubId/tables', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const user = (req as any).user;
    const { clubId } = req.params;
    const { name, smallBlind, bigBlind, minBuyIn, maxBuyIn, maxSeats, rakePct, rakeCap } = req.body;

    // Check club ownership/management
    const club = await app.db.query(
      'SELECT * FROM clubs WHERE id = $1 AND (owner_id = $2 OR $3 = $4)',
      [clubId, user.userId, user.role, 'platform_owner']
    );

    if (!club.rows.length) {
      return reply.status(403).send({ error: 'Not authorized to create tables in this club' });
    }

    if (bigBlind !== smallBlind * 2) {
      return reply.status(400).send({ error: 'Big blind must be 2x small blind' });
    }

    const result = await app.db.query(`
      INSERT INTO poker_tables (club_id, name, small_blind, big_blind, min_buy_in, max_buy_in, max_seats, rake_pct, rake_cap, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [clubId, name, smallBlind, bigBlind, minBuyIn, maxBuyIn, maxSeats, rakePct, rakeCap, user.userId]);

    return reply.status(201).send({ table: result.rows[0] });
  });
}
