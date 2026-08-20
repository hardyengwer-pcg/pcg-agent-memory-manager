import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import cron from 'node-cron';
import 'dotenv/config';

const app = express();
const PORT = 3000;

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

app.use(express.json({ limit: '25mb' }));

const allowedGoogleEmail = process.env.GOOGLE_ALLOWED_EMAIL?.trim().toLowerCase();

app.use('/api', async (req, res, next) => {
  if (req.method === 'GET' && req.path === '/api/ai-settings') return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nicht authentifiziert. Bitte im Browser anmelden.' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Nicht authentifiziert. Bitte im Browser anmelden.' });
  }

  try {
    const tasksApi = google.tasks({ version: 'v1', auth: getOAuth2Client(token) });
    await tasksApi.tasklists.list({ maxResults: 1 });

    if (!allowedGoogleEmail) {
      return res.status(503).json({ error: 'GOOGLE_ALLOWED_EMAIL ist nicht konfiguriert.' });
    }
    const oauth2 = google.oauth2({ version: 'v2', auth: getOAuth2Client(token) });
    const userInfo = await oauth2.userinfo.get();
    if (userInfo.data.email?.toLowerCase() !== allowedGoogleEmail) {
      return res.status(403).json({ error: 'Dieses Google-Konto ist nicht für den Agenten freigegeben.' });
    }

    (req as any).googleToken = token;
    return next();
  } catch (err: any) {
    if (isAuthError(err)) {
      clearStoredToken();
      return res.status(401).json({ error: 'Google API-Authentifizierung abgelaufen. Bitte neu anmelden.' });
    }
    console.warn('Google token validation failed:', err?.message || err);
    return res.status(503).json({ error: 'Google-Token konnte derzeit nicht validiert werden.' });
  }
});

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
    baseUrl = 'https://generativelanguage.googleapis.com';
  }

  if (baseUrl) {
    baseUrl = normalizeAiBaseUrl(baseUrl);
  }

  const isGateway = (apiKey.startsWith('sk-') || (baseUrl.includes('gateway') || baseUrl.includes('pcg')));

  return { apiKey, baseUrl, isGateway };
}

