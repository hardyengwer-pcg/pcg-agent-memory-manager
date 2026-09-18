# Architektur

## Komponenten

| Komponente | Aufgabe |
| --- | --- |
| `src/` | React-UI mit Firebase Google Sign-In |
| `server.ts` | Lokale Express-API, Orchestrierung, AI-Generierung und Briefing-Logik |
| `src/server/api-auth.ts` | Zentrale Google-Token- und Konto-Authentifizierung |
| `src/server/calendar-reader.ts` | Kalender-Kontext und Meeting-Evidence |
| `src/server/chat-reader.ts` | Google-Chat-Kontext und Chat-Evidence |
| `src/server/gmail-reader.ts` | Gmail-Kontext, Ausgangsmails und Follow-up-Evidence |
| `src/server/tasks-reader.ts` | Autoritative offene/erledigte Google Tasks |
| `src/server/drive-reader.ts` | Drive-Dateilisting und Datei-Exporte |
| `src/server/drive-context.ts` | Drive-Kontextauswahl, Relevanzfilter und Memory-Kontext |
| `src/server/ai-config.ts` | AI-Key, Gateway-Allowlist, Modellauflösung und lokale AI-Einstellungen |
| `src/server/evidence.ts` | Gemeinsamer Adapter zum unveränderlichen Evidence-Ledger |
| `src/server/input-validation.ts` | Begrenzung und Typprüfung textbasierter Action-Payloads |
| `cli.ts` | Headless-Kommandos und OAuth-Refresh-Token-Verwaltung |
| `verbatim-evidence-ledger.ts` | Unveränderlicher Rohquellen-Ledger mit SHA-256 Hashes, Zeitstempeln und Hybridsuche |
| `temporal-facts.ts` | Temporales Faktenmodell mit Gültigkeitsfenstern und automatischer Invalidierung |
| `decision-memory.ts` | Entscheidungsgedächtnis mit Begründungen, verworfenen Alternativen und Tags |
| Google Workspace | Datenquellen und Zielsysteme fuer Aktionen |
| Gemini oder PCG Gateway | Zusammenfassung, Antwortgenerierung und Transkription |

## Datenfluss

1. Die Web-UI meldet sich via Firebase mit Google an und erhaelt einen kurzlebigen Access-Token.
2. Die lokale API validiert Token und Kontoinhaber gegen `GOOGLE_ALLOWED_EMAIL`.
3. Workspace-Rohdaten (Drive, Gmail, Chat, Kalender, Tasks) werden unverändert im lokalen **Verbatim Evidence Ledger** (`.evidence-ledger/evidence.jsonl`) mit SHA-256 Hash und Versionierung archiviert.
4. Der Kontext geht an das konfigurierte AI-Modell (Google Gemini oder freigegebenes Gateway).
5. Das tägliche Management-Briefing folgt einer festen 7-stufigen Struktur mit strikter Validierung (dringende Aktionen vor kompakter Projektstatusübersicht, keine Dopplungen).
6. Die UI zeigt Vorschlaege. Seiteneffekte wie E-Mails, Kalendertermine oder Tasks erfordern eine explizite Aktion in der UI oder im Daily-Lauf.

## Ausfuehrungsmodi

- **Web:** lokale UI fuer interaktive Recherche und bestaetigte Aktionen.
- **CLI:** fuer headless Briefings, Quellensuche, Faktenabfrage, Entscheidungsablage und Windows Task Scheduler.
- **Google Chat:** `chat-process` liest neue Nachrichten im konfigurierten Raum und antwortet darauf.

## Qualitäts- und Sicherheitsprüfungen

- `npm run check` führt Lint, Tests, Produktions-Build, `npm audit` und den Scan getrackter Dateien auf Secrets aus.
- GitHub Actions führt denselben Check bei Pushes und Pull Requests gegen `main` aus.
- Reader-Tests verwenden injizierte Google-Clients und benötigen keine Workspace-Zugangsdaten.

## Persistenz

Die Anwendung speichert lokal OAuth- und Laufzeitdaten. Diese Dateien sind absichtlich nicht versioniert:

- `.env`
- `.latest_token.json`
- `.ai_settings.json`
- `.chat-state.json`
- `.last_cron_status.json`
- `agent-memory/` (kuratierte OKF-Konzepte)
- `.evidence-ledger/` (unveränderliche Rohdaten `evidence.jsonl`, temporale Fakten `temporal-facts.jsonl`, Entscheidungen `decisions.jsonl`)

## Sicherheitsgrenzen

- Der HTTP-Server bindet nur an Loopback.
- Jeder geschuetzte API-Aufruf validiert Google-Token und erlaubte E-Mail-Adresse.
- AI-Endpunkte muessen HTTPS nutzen und in der Host-Allowlist liegen.
- Nicht vertrauenswuerdige Workspace-Inhalte duerfen keine Aktionen direkt ausloesen; Aktionen werden in der UI bestaetigt.
