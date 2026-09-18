import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import cron from 'node-cron';
import 'dotenv/config';
import { appendVerbatimEvidence, searchVerbatimEvidence, type VerbatimEvidenceInput } from './verbatim-evidence-ledger.ts';
import { queryTemporalTimeline, upsertTemporalFact, type TemporalFactInput } from './temporal-facts.ts';
import { recordDecision, searchDecisions, type DecisionRecordInput } from './decision-memory.ts';
import { createApiAuthMiddleware, validateGoogleToken } from './src/server/api-auth.ts';
import { fetchUpcomingEvents } from './src/server/calendar-reader.ts';
import { fetchRecentChats } from './src/server/chat-reader.ts';
import { fetchRecentEmails } from './src/server/gmail-reader.ts';
import { fetchTasks } from './src/server/tasks-reader.ts';
import { getFileContent, listAllFiles } from './src/server/drive-reader.ts';
import { fetchDriveKnowledgeBaseContext as readDriveKnowledgeBaseContext } from './src/server/drive-context.ts';

export { fetchTasks };

export { fetchRecentEmails };

export { fetchRecentChats };

export { fetchUpcomingEvents };

const app = express();
const PORT = 3000;

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Audio transcription uses base64 JSON; text-based action routes enforce tighter field limits below.
app.use(express.json({ limit: '25mb' }));

function validateTextField(value: unknown, field: string, maxLength: number, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    return required ? `${field} ist erforderlich.` : null;
  }
  if (typeof value !== 'string') return `${field} muss Text sein.`;
  if (value.length > maxLength) return `${field} darf maximal ${maxLength} Zeichen enthalten.`;
  return null;
}

app.use('/api', createApiAuthMiddleware({
  validateGoogleToken: (token) => validateGoogleToken(token, getOAuth2Client),
}));

const TOKEN_FILE = path.join(process.cwd(), '.latest_token.json');
const CRON_STATUS_FILE = path.join(process.cwd(), '.last_cron_status.json');

let latestAccessToken: string | null = null;

export class GoogleAuthError extends Error {
  constructor(message = "Google API-Authentifizierung abgelaufen. Bitte neu anmelden.") {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export function isAuthError(error: any): boolean {
  if (!error) return false;
  if (error instanceof GoogleAuthError || error?.name === 'GoogleAuthError') return true;
  const status = error.code || error.status || (error.response && error.response.status);
  const msg = typeof error === 'string' ? error : (error.message || error.error || '');
  if (status === 401 || status === '401') return true;
  if (status === 403 || status === '403') {
    if (
      msg.includes('insufficient') ||
      msg.includes('Permission') ||
      msg.includes('credential') ||
      msg.includes('token') ||
      msg.includes('grant') ||
      msg.includes('auth') ||
      msg.includes('access') ||
      msg.includes('Unauthenticated')
    ) {
      return true;
    }
  }
  return (
    msg.includes('authentication credential') ||
    msg.includes('Invalid Credentials') ||
    msg.includes('invalid_grant') ||
    msg.includes('Unauthenticated') ||
    msg.includes('Token has been expired or revoked') ||
    msg.includes('401')
  );
}

export function clearStoredToken() {
  latestAccessToken = null;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  } catch (e) {
    console.error("Error deleting stored token file:", e);
  }
}

const DEFAULT_CLIENT_ID = '261415172337-16a674uqih6mk269b0hj8q61qguq6scp.apps.googleusercontent.com';
const REFRESH_FILE = path.join(process.cwd(), 'agent-memory', '.google-refresh-token.json');

export function loadRefreshToken(): string | null {
  if (process.env.GOOGLE_REFRESH_TOKEN) return process.env.GOOGLE_REFRESH_TOKEN;
  try {
    if (fs.existsSync(REFRESH_FILE)) {
      const data = JSON.parse(fs.readFileSync(REFRESH_FILE, 'utf-8'));
      if (data.refresh_token) return data.refresh_token;
    }
  } catch {}
  return null;
}

export async function getValidAccessToken(): Promise<string | null> {
  const existing = loadStoredToken();
  if (existing) return existing;

  const refreshToken = loadRefreshToken();
  if (!refreshToken) return null;

  try {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (process.env.GOOGLE_CLIENT_SECRET) {
      params.append('client_secret', process.env.GOOGLE_CLIENT_SECRET);
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data: any = await res.json();
    if (data.access_token) {
      saveToken(data.access_token);
      return data.access_token;
    }
  } catch (e: any) {
    console.warn('[Token Auto-Refresh] Fehler:', e?.message || e);
  }
  return null;
}

export function loadStoredToken(): string | null {
  if (latestAccessToken) return latestAccessToken;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (data.token) {
        latestAccessToken = data.token;
        return data.token;
      }
    }
  } catch (e) {
    console.error("Error reading token file:", e);
  }
  return null;
}

export function saveToken(token: string) {
  latestAccessToken = token;
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, updatedAt: new Date().toISOString() }), 'utf-8');
  } catch (e) {
    console.error("Error saving token to file:", e);
  }
}

