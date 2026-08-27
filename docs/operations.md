# Betrieb

## Konfiguration

Kopiere `.env.example` nach `.env`. Die Datei bleibt lokal und darf nie committed werden.

| Variable | Erforderlich | Zweck |
| --- | --- | --- |
| `GEMINI_API_KEY` | Ja | Gemini- oder Gateway-Zugang |
| `GOOGLE_CLIENT_ID` | Ja | OAuth-Desktop-Client |
| `GOOGLE_CLIENT_SECRET` | Je nach Client | OAuth-Client-Secret |
| `GOOGLE_ALLOWED_EMAIL` | Ja fuer Web-API | Einzig erlaubtes Google-Konto |
| `GOOGLE_REFRESH_TOKEN` | Nach `auth` | Headless-CLI-Zugang |
| `GOOGLE_REDIRECT_PORT` | Nein | OAuth-Callback, Standard `4315` |
| `CHAT_SPACE_ID` | Nein | Google-Chat-Raum fuer Bot-Rueckkanal |
| `AI_ALLOWED_BASE_URLS` | Nein | Zusaetzliche, kommaseparierte Gateway-Hosts |

Standardmaessig sind nur `gateway.pcg.io` und `generativelanguage.googleapis.com` als AI-Gateway zugelassen. Jeder weitere Host muss explizit ueber `AI_ALLOWED_BASE_URLS` freigegeben werden.

## OAuth initialisieren

```bash
npm run agent -- auth
npm run agent -- status
```

Der erste Befehl oeffnet einmalig einen Browser. Danach arbeitet die CLI mit dem lokal gespeicherten Refresh-Token.

## Taegliches Briefing

```bash
npm run agent -- daily
```

Der Lauf sammelt Workspace-Kontext, speichert Rohquellen unverändert im Evidence Ledger, erstellt ein 6-teiliges Management-Briefing (Reihenfolge: 1. Änderungen, 2. Squad Lead Control, 3. Meetings, 4. Projektstatus, 5. Ausblick, 6. Handlungsempfehlungen), synchronisiert es nach Drive, sendet eine Zusammenfassung per E-Mail und postet das Briefing in den Google-Chat-Raum.

Vor der Analyse synchronisiert der Lauf die strukturierten OKF-Dateien aus dem lokalen `agent-memory/`-Ordner (inklusive Unterordner) in den konfigurierten Drive-Memory-Ordner. Diese Dateien bleiben die autoritative lokale Quelle; Token- und Geheimdateien werden nicht synchronisiert.

Das Bundle folgt OKF v0.2: `index.md` beschreibt den Bestand, `log.md` dokumentiert Änderungen und Konzeptdateien wie `tasks.md` enthalten YAML-Frontmatter mit Typ, Quellen, Lifecycle und Erzeugungsmetadaten.

## Evidence Ledger, Fakten & Entscheidungen (CLI)

```bash
# 1. Semantische / hybride Quellensuche im Evidence Ledger
npm run agent -- evidence-search "Orderbird" [--source drive|gmail|calendar|chat|tasks] [--limit 5]

# 2. Temporale Fakten verwalten (inkl. automatischer Widerspruchs-Invalidierung)
npm run agent -- fact-upsert -- --subject "Mario Pasculli" --predicate "availability" --object "medical_leave" --source-url "https://chat.google.com/..."
npm run agent -- fact-timeline ["Mario Pasculli"] [--all]

# 3. Entscheidungsgedächtnis (Decision Memory)
npm run agent -- decision-record -- --title "K&B Modellwahl" --decision "Gemini 2.5 Flash aktiv nutzen" --rationale "Kostenfaktor" --project "Koenig & Bauer" --alts "Gemini 3.7 Flash,Claude" --owner "Hardy Engwer" --tags "ai-model,kosten"
npm run agent -- decision-search "Kostenfaktor" [--project "Koenig & Bauer"]
```

## Windows Task Scheduler

`run-agent.cmd` ist ein Wrapper mit Logdatei. `run-agent-hidden.vbs` startet ihn ohne sichtbares Konsolenfenster.

Die lokale Einrichtung verwendet morgens um 08:00 Uhr das Briefing und abends um 18:00 Uhr die Chat-Anweisungsverarbeitung:

```powershell
$project = "C:\Pfad\zum\Projekt"
schtasks /create /tn "PCG Agent Daily" /tr "wscript.exe `"$project\run-agent-hidden.vbs`" daily" /sc daily /st 08:00 /f
schtasks /create /tn "PCG Agent Chat EOD" /tr "wscript.exe `"$project\run-agent-hidden.vbs`" chat-process" /sc daily /st 18:00 /f
```

Oder direkt als PowerShell-Scheduled-Task registrieren:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location -LiteralPath 'C:\Users\HardyEngwer\antigravity\Remix-PCG-Agent-Memory-Manager-und-Assistent-2026-08-18-aca67'; npm run agent -- daily`""
$trigger = New-ScheduledTaskTrigger -Daily -At 08:00AM
Register-ScheduledTask -TaskName "PCG_Agent_Daily_0800" -Action $action -Trigger $trigger -Description "Tägliches PCG Agent Management-Briefing um 08:00 Uhr" -Force
```

Alternativ kann Google Chat häufiger per Polling betrieben werden:

```powershell
schtasks /create /tn "PCG Agent Chat" /tr "wscript.exe `"$project\run-agent-hidden.vbs`" chat-process" /sc minute /mo 5 /f
```

Vor dem Aktivieren geplanter Tasks einen manuellen `daily`- und `chat-process`-Lauf pruefen.

## Browser-Vergleich

Der Browser-Vergleich liest ausschliesslich die sichtbaren Inhalte von URLs ueber `@browsermcp/mcp` und die Browser-MCP-Extension. Jira- und Odoo-Logins werden nicht ausgelesen; die bestehende Browser-Sitzung wird verwendet. Vor dem Lauf muss der gewuenschte Tab in der Extension mit `Connect` verbunden werden.

```bash
npm run agent -- browser-pages
npm run agent -- browser-compare --urls "https://jira.example/project,https://odoo.example/project" --instruction "Vergleiche die Projekte hinsichtlich Status, Verantwortlichen und naechsten Schritten."
```

Es gibt keine Schreibaktionen. Fuer zusaetzliche Sicherheit kann `BROWSER_ALLOWED_HOSTS` in `.env` auf eine kommaseparierte Liste erlaubter Hostnamen gesetzt werden.

## Wartung

```bash
npm install
npm audit
npm run lint
npm run build
```

Bei widerrufenen Google-Berechtigungen `npm run agent -- auth` erneut ausfuehren. Bei kompromittierten Zugangsdaten OAuth-Token in Google widerrufen, lokale Token-Dateien loeschen und einen neuen API-Key erstellen.