function getModelName(customModel?: string, customApiKey?: string, customBaseUrl?: string): string {
  const settings = loadAISettings();
  const { isGateway } = getEffectiveApiConfig(customApiKey, customBaseUrl);

  const rawModel = (customModel && customModel.trim() !== '') 
    ? customModel.trim() 
    : (settings.model && settings.model.trim() !== '' ? settings.model.trim() : '');

  if (isGateway) {
    if (rawModel && (rawModel === 'gemini-3.5-flash' || rawModel === 'pcg-auto-pro' || rawModel === 'gemini-2.5-pro' || rawModel === 'claude-sonnet-5' || rawModel === 'gpt-5.4' || rawModel === 'Standard' || rawModel === 'Pro' || rawModel === 'Expert')) {
      return rawModel === 'Standard' || rawModel === 'Pro' || rawModel === 'Expert' ? 'gemini-3.5-flash' : rawModel;
    }
    return "gemini-3.5-flash";
  } else {
    if (!rawModel || rawModel === "Standard" || rawModel === "Pro" || rawModel === "Expert" || rawModel.startsWith('gemini-2.5') || rawModel.startsWith('gemini-1.5') || rawModel.startsWith('gemini-2.0')) {
      return "gemini-3.7-flash";
    }
    return rawModel;
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
    return await ai.models.generateContent({
      model: targetModel,
      contents: options.contents,
      ...(options.config ? { config: options.config } : {})
    });
  } catch (err: any) {
    console.warn("AI Generation Error for model:", targetModel, "Error:", err?.message || err);
    const fullStr = (err?.message || '') + ' ' + JSON.stringify(err || {});
    
    // Check for access denied, invalid model name, quota exhausted, or 403 errors
    const isAccessDenied = fullStr.includes('key_model_access_denied') || fullStr.includes('not allowed to access model') || fullStr.includes('403') || fullStr.includes('Forbidden') || err?.status === 403 || err?.code === 403;
    const isInvalidModel = fullStr.includes('Invalid model name passed in model=') || fullStr.includes('invalid model');
    const isQuotaError = err?.status === 429 || err?.code === 429 || fullStr.includes('quota') || fullStr.includes('Quota') || fullStr.includes('RESOURCE_EXHAUSTED');

    if (isAccessDenied || isInvalidModel || isQuotaError) {
      const directCandidates = ['gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'].filter(m => m !== targetModel);

      for (const fallbackModel of directCandidates) {
        try {
          const fallbackAi = getGenAIClient(options.customApiKey, options.customBaseUrl);
          const result = await fallbackAi.models.generateContent({
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
      message: `Ungültiger KI-Modellname ('${currentModel}'). Bitte klicke oben rechts auf 'AI Gateway' und wähle ein gültiges Modell wie z. B. 'Standard', 'Pro' oder 'gemini-2.5-flash'.`
    };
  }

  if (
    fullStr.includes('key_model_access_denied') || 
    fullStr.includes('not allowed to access model')
  ) {
    const match = fullStr.match(/models=\[([^\]]+)\]/);
    const allowed = match ? match[1] : "'Standard', 'Pro', 'Expert', 'gemini-2.5-flash'";
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

export async function fetchRecentEmails(auth: any) {
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    
    // Fetch recent active emails. Trash and spam must never influence task state.
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'newer_than:45d -in:trash -in:spam',
      maxResults: 60,
      includeSpamTrash: false,
    });
    const messages = res.data.messages || [];

    // 2. Targeted search for all Transcripts, Meeting Notes, Projects, SoW, Tasks, Assignments, Use Cases, Onboarding & Handover discussions
    let targetedMessages: any[] = [];
    try {
      const targetedRes = await gmail.users.messages.list({
        userId: 'me',
        q: 'newer_than:45d -in:trash -in:spam (transcript OR transkript OR "meeting notes" OR protokoll OR summary OR zusammenfassung OR "action items" OR todo OR to-do OR aufgabe OR projekt OR zugewiesen OR "next steps" OR handover OR scoping OR proposal OR sow OR "statement of work" OR "use case" OR "use cases" OR review OR retrospective OR alignment OR sync OR briefing OR absprache OR "Koenig" OR "Bauer" OR "Lorenz" OR "domcura" OR "voestalpine" OR "VOEST" OR "PK" OR "Einarbeitung" OR "Einarbeitungsplan" OR "Onboarding" OR "Mitarbeiter" OR "September" OR "Joiner" OR "Welcome" OR "Schulung")',
        maxResults: 50,
        includeSpamTrash: false
      });
      targetedMessages = targetedRes.data.messages || [];
    } catch (targetErr: any) {
      console.warn("Targeted Gmail query notice:", targetErr?.message || targetErr);
    }

    // Combine unique message IDs
    const messageIdMap = new Map<string, boolean>();
    const allMsgIds: string[] = [];
    for (const m of messages) {
      if (m.id && !messageIdMap.has(m.id)) {
        messageIdMap.set(m.id, true);
        allMsgIds.push(m.id);
      }
    }
    for (const m of targetedMessages) {
      if (m.id && !messageIdMap.has(m.id)) {
        messageIdMap.set(m.id, true);
        allMsgIds.push(m.id);
      }
    }

    const parsedEmails: any[] = [];
    
    for (const msgId of allMsgIds) {
      try {
        const mRes = await gmail.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'full'
        });
        const headers = mRes.data.payload?.headers;
        const labelIds = mRes.data.labelIds || [];
        const subject = headers?.find(h => h.name === 'Subject')?.value || '(Kein Betreff)';
        const from = headers?.find(h => h.name === 'From')?.value || 'Unbekannt';
        const date = headers?.find(h => h.name === 'Date')?.value || '';
        const snippet = mRes.data.snippet || '';
        const internalDate = Number(mRes.data.internalDate) || (date ? new Date(date).getTime() : 0);

        if (labelIds.includes('TRASH') || labelIds.includes('SPAM')) continue;

        let statusStr = "Posteingang (Aktiv)";
        if (!labelIds.includes('INBOX')) {
          statusStr = "ARCHIVIERT";
        }

        // Extract body text & attachments
        let emailBodyText = "";
        const attachmentsList: string[] = [];

        const extractParts = (part: any) => {
          if (!part) return;
          if (part.filename) {
            attachmentsList.push(part.filename);
          }
          if (part.mimeType === 'text/plain' && part.body?.data) {
            try {
              const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
              emailBodyText += decoded + "\n";
            } catch {}
          } else if (part.mimeType === 'text/html' && part.body?.data && !emailBodyText) {
            try {
              const decodedHtml = Buffer.from(part.body.data, 'base64').toString('utf-8');
              const textClean = decodedHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                           .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                           .replace(/<[^>]+>/g, ' ')
                                           .replace(/\s+/g, ' ')
                                           .trim();
              emailBodyText += textClean + "\n";
            } catch {}
          }
          if (part.parts && Array.isArray(part.parts)) {
            for (const subPart of part.parts) {
              extractParts(subPart);
            }
          }
        };

        if (mRes.data.payload) {
          extractParts(mRes.data.payload);
        }

        // Clean and slice body text for prompt context
        let bodySnippet = emailBodyText.replace(/\r?\n+/g, ' ').trim();
        if (bodySnippet.length > 2500) {
          bodySnippet = bodySnippet.slice(0, 2500) + '... [Gekürzt]';
        }
        if (!bodySnippet) {
          bodySnippet = snippet;
        }

        const isTranscriptOrProject = /transcript|transkript|meeting\s*notes|protokoll|summary|zusammenfassung|action\s*items?|todo|to-do|aufgabe|zugewiesen|projekt|next\s*steps|handover|scoping|proposal|sow|statement\s*of\s*work|use\s*cases?|review|retrospective|alignment|sync|briefing|absprache/i.test(subject) ||
                                     /transcript|transkript|meeting\s*notes|protokoll|summary|zusammenfassung|action\s*items?|todo|to-do|aufgabe|zugewiesen|projekt|next\s*steps|handover|scoping|proposal|sow|statement\s*of\s*work|use\s*cases?|review|retrospective|alignment|sync|briefing|absprache/i.test(bodySnippet);

        parsedEmails.push({
          id: msgId,
          internalDate,
          statusStr,
          from,
          subject,
          date,
          bodySnippet,
          attachments: attachmentsList.join(', '),
          isTranscriptOrProject
        });
      } catch (singleMsgErr: any) {
        console.warn(`Gmail msg get notice ${msgId}:`, singleMsgErr?.message || singleMsgErr);
      }
    }

    // Deterministic sort: latest email first
    parsedEmails.sort((a, b) => {
      if (b.internalDate !== a.internalDate) return b.internalDate - a.internalDate;
      return (a.id || '').localeCompare(b.id || '');
    });

    let emailsContext = "Neueste aktive E-Mails & Transkripte (Posteingang und Archiv; ohne Papierkorb/Spam):\n";
    const nowMs = Date.now();
    for (const em of parsedEmails) {
      // Calculate age in days
      const daysOld = em.internalDate ? Math.floor((nowMs - em.internalDate) / (1000 * 60 * 60 * 24)) : 0;
      
      // Skip very old emails (> 45 days) to avoid polluting active memory
      if (daysOld > 45 && em.statusStr !== "Posteingang (Aktiv)") {
        continue;
      }

      // Filter out automated HiBob / HR notification emails (timesheet / vacation approvals that are already done)
      if (/hibob|stundenzettel|time\s*off/i.test(em.from) || /hibob.*(stundenzettel|approved|submitted|genehmigt|freigabe)/i.test(em.subject)) {
        continue;
      }

      const attachInfo = em.attachments ? ` | Anhänge: ${em.attachments}` : '';
      const flagInfo = em.isTranscriptOrProject ? ' [⭐ ENTHÄLT TRANSKRIPT / PROJEKT / USE-CASE / AUFGABEN]' : '';
      const mailUrl = `https://mail.google.com/mail/u/0/#all/${em.id}`;
      
      let ageFlag = '';
      if (daysOld > 21) {
        ageFlag = ` [⚠️ HISTORISCHE E-MAIL (${daysOld} Tage alt) - VORHER PRÜFEN OB NOCH AKTUELL; NICHT als aktuelle Prio oder neue To-Dos interpretieren]`;
      } else if (daysOld > 7) {
        ageFlag = ` [Älterer Thread (${daysOld} Tage alt) - Aktualität vor Erwähnung gegenprüfen]`;
      }

      emailsContext += `- [Status: ${em.statusStr}]${flagInfo}${ageFlag} Von: ${em.from} | Betreff: ${em.subject} | Datum: ${em.date} | Direktlink: ${mailUrl}${attachInfo}\n  Inhalt / Text: "${em.bodySnippet}"\n`;
    }
    return emailsContext;
  } catch (e: any) {
    console.warn("Gmail fetch notice:", e?.message || e);
    return "(E-Mails konnten nicht abgerufen werden)\n";
  }
}