export function getCronStatus() {
  try {
    if (fs.existsSync(CRON_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(CRON_STATUS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error("Error reading cron status file:", e);
  }
  return null;
}

export function saveCronStatus(statusData: any) {
  try {
    fs.writeFileSync(CRON_STATUS_FILE, JSON.stringify(statusData, null, 2), 'utf-8');
  } catch (e) {
    console.error("Error saving cron status:", e);
  }
}

function recordVerbatimEvidence(inputs: VerbatimEvidenceInput[]): void {
  try {
    const records = appendVerbatimEvidence(inputs);
    if (records.length > 0) console.log(`[Evidence Ledger] ${records.length} neue unveränderte Quelle(n) gespeichert.`);
  } catch (error: any) {
    console.warn('[Evidence Ledger] Speicherung übersprungen:', error?.message || error);
  }
}

const AI_SETTINGS_FILE = path.join(process.cwd(), '.ai_settings.json');

interface AISettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function loadAISettings(): AISettings {
  try {
    if (fs.existsSync(AI_SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(AI_SETTINGS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error("Error reading AI settings file:", e);
  }
  return {};
}

function saveAISettings(settings: AISettings) {
  try {
    fs.writeFileSync(AI_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error("Error saving AI settings file:", e);
  }
}

function isValidApiKey(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  if (trimmed.length < 5 || trimmed.length > 250) return false;
  if (/\s/.test(trimmed)) return false; // Reject keys containing spaces or newlines
  return true;
}

function normalizeAiBaseUrl(value?: string): string {
  const rawValue = value?.trim();
  if (!rawValue) return '';

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error('Die Gateway-URL ist ungültig.');
  }

  const allowedHosts = new Set([
    'gateway.pcg.io',
    'generativelanguage.googleapis.com',
    ...(process.env.AI_ALLOWED_BASE_URLS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)
  ]);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('Die Gateway-URL ist nicht freigegeben.');
  }

  return url.toString().replace(/\/+$/, '');
}

function getEffectiveApiConfig(customApiKey?: string, customBaseUrl?: string) {
  const settings = loadAISettings();
  const rawCustom = (customApiKey !== undefined && customApiKey.trim() !== '') ? customApiKey.trim() : undefined;
  const rawSaved = (settings.apiKey && isValidApiKey(settings.apiKey)) ? settings.apiKey.trim() : undefined;

  let apiKey = rawCustom || rawSaved || process.env.GEMINI_API_KEY || '';
  if (apiKey && !isValidApiKey(apiKey)) {
    apiKey = process.env.GEMINI_API_KEY || '';
  }

  const configuredBaseUrl = customBaseUrl !== undefined && customBaseUrl.trim() !== '' ? customBaseUrl : settings.baseUrl;
  const userBaseUrl = normalizeAiBaseUrl(configuredBaseUrl);

  let baseUrl = userBaseUrl;

  if (apiKey && apiKey.startsWith('sk-')) {
    if (!baseUrl) {
      baseUrl = 'https://gateway.pcg.io';
    }
  } else {
    // If not using an sk- LiteLLM key, route directly to Google Gemini API
    baseUrl = '';
  }

  if (baseUrl) {
    baseUrl = normalizeAiBaseUrl(baseUrl);
  }

  const isGateway = Boolean(baseUrl && (baseUrl.includes('gateway') || baseUrl.includes('pcg')));

  return { apiKey, baseUrl, isGateway };
}

function getModelName(customModel?: string, customApiKey?: string, customBaseUrl?: string): string {
  const settings = loadAISettings();
  const { isGateway } = getEffectiveApiConfig(customApiKey, customBaseUrl);

  const rawModel = (customModel && customModel.trim() !== '') 
    ? customModel.trim() 
    : (settings.model && settings.model.trim() !== '' ? settings.model.trim() : '');

  if (isGateway) {
    if (rawModel && (rawModel === 'gemini-3.8-flash' || rawModel === 'gemini-3.5-flash' || rawModel === 'gemini-3.7-flash' || rawModel === 'pcg-auto-pro' || rawModel === 'gemini-2.5-pro' || rawModel === 'claude-sonnet-5' || rawModel === 'gpt-5.4' || rawModel === 'Standard' || rawModel === 'Pro' || rawModel === 'Expert')) {
      return rawModel;
    }
    return "gemini-3.8-flash";
  } else {
    if (rawModel && (rawModel.startsWith('gemini-') || rawModel === 'Standard' || rawModel === 'Pro')) {
      return rawModel;
    }
    return "gemini-3.8-flash";
  }
}

function convertToOpenAIMessages(contents: any, systemInstruction?: any): any[] {
  const messages: any[] = [];
  if (systemInstruction) {
    let sysText = '';
    if (typeof systemInstruction === 'string') {
      sysText = systemInstruction;
    } else if (systemInstruction.parts && Array.isArray(systemInstruction.parts)) {
      sysText = systemInstruction.parts.map((p: any) => p.text || (typeof p === 'string' ? p : '')).join('\n');
    } else if (systemInstruction.text) {
      sysText = systemInstruction.text;
    }
    if (sysText.trim() !== '') {
      messages.push({ role: 'system', content: sysText.trim() });
    }
  }

  if (typeof contents === 'string') {
    messages.push({ role: 'user', content: contents });
  } else if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item && typeof item === 'object') {
        const role = item.role === 'model' || item.role === 'assistant' ? 'assistant' : (item.role === 'system' ? 'system' : 'user');
        let text = '';
        if (typeof item.content === 'string') {
          text = item.content;
        } else if (Array.isArray(item.parts)) {
          text = item.parts.map((p: any) => p.text || (typeof p === 'string' ? p : '')).join('\n');
        } else if (item.text) {
          text = item.text;
        }
        if (text) {
          messages.push({ role, content: text });
        }
      }
    }
  } else if (contents && typeof contents === 'object') {
    const role = contents.role === 'model' || contents.role === 'assistant' ? 'assistant' : (contents.role === 'system' ? 'system' : 'user');
    let text = '';
    if (typeof contents.content === 'string') {
      text = contents.content;
    } else if (Array.isArray(contents.parts)) {
      text = contents.parts.map((p: any) => p.text || (typeof p === 'string' ? p : '')).join('\n');
    } else if (contents.text) {
      text = contents.text;
    }
    if (text) {
      messages.push({ role, content: text });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hallo' });
  }

  return messages;
}

function getGenAIClient(customApiKey?: string, customBaseUrl?: string): GoogleGenAI {
  const { apiKey, baseUrl } = getEffectiveApiConfig(customApiKey, customBaseUrl);
  const options: any = { apiKey: apiKey || '' };
  if (baseUrl) {
    options.httpOptions = { baseUrl };
  }
  return new GoogleGenAI(options);
}

async function callOpenAICompatibleGateway(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  contents: any;
  config?: any;
}): Promise<{ text?: string }> {
  let endpoint = options.baseUrl;
  if (endpoint.endsWith('/v1')) {
    endpoint = `${endpoint}/chat/completions`;
  } else if (endpoint.endsWith('/v1/')) {
    endpoint = `${endpoint}chat/completions`;
  } else {
    endpoint = `${endpoint}/v1/chat/completions`;
  }

  const messages = convertToOpenAIMessages(options.contents, options.config?.systemInstruction);
  const body: any = {
    model: options.model,
    messages
  };

  if (options.config?.responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${options.apiKey}`
    },
    body: JSON.stringify(body)
  });

  const textRes = await res.text();
  let jsonRes: any = {};
  try {
    jsonRes = JSON.parse(textRes);
  } catch {
    if (!res.ok) {
      throw new Error(`Gateway Error (${res.status}): ${textRes}`);
    }
  }

  if (!res.ok || jsonRes.error) {
    const errorMsg = jsonRes.error?.message || jsonRes.error || textRes || `HTTP ${res.status}`;
    const err = new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
    (err as any).status = res.status;
    (err as any).data = jsonRes;
    throw err;
  }

  const choiceContent = jsonRes.choices?.[0]?.message?.content || '';
  return { text: choiceContent };
}

export async function generateAIContent(options: {
  contents: any;
  config?: any;
  customApiKey?: string;
  customBaseUrl?: string;
  customModel?: string;
}): Promise<{ text?: string }> {
  const { apiKey, baseUrl, isGateway } = getEffectiveApiConfig(options.customApiKey, options.customBaseUrl);

  if (!apiKey || apiKey.trim() === '') {
    throw new Error("Ungültiger oder fehlender API-Key. Bitte klicke oben rechts auf 'AI Gateway' und trage deinen passenden API-Key (z. B. sk-... für LiteLLM Gateway oder deinen Google Gemini API-Key) ein.");
  }

  let targetModel = getModelName(options.customModel, options.customApiKey, options.customBaseUrl);

  // 1. Gateway execution (LiteLLM / OpenAI format)
  if (isGateway) {
    const gatewayCandidates = [
      targetModel,
      'Standard',
      'gemini-3.8-flash',
      'Pro',
      'Expert',
      'gemini-3.5-flash',
      'pcg-auto-pro',
      'gemini-2.5-pro',
      'claude-sonnet-5',
      'gpt-5.4',
      'gpt-auto-pro'
    ].filter((m, idx, arr) => arr.indexOf(m) === idx);

    for (let i = 0; i < gatewayCandidates.length; i++) {
      const candidate = gatewayCandidates[i];
      try {
        const result = await callOpenAICompatibleGateway({
          apiKey,
          baseUrl: baseUrl || 'https://gateway.pcg.io',
          model: candidate,
          contents: options.contents,
          config: options.config
        });

        if (candidate !== targetModel) {
          const currentSettings = loadAISettings();
          currentSettings.model = candidate;
          saveAISettings(currentSettings);
          console.log(`[AI Generation] Switched to working gateway model: ${candidate}`);
        }

        return result;
      } catch (gwErr: any) {
        console.warn(`[AI Generation] Gateway error with model ${candidate}:`, gwErr?.message || gwErr);
        if (i === gatewayCandidates.length - 1) {
          throw gwErr;
        }
      }
    }
  }

  // 2. Direct Google GenAI execution
  const ai = getGenAIClient(options.customApiKey, options.customBaseUrl);
  try {
    return await generateGeminiContentWithTimeout(ai, {
      model: targetModel,
      contents: options.contents,
      ...(options.config ? { config: options.config } : {})
    });
  } catch (err: any) {
    console.warn("AI Generation Error for model:", targetModel, "Error:", err?.message || err);
    let fullStr = (err?.message || '') + ' ' + JSON.stringify(err || {});
    
    // Check for access denied, invalid model name, quota exhausted, 503 unavailable, 404 not found, or 403 errors
    const isAccessDenied = fullStr.includes('key_model_access_denied') || fullStr.includes('not allowed to access model') || fullStr.includes('403') || fullStr.includes('Forbidden') || err?.status === 403 || err?.code === 403;
    const isInvalidModel = fullStr.includes('Invalid model name passed in model=') || fullStr.includes('invalid model') || fullStr.includes('not found') || err?.status === 404;
    const isQuotaError = err?.status === 429 || err?.code === 429 || fullStr.includes('quota') || fullStr.includes('Quota') || fullStr.includes('RESOURCE_EXHAUSTED');
    const isUnavailable = err?.status === 503 || err?.code === 503 || fullStr.includes('503') || fullStr.includes('UNAVAILABLE') || fullStr.includes('high demand');
    const isNetworkError = fullStr.includes('fetch failed') || fullStr.includes('ECONNRESET') || fullStr.includes('ETIMEDOUT') || fullStr.includes('timed out');

    if (isAccessDenied || isInvalidModel || isQuotaError || isUnavailable || isNetworkError) {
      if (isQuotaError) {
        console.log(`[AI Generation] Quota für ${targetModel} erschöpft. Wechsle ohne Wartezeit zum Fallback-Modell.`);
      } else if (isUnavailable) {
        console.log('[AI Generation] Modell überlastet (503). Warte 10 Sekunden vor Fallback...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      } else if (isNetworkError) {
        console.log(`[AI Generation] Netzwerkfehler für ${targetModel}. Wechsle zum Fallback-Modell.`);
      }
      const directCandidates = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'].filter(m => m !== targetModel);

      for (const fallbackModel of directCandidates) {
        try {
          const fallbackAi = getGenAIClient(options.customApiKey, options.customBaseUrl);
          const result = await generateGeminiContentWithTimeout(fallbackAi, {
            model: fallbackModel,
            contents: options.contents,
            ...(options.config ? { config: options.config } : {})
          });

          // Save working model to settings
          const currentSettings = loadAISettings();
          currentSettings.model = fallbackModel;
          saveAISettings(currentSettings);

          console.log(`[AI Generation] Successfully recovered using model: ${fallbackModel}`);
          return result;
        } catch (fbErr: any) {
          console.warn(`[AI Generation] Fallback failed for model ${fallbackModel}:`, fbErr?.message || fbErr);
        }
      }
    }
    throw err;
  }
}

async function generateGeminiContentWithTimeout(ai: any, request: any, timeoutMs = 60000): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ai.models.generateContent(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Gemini request timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatAIError(error: any, customModel?: string, customApiKey?: string, customBaseUrl?: string): { status: number; message: string } {
  const currentModel = getModelName(customModel, customApiKey, customBaseUrl);
  const rawMsg = error?.message || String(error || '');
  let fullStr = rawMsg;
  try {
    fullStr += ` ${JSON.stringify(error || {})}`;
  } catch {}

  if (fullStr.includes('LiteLLM Virtual Key expected') || fullStr.includes('sk-')) {
    return {
      status: 400,
      message: "Ungültiger oder nicht zugelassener LiteLLM API-Key. Bitte überprüfe unter 'AI Gateway' (oben rechts) deinen Key (z. B. sk-...)."
    };
  }

  if (
    fullStr.includes('API key not valid') ||
    fullStr.includes('API_KEY_INVALID') ||
    fullStr.includes('INVALID_ARGUMENT') ||
    fullStr.includes('UNAUTHENTICATED') ||
    fullStr.includes('invalid API key')
  ) {
    return {
      status: 401,
      message: "Der angegebene API-Key wurde vom AI Dienst abgelehnt (HTTP 401). Bitte klicke oben rechts auf 'AI Gateway', lösche ggf. den gespeicherten Key und trage einen gültigen Schlüssel ein."
    };
  }

  if (fullStr.includes('Invalid model name passed in model=')) {
    return {
      status: 400,
      message: `Ungültiger KI-Modellname ('${currentModel}'). Bitte klicke oben rechts auf 'AI Gateway' und wähle ein gültiges Modell wie z. B. 'Standard', 'Pro' oder 'gemini-3.8-flash'.`
    };
  }

  if (
    fullStr.includes('key_model_access_denied') || 
    fullStr.includes('not allowed to access model')
  ) {
    const match = fullStr.match(/models=\[([^\]]+)\]/);
    const allowed = match ? match[1] : "'Standard', 'Pro', 'Expert', 'gemini-3.8-flash'";
    return {
      status: 403,
      message: `Zugriff auf Modell '${currentModel}' verweigert (HTTP 403). Dieser API-Key / Gateway erlaubt nur bestimmte Modelle: [${allowed}]. Bitte wähle unter 'AI Gateway' (oben rechts) ein passendes KI-Modell aus.`
    };
  }

  if (error?.status === 429 || error?.code === 429 || fullStr.includes('quota') || fullStr.includes('Quota') || fullStr.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message: "API-Kontingent (Quota) überschritten. Bitte trage unter 'AI Gateway' (oben rechts) deinen eigenen API-Key oder Gateway ein."
    };
  }

  const cleanMsg = rawMsg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const status = error?.status || error?.code || (error?.response && error?.response?.status) || 500;
  return {
    status: typeof status === 'number' ? status : 500,
    message: cleanMsg || "Ein Fehler bei der KI-Verarbeitung ist aufgetreten."
  };
}

app.get('/api/ai-settings', (req, res) => {
  const settings = loadAISettings();
  const rawKey = settings.apiKey || '';
  const keyValid = isValidApiKey(rawKey);
  const maskedKey = keyValid ? `${rawKey.slice(0, 4)}••••••••${rawKey.slice(-4)}` : (rawKey ? 'UNGÜLTIGER TEXT' : '');
  res.json({
    apiKeyConfigured: Boolean(rawKey && keyValid),
    apiKeyInvalidFormat: Boolean(rawKey && !keyValid),
    apiKeyMasked: maskedKey,
    baseUrl: settings.baseUrl || '',
    model: settings.model || 'Standard'
  });
});

app.post('/api/ai-settings', (req, res) => {
  const { apiKey, baseUrl, model, removeApiKey } = req.body;
  const settings = loadAISettings();

  if (removeApiKey) {
    delete settings.apiKey;
  } else if (apiKey !== undefined && apiKey !== null) {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (trimmed !== '') {
      if (!isValidApiKey(trimmed)) {
        return res.status(400).json({
          success: false,
          error: "Der eingegebene API-Key ist ungültig (enthält Leerzeichen oder Text). Ein API-Schlüssel beginnt gewöhnlich mit 'sk-...' oder 'AIza...' und darf keine Leerzeichen enthalten."
        });
      }
      settings.apiKey = trimmed;
    }
  }

  if (baseUrl !== undefined) {
    try {
      settings.baseUrl = typeof baseUrl === 'string' ? normalizeAiBaseUrl(baseUrl) : '';
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  if (model !== undefined) {
    const trimmedModel = typeof model === 'string' ? model.trim() : '';
    if (trimmedModel !== '') {
      settings.model = trimmedModel;
    }
  }

  saveAISettings(settings);
  res.json({ success: true, message: "Einstellungen erfolgreich gespeichert." });
});

app.post('/api/ai-settings/test', async (req, res) => {
  const { apiKey, baseUrl, model } = req.body;
  const trimmedKey = typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : undefined;
  try {
    const response = await generateAIContent({
      contents: "Antworte kurz mit 'Verbindung OK'.",
      customApiKey: trimmedKey,
      customBaseUrl: baseUrl,
      customModel: model
    });
    if (response.text) {
      return res.json({ 
        success: true, 
        message: `Verbindung erfolgreich! (Verwendetes Modell: ${getModelName(model, trimmedKey, baseUrl)})` 
      });
    }
    res.status(500).json({ success: false, error: "Keine Antwort von der AI empfangen." });
  } catch (err: any) {
    const errObj = formatAIError(err, model, trimmedKey, baseUrl);
    console.warn("AI Settings test notice:", errObj.message);
    res.status(errObj.status).json({ success: false, error: errObj.message });
  }
});

app.post('/api/token-sync', (req, res) => {
  const token = (req as any).googleToken;
  if (!token) {
    return res.status(401).json({ error: "Nicht authentifiziert" });
  }
  saveToken(token);
  return res.json({ success: true, message: "Token erfolgreich synchronisiert." });
});

export const driveFolderId = '1YK8hW4LWtZdmLW-hLcs9fFX_jFz3teOB';

export function getOAuth2Client(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

export async function getDriveClient(accessToken: string) {
  return google.drive({ version: 'v3', auth: getOAuth2Client(accessToken) });
}

function fetchDriveContext(accessToken: string) {
  return readDriveKnowledgeBaseContext(accessToken, driveFolderId, {
    getDriveClient,
    listAllFiles,
    getFileContent,
    recordEvidence: recordVerbatimEvidence,
    loadLocalMemoryContext,
  });
}

export async function fetchDriveKnowledgeBaseContext(accessToken: string) {
  return fetchDriveContext(accessToken);
}

export function extractDavidOneOnOneAgenda(tasksContext?: string): string {
  const agendaLine = tasksContext?.split('\n').find(line =>
    /^- \[OFFEN\] Besprechung David\b/i.test(line.trim())
  );

  return agendaLine
    ? `--- BESONDERE AGENDA-QUELLE: BESPRECHUNG DAVID ---\n${agendaLine}\nDiese Notiz enthält die gesammelten Themen für Davids 1:1 und muss bei jeder Vorbereitung eines David-Termins berücksichtigt werden.`
    : '--- BESONDERE AGENDA-QUELLE: BESPRECHUNG DAVID ---\nKeine offene Aufgabe "Besprechung David" gefunden.';
}

// Function to recursively list files in the knowledge base folder
function enrichTimestampTranscriptLinks(driveContext: string, eventsContext: string): string {
  const eventPattern = /- .*?([^\n(]+)\(([^)]+) bis ([^)]+)\).*?Direktlink:\s*(https?:\/\/[^\s|]+)/g;
  const events: { summary: string; end: number; url: string }[] = [];
  for (const match of eventsContext.matchAll(eventPattern)) {
    const end = Date.parse(match[3]);
    if (!Number.isNaN(end)) events.push({ summary: match[1].trim(), end, url: match[4] });
  }

  return driveContext.replace(
    /--- DOKUMENT \/ TRANSKRIPT \/ VORBEREITUNG: "([^"]*Transkript_[^"\s]+)"[^\n]*---([\s\S]*?)(?=\n--- DOKUMENT \/ TRANSKRIPT \/ VORBEREITUNG:|$)/gi,
    (block, name, body) => {
      const timestamp = name.match(/Transkript_(\d{4}-\d{2}-\d{2})[_-](\d{2})[-:](\d{2})/i);
      if (!timestamp || events.length === 0) {
        return `${block}\n[TRANSKRIPT-ZUORDNUNG: ungeklärt – kein passender Kalenderzeitpunkt ermittelbar]`;
      }

      const transcriptTime = Date.parse(`${timestamp[1]}T${timestamp[2]}:${timestamp[3]}:00`);
      const transcriptText = body.slice(0, 1800).toLowerCase();
      const candidates = events
        .map(event => {
          const minutesAfterEnd = (transcriptTime - event.end) / 60000;
          const words = event.summary.toLowerCase().split(/[^a-z0-9äöüß]+/).filter(word => word.length >= 4);
          const overlap = words.filter(word => transcriptText.includes(word)).length;
          return { event, minutesAfterEnd, overlap };
        })
        .filter(candidate => candidate.minutesAfterEnd >= 0 && candidate.minutesAfterEnd <= 45)
        .sort((a, b) => (b.overlap - a.overlap) || (a.minutesAfterEnd - b.minutesAfterEnd));

      if (candidates.length === 0) {
        return `${block}\n[TRANSKRIPT-ZUORDNUNG: ungeklärt – kein Meeting innerhalb von 45 Minuten vor der Transkription]`;
      }

      const best = candidates[0];
      const confidence = best.overlap > 0 ? 'hoch' : 'mittel';
      return `${block}\n[TRANSKRIPT-ZUORDNUNG: ${confidence} – ${best.event.summary}; Meeting-Ende ${new Date(best.event.end).toISOString()}; ${Math.round(best.minutesAfterEnd)} Minuten bis Transkription; Quelle: ${best.event.url}]`;
    }
  );
}

function loadLocalMemoryContext(): string {
  try {
    const memDir = path.join(process.cwd(), 'agent-memory');
    if (!fs.existsSync(memDir)) return "(Kein lokales Nutzer-Memory vorhanden.)\n";
    const memoryFiles = fs.readdirSync(memDir);
    let memoryText = "AUTORITATIVES NUTZER-MEMORY (neueste explizite Korrekturen; überschreibt widersprüchliche ältere Quellen):\n";
    for (const memoryFile of memoryFiles) {
      if (memoryFile.startsWith('.') || /token|secret|credential/i.test(memoryFile)) continue;
      if (memoryFile.endsWith('.md') || memoryFile.endsWith('.txt') || memoryFile.endsWith('.json')) {
        const content = fs.readFileSync(path.join(memDir, memoryFile), 'utf-8');
        memoryText += `--- NUTZER-MEMORY: "${memoryFile}" ---\n${content}\n\n`;
      }
    }
    return memoryText;
  } catch {
    return "(Lokales Nutzer-Memory konnte nicht geladen werden.)\n";
  }
}

const AVAILABLE_SKILLS: Record<string, string> = {
  'okf-memory-curation': 'okf-memory-curation.md',
  'workspace-context-ingestion': 'workspace-context-ingestion.md',
  'task-state-reconciliation': 'task-state-reconciliation.md',
  'david-one-on-one-preparation': 'david-one-on-one-preparation.md',
  'daily-management-briefing': 'daily-management-briefing.md',
  'project-and-customer-status': 'project-and-customer-status.md',
  'squad-lead-operations': 'squad-lead-operations.md',
  'chat-command-safety': 'chat-command-safety.md',
};

export function loadSkillContext(skillNames: string[]): string {
  const skillsDir = path.join(process.cwd(), 'skills');
  const sections: string[] = [];
  for (const skillName of [...new Set(skillNames)]) {
    const fileName = AVAILABLE_SKILLS[skillName];
    if (!fileName) continue;
    const skillPath = path.join(skillsDir, fileName);
    if (!fs.existsSync(skillPath)) continue;
    sections.push(`--- SKILL: ${skillName} ---\n${fs.readFileSync(skillPath, 'utf-8').trim()}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : '(Keine passenden Skills geladen.)';
}

export async function syncLocalMemoryToDrive(accessToken: string): Promise<string[]> {
  const memDir = path.join(process.cwd(), 'agent-memory');
  if (!fs.existsSync(memDir)) return [];

  const drive = await getDriveClient(accessToken);
  const syncedFiles: string[] = [];

  const syncDirectory = async (localDir: string, parentId: string, relativeDir: string): Promise<void> => {
    const filesRes = await drive.files.list({
      q: `'${parentId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType)',
      pageSize: 100,
    });
    const existingFiles = new Map<string, { id: string; mimeType?: string }>();
    for (const file of filesRes.data.files || []) {
      if (file.id && file.name) existingFiles.set(file.name, { id: file.id, mimeType: file.mimeType });
    }

    for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /token|secret|credential/i.test(entry.name)) continue;
      const localPath = path.join(localDir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        let folderId = existingFiles.get(entry.name)?.id;
        if (!folderId) {
          const folder = await drive.files.create({
            requestBody: { name: entry.name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' },
            fields: 'id',
          });
          folderId = folder.data.id || '';
        }
        if (folderId) await syncDirectory(localPath, folderId, relativePath);
        continue;
      }

      if (!/\.(md|txt|json)$/i.test(entry.name)) continue;
      const body = fs.readFileSync(localPath, 'utf-8');
      const mimeType = entry.name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain';
      const media = { mimeType, body };
      const fileId = existingFiles.get(entry.name)?.id;

      if (fileId) {
        await drive.files.update({ fileId, media });
      } else {
        await drive.files.create({ requestBody: { name: entry.name, parents: [parentId], mimeType }, media });
      }
      syncedFiles.push(relativePath);
    }
  };

  await syncDirectory(memDir, driveFolderId, '');
  return syncedFiles;
}

type StructuredMemoryConcept = {
  category: 'projects' | 'customers' | 'squad' | 'general';
  slug: string;
  type: string;
  title: string;
  description: string;
  tags?: string[];
  status?: 'draft' | 'stable' | 'deprecated';
  stale_after?: string;
  body: string;
  sources?: { id?: string; resource: string; title?: string }[];
};

export type StructuredMemoryChange = {
  kind: 'added' | 'updated';
  category: 'projects' | 'squad';
  slug: string;
  title: string;
  status?: string;
  previousStatus?: string;
  sources?: { resource: string; title?: string }[];
};

type StructuredMemorySnapshot = Record<string, {
  category: 'projects' | 'squad';
  slug: string;
  title: string;
  description: string;
  status?: string;
  body: string;
}>;

const PROJECT_CHANGE_LOG = path.join(process.cwd(), 'agent-memory', 'project-change-log.md');
const PROJECT_CHANGE_SNAPSHOT = path.join(process.cwd(), 'agent-memory', '.project-change-snapshot.json');

function slugifyMemoryTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'concept';
}

function parseStructuredMemoryResponse(text: string): StructuredMemoryConcept[] {
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || text.match(/\[[\s\S]*\]/)?.[0];
  if (!jsonBlock) return [];

  try {
    const parsed = JSON.parse(jsonBlock);
    if (!Array.isArray(parsed)) return [];
    const allowedCategories = new Set<StructuredMemoryConcept['category']>(['projects', 'customers', 'squad', 'general']);
    return parsed.filter((item): item is StructuredMemoryConcept =>
      item && allowedCategories.has(item.category) && typeof item.title === 'string' && typeof item.body === 'string'
    ).slice(0, 20);
  } catch {
    return [];
  }
}

export function normalizeStructuredMemoryCategories(concepts: StructuredMemoryConcept[]): StructuredMemoryConcept[] {
  const projectSignals = /\b(projekt|project|sow|statement of work|migration|migrat|poc|proof of concept|showcase|rollout|fieldservice|budget|funding|workstream|service-konto|systemanalyse|architektur|pipeline|deliverable|liefer)\b/i;
  return concepts.map(concept => {
    const searchable = `${concept.title} ${concept.description} ${concept.body}`;
    if (concept.category === 'customers' && projectSignals.test(searchable)) {
      return { ...concept, category: 'projects', type: 'Project' };
    }
    return concept;
  });
}

function renderStructuredMemoryConcept(concept: StructuredMemoryConcept, generatedAt: string): string {
  const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
  const tags = (concept.tags || []).filter(tag => typeof tag === 'string').map(tag => clean(tag)).filter(Boolean);
  const sources = (concept.sources || []).filter(source => source && typeof source.resource === 'string' && source.resource.trim());
  const lines = [
    '---',
    `type: ${clean(concept.type || 'Reference')}`,
    `title: ${clean(concept.title)}`,
    `description: ${clean(concept.description || concept.title)}`,
    `tags: [${tags.join(', ')}]`,
    `status: ${concept.status || 'stable'}`,
    `generated: { by: process:pcg-agent-memory-manager, at: ${generatedAt} }`,
    `verified: { by: process:pcg-agent-memory-manager, at: ${generatedAt} }`,
  ];
  if (concept.stale_after && /^\d{4}-\d{2}-\d{2}T/.test(concept.stale_after)) {
    lines.push(`stale_after: ${concept.stale_after}`);
  }
  if (sources.length > 0) {
    lines.push('sources:');
    for (const source of sources.slice(0, 8)) {
      lines.push(`  - id: ${clean(source.id || slugifyMemoryTitle(source.title || source.resource))}`);
      lines.push(`    resource: ${clean(source.resource)}`);
      if (source.title) lines.push(`    title: ${clean(source.title)}`);
    }
  }
  lines.push('---', '', concept.body.trim(), '');
  return lines.join('\n');
}

function changeKey(concept: Pick<StructuredMemoryConcept, 'category' | 'slug'>): string {
  return `${concept.category}/${concept.slug}`;
}

function normalizedChangeValue(value: string | undefined): string {
  return (value || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function loadStructuredMemorySnapshot(): StructuredMemorySnapshot {
  try {
    if (!fs.existsSync(PROJECT_CHANGE_SNAPSHOT)) return {};
    return JSON.parse(fs.readFileSync(PROJECT_CHANGE_SNAPSHOT, 'utf-8')) as StructuredMemorySnapshot;
  } catch {
    return {};
  }
}

export function detectStructuredMemoryChanges(
  previous: StructuredMemorySnapshot,
  concepts: StructuredMemoryConcept[],
): StructuredMemoryChange[] {
  const changes: StructuredMemoryChange[] = [];
  for (const concept of concepts) {
    if (concept.category !== 'projects' && concept.category !== 'squad') continue;
    const key = changeKey(concept);
    const old = previous[key];
    const current = {
      category: concept.category,
      slug: concept.slug,
      title: concept.title,
      description: concept.description,
      status: concept.status,
      body: concept.body,
    };
    const materialChange = old && (
      normalizedChangeValue(old.title) !== normalizedChangeValue(current.title) ||
      normalizedChangeValue(old.description) !== normalizedChangeValue(current.description) ||
      normalizedChangeValue(old.status) !== normalizedChangeValue(current.status) ||
      normalizedChangeValue(old.body) !== normalizedChangeValue(current.body)
    );
    if (!old || materialChange) {
      changes.push({
        kind: old ? 'updated' : 'added',
        category: concept.category,
        slug: concept.slug,
        title: concept.title,
        status: concept.status,
        previousStatus: old?.status,
        sources: (concept.sources || []).filter(source => source && typeof source.resource === 'string').map(source => ({ resource: source.resource, title: source.title })),
      });
    }
  }
  return changes;
}

function appendProjectChangeLog(changes: StructuredMemoryChange[], generatedAt: string): void {
  if (changes.length === 0) return;
  const date = generatedAt.slice(0, 10);
  const lines = changes.map(change => {
    const status = change.previousStatus && change.status && change.previousStatus !== change.status
      ? `Status: ${change.previousStatus} -> ${change.status}`
      : `Status: ${change.status || 'nicht angegeben'}`;
    const sources = (change.sources || []).slice(0, 4).map(source => `[${source.title || 'Quelle'}](${source.resource})`).join(', ');
    return [
      `- **${change.kind === 'added' ? 'Neu' : 'Geändert'}**: \`${change.category}/${change.slug}\` – ${change.title}`,
      `  - ${status}`,
      sources ? `  - Quellen: ${sources}` : '  - Quellen: nicht angegeben',
    ].join('\n');
  }).join('\n');
  const existing = fs.existsSync(PROJECT_CHANGE_LOG) ? fs.readFileSync(PROJECT_CHANGE_LOG, 'utf-8') : '# Projekt- und Squad-Änderungslog\n\n';
  fs.writeFileSync(PROJECT_CHANGE_LOG, `${existing.trimEnd()}\n\n## ${date}\n\n${lines}\n`, 'utf-8');
}

function saveStructuredMemorySnapshot(concepts: StructuredMemoryConcept[]): void {
  const snapshot: StructuredMemorySnapshot = {};
  for (const concept of concepts) {
    if (concept.category !== 'projects' && concept.category !== 'squad') continue;
    snapshot[changeKey(concept)] = {
      category: concept.category,
      slug: concept.slug,
      title: concept.title,
      description: concept.description,
      status: concept.status,
      body: concept.body,
    };
  }
  fs.mkdirSync(path.dirname(PROJECT_CHANGE_SNAPSHOT), { recursive: true });
  fs.writeFileSync(PROJECT_CHANGE_SNAPSHOT, JSON.stringify(snapshot, null, 2), 'utf-8');
}

function updateStructuredMemoryIndex(concepts: StructuredMemoryConcept[]): void {
  const memDir = path.join(process.cwd(), 'agent-memory');
  const byCategory = new Map<StructuredMemoryConcept['category'], StructuredMemoryConcept[]>();
  const categories: StructuredMemoryConcept['category'][] = ['projects', 'customers', 'squad', 'general'];
  for (const category of categories) {
    const categoryDir = path.join(memDir, category);
    if (!fs.existsSync(categoryDir)) continue;
    for (const fileName of fs.readdirSync(categoryDir).filter(file => file.endsWith('.md'))) {
      const filePath = path.join(categoryDir, fileName);
      const content = fs.readFileSync(filePath, 'utf-8');
      const title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim() || fileName.replace(/\.md$/, '');
      const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() || 'Kuratiertes Memory-Konzept.';
      const list = byCategory.get(category) || [];
      list.push({ category, slug: fileName.replace(/\.md$/, ''), type: 'Reference', title, description, body: '' });
      byCategory.set(category, list);
    }
  }
  for (const concept of concepts) {
    const list = byCategory.get(concept.category) || [];
    const existingIndex = list.findIndex(item => item.slug === concept.slug);
    if (existingIndex >= 0) list[existingIndex] = concept;
    else list.push(concept);
    byCategory.set(concept.category, list);
  }

  const categoryLabels: Record<StructuredMemoryConcept['category'], string> = {
    projects: 'Projektbezogene Themen',
    customers: 'Kundenbezogene Themen',
    squad: 'Squad- und Teamthemen',
    general: 'Allgemeine Themen und Regeln',
  };
  const lines = [
    '---',
    'okf_version: "0.2"',
    '---',
    '',
    '# PCG Agent Memory',
    '',
    'Strukturiertes OKF-v0.2-Memory aus Workspace-Quellen. Google Tasks bleiben für Aufgabenstatus autoritativ.',
    '',
    '## Dauerhafte Referenzen',
    '',
    '- [Aktive Aufgaben und Memory-Regeln](tasks.md) - Autoritative Aufgaben- und Briefing-Regeln.',
    '- [Änderungslog](log.md) - Chronologische Änderungen an diesem Bundle.',
    '- [Projekt- und Squad-Änderungslog](project-change-log.md) - Erkanntes Hinzukommen und materielle Änderungen.',
  ];
  for (const category of Object.keys(categoryLabels) as StructuredMemoryConcept['category'][]) {
    lines.push('', `## ${categoryLabels[category]}`, '');
    const categoryConcepts = byCategory.get(category) || [];
    if (categoryConcepts.length === 0) {
      lines.push('- Noch keine kuratierten Konzepte.');
    } else {
      for (const concept of categoryConcepts.sort((a, b) => a.title.localeCompare(b.title))) {
        lines.push(`- [${concept.title}](${category}/${slugifyMemoryTitle(concept.slug || concept.title)}.md) - ${concept.description || 'Kuratiertes Memory-Konzept.'}`);
      }
    }
  }
  fs.writeFileSync(path.join(memDir, 'index.md'), `${lines.join('\n')}\n`, 'utf-8');
}

function appendStructuredMemoryLog(concepts: StructuredMemoryConcept[], generatedAt: string): void {
  const logPath = path.join(process.cwd(), 'agent-memory', 'log.md');
  const date = generatedAt.slice(0, 10);
  const entries = concepts.map(concept => `* **Update**: ${concept.category}/${slugifyMemoryTitle(concept.slug || concept.title)}.md aktualisiert.`).join('\n');
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '# Directory Update Log\n';
  fs.writeFileSync(logPath, `${existing.trimEnd()}\n\n## ${date}\n\n${entries || '* **Update**: Kein neues Konzept erzeugt.'}\n`, 'utf-8');
}

export async function generateStructuredMemoryConcepts(input: {
  driveContext: string;
  emailsContext: string;
  eventsContext: string;
  chatsContext: string;
  tasksContext: string;
  localMemoryContext: string;
}): Promise<string[]> {
  const generatedAt = new Date().toISOString();
  const skillContext = loadSkillContext([
    'okf-memory-curation',
    'workspace-context-ingestion',
    'task-state-reconciliation',
    'project-and-customer-status',
    'squad-lead-operations',
  ]);
  const response = await generateAIContent({
    contents: `Erzeuge aus dem folgenden Workspace-Kontext ein kuratiertes OKF-v0.2-Memory. Gib ausschließlich valides JSON als Array zurück.

Die folgenden Skills sind verbindliche Arbeitsanweisungen für diese Kuration:
${skillContext}

Jedes Element muss diese Form haben:
{"category":"projects|customers|squad|general","slug":"stabiler-kebab-case-name","type":"Project|Customer|Squad Topic|Reference","title":"...","description":"Ein Satz.","tags":["..."],"status":"stable","body":"Markdown mit aktuellem Stand, offenen Punkten und relevanten Regeln.","sources":[{"id":"...","resource":"https://...","title":"..."}]}

Regeln:
- Erzeuge nur dauerhaft nützliche Konzepte, maximal 20.
- Trenne strikt: Projekte nach projects/, Kundenthemen nach customers/, Squad-/Teamthemen nach squad/, allgemeine Regeln nach general/.
- Keine erledigten Aufgaben als offen darstellen. Google Tasks mit [ERLEDIGT] sind endgültig erledigt; [OFFEN] bleibt aktiv.
- Keine neuen Aufgaben erfinden. Dokumentiere offene Aufgaben nur, wenn sie aus den Quellen stammen.
- Bevorzuge aktuelle, wiederverwendbare Fakten gegenüber einem Tagesbericht.
- Jede wichtige Aussage muss im Body oder in den sources auf eine Quelle zurückführbar sein.
- Wenn keine belastbare Quelle existiert, lasse das Konzept weg.

--- DRIVE ---
${input.driveContext}
--- E-MAILS ---
${input.emailsContext}
--- KALENDER ---
${input.eventsContext}
--- CHATS ---
${input.chatsContext}
--- GOOGLE TASKS ---
${input.tasksContext}
--- LOKALES MEMORY ---
${input.localMemoryContext}`,
    config: {
      temperature: 0.0,
      systemInstruction: 'Du bist ein präziser Memory-Kurator. Schreibe keine Tageszusammenfassung und keine ACTION_PROPOSALS. Liefere ausschließlich JSON.',
    },
  });

  const concepts = normalizeStructuredMemoryCategories(parseStructuredMemoryResponse(response.text || '')).map(concept => ({
    ...concept,
    slug: slugifyMemoryTitle(concept.slug || concept.title),
  }));
  if (concepts.length === 0) return [];

  const changes = detectStructuredMemoryChanges(loadStructuredMemorySnapshot(), concepts);
  appendProjectChangeLog(changes, generatedAt);
  saveStructuredMemorySnapshot(concepts);

  const memDir = path.join(process.cwd(), 'agent-memory');
  for (const category of ['projects', 'customers', 'squad', 'general']) {
    const categoryDir = path.join(memDir, category);
    if (!fs.existsSync(categoryDir)) continue;
    for (const fileName of fs.readdirSync(categoryDir)) {
      if (fileName.endsWith('.md')) fs.unlinkSync(path.join(categoryDir, fileName));
    }
  }
  for (const concept of concepts) {
    const categoryDir = path.join(memDir, concept.category);
    fs.mkdirSync(categoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(categoryDir, `${concept.slug}.md`),
      renderStructuredMemoryConcept(concept, generatedAt),
      'utf-8'
    );
  }
  updateStructuredMemoryIndex(concepts);
  appendStructuredMemoryLog(concepts, generatedAt);
  return concepts.map(concept => `${concept.category}/${concept.slug}.md`);
}

async function fetchDriveKnowledgeBaseContextLegacy(accessToken: string) {
  try {
    const drive = await getDriveClient(accessToken);
    
    // 1. Files from knowledge base folder
    const folderFiles = await listAllFiles(drive, driveFolderId);
    
    // 2. Search Drive broadly for Google Docs, Sheets, Presentations, Markdown, text files, and CSVs
    let broadFiles: any[] = [];
    try {
      const broadQuery = "trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.presentation' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'text/csv' or mimeType = 'application/pdf')";
      const res = await drive.files.list({
        q: broadQuery,
        pageSize: 100,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
      });
      broadFiles = res.data.files || [];
    } catch (searchErr: any) {
      console.warn("Broad Drive search notice:", searchErr?.message || searchErr);
    }

    // 3. Targeted search 1: Specific customer, preparation, and project documents
    let targetedFiles: any[] = [];
    try {
       const targetQuery = "trashed = false and (name contains 'Schwarz' or name contains 'DSV' or name contains 'Vorbereitung' or name contains 'Use Case' or name contains 'Memory' or name contains 'Briefing' or name contains 'Meeting' or name contains 'Protokoll' or name contains 'Transkript' or name contains 'Transcript' or name contains 'Notes' or name contains 'Sync' or name contains 'Weekly' or name contains 'Wochen' or name contains 'Besprechung' or name contains 'Koenig' or name contains 'Bauer' or name contains 'PK' or name contains 'Lorenz' or name contains 'domcura' or name contains 'voestalpine' or name contains 'VOEST' or name contains 'Alpine' or name contains 'Fabian' or name contains 'Mario' or name contains 'Panda' or name contains 'Auslastung' or name contains 'Kapazität' or name contains 'Staffing' or name contains 'Billability' or name contains 'Allocation' or name contains 'Resource')";
      const res = await drive.files.list({
        q: targetQuery,
        pageSize: 60,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
      });
      targetedFiles = res.data.files || [];
    } catch (targetErr: any) {
      console.warn("Targeted Drive search notice:", targetErr?.message || targetErr);
    }

    // 4. Targeted search 2: Onboarding, Einarbeitung, Mitarbeiter, September, Team, Training
    let onboardingFiles: any[] = [];
    try {
      const onboardingQuery = "trashed = false and (name contains 'Einarbeitung' or name contains 'Einarbeitungsplan' or name contains 'Onboarding' or name contains 'Mitarbeiter' or name contains 'Plan' or name contains 'September' or name contains 'Welcome' or name contains 'Joiner' or name contains 'Schulung' or name contains 'Training' or name contains 'Squad' or name contains 'DATA' or name contains 'Handover')";
      const res = await drive.files.list({
        q: onboardingQuery,
        pageSize: 60,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
      });
      onboardingFiles = res.data.files || [];
    } catch (onboardingErr: any) {
      console.warn("Onboarding Drive search notice:", onboardingErr?.message || onboardingErr);
    }

    // Combine files, removing duplicates by ID
    const fileMap = new Map<string, any>();
    for (const f of folderFiles) {
      fileMap.set(f.id, f);
    }
    for (const f of broadFiles) {
      if (!fileMap.has(f.id)) {
        fileMap.set(f.id, { ...f, path: f.name });
      }
    }
    for (const f of targetedFiles) {
      if (!fileMap.has(f.id)) {
        fileMap.set(f.id, { ...f, path: f.name });
      }
    }
    for (const f of onboardingFiles) {
      if (!fileMap.has(f.id)) {
        fileMap.set(f.id, { ...f, path: f.name });
      }
    }

    const allFiles = Array.from(fileMap.values());
    const eligibleFiles = allFiles.filter(f => 
      f.mimeType === 'text/markdown' || 
      f.mimeType === 'text/plain' || 
      f.mimeType === 'text/csv' ||
      f.mimeType.includes('google-apps.document') ||
      f.mimeType.includes('google-apps.spreadsheet') ||
      f.mimeType.includes('google-apps.presentation') ||
      f.name.endsWith('.md') ||
      f.name.endsWith('.txt') ||
      f.name.endsWith('.csv') ||
      /einarbeitung|onboarding|mitarbeiter|plan|september|welcome|joiner|schulung|training|squad|data|schwarz|dsv|vorbereitung|use\s*case|protokoll|transkript|transcript|meeting|notes|briefing|koenig|bauer|pk|lorenz|domcura|voest|alpine/i.test(f.name)
    );

    // Ingest all relevant active notes without dropping projects.
    // Filter out huge raw binary / data dump files and keep clean project context under 220k input tokens (~800k chars)
    eligibleFiles.sort((a, b) => {
      const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
      const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
      return timeB - timeA;
    });

    const topFiles = eligibleFiles.slice(0, 20);

    let contextData = "";
    for (const file of topFiles) {
      const content = await getFileContent(drive, file.id, file.mimeType);
      if (content && typeof content === 'string') {
        const fullOrLargeContent = content.length > 2500 ? content.slice(0, 2500) + "\n...[Gekürzt bei 2.500 Zeichen]" : content;
        
        const modDateObj = file.modifiedTime ? new Date(file.modifiedTime) : null;
        const modDateStr = modDateObj ? modDateObj.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
        const isOnboardingOrFuturePlan = /einarbeitung|onboarding|mitarbeiter|plan|september|schulung|welcome|new\s*joiner/i.test(file.path || file.name) || /einarbeitung|onboarding|september|neuer\s*mitarbeiter/i.test(fullOrLargeContent.slice(0, 500));
        
        let ageNotice = '';
        if (isOnboardingOrFuturePlan) {
          ageNotice = ` [🌟 STRATEGISCHER / OPERATIVER ZUKUNFTS-PLAN & VORBEREITUNG (z. B. Onboarding / Einarbeitung September) - HOHE PRIORITÄT FÜR SQUAD LEAD HARDY - PROAKTIV VORBEREITUNGS-TODOS ABLEITEN!]`;
        } else if (modDateObj) {
          const diffDays = Math.floor((Date.now() - modDateObj.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDays <= 3) {
            ageNotice = ` [🚨 FRISCH / KÜRZLICH BEARBEITET (${modDateStr}) - ENTHÄLT AKTUELLE NOTIZEN & VORBEREITUNG!]`;
          } else if (diffDays > 28) {
            const weeksAgo = Math.floor(diffDays / 7);
            ageNotice = ` [⚠️ HISTORISCHES DOKUMENT - Zuletzt geändert vor ${weeksAgo} Wochen (am ${modDateStr}). MANDATORISCHE AKTUALITÄTSPRÜFUNG: Nur als Hintergrundwissen nutzen, KEINE alten Themen/To-Dos daraus als aktiv oder offen präsentieren!]`;
          } else if (diffDays > 10) {
            ageNotice = ` [Älterer Stand (geändert vor ${diffDays} Tagen am ${modDateStr}) - Bitte vor Erwähnung prüfen, ob Thema noch aktiv ist]`;
          } else {
            ageNotice = ` (Stand: ${modDateStr})`;
          }
        }

        const isCustomerPrep = /schwarz|dsv|vorbereitung|use\s*case/i.test(file.path || file.name);
        const prepHighlight = isCustomerPrep ? ' [⭐ KUNDEN-VORBEREITUNGS-DOKUMENT]' : '';
        const docUrl = file.webViewLink || (file.mimeType.includes('google-apps.document') ? `https://docs.google.com/document/d/${file.id}/edit` : file.mimeType.includes('google-apps.spreadsheet') ? `https://docs.google.com/spreadsheets/d/${file.id}/edit` : `https://drive.google.com/file/d/${file.id}/view`);

        recordVerbatimEvidence([{
          sourceType: 'drive',
          sourceId: file.id,
          content,
          sourceTimestamp: file.modifiedTime,
          sourceUrl: docUrl,
          metadata: { name: file.name, path: file.path, mimeType: file.mimeType },
        }]);

        contextData += `--- DOKUMENT / TRANSKRIPT / VORBEREITUNG: "${file.path || file.name}" | Direktlink: ${docUrl}${prepHighlight}${ageNotice} ---\n${fullOrLargeContent}\n\n`;
      }
    }
    const localMem = loadLocalMemoryContext();
     return (contextData + '\n--- LOKALES MEMORY / HINTERGRUND (gegen aktuelle datierte Quellen prüfen) ---\n' + localMem) || "(Keine Dokumente, Meeting-Protokolle oder Transkripte im Google Drive gefunden.)\n";
  } catch (e: any) {
    console.warn("Drive knowledge base fetch notice:", e?.message || e);
    return "(Dokumente / Meeting-Protokolle aus Google Drive konnten nicht geladen werden)\n";
  }
}

function extractCurrentSquadSignals(driveContext: string, chatsContext: string): string {
  const currentDrive = driveContext.split('\n--- LOKALES MEMORY / HINTERGRUND')[0];
  const driveBlocks = currentDrive.match(/--- DOKUMENT \/ TRANSKRIPT[\s\S]*?(?=\n--- DOKUMENT \/ TRANSKRIPT|$)/g) || [];
  const currentSourceBlocks = driveBlocks.filter(block => !/(?:^|\s)(?:projects|customers|squad|general)\/[^\s"|]+\.md/i.test(block));
  const relevantBlocks = currentSourceBlocks.filter(block => /panda|mario|auslastung|kapazität|neue[nr]?\s+projekte|staffing|resource planner|billability|allocation/i.test(block));
  const chatLines = chatsContext.split(/\r?\n/).filter(line => /panda|mario|auslastung|kapazität|neue[nr]?\s+projekte|staffing|resource planner|billability|allocation/i.test(line));
  const signals = [
    ...relevantBlocks.slice(0, 4).map(block => block.slice(0, 2000)),
    chatLines.slice(0, 40).join('\n'),
  ].filter(Boolean).join('\n\n');
  return signals || '(Keine aktuelle datierte Squad-Auslastungsquelle für Panda oder Mario gefunden.)';
}

export function extractProjectCapacityEvidence(driveContext: string, emailsContext: string, chatsContext: string): string {
  const evidencePattern = /projekt|project|sow|statement of work|aufwand|budget|pipeline|kapaz|auslast|staffing|allocation|billability|resource planner|booking|bench|unassigned|presales|sbe|service before/i;
  const currentDrive = driveContext.split('\n--- LOKALES MEMORY / HINTERGRUND')[0];
  const driveBlocks = currentDrive.match(/--- DOKUMENT \/ TRANSKRIPT[\s\S]*?(?=\n--- DOKUMENT \/ TRANSKRIPT|$)/g) || [];
  const sourceBlocks = driveBlocks
    .filter(block => !/(?:^|\s)(?:projects|customers|squad|general)\/[^\s"|]+\.md/i.test(block))
    .filter(block => evidencePattern.test(block))
    .slice(0, 15)
    .map(block => block.slice(0, 2500));
  const messageLines = `${emailsContext}\n${chatsContext}`
    .split(/\r?\n/)
    .filter(line => evidencePattern.test(line))
    .slice(0, 100);
  return [...sourceBlocks, messageLines.join('\n')].filter(Boolean).join('\n\n') || '(Keine projekt- oder kapazitätsbezogenen Quellen gefunden.)';
}

export function sanitizeCurrentSquadCapacityClaims(text: string, currentSquadSignals: string): string {
  const sourceUrl = currentSquadSignals.match(/Direktlink:\s*(https?:\S+)/i)?.[1];
  const capacityClaim = /(?:\*\*)?\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+){0,2})(?:\*\*)?\s+(?:ist|sind)\s+(voll ausgelastet(?:\s*\/\s*regulär im Einsatz)?|unausgelastet|im Bench|auf Bench|ohne Auslastung|hat keine Kapazität|hat freie Kapazität)/gi;
  return text.replace(capacityClaim, (full, person: string) => {
    const currentPersonSignal = new RegExp(`${person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,3000}(auslast|kapaz|pipeline|projekt|resource planner|billability|allocation)`, 'i').test(currentSquadSignals);
    const currentAvailabilitySignal = new RegExp(`${person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,3000}(keine klare pipeline|kein festes budget|hat kapazität|freie kapazität|neue[nr]?\\s+projekte|weitere ideen)`, 'i').test(currentSquadSignals);
    if (currentAvailabilitySignal) {
      const noPipeline = new RegExp(`${person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,3000}(keine klare pipeline|kein festes budget)`, 'i').test(currentSquadSignals);
      const signal = noPipeline
        ? 'meldet aktuell keine klare Pipeline beziehungsweise kein festes Budget und fragt nach weiteren Projekten'
        : 'meldet laut aktueller datierter Quelle Kapazitätsbedarf beziehungsweise Interesse an neuen Projekten';
      return `${person} ${signal}${sourceUrl ? ` [Quelle: aktuelle Squad-Quelle](${sourceUrl})` : ''}`;
    }
    if (currentPersonSignal) return full;
    return `${person}s aktueller Auslastungsstatus ist in den jüngsten datierten Weekly-/Transcript-Quellen nicht belegt; der alte Status wird nicht fortgeschrieben${sourceUrl ? ` [Quelle: aktuelle Squad-Quelle](${sourceUrl})` : ''}`;
  });
}

function titleFromMemoryPath(value: string): string {
  return value
    .replace(/\.md$/i, '')
    .split(/[-_/]+/)
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ')
    .replace(/\bVoestalpine\b/i, 'VOEST Alpine')
    .replace(/\bKoenig Und Bauer\b/i, 'Koenig & Bauer');
}

export function validateDailyBriefingStructure(text: string): string {
  const expectedSections = [
    '## 1. [ÄNDERUNG] Projekt- und Kapazitätsänderungen',
    '## 2. Squad Lead Control',
    '## 3. 🚨 Proaktive Kunden- & Meeting-Vorbereitung',
    '## 4. 🔮 Vorausschau & Wochenausblick',
    '## 5. 🚨 Dringende Klärungen & Projekt-To-dos',
    '## 6. 💡 Weitere nächste Schritte',
    '## 7. 📋 Kompakte Projektstatusübersicht',
  ];
  const missing = expectedSections.filter(section => !text.includes(section));
  if (missing.length > 0) {
    console.warn(`[Briefing Structure] Fehlende Abschnitte: ${missing.join(', ')}`);
  }

  const firstSectionIndex = text.indexOf('## 1. [ÄNDERUNG]');
  const titleEnd = text.indexOf('\n', text.indexOf('# ☀️'));
  let normalized = firstSectionIndex > 0 && titleEnd >= 0
    ? `${text.slice(0, titleEnd + 1)}\n${text.slice(firstSectionIndex)}`
    : text;

  const statusSectionStart = normalized.indexOf('## 7. 📋 Kompakte Projektstatusübersicht');
  const statusSectionEnd = normalized.indexOf('\n<ACTION_PROPOSALS>', statusSectionStart);
  if (statusSectionStart >= 0) {
    const end = statusSectionEnd >= 0 ? statusSectionEnd : normalized.length;
    const section = normalized.slice(statusSectionStart, end);
    const lines = section.split('\n');
    const repaired: string[] = [];
    let currentItem = false;
    let itemHasStatus = false;
    let skipOrphanBlock = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (skipOrphanBlock) {
        if (/^-\s+\*\*/.test(line) || /^---/.test(line)) {
          skipOrphanBlock = false;
        } else {
          continue;
        }
      }
      if (/^-\s+\*\*/.test(line)) {
        currentItem = true;
        itemHasStatus = false;
      }
      if (!line.trim() && itemHasStatus) currentItem = false;
      if (/^\s*[•-]\s+\*\*Status:\*\*/.test(line) && !currentItem) {
        const remaining = lines.slice(index).join('\n');
        const sourcePath = remaining.match(/(?:projects|customers)\/([a-z0-9-]+)\.md/i)?.[1];
        if (sourcePath) {
          repaired.push(`- **${titleFromMemoryPath(sourcePath)}**`);
          currentItem = true;
        } else {
          console.warn('[Briefing Structure] Verwaister Projektstatus ohne ermittelbaren Projekttitel.');
          skipOrphanBlock = true;
          continue;
        }
      }
      if (/^\s*[•-]\s+\*\*Status:\*\*/.test(line)) itemHasStatus = true;
      repaired.push(line);
    }
    normalized = `${normalized.slice(0, statusSectionStart)}${repaired.join('\n')}${normalized.slice(end)}`;
  }
  return normalized;
}

// --- GOOGLE WORKSPACE ACTIONS ENDPOINTS & SANITIZATION ---

function applyCanonicalSpellingCorrections(text: string): string {
  if (!text) return "";
  let corrected = text;
  corrected = corrected.replace(/\bDom\s*Kura\b/gi, 'domcura');
  corrected = corrected.replace(/\bDomKura\b/g, 'domcura');
  corrected = corrected.replace(/\bFirst\s*Alpina\b/gi, 'VOEST Alpine');
  corrected = corrected.replace(/\bFirst\s*Alpine\b/gi, 'VOEST Alpine');
  corrected = corrected.replace(
    /-\s+\*\*Kantonsspital\s+Graub[üu]nden\*\*\s*(\r?\n\s*[•-]\s+\*\*Status:\*\*[\s\S]*?(?:Avantgarde|Patrik M[öo]ller))/gi,
    '- **Avantgarde**$1'
  );
  return corrected;
}

function normalizeTaskComparisonText(value: string): string {
  const stopWords = new Set([
    'aber', 'als', 'am', 'an', 'auf', 'aus', 'bei', 'bis', 'das', 'den', 'der', 'die', 'ein', 'eine',
    'fuer', 'für', 'im', 'in', 'ist', 'mit', 'nach', 'oder', 'und', 'von', 'vor', 'zu', 'zum', 'zur'
  ]);
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 1 && !stopWords.has(word))
    .join(' ');
}

function areTaskTextsSimilar(first: string, second: string): boolean {
  const a = normalizeTaskComparisonText(first);
  const b = normalizeTaskComparisonText(second);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a))) return true;

  const aWords = new Set(a.split(' '));
  const bWords = new Set(b.split(' '));
  const common = [...aWords].filter(word => bWords.has(word)).length;
  const smallerSize = Math.min(aWords.size, bWords.size);
  if (smallerSize === 0) return false;
  const overlap = common / smallerSize;
  return (common >= 3 && overlap >= 0.5) || (common >= 2 && overlap >= 0.8);
}

function extractGoogleTaskStates(tasksContext?: string): { open: string[]; completed: string[] } {
  const result = { open: [] as string[], completed: [] as string[] };
  if (!tasksContext) return result;

  for (const line of tasksContext.split('\n')) {
    const match = line.match(/^- \[(OFFEN|ERLEDIGT)\] (.*?)(?= \|)/);
    if (!match) continue;
    (match[1] === 'OFFEN' ? result.open : result.completed).push(match[2].trim());
  }
  return result;
}

function removeCompletedTaskRecommendations(text: string, completedTitles: string[], openTitles: string[] = []): string {
  if (completedTitles.length === 0) return text;
  const sectionStart = text.search(/^## 4\.\s/m);
  if (sectionStart < 0) return text;

  const actionStart = text.indexOf('<ACTION_PROPOSALS>', sectionStart);
  const sectionEnd = actionStart >= 0 ? actionStart : text.length;
  const before = text.slice(0, sectionStart);
  const section = text.slice(sectionStart, sectionEnd).replace(
    /^- \*\*([^*\n]+)\*\*[\s\S]*?(?=^- \*\*|$)/gm,
    (block, title) => completedTitles.some(completed => areTaskTextsSimilar(title, completed)) &&
       !openTitles.some(open => areTaskTextsSimilar(title, open)) ? '' : block
  );
  return before + section + text.slice(sectionEnd);
}

function removeStaleNextStepsFromProjectStatus(text: string, completedTitles: string[]): string {
  if (completedTitles.length === 0) return text;
  const sec2Start = text.search(/^## 2\.\s/m);
  if (sec2Start < 0) return text;
  const sec2End = text.search(/^## 3\.\s/m);
  const section = text.slice(sec2Start, sec2End >= 0 ? sec2End : text.length);

  const cleaned = section.replace(
    /(\*\*Nächste Schritte:\*\*\s*)([^\n•]+)/gi,
    (_match, prefix: string, body: string) => {
      const sentences = body.split(/(?<=\.)\s+/).filter((s: string) => s.trim());
      const kept = sentences.filter((s: string) => !completedTitles.some(c => areTaskTextsSimilar(s, c)));
      return kept.length > 0 ? prefix + kept.join(' ') : '';
    }
  );

  return text.slice(0, sec2Start) + cleaned + (sec2End >= 0 ? text.slice(sec2End) : '');
}

function applyAuthoritativeProjectCorrections(text: string): string {
  return text.replace(
    /(^|\n)(- \*\*SUSE\*\*[\s\S]*?)(?=\n- \*\*|\n---|$)/gi,
    (_match, prefix, block) => prefix + block.replace(/^\s*•?\s*\*\*Nächste Schritte:\*\*[^\n]*Kickoff[^\n]*\n?/gim, '')
  );
}

export function sanitizeActionProposals(text: string, tasksContext?: string, eventsContext?: string): string {
  if (!text) return text;
  text = applyCanonicalSpellingCorrections(text);
  text = applyAuthoritativeProjectCorrections(text);
  const taskStates = extractGoogleTaskStates(tasksContext);
  text = removeStaleNextStepsFromProjectStatus(text, taskStates.completed);
  if (!text.includes('<ACTION_PROPOSALS>')) {
    text = removeCompletedTaskRecommendations(text, taskStates.completed, taskStates.open);
    text = convertMarkdownTablesToCleanText(text);
    text = text.replace(/###?\s*📅?\s*Datenbasis\s*&?\s*Zeiträume[\s\S]*?(?=(?:###?|\n\n[1-5]\.|\n\n[A-Z]))/gi, '').trim();
    text = text.replace(/-\s*\*\*Kalender:\*\*[\s\S]*?(?=\n\n|\n[1-5]\.)/gi, '').trim();
    return text;
  }

  const match = text.match(/<ACTION_PROPOSALS>([\s\S]*?)<\/ACTION_PROPOSALS>/);
  if (!match) return removeCompletedTaskRecommendations(text, taskStates.completed, taskStates.open);

  const todayISO = new Date().toISOString().split('T')[0];

  // Extract today's & tomorrow's meeting titles, descriptions and participants for intelligent cross-referencing
  const todayMeetingKeywords: string[] = [];
  if (eventsContext) {
    const eventLines = eventsContext.split('\n');
    for (const line of eventLines) {
      if (line.includes('[🚨 HEUTE') || line.includes('[HEUTE') || line.includes('[🚨 MORGEN') || line.includes('[MORGEN') || line.includes(todayISO)) {
        const lineLower = line.toLowerCase();
        // Extract common person/client names or terms from meeting summaries
        const words = lineLower.split(/[\s,:;|()/\-]+/).filter(w => w.length > 2 && !['termin', 'uhr', 'bis', 'mit', 'und', 'heute', 'morgen', 'anstehend', 'details', 'ort', 'teilnehmer'].includes(w));
        todayMeetingKeywords.push(...words);
      }
    }
  }

  try {
    let rawJson = match[1].trim();
    // Remove markdown code fences if generated by LLM
    rawJson = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const proposals = JSON.parse(rawJson);

    if (Array.isArray(proposals)) {
      let modified = false;
      const filteredProposals: any[] = [];

      for (const p of proposals) {
        const titleLower = (p.title || p.details?.title || '').toLowerCase().trim();
        const notesLower = (p.details?.notes || p.details?.body || '').toLowerCase().trim();

        const proposalTitle = (p.details?.title || p.title || '').toLowerCase().trim();
        const matchesCompletedTask = taskStates.completed.some(completed => areTaskTextsSimilar(proposalTitle, completed));
        if (matchesCompletedTask) {
          console.log(`[Completed Task Filter] Removed proposal matching completed Google Task: "${p.title}"`);
          modified = true;
          continue;
        }

        // 2. FILTER OUT IGNORED INTERNAL MEETINGS (Thursdays for Data)
        if (/thursdays?\s+(for|4)\s+data/i.test(titleLower) || /thursdays?\s+(for|4)\s+data/i.test(notesLower)) {
          console.log(`[Ignored Meeting Filter] Removed proposal for Thursdays for Data: "${p.title}"`);
          modified = true;
          continue;
        }

        // 3. INTELLIGENT CALENDAR CROSS-REFERENCING:
        // If there is already a meeting today with a person (e.g. Marion) or customer,
        // do not propose a redundant task or email like "Kümmere dich um Marion bzgl. Auslastung" or "E-Mail an Marion".
        const isMeetingRedundant = todayMeetingKeywords.some(keyword => {
          if (keyword.length < 3) return false;
          const matchesKeyword = titleLower.includes(keyword) || notesLower.includes(keyword);
          if (!matchesKeyword) return false;

          // Check if this action proposal is about contacting, talking to, checking status, or discussing a topic with that person
          const isDiscussAction = /auslastung|staffing|nachhaken|nachfragen|kontakt|besprechen|abstimmen|kümmern|status|checkin|sync|1:1|update|gespräch/i.test(titleLower) ||
                                  /auslastung|staffing|nachhaken|nachfragen|kontakt|besprechen|abstimmen|kümmern|status|checkin|sync|1:1|update|gespräch/i.test(notesLower);
          return isDiscussAction;
        });

        if (isMeetingRedundant) {
          console.log(`[Calendar Cross-Check] Removed redundant Doing/Action proposal "${p.title}" because a meeting covering this topic/person is already scheduled today!`);
          modified = true;
          continue;
        }

        // Existing open tasks remain authoritative and must not be duplicated by any action proposal.
        if (taskStates.open.some(open => areTaskTextsSimilar(proposalTitle, open))) {
          console.log(`[Open Task Deduplication] Removed proposal matching open Google Task: "${p.title}"`);
          modified = true;
          continue;
        }

        if (p.details) {
          // Check dueDate - ensure it's not in the past
          if (p.details.dueDate && typeof p.details.dueDate === 'string') {
            const d = new Date(p.details.dueDate);
            if (!isNaN(d.getTime())) {
              const iso = d.toISOString().split('T')[0];
              if (iso < todayISO) {
                p.details.dueDate = todayISO;
                modified = true;
              }
            }
          }
          // Check startTime - ensure it's not in the past
          if (p.details.startTime && typeof p.details.startTime === 'string') {
            const d = new Date(p.details.startTime);
            if (!isNaN(d.getTime())) {
              const iso = d.toISOString().split('T')[0];
              if (iso < todayISO) {
                const timePart = p.details.startTime.includes('T') ? p.details.startTime.split('T')[1] : '10:00:00';
                p.details.startTime = `${todayISO}T${timePart}`;
                modified = true;
              }
            }
          }
        }

        filteredProposals.push(p);
      }

      if (modified) {
        if (filteredProposals.length === 0) {
          text = text.replace(match[0], '');
        } else {
          const fixedJson = JSON.stringify(filteredProposals, null, 2);
          text = text.replace(match[0], `<ACTION_PROPOSALS>\n${fixedJson}\n</ACTION_PROPOSALS>`);
        }
      }
    }
  } catch (e) {
    console.warn("Could not parse/sanitize action proposals JSON:", e);
  }

  text = removeCompletedTaskRecommendations(text, taskStates.completed, taskStates.open);

  // 5. Convert any markdown tables to clean bullet and paragraph formatting
  text = convertMarkdownTablesToCleanText(text);

  // 6. Strip any residual data sources / catalog lists from header
  text = text.replace(/###?\s*📅?\s*Datenbasis\s*&?\s*Zeiträume[\s\S]*?(?=(?:###?|\n\n[1-5]\.|\n\n[A-Z]))/gi, '').trim();
  text = text.replace(/-\s*\*\*Kalender:\*\*[\s\S]*?(?=\n\n|\n[1-5]\.)/gi, '').trim();

  return text;
}

function ensureCriticalProjectTasks(summary: string, sourceContext: string, tasksContext: string, dueDate: string): string {
  const wireguardTitle = 'HHA: WireGuard-Zugang für Kundeninfrastruktur einrichten';
  if (!/wireguard/i.test(sourceContext)) {
    return summary;
  }

  const taskStates = extractGoogleTaskStates(tasksContext);
  if (taskStates.open.some(task => areTaskTextsSimilar(wireguardTitle, task) || /wireguard|timo\s+dempwolf/i.test(task) || /public\s+keys?.*hha|hha.*public\s+keys?/i.test(task))) {
    return summary;
  }

  const sourceLine = sourceContext.split('\n').find(line => /wireguard/i.test(line)) || 'Aktueller HHA-Kontext nennt persönliche WireGuard-Keys für den Kundeninfrastrukturzugang.';
  const sourceUrl = sourceLine.match(/https?:\/\/[^\s|)]+/)?.[0] || 'https://tasks.google.com/';
  const proposal = {
    id: 'critical-wireguard',
    type: 'task',
    title: wireguardTitle,
    details: {
      title: wireguardTitle,
      notes: `Beim Kunden Hamburger Hochbahn persönlichen WireGuard-Key über Timo Dempwolf einrichten lassen, damit der Zugriff auf GitLab/Kundeninfrastruktur für das HHA AI Gateway möglich ist. Quelle: ${sourceUrl}`,
      dueDate,
    },
  };
  const actionMatch = summary.match(/<ACTION_PROPOSALS>([\s\S]*?)<\/ACTION_PROPOSALS>/i);
  if (actionMatch) {
    const raw = actionMatch[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const proposals = JSON.parse(raw);
      if (Array.isArray(proposals)) {
        if (proposals.some((proposal: any) => proposal?.type === 'task' && /wireguard|timo\s+dempwolf/i.test(`${proposal.title || ''} ${proposal.details?.title || ''} ${proposal.details?.notes || ''}`))) {
          return summary;
        }
        proposals.push(proposal);
        return summary.replace(actionMatch[0], `<ACTION_PROPOSALS>\n${JSON.stringify(proposals, null, 2)}\n</ACTION_PROPOSALS>`);
      }
    } catch {
      // Fall through and append a clean proposal block.
    }
  }
  return `${summary.trim()}\n\n<ACTION_PROPOSALS>\n${JSON.stringify([proposal], null, 2)}\n</ACTION_PROPOSALS>`;
}

function ensureActionSectionTasks(summary: string, tasksContext: string, fallbackDueDate: string): string {
  const taskStates = extractGoogleTaskStates(tasksContext);
  const actionMatch = summary.match(/<ACTION_PROPOSALS>([\s\S]*?)<\/ACTION_PROPOSALS>/i);
  let proposals: any[] = [];
  if (actionMatch) {
    try {
      proposals = JSON.parse(actionMatch[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
    } catch {
      proposals = [];
    }
  }

  const additions: any[] = [];
  for (const sectionTitle of ['## 5. 🚨 Dringende Klärungen & Projekt-To-dos', '## 6. 💡 Weitere nächste Schritte']) {
    const sectionStart = summary.indexOf(sectionTitle);
    if (sectionStart < 0) continue;
    const nextSection = summary.indexOf('\n## ', sectionStart + sectionTitle.length);
    const actionBlock = summary.indexOf('\n<ACTION_PROPOSALS>', sectionStart);
    const sectionEnd = [nextSection, actionBlock].filter(index => index >= 0).sort((a, b) => a - b)[0] || summary.length;
    const section = summary.slice(sectionStart, sectionEnd);
    const itemPattern = /^- \*\*(.+?)\*\*(?:\s+—\s+Fälligkeit:\s+(\d{4}-\d{2}-\d{2}))?[\s\S]*?(?=\n- \*\*|$)/gm;
    for (const match of section.matchAll(itemPattern)) {
      const title = match[1].trim();
      if (!title || /^(Weitere nächste Schritte|Dringende Klärungen)/i.test(title)) continue;
      const dueDate = match[2] || fallbackDueDate;
      const details = match[0].replace(/^- \*\*.+?\*\*/, '').replace(/—\s+Fälligkeit:\s+\d{4}-\d{2}-\d{2}/, '').replace(/\s+/g, ' ').trim();
      const proposalText = `${title} ${details}`;
      const alreadyRepresented = [...taskStates.open, ...taskStates.completed].some(task => areTaskTextsSimilar(title, task)) ||
        proposals.some(proposal => proposal?.type === 'task' && areTaskTextsSimilar(title, proposal.details?.title || proposal.title || '')) ||
        additions.some(proposal => areTaskTextsSimilar(title, proposal.details?.title || proposal.title || ''));
      if (alreadyRepresented) continue;
      additions.push({
        id: `section-task-${additions.length + 1}`,
        type: 'task',
        title,
        details: { title, notes: details || `Konkrete Aktion aus dem Daily-Abschnitt: ${title}`, dueDate },
      });
    }
  }

  if (additions.length === 0) return summary;
  const merged = [...proposals, ...additions];
  const serialized = `<ACTION_PROPOSALS>\n${JSON.stringify(merged, null, 2)}\n</ACTION_PROPOSALS>`;
  return actionMatch ? summary.replace(actionMatch[0], serialized) : `${summary.trim()}\n\n${serialized}`;
}

function convertMarkdownTablesToCleanText(text: string): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const resultLines: string[] = [];
  let inTable = false;
  let headers: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Check if line looks like a markdown table row: | cell1 | cell2 |
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());

      // Skip delimiter/alignment row like |---|---| or |:---:|---:|
      if (cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c))) {
        continue;
      }

      if (!inTable) {
        // First row of table is header
        inTable = true;
        headers = cells;
      } else {
        // Data row
        if (cells.length > 0) {
          const col0 = cells[0];
          const details: string[] = [];

          for (let cIdx = 1; cIdx < cells.length; cIdx++) {
            const val = cells[cIdx];
            if (val) {
              const hName = headers[cIdx] || '';
              if (hName && !['value', 'wert', 'inhalt'].includes(hName.toLowerCase())) {
                details.push(`${hName}: ${val}`);
              } else {
                details.push(val);
              }
            }
          }

          if (details.length > 0) {
            resultLines.push(`  • ${col0} — ${details.join(' | ')}`);
          } else {
            resultLines.push(`  • ${col0}`);
          }
        }
      }
    } else {
      if (inTable) {
        inTable = false;
        headers = [];
        resultLines.push(''); // spacing after table
      }
      resultLines.push(rawLine);
    }
  }

  return resultLines.join('\n');
}

export function cleanContentForEmail(text: string): string {
  if (!text) return "";
  let cleanText = applyCanonicalSpellingCorrections(text);

  // 1. Remove <ACTION_PROPOSALS>...</ACTION_PROPOSALS> block entirely
  cleanText = cleanText.replace(/<ACTION_PROPOSALS>[\s\S]*?<\/ACTION_PROPOSALS>/gi, '');

  // 2. Remove any orphaned tags if left behind
  cleanText = cleanText.replace(/<ACTION_PROPOSALS>/gi, '');
  cleanText = cleanText.replace(/<\/ACTION_PROPOSALS>/gi, '');

  // 3. Convert markdown tables to clean formatted bullet points
  cleanText = convertMarkdownTablesToCleanText(cleanText);

  // 4. Clean up multiple excessive empty lines
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  // 5. Remove any legacy data basis source block if present
  cleanText = cleanText.replace(/###?\s*📅?\s*Datenbasis\s*&?\s*Zeiträume[\s\S]*?(?=(?:###?|\n\n[1-5]\.|\n\n[A-Z]))/gi, '').trim();
  cleanText = cleanText.replace(/-\s*\*\*Kalender:\*\*[\s\S]*?(?=\n\n|\n[1-5]\.)/gi, '').trim();

  return cleanText;
}

export function getActionProposalsInstruction(): string {
  const todayISO = new Date().toISOString().split('T')[0];
  const todayGerman = new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `
WICHTIG FÜR KONKRETE NÄCHSTE SCHRITTE & AKTIONEN (STAND HEUTE: ${todayGerman}, ${todayISO}):

MANDATORISCHE VORHERIGE AKTUALITÄTS- & RELEVANZ-PRÜFUNG:
1. VOR JEDER AUSGABE EINES THEMAS ODER TO-DOS: Prüfe immer vorher, ob das Thema tatsächlich noch aktuell und aktiv ist!
2. Wenn eine Information oder ein E-Mail-Thread älter als 1-2 Wochen ist und seither kein neuer Termin, kein neuer Austausch und keine offene Google Task dazu existiert, gilt das Thema als historisch/abgeschlossen und darf NICHT als neue Priorität oder aktives To-Do angezeigt werden.
3. Inhalte aus dem Papierkorb (Trash) oder alte, unveränderte Drive-Dokumente dürfen keinesfalls als unerledigte To-Dos vorgeschlagen werden.
4. KONFLIKTPRIORITÄT: Neueste explizite Nutzerkorrektur > neueste datierte Weekly/Transkript/Chat-/Kalender-Quelle für Projekt- und Squad-Fakten > Google-Tasks-Status für Aufgaben > älteres lokales Memory. [ERLEDIGT] darf nie aus alten Quellen reaktiviert werden; [OFFEN] bleibt aktiv.
5. Ein [ERLEDIGT]-Status in Google Tasks ist für genau diese Aufgabe final und darf durch ältere Quellen nicht reaktiviert werden.
6. Ein [OFFEN]-Status in Google Tasks bleibt aktiv, auch wenn das übergeordnete Projekt oder eine ältere Notiz als abgeschlossen bezeichnet wird.

STRIKTER QUERABGLEICH MIT KALENDER & MEETINGS (KONTEXTVERSTÄNDNIS FÜR DAS "DOING"):
1. VOR JEDEM AKTIONEN- ODER TO-DO-VORSCHLAG: Prüfe immer den Kalender ("--- KALENDER ---")!
2. Wenn für HEUTE (oder die nächsten Tage) bereits ein Meeting, 1:1, Sync oder Gespräch mit einer Person (z. B. Marion, Squad-Mitglieder, Kunden) im Kalender steht:
   - SCHLAGE HIERFÜR KEIN SEPARATES TO-DO / KEINE MANUELLE DOING-AUFGABE VOR (wie z. B. "Kümmere dich um Marion bzgl. Auslastung", "E-Mail an Marion wegen Staffing", "Status nachhaken", "Marion kontaktieren")!
   - Hardy bespricht solche Themen (Auslastung, Feedback, Projektstand, Roadmap) direkt im anstehenden Termin.
   - Nenne das Thema stattdessen als **Agenda-Punkt / Notiz zur Meeting-Vorbereitung** im Text des Briefings – erstelle KEIN separates Doing/Action Proposal dafür!
3. Erstelle nur dann ein Action Proposal / To-Do, wenn ein echtes asynchrones To-Do vorliegt, das NICHT Gegenstand eines heute anstehenden Meetings ist.

STRIKTE REGEL FÜR ABGESCHLOSSENE AUFGABEN & ADMINISTRATIVE MITTEILUNGEN:
1. Aufgaben unter [ERLEDIGT] und im lokalen Memory explizit abgeschlossene Punkte:
   - Schlage dieselbe Aufgabe KEINESFALLS erneut als To-do, Action Proposal oder Nachfass-Aufgabe vor.
   - Ein Projekt darf trotzdem einen neuen Status haben; schliesse nicht pauschal alle zukünftigen Aufgaben eines Projekts aus.
2. HiBob / Stundenzettel-Freigaben (z. B. Stundenzettel von Nils Traut):
   - Sind administrative E-Mail-Mitteilungen bzw. längst erledigt. NIEMALS als offene To-Dos oder Freigabeaufgaben vorschlagen!
3. Panda und Mario Auslastung:
   - Verwende niemals eine statische Auslastungsannahme. Prüfe die neueste datierte Weekly-, Transkript-, Chat- oder Planner-Quelle.
   - Wenn Panda nach neuen Projekten fragt oder Mario für neue Aufgaben / andere Auslastung vorgeschlagen wird, nimm dies als aktuelles Squad-Planungssignal auf und verlinke die Quelle.
4. Lorenz / Funding:
   - Lorenz Funding wird NICHT genutzt (keine Screenshots, Anträge etc. erstellen, nicht Hardys Aufgabe) – stattdessen werden lediglich intern ein paar Stunden umgebucht.
5. Koenig & Bauer (Koenig&Bauer):
   - Aus dem PK vom Montag: Interne Treffen finden statt, um die Budgetfrage zu klären. Immer transparent im Projektstatus erwähnen!
6. Schreibweisen:
   - "domcura" (immer kleingeschrieben bzw. "domcura", niemals "Dom Kura" oder "DomKura").
   - "VOEST Alpine" (immer "VOEST Alpine", niemals "First Alpina" oder "First Alpine").

TEAM, ONBOARDING & EINARBEITUNGSPLÄNE (ZUKÜNFTIGE MEILENSTEINE WIE SEPTEMBER):
1. Einarbeitungspläne, Onboarding-Konzepte, Schulungspläne und Meilensteine für neue Mitarbeiter (insbesondere für September oder anstehende Monate) sind zentrale Kern-Verantwortungen von Hardy als Squad Lead!
2. Zukunftsorientierte Dokumente & Pläne dürfen NIEMALS wegen ihres Erstellungsdatums als veraltet oder inaktiv ignoriert werden.
3. Schlage bei Vorliegen eines Einarbeitungsplans proaktiv konkrete Vorbereitungs-To-Dos und Action Proposals für Hardy vor:
   - Einarbeitungsplan finalisieren & mit Team / HR abstimmen
   - Hardware, Zugänge und Berechtigungen für den neuen Mitarbeiter rechtzeitig anfordern/prüfen
   - Buddy / Mentor zuweisen und Vorbereitungsbriefing planen
   - Kennenlern-Termine, Team-Vorstellung und 1:1 Serie für September im Kalender anlegen
   - Schulungsslots & Fach-Einarbeitungsthemen in den ersten Wochen einplanen
4. Quellen stets als anklickbare Markdown-Links belegen (z. B. \`[Quelle: Google Drive – "Einarbeitungsplan ..."](URL)\`).

STRIKTE REGEL FÜR QUELLENANGABEN & ANKLICKBARE LINKS:
1. Jede wichtige Information, Aussage, jedes Projekt-Update und jedes To-Do MUSS am Ende mit einer konkreten, ANKLICKBAREN Quellenangabe als Markdown-Link belegt werden (nutze stets die im Kontext angegebenen "Direktlink:" URLs)!
   - Beispiele: \`[Quelle: Google Drive – "Transkript PK Montag"](URL)\`, \`[Quelle: Google Chat – Raum "DATA Squad"](URL)\`, \`[Quelle: Gmail – Betreff "...", Datum ...](URL)\`, \`[Quelle: Google Kalender – Termin ...](URL)\`, \`[Quelle: Google Tasks – Liste "..."](URL)\`.
2. Erfinde niemals Quellen oder Fakten. Wenn eine Information nicht vorhanden ist, weise transparent darauf hin.

STRIKTE REGEL FÜR INTERNE TERMINE (Thursdays for Data):
1. "Thursdays for Data" ist ein interner Serientermin von PCG und MUSS IMMER KOMPLETT SILENT IGNORIERT WERDEN!
   - Erwähne "Thursdays for Data" NIEMALS im Briefing oder Chat.
   - Erstelle NIEMALS einen Abschnitt oder Aufzählungspunkt wie "Ignorierte interne Termine" oder Ähnliches im Bericht!

STRIKTE DUPLIKATS-VERMEIDUNGS-REGEL (GEGENCHECK BESTEHENDER TO-DOS):
1. PRÜFE VOR JEDEM VORSCHLAG DIE ABSCHNITTE "--- TO-DOS ---" / GOOGLE TASKS!
2. Wenn eine Aufgabe inhaltlich bereits als [OFFEN] oder [ERLEDIGT] existiert, DARFST DU DIESE NICHT nochmals als neues To-do oder Action Proposal vorschlagen. [OFFEN] bleibt im Briefing sichtbar; [ERLEDIGT] wird nicht reaktiviert.
3. Schlage NUR Aufgaben vor, die wirklich NEU sind und noch in KEINER Liste vorkommen.

STRIKTE DATUMS- UND FRISTENREGEL (FEHLERVERMEIDUNG):
1. HEUTIGES DATUM: ${todayISO} (${todayGerman}).
2. ERSTELLE NIEMALS To-Do-Vorschläge, Action Proposals oder Kalendereinträge mit einem Fälligkeitsdatum (dueDate) oder Timing IN DER VERGANGENHEIT (z. B. vor Wochen, Monaten oder Jahren wie vor 89 Wochen)!
3. Alle vorgeschlagenen Fälligkeiten (dueDate / startTime) MÜSSEN am heutigen Tag (${todayISO}) oder in der ZUKUNFT liegen.
4. Ignoriere historische Deadlines aus alten Dokumenten/Protokollen. Wenn ein Thema tatsächlich noch aktuell und offen ist, wähle als Fälligkeitsdatum HEUTE (${todayISO}) oder ein neues realistisches ZUKÜNFTIGES Datum.
5. Jede neue Task-Aktion MUSS ein konkretes dueDate im Format YYYY-MM-DD enthalten. Wähle bei dringenden Blockern heute, bei normalen Projektaktionen den nächsten sinnvollen Arbeitstag und bei länger laufenden Themen das realistische Abschlussdatum.

KUNDEN-MEETINGS & VORBEREITUNGS-REGEL (SPÄTESTENS 1 TAG VORHER):
1. Die Vorbereitung auf alle Kunden-, Use-Case- und Partner-Meetings (wie Schwarz / DSV, Kunden-Workshops, Reviews etc.) MUSS SPÄTESTENS 1 TAG VORHER (am Vortag bzw. freitags für Montag) erfolgen!
2. Wenn für HEUTE oder MORGEN oder MONTAG ein Kunden-Meeting im Kalender steht:
   - Ziehe alle in Drive vorhandenen Vorbereitungsnotizen, Mitschriften, Ziele und Use Cases heran.
   - Bereite Hardy aktiv darauf vor (Agenda, Use Cases, offene Punkte).
   - Schlage bei Bedarf proaktiv Vorbereitungs-To-Dos mit Fälligkeit HEUTE (${todayISO}) vor, damit das Meeting rechtzeitig vorbereitet ist.

Wann immer aus deinen Analysen, Antworten oder Briefings konkrete Folgeschritte hervorgehen (z. B. "Du musst bei Projekt X den Status nachhaken", "Schreibe eine E-Mail an Kundin Y", "Erstelle einen Kalendereintrag", "Sende eine Google Chat Erinnerung" oder "Erstelle ein Dokument / eine Notiz in Google Drive"), füge UNBEDINGT am Ende deiner Nachricht einen strukturierten JSON-Block in folgendem exakten Format an:

<ACTION_PROPOSALS>
[
  {
    "id": "act-1",
    "type": "task",
    "title": "Status nachhaken bei Projekt Alpha",
    "details": {
      "title": "Projekt Alpha: Status nachhaken",
      "notes": "Erinnerung aus Briefing: Nachfassen bezüglich Feedback zur Architektur.",
      "dueDate": "${todayISO}"
    }
  },
  {
    "id": "act-2",
    "type": "email",
    "title": "E-Mail-Entwurf an Kundin Schmidt vorbereiten",
    "details": {
      "to": "schmidt@kundenfirma.de",
      "subject": "Status-Update & Nächste Schritte Projekt Alpha",
      "body": "Hallo Frau Schmidt,\\n\\nich möchte mich kurz zum aktuellen Stand erkundigen...",
      "isDraft": true
    }
  },
  {
    "id": "act-3",
    "type": "calendar",
    "title": "Follow-up Meeting eintragen",
    "details": {
      "summary": "Follow-up Call: Projekt Alpha Sync",
      "description": "Besprechung der offenen Punkte aus dem Briefing.",
      "startTime": "${todayISO}T10:00:00",
      "endTime": "${todayISO}T10:30:00"
    }
  },
  {
    "id": "act-4",
    "type": "chat",
    "title": "Google Chat Erinnerung an Squad senden",
    "details": {
      "text": "Hallo Team, kurzer Reminder zum Status-Update für Projekt Alpha."
    }
  }
]
</ACTION_PROPOSALS>

Achte darauf, dass alle Detailfelder realistisch, zukunftsgerichtet und sofort ausführbar vorausgefüllt sind.
`;
}

export async function createGoogleTaskDirect(title: string, notes?: string, dueDate?: string, tokenOverride?: string) {
  const token = tokenOverride || loadStoredToken();
  if (!token) {
    throw new GoogleAuthError("Kein gültiges Google Token vorhanden. Bitte in der Web-App anmelden.");
  }
  const oauth2Client = getOAuth2Client(token);
  const tasksApi = google.tasks({ version: 'v1', auth: oauth2Client });
  const taskListRes = await tasksApi.tasklists.list({ maxResults: 1 });
  const tasklistId = taskListRes.data.items?.[0]?.id || '@default';

  const insertRes = await tasksApi.tasks.insert({
    tasklist: tasklistId,
    requestBody: {
      title,
      notes: notes || '',
      due: dueDate ? new Date(dueDate).toISOString() : undefined,
    }
  });

  return { id: insertRes.data.id, title, notes, dueDate };
}

app.post('/api/actions/task', async (req, res) => {
  const token = (req as any).googleToken;
  try {
    const { title, notes, dueDate } = req.body;
    const fieldError = validateTextField(title, 'Titel', 500, true) || validateTextField(notes, 'Notizen', 10000) || validateTextField(dueDate, 'Fälligkeitsdatum', 30);
    if (fieldError) return res.status(400).json({ error: fieldError });
    if (!title) {
      return res.status(400).json({ error: "Titel der Aufgabe ist erforderlich." });
    }

    const taskResult = await createGoogleTaskDirect(title, notes, dueDate, token);
    res.json({
      success: true,
      message: `Aufgabe "${title}" erfolgreich in Google Tasks erstellt!`,
      taskId: taskResult.id
    });
  } catch (error: any) {
    if (isAuthError(error)) {
      clearStoredToken();
      return res.status(401).json({ error: "Google API-Authentifizierung abgelaufen. Bitte neu anmelden." });
    }
    console.error("Create task error:", error);
    res.status(500).json({ error: error?.message || "Fehler beim Erstellen der Aufgabe in Google Tasks." });
  }
});

// ─── CHAT-DIRECT TASK CREATION (uses authenticated request token) ───
app.post('/api/chat/create-tasks', async (req, res) => {
  const token = (req as any).googleToken;
  if (!token) {
    return res.status(401).json({
      error: "Kein Google-Token vorhanden. Bitte im Browser mit Google anmelden."
    });
  }
  const { tasks } = req.body;
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: "Keine Tasks übergeben." });
  }
  const results: { title: string; id?: string; error?: string }[] = [];
  for (const task of tasks) {
    try {
      const result = await createGoogleTaskDirect(task.title, task.notes, task.dueDate, token);
      results.push({ title: task.title, id: result.id });
    } catch (err: any) {
      results.push({ title: task.title, error: err.message || String(err) });
    }
  }
  const allOk = results.every(r => !r.error);
  res.json({ success: allOk, results });
});

