import { google } from 'googleapis';

type RecordEvidence = (inputs: any[]) => void;

export async function fetchRecentEmails(auth: any, recordEvidence: RecordEvidence) {
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.list({ userId: 'me', q: 'newer_than:45d -in:trash -in:spam', maxResults: 60, includeSpamTrash: false });
    const messages = res.data.messages || [];
    let targetedMessages: any[] = [];
    try {
      const targetedRes = await gmail.users.messages.list({
        userId: 'me',
        q: 'newer_than:45d -in:trash -in:spam (transcript OR transkript OR "meeting notes" OR protokoll OR summary OR zusammenfassung OR "action items" OR todo OR to-do OR aufgabe OR projekt OR zugewiesen OR "next steps" OR handover OR scoping OR proposal OR sow OR "statement of work" OR "use case" OR "use cases" OR review OR retrospective OR alignment OR sync OR briefing OR absprache OR "Koenig" OR "Bauer" OR "Lorenz" OR "domcura" OR "voestalpine" OR "VOEST" OR "PK" OR "Einarbeitung" OR "Einarbeitungsplan" OR "Onboarding" OR "Mitarbeiter" OR "September" OR "Joiner" OR "Welcome" OR "Schulung")',
        maxResults: 50,
        includeSpamTrash: false,
      });
      targetedMessages = targetedRes.data.messages || [];
    } catch (error: any) {
      console.warn('Targeted Gmail query notice:', error?.message || error);
    }

    const ids = [...new Map([...messages, ...targetedMessages].filter(message => message.id).map(message => [message.id, message])).keys()];
    const parsedEmails: any[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const chunkResults = await Promise.all(ids.slice(i, i + 10).map(async (msgId) => {
        try {
          const message = (await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' })).data;
          const headers = message.payload?.headers;
          const labelIds = message.labelIds || [];
          const subject = headers?.find(h => h.name === 'Subject')?.value || '(Kein Betreff)';
          const from = headers?.find(h => h.name === 'From')?.value || 'Unbekannt';
          const to = headers?.find(h => h.name === 'To')?.value || '';
          const date = headers?.find(h => h.name === 'Date')?.value || '';
          const snippet = message.snippet || '';
          const internalDate = Number(message.internalDate) || (date ? new Date(date).getTime() : 0);
          if (labelIds.includes('TRASH') || labelIds.includes('SPAM')) return null;

          const statusStr = labelIds.includes('SENT') ? 'GESENDET' : labelIds.includes('INBOX') ? 'Posteingang (Aktiv)' : 'ARCHIVIERT';
          let bodyText = '';
          const attachments: string[] = [];
          const extractParts = (part: any) => {
            if (!part) return;
            if (part.filename) attachments.push(part.filename);
            if (part.mimeType === 'text/plain' && part.body?.data) {
              try { bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n'; } catch {}
            } else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
              try {
                bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8')
                  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n';
              } catch {}
            }
            for (const child of part.parts || []) extractParts(child);
          };
          extractParts(message.payload);
          let bodySnippet = bodyText.replace(/\r?\n+/g, ' ').trim() || snippet;
          if (bodySnippet.length > 2500) bodySnippet = bodySnippet.slice(0, 2500) + '... [Gekürzt]';
          const projectPattern = /transcript|transkript|meeting\s*notes|protokoll|summary|zusammenfassung|action\s*items?|todo|to-do|aufgabe|zugewiesen|projekt|next\s*steps|handover|scoping|proposal|sow|statement\s*of\s*work|use\s*cases?|review|retrospective|alignment|sync|briefing|absprache/i;
          return { id: msgId, internalDate, statusStr, from, to, subject, date, bodySnippet, bodyText: bodyText || snippet, attachments: attachments.join(', '), isTranscriptOrProject: projectPattern.test(subject) || projectPattern.test(bodySnippet) };
        } catch (error: any) {
          console.warn(`Gmail msg get notice ${msgId}:`, error?.message || error);
          return null;
        }
      }));
      parsedEmails.push(...chunkResults.filter(Boolean));
    }

    recordEvidence(parsedEmails.map(email => ({
      sourceType: 'gmail' as const,
      sourceId: email.id,
      content: email.bodyText,
      sourceTimestamp: email.date || (email.internalDate ? new Date(email.internalDate).toISOString() : undefined),
      author: email.from,
      sourceUrl: `https://mail.google.com/mail/u/0/#all/${email.id}`,
      metadata: { subject: email.subject, status: email.statusStr, attachments: email.attachments },
    })));
    parsedEmails.sort((a, b) => b.internalDate - a.internalDate || (a.id || '').localeCompare(b.id || ''));

    let context = 'Neueste aktive E-Mails & Transkripte (Posteingang und Archiv; ohne Papierkorb/Spam):\n';
    const nowMs = Date.now();
    for (const email of parsedEmails) {
      const daysOld = email.internalDate ? Math.floor((nowMs - email.internalDate) / (1000 * 60 * 60 * 24)) : 0;
      if (daysOld > 45 && email.statusStr !== 'Posteingang (Aktiv)') continue;
      if (/hibob|stundenzettel|time\s*off/i.test(email.from) || /hibob.*(stundenzettel|approved|submitted|genehmigt|freigabe)/i.test(email.subject)) continue;
      const ageFlag = daysOld > 21 ? ` [⚠️ HISTORISCHE E-MAIL (${daysOld} Tage alt) - VORHER PRÜFEN OB NOCH AKTUELL; NICHT als aktuelle Prio oder neue To-Dos interpretieren]` : daysOld > 7 ? ` [Älterer Thread (${daysOld} Tage alt) - Aktualität vor Erwähnung gegenprüfen]` : '';
      const direction = email.statusStr === 'GESENDET' ? ` | Empfänger: ${email.to || 'unbekannt'} | AUSGANG: Für offene Antworten Follow-up prüfen` : '';
      const flag = email.isTranscriptOrProject ? ' [⭐ ENTHÄLT TRANSKRIPT / PROJEKT / USE-CASE / AUFGABEN]' : '';
      const url = `https://mail.google.com/mail/u/0/#all/${email.id}`;
      const attachments = email.attachments ? ` | Anhänge: ${email.attachments}` : '';
      context += `- [Status: ${email.statusStr}]${flag}${ageFlag} Von: ${email.from}${direction} | Betreff: ${email.subject} | Datum: ${email.date} | Direktlink: ${url}${attachments}\n  Inhalt / Text: "${email.bodySnippet}"\n`;
    }
    return context;
  } catch (error: any) {
    console.warn('Gmail fetch notice:', error?.message || error);
    return '(E-Mails konnten nicht abgerufen werden)\n';
  }
}
