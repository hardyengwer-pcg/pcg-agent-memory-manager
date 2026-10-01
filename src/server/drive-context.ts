type DriveDependencies = {
  getDriveClient: (accessToken: string) => Promise<any>;
  listAllFiles: (drive: any, folderId: string) => Promise<any[]>;
  getFileContent: (drive: any, fileId: string, mimeType: string, timeoutMs?: number) => Promise<string | null>;
  recordEvidence: (inputs: any[]) => void;
  loadLocalMemoryContext: () => string;
};

export function enrichTimestampTranscriptLinks(driveContext: string, eventsContext: string): string {
  const eventPattern = /- .*?([^\n(]+)\(([^)]+) bis ([^)]+)\).*?Direktlink:\s*(https?:\/\/[^\s|]+)/g;
  const events: { summary: string; end: number; url: string }[] = [];
  for (const match of eventsContext.matchAll(eventPattern)) {
    const end = Date.parse(match[3]);
    if (!Number.isNaN(end)) events.push({ summary: match[1].trim(), end, url: match[4] });
  }
  return driveContext.replace(
    /--- DOKUMENT \/ TRANSKRIPT \/ VORBEREITUNG: "([^"]*Transkript_[^"\s]+)"[^\n]*---([\s\S]*?)(?=\n--- DOKUMENT \/ TRANSKRIPT \/ VORBEREITUNG:|$)/gi,
    (block, name, body) => {
      const timestamp = name.match(/Transkript_(\d{4}-\d{2}-\d{2})[_-](\d{2})[-:](\d{2})/i) || body.match(/(?:generated on|erstellt am|generiert am)\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (!timestamp || events.length === 0) return `${block}\n[TRANSKRIPT-ZUORDNUNG: ungeklärt – kein passender Kalenderzeitpunkt ermittelbar]`;
      const transcriptTime = timestamp[1].includes('-')
        ? Date.parse(`${timestamp[1]}T${timestamp[2]}:${timestamp[3]}:00`)
        : Date.parse(`${timestamp[1]} ${timestamp[2]}:${timestamp[3]} ${timestamp[4] || ''}`);
      const transcriptText = body.slice(0, 1800).toLowerCase();
      const candidates = events.map(event => {
        const minutesAfterEnd = (transcriptTime - event.end) / 60000;
        const words = event.summary.toLowerCase().split(/[^a-z0-9äöüß]+/).filter(word => word.length >= 4);
        const overlap = words.filter(word => transcriptText.includes(word)).length;
        return { event, minutesAfterEnd, overlap };
      }).filter(candidate => candidate.minutesAfterEnd >= 0 && candidate.minutesAfterEnd <= 45)
        .sort((a, b) => (b.overlap - a.overlap) || (a.minutesAfterEnd - b.minutesAfterEnd));
      if (candidates.length === 0) return `${block}\n[TRANSKRIPT-ZUORDNUNG: ungeklärt – kein Meeting innerhalb von 45 Minuten vor der Transkription]`;
      const best = candidates[0];
      const confidence = best.overlap > 0 ? 'hoch' : 'mittel';
      return `${block}\n[TRANSKRIPT-ZUORDNUNG: ${confidence} – ${best.event.summary}; Meeting-Ende ${new Date(best.event.end).toISOString()}; ${Math.round(best.minutesAfterEnd)} Minuten bis Transkription; Quelle: ${best.event.url}]`;
    },
  );
}

