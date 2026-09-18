import test from 'node:test';
import assert from 'node:assert/strict';
import { getFileContent, listAllFiles } from '../src/server/drive-reader.ts';

test('lists files recursively with relative paths', async () => {
  const drive = {
    files: {
      list: async ({ q }: { q: string }) => q.includes('root')
        ? { data: { files: [{ id: 'folder', name: 'Meet Recordings', mimeType: 'application/vnd.google-apps.folder' }, { id: 'root-file', name: 'root.md', mimeType: 'text/markdown' }] } }
        : { data: { files: [{ id: 'nested-file', name: 'Transcript_2026-09-17_13-48.md', mimeType: 'text/markdown' }] } },
    },
  };

  const files = await listAllFiles(drive, 'root');

  assert.deepEqual(files.map(file => file.path), ['Meet Recordings/Transcript_2026-09-17_13-48.md', 'root.md']);
});

test('exports Google Docs as plain text', async () => {
  const drive = { files: { export: async () => ({ data: 'meeting transcript' }) } };

  const content = await getFileContent(drive, 'doc-1', 'application/vnd.google-apps.document');

  assert.equal(content, 'meeting transcript');
});

test('returns null when a Drive read times out', async () => {
  const drive = { files: { get: async () => new Promise(() => {}) } };

  const content = await getFileContent(drive, 'slow-file', 'text/markdown', 10);

  assert.equal(content, null);
});