app.post('/api/actions/email', async (req, res) => {
  const token = (req as any).googleToken;
  try {
    const oauth2Client = getOAuth2Client(token);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const { to, subject, body, isDraft = true } = req.body;

    const fieldError = validateTextField(to, 'Empfänger', 2000, true) || validateTextField(subject, 'Betreff', 500, true) || validateTextField(body, 'Text', 100000, true);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const cleanBody = cleanContentForEmail(body);

    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const messageParts = [
      `To: ${to}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${utf8Subject}`,
      '',
      cleanBody,
    ];
    const emailBody = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(emailBody)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    if (isDraft) {
      const draftRes = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw: encodedMessage }
        }
      });
      res.json({
        success: true,
        message: `E-Mail-Entwurf an ${to} ("${subject}") erfolgreich in Gmail gespeichert!`,
        draftId: draftRes.data.id
      });
    } else {
      const sendRes = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
      });
      res.json({
        success: true,
        message: `E-Mail an ${to} ("${subject}") erfolgreich gesendet!`,
        messageId: sendRes.data.id
      });
    }
  } catch (error: any) {
    if (isAuthError(error)) {
      clearStoredToken();
      return res.status(401).json({ error: "Google API-Authentifizierung abgelaufen. Bitte neu anmelden." });
    }
    console.error("Email action error:", error);
    res.status(500).json({ error: error?.message || "Fehler beim Erstellen/Senden der E-Mail." });
  }
});

