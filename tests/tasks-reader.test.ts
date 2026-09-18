import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTasks } from '../src/server/tasks-reader.ts';

test('separates open and completed tasks and preserves due dates', async () => {
  const evidence: any[] = [];
  const tasksApi = {
    tasklists: {
      list: async () => ({ data: { items: [{ id: 'list-1', title: 'My Tasks' }] } }),
    },
    tasks: {
      list: async ({ showCompleted }: { showCompleted: boolean }) => ({
        data: {
          items: showCompleted
            ? [{ id: 'done-1', title: 'Erledigte Aufgabe', status: 'completed', completed: new Date().toISOString() }]
            : [{ id: 'open-1', title: 'WireGuard Zugang prüfen', status: 'needsAction', due: '2026-09-18T00:00:00.000Z', notes: 'Public Keys anfordern' }],
        },
      }),
    },
  };

  const context = await fetchTasks({}, input => evidence.push(...input), () => tasksApi as any);

  assert.match(context, /\[OFFEN\] WireGuard Zugang prüfen/);
  assert.match(context, /Fällig: 18\.9\.2026/);
  assert.match(context, /Notiz: Public Keys anfordern/);
  assert.match(context, /\[ERLEDIGT\] Erledigte Aufgabe/);
  assert.equal(evidence.length, 2);
});
