# Security Policy

## Sicherheitsmodell

- Die Web-API bindet nur an `127.0.0.1`.
- Geschuetzte Routen erfordern einen validen Google-Access-Token des in `GOOGLE_ALLOWED_EMAIL` definierten Kontos.
- AI-Gateway-URLs muessen HTTPS verwenden und auf einer expliziten Allowlist stehen.
- Lokale Tokens, Briefings und Memory-Dateien sind von Git ausgeschlossen.

## Sicherheitsvorfall melden

Bitte keine sicherheitsrelevanten Details in Issues veroeffentlichen. Melde sie direkt an den Repository-Owner mit Reproduktionsschritten, betroffenen Dateien und einer Einschaetzung der Auswirkung.

## Vor dem Push pruefen

```bash
npm audit
npm run lint
npm run build
git status --ignored
```

Kontrolliere besonders, dass keine `.env`-, Token-, Briefing- oder `agent-memory/`-Dateien gestaged sind.