export async function fetchUpcomingEvents(auth: any) {
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const fourteenDaysAhead = new Date();
    fourteenDaysAhead.setDate(fourteenDaysAhead.getDate() + 14);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: sevenDaysAgo.toISOString(),
      timeMax: fourteenDaysAhead.toISOString(),
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = res.data.items || [];
    
    const now = new Date();
    const todayISO = now.toISOString().split('T')[0];
    
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = tomorrow.toISOString().split('T')[0];

    // Calculate next Monday date for lookahead
    const currentDay = now.getDay(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
    const daysUntilMonday = ((8 - currentDay) % 7) || 7;
    const nextMonday = new Date(now);
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
    const nextMondayISO = nextMonday.toISOString().split('T')[0];

    let eventsContext = `Kalendertermine (Letzte 7 Tage bis +14 Tage Vorausschau, Stand heute: ${now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}):\n`;
    
    for (const event of events) {
      const summary = event.summary || '(Kein Titel)';
      const desc = event.description ? ` | Details: ${event.description.replace(/\n+/g, ' ').slice(0, 300)}` : '';
      
      // HARD RULE: Always completely ignore "Thursdays for Data" (internal meeting)
      if (/thursdays?\s+(for|4)\s+data/i.test(summary) || /thursdays?\s+(for|4)\s+data/i.test(desc)) {
        continue;
      }

      const start = event.start?.dateTime || event.start?.date || '';
      const end = event.end?.dateTime || event.end?.date || '';
      const eventDateISO = start.includes('T') ? start.split('T')[0] : start;

      let tag = '[ANSTEHEND]';
      if (eventDateISO === todayISO) {
        tag = '[🚨 HEUTE - ANSTEHENDER TERMIN]';
      } else if (eventDateISO === tomorrowISO) {
        tag = '[🚨 MORGEN - ANSTEHENDER TERMIN (VORBEREITUNG HEUTE ERFORDERLICH!)]';
      } else if (eventDateISO === nextMondayISO) {
        tag = '[🔮 MONTAG - NÄCHSTE WOCHE (VORBEREITUNG VOR WOCHENENDE ERFORDERLICH!)]';
      } else if (eventDateISO < todayISO) {
        tag = '[VERGANGEN]';
      } else if (eventDateISO > todayISO) {
        tag = '[VORAUSSCHAU / NÄCHSTE TAGE]';
      }

      // Highlight customer / use case / important meetings
      const isCustomerOrUseCase = /schwarz|dsv|use\s*case|kunde|client|customer|workshop|pitch|review|briefing|squad/i.test(summary) || 
                                  /schwarz|dsv|use\s*case|kunde|client|customer/i.test(desc);
      if (isCustomerOrUseCase) {
        if (eventDateISO === todayISO) {
          tag += ' [⭐ KUNDENTERMIN HEUTE - BRIEFING & NOTIZEN!]';
        } else if (eventDateISO === tomorrowISO || eventDateISO === nextMondayISO) {
          tag += ' [⭐ KUNDENTERMIN MORGEN/MONTAG - VORBEREITUNG SPÄTESTENS HEUTE (1 TAG VORHER) DURCHFÜHREN!]';
        } else {
          tag += ' [⭐ KUNDEN- / USE-CASE-TERMIN - VORBEREITUNG FRÜHZEITIG EINPLANEN!]';
        }
      }

      const loc = event.location ? ` | Ort: ${event.location}` : '';
      const attendees = event.attendees ? ` | Teilnehmer: ${event.attendees.map((a: any) => a.displayName || a.email).join(', ')}` : '';
      const calUrl = event.htmlLink || 'https://calendar.google.com/calendar/u/0/r';
      eventsContext += `- ${tag} ${summary} (${start} bis ${end}) | Direktlink: ${calUrl}${loc}${attendees}${desc}\n`;
    }
    return eventsContext;
  } catch (e: any) {
    console.warn("Calendar fetch notice:", e?.message || e);
    return "(Kalendertermine konnten nicht abgerufen werden)\n";
  }
}

