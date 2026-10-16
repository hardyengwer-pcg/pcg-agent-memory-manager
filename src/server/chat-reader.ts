import { google } from 'googleapis';

type RecordEvidence = (inputs: any[]) => void;

export async function fetchChatSpaceContext(auth: any, spaceName: string, createChatClient = (value: any) => google.chat({ version: 'v1', auth: value })) {
  const chat = createChatClient(auth);
  const messages: any[] = [];
  let messagePageToken: string | undefined;
  let messagePage = 0;
  do {
    const page = await chat.spaces.messages.list({ parent: spaceName, pageSize: 100, pageToken: messagePageToken, orderBy: 'createTime desc' });
    messages.push(...(page.data.messages || []));
    messagePageToken = page.data.nextPageToken || undefined;
    messagePage += 1;
  } while (messagePageToken && messagePage < 10);
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return messages
    .filter(message => (!message.createTime || Date.parse(message.createTime) >= recentCutoff) && !/^\[PCG-Agent\]/i.test(String(message.text || '').trim()))
    .map(message => {
      const sender = message.sender?.displayName || message.sender?.name || 'User';
      const time = message.createTime ? ` [${new Date(message.createTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}]` : '';
      return `- ${sender}${time}: "${String(message.text || '(Kein Text)').replace(/\n+/g, ' ')}"`;
    })
    .join('\n');
}

export async function fetchRecentChats(auth: any, recordEvidence: RecordEvidence, createChatClient = (value: any) => google.chat({ version: 'v1', auth: value })) {
  try {
    const chat = createChatClient(auth);
    const spaces: any[] = [];
    let spacePageToken: string | undefined;
    let spacePage = 0;
    do {
      const page = await chat.spaces.list({ pageSize: 100, pageToken: spacePageToken });
      spaces.push(...(page.data.spaces || []));
      spacePageToken = page.data.nextPageToken || undefined;
      spacePage += 1;
    } while (spacePageToken && spacePage < 2);
    const prioritySpace = /data\s*\/\s*ai|hha|hochbahn|huf|leadership|gcp|squad|d\/ai|avantgarde|häusler|haeusler|lorenz|suse|viessmann|sulzer|freenet|uhrenschmuck|pcg agent/i;
    const selectedSpaces = spaces
      .filter(space => space.name !== process.env.CHAT_SPACE_ID && !/^pcg agent$/i.test(String(space.displayName || '').trim()))
      .sort((a, b) => Number(prioritySpace.test(String(b.displayName || ''))) - Number(prioritySpace.test(String(a.displayName || ''))))
      .slice(0, 25);
    let context = 'Aktuelle Chat-Räume & Nachrichten:\n';
    for (let batchStart = 0; batchStart < selectedSpaces.length; batchStart += 10) {
      const batchContext = await Promise.all(selectedSpaces.slice(batchStart, batchStart + 10).map(async space => {
      if (!space.name) return '';
      if (space.name === process.env.CHAT_SPACE_ID || /^pcg agent$/i.test(String(space.displayName || '').trim())) return '';
      const spaceLabel = space.displayName ? `Raum: "${space.displayName}"` : `Raum: ${space.name}`;
      const chatUrl = `https://chat.google.com/room/${space.name.replace('spaces/', '')}`;
      let spaceContext = `- ${spaceLabel} | Direktlink: ${chatUrl}\n`;
      try {
        const messages: any[] = [];
        let messagePageToken: string | undefined;
        let messagePage = 0;
        do {
          const page = await chat.spaces.messages.list({ parent: space.name, pageSize: 100, pageToken: messagePageToken, orderBy: 'createTime desc' });
          messages.push(...(page.data.messages || []));
          messagePageToken = page.data.nextPageToken || undefined;
          messagePage += 1;
         } while (messagePageToken && messagePage < 1);
        const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const message of messages.filter(message => {
          if (message.createTime && Date.parse(message.createTime) < recentCutoff) return false;
          return !/^\[PCG-Agent\]/i.test(String(message.text || '').trim());
        })) {
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
          spaceContext += `   * ${sender}${time}: "${text.replace(/\n+/g, ' ')}"\n`;
        }
      } catch {
        // A listed space may not be readable with the current Chat scope.
      }
      return spaceContext;
      }));
      context += batchContext.join('');
    }
    return context;
  } catch (error: any) {
    console.warn('Chat fetch notice:', error?.message || error);
    return '(Chats konnten nicht abgerufen werden - Berechtigung oder Dienst inaktiv)\n';
  }
}
