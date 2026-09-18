import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUpcomingEvents } from '../src/server/calendar-reader.ts';

test('filters ignored internal meetings and records relevant events', async () => {
  const evidence: any[] = [];
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const calendar = {
    events: {
      list: async () => ({ data: { items: [
        { id: 'ignored', summary: 'Thursdays for Data', start: { dateTime: start }, end: { dateTime: end } },
        { id: 'relevant', summary: 'HHA AI Gateway Sync', start: { dateTime: start }, end: { dateTime: end }, htmlLink: 'https://calendar.example/hha', attendees: [{ displayName: 'Mario' }] },
      ] } }),
    },
  };

  const context = await fetchUpcomingEvents({}, input => evidence.push(...input), () => calendar as any);

  assert.doesNotMatch(context, /Thursdays for Data/);
  assert.match(context, /HHA AI Gateway Sync/);
  assert.match(context, /Teilnehmer: Mario/);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceType, 'calendar');
});