app.post('/api/actions/calendar', async (req, res) => {
  const token = (req as any).googleToken;
  try {
    const oauth2Client = getOAuth2Client(token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { summary, description, startTime, endTime } = req.body;

    const fieldError = validateTextField(summary, 'Titel', 500, true) || validateTextField(description, 'Beschreibung', 10000) || validateTextField(startTime, 'Startzeit', 80, true) || validateTextField(endTime, 'Endzeit', 80);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const startObj = new Date(startTime);
    const endObj = endTime ? new Date(endTime) : new Date(startObj.getTime() + 30 * 60 * 1000);

    const eventRes = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description: description || '',
        start: { dateTime: startObj.toISOString(), timeZone: 'Europe/Berlin' },
        end: { dateTime: endObj.toISOString(), timeZone: 'Europe/Berlin' }
      }
    });

    res.json({
      success: true,
      message: `Termin "${summary}" für ${startObj.toLocaleString('de-DE')} im Google Kalender eingetragen!`,
      eventId: eventRes.data.id,
      htmlLink: eventRes.data.htmlLink
    });
  } catch (error: any) {
    if (isAuthError(error)) {
      clearStoredToken();
      return res.status(401).json({ error: "Google API-Authentifizierung abgelaufen. Bitte neu anmelden." });
    }
    console.error("Calendar event action error:", error);
    res.status(500).json({ error: error?.message || "Fehler beim Erstellen des Kalendereintrags." });
  }
});

