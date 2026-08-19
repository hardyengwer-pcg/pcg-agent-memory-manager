#!/usr/bin/env node
/**
 * Google OAuth2 Einmal-Setup Script
 * Startet kurz einen lokalen Server NUR für den Auth-Redirect,
 * speichert danach das Refresh-Token dauerhaft -> kein Browser mehr nötig.
 *
 * Aufruf: node scripts/google-auth-setup.mjs
 */

import http from 'http';
import https from 'https';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, 'agent-memory', '.google-refresh-token.json');

// ── OAuth-Konfiguration ─────────────────────────────────────────────────────
// Client ID aus firebase-applet-config.json
const CLIENT_ID = '261415172337-16a674uqih6mk269b0hj8q61qguq6scp.apps.googleusercontent.com';
const REDIRECT_PORT = 4315;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

const SCOPES = [
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
].join(' ');

// ── PKCE-Hilfsfunktionen ────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function generateCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}
function generateCodeChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

// ── Token-Exchange (mit PKCE, ohne Client Secret) ──────────────────────────
function exchangeCode(code, verifier) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Ungültige Server-Antwort: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Refresh Token verwenden um Access Token zu holen ───────────────────────
export function refreshAccessToken(refreshToken, clientSecret = '') {
  return new Promise((resolve, reject) => {
    const params = {
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
    };
    if (clientSecret) params.client_secret = clientSecret;
    const body = new URLSearchParams(params).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Ungültige Server-Antwort: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Gespeichertes Token laden ───────────────────────────────────────────────
export function loadSavedToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveTokenData(data) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
  console.log(`\n✅ Token gespeichert: ${TOKEN_FILE}`);
}

// ── Browser öffnen ──────────────────────────────────────────────────────────
function openBrowser(url) {
  const cmd = process.platform === 'win32'  ? `start "" "${url}"` :
               process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.warn('Browser konnte nicht automatisch geöffnet werden.'); });
}

// ── Hauptfunktion ───────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔑 PCG Agent – Google Einmal-Anmeldung\n');

  const saved = loadSavedToken();
  if (saved && saved.refresh_token) {
    console.log(`✅ Bereits angemeldet (gespeichert am ${saved.savedAt}).\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => rl.question('Neu anmelden? (j/N): ', r));
    rl.close();
    if (!answer.toLowerCase().startsWith('j')) {
      console.log('Abgebrochen.\n');
      return;
    }
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  let resolveCode;
  const codePromise = new Promise(r => { resolveCode = r; });

  // Temporärer lokaler Server NUR für den OAuth-Redirect
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>❌ Fehler: ${error}</h2><p>Dieses Fenster kann geschlossen werden.</p>`);
      resolveCode(null);
      return;
    }

    if (code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:sans-serif;background:#0f0f10;color:#e8e8ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.card{background:#1a1a1e;border-radius:16px;padding:48px;text-align:center;border:1px solid #2a2a30;}
h1{color:#4ade80;font-size:2rem;margin-bottom:8px;}p{color:#aaa;}</style>
</head><body><div class="card"><h1>✅ Erfolgreich angemeldet!</h1>
<p>Du kannst dieses Fenster jetzt schließen.<br>Der PCG Agent hat das Token gespeichert.</p></div></body></html>`);
      resolveCode(code);
    }
  });

  await new Promise(r => server.listen(REDIRECT_PORT, '127.0.0.1', r));
  console.log(`📡 Lokaler Auth-Server gestartet auf Port ${REDIRECT_PORT}...`);
  console.log('\n🌐 Browser wird geöffnet...\n');
  console.log('Falls der Browser nicht öffnet, kopiere diese URL manuell:');
  console.log('\n' + authUrl.toString() + '\n');

  openBrowser(authUrl.toString());

  console.log('⏳ Warte auf Google-Anmeldung...\n');
  const code = await codePromise;
  server.close();

  if (!code) {
    console.error('❌ Keine Autorisierung erhalten. Abgebrochen.\n');
    process.exit(1);
  }

  console.log('🔄 Tausche Code gegen Token...');

  const tokenData = await exchangeCode(code, codeVerifier);

  if (tokenData.error) {
    // Falls PKCE ohne Client Secret nicht klappt, gib Anleitung aus
    if (tokenData.error === 'invalid_client' || tokenData.error === 'unauthorized_client') {
      console.error('\n⚠️  PKCE ohne Client Secret wird von diesem OAuth-Client nicht unterstützt.');
      console.error('Bitte im Google Cloud Console einen "Desktop App" OAuth-Client anlegen und');
      console.error('das Client Secret hier eintragen:\n');
      
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const secret = await new Promise(r => rl.question('Client Secret eingeben: ', r));
      rl.close();

      const retryBody = new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: secret.trim(),
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString();

      // Retry with client secret
      const retry = await new Promise((resolve, reject) => {
        const body = retryBody;
        const req = https.request({
          hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let data = ''; res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e){ reject(e); } });
        });
        req.on('error', reject); req.write(body); req.end();
      });

      if (retry.error) {
        console.error('\n❌ Fehler:', retry.error_description || retry.error);
        process.exit(1);
      }
      saveTokenData({ ...retry, client_secret: secret.trim() });
    } else {
      console.error('\n❌ Token-Exchange-Fehler:', tokenData.error_description || tokenData.error);
      process.exit(1);
    }
  } else {
    saveTokenData(tokenData);
  }

  console.log('\n🎉 Anmeldung erfolgreich! Ab jetzt läuft alles automatisch im Hintergrund.\n');
}

main().catch(e => { console.error('❌ Fehler:', e.message); process.exit(1); });
