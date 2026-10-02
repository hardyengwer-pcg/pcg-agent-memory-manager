import { google } from 'googleapis';

type RecordEvidence = (inputs: any[]) => void;

export async function fetchRecentChats(auth: any, recordEvidence: RecordEvidence, createChatClient = (value: any) => google.chat({ version: 'v1', auth: value })) {
  try {
    const chat = createChatClient(auth);
    const spaces: any[] = [];
    let spacePageToken: string | undefined;
    do {
      const page = await chat.spaces.list({ pageSize: 100, pageToken: spacePageToken });
      spaces.push(...(page.data.spaces || []));
      spacePageToken = page.data.nextPageToken || undefined;
    } while (spacePageToken);
    let context = 'Aktuelle Chat-Räume & Nachrichten:\n';
    for (const space of spaces) {
      if (!space.name) continue;
      const spaceLabel = space.displayName ? `Raum: "${space.displayName}"` : `Raum: ${space.name}`;
      const chatUrl = `https://chat.google.com/room/${space.name.replace('spaces/', '')}`;
      context += `- ${spaceLabel} | Direktlink: ${chatUrl}\n`;
      try {
        const messages: any[] = [];
        let messagePageToken: string | undefined;
        do {
          const page = await chat.spaces.messages.list({ parent: space.name, pageSize: 100, pageToken: messagePageToken, orderBy: 'createTime desc' });
          messages.push(...(page.data.messages || []));
          messagePageToken = page.data.nextPageToken || undefined;
        } while (messagePageToken);
        const recentCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
        for (const message of messages.filter(message => !message.createTime || Date.parse(message.createTime) >= recentCutoff)) {
          const sender = message.sender?.displayName || message.sender?.name || 'User';
          const text = message.text || '(Kein Text)';
          const time = message.createTime ? ` [${new Date(message.createTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}]` : '';
          recordEvidence([{
            sourceType: 'chat',
            sourceId: message.name || `${space.name}:${message.createTime}:${sender}`,
            content: JSON.stringify(message),
            sourceTimestamp: message.createTime,
            author: sender,
            sourceUrl: chatUrl,
            parentId: space.name,
            metadata: { spaceName: space.name, spaceLabel },
          }]);
          context += `   * ${sender}${time}: "${text.replace(/\n+/g, ' ')}"\n`;
        }
      } catch {
        // A listed space may not be readable with the current Chat scope.
      }
    }
    return context;
  } catch (error: any) {
    console.warn('Chat fetch notice:', error?.message || error);
    return '(Chats konnten nicht abgerufen werden - Berechtigung oder Dienst inaktiv)\n';
  }
}