app.post('/api/actions/chat', async (req, res) => {
  const token = (req as any).googleToken;
  try {
    const oauth2Client = getOAuth2Client(token);
    const chat = google.chat({ version: 'v1', auth: oauth2Client });
    const { text, spaceName } = req.body;

    const fieldError = validateTextField(text, 'Nachrichtentext', 20000, true) || validateTextField(spaceName, 'Chat-Raum', 200);
    if (fieldError) return res.status(400).json({ error: fieldError });

    let targetSpace = spaceName;
    if (!targetSpace) {
      const spacesRes = await chat.spaces.list({ pageSize: 5 });
      const spaces = spacesRes.data.spaces || [];
      if (spaces.length > 0) {
        targetSpace = spaces[0].name;
      }
    }

    if (!targetSpace) {
      return res.status(400).json({ error: "Kein aktiver Google Chat Raum gefunden. Bitte Name des Chatraums angeben." });
    }

    const msgRes = await chat.spaces.messages.create({
      parent: targetSpace,
      requestBody: { text }
    });

    res.json({
      success: true,
      message: `Nachricht erfolgreich im Google Chat (${targetSpace}) gesendet!`,
      messageId: msgRes.data.name
    });
  } catch (error: any) {
    if (isAuthError(error)) {
      clearStoredToken();
      return res.status(401).json({ error: "Google API-Authentifizierung abgelaufen. Bitte neu anmelden." });
    }
    console.error("Chat action error:", error);
    res.status(500).json({ error: error?.message || "Fehler beim Senden der Google Chat Nachricht." });
  }
});

