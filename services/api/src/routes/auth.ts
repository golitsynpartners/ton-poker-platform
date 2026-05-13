import { FastifyInstance } from 'fastify';
import { verifyTelegramInitData } from '../middleware/telegram-auth';
import { signToken } from '../middleware/auth';

export async function authRoutes(app: FastifyInstance) {
  /**
   * POST /auth/telegram
   * Exchange Telegram initData for a JWT.
   * Called once when Mini App opens.
   */
  app.post<{ Body: { initData: string } }>('/auth/telegram', async (req, reply) => {
    const { initData } = req.body;

    if (!initData) {
      return reply.status(400).send({ error: 'initData required' });
    }

    let telegramData;
    try {
      telegramData = verifyTelegramInitData(initData);
    } catch (err: any) {
      return reply.status(401).send({ error: err.message });
    }

    const { user: tgUser } = telegramData;

    // Upsert user
    const result = await app.db.query(`
      INSERT INTO users (telegram_id, telegram_username, telegram_first_name, telegram_last_name, telegram_photo_url)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (telegram_id) DO UPDATE SET
        telegram_username = EXCLUDED.telegram_username,
        telegram_first_name = EXCLUDED.telegram_first_name,
        telegram_last_name = EXCLUDED.telegram_last_name,
        telegram_photo_url = EXCLUDED.telegram_photo_url,
        updated_at = NOW()
      RETURNING id, role, is_banned, ban_reason
    `, [tgUser.id, tgUser.username, tgUser.first_name, tgUser.last_name, tgUser.photo_url]);

    const user = result.rows[0];

    if (user.is_banned) {
      return reply.status(403).send({ error: 'Account suspended', reason: user.ban_reason });
    }

    const token = signToken({
      userId: user.id,
      telegramId: tgUser.id,
      role: user.role,
    });

    return reply.send({ token, user: { id: user.id, role: user.role } });
  });
}
