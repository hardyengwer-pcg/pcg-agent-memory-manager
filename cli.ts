import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { exec } from 'child_process';
import readline from 'readline';
import { google } from 'googleapis';
import {
  GoogleAuthError,
  isAuthError,
  loadStoredToken,
  saveToken,
  clearStoredToken,
  getCronStatus,
  fetchTasks,
  fetchUpcomingEvents,
  fetchRecentEmails,
  fetchRecentChats,
  fetchDriveKnowledgeBaseContext,
  performDailyUpdate,
  createGoogleTaskDirect,
  getOAuth2Client,
  cleanContentForEmail,
  generateAIContent,
  formatAIError,
} from './server.ts';

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, '.env');
const REFRESH_FILE = path.join(ROOT, 'agent-memory', '.google-refresh-token.json');

const CHAT_MARKER = '[PCG-Agent]';
const CHAT_STATE_FILE = path.join(ROOT, '.chat-state.json');

const DEFAULT_CLIENT_ID = '261415172337-16a674uqih6mk269b0hj8q61qguq6scp.apps.googleusercontent.com';
const REDIRECT_PORT = Number(process.env.GOOGLE_REDIRECT_PORT || 4315);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/tasks',
].join(' ');

function base64url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(question, (answer) => { rl.close(); r(answer.trim()); });
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(question);
  return answer.toLowerCase().startsWith('j');
}

