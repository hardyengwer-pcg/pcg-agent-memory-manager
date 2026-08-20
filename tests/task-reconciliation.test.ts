import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDavidOneOnOneAgenda, sanitizeActionProposals } from '../server.ts';

const tasksContext = `Google Tasks - AUTORITATIVE AUFGABENZUSTAENDE:
OFFEN:
- [OFFEN] Onboarding Michael vorbereiten | Liste: My Tasks
ERLEDIGT:
- [ERLEDIGT] FNTV Cloud Function Timeout Alert pruefen | Liste: My Tasks`;

test('always exposes Besprechung David as the dedicated 1:1 agenda source', () => {
  const context = '- [OFFEN] Besprechung David | Liste: My Tasks | Notiz: Lorenz, Staffing und Odoo klären';
  const result = extractDavidOneOnOneAgenda(context);

  assert.match(result, /Besprechung David/);
  assert.match(result, /Lorenz, Staffing und Odoo klären/);
  assert.match(result, /bei jeder Vorbereitung eines David-Termins berücksichtigt/);
});

test('removes completed task from recommendations and proposals', () => {
  const text = `## 4. Konkrete naechste Schritte
- **FNTV Cloud Function Timeout Alert pruefen** - Faellig: heute
  Details: Fehler analysieren
- **Neuen Punkt pruefen** - Faellig: morgen
  Details: neu

<ACTION_PROPOSALS>
[
  {"type":"task","title":"FNTV Cloud Function Timeout Alert pruefen","details":{}},
  {"type":"task","title":"Neuen Punkt pruefen","details":{}}
]
</ACTION_PROPOSALS>`;

  const result = sanitizeActionProposals(text, tasksContext, '');

  assert.doesNotMatch(result, /FNTV Cloud Function Timeout Alert/);
  assert.match(result, /Neuen Punkt pruefen/);
});

test('does not create a duplicate for an open task', () => {
  const text = `<ACTION_PROPOSALS>
[
  {"type":"task","title":"Onboarding Michael vorbereiten","details":{}},
  {"type":"task","title":"Anderen neuen Punkt pruefen","details":{}}
]
</ACTION_PROPOSALS>`;

  const result = sanitizeActionProposals(text, tasksContext, '');

  assert.doesNotMatch(result, /Onboarding Michael vorbereiten/);
  assert.match(result, /Anderen neuen Punkt pruefen/);
});

test('matches real-world title variants despite details and spelling differences', () => {
  const realTasks = `Google Tasks - AUTORITATIVE AUFGABENZUSTAENDE:
OFFEN:
- [OFFEN] Dennis KSGR sauber aufsetzen und fragt nach best practices, da sein erstes Projekt hier | Liste: My Tasks
- [OFFEN] Projektleitung Nestlim anfragen: Kontaktiere Nestlim bezueglich der Uebernahme der Projektleitung fuer Koenig und Bauer | Liste: My Tasks
ERLEDIGT:`;
  const text = `<ACTION_PROPOSALS>
[
  {"type":"task","title":"Dennis KSGR: Best Practices bereitstellen","details":{"title":"Dennis KSGR: Best Practices fuer Projekt-Setup bereitstellen","notes":"Jira und Confluence erklaeren"}},
  {"type":"task","title":"Projektleitung Neslim anfragen fuer Koenig & Bauer","details":{"title":"Projektleitung Neslim anfragen fuer Koenig & Bauer","notes":"Verfuegbarkeit pruefen"}}
]
</ACTION_PROPOSALS>`;

  const result = sanitizeActionProposals(text, realTasks, '');

  assert.doesNotMatch(result, /Dennis KSGR/);
  assert.doesNotMatch(result, /Projektleitung Neslim/);
});

test('filters completed recommendations without an action block', () => {
  const text = `## 4. Konkrete naechste Schritte
- **FNTV Cloud Function Timeout Alert pruefen** - Faellig: heute
  Details: Fehler analysieren
- **Neuen Punkt pruefen** - Faellig: morgen
  Details: neu`;

  const result = sanitizeActionProposals(text, tasksContext, '');

  assert.doesNotMatch(result, /FNTV Cloud Function Timeout Alert/);
  assert.match(result, /Neuen Punkt pruefen/);
});

test('removes obsolete SUSE kickoff recommendation from an active project', () => {
  const text = `## 2. Projektstatus
- **SUSE**
  • **Status:** On Track
  • **Aktueller Stand:** Juan arbeitet bereits am Projekt.
  • **Nächste Schritte:** Du kannst nun das offizielle Kickoff-Meeting einplanen.
  • [Quelle: Chat](https://example.com)
- **Anderes Projekt**
  • **Nächste Schritte:** Kickoff vorbereiten.`;

  const result = sanitizeActionProposals(text, '', '');

  assert.doesNotMatch(result, /offizielle Kickoff-Meeting/);
  assert.match(result, /Juan arbeitet bereits am Projekt/);
  assert.match(result, /Anderes Projekt[\s\S]*Kickoff vorbereiten/);
});

test('removes completed task sentences from Section 2 Nächste Schritte', () => {
  const lorenzTasks = `Google Tasks - AUTORITATIVE AUFGABENZUSTAENDE:
OFFEN:
- [OFFEN] Onboarding Michael vorbereiten | Liste: My Tasks
ERLEDIGT:
- [ERLEDIGT] Lorenz: Sudipt Pandas Stunden auf Task 362 umbuchen | Liste: My Tasks`;

  const text = `## 2. Projektstatus
- **Project Lorenz (Cure)**
  • **Status:** In Klärung
  • **Aktueller Stand:** Drive-Freigaben erteilt.
  • **Nächste Schritte:** Sudipt Pandas falsch gebuchte Stunden von Ticket 112507 auf Task 362 verschieben. IT muss Passwort freischalten.
  • [Quelle: Chat](https://example.com)
- **SUSE**
  • **Nächste Schritte:** Workshop vorbereiten.`;

  const result = sanitizeActionProposals(text, lorenzTasks, '');

  assert.doesNotMatch(result, /Sudipt Pandas falsch gebuchte Stunden/);
  assert.match(result, /IT muss Passwort freischalten/);
  assert.match(result, /SUSE[\s\S]*Workshop vorbereiten/);
});
