import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

const COOKIE_NAME = 'mappr_anon';


function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function packCookie(id: string, secret: string): string {
  return `${id}.${sign(id, secret)}`;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function unpackCookie(raw: unknown, secret: string): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [id, sig] = parts;
  if (!isUuid(id) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null;

  const expected = sign(id, secret);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);


  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  return id;
}

declare global {
  namespace Express {
    interface Request {
      anonId: string;
      hasEstablishedAnonSession: boolean;
    }
  }
}

export function anonSession(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) {
    throw new Error('COOKIE_SECRET is not set');
  }

  const raw = req.cookies?.[COOKIE_NAME];
  const existingId = raw ? unpackCookie(raw, secret) : null;

  const anonId = existingId ?? crypto.randomUUID();
  req.anonId = anonId;
  req.hasEstablishedAnonSession = existingId !== null;


  if (!existingId) {
    res.cookie(COOKIE_NAME, packCookie(anonId, secret), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
    });
  }

  next();
}
