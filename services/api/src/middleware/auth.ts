import jwt from 'jsonwebtoken';
import { FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config';

export interface JWTPayload {
  userId: string;
  telegramId: number;
  role: 'platform_owner' | 'club_owner' | 'agent' | 'player';
  iat: number;
  exp: number;
}

export function signToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  const config = loadConfig();
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN as any });
}

export function verifyToken(token: string): JWTPayload {
  const config = loadConfig();
  return jwt.verify(token, config.JWT_SECRET) as JWTPayload;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization token' });
  }

  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    (request as any).user = payload;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: JWTPayload['role'][]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (request as any).user as JWTPayload;
    if (!user || !roles.includes(user.role)) {
      return reply.status(403).send({ error: 'Insufficient permissions' });
    }
  };
}