function postForm(url: string, params: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Ungültige Server-Antwort: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function exchangeCode(code: string, verifier: string, clientSecret: string) {
  const params: Record<string, string> = {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  };
  if (clientSecret) params.client_secret = clientSecret;
  return postForm('https://oauth2.googleapis.com/token', params);
}

async function refreshAccessToken(refreshToken: string, clientSecret: string) {
  const params: Record<string, string> = {
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID,
    grant_type: 'refresh_token',
  };
  if (clientSecret) params.client_secret = clientSecret;
  return postForm('https://oauth2.googleapis.com/token', params);
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` :
              process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.warn('Browser konnte nicht automatisch geöffnet werden.'); });
}

function loadRefreshToken(): string | null {
  if (process.env.GOOGLE_REFRESH_TOKEN) return process.env.GOOGLE_REFRESH_TOKEN;
  try {
    if (fs.existsSync(REFRESH_FILE)) {
      const data = JSON.parse(fs.readFileSync(REFRESH_FILE, 'utf-8'));
      if (data.refresh_token) return data.refresh_token;
    }
  } catch {}
  return null;
}

function saveTokenFile(data: any) {
  fs.mkdirSync(path.dirname(REFRESH_FILE), { recursive: true });
  fs.writeFileSync(REFRESH_FILE, JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

function setEnvValue(key: string, value: string) {
  let content = '';
  try { content = fs.readFileSync(ENV_FILE, 'utf-8'); } catch {}
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(ENV_FILE, content, 'utf-8');
  process.env[key] = value;
}

async function getAccessToken(): Promise<string> {
  const refreshToken = loadRefreshToken();
  if (!refreshToken) {
    throw new Error('Kein Google-Refresh-Token gefunden. Bitte zuerst ausführen: npm run agent -- auth');
  }
  const data = await refreshAccessToken(refreshToken, process.env.GOOGLE_CLIENT_SECRET || '');
  if (data.error) {
    throw new Error(`Token-Refresh fehlgeschlagen: ${data.error_description || data.error}`);
  }
  if (!data.access_token) throw new Error('Kein Access-Token erhalten.');
  saveToken(data.access_token);
  return data.access_token;
}

function getChatSpaceId(): string {
  const id = process.env.CHAT_SPACE_ID;
  if (!id) {
    throw new Error('CHAT_SPACE_ID fehlt in .env. Erst ausführen: npm run agent -- chat-spaces');
  }
  return id.startsWith('spaces/') ? id : `spaces/${id}`;
}

function splitChatMessage(text: string, maxLength = 3400): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < maxLength / 2) splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength / 2) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt <= 0) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function loadChatState(): string | null {
  try {
    if (fs.existsSync(CHAT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CHAT_STATE_FILE, 'utf-8')).lastCreateTime || null;
    }
  } catch {}
  return null;
}

function saveChatState(lastCreateTime: string) {
  fs.writeFileSync(CHAT_STATE_FILE, JSON.stringify({ lastCreateTime, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

async function cmdChatSpaces() {
  const accessToken = await getAccessToken();
  const chat = google.chat({ version: 'v1', auth: getOAuth2Client(accessToken) });
  const res = await chat.spaces.list({ pageSize: 100 });
  const spaces = res.data.spaces || [];
  console.log('\nGoogle Chat Räume:\n');
  for (const s of spaces) {
    console.log(`- ${s.name} | ${s.spaceType} | ${s.displayName || '(ohne Namen)'}`);
  }
  console.log('\nTipp: In Google Chat einen privaten Raum (z. B. "PCG Agent") erstellen und');
  console.log('dessen ID (z. B. spaces/XXXX) als CHAT_SPACE_ID in .env eintragen.\n');
}

async function cmdChatSend(text: string) {
  const accessToken = await getAccessToken();
  const chat = google.chat({ version: 'v1', auth: getOAuth2Client(accessToken) });
  const res = await chat.spaces.messages.create({
    parent: getChatSpaceId(),
    requestBody: { text: `${CHAT_MARKER} ${text}` },
  });
  console.log(`Nachricht gesendet (${res.data.name})`);
}

async function processChatCommand(text: string, token: string, oauth2Client: any): Promise<string> {
  const systemInstruction = `Du bist der PCG Agent Memory Manager, der persönliche KI-Assistent von Hardy Engwer (Squad Lead DATA / AI Consultant bei PCG). Interpretiere die folgende Chat-Nachricht von Hardy und übersetze sie in GENAU EIN JSON-Aktionsobjekt. Antworte ausschließlich mit:

<ACTION>
{ "action": "task" | "calendar" | "email" | "todos" | "status" | "daily", "title": "", "notes": "", "dueDate": "", "startTime": "", "to": "", "subject": "", "body": "" }
</ACTION>

Regeln:
- task: Aufgabe in Google Tasks anlegen. title = Aufgabe, dueDate als YYYY-MM-DD (falls genannt, sonst leer), notes = Details.
- calendar: Kalendertermin anlegen. title = Titel, startTime = "YYYY-MM-DDTHH:MM:SS" (aus der Nachricht ableiten).
- email: E-Mail senden. to, subject, body füllen. to leer lassen, wenn nicht genannt (dann wird es an Hardy selbst gesendet).
- todos: Liste der offenen Google Tasks ausgeben (keine weiteren Felder nötig).
- status: Status des letzten Daily-Updates ausgeben.
- daily: Das komplette tägliche Update (Briefing + Tasks + E-Mail) jetzt auslösen.
- Wenn die Absicht unklar ist, wähle action="todos".
Antworte NUR mit dem <ACTION>-Block, kein anderer Text.`;

  const response = await generateAIContent({
    contents: `Chat-Nachricht von Hardy: ${text}`,
    config: { temperature: 0.0, systemInstruction },
  });

  const raw = (response.text || '').trim();
  const match = raw.match(/<ACTION>([\s\S]*?)<\/ACTION>/);
  if (!match) return `Konnte Befehl nicht interpretieren: "${text}"`;

  let action: any;
  try {
    const cleaned = match[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    action = JSON.parse(cleaned);
  } catch {
    return `JSON-Parse-Fehler bei Befehl: "${text}"`;
  }

  try {
    switch (action.action) {
      case 'task': {
        const r = await createGoogleTaskDirect(action.title, action.notes || '', action.dueDate || '', token);
        return `Task erstellt: ${action.title}${r.id ? ` (ID: ${r.id})` : ''}`;
      }
      case 'calendar': {
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const start = new Date(action.startTime);
        if (isNaN(start.getTime())) return `Ungültige Zeit: ${action.startTime}`;
        const end = new Date(start.getTime() + 60 * 60000);
        const created = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: action.title,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
          },
        });
        return `Termin erstellt: ${action.title} (${action.startTime}, ID: ${created.data.id})`;
      }
      case 'email': {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const to = action.to || profile.data.emailAddress;
        const utf8Subject = `=?utf-8?B?${Buffer.from(action.subject || 'PCG Agent').toString('base64')}?=`;
        const body = [
          `To: ${to}`,
          'Content-Type: text/plain; charset=utf-8',
          'MIME-Version: 1.0',
          `Subject: ${utf8Subject}`,
          '',
          action.body || '',
        ].join('\r\n');
        const encoded = Buffer.from(body).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
        return `E-Mail gesendet an ${to}: ${action.subject}`;
      }
      case 'status': {
        const cron = getCronStatus();
        return cron?.summary
          ? `Letzter Daily-Run: ${cron.dateStr || '?'}\n\n${cleanContentForEmail(cron.summary).slice(0, 2000)}`
          : 'Noch kein Daily-Update vorhanden. Nutze "daily", um es jetzt auszulösen.';
      }
      case 'daily': {
        const result = await performDailyUpdate(token, true, { autoCreateTasks: true });
        const tasks = (result.createdTasks || []).map((t) => `${t.error ? 'FEHLER' : 'OK'}: ${t.title}`).join('\n') || 'keine';
        return `Daily-Update abgeschlossen (${result.dateStr}).\nErstellte Tasks:\n${tasks}\nE-Mail: ${result.emailSent ? 'gesendet' : 'fehlgeschlagen'}.`;
      }
      case 'todos':
      default: {
        const context = await fetchTasks(oauth2Client);
        return context ? context.slice(0, 3000) : 'Keine Tasks gefunden.';
      }
    }
  } catch (err: any) {
    return `Aktion fehlgeschlagen: ${err?.message || err}`;
  }
}

async function cmdChatProcess() {
  const accessToken = await getAccessToken();
  const oauth2Client = getOAuth2Client(accessToken);
  const chat = google.chat({ version: 'v1', auth: oauth2Client });
  const spaceId = getChatSpaceId();

  const listRes = await chat.spaces.messages.list({ parent: spaceId, pageSize: 50, orderBy: 'createTime desc' });
  const messages = (listRes.data.messages || []).reverse();

  const lastTime = loadChatState();
  let newMax = lastTime || '';
  const commands: { text: string; time: string }[] = [];

  for (const m of messages) {
    const t = m.createTime || '';
    if (t > newMax) newMax = t;
    if (lastTime && t <= lastTime) continue;
    const text = (m.text || '').trim();
    if (!text || text.startsWith(CHAT_MARKER)) continue;
    commands.push({ text, time: t });
  }

  if (!lastTime) {
    saveChatState(newMax || new Date().toISOString());
    console.log('Initialer Chat-Stand gesetzt. Schicke eine Nachricht in den Raum und starte erneut:');
    console.log('npm run agent -- chat-process');
    return;
  }

  if (commands.length === 0) {
    console.log('Keine neuen Chat-Befehle gefunden.');
    return;
  }

  console.log(`${commands.length} neue Chat-Befehle gefunden. Verarbeite...`);
  const replies: string[] = [];
  for (const cmd of commands) {
    console.log(`- Befehl: ${cmd.text.slice(0, 80)}`);
    replies.push(await processChatCommand(cmd.text, accessToken, oauth2Client));
  }

  if (newMax) saveChatState(newMax);
  await chat.spaces.messages.create({
    parent: spaceId,
    requestBody: { text: `${CHAT_MARKER} ${replies.join('\n\n')}` },
  });
  console.log('Antwort in den Chat-Raum gepostet.');
}

async function cmdAuth(force: boolean) {
  console.log('\nPCG Agent – Google Einmal-Anmeldung (CLI)\n');

  const existing = loadRefreshToken();
  if (existing && !force) {
    const ok = await confirm('Bereits angemeldet. Neu anmelden? (j/N): ');
    if (!ok) { console.log('Abgebrochen.'); return; }
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  let resolveCode: (code: string | null) => void;
  const codePromise = new Promise<string | null>((r) => { resolveCode = r; });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Fehler: ${error}</h2><p>Dieses Fenster kann geschlossen werden.</p>`);
      resolveCode!(null);
      return;
    }
    if (code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f0f10;color:#4ade80;display:flex;align-items:center;justify-content:center;height:100vh;"><h1>Erfolgreich angemeldet!</h1></body></html>');
      resolveCode!(code);
    }
  });

  await new Promise<void>((r) => server.listen(REDIRECT_PORT, '127.0.0.1', () => r()));
  console.log(`Lokaler Auth-Server gestartet auf Port ${REDIRECT_PORT}...`);
  console.log('Browser wird geöffnet. Falls nicht: Kopiere diese URL manuell:');
  console.log('\n' + authUrl.toString() + '\n');
  console.log('Wichtig: Falls "Google hasn\'t verified this app" erscheint, wähle');
  console.log('"Advanced" -> "Go to ... (unsafe)" und bestätige alle Scopes.');
  openBrowser(authUrl.toString());

  console.log('Warte auf Google-Anmeldung...\n');
  const code = await codePromise;
  server.close();

  if (!code) {
    console.error('Keine Autorisierung erhalten. Abgebrochen.');
    process.exit(1);
  }

  console.log('Tausche Code gegen Token...');
  let tokenData = await exchangeCode(code, verifier, process.env.GOOGLE_CLIENT_SECRET || '');

  if (tokenData.error === 'invalid_client' || tokenData.error === 'unauthorized_client') {
    console.warn('\nPKCE ohne Client Secret wird von diesem OAuth-Client nicht unterstützt.');
    console.warn('Bitte in der Google Cloud Console einen "Desktop App" OAuth-Client anlegen');
    console.warn('und das Client Secret hier eingeben (oder GOOGLE_CLIENT_ID/SECRET in .env setzen):');
    const secret = await prompt('Client Secret: ');
    tokenData = await exchangeCode(code, verifier, secret.trim());
    if (!tokenData.error) setEnvValue('GOOGLE_CLIENT_SECRET', secret.trim());
  }

  if (tokenData.error) {
    console.error('Token-Exchange-Fehler:', tokenData.error_description || tokenData.error);
    console.error('Hinweis: In der Google Cloud Console muss als Redirect URI vorhanden sein:');
    console.error(REDIRECT_URI);
    process.exit(1);
  }

  if (!tokenData.refresh_token) {
    console.error('Kein Refresh-Token erhalten. Erneut anmelden mit --force.');
    process.exit(1);
  }

  setEnvValue('GOOGLE_REFRESH_TOKEN', tokenData.refresh_token);
  saveTokenFile(tokenData);
  console.log('\nAnmeldung erfolgreich! Refresh-Token in .env gespeichert.');
  console.log('Ab jetzt läuft alles automatisch im Hintergrund (kein Browser mehr nötig).\n');
}

