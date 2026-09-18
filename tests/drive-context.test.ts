import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichTimestampTranscriptLinks } from '../src/server/drive-context.ts';

test('matches timestamp transcript to a nearby calendar meeting', () => {
  const drive = '--- DOKUMENT / TRANSKRIPT / VORBEREITUNG: "Meet Recordings/Transkript_2026-09-17_13-48.md" ---\nHHA Sync WireGuard GitLab Kundeninfrastruktur';
  const calendar = '- [VERGANGEN] HHA Sync mit David (2026-09-17T12:30:00+02:00 bis 2026-09-17T13:45:00+02:00) | Direktlink: https://calendar.example/hha';

  const result = enrichTimestampTranscriptLinks(drive, calendar);

  assert.match(result, /TRANSKRIPT-ZUORDNUNG: hoch/);
  assert.match(result, /HHA Sync mit David/);
});

test('marks timestamp transcript without nearby meeting as unresolved', () => {
  const drive = '--- DOKUMENT / TRANSKRIPT / VORBEREITUNG: "Meet Recordings/Transkript_2026-09-17_13-48.md" ---\nUnbekannter Inhalt';
  const calendar = '- [VERGANGEN] Altes Meeting (2026-09-17T10:00:00+02:00 bis 2026-09-17T11:00:00+02:00) | Direktlink: https://calendar.example/old';

  const result = enrichTimestampTranscriptLinks(drive, calendar);

  assert.match(result, /TRANSKRIPT-ZUORDNUNG: ungeklärt/);
});