export async function fetchRecentChats(auth: any) {
  try {
    const chat = google.chat({ version: 'v1', auth });
    const res = await chat.spaces.list({
      pageSize: 50,
    });
    const spaces = res.data.spaces || [];
    let chatContext = "Aktuelle Chat-Räume & Nachrichten:\n";
    for (const space of spaces) {
      if (!space.name) continue;
      const spaceLabel = space.displayName ? `Raum: "${space.displayName}"` : `Raum: ${space.name}`;
      const chatUrl = space.name ? `https://chat.google.com/room/${space.name.replace('spaces/', '')}` : 'https://chat.google.com/';
      chatContext += `- ${spaceLabel} | Direktlink: ${chatUrl}\n`;
      try {
        const msgsRes = await chat.spaces.messages.list({
          parent: space.name,
          pageSize: 25,
          orderBy: 'createTime desc'
        });
        const msgs = msgsRes.data.messages || [];
        for (const msg of msgs) {
          const sender = msg.sender?.displayName || msg.sender?.name || 'User';
          const text = msg.text || '(Kein Text)';
          const timeStr = msg.createTime ? ` [${new Date(msg.createTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}]` : '';
          chatContext += `   * ${sender}${timeStr}: "${text.replace(/\n+/g, ' ')}"\n`;
        }
      } catch (msgErr: any) {
        // message list read scope might be restricted or empty, ignore
      }
    }
    return chatContext;
  } catch (e: any) {
    console.warn("Chat fetch notice:", e?.message || e);
    return "(Chats konnten nicht abgerufen werden - Berechtigung oder Dienst inaktiv)\n";
  }
}

export async function fetchTasks(auth: any) {
  try {
    const tasksApi = google.tasks({ version: 'v1', auth });
    const taskLists: any[] = [];
    let listPageToken: string | undefined;
    do {
      const listsRes = await tasksApi.tasklists.list({ maxResults: 100, pageToken: listPageToken });
      taskLists.push(...(listsRes.data.items || []));
      listPageToken = listsRes.data.nextPageToken || undefined;
    } while (listPageToken);

    const openTasks: { task: any; listTitle: string }[] = [];
    const completedTasks: { task: any; listTitle: string }[] = [];
    const completedMin = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const tasksUrl = 'https://tasks.google.com/';

    for (const list of taskLists) {
      if (!list.id) continue;
      let openPageToken: string | undefined;
      do {
        const res = await tasksApi.tasks.list({
          tasklist: list.id,
          showCompleted: false,
          showHidden: false,
          maxResults: 100,
          pageToken: openPageToken
        });
        for (const task of res.data.items || []) {
          if (task.title && task.status !== 'completed') openTasks.push({ task, listTitle: list.title || '(ohne Namen)' });
        }
        openPageToken = res.data.nextPageToken || undefined;
      } while (openPageToken);

      let completedPageToken: string | undefined;
      do {
        const res = await tasksApi.tasks.list({
          tasklist: list.id,
          showCompleted: true,
          showHidden: true,
          completedMin,
          maxResults: 100,
          pageToken: completedPageToken
        });
        for (const task of res.data.items || []) {
          if (task.title && task.status === 'completed') completedTasks.push({ task, listTitle: list.title || '(ohne Namen)' });
        }
        completedPageToken = res.data.nextPageToken || undefined;
      } while (completedPageToken);
    }

    openTasks.sort((a, b) => (a.task.due || '9999').localeCompare(b.task.due || '9999') || a.task.title.localeCompare(b.task.title));
    completedTasks.sort((a, b) => (b.task.completed || '').localeCompare(a.task.completed || ''));

    let tasksContext = "Google Tasks – AUTORITATIVE AUFGABENZUSTÄNDE:\n";
    tasksContext += "OFFEN (müssen berücksichtigt werden, auch wenn andere Quellen das Thema als abgeschlossen bezeichnen):\n";
    if (openTasks.length === 0) {
      tasksContext += "(Keine offenen Aufgaben in Google Tasks.)\n";
    } else {
      for (const { task, listTitle } of openTasks) {
        const dueStr = task.due ? ` | Fällig: ${new Date(task.due).toLocaleDateString('de-DE')}` : '';
        const notesStr = task.notes ? ` | Notiz: ${task.notes.replace(/\n+/g, ' ')}` : '';
        tasksContext += `- [OFFEN] ${task.title} | Liste: ${listTitle}${dueStr} | Direktlink: ${tasksUrl}${notesStr}\n`;
      }
    }

    tasksContext += "ERLEDIGT (dürfen durch ältere E-Mails, Chats, Kalender oder Drive-Dokumente NICHT reaktiviert werden):\n";
    if (completedTasks.length === 0) {
      tasksContext += "(Keine in den letzten 180 Tagen erledigten Aufgaben gefunden.)\n";
    } else {
      for (const { task, listTitle } of completedTasks) {
        const completedStr = task.completed ? new Date(task.completed).toLocaleDateString('de-DE') : 'unbekannt';
        tasksContext += `- [ERLEDIGT] ${task.title} | Liste: ${listTitle} | Erledigt am: ${completedStr} | Direktlink: ${tasksUrl}\n`;
      }
    }

    return tasksContext;
  } catch (e: any) {
    console.warn("Tasks fetch notice:", e?.message || e);
    return "(Google Tasks konnten nicht abgerufen werden)\n";
  }
}

// Function to recursively list files in the knowledge base folder
async function listAllFiles(drive: any, folderId: string, pathPrefix = '') {
  let files: any[] = [];
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime)',
    });
    
    for (const file of res.data.files || []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const subFiles = await listAllFiles(drive, file.id, `${pathPrefix}${file.name}/`);
        files = files.concat(subFiles);
      } else {
        files.push({ ...file, path: `${pathPrefix}${file.name}` });
      }
    }
  } catch (e: any) {
    console.warn(`Drive files listing notice in folder ${folderId}:`, e?.message || e);
  }
  return files;
}