async function cmdStatus() {
  console.log('\nPCG Agent Status\n');

  const apiKey = process.env.GEMINI_API_KEY;
  console.log(`GEMINI_API_KEY:     ${apiKey ? 'vorhanden' : 'FEHLT (wird für die KI benötigt)'}`);

  const refreshToken = loadRefreshToken();
  console.log(`Google Refresh-Token: ${refreshToken ? 'vorhanden' : 'FEHLT (npm run agent -- auth)'}`);
  const clientId = process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;
  console.log(`Google Client ID:     ${clientId ? 'vorhanden' : 'FEHLT'}`);
  console.log(`Client Secret:        ${process.env.GOOGLE_CLIENT_SECRET ? 'vorhanden' : 'nicht benötigt'}`);

  const accessToken = loadStoredToken();
  if (refreshToken && accessToken) {
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: getOAuth2Client(accessToken) });
      const info = await oauth2.userinfo.get();
      console.log(`Angemeldet als:       ${info.data.email}`);
    } catch (err: any) {
      console.log('Access-Token vorhanden, aber Prüfung fehlgeschlagen:', err?.message || err);
    }
  }

  const cron = getCronStatus();
  if (cron) {
    console.log(`Letzter Daily-Run:    ${cron.dateStr || '?'} um ${cron.lastRunAt || '?'} (${cron.success ? 'erfolgreich' : 'Fehler'})`);
  }
  console.log('');
}

