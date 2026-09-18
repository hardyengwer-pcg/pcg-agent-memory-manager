import { google } from 'googleapis';

type RecordEvidence = (inputs: any[]) => void;

export async function fetchTasks(auth: any, recordEvidence: RecordEvidence = () => {}, createTasksClient = (value: any) => google.tasks({ version: 'v1', auth: value })) {
  try {
    const tasksApi = createTasksClient(auth);
    const taskLists: any[] = [];
    let listPageToken: string | undefined;
    do {
      const response = await tasksApi.tasklists.list({ maxResults: 100, pageToken: listPageToken });
      taskLists.push(...(response.data.items || []));
      listPageToken = response.data.nextPageToken || undefined;
    } while (listPageToken);

    const openTasks: { task: any; listTitle: string }[] = [];
    const completedTasks: { task: any; listTitle: string }[] = [];
    const completedMin = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const tasksUrl = 'https://tasks.google.com/';
    for (const list of taskLists) {
      if (!list.id) continue;
      let openPageToken: string | undefined;
      do {
        const response = await tasksApi.tasks.list({ tasklist: list.id, showCompleted: false, showHidden: false, maxResults: 100, pageToken: openPageToken });
        for (const task of response.data.items || []) if (task.title && task.status !== 'completed') openTasks.push({ task, listTitle: list.title || '(ohne Namen)' });
        openPageToken = response.data.nextPageToken || undefined;
      } while (openPageToken);

      let completedPageToken: string | undefined;
      do {
        const response = await tasksApi.tasks.list({ tasklist: list.id, showCompleted: true, showHidden: true, completedMin, maxResults: 100, pageToken: completedPageToken });
        for (const task of response.data.items || []) if (task.title && task.status === 'completed') completedTasks.push({ task, listTitle: list.title || '(ohne Namen)' });
        completedPageToken = response.data.nextPageToken || undefined;
      } while (completedPageToken);
    }

    openTasks.sort((a, b) => (a.task.due || '9999').localeCompare(b.task.due || '9999') || a.task.title.localeCompare(b.task.title));
    completedTasks.sort((a, b) => (b.task.completed || '').localeCompare(a.task.completed || ''));
    recordEvidence([...openTasks, ...completedTasks].map(({ task, listTitle }) => ({
      sourceType: 'tasks' as const,
      sourceId: task.id,
      content: JSON.stringify(task),
      sourceTimestamp: task.updated || task.completed || task.due,
      sourceUrl: tasksUrl,
      parentId: task.parent,
      metadata: { listTitle, status: task.status },
    })));

    let context = 'Google Tasks – AUTORITATIVE AUFGABENZUSTÄNDE:\nOFFEN (müssen berücksichtigt werden, auch wenn andere Quellen das Thema als abgeschlossen bezeichnen):\n';
    if (openTasks.length === 0) context += '(Keine offenen Aufgaben in Google Tasks.)\n';
    for (const { task, listTitle } of openTasks) {
      const due = task.due ? ` | Fällig: ${new Date(task.due).toLocaleDateString('de-DE')}` : '';
      const notes = task.notes ? ` | Notiz: ${task.notes.replace(/\n+/g, ' ')}` : '';
      context += `- [OFFEN] ${task.title} | Liste: ${listTitle}${due} | Direktlink: ${tasksUrl}${notes}\n`;
    }
    context += 'ERLEDIGT (dürfen durch ältere E-Mails, Chats, Kalender oder Drive-Dokumente NICHT reaktiviert werden):\n';
    if (completedTasks.length === 0) context += '(Keine in den letzten 180 Tagen erledigten Aufgaben gefunden.)\n';
    for (const { task, listTitle } of completedTasks) {
      const completed = task.completed ? new Date(task.completed).toLocaleDateString('de-DE') : 'unbekannt';
      context += `- [ERLEDIGT] ${task.title} | Liste: ${listTitle} | Erledigt am: ${completed} | Direktlink: ${tasksUrl}\n`;
    }
    return context;
  } catch (error: any) {
    console.warn('Tasks fetch notice:', error?.message || error);
    return '(Google Tasks konnten nicht abgerufen werden)\n';
  }
}