app.post('/api/actions/drive', async (req, res) => {
  const token = (req as any).googleToken;
  try {
    const drive = await getDriveClient(token);
    const { fileName = `Notiz_${new Date().toISOString().split('T')[0]}.md`, content } = req.body;

    const fieldError = validateTextField(fileName, 'Dateiname', 255, true) || validateTextField(content, 'Dokumentinhalt', 1000000, true);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const fileMetadata = { name: fileName, parents: [driveFolderId], mimeType: 'text/markdown' };
    const media = { mimeType: 'text/markdown', body: content };

    const fileRes = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    });

    res.json({
      success: true,
      message: `Dokument "${fileRes.data.name}" erfolgreich im Google Drive Ordner gespeichert!`,
      fileId: fileRes.data.id,
      link: fileRes.data.webViewLink
    });
  } catch (error: any) {
    if (isAuthError(error)) {
      clearStoredToken();
      return res.status(401).json({ error: "Google API-Authentifizierung abgelaufen. Bitte neu anmelden." });
    }
    console.error("Drive action error:", error);
    res.status(500).json({ error: error?.message || "Fehler beim Speichern der Datei in Google Drive." });
  }
});

app.post('/api/evidence/search', async (req, res) => {
  try {
    const { query, sourceType, limit, minScore, projectFilter } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Suchanfrage (query) ist erforderlich.' });
    }
    const results = searchVerbatimEvidence({
      query,
      sourceType,
      limit: typeof limit === 'number' ? limit : 10,
      minScore: typeof minScore === 'number' ? minScore : 0.5,
      projectFilter: typeof projectFilter === 'string' ? projectFilter : undefined,
    });
    res.json({ success: true, count: results.length, results });
  } catch (error: any) {
    console.error('Evidence search error:', error);
    res.status(500).json({ error: error?.message || 'Fehler bei der Quellensuche.' });
  }
});

app.post('/api/facts/upsert', async (req, res) => {
  try {
    const { subject, predicate, object, validFrom, validTo, sourceUrl, sourceType, confidence, metadata } = req.body || {};
    if (!subject || !predicate || !object) {
      return res.status(400).json({ error: 'subject, predicate und object sind erforderlich.' });
    }
    const result = upsertTemporalFact({
      subject,
      predicate,
      object,
      validFrom,
      validTo,
      sourceUrl,
      sourceType,
      confidence,
      metadata,
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Temporal fact upsert error:', error);
    res.status(500).json({ error: error?.message || 'Fehler beim Speichern des Fakts.' });
  }
});

app.get('/api/facts/timeline', async (req, res) => {
  try {
    const subject = req.query.subject ? String(req.query.subject) : undefined;
    const predicate = req.query.predicate ? String(req.query.predicate) : undefined;
    const includeInvalidated = req.query.includeInvalidated === 'true';

    const facts = queryTemporalTimeline({ subject, predicate, includeInvalidated });
    res.json({ success: true, count: facts.length, facts });
  } catch (error: any) {
    console.error('Temporal timeline query error:', error);
    res.status(500).json({ error: error?.message || 'Fehler beim Laden der Timeline.' });
  }
});

app.post('/api/decisions/record', async (req, res) => {
  try {
    const { title, project, decision, rationale, alternativesConsidered, owner, date, sourceUrl, tags, metadata } = req.body || {};
    if (!title || !decision || !rationale) {
      return res.status(400).json({ error: 'title, decision und rationale sind erforderlich.' });
    }
    const record = recordDecision({
      title,
      project,
      decision,
      rationale,
      alternativesConsidered: Array.isArray(alternativesConsidered) ? alternativesConsidered : [],
      owner,
      date,
      sourceUrl,
      tags: Array.isArray(tags) ? tags : [],
      metadata,
    });
    res.json({ success: true, record });
  } catch (error: any) {
    console.error('Decision record error:', error);
    res.status(500).json({ error: error?.message || 'Fehler beim Speichern der Entscheidung.' });
  }
});

app.get('/api/decisions/search', async (req, res) => {
  try {
    const query = req.query.query ? String(req.query.query) : undefined;
    const project = req.query.project ? String(req.query.project) : undefined;
    const owner = req.query.owner ? String(req.query.owner) : undefined;
    const tag = req.query.tag ? String(req.query.tag) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;

    const decisions = searchDecisions({ query, project, owner, tag, limit });
    res.json({ success: true, count: decisions.length, decisions });
  } catch (error: any) {
    console.error('Decision search error:', error);
    res.status(500).json({ error: error?.message || 'Fehler bei der Entscheidungssuche.' });
  }
});

app.post('/api/agent/chat', async (req, res) => {
  const accessToken = (req as any).googleToken;
  if (!accessToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const oauth2Client = getOAuth2Client(accessToken);
    const contextData = await fetchDriveContext(accessToken);
    const emailsContext = await fetchRecentEmails(oauth2Client, recordVerbatimEvidence);
    const eventsContext = await fetchUpcomingEvents(oauth2Client, recordVerbatimEvidence);
    const chatsContext = await fetchRecentChats(oauth2Client, recordVerbatimEvidence);
    const tasksContext = await fetchTasks(oauth2Client, recordVerbatimEvidence);
    const davidAgendaContext = extractDavidOneOnOneAgenda(tasksContext);
    const localMemoryContext = loadLocalMemoryContext();
    const skillContext = loadSkillContext([
      'workspace-context-ingestion',
      'task-state-reconciliation',
      'david-one-on-one-preparation',
      'project-and-customer-status',
      'chat-command-safety',
    ]);

    // Check if there is an existing canonical daily update for today
    const dateStr = new Date().toISOString().split('T')[0];
    const existingCron = getCronStatus();
    let todayCanonicalBriefing = "";
    if (existingCron && existingCron.dateStr === dateStr && existingCron.summary) {
      todayCanonicalBriefing = `\n--- HEUTIGES KANONISCHES MANAGEMENT-BRIEFING (${dateStr}) ---\n${existingCron.summary}\n`;
    }

    const systemPrompt = `Du bist der PCG Agent Memory Manager, der persönliche KI-Assistent von Hardy Engwer (Squad Lead DATA / AI Consultant bei PCG). Deine Aufgabe ist die autonome, strukturierte und regelmäßige Pflege und Aktualisierung seines lokalen Memory-Systems (agent-memory/).
Dein Ziel ist es, den operativen Overhead für Hardy zu minimieren, indem du Rohdaten strukturierst, Risiken triagierst, ein proaktives Update-Interview führst und Management-reife Briefings vorbereitest. Du bist nicht für die Umsetzung von technischen Anforderungen von Kunden verantwortlich, 
möchtest aber davon wissen und den Überblick behalten. Behalte die Projektmanager-Übersicht. Trage To-Dos ein zum Nachhaken, Klären oder Vorbereiten, wenn Deadlines oder Aufgaben irgendwo auftauchen. 

WICHTIGE FOKUS- & BRIEFING-REGELN:

1. 📝 UNIVERSELLE ANALYSE VON TRANSKRIPTEN, BESPRECHUNGS-SYNCS & PROJEKT-ZUWEISUNGEN:
   - Durchleuchte lückenlos ALLE vorliegenden Transkripte, Meeting-Mitschriften, E-Mails, Chats und Protokolle aus internen wie externen Terminen (z. B. 1:1s, Team-Syncs, Kunden-Calls, Partner- & Projektmeetings).
   - Identifiziere systematisch jede Hardy zugewiesene Aufgabe, Zusage, Klärung, Projektverantwortung oder Zuarbeit (z. B. "Hardy kümmert sich um...", "Hardy klärt...", "Hardy bereitet Dokument/Konzept vor", "Action Item für Hardy", "Assignment:", "Hardy to review...").
   - Wandle jede identifizierte Verpflichtung oder Zuweisung direkt in ein handlungsfähiges Google-Tasks-To-Do mit realistischer Frist um.
   - Kläre und verfolge proaktiv alle offenen Punkte und Action Items aus vergangenen Besprechungen.

2. 💼 END-TO-END PIPELINE-, SCOPING-, USE-CASE- & SoW-TRACKING:
   - Erfasse systematisch alle Use Cases, Leistungsanforderungen (Scoping) und Deliverables aus Kunden-, Partner- und Vertriebs-Gesprächen (z. B. Abstimmungen mit Sales/Sellern, Account Managern oder Kunden-Teams).
   - Verfolge und memorisiere den genauen Status von Übergaben und Wartezuständen (z. B. "Warten auf Use Cases / Input von Stakeholder/Seller/Kunde, um anschließend das Statement of Work (SoW), Angebot oder Konzept zu generieren").
   - Leite proaktiv die passenden Action Items ab:
     * Wenn Input/Use Cases noch ausstehen -> Halte ein Nachfass-To-Do fest ("Beim jeweiligen Stakeholder nach Use Cases / Input nachhaken").
     * Für die anschließende Ausarbeitung -> Halte ein Erstellungs-To-Do fest ("SoW / Konzept-Entwurf erstellen sobald Use Cases vorliegen").
   - Speichere und strukturiere diesen Kontext persistent mit aussagekräftigen Tags (#kunde/..., #thema/sow, #thema/scoping, #status/wartend, #status/in-progress).

3. 🚨 PROAKTIVE MEETING-VORBEREITUNG (SPÄTESTENS 1 TAG VORHER FÜR KUNDEN & USE CASES):
   - WICHTIGE REGEL: Die inhaltliche und organisatorische Vorbereitung auf Kunden-, Partner- und Use-Case-Meetings (wie Schwarz / DSV, Workshops, Pitches etc.) MUSS SPÄTESTENS 1 TAG VORHER (am Vortag bzw. freitags für Montag) aktiv im Briefing und Chat bereitgestellt werden!
   - Prüfe alle Kundentermine für HEUTE, MORGEN und den NÄCHSTEN WERKTAG (z. B. Montag).
   - Ziehe ALLE verfügbaren Vorbereitungsnotizen, Mitschriften, Drive-Dokumente und Transkripte (insbesondere gestern/kürzlich eingetragene Vorbereitungen) heran.
   - Bereite Hardy aktiv darauf vor: Was ist die Agenda, welche Use Cases, Ziele, offenen Fragen und technischen Eckpunkte sind relevant?
   - Schlage bei Bedarf Vorbereitungs-To-Dos mit Fälligkeit HEUTE vor.

4. 🔮 VORAUSSCHAU AUF DIE NÄCHSTEN ARBEITSTAGE (FREITAG -> MONTAG & KOMMENDE WOCHE):
   - Wenn heute Freitag ist (oder vor dem Wochenende): Blicke explizit vorausschauend auf MONTAG und die kommende Arbeitswoche!
   - Welche Termine stehen am Montag an? Welche Kunden-Vorbereitungen, Deadlines und To-Dos müssen für den Wochenstart bereits HEUTE im Blick behalten und vorbereitet werden?

5. 🚫 INTERNE TERMINE SILENT IGNORIEREN (Thursdays for Data):
   - "Thursdays for Data" ist ein interner PCG-Serientermin und MUSS IMMER KOMPLETT SILENT IGNORIERT WERDEN! Keine Erwähnung, keine To-Dos, keine Vorbereitung und NIEMALS ein Abschnitt "Ignorierte interne Termine".

6. 🔒 MANDATORISCHE VORHERIGE AKTUALITÄTSPRÜFUNG & FILTERUNG ALTER THEMEN:
   - STRIKTE AKTUALITÄTS-REGEL: Überprüfe JEDES Thema, Projekt und To-Do VOR der Anzeige auf Aktualität und Relevanz!
   - Liegt der letzte Vorgang, die letzte E-Mail oder Notiz länger als 7-14 Tage zurück und gibt es KEINEN anstehenden Termin oder offene Google Task dazu? -> Thema ist veraltet/inaktiv und darf NICHT als aktuelle Priorität, offenes Thema oder To-Do angezeigt werden.
   - Gelöschte E-Mails aus dem Papierkorb (Trash) und alte Archiv-Mails dürfen NIEMALS als aktive Themen herangezogen werden.
   - Konfliktpriorität: neueste explizite Nutzerkorrektur im lokalen Memory > Google-Tasks-Status > neueste datierte Mail/Chat/Meeting-Notiz > ältere Quelle.
   - Eine Aufgabe mit [ERLEDIGT] ist final abgeschlossen und darf nicht aus alten Quellen wiederbelebt werden. Eine Aufgabe mit [OFFEN] bleibt dagegen aktiv, selbst wenn eine andere Quelle das Projekt pauschal als abgeschlossen bezeichnet.
   - Projektstatus und Aufgabenstatus getrennt behandeln: Ein abgeschlossenes Einzel-To-do bedeutet nicht automatisch, dass das gesamte Projekt abgeschlossen ist.
   - Konzentriere dich ausnahmslos auf die realen, aktuellen und anstehenden Prioritäten von heute, morgen und den nächsten Arbeitstagen.

7. 📋 STRIKTE VOLLSTÄNDIGKEIT & KONSISTENZ (MANDATORISCHER THEMEN-AUDIT BEI JEDEM AUFRUF):
   - Gehe JEDES MAL ausnahmslos ALLE unerledigten/offenen Themen, Projekte und To-Dos aus allen Datenquellen lückenlos durch.
   - Keines der offenen Themen darf ausgelassen werden. Synchronisiere jedes Thema mit den allerneuesten Ergebnissen aus Drive, Mails und Chats.
    - BESONDERE DAVID-1:1-AGENDA: Die offene Google-Task "Besprechung David" ist Hardys dauerhafte Agenda-Sammelstelle. Berücksichtige ihren vollständigen Titel und insbesondere die Notiz bei JEDEM Kontextaufbau. Wenn ein David-1:1 ansteht, nimm alle dort gesammelten Themen vollständig als Agenda-/Vorbereitungspunkte auf. Erstelle dafür kein separates To-do, außer eine eigenständige Vorbereitungsaufgabe ist ausdrücklich nötig.

8. 🎯 STRIKTER QUERABGLEICH MIT MEETINGS FÜRS "DOING" (KEINE REDUNDANTEN TO-DOS):
   - Wenn mit einer Person oder einem Kunden heute oder in Kürze bereits ein Meeting / 1:1 im Kalender steht (wie z. B. heute Meeting mit Marion):
   - Erstelle KEIN separates Doing-To-Do oder E-Mail-Vorschlag, um sich um die Person zu kümmern oder Themen wie Auslastung, Feedback oder Staffing anzusprechen!
   - Nimm solche Themen stattdessen als Agendapunkt / Vorbereitungsnotiz für das Meeting auf.
   - Wenn es sich jedoch um echte Aufgaben aus Transkripten handelt, die Hardy unabhängig vom Meeting erledigen oder vorbereiten muss, erstelle dafür ein konkretes To-Do!

9. 🏷️ HIERARCHISCHE OBSIDIAN-TAGS (#kunde/..., #squad/..., #prio/..., #status/..., #thema/...):
   - Verwende bei der Strukturierung von Notizen, Themen und Status-Übersichten gezielt hierarchische Obsidian-Tags, z. B. #kunde/schwarz, #kunde/dsv, #squad/mathias, #squad/marion, #status/in-progress, #status/wartend, #prio/hoch, #thema/sow, #thema/ai-ops etc., um Themen schnell auffindbar und filterbar zu machen.

10. 🚫 KEINE MARKDOWN-TABELLEN (STRIKTE ABSATZ- & LISTEN-FORMATIERUNG):
   - Verwende NIEMALS Markdown-Tabellen (weder in Projektstatusberichten noch bei To-Dos oder Zusammenfassungen).
   - Formatiere alle Inhalte stets in gut lesbaren, übersichtlichen Text-Absätzen und Aufzählungspunkten (Bullet Points) mit fetten Titeln.

11. 📌 PROJEKT-SPEZIFISCHE FAKTEN & SCHREIBWEISEN:
   - **domcura**: Immer kleingeschrieben bzw. "domcura", niemals "Dom Kura" oder "DomKura".
   - **VOEST Alpine**: Immer "VOEST Alpine" (oder "voestalpine"), niemals "First Alpina" oder "First Alpine".
   - **Koenig & Bauer (Koenig&Bauer)**: Interne Treffen finden statt, um die Budgetfrage zu klären (beschlossen im PK vom Montag). Im Statusbericht transparent anführen!
   - **Lorenz Funding**: Lorenz Funding soll NICHT genutzt werden (keine Screenshots, Anträge etc., nicht Hardys Aufgabe) – stattdessen werden intern ein paar Stunden umgebucht.
    - **Panda / Mario Auslastung**: Keine statischen Aussagen. Aktuellen Status ausschließlich aus der neuesten datierten Quelle ableiten; ältere Aussagen ausdrücklich als überholt behandeln.
   - **HiBob / Nils Traut**: Administrative Stundenzettel-Freigaben sind bereits erledigt und dürfen keinesfalls als offene Aufgaben vorgeschlagen werden.

12. 🔍 OBLIGATORISCHE ANKLICKBARE QUELLENANGABEN (MARKDOWN-LINKS):
   - Jede einzelne Information, jedes Projektupdate, jede Vorbereitungsnotiz und jedes To-Do MUSS am Ende des jeweiligen Punkts mit einer genauen, ANKLICKBAREN Quellenangabe als Markdown-Link belegt werden (nutze die URLs aus "Direktlink:" im Kontext)!
   - Beispiele: \`[Quelle: Google Drive – "Transkript PK Montag"](https://...)\`, \`[Quelle: Google Chat – "Raum DATA Squad"](https://...)\`, \`[Quelle: Gmail – Betreff "...", 18.08.](https://...)\`, \`[Quelle: Google Kalender – "1:1 Marion"](https://...)\`, \`[Quelle: Google Tasks – Liste "Meine Aufgaben"](https://tasks.google.com/)\`.

  13. 📐 EINHEITLICHES AUSGABEFORMAT (7 ABSCHNITTE, DETERMINISTISCH & OHNE TABELLEN):
    - Wenn ein Daily Briefing, Sync, Status-Bericht oder Lagebild angefragt wird, folge IMMER exakt dieser Reihenfolge. Keine Executive Summary vor Abschnitt 1:
      # ☀️ Tägliches Management-Update (<Datum>)
      ---
      ## 1. [ÄNDERUNG] Projekt- und Kapazitätsänderungen
      - **<Projekt / Person / Planung>**
        • **Änderung:** <Was ist neu oder anders>
        • **Auswirkung:** <Konsequenz für Projekt, Kapazität oder Squad>
        • [Quelle: <Name>](<URL>)
      ---
      ## 2. Squad Lead Control
      - **Allocation / Billability / Booking / Projektplanung / David Weekly**
        • <Aktueller Stand und offene Entscheidung>
        • [Quelle: <Name>](<URL>)
      ---
      ## 3. 🚨 Proaktive Kunden- & Meeting-Vorbereitung (Heute, Morgen & Montag)
      - **<Kunde / Termin>** — <Datum / Zeit>
        • **Agenda & Kontext:** <Inhalte & offene Punkte>
        • **Vorbereitungs-Status & To-Dos:** <Was ist vorbereitet / was zu tun>
        • [Quelle: <Name>](<URL>)
      ---
       ## 4. 🔮 Vorausschau & Wochenausblick (Nächste Tage / Montag)
       - **<Fokusbereich / Tag>**
         • **Anstehend:** <Fristen / Termine / Vorbereitungsbedarf>
         • [Quelle: <Name>](<URL>)
       ---
       ## 5. 🚨 Dringende Klärungen & Projekt-To-dos
       - **<Blocker / Entscheidung / Projektaktion>** — Fälligkeit: <Datum>
         • **Details:** <Owner, konkrete nächste Aktion und Auswirkung>
         • **Priorität:** <Hoch / Mittel>
         • [Quelle: <Name>](<URL>)
       ---
       ## 6. 💡 Weitere nächste Schritte
       - **<Handlung / To-Do>** — Fälligkeit: <Datum>
         • **Details:** <Wer, was, warum>
         • [Quelle: <Name>](<URL>)
       ---
       ## 7. 📋 Kompakte Projektstatusübersicht (optional)
       - Nur eine Zeile pro aktivem Projekt; keine Details oder To-dos wiederholen.
       - Neue Projekte aus aktuellen Quellen aufnehmen, auch ohne lokale Memory-Datei (z. B. Avantgarde).
       - [Quelle: <Name>](<URL>)
     - Vermeide Dopplungen: Änderungen gehören ausschließlich in Abschnitt 1, Squad-/Kapazitätskontrollen ausschließlich in Abschnitt 2, dringende Projektklärungen in Abschnitt 5 und sonstige To-dos in Abschnitt 6. Abschnitt 7 bleibt kompakt.

14. 🛡️ MANDATORISCHE SELBSTKONTROLLE (SELF-AUDIT VOR DER AUSGABE):
   - Führe vor der Ausgabe eine interne Selbstkontrolle durch:
     1. Wurden wirklich ALLE relevanten Quellen (Drive-Transkripte, Google Chat, E-Mails, Kalender, Tasks) lückenlos geprüft?
     2. Wurde kein aktives Kundenprojekt ausgelassen?
     3. Wurden alle [ERLEDIGT]-Tasks und expliziten Nutzerkorrekturen berücksichtigt, ohne offene Tasks desselben Projekts zu unterdrücken?
     4. Wurden überall die korrekten Schreibweisen ("domcura", "VOEST Alpine") verwendet?
     5. Wurde "Thursdays for Data" silent ignoriert und KEIN "Punkt 4: Ignorierte interne Termine" erzeugt?
     6. Sind alle Quellenangaben als anklickbare Markdown-Links formatiert?

 Rolle: Strategischer Sparringspartner und hochgradig organisierter Operations-Assistent im Cloud- & KI-Umfeld angepasst auf die PCG Squad Lead Rolle.
Tonalität: Deutsch, prägnant, faktenbasiert, absolut management-tauglich.
 Fokus: Extrem proaktiv. Du wartest nicht auf Anweisungen, sondern schlägst konkrete Aktionen, Zuweisungen (Owner) und Deadlines vor.

VERBINDLICHE SKILLS FÜR DIESE ANFRAGE:
${skillContext}

${getActionProposalsInstruction()}
${todayCanonicalBriefing}

Hier sind die Inhalte aus Hardys Knowledge Base (Google Drive):
${contextData}

${emailsContext}

${eventsContext}

${chatsContext}

${tasksContext}

Besondere DAVID-1:1-AGENDA: Die offene Google-Task "Besprechung David" ist Hardys dauerhafte Agenda-Sammelstelle. Berücksichtige ihren vollständigen Titel und insbesondere die Notiz bei JEDEM Kontextaufbau. Wenn ein David-1:1 ansteht, nimm alle dort gesammelten Themen vollständig als Agenda-/Vorbereitungspunkte auf. Erstelle dafür kein separates To-do, außer eine eigenständige Vorbereitungsaufgabe ist ausdrücklich nötig.

${davidAgendaContext}

WIEDERHOLTE AUTORITATIVE NUTZERKORREKTUREN (bei Konflikten zwingend anwenden):
${localMemoryContext}

Antworte basierend auf diesen Dokumenten. Wenn die Informationen nicht vorhanden sind, gib dies klar an. Keine externen Informationen erfinden. ggf. auf Quellen hinweisen`;

    const response = await generateAIContent({
      contents: message,
      config: {
        temperature: 0.0,
        systemInstruction: systemPrompt
      }
    });

    let reply = sanitizeActionProposals(response.text || "", tasksContext, eventsContext);

    res.json({ reply });
  } catch (error: any) {
    if (isAuthError(error)) {
      clearStoredToken();
      return res.status(401).json({ error: "Google API-Authentifizierung abgelaufen. Bitte neu anmelden." });
    }

    const errObj = formatAIError(error);
    console.warn("Chat notice:", errObj.message);
    res.status(errObj.status).json({ error: errObj.message });
  }
});

app.post('/api/transcribe', async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) {
      return res.status(400).json({ error: "Keine Audiodatei empfangen." });
    }

    const response = await generateAIContent({
      contents: [
        {
          inlineData: {
            mimeType: mimeType || 'audio/webm',
            data: audio
          }
        },
        "Transkribiere diese gesprochene Nachricht präzise auf Deutsch. Gib NUR den transkribierten Text zurück, ohne Anführungszeichen, ohne Einleitung oder zusätzliche Kommentare."
      ]
    });

    res.json({ text: response.text?.trim() || "" });
  } catch (error: any) {
    const errObj = formatAIError(error);
    console.warn("Transcribe notice:", errObj.message);
    res.status(errObj.status).json({ error: errObj.message });
  }
});