async function cmdDaily() {
  const accessToken = await getAccessToken();
  console.log('\nStarte tägliches Update (analyze -> Gemini -> Tasks -> Drive -> E-Mail)...\n');
  const result = await performDailyUpdate(accessToken, true, { autoCreateTasks: true });
  console.log('\n--- Zusammenfassung ---');
  console.log(result.summary);
  console.log('\n--- Ergebnis ---');
  if (result.createdTasks && result.createdTasks.length > 0) {
    console.log('Erstellte Google Tasks:');
    for (const t of result.createdTasks) {
      console.log(`  ${t.error ? 'FEHLER' : 'OK'}: ${t.title}${t.error ? ` (${t.error})` : ` (ID: ${t.id})`}`);
    }
  } else {
    console.log('Erstellte Google Tasks: keine');
  }
  console.log(`E-Mail gesendet: ${result.emailSent ? 'ja' : 'nein'}${result.emailErrorMsg ? ' - ' + result.emailErrorMsg : ''}`);
  console.log(`Datum: ${result.dateStr}\n`);

  if (process.env.CHAT_SPACE_ID) {
    try {
      const chat = google.chat({ version: 'v1', auth: getOAuth2Client(accessToken) });
      const chunks = splitChatMessage(cleanContentForEmail(result.summary));
      for (const [index, chunk] of chunks.entries()) {
        await chat.spaces.messages.create({
          parent: getChatSpaceId(),
          requestBody: { text: `${CHAT_MARKER} Daily-Update ${result.dateStr} (${index + 1}/${chunks.length})\n\n${chunk}` },
        });
      }
      console.log(`Briefing in ${chunks.length} Teilen nach Google Chat gepostet.`);
    } catch (chatErr: any) {
      console.warn('Chat-Post fehlgeschlagen:', chatErr?.message || chatErr);
    }
  }
}

