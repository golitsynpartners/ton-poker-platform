import jwt from 'jsonwebtoken';

export interface JWTPayload {
  userId: string;
  telegramId: number;
  role: 'platform_owner' | 'club_owner' | 'agent' | 'player';
  iat: number;
  exp: number;
}

const JWT_SECRET = process.env.JWT_SECRET!;

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}
