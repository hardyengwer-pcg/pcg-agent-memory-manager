# Security Policy

## Sicherheitsmodell

- Die Web-API bindet nur an `127.0.0.1`.
- Geschuetzte Routen erfordern einen validen Google-Access-Token des in `GOOGLE_ALLOWED_EMAIL` definierten Kontos.
- AI-Gateway-URLs muessen HTTPS verwenden und auf einer expliziten Allowlist stehen.
- Lokale Tokens, Briefings und Memory-Dateien sind von Git ausgeschlossen.
- Die Workspace-Reader laufen nur mit dem vom Benutzer bereitgestellten OAuth-Token; externe Inhalte werden als untrusted evidence behandelt und dürfen keine Schreibaktion direkt auslösen.
- Schreibaktionen (Tasks, Gmail, Kalender, Chat und Drive) liegen hinter der zentralen API-Authentifizierung und route-spezifischen Eingabegrenzen.
- Der Firebase-Konfigurationswert `apiKey` ist kein OAuth-Secret, muss aber in Firebase/GCP auf die vorgesehenen Domains und APIs eingeschränkt sein.

## Datenklassifizierung

- **Secrets:** `.env`, OAuth-Refresh-/Access-Tokens, AI-Keys und lokale Zustandsdateien. Niemals committen oder in Logs ausgeben.
- **Vertrauliche Workspace-Daten:** Gmail, Drive, Kalender, Chat, Tasks und Evidence Ledger. Ausschließlich lokal bzw. im autorisierten Google-Konto verarbeiten.
- **Öffentliche Konfiguration:** Firebase-Web-API-Key und Projekt-ID dürfen nur mit restriktiven Firebase-/GCP-Regeln veröffentlicht werden.

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

GitHub Actions führt bei Push und Pull Request automatisch `npm run check` aus:

- TypeScript-Lint
- Tests
- Produktions-Build
- `npm audit`

Ein Firebase-Web-API-Key wird nicht als Secret behandelt. Prüfe trotzdem regelmäßig
API- und Domain-Restriktionen im Firebase-/GCP-Projekt.