async function cmdTodos() {
  const accessToken = await getAccessToken();
  const oauth2Client = getOAuth2Client(accessToken);
  const context = await fetchTasks(oauth2Client);
  console.log('\nGoogle Tasks (übersicht):\n');
  console.log(context);
  console.log('');
}

async function cmdTask(args: string[]) {
  const title = args.find((a) => !a.startsWith('-'));
  if (!title) {
    console.error('Nutzung: npm run agent -- task "Titel" [--due 2026-08-20] [--notes "Notiz"]');
    process.exit(1);
  }
  const accessToken = await getAccessToken();
  const due = flagValue(args, '--due');
  const notes = flagValue(args, '--notes');
  const result = await createGoogleTaskDirect(title, notes || '', due || '', accessToken);
  console.log(`Task angelegt: ${result.title || title}${result.id ? ` (ID: ${result.id})` : ''}`);
}

async function cmdEmail(args: string[]) {
  const to = flagValue(args, '--to');
  const subject = flagValue(args, '--subject');
  const body = flagValue(args, '--body');
  if (!subject || !body) {
    console.error('Nutzung: npm run agent -- email --to "x@y.de" --subject "Betreff" --body "Text"');
    process.exit(1);
  }
  const accessToken = await getAccessToken();
  const oauth2Client = getOAuth2Client(accessToken);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const from = profile.data.emailAddress;
  const target = to || from;
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `To: ${target}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${utf8Subject}`,
    '',
    body,
  ];
  const encoded = Buffer.from(messageParts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
  console.log(`E-Mail gesendet an ${target}`);
}

