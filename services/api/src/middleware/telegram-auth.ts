import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface TelegramInitData {
  user: TelegramUser;
  chat_instance?: string;
  chat_type?: string;
  start_param?: string;
  auth_date: number;
  hash: string;
}

/**
 * Verifies Telegram Mini App initData signature.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramInitData(initDataRaw: string): TelegramInitData {
  const config = loadConfig();
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');

  if (!hash) throw new Error('Missing hash in initData');

  // Remove hash from params before verifying
  params.delete('hash');

  // Sort params alphabetically and join as key=value\n
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // HMAC-SHA256 with key = HMAC-SHA256("WebAppData", bot_token)
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(config.TELEGRAM_BOT_TOKEN)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(hash, 'hex'))) {
    throw new Error('Invalid Telegram signature');
  }

  // Reject stale initData (older than 1 hour)
  const authDate = parseInt(params.get('auth_date') ?? '0', 10);
  if (Date.now() / 1000 - authDate > 3600) {
    throw new Error('initData expired');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new Error('Missing user in initData');

  return {
    user: JSON.parse(userRaw) as TelegramUser,
    chat_instance: params.get('chat_instance') ?? undefined,
    chat_type: params.get('chat_type') ?? undefined,
    start_param: params.get('start_param') ?? undefined,
    auth_date: authDate,
    hash,
  };
}

/**
 * Fastify preHandler hook for Telegram auth.
 * Attaches verified telegram user to request.
 */
export async function telegramAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const initData = request.headers['x-telegram-init-data'] as string;
  if (!initData) {
    return reply.status(401).send({ error: 'Missing Telegram auth' });
  }

  try {
    const data = verifyTelegramInitData(initData);
    (request as any).telegramUser = data.user;
  } catch (err) {
    return reply.status(401).send({ error: 'Invalid Telegram auth' });
  }
}
