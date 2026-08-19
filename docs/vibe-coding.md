# Vibe-Coding-Notiz

Dieses Projekt wurde iterativ mit KI-Unterstuetzung entwickelt. Vibe Coding beschleunigt Prototyping, UI-Iteration und Dokumentation, ersetzt aber keine technische Verantwortung.

## Arbeitsprinzip

- Anforderungen werden in kleine, testbare Schritte zerlegt.
- KI-generierter Code wird wie externer Code gelesen, hinterfragt und angepasst.
- Google-Workspace-Aktionen bleiben nachvollziehbar und erfordern im Web eine explizite Bestaetigung.
- Zugangsdaten und Arbeitsdaten bleiben lokal und ausgeschlossen von Git.

## Verbindliche Qualitaetsgrenzen

- Vor jeder Veroeffentlichung: `npm run lint`, `npm run build` und `npm audit`.
- Sicherheitskritische Aenderungen erhalten eine manuelle Review, insbesondere Authentifizierung, Token-Speicherung, Prompting und externe HTTP-Ziele.
- KI-Ausgaben sind Vorschlaege, keine vertrauenswuerdigen Instruktionen. Inhalte aus E-Mail, Drive und Chat gelten als untrusted input.
- Aenderungen mit Nebenwirkungen werden funktional getestet, bevor Scheduler aktiviert werden.

## Bekannte Grenzen

Der Agent verarbeitet sensible Workspace-Inhalte. Deshalb bleibt das Repository privat, der Server lokal und die Konfiguration strikt getrennt vom Quellcode.