export async function performDailyUpdate(accessToken: string, forceRefresh: boolean = false, options: { autoCreateTasks?: boolean } = {}) {
  const oauth2Client = getOAuth2Client(accessToken);

  // Validate base token first
  try {
    const tasksApi = google.tasks({ version: 'v1', auth: oauth2Client });
    await tasksApi.tasklists.list({ maxResults: 1 });
  } catch (userErr: any) {
    if (isAuthError(userErr)) {
      console.warn("Google OAuth token check notice:", userErr?.message || userErr);
      clearStoredToken();
      throw new GoogleAuthError("Google API-Authentifizierung abgelaufen. Bitte neu anmelden.");
    }
    console.warn("Token check skipped (non-auth error):", userErr?.message || userErr);
  }

  const dateStr = new Date().toISOString().split('T')[0];

  try {
    const syncedMemoryFiles = await syncLocalMemoryToDrive(accessToken);
    console.log(`[Memory Sync] ${syncedMemoryFiles.length} strukturierte Datei(en) nach Drive synchronisiert.`);
  } catch (memoryErr: any) {
    console.warn('[Memory Sync] Drive-Synchronisierung übersprungen:', memoryErr?.message || memoryErr);
  }

  // Always perform a live, fresh evaluation of all connected Google Workspace sources in parallel
  console.log(`[Daily Briefing] Performing live real-time analysis for ${dateStr}...`);

  const [
    driveContext,
    emailsContext,
    eventsContext,
    chatsContext,
    tasksContext
  ] = await Promise.all([
    fetchDriveContext(accessToken),
    fetchRecentEmails(oauth2Client, recordVerbatimEvidence),
    fetchUpcomingEvents(oauth2Client, recordVerbatimEvidence),
    fetchRecentChats(oauth2Client, recordVerbatimEvidence),
    fetchTasks(oauth2Client, recordVerbatimEvidence)
  ]);
  const enrichedDriveContext = enrichTimestampTranscriptLinks(driveContext, eventsContext);
  const davidAgendaContext = extractDavidOneOnOneAgenda(tasksContext);
  const localMemoryContext = loadLocalMemoryContext();
  const currentSquadSignals = extractCurrentSquadSignals(enrichedDriveContext, chatsContext);
  const projectCapacityEvidence = extractProjectCapacityEvidence(enrichedDriveContext, emailsContext, chatsContext);
  const skillContext = loadSkillContext([
    'workspace-context-ingestion',
    'task-state-reconciliation',
    'david-one-on-one-preparation',
    'daily-management-briefing',
    'project-and-customer-status',
    'squad-lead-operations',
  ]);

  const nowStr = new Date().toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });

  const prompt = `Erstelle ein fokussiertes, tägliches Management-Briefing und Update basierend auf allen verknüpften Quellen (Google Drive Dokumente & Meeting-Protokolle, E-Mails, Kalender, Google Chat und Google Tasks).

VERBINDLICHE SKILLS FÜR DIESES DAILY:
${skillContext}

 WICHTIGE LAYOUT- & FORMATIERUNGSREGELN:
 - HEADER: Beginne direkt mit dem Briefing-Titel (z. B. "# ☀️ Tägliches Management-Update (${nowStr})"). Keine Executive Summary und keine Aufzählung von Datenquellen vor Abschnitt 1!
- STRIKTES TABELLEN-VERBOT: Verwende NIEMALS Markdown-Tabellen! Formatiere ALLE Inhalte in sauberen Text-Absätzen und Aufzählungslisten (Bullet Points).
- ANKLICKBARE QUELLEN-LINKS: Jede Information und jedes To-Do MUSS am Ende mit einer anklickbaren Quellenangabe als Markdown-Link belegt werden (z. B. [Quelle: Google Drive – "Transkript PK Montag"](https://...), [Quelle: Gmail – Betreff "...", Datum](https://...), [Quelle: Google Kalender – "1:1 Marion"](https://...)). Nutze stets die Direktlinks aus den Quellen-Abschnitten!
- KEINE IGNORIERTEN TERMINE IM BERICHT: Erstelle NIEMALS einen Abschnitt oder Punkt wie "Ignorierte interne Termine". "Thursdays for Data" wird komplett stillschweigend ignoriert.

 FESTE 7-TEILIGE BRIEFING-STRUKTUR OHNE DOPPLUNGEN:

 # ☀️ Tägliches Management-Update (${nowStr})

 ---

 ## 1. [ÄNDERUNG] Projekt- und Kapazitätsänderungen
 - **<Projekt / Person / Planung>**
   • **Änderung:** <Was ist neu oder anders>
   • **Auswirkung:** <Konsequenz für Projekt, Kapazität oder Squad>
   • [Quelle: <Name>](<URL>)

 ---

 ## 2. Squad Lead Control
 - **Allocation / Billability / Booking / Projektplanung / David Weekly**
   • **Aktueller Stand:** <Nur aktuelle, source-backed Kontrollen>
   • **Offene Entscheidung:** <Wer muss was klären, falls belegt>
   • [Quelle: <Name>](<URL>)

 ---

 ## 3. 🚨 Proaktive Kunden- & Meeting-Vorbereitung (Heute, Morgen & Montag)
 - **<Kunde / Termin>** — <Datum / Uhrzeit>
  • **Agenda & Kontext:** <Inhalte, Ziele, offene Fragen>
  • **Vorbereitungs-Status & To-Dos:** <Was ist vorbereitet / was ist heute zu tun>
  • [Quelle: <Name>](<URL>)

---

  ## 4. 🔮 Vorausschau & Wochenausblick (Nächste Tage / Montag)
- **<Fokusbereich / Wochentag>**
  • **Anstehende Fristen & Termine:** <Was steht an>
  • **Vorbereitungsbedarf vorab:** <Was muss heute/vorab vorbereitet werden>
  • [Quelle: <Name>](<URL>)

  ## 5. 🚨 Dringende Klärungen & Projekt-To-dos
- **<Blocker / Entscheidung / Projektaktion>** — Fälligkeit: <Datum>
  • **Details:** <Owner, konkrete nächste Aktion und Auswirkung>
  • **Priorität:** <Hoch / Mittel>
  • [Quelle: <Name>](<URL>)

  ## 6. 💡 Weitere nächste Schritte
- **<Handlungsempfehlung>** — Fälligkeit: <Datum>
  • **Details:** <Wer, was, warum>
  • [Quelle: <Name>](<URL>)

  ## 7. 📋 Kompakte Projektstatusübersicht (optional)
- Nur für seltene Orientierung verwenden; pro aktivem Projekt maximal eine Zeile.
- Keine Details, Meetings, Kapazitätsdaten oder To-dos wiederholen; dafür auf Abschnitt 1–6 verweisen.
- Neue Projekte aus aktuellen Quellen aufnehmen, auch ohne lokale Memory-Datei (z. B. Avantgarde).
  • [Quelle: <Name>](<URL>)

--- GOOGLE DRIVE (MEETING NOTES & DOKUMENTE) ---
${enrichedDriveContext}

--- E-MAILS ---
${emailsContext}

--- KALENDER ---
${eventsContext}

--- CHATS ---
${chatsContext}

--- AKTUELLE SQUAD-SIGNALE AUS DATIERTEN QUELLEN ---
${currentSquadSignals}

--- PROJEKT- UND KAPAZITÄTSÄNDERUNGEN / QUELLEN-AUDIT ---
${projectCapacityEvidence}

--- TO-DOS ---
${tasksContext}

${davidAgendaContext}

--- LOKALES MEMORY / EXPLIZITE NUTZERKORREKTUREN (nur aktuelle Korrekturen; alte Auslastungsfakten nicht wiederverwenden) ---
${localMemoryContext}
`;

  const response = await generateAIContent({
    contents: prompt,
    config: {
      temperature: 0.0,
      systemInstruction: `Du bist der PCG Agent Memory Manager, der persönliche KI-Assistent von Hardy Engwer (Squad Lead DATA / AI Consultant bei PCG). Erstelle ein klares, management-taugliches Briefing auf Deutsch.

MANDATORISCHE FORMATIERUNGS- & INHALTS-REGELN:
1. KEINE TABELLEN: Verwende NIEMALS Markdown-Tabellen. Stelle alle Status-Übersichten in klaren Text-Absätzen und Aufzählungslisten (Bullet Points) dar.
2. KEIN QUELLENKATALOG IM HEADER: Keine Auflistungen wie "Kalender: Termine...", "E-Mails: Neueste 50..." im Header.
2a. KEINE EXECUTIVE SUMMARY VOR ABSCHNITT 1: Nach dem Titel beginnt das Briefing unmittelbar mit den Projekt- und Kapazitätsänderungen.
3. MANDATORISCHE AKTUALITÄTSPRÜFUNG: Überprüfe jedes Thema vor der Anzeige auf Aktualität. Wenn eine E-Mail, Notiz oder Aufgabe länger als 7-14 Tage zurückliegt und kein anstehender Termin oder offener Task vorliegt, ist das Thema inaktiv und wird NICHT mehr angezeigt.
   Konfliktpriorität: neueste explizite Nutzerkorrektur im lokalen Memory > Google-Tasks-Status > neueste datierte Mail/Chat/Meeting-Notiz > ältere Quelle. [ERLEDIGT] darf nie aus alten Quellen reaktiviert werden; [OFFEN] bleibt aktiv.
  4. Universelle Analyse von Transkripten & Projekt-Zuweisungen: Analysiere Transkripte und Mitschriften aus E-Mails, Drive und Besprechungen lückenlos und leite konkrete To-Dos für jede Hardy zugewiesene Aufgabe, Zusage oder Projektverantwortung ab. Eine aktuelle Mail oder Chat-Nachricht mit Projektübernahme, neuer PM-Verantwortung, neuem Kundenkontext oder neuem Delivery-Stream erzeugt ein eigenständiges Projekt, auch ohne lokale Memory-Datei. Beispiel: Avantgarde ist nicht KSGR.
5. End-to-End Pipeline-, Scoping- & SoW-Tracking: Erfasse Use Cases, Leistungsanforderungen und Deliverables aus Kunden-, Partner- und Vertriebs-Gesprächen. Tracke Wartezustände (z. B. Warten auf Use Cases/Input, anschließende SoW-Generierung) und schlage dafür proaktiv Nachfass- & Entwurfs-To-Dos vor.
6. Proaktive Meeting-Vorbereitung (spätestens 1 Tag vorher): Bereite Hardy auf Kunden- und Use-Case-Meetings (wie Schwarz / DSV) für heute, morgen und Montag basierend auf vorhandenen Notizen und eingetragenen Vorbereitungen vor.
7. Vorausschau: Schaue vorausschauend auf Montag und die nächste Woche.
8. Vollständigkeit: Gehe lückenlos alle aktiven, unerledigten Themen durch und synchronisiere sie mit den neuesten Quellen.
  8a. DOPPLUNGSVERBOT: Änderungen ausschließlich in Abschnitt 1, Squad-Lead-Kontrollen ausschließlich in Abschnitt 2, dringende Projektklärungen ausschließlich in Abschnitt 5 und weitere To-dos ausschließlich in Abschnitt 6. Meetings nennen nur Agenda und Vorbereitung. Abschnitt 7 enthält je Projekt nur eine kompakte Statuszeile ohne Wiederholung.
  8b. PRIORITÄT: Dringende Blocker, Entscheidungen, fällige Projektaktionen und konkrete nächste Schritte stehen vor der optionalen Projektstatusübersicht. Die Statusübersicht darf nie zulasten dieser Hinweise ausführlich werden.
  8c. TODO-SYNCHRONISATION: Jede konkrete Aktion in Abschnitt 5 oder 6 muss als task in ACTION_PROPOSALS gespiegelt werden. Jede solche task-Aktion braucht ein sinnvolles dueDate im Format YYYY-MM-DD; offene Projektaktionen ohne Enddatum sind nicht zulässig.
  8e. EXPLIZITE BENUTZERBITTEN: Wenn Hardy in Chat, Mail oder Meeting ausdrücklich sagt, dass er sich um einen konkreten Kundenblocker oder Zugang kümmern will (z. B. WireGuard-Zugang für HHA), muss daraus zwingend ein eigener Google-Task mit Owner Hardy, konkreter nächster Aktion und Fälligkeitsdatum entstehen. Ein bloßer Hinweis in Abschnitt 1 reicht nicht.
  8f. TASK-ABGLEICH: Offene konkrete Aktionen aus Abschnitt 5 und 6 müssen in Google Tasks erscheinen. Erledigte Google Tasks und explizit abgeschlossene Aktionen dürfen weder im Bericht als offene nächste Schritte erscheinen noch erneut angelegt werden. Wenn eine Aktion heute fällig oder überfällig ist, verwende heute (${dateStr}) als Fälligkeitsdatum, sofern keine neue realistische Frist belegt ist.
  8d. E-MAIL-AUSGANG & FOLLOW-UP: Prüfe im E-Mail-Kontext ausdrücklich Nachrichten mit Status GESENDET. Wenn Hardy eine relevante Projekt-, Schätzungs-, Scope- oder Übergabemail gesendet hat und noch keine Antwort vorliegt, erstelle ein Nachhaken als Task mit Empfänger, Betreff, ursprünglichem Anliegen und gewünschter Antwort. Bei einer Abwesenheitsmeldung richte das dueDate auf den ersten oder zweiten Arbeitstag nach dem genannten Rückkehrdatum; ohne Rückkehrdatum auf 7–10 Tage nach Versand. Keine Follow-up-Aufgabe erzeugen, wenn bereits eine Antwort vorliegt oder ein gleichwertiger offener Google Task existiert.
9. AKTUELLE SQUAD-SIGNALE: Der Abschnitt \`AKTUELLE SQUAD-SIGNALE AUS DATIERTEN QUELLEN\` ist für Mario- und Panda-Auslastung maßgeblich. Wenn dort Mario-Projektideen, Kapazitätsoptionen oder Pandas Wunsch nach neuen Projekten stehen, muss dies im Squad-Status beziehungsweise in der David-Weekly-Agenda erscheinen. Wenn dort kein aktueller Panda-Eintrag steht, darf kein alter "Panda ist voll ausgelastet"-Fakt ausgegeben werden.
10. PROJEKT- UND KAPAZITÄTSAUDIT: Prüfe den Abschnitt \`PROJEKT- UND KAPAZITÄTSÄNDERUNGEN / QUELLEN-AUDIT\` vollständig. Berücksichtige jede relevante Erwähnung zu Projekten, SOWs, Budgets, Pipelines, Staffing, Allocation, Billability, Resource Planner, Booking, Bench, Unassigned und Presales. Jede materielle Änderung gegenüber dem bisherigen Stand muss im Briefing mit dem Präfix \`[ÄNDERUNG]\`, aktuellem Stand, Auswirkung und Quelle kenntlich gemacht werden.
10. Querabgleich mit Terminen: Wenn heute ein Meeting (z. B. 1:1 mit Teammitgliedern) ansteht, nimm besprechbare Punkte als Meeting-Agendapunkte auf – erstelle aber To-Dos für echte Vorbereitungsaufgaben und vergangene Action Items!
11. Abgeschlossene Aufgaben: Alle mit [ERLEDIGT] markierten oder im lokalen Memory explizit abgeschlossenen Einzelaufgaben dürfen nie erneut vorgeschlagen werden. Projekte nicht pauschal abschliessen; offene Google Tasks desselben Projekts bleiben gültig.
12. Ignorierte Termine: "Thursdays for Data" ist intern und wird immer still ignoriert. KEINEN Abschnitt "Ignorierte interne Termine" erstellen!
13. Projekt-Fakten & Schreibweisen:
    - "domcura" (immer kleingeschrieben).
    - "VOEST Alpine" (immer "VOEST Alpine").
    - Koenig & Bauer: Interne Treffen finden statt, um Budgetfrage zu klären (aus PK vom Montag).
    - Lorenz Funding: Nicht nutzen, keine Screenshots/Anträge, Stunden werden intern umgebucht.
    - Panda und Mario: Auslastung und Projektwünsche wöchentlich anhand der neuesten datierten Quellen aktualisieren; keine statische Kapazitätsaussage verwenden.
    - HiBob / Nils Traut: Stundenzettel-Freigaben sind erledigt, keinesfalls als Task vorschlagen.
14. OBLIGATORISCHE ANKLICKBARE QUELLENANGABEN (MARKDOWN-LINKS):
    - Jedes Projektupdate, jeder Status, jede Vorbereitungsnotiz und jedes To-Do MUSS am Ende mit einer anklickbaren Quellenangabe als Markdown-Link belegt werden (nutze die URLs aus den Kontextblöcken, z. B. \`[Quelle: Google Drive – "Transkript PK"](https://...)\`, \`[Quelle: Google Chat – "DATA Squad"](https://...)\`, \`[Quelle: Gmail – Betreff "...", Datum](https://...)\`, \`[Quelle: Google Kalender – Termin ...](https://...)\`, \`[Quelle: Google Tasks – Liste "..."](https://tasks.google.com/)\`).
15. TEAM & ONBOARDING NEUER MITARBEITER (Z. B. SEPTEMBER):
    - Einarbeitungspläne und Onboarding-Konzepte für neue Teammitglieder (insbesondere für September) sind strategische Führungsaufgaben von Squad Lead Hardy. Proaktiv in die Vorausschau und Handlungsempfehlungen aufnehmen und konkrete Vorbereitungs-To-Dos (Einarbeitungsplan abstimmen, Hardware/Zugänge prüfen, Buddy festlegen, 1:1 Termine und Schulungsslots im Kalender einstellen) ableiten!
16. SELBSTKONTROLLE & LÜCKENLOSE VOLLSTÄNDIGKEIT:
    - Kontrolliere vor der Ausgabe selbst, ob alle aktiven Kundenprojekte, Onboarding-Pläne, offenen Tasks, Termine und neuen Chat-/Mail-Inhalte vollständig und transparent erfasst sind und kein Punkt 4 für ignorierte Termine existiert.\n\n${getActionProposalsInstruction()}`
    }
  });

  let summary = validateDailyBriefingStructure(sanitizeCurrentSquadCapacityClaims(
    sanitizeActionProposals(response.text || "Kein Update generiert.", tasksContext, eventsContext),
    currentSquadSignals,
  ));
  summary = ensureCriticalProjectTasks(
    summary,
    `${enrichedDriveContext}\n${emailsContext}\n${chatsContext}`,
    tasksContext,
    dateStr,
  );
  summary = ensureActionSectionTasks(summary, tasksContext, dateStr);

  try {
    if (process.env.ENABLE_DAILY_MEMORY_CURATION === 'true') {
      const generatedMemoryFiles = await generateStructuredMemoryConcepts({
        driveContext,
        emailsContext,
        eventsContext,
        chatsContext,
        tasksContext,
        localMemoryContext,
      });
      console.log(`[Memory Curation] ${generatedMemoryFiles.length} OKF-Konzept(e) aktualisiert.`);
    } else {
      console.log('[Memory Curation] Im Daily standardmäßig übersprungen; Memory-Sync bleibt aktiv.');
    }
    const syncedMemoryFiles = await syncLocalMemoryToDrive(accessToken);
    console.log(`[Memory Sync] ${syncedMemoryFiles.length} strukturierte Datei(en) nach Drive synchronisiert.`);
  } catch (memoryErr: any) {
    console.warn('[Memory Curation] Strukturierte Memory-Aktualisierung übersprungen:', memoryErr?.message || memoryErr);
  }

  let createdTasks: { title: string; id?: string; error?: string }[] = [];
  if (options.autoCreateTasks) {
    const proposalsMatch = summary.match(/<ACTION_PROPOSALS>([\s\S]*?)<\/ACTION_PROPOSALS>/i);
    if (proposalsMatch) {
      try {
        // Re-read Tasks after generation so manually-created or concurrently-created
        // tasks cannot slip through the earlier snapshot-based sanitization.
        const latestTaskStates = extractGoogleTaskStates(await fetchTasks(oauth2Client, recordVerbatimEvidence));
        const createdTitles: string[] = [];
        let jsonStr = proposalsMatch[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim().replace(/,\s*([\]}])/g, '$1');
        const proposals = JSON.parse(jsonStr);
        const taskProposals = Array.isArray(proposals) ? proposals.filter((p: any) => p && p.type === 'task') : [];
        for (const tp of taskProposals) {
          try {
            const title = tp.details?.title || tp.title;
            if (latestTaskStates.open.some(open => areTaskTextsSimilar(title, open)) || createdTitles.some(created => areTaskTextsSimilar(title, created))) {
              console.log(`[Final Task Deduplication] Skipped existing or duplicate proposal: "${title}"`);
              continue;
            }
            const notes = tp.details?.notes || '';
            const dueDate = tp.details?.dueDate || dateStr;
            if (!tp.details?.dueDate) {
              console.warn(`[Task Due Date] Kein dueDate für "${title}"; verwende ${dateStr}.`);
            }
            const r = await createGoogleTaskDirect(title, notes, dueDate, accessToken);
            createdTasks.push({ title, id: r.id });
            createdTitles.push(title);
            console.log(`Google Task angelegt: ${title} (ID: ${r.id})`);
          } catch (taskErr: any) {
            const title = tp.details?.title || tp.title || 'Unbekannt';
            createdTasks.push({ title, error: taskErr?.message || String(taskErr) });
            console.warn(`Task nicht angelegt (${title}): ${taskErr?.message || taskErr}`);
          }
        }
      } catch (parseErr) {
        console.warn("ACTION_PROPOSALS konnte nicht geparst werden:", parseErr);
      }
    }
  }
  
  // Speichern in Drive (optional, fail-safe)
  try {
    const drive = await getDriveClient(accessToken);
    const fileName = `Daily_Update_${dateStr}.md`;
    
    const res = await drive.files.list({
      q: `'${driveFolderId}' in parents and name='${fileName}' and trashed=false`,
      fields: 'files(id)'
    });
    const files = res.data.files || [];
    
    const fileMetadata = { name: fileName, parents: [driveFolderId], mimeType: 'text/markdown' };
    const media = { mimeType: 'text/markdown', body: summary };
    
    if (files.length > 0) {
      await drive.files.update({ fileId: files[0].id, media: media });
    } else {
      await drive.files.create({ requestBody: fileMetadata, media: media });
    }
  } catch (driveErr: any) {
    console.error("Could not save daily briefing to Google Drive:", driveErr?.message || driveErr);
  }
  
  let emailSent = false;
  let emailErrorMsg = null;
  let emailMessageId: string | null = null;
  
  // E-Mail senden
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profileRes = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profileRes.data.emailAddress;
    
    if (emailAddress) {
      const cleanEmailContent = cleanContentForEmail(summary);
      const utf8Subject = `=?utf-8?B?${Buffer.from(`PCG Agent Daily Briefing - ${dateStr}`).toString('base64')}?=`;
      const encodedBody = Buffer.from(cleanEmailContent, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
      const messageParts = [
        `From: ${emailAddress}`,
        `To: ${emailAddress}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        'MIME-Version: 1.0',
        `Subject: ${utf8Subject}`,
        '',
        encodedBody,
      ];
      const emailBody = messageParts.join('\r\n');
      const encodedMessage = Buffer.from(emailBody)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
        
      const sentMessage = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
      });
      emailMessageId = sentMessage.data.id || null;
      console.log("Email sent successfully to", emailAddress);
      emailSent = true;
    }
  } catch (emailError: any) {
    console.error("Failed to send email:", emailError.message || emailError);
    emailErrorMsg = emailError.message || String(emailError);
    // Continue even if email fails, so we don't break the whole process if only email failed
  }
  
  const result = { summary, emailSent, emailErrorMsg, emailMessageId, lastRunAt: new Date().toISOString(), dateStr, success: true, createdTasks };
  saveCronStatus(result);
  return result;
}

app.get('/api/cron/status', (req, res) => {
  const status = getCronStatus();
  const token = loadStoredToken();
  res.json({
    status: status || null,
    hasToken: !!token
  });
});

// --- OBSIDIAN-STYLE HIERARCHICAL TAGGING SYSTEM ---

interface TagItem {
  tag: string;
  namespace: string;
  name: string;
  count: number;
}

function extractObsidianTags(text: string): Map<string, number> {
  const tagCounts = new Map<string, number>();
  if (!text) return tagCounts;

  // Regex to match #tag or #namespace/subtag (excluding hex colors and markdown headings)
  // Look for # followed by a letter, then word chars, dashes, slashes
  const tagRegex = /(?:^|\s)#([a-zA-ZäöüÄÖÜß][\w\u00C0-\u017F/-]{1,40})/g;
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const rawTag = match[1].toLowerCase().replace(/\/+$/, '');
    // Exclude false positives like color codes or simple numbers
    if (/^[0-9a-f]{3,6}$/i.test(rawTag) || rawTag === 'include' || rawTag === 'import') continue;
    tagCounts.set(rawTag, (tagCounts.get(rawTag) || 0) + 1);
  }

  return tagCounts;
}

app.get('/api/tags', async (req, res) => {
  const token = (req as any).googleToken;

  if (!token) {
    return res.status(401).json({ error: "Nicht authentifiziert" });
  }

  try {
    const oauth2Client = getOAuth2Client(token);
    const driveContext = await fetchDriveContext(token);
    const tasksContext = await fetchTasks(oauth2Client, recordVerbatimEvidence);
    const eventsContext = await fetchUpcomingEvents(oauth2Client, recordVerbatimEvidence);
    const emailsContext = await fetchRecentEmails(oauth2Client, recordVerbatimEvidence);
    const cronStatus = getCronStatus();

    const allText = [
      driveContext,
      tasksContext,
      eventsContext,
      emailsContext,
      cronStatus?.summary || ''
    ].join('\n');

    const tagCounts = extractObsidianTags(allText);

    // Also inject canonical known PCG tags if not explicitly found in text
    const canonicalTags: { tag: string; defaultCount: number }[] = [
      { tag: 'kunde/schwarz', defaultCount: (allText.match(/schwarz/gi) || []).length },
      { tag: 'kunde/dsv', defaultCount: (allText.match(/dsv/gi) || []).length },
      { tag: 'squad/marion', defaultCount: (allText.match(/marion/gi) || []).length },
      { tag: 'squad/hardy', defaultCount: 1 },
      { tag: 'status/in-progress', defaultCount: (allText.match(/in-progress|in arbeit|offen/gi) || []).length },
      { tag: 'status/review', defaultCount: (allText.match(/review|abstimmung/gi) || []).length },
      { tag: 'prio/hoch', defaultCount: (allText.match(/🚨|wichtig|dringend|asap/gi) || []).length },
      { tag: 'prio/normal', defaultCount: 2 },
      { tag: 'thema/cloud', defaultCount: (allText.match(/cloud|gcp|aws/gi) || []).length },
      { tag: 'thema/ai-ops', defaultCount: (allText.match(/ai|ki|llm|genai/gi) || []).length },
      { tag: 'thema/staffing', defaultCount: (allText.match(/staffing|auslastung|kapazität/gi) || []).length }
    ];

    for (const c of canonicalTags) {
      const existing = tagCounts.get(c.tag) || 0;
      tagCounts.set(c.tag, Math.max(existing, c.defaultCount || 1));
    }

    const categories: Record<string, TagItem[]> = {
      kunde: [],
      squad: [],
      prio: [],
      status: [],
      thema: [],
      andere: []
    };

    const allTagsList: TagItem[] = [];

    tagCounts.forEach((count, tag) => {
      let namespace = 'andere';
      let name = tag;

      if (tag.includes('/')) {
        const parts = tag.split('/');
        namespace = parts[0];
        name = parts.slice(1).join('/');
      } else {
        if (tag === 'schwarz' || tag === 'dsv') {
          namespace = 'kunde';
        } else if (tag === 'marion' || tag === 'hardy') {
          namespace = 'squad';
        }
      }

      const item: TagItem = {
        tag,
        namespace,
        name,
        count
      };

      allTagsList.push(item);

      if (categories[namespace]) {
        categories[namespace].push(item);
      } else {
        if (!categories[namespace]) categories[namespace] = [];
        categories[namespace].push(item);
      }
    });

    // Sort descending by count
    allTagsList.sort((a, b) => b.count - a.count);
    for (const k of Object.keys(categories)) {
      categories[k].sort((a, b) => b.count - a.count);
    }

    res.json({
      success: true,
      totalTags: allTagsList.length,
      categories,
      allTags: allTagsList
    });
  } catch (error: any) {
    console.warn("Tags extraction notice:", error?.message || error);
    res.status(500).json({ error: "Fehler beim Extrahieren der Wissens-Tags" });
  }
});

app.post('/api/cron/trigger', async (req, res) => {
  const token = (req as any).googleToken;

  if (!token) {
    return res.status(401).json({ error: "Kein Zugriffstoken vorhanden. Bitte im Browser anmelden." });
  }
  const forceRefresh = Boolean(req.body?.forceRefresh || req.query?.forceRefresh);
  try {
    const result = await performDailyUpdate(token, forceRefresh);
    res.json({ success: true, ...result });
  } catch (error: any) {
    if (isAuthError(error)) {
      clearStoredToken();
      return res.status(401).json({ error: "Google API-Authentifizierung abgelaufen. Bitte neu anmelden." });
    }
    
    const errObj = formatAIError(error);
    console.warn("Daily update trigger notice:", errObj.message);
    res.status(errObj.status).json({ error: errObj.message });
  }
});

// An Werktagen (Montag bis Freitag) um 8:00 Uhr laufen lassen (Europe/Berlin Zeit) mit automatischem Refresh-Token
if (isMain) {
cron.schedule('0 8 * * 1-5', async () => {
  const token = await getValidAccessToken();
  if (!token) {
    console.log("Daily update skipped at 08:00: No valid access token or refresh token available.");
    saveCronStatus({
      lastRunAt: new Date().toISOString(),
      dateStr: new Date().toISOString().split('T')[0],
      error: "Übersprungen: Kein Zugriffstoken vorhanden. Bitte im Browser oder via 'npm run agent -- auth' anmelden.",
      success: false
    });
    return;
  }
  console.log("Running daily automated update at 08:00 (Mon-Fri)...");
  try {
    await performDailyUpdate(token);
    console.log("Daily update completed successfully.");
  } catch (err: any) {
    if (isAuthError(err)) {
      clearStoredToken();
      console.log("Daily update failed: Access token expired.");
    } else {
      console.error("Daily update failed:", err);
    }
    const errObj = formatAIError(err);
    saveCronStatus({
      lastRunAt: new Date().toISOString(),
      dateStr: new Date().toISOString().split('T')[0],
      error: isAuthError(err) ? "Token abgelaufen. Bitte neu im Browser anmelden." : errObj.message,
      success: false
    });
  }
}, {
  timezone: "Europe/Berlin"
});
}

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

if (isMain) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
  });
}
