import type { NextFunction, Request, Response } from 'express';
import { google } from 'googleapis';
import 'dotenv/config';

type AuthDependencies = {
  validateGoogleToken: (accessToken: string) => Promise<void>;
};

export function createApiAuthMiddleware({ validateGoogleToken }: AuthDependencies) {
  return async function authenticateApiRequest(req: Request, res: Response, next: NextFunction) {
    // The settings read only exposes a masked key, model and base URL.
    if (req.method === 'GET' && req.path === '/ai-settings') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Nicht authentifiziert. Bitte im Browser anmelden.' });
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return res.status(401).json({ error: 'Nicht authentifiziert. Bitte im Browser anmelden.' });
    }

    try {
      await validateGoogleToken(token);
      (req as any).googleToken = token;
      return next();
    } catch (error: any) {
      const status = error?.status || error?.code;
      if (status === 403 && !/insufficient|credential|token|auth|access/i.test(error?.message || '')) {
        return res.status(403).json({ error: 'Dieses Google-Konto ist nicht für den Agenten freigegeben.' });
      }
      if (status === 401 || error?.message === 'AUTH_FAILED' || (status === 403 && /insufficient|credential|token|auth|access/i.test(error?.message || ''))) {
        return res.status(401).json({ error: 'Google API-Authentifizierung abgelaufen. Bitte neu anmelden.' });
      }
      console.warn('Google token validation failed:', error?.message || error);
      return res.status(503).json({ error: 'Google-Token konnte derzeit nicht validiert werden.' });
    }
  };
}

export async function validateGoogleToken(token: string, getOAuth2Client: (accessToken: string) => any) {
  const allowedGoogleEmail = process.env.GOOGLE_ALLOWED_EMAIL?.trim().toLowerCase();
  const tasksApi = google.tasks({ version: 'v1', auth: getOAuth2Client(token) });
  await tasksApi.tasklists.list({ maxResults: 1 });
  if (!allowedGoogleEmail) {
    const error: any = new Error('GOOGLE_ALLOWED_EMAIL ist nicht konfiguriert.');
    error.status = 503;
    throw error;
  }
  const oauth2 = google.oauth2({ version: 'v2', auth: getOAuth2Client(token) });
  const userInfo = await oauth2.userinfo.get();
  if (userInfo.data.email?.toLowerCase() !== allowedGoogleEmail) {
    const error: any = new Error('ACCOUNT_NOT_ALLOWED');
    error.status = 403;
    throw error;
  }
}