export async function fetchDriveKnowledgeBaseContext(accessToken: string, driveFolderId: string | string[], dependencies: DriveDependencies) {
  try {
    const drive = await dependencies.getDriveClient(accessToken);
    const externalPlaybooks = [
      {
        id: '1JoDeOWLoDmFU-kjWcJ6aKxosD-lWAcELqrPUgVp1bc4',
        name: 'Playbook: nicht ausgelastete Squad-Mitglieder',
        url: 'https://docs.google.com/document/d/1JoDeOWLoDmFU-kjWcJ6aKxosD-lWAcELqrPUgVp1bc4/edit',
      },
      {
        id: '1j_A5aPj7HneC9NhWs7kY0dfva4aIb2EuZ0z8I-GTZXU',
        name: 'Resource Planner Duties und Kapazitätsregeln',
        url: 'https://docs.google.com/document/d/1j_A5aPj7HneC9NhWs7kY0dfva4aIb2EuZ0z8I-GTZXU/edit',
      },
    ];
    const externalContents = await Promise.all(externalPlaybooks.map(async source => ({
      source,
      content: await dependencies.getFileContent(drive, source.id, 'application/vnd.google-apps.document', 30000),
    })));
    const externalContext = externalContents.filter(item => item.content).map(({ source, content }) => {
      dependencies.recordEvidence([{ sourceType: 'drive', sourceId: source.id, content: content!, sourceTimestamp: new Date().toISOString(), sourceUrl: source.url, metadata: { name: source.name, external: true } }]);
      return `--- EXTERNE PLAYBOOK-/REGELQUELLE: "${source.name}" | Direktlink: ${source.url} ---\n${content}\n\n`;
    }).join('');
    const folderFiles = (await Promise.all((Array.isArray(driveFolderId) ? driveFolderId : [driveFolderId]).map(folderId => dependencies.listAllFiles(drive, folderId)))).flat();
    let broadFiles: any[] = [];
    try {
      const response = await drive.files.list({
          q: "trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.presentation' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'text/csv')",
        pageSize: 100,
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
      });
      broadFiles = response.data.files || [];
    } catch (error: any) {
      console.warn('Broad Drive search notice:', error?.message || error);
    }

    const queries = [
      "trashed = false and (name contains 'Schwarz' or name contains 'DSV' or name contains 'Vorbereitung' or name contains 'Use Case' or name contains 'Memory' or name contains 'Briefing' or name contains 'Meeting' or name contains 'Protokoll' or name contains 'Transkript' or name contains 'Transcript' or name contains 'Notes' or name contains 'Sync' or name contains 'Weekly' or name contains 'Wochen' or name contains 'Besprechung' or name contains 'Koenig' or name contains 'Bauer' or name contains 'PK' or name contains 'Lorenz' or name contains 'domcura' or name contains 'voestalpine' or name contains 'VOEST' or name contains 'Alpine' or name contains 'Fabian' or name contains 'Mario' or name contains 'Panda' or name contains 'Auslastung' or name contains 'Kapazität' or name contains 'Staffing' or name contains 'Billability' or name contains 'Allocation' or name contains 'Resource')",
      "trashed = false and (name contains 'Einarbeitung' or name contains 'Einarbeitungsplan' or name contains 'Onboarding' or name contains 'Mitarbeiter' or name contains 'Plan' or name contains 'September' or name contains 'Welcome' or name contains 'Joiner' or name contains 'Schulung' or name contains 'Training' or name contains 'Squad' or name contains 'DATA' or name contains 'Handover')",
    ];
    const targetedFiles: any[][] = [];
    for (const query of queries) {
      try {
        const response = await drive.files.list({ q: query, pageSize: 60, orderBy: 'modifiedTime desc', fields: 'files(id, name, mimeType, modifiedTime, webViewLink)' });
        targetedFiles.push(response.data.files || []);
      } catch (error: any) {
        console.warn('Targeted Drive search notice:', error?.message || error);
      }
    }

    const fileMap = new Map<string, any>();
    for (const file of [...folderFiles, ...broadFiles, ...targetedFiles.flat()]) {
      if (file.id && !fileMap.has(file.id)) fileMap.set(file.id, file.path ? file : { ...file, path: file.name });
    }
    const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const eligibleFiles = Array.from(fileMap.values()).filter(file =>
      file.modifiedTime && new Date(file.modifiedTime).getTime() >= cutoff && file.mimeType !== 'application/vnd.google-apps.shortcut' && (
        file.mimeType === 'text/markdown' || file.mimeType === 'text/plain' || file.mimeType === 'text/csv' ||
        file.mimeType?.includes('google-apps.document') || file.mimeType?.includes('google-apps.spreadsheet') || file.mimeType?.includes('google-apps.presentation') ||
        file.name?.endsWith('.md') || file.name?.endsWith('.txt') || file.name?.endsWith('.csv') ||
        /einarbeitung|onboarding|mitarbeiter|plan|september|welcome|joiner|schulung|training|squad|data|schwarz|dsv|vorbereitung|use\s*case|protokoll|transkript|transcript|meeting|notes|briefing|koenig|bauer|pk|lorenz|domcura|voest|alpine/i.test(file.name || '')
      )
    );
    eligibleFiles.sort((a, b) => {
      const aMeeting = /transkript|transcript|meeting|notes|protokoll|besprechung/i.test(a.name || a.path || '');
      const bMeeting = /transkript|transcript|meeting|notes|protokoll|besprechung/i.test(b.name || b.path || '');
      return Number(bMeeting) - Number(aMeeting) || new Date(b.modifiedTime || 0).getTime() - new Date(a.modifiedTime || 0).getTime();
    });

    let context = '';
    for (const file of eligibleFiles.slice(0, 20)) {
      const content = await dependencies.getFileContent(drive, file.id, file.mimeType);
      if (typeof content !== 'string') continue;
      const isMeetingDocument = /transkript|transcript|meeting|notes|protokoll|besprechung/i.test(file.name || file.path || '');
      const trimmedContent = content.length > 3000 && isMeetingDocument
        ? `${content.slice(0, 1500)}\n...[Mitte gekürzt]...\n${content.slice(-3000)}`
        : content.length > 2500 ? `${content.slice(0, 2500)}\n...[Gekürzt bei 2.500 Zeichen]` : content;
      const modified = file.modifiedTime ? new Date(file.modifiedTime) : null;
      const dateLabel = modified ? modified.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
      const futurePlan = /einarbeitung|onboarding|mitarbeiter|plan|september|schulung|welcome|new\s*joiner/i.test(file.path || file.name) || /einarbeitung|onboarding|september|neuer\s*mitarbeiter/i.test(trimmedContent.slice(0, 500));
      let ageNotice = '';
      if (futurePlan) ageNotice = ' [🌟 STRATEGISCHER / OPERATIVER ZUKUNFTS-PLAN - HOHE PRIORITÄT FÜR SQUAD LEAD HARDY]';
      else if (modified) {
        const ageDays = Math.floor((Date.now() - modified.getTime()) / (1000 * 60 * 60 * 24));
        if (ageDays <= 3) ageNotice = ` [🚨 FRISCH / KÜRZLICH BEARBEITET (${dateLabel})]`;
        else if (ageDays > 28) ageNotice = ` [⚠️ HISTORISCHES DOKUMENT - geändert vor ${Math.floor(ageDays / 7)} Wochen; nicht als aktuelle Aufgabe behandeln]`;
        else if (ageDays > 10) ageNotice = ` [Älterer Stand: ${ageDays} Tage]`;
        else ageNotice = ` (Stand: ${dateLabel})`;
      }
      const isCustomerPrep = /schwarz|dsv|vorbereitung|use\s*case/i.test(file.path || file.name);
      const prepHighlight = isCustomerPrep ? ' [⭐ KUNDEN-VORBEREITUNGS-DOKUMENT]' : '';
      const url = file.webViewLink || (file.mimeType?.includes('google-apps.document') ? `https://docs.google.com/document/d/${file.id}/edit` : file.mimeType?.includes('google-apps.spreadsheet') ? `https://docs.google.com/spreadsheets/d/${file.id}/edit` : `https://drive.google.com/file/d/${file.id}/view`);
      dependencies.recordEvidence([{ sourceType: 'drive', sourceId: file.id, content, sourceTimestamp: file.modifiedTime, sourceUrl: url, metadata: { name: file.name, path: file.path, mimeType: file.mimeType } }]);
      context += `--- DOKUMENT / TRANSKRIPT / VORBEREITUNG: "${file.path || file.name}" | Direktlink: ${url}${prepHighlight}${ageNotice} ---\n${trimmedContent}\n\n`;
    }
    return `${externalContext}${context}\n--- LOKALES MEMORY / HINTERGRUND (gegen aktuelle datierte Quellen prüfen) ---\n${dependencies.loadLocalMemoryContext()}` || '(Keine Dokumente, Meeting-Protokolle oder Transkripte im Google Drive gefunden.)\n';
  } catch (error: any) {
    console.warn('Drive knowledge base fetch notice:', error?.message || error);
    return '(Dokumente / Meeting-Protokolle aus Google Drive konnten nicht geladen werden)\n';
  }
}
