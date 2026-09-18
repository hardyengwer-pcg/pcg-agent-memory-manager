import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecentEmails } from '../src/server/gmail-reader.ts';

test('marks sent emails and preserves follow-up context', async () => {
  const evidence: any[] = [];
  const gmail = {
    users: {
      messages: {
        list: async ({ q }: { q: string }) => q.includes('transcript') ? { data: { messages: [] } } : { data: { messages: [{ id: 'mail-1' }] } },
        get: async () => ({ data: {
          id: 'mail-1',
          labelIds: ['SENT'],
          internalDate: String(Date.now()),
          snippet: 'Bitte um Rückmeldung zur Avantgarde-Schätzung.',
          payload: {
            headers: [
              { name: 'From', value: 'hardy@pcg.io' },
              { name: 'To', value: 'adrian@avantgarde.example' },
              { name: 'Subject', value: 'Avantgarde Schätzung' },
              { name: 'Date', value: new Date().toUTCString() },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Bitte um Rückmeldung zur Schätzung.').toString('base64') },
          },
        } }),
      },
    },
  };

  const context = await fetchRecentEmails({}, input => evidence.push(...input), () => gmail as any);

  assert.match(context, /Status: GESENDET/);
  assert.match(context, /Empfänger: adrian@avantgarde\.example/);
  assert.match(context, /AUSGANG: Für offene Antworten Follow-up prüfen/);
  assert.equal(evidence[0].metadata.status, 'GESENDET');
});