async function getFileContent(drive: any, fileId: string, mimeType: string) {
  try {
    if (mimeType.includes('google-apps.document')) {
      const res = await drive.files.export({
        fileId,
        mimeType: 'text/plain',
      });
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    } else if (mimeType.includes('google-apps.spreadsheet')) {
      const res = await drive.files.export({
        fileId,
        mimeType: 'text/csv',
      });
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    } else if (mimeType.includes('google-apps.presentation')) {
      const res = await drive.files.export({
        fileId,
        mimeType: 'text/plain',
      });
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    } else {
      const res = await drive.files.get({
        fileId,
        alt: 'media',
      });
      if (typeof res.data === 'string') return res.data;
      if (Buffer.isBuffer(res.data)) return res.data.toString('utf-8');
      return typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
    }
  } catch (e: any) {
    console.warn(`Drive file reading notice ${fileId}:`, e?.message || e);
    return null;
  }
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

export async function fetchDriveKnowledgeBaseContext(accessToken: string) {
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
      const targetQuery = "trashed = false and (name contains 'Schwarz' or name contains 'DSV' or name contains 'Vorbereitung' or name contains 'Use Case' or name contains 'Memory' or name contains 'Briefing' or name contains 'Meeting' or name contains 'Protokoll' or name contains 'Transkript' or name contains 'Notes' or name contains 'Sync' or name contains 'Besprechung' or name contains 'Koenig' or name contains 'Bauer' or name contains 'PK' or name contains 'Lorenz' or name contains 'domcura' or name contains 'voestalpine' or name contains 'VOEST' or name contains 'Alpine')";
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

    // Sort by modifiedTime descending so freshest notes come first
    eligibleFiles.sort((a, b) => {
      const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
      const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
      return timeB - timeA;
    });

    let contextData = "";
    for (const file of eligibleFiles) {
      const content = await getFileContent(drive, file.id, file.mimeType);
      if (content && typeof content === 'string') {
        const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n...[Gekürzt wegen Länge]" : content;
        
        const modDateObj = file.modifiedTime ? new Date(file.modifiedTime) : null;
        const modDateStr = modDateObj ? modDateObj.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
        const isOnboardingOrFuturePlan = /einarbeitung|onboarding|mitarbeiter|plan|september|schulung|welcome|new\s*joiner/i.test(file.path || file.name) || /einarbeitung|onboarding|september|neuer\s*mitarbeiter/i.test(truncated.slice(0, 500));
        
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

        contextData += `--- DOKUMENT / TRANSKRIPT / VORBEREITUNG: "${file.path || file.name}" | Direktlink: ${docUrl}${prepHighlight}${ageNotice} ---\n${truncated}\n\n`;
      }
    }
    const localMem = loadLocalMemoryContext();
    return (localMem + contextData) || "(Keine Dokumente, Meeting-Protokolle oder Transkripte im Google Drive gefunden.)\n";
  } catch (e: any) {
    console.warn("Drive knowledge base fetch notice:", e?.message || e);
    return "(Dokumente / Meeting-Protokolle aus Google Drive konnten nicht geladen werden)\n";
  }
}

// --- GOOGLE WORKSPACE ACTIONS ENDPOINTS & SANITIZATION ---

