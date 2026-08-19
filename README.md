# PCG Agent Memory Manager

Ein lokaler KI-Assistent fuer persoenliche Arbeitsorganisation. Der Agent verarbeitet Google Workspace-Kontext, erstellt Management-Briefings und unterstuetzt bei Google Tasks, Kalender, Gmail, Drive und Google Chat.

> Dieses Projekt ist fuer eine **private** Nutzung konzipiert. Es enthaelt Integrationen mit personenbezogenen und geschäftlichen Workspace-Daten und darf nicht mit lokalen Zustands- oder Zugangsdaten veroeffentlicht werden.

## Funktionen

- Taegliches Management-Briefing aus Gmail, Calendar, Drive, Google Chat und Tasks
- Google-Workspace-Aktionen mit expliziter Benutzerbestaetigung
- Headless CLI fuer Automatisierung und Windows Task Scheduler
- Google-Chat-Rueckkanal per Polling
- Lokale React-Weboberflaeche auf `127.0.0.1`

## Schnellstart

**Voraussetzungen:** Node.js 20+, ein Google-OAuth-Desktop-Client und aktivierte Google APIs fuer Gmail, Calendar, Drive, Tasks und Chat.

```bash
npm install
Copy-Item .env.example .env
```

Konfiguriere anschliessend mindestens diese Werte in `.env`:

```dotenv
GEMINI_API_KEY="..."
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_ALLOWED_EMAIL="you@example.com"
```

Die vollstaendige Konfigurationsreferenz steht in [docs/operations.md](docs/operations.md).

### CLI verwenden

```bash
# Einmalige OAuth-Anmeldung; speichert den Refresh-Token lokal.
npm run agent -- auth

# Status und Tagesbriefing
npm run agent -- status
npm run agent -- daily

# Weitere Aktionen
npm run agent -- todos
npm run agent -- chat-spaces
npm run agent -- chat-send "Status aktualisiert"
npm run agent -- chat-process
```

Bei CLI-Befehlen mit Flags `npx tsx cli.ts` verwenden, da npm einzelne Flags als npm-Konfiguration interpretieren kann:

```bash
npx tsx cli.ts task "Konzept pruefen" --due 2026-08-20 --notes "Vor dem Kundentermin"
```

### Lokale Weboberflaeche

```bash
npm run dev
```

Der Server bindet ausschliesslich an `127.0.0.1:3000`. Fuer einen Production-Build:

```bash
npm run build
npm start
```

## Projektstruktur

```text
cli.ts              Headless CLI und OAuth-Flow
server.ts           Express-API, Google-Integrationen, Briefing-Logik
src/                React-Weboberflaeche
docs/               Architektur, Betrieb und Entwicklungsnotizen
run-agent.cmd       Windows-Wrapper fuer geplante Ausfuehrungen
```

## Sicherheit

- API-Aufrufe erfordern ein validiertes Google-Token des in `GOOGLE_ALLOWED_EMAIL` festgelegten Kontos.
- Der Server ist nur lokal erreichbar.
- AI-Gateway-Ziele sind auf HTTPS und eine Host-Allowlist beschraenkt.
- Workspace-Aktionen aus der Weboberflaeche werden explizit bestaetigt.
- Tokens, Briefings, lokale Memory-Dateien und `.env` sind per `.gitignore` ausgeschlossen.

Details: [SECURITY.md](SECURITY.md).

## Dokumentation

- [Architektur](docs/architecture.md)
- [Betrieb und Automatisierung](docs/operations.md)
- [Vibe-Coding-Notiz](docs/vibe-coding.md)
- [Beitragen](CONTRIBUTING.md)

## Qualitaetssicherung

```bash
npm run lint
npm run build
npm audit
```

## Lizenz

Dieses Repository ist privat. Eine Nutzung, Weitergabe oder Veroeffentlichung ausserhalb der autorisierten Organisation bedarf einer ausdruecklichen Freigabe.
