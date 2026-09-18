type DriveDependencies = {
  getDriveClient: (accessToken: string) => Promise<any>;
  listAllFiles: (drive: any, folderId: string) => Promise<any[]>;
  getFileContent: (drive: any, fileId: string, mimeType: string) => Promise<string | null>;
  recordEvidence: (inputs: any[]) => void;
  loadLocalMemoryContext: () => string;
};

export async function fetchDriveKnowledgeBaseContext(accessToken: string, driveFolderId: string, dependencies: DriveDependencies) {
  try {
    const drive = await dependencies.getDriveClient(accessToken);
    const folderFiles = await dependencies.listAllFiles(drive, driveFolderId);
    let broadFiles: any[] = [];
    try {
      const response = await drive.files.list({
        q: "trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.google-apps.presentation' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'text/csv' or mimeType = 'application/pdf')",
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
    const eligibleFiles = Array.from(fileMap.values()).filter(file =>
      file.mimeType === 'text/markdown' || file.mimeType === 'text/plain' || file.mimeType === 'text/csv' ||
      file.mimeType?.includes('google-apps.document') || file.mimeType?.includes('google-apps.spreadsheet') || file.mimeType?.includes('google-apps.presentation') ||
      file.name?.endsWith('.md') || file.name?.endsWith('.txt') || file.name?.endsWith('.csv') ||
      /einarbeitung|onboarding|mitarbeiter|plan|september|welcome|joiner|schulung|training|squad|data|schwarz|dsv|vorbereitung|use\s*case|protokoll|transkript|transcript|meeting|notes|briefing|koenig|bauer|pk|lorenz|domcura|voest|alpine/i.test(file.name || '')
    );
    eligibleFiles.sort((a, b) => new Date(b.modifiedTime || 0).getTime() - new Date(a.modifiedTime || 0).getTime());

    let context = '';
    for (const file of eligibleFiles.slice(0, 20)) {
      const content = await dependencies.getFileContent(drive, file.id, file.mimeType);
      if (typeof content !== 'string') continue;
      const trimmedContent = content.length > 2500 ? `${content.slice(0, 2500)}\n...[Gekürzt bei 2.500 Zeichen]` : content;
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
    return `${context}\n--- LOKALES MEMORY / HINTERGRUND (gegen aktuelle datierte Quellen prüfen) ---\n${dependencies.loadLocalMemoryContext()}` || '(Keine Dokumente, Meeting-Protokolle oder Transkripte im Google Drive gefunden.)\n';
  } catch (error: any) {
    console.warn('Drive knowledge base fetch notice:', error?.message || error);
    return '(Dokumente / Meeting-Protokolle aus Google Drive konnten nicht geladen werden)\n';
  }
}
