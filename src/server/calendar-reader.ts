import { google } from 'googleapis';

type RecordEvidence = (inputs: any[]) => void;

export async function fetchUpcomingEvents(auth: any, recordEvidence: RecordEvidence) {
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fourteenDaysAhead = new Date();
    fourteenDaysAhead.setDate(fourteenDaysAhead.getDate() + 14);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: sevenDaysAgo.toISOString(),
      timeMax: fourteenDaysAhead.toISOString(),
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = res.data.items || [];
    const now = new Date();
    const todayISO = now.toISOString().split('T')[0];
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = tomorrow.toISOString().split('T')[0];
    const daysUntilMonday = ((8 - now.getDay()) % 7) || 7;
    const nextMonday = new Date(now);
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
    const nextMondayISO = nextMonday.toISOString().split('T')[0];

    let context = `Kalendertermine (Letzte 7 Tage bis +14 Tage Vorausschau, Stand heute: ${now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}):\n`;
    for (const event of events) {
      const summary = event.summary || '(Kein Titel)';
      const desc = event.description ? ` | Details: ${event.description.replace(/\n+/g, ' ').slice(0, 300)}` : '';
      if (/thursdays?\s+(for|4)\s+data/i.test(summary) || /thursdays?\s+(for|4)\s+data/i.test(desc)) continue;

      const start = event.start?.dateTime || event.start?.date || '';
      const end = event.end?.dateTime || event.end?.date || '';
      const eventDateISO = start.includes('T') ? start.split('T')[0] : start;
      let tag = '[ANSTEHEND]';
      if (eventDateISO === todayISO) tag = '[🚨 HEUTE - ANSTEHENDER TERMIN]';
      else if (eventDateISO === tomorrowISO) tag = '[🚨 MORGEN - ANSTEHENDER TERMIN (VORBEREITUNG HEUTE ERFORDERLICH!)]';
      else if (eventDateISO === nextMondayISO) tag = '[🔮 MONTAG - NÄCHSTE WOCHE (VORBEREITUNG VOR WOCHENENDE ERFORDERLICH!)]';
      else if (eventDateISO < todayISO) tag = '[VERGANGEN]';
      else if (eventDateISO > todayISO) tag = '[VORAUSSCHAU / NÄCHSTE TAGE]';

      const customerMeeting = /schwarz|dsv|use\s*case|kunde|client|customer|workshop|pitch|review|briefing|squad/i.test(summary) || /schwarz|dsv|use\s*case|kunde|client|customer/i.test(desc);
      if (customerMeeting) {
        if (eventDateISO === todayISO) tag += ' [⭐ KUNDENTERMIN HEUTE - BRIEFING & NOTIZEN!]';
        else if (eventDateISO === tomorrowISO || eventDateISO === nextMondayISO) tag += ' [⭐ KUNDENTERMIN MORGEN/MONTAG - VORBEREITUNG SPÄTESTENS HEUTE (1 TAG VORHER) DURCHFÜHREN!]';
        else tag += ' [⭐ KUNDEN- / USE-CASE-TERMIN - VORBEREITUNG FRÜHZEITIG EINPLANEN!]';
      }

      const location = event.location ? ` | Ort: ${event.location}` : '';
      const attendees = event.attendees ? ` | Teilnehmer: ${event.attendees.map((a: any) => a.displayName || a.email).join(', ')}` : '';
      const calendarUrl = event.htmlLink || 'https://calendar.google.com/calendar/u/0/r';
      recordEvidence([{
        sourceType: 'calendar',
        sourceId: event.id || `${summary}:${start}`,
        content: JSON.stringify(event),
        sourceTimestamp: start,
        author: event.organizer?.email,
        sourceUrl: calendarUrl,
        metadata: { summary, status: tag },
      }]);
      context += `- ${tag} ${summary} (${start} bis ${end}) | Direktlink: ${calendarUrl}${location}${attendees}${desc}\n`;
    }
    return context;
  } catch (error: any) {
    console.warn('Calendar fetch notice:', error?.message || error);
    return '(Kalendertermine konnten nicht abgerufen werden)\n';
  }
}
