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

Der Lauf sammelt Workspace-Kontext, erstellt ein Briefing, speichert es in Drive, sendet eine Zusammenfassung per E-Mail und kann Aufgaben ableiten.

## Windows Task Scheduler

`run-agent.cmd` ist ein Wrapper mit Logdatei. `run-agent-hidden.vbs` startet ihn ohne sichtbares Konsolenfenster.

Die lokale Einrichtung verwendet morgens um 08:00 Uhr das Briefing und abends um 18:00 Uhr die Chat-Anweisungsverarbeitung:

```powershell
$project = "C:\Pfad\zum\Projekt"
schtasks /create /tn "PCG Agent Daily" /tr "wscript.exe `"$project\run-agent-hidden.vbs`" daily" /sc daily /st 08:00 /f
schtasks /create /tn "PCG Agent Chat EOD" /tr "wscript.exe `"$project\run-agent-hidden.vbs`" chat-process" /sc daily /st 18:00 /f
```

Alternativ kann Google Chat häufiger per Polling betrieben werden:

```powershell
schtasks /create /tn "PCG Agent Chat" /tr "wscript.exe `"$project\run-agent-hidden.vbs`" chat-process" /sc minute /mo 5 /f
```

Vor dem Aktivieren geplanter Tasks einen manuellen `daily`- und `chat-process`-Lauf pruefen.

## Wartung

```bash
npm install
npm audit
npm run lint
npm run build
```

Bei widerrufenen Google-Berechtigungen `npm run agent -- auth` erneut ausfuehren. Bei kompromittierten Zugangsdaten OAuth-Token in Google widerrufen, lokale Token-Dateien loeschen und einen neuen API-Key erstellen.
