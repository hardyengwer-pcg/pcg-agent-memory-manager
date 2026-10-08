import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecentChats } from '../src/server/chat-reader.ts';

test('reads chat spaces and records message evidence', async () => {
  const evidence: any[] = [];
  const chat = {
    spaces: {
      list: async () => ({ data: { spaces: [{ name: 'spaces/hha', displayName: 'HHA Gateway' }] } }),
      messages: {
        list: async () => ({ data: { messages: [{
          name: 'spaces/hha/messages/1',
           createTime: '2026-10-01T08:00:00Z',
          text: 'WireGuard Public Keys an Timo senden',
          sender: { displayName: 'Hardy' },
        }] } }),
      },
    },
  };

  const context = await fetchRecentChats({}, input => evidence.push(...input), () => chat as any);

  assert.match(context, /Raum: "HHA Gateway"/);
  assert.match(context, /Hardy/);
  assert.match(context, /WireGuard Public Keys an Timo senden/);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceType, 'chat');
});

test('excludes PCG-Agent replies from report context and evidence', async () => {
  const evidence: any[] = [];
  const chat = {
    spaces: {
      list: async () => ({ data: { spaces: [{ name: 'spaces/agent', displayName: 'PCG Agent' }] } }),
      messages: {
        list: async () => ({ data: { messages: [
          { name: 'spaces/agent/messages/1', createTime: '2026-10-08T08:00:00Z', text: 'Hardy request', sender: { displayName: 'Hardy' } },
          { name: 'spaces/agent/messages/2', createTime: '2026-10-08T08:01:00Z', text: '[PCG-Agent] Antwort', sender: { displayName: 'PCG Agent' } },
        ] } }),
      },
    },
  };

  const context = await fetchRecentChats({}, input => evidence.push(...input), () => chat as any);

  assert.match(context, /Hardy request/);
  assert.doesNotMatch(context, /PCG-Agent/);
  assert.equal(evidence.length, 1);
});