function applyCanonicalSpellingCorrections(text: string): string {
  if (!text) return "";
  let corrected = text;
  corrected = corrected.replace(/\bDom\s*Kura\b/gi, 'domcura');
  corrected = corrected.replace(/\bDomKura\b/g, 'domcura');
  corrected = corrected.replace(/\bFirst\s*Alpina\b/gi, 'VOEST Alpine');
  corrected = corrected.replace(/\bFirst\s*Alpine\b/gi, 'VOEST Alpine');
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

function removeCompletedTaskRecommendations(text: string, completedTitles: string[]): string {
  if (completedTitles.length === 0) return text;
  const sectionStart = text.search(/^## 4\.\s/m);
  if (sectionStart < 0) return text;

  const actionStart = text.indexOf('<ACTION_PROPOSALS>', sectionStart);
  const sectionEnd = actionStart >= 0 ? actionStart : text.length;
  const before = text.slice(0, sectionStart);
  const section = text.slice(sectionStart, sectionEnd).replace(
    /^- \*\*([^*\n]+)\*\*[\s\S]*?(?=^- \*\*|$)/gm,
    (block, title) => completedTitles.some(completed => areTaskTextsSimilar(title, completed)) ? '' : block
  );
  return before + section + text.slice(sectionEnd);
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
  if (!text.includes('<ACTION_PROPOSALS>')) {
    text = removeCompletedTaskRecommendations(text, taskStates.completed);
    text = convertMarkdownTablesToCleanText(text);
    text = text.replace(/###?\s*📅?\s*Datenbasis\s*&?\s*Zeiträume[\s\S]*?(?=(?:###?|\n\n[1-5]\.|\n\n[A-Z]))/gi, '').trim();
    text = text.replace(/-\s*\*\*Kalender:\*\*[\s\S]*?(?=\n\n|\n[1-5]\.)/gi, '').trim();
    return text;
  }

  const match = text.match(/<ACTION_PROPOSALS>([\s\S]*?)<\/ACTION_PROPOSALS>/);
  if (!match) return removeCompletedTaskRecommendations(text, taskStates.completed);

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

        // Filter out false Panda underutilization proposals
        if ((titleLower.includes('panda') || notesLower.includes('panda')) && /auslastung|kapazität|unausgelastet|leerlauf/i.test(titleLower + ' ' + notesLower)) {
          console.log(`[Panda Filter] Removed invalid Panda underutilization proposal: "${p.title}"`);
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

  text = removeCompletedTaskRecommendations(text, taskStates.completed);

  // 5. Convert any markdown tables to clean bullet and paragraph formatting
  text = convertMarkdownTablesToCleanText(text);

  // 6. Strip any residual data sources / catalog lists from header
  text = text.replace(/###?\s*📅?\s*Datenbasis\s*&?\s*Zeiträume[\s\S]*?(?=(?:###?|\n\n[1-5]\.|\n\n[A-Z]))/gi, '').trim();
  text = text.replace(/-\s*\*\*Kalender:\*\*[\s\S]*?(?=\n\n|\n[1-5]\.)/gi, '').trim();

  return text;
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
4. KONFLIKTPRIORITÄT: Neueste explizite Nutzerkorrektur im lokalen Memory > Google-Tasks-Status > neueste datierte Mail/Chat/Meeting-Notiz > ältere Quellen.
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
3. Panda Auslastung:
   - Panda ist voll ausgelastet / regulär im Einsatz. Schlage KEINE To-Dos oder Warnungen bzgl. "Panda unausgelastet" oder "Kapazitätsengpässe" vor.
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
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Nicht authentifiziert" });
  }
  const token = authHeader.split(' ')[1];
  try {
    const oauth2Client = getOAuth2Client(token);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const { to, subject, body, isDraft = true } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: "Empfänger (to), Betreff (subject) und Text (body) sind erforderlich." });
    }

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
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Nicht authentifiziert" });
  }
  const token = authHeader.split(' ')[1];
  try {
    const oauth2Client = getOAuth2Client(token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { summary, description, startTime, endTime } = req.body;

    if (!summary || !startTime) {
      return res.status(400).json({ error: "Titel (summary) und Startzeit (startTime) sind erforderlich." });
    }

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
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Nicht authentifiziert" });
  }
  const token = authHeader.split(' ')[1];
  try {
    const oauth2Client = getOAuth2Client(token);
    const chat = google.chat({ version: 'v1', auth: oauth2Client });
    const { text, spaceName } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Nachrichtentext ist erforderlich." });
    }

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
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Nicht authentifiziert" });
  }
  const token = authHeader.split(' ')[1];
  try {
    const drive = await getDriveClient(token);
    const { fileName = `Notiz_${new Date().toISOString().split('T')[0]}.md`, content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Inhalt für das Dokument ist erforderlich." });
    }

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
    const contextData = await fetchDriveKnowledgeBaseContext(accessToken);
    const emailsContext = await fetchRecentEmails(oauth2Client);
    const eventsContext = await fetchUpcomingEvents(oauth2Client);
    const chatsContext = await fetchRecentChats(oauth2Client);
    const tasksContext = await fetchTasks(oauth2Client);
    const localMemoryContext = loadLocalMemoryContext();

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
   - **Panda**: Panda ist voll ausgelastet / regulär im operativen Einsatz. Keine Behauptungen über Unterauslastung oder Kapazitätsengpässe!
   - **HiBob / Nils Traut**: Administrative Stundenzettel-Freigaben sind bereits erledigt und dürfen keinesfalls als offene Aufgaben vorgeschlagen werden.

12. 🔍 OBLIGATORISCHE ANKLICKBARE QUELLENANGABEN (MARKDOWN-LINKS):
   - Jede einzelne Information, jedes Projektupdate, jede Vorbereitungsnotiz und jedes To-Do MUSS am Ende des jeweiligen Punkts mit einer genauen, ANKLICKBAREN Quellenangabe als Markdown-Link belegt werden (nutze die URLs aus "Direktlink:" im Kontext)!
   - Beispiele: \`[Quelle: Google Drive – "Transkript PK Montag"](https://...)\`, \`[Quelle: Google Chat – "Raum DATA Squad"](https://...)\`, \`[Quelle: Gmail – Betreff "...", 18.08.](https://...)\`, \`[Quelle: Google Kalender – "1:1 Marion"](https://...)\`, \`[Quelle: Google Tasks – Liste "Meine Aufgaben"](https://tasks.google.com/)\`.

13. 📐 EINHEITLICHES AUSGABEFORMAT (4 ABSCHNITTE, DETERMINISTISCH & OHNE TABELLEN):
   - Wenn ein Daily Briefing, Sync, Status-Bericht oder Lagebild angefragt wird, folge IMMER exakt dieser 4-teiligen Struktur:
     # ☀️ Tägliches Management-Update (<Datum>)
     <2-3 Sätze Executive Summary>
     ---
     ## 1. 🚨 Proaktive Kunden- & Meeting-Vorbereitung (Heute, Morgen & Montag)
     - **<Kunde / Termin>** — <Datum / Zeit>
       • **Agenda & Kontext:** <Inhalte & offene Punkte>
       • **Vorbereitungs-Status & To-Dos:** <Was ist vorbereitet / was zu tun>
       • [Quelle: <Name>](<URL>)
     ---
     ## 2. 📋 Lückenloser Status aller aktiven Kunden & Projekte
     - **<Projektname>** (z. B. Schwarz / DSV, Koenig & Bauer, domcura, VOEST Alpine, Lorenz, Squad / Team)
       • **Status:** <🟢 On Track / 🟡 In Klärung / 🟠 Wartend auf Input>
       • **Aktueller Stand:** <Präziser Kontext>
       • **Wartezustand & Nächste Schritte:** <Konkrete Aufgaben>
       • [Quelle: <Name>](<URL>)
     ---
     ## 3. 🔮 Vorausschau & Wochenausblick (Nächste Tage / Montag)
     - **<Fokusbereich / Tag>**
       • **Anstehend:** <Fristen / Termine / Vorbereitungsbedarf>
       • [Quelle: <Name>](<URL>)
     ---
     ## 4. 💡 Konkrete nächste Schritte & Handlungsempfehlungen
     - **<Handlung / To-Do>** — Fälligkeit: <Datum>
       • **Details:** <Wer, was, warum>
       • [Quelle: <Name>](<URL>)

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

${getActionProposalsInstruction()}
${todayCanonicalBriefing}

Hier sind die Inhalte aus Hardys Knowledge Base (Google Drive):
${contextData}

${emailsContext}

${eventsContext}

${chatsContext}

${tasksContext}

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

  // Always perform a live, fresh evaluation of all connected Google Workspace sources
  console.log(`[Daily Briefing] Performing live real-time analysis for ${dateStr}...`);

  const driveContext = await fetchDriveKnowledgeBaseContext(accessToken);
  const emailsContext = await fetchRecentEmails(oauth2Client);
  const eventsContext = await fetchUpcomingEvents(oauth2Client);
  const chatsContext = await fetchRecentChats(oauth2Client);
  const tasksContext = await fetchTasks(oauth2Client);
  const localMemoryContext = loadLocalMemoryContext();

  const nowStr = new Date().toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });

  const prompt = `Erstelle ein fokussiertes, tägliches Management-Briefing und Update basierend auf allen verknüpften Quellen (Google Drive Dokumente & Meeting-Protokolle, E-Mails, Kalender, Google Chat und Google Tasks).

WICHTIGE LAYOUT- & FORMATIERUNGSREGELN:
- HEADER: Beginne direkt mit dem Briefing-Titel (z. B. "# ☀️ Tägliches Management-Update (${nowStr})") und einer prägnanten 2-3-Satz-Zusammenfassung der heutigen Prioritäten. KEINE Aufzählung von Datenquellen im Header!
- STRIKTES TABELLEN-VERBOT: Verwende NIEMALS Markdown-Tabellen! Formatiere ALLE Inhalte in sauberen Text-Absätzen und Aufzählungslisten (Bullet Points).
- ANKLICKBARE QUELLEN-LINKS: Jede Information und jedes To-Do MUSS am Ende mit einer anklickbaren Quellenangabe als Markdown-Link belegt werden (z. B. [Quelle: Google Drive – "Transkript PK Montag"](https://...), [Quelle: Gmail – Betreff "...", Datum](https://...), [Quelle: Google Kalender – "1:1 Marion"](https://...)). Nutze stets die Direktlinks aus den Quellen-Abschnitten!
- KEINE IGNORIERTEN TERMINE IM BERICHT: Erstelle NIEMALS einen Abschnitt oder Punkt wie "Ignorierte interne Termine". "Thursdays for Data" wird komplett stillschweigend ignoriert.

FESTE 4-TEILIGE BRIEFING-STRUKTUR:

# ☀️ Tägliches Management-Update (${nowStr})
<2-3 prägnante Sätze Executive Summary / Fokus des Tages>

---

## 1. 🚨 Proaktive Kunden- & Meeting-Vorbereitung (Heute, Morgen & Montag)
- **<Kunde / Termin>** — <Datum / Uhrzeit>
  • **Agenda & Kontext:** <Inhalte, Ziele, offene Fragen>
  • **Vorbereitungs-Status & To-Dos:** <Was ist vorbereitet / was ist heute zu tun>
  • [Quelle: <Name>](<URL>)

---

## 2. 📋 Lückenloser Status aller aktiven Kunden & Projekte
- **<Projektname>** (z. B. Schwarz / DSV, Koenig & Bauer, domcura, VOEST Alpine, Lorenz, Squad / Team)
  • **Status:** <🟢 On Track / 🟡 In Klärung / 🟠 Wartend auf Input>
  • **Aktueller Stand:** <Präziser Kontext aus Drive, Mails, Chats>
  • **Wartezustand & Nächste Schritte:** <Konkrete Aufgaben / Wer wartet auf wen>
  • [Quelle: <Name>](<URL>)

---

## 3. 🔮 Vorausschau & Wochenausblick (Nächste Tage / Montag)
- **<Fokusbereich / Wochentag>**
  • **Anstehende Fristen & Termine:** <Was steht an>
  • **Vorbereitungsbedarf vorab:** <Was muss heute/vorab vorbereitet werden>
  • [Quelle: <Name>](<URL>)

---

## 4. 💡 Konkrete nächste Schritte & Handlungsempfehlungen
- **<Handlungsempfehlung>** — Fälligkeit: <Datum>
  • **Details:** <Wer, was, warum>
  • [Quelle: <Name>](<URL>)

--- GOOGLE DRIVE (MEETING NOTES & DOKUMENTE) ---
${driveContext}

--- E-MAILS ---
${emailsContext}

--- KALENDER ---
${eventsContext}

--- CHATS ---
${chatsContext}

--- TO-DOS ---
${tasksContext}

--- AUTORITATIVE NUTZERKORREKTUREN (ÜBERSCHREIBEN ÄLTERE QUELLEN) ---
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
3. MANDATORISCHE AKTUALITÄTSPRÜFUNG: Überprüfe jedes Thema vor der Anzeige auf Aktualität. Wenn eine E-Mail, Notiz oder Aufgabe länger als 7-14 Tage zurückliegt und kein anstehender Termin oder offener Task vorliegt, ist das Thema inaktiv und wird NICHT mehr angezeigt.
   Konfliktpriorität: neueste explizite Nutzerkorrektur im lokalen Memory > Google-Tasks-Status > neueste datierte Mail/Chat/Meeting-Notiz > ältere Quelle. [ERLEDIGT] darf nie aus alten Quellen reaktiviert werden; [OFFEN] bleibt aktiv.
4. Universelle Analyse von Transkripten & Projekt-Zuweisungen: Analysiere Transkripte und Mitschriften aus E-Mails, Drive und Besprechungen lückenlos und leite konkrete To-Dos für jede Hardy zugewiesene Aufgabe, Zusage oder Projektverantwortung ab.
5. End-to-End Pipeline-, Scoping- & SoW-Tracking: Erfasse Use Cases, Leistungsanforderungen und Deliverables aus Kunden-, Partner- und Vertriebs-Gesprächen. Tracke Wartezustände (z. B. Warten auf Use Cases/Input, anschließende SoW-Generierung) und schlage dafür proaktiv Nachfass- & Entwurfs-To-Dos vor.
6. Proaktive Meeting-Vorbereitung (spätestens 1 Tag vorher): Bereite Hardy auf Kunden- und Use-Case-Meetings (wie Schwarz / DSV) für heute, morgen und Montag basierend auf vorhandenen Notizen und eingetragenen Vorbereitungen vor.
7. Vorausschau: Schaue vorausschauend auf Montag und die nächste Woche.
8. Vollständigkeit: Gehe lückenlos alle aktiven, unerledigten Themen durch und synchronisiere sie mit den neuesten Quellen.
9. Querabgleich mit Terminen: Wenn heute ein Meeting (z. B. 1:1 mit Teammitgliedern) ansteht, nimm besprechbare Punkte als Meeting-Agendapunkte auf – erstelle aber To-Dos für echte Vorbereitungsaufgaben und vergangene Action Items!
10. Abgeschlossene Aufgaben: Alle mit [ERLEDIGT] markierten oder im lokalen Memory explizit abgeschlossenen Einzelaufgaben dürfen nie erneut vorgeschlagen werden. Projekte nicht pauschal abschliessen; offene Google Tasks desselben Projekts bleiben gültig.
11. Ignorierte Termine: "Thursdays for Data" ist intern und wird immer still ignoriert. KEINEN Abschnitt "Ignorierte interne Termine" erstellen!
12. Projekt-Fakten & Schreibweisen:
    - "domcura" (immer kleingeschrieben).
    - "VOEST Alpine" (immer "VOEST Alpine").
    - Koenig & Bauer: Interne Treffen finden statt, um Budgetfrage zu klären (aus PK vom Montag).
    - Lorenz Funding: Nicht nutzen, keine Screenshots/Anträge, Stunden werden intern umgebucht.
    - Panda: Voll ausgelastet, keine Kapazitätswarnungen.
    - HiBob / Nils Traut: Stundenzettel-Freigaben sind erledigt, keinesfalls als Task vorschlagen.
13. OBLIGATORISCHE ANKLICKBARE QUELLENANGABEN (MARKDOWN-LINKS):
    - Jedes Projektupdate, jeder Status, jede Vorbereitungsnotiz und jedes To-Do MUSS am Ende mit einer anklickbaren Quellenangabe als Markdown-Link belegt werden (nutze die URLs aus den Kontextblöcken, z. B. \`[Quelle: Google Drive – "Transkript PK"](https://...)\`, \`[Quelle: Google Chat – "DATA Squad"](https://...)\`, \`[Quelle: Gmail – Betreff "...", Datum](https://...)\`, \`[Quelle: Google Kalender – Termin ...](https://...)\`, \`[Quelle: Google Tasks – Liste "..."](https://tasks.google.com/)\`).
14. TEAM & ONBOARDING NEUER MITARBEITER (Z. B. SEPTEMBER):
    - Einarbeitungspläne und Onboarding-Konzepte für neue Teammitglieder (insbesondere für September) sind strategische Führungsaufgaben von Squad Lead Hardy. Proaktiv in die Vorausschau und Handlungsempfehlungen aufnehmen und konkrete Vorbereitungs-To-Dos (Einarbeitungsplan abstimmen, Hardware/Zugänge prüfen, Buddy festlegen, 1:1 Termine und Schulungsslots im Kalender einstellen) ableiten!
15. SELBSTKONTROLLE & LÜCKENLOSE VOLLSTÄNDIGKEIT:
    - Kontrolliere vor der Ausgabe selbst, ob alle aktiven Kundenprojekte, Onboarding-Pläne, offenen Tasks, Termine und neuen Chat-/Mail-Inhalte vollständig und transparent erfasst sind und kein Punkt 4 für ignorierte Termine existiert.\n\n${getActionProposalsInstruction()}`
    }
  });

  const summary = sanitizeActionProposals(response.text || "Kein Update generiert.", tasksContext, eventsContext);

  let createdTasks: { title: string; id?: string; error?: string }[] = [];
  if (options.autoCreateTasks) {
    const proposalsMatch = summary.match(/<ACTION_PROPOSALS>([\s\S]*?)<\/ACTION_PROPOSALS>/i);
    if (proposalsMatch) {
      try {
        let jsonStr = proposalsMatch[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim().replace(/,\s*([\]}])/g, '$1');
        const proposals = JSON.parse(jsonStr);
        const taskProposals = Array.isArray(proposals) ? proposals.filter((p: any) => p && p.type === 'task') : [];
        for (const tp of taskProposals) {
          try {
            const title = tp.details?.title || tp.title;
            const notes = tp.details?.notes || '';
            const dueDate = tp.details?.dueDate;
            const r = await createGoogleTaskDirect(title, notes, dueDate, accessToken);
            createdTasks.push({ title, id: r.id });
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
  
  // E-Mail senden
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profileRes = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profileRes.data.emailAddress;
    
    if (emailAddress) {
      const cleanEmailContent = cleanContentForEmail(summary);
      const utf8Subject = `=?utf-8?B?${Buffer.from(`Dein tägliches Memory Update - ${dateStr}`).toString('base64')}?=`;
      const messageParts = [
        `To: ${emailAddress}`,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        `Subject: ${utf8Subject}`,
        '',
        cleanEmailContent,
      ];
      const emailBody = messageParts.join('\r\n');
      const encodedMessage = Buffer.from(emailBody)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
        
      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
      });
      console.log("Email sent successfully to", emailAddress);
      emailSent = true;
    }
  } catch (emailError: any) {
    console.error("Failed to send email:", emailError.message || emailError);
    emailErrorMsg = emailError.message || String(emailError);
    // Continue even if email fails, so we don't break the whole process if only email failed
  }
  
  const result = { summary, emailSent, emailErrorMsg, lastRunAt: new Date().toISOString(), dateStr, success: true, createdTasks };
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
    const driveContext = await fetchDriveKnowledgeBaseContext(token);
    const tasksContext = await fetchTasks(oauth2Client);
    const eventsContext = await fetchUpcomingEvents(oauth2Client);
    const emailsContext = await fetchRecentEmails(oauth2Client);
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

// Täglich um 9:00 Uhr laufen lassen (Europe/Berlin Zeit)
if (isMain) {
cron.schedule('0 9 * * *', async () => {
  const token = loadStoredToken();
  if (!token) {
    console.log("Daily update skipped at 09:00: No stored access token available.");
    saveCronStatus({
      lastRunAt: new Date().toISOString(),
      dateStr: new Date().toISOString().split('T')[0],
      error: "Übersprungen: Kein Zugriffstoken vorhanden. Bitte im Browser anmelden.",
      success: false
    });
    return;
  }
  console.log("Running daily automated update at 09:00...");
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