async function cmdCalendar(args: string[]) {
  const title = flagValue(args, '--title');
  const when = flagValue(args, '--when');
  if (!title || !when) {
    console.error('Nutzung: npm run agent -- calendar --title "Titel" --when "2026-08-20 14:00" [--duration-min 60]');
    process.exit(1);
  }
  const accessToken = await getAccessToken();
  const oauth2Client = getOAuth2Client(accessToken);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const durationMin = Number(flagValue(args, '--duration-min') || '60');
  const start = new Date(when);
  if (isNaN(start.getTime())) {
    console.error(`Ungültiges Datum: ${when} (Format: YYYY-MM-DD HH:MM)`);
    process.exit(1);
  }
  const end = new Date(start.getTime() + durationMin * 60000);
  const created = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });
  console.log(`Termin angelegt: ${title} (ID: ${created.data.id})`);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

function printHelp() {
  console.log(`
PCG Agent CLI – Befehle:

  npm run agent -- auth [--force]      Einmalige Google-Anmeldung (Refresh-Token -> .env)
  npm run agent -- status              Status von Tokens & letztem Daily-Run
  npm run agent -- daily               Tägliches Update (Tasks anlegen, Drive-Briefing, E-Mail)
  npm run agent -- todos               Google Tasks auflisten
  npm run agent -- task "Titel" [--due YYYY-MM-DD] [--notes "Notiz"]
  npm run agent -- email --to x@y.de --subject "Betreff" --body "Text"
  npm run agent -- calendar --title "Titel" --when "YYYY-MM-DD HH:MM" [--duration-min 60]

Chat-Rückkanal (Google Chat Bot):
  npm run agent -- chat-spaces         Chat-Räume auflisten (Raum-ID für .env)
  npm run agent -- chat-send "Text"    Nachricht in den konfigurierten Raum senden
  npm run agent -- chat-process        Neue Chat-Befehle lesen, ausführen, antworten

Konfiguration in .env:
  GEMINI_API_KEY        Pflicht – für die KI
  GOOGLE_REFRESH_TOKEN  wird von 'auth' automatisch gespeichert
  GOOGLE_CLIENT_ID      optional (Standard: Firebase OAuth Client)
  GOOGLE_CLIENT_SECRET  optional (nur wenn PKCE nicht funktioniert)
  GOOGLE_REDIRECT_PORT  optional (Standard: 4315)
  CHAT_SPACE_ID         optional – Raum-ID (z. B. spaces/XXXX) für den Chat-Bot
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  try {
    switch (cmd) {
      case 'auth': return await cmdAuth(args.includes('--force'));
      case 'status': return await cmdStatus();
      case 'daily': return await cmdDaily();
      case 'todos': return await cmdTodos();
      case 'task': return await cmdTask(args.slice(1));
      case 'email': return await cmdEmail(args.slice(1));
      case 'calendar': return await cmdCalendar(args.slice(1));
      case 'chat-spaces': return await cmdChatSpaces();
      case 'chat-send': return await cmdChatSend(args.slice(1).join(' '));
      case 'chat-process': return await cmdChatProcess();
      case 'help':
      case '--help':
      case '-h': return printHelp();
      default:
        console.error(`Unbekannter Befehl: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    if (err instanceof GoogleAuthError || isAuthError(err)) {
      console.error('Fehler:', err.message);
      console.error('Hinweis: Token ungültig. Bitte neu anmelden mit: npm run agent -- auth --force');
    } else {
      console.error('Fehler:', err?.message || err);
    }
    process.exit(1);
  }
}

main();
