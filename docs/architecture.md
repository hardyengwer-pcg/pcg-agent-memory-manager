# Architektur

## Komponenten

| Komponente | Aufgabe |
| --- | --- |
| `src/` | React-UI mit Firebase Google Sign-In |
| `server.ts` | Lokale Express-API, Google Workspace, AI-Generierung und Briefing-Logik |
| `cli.ts` | Headless-Kommandos und OAuth-Refresh-Token-Verwaltung |
| Google Workspace | Datenquellen und Zielsysteme fuer Aktionen |
| Gemini oder PCG Gateway | Zusammenfassung, Antwortgenerierung und Transkription |

## Datenfluss

1. Die Web-UI meldet sich via Firebase mit Google an und erhaelt einen kurzlebigen Access-Token.
2. Die lokale API validiert Token und Kontoinhaber gegen `GOOGLE_ALLOWED_EMAIL`.
3. Der Agent liest nur die benoetigten Workspace-Daten und erzeugt daraus Kontext.
4. Der Kontext geht an das konfigurierte, freigegebene AI-Gateway.
5. Die UI zeigt Vorschlaege. Seiteneffekte wie E-Mails, Kalendertermine oder Tasks erfordern eine explizite Aktion in der UI.

## Ausfuehrungsmodi

- **Web:** lokale UI fuer interaktive Recherche und bestaetigte Aktionen.
- **CLI:** fuer headless Briefings, Einzelaktionen und Windows Task Scheduler.
- **Google Chat:** `chat-process` liest neue Nachrichten im konfigurierten Raum und antwortet darauf.

## Persistenz

Die Anwendung speichert lokal OAuth- und Laufzeitdaten. Diese Dateien sind absichtlich nicht versioniert:

- `.env`
- `.latest_token.json`
- `.ai_settings.json`
- `.chat-state.json`
- `.last_cron_status.json`
- `agent-memory/`

## Sicherheitsgrenzen

- Der HTTP-Server bindet nur an Loopback.
- Jeder geschuetzte API-Aufruf validiert Google-Token und erlaubte E-Mail-Adresse.
- AI-Endpunkte muessen HTTPS nutzen und in der Host-Allowlist liegen.
- Nicht vertrauenswuerdige Workspace-Inhalte duerfen keine Aktionen direkt ausloesen; Aktionen werden in der UI bestaetigt.
