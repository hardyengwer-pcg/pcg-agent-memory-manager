import React, { useState } from 'react';
import { 
  CheckSquare, Mail, Calendar, MessageSquare, FileText, 
  X, Loader2, CheckCircle2, AlertCircle, Plus, LogIn 
} from 'lucide-react';

interface ManualActionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ManualActionModal({ isOpen, onClose }: ManualActionModalProps) {
  const [activeType, setActiveType] = useState<'task' | 'email' | 'calendar' | 'chat' | 'drive'>('task');
  const [isLoading, setIsLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isAuthNeeded, setIsAuthNeeded] = useState(false);

  const handleReAuth = async () => {
    try {
      setIsLoading(true);
      setErrorMsg(null);
      const { googleSignIn } = await import('../auth');
      await googleSignIn();
      setIsAuthNeeded(false);
      setIsLoading(false);
    } catch (err: any) {
      setIsLoading(false);
      setErrorMsg("Anmeldung fehlgeschlagen: " + (err.message || ''));
    }
  };

  // Form states
  const [taskTitle, setTaskTitle] = useState('');
  const [taskNotes, setTaskNotes] = useState('');
  const [taskDueDate, setTaskDueDate] = useState('');

  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [isDraft, setIsDraft] = useState(true);

  const [calSummary, setCalSummary] = useState('');
  const [calStart, setCalStart] = useState('');
  const [calEnd, setCalEnd] = useState('');
  const [calDesc, setCalDesc] = useState('');

  const [chatText, setChatText] = useState('');
  const [chatSpace, setChatSpace] = useState('');

  const [driveName, setDriveName] = useState('');
  const [driveContent, setDriveContent] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setSuccessMsg(null);
    setErrorMsg(null);

    try {
      const { getAccessToken } = await import('../auth');
      const token = await getAccessToken();
      if (!token) {
        setErrorMsg("Bitte erst mit Google anmelden.");
        setIsLoading(false);
        return;
      }

      let endpoint = '';
      let payload: any = {};

      if (activeType === 'task') {
        if (!taskTitle) {
          setErrorMsg("Titel ist erforderlich.");
          setIsLoading(false);
          return;
        }
        endpoint = '/api/actions/task';
        payload = { title: taskTitle, notes: taskNotes, dueDate: taskDueDate };
      } else if (activeType === 'email') {
        if (!emailTo || !emailSubject || !emailBody) {
          setErrorMsg("Empfänger, Betreff und Text sind erforderlich.");
          setIsLoading(false);
          return;
        }
        endpoint = '/api/actions/email';
        payload = { to: emailTo, subject: emailSubject, body: emailBody, isDraft };
      } else if (activeType === 'calendar') {
        if (!calSummary || !calStart) {
          setErrorMsg("Titel und Startzeit sind erforderlich.");
          setIsLoading(false);
          return;
        }
        endpoint = '/api/actions/calendar';
        payload = { summary: calSummary, description: calDesc, startTime: calStart, endTime: calEnd };
      } else if (activeType === 'chat') {
        if (!chatText) {
          setErrorMsg("Nachrichtentext ist erforderlich.");
          setIsLoading(false);
          return;
        }
        endpoint = '/api/actions/chat';
        payload = { text: chatText, spaceName: chatSpace };
      } else if (activeType === 'drive') {
        if (!driveContent) {
          setErrorMsg("Inhalt ist erforderlich.");
          setIsLoading(false);
          return;
        }
        endpoint = '/api/actions/drive';
        payload = { fileName: driveName || `Notiz_${new Date().toISOString().split('T')[0]}.md`, content: driveContent };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const responseText = await res.text();
      let data: any = {};
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { error: responseText };
      }

      if (res.status === 401 || (data.error && (data.error.includes('abgelaufen') || data.error.includes('neu anmelden') || data.error.includes('Authentifizierung')))) {
        const { clearToken } = await import('../auth');
        clearToken();
        setIsAuthNeeded(true);
        setErrorMsg(data.error || "Google-Authentifizierung abgelaufen oder unzureichend. Bitte neu anmelden.");
        return;
      }

      if (res.ok && data.success) {
        setSuccessMsg(data.message || 'Aktion erfolgreich ausgeführt!');
        setTimeout(() => {
          onClose();
          setSuccessMsg(null);
        }, 1500);
      } else {
        setErrorMsg(data.error || 'Fehler beim Ausführen der Aktion.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Fehler beim Senden.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl relative space-y-5">
        <div className="flex items-center justify-between border-b border-gray-800 pb-3.5">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 bg-blue-600/20 text-blue-400 rounded-xl border border-blue-500/30">
              <Plus className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Neue Google Aktion erstellen</h2>
              <p className="text-xs text-gray-400">To-Do, E-Mail, Termin, Chat oder Drive-Notiz</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-white rounded-lg">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Action Type Selector */}
        <div className="grid grid-cols-5 gap-1.5">
          {[
            { type: 'task', label: 'To-Do', icon: <CheckSquare className="h-4 w-4" /> },
            { type: 'email', label: 'E-Mail', icon: <Mail className="h-4 w-4" /> },
            { type: 'calendar', label: 'Termin', icon: <Calendar className="h-4 w-4" /> },
            { type: 'chat', label: 'Chat', icon: <MessageSquare className="h-4 w-4" /> },
            { type: 'drive', label: 'Drive', icon: <FileText className="h-4 w-4" /> },
          ].map((item) => (
            <button
              key={item.type}
              type="button"
              onClick={() => setActiveType(item.type as any)}
              className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-xs font-medium transition-all ${
                activeType === item.type
                  ? 'bg-blue-600/20 border-blue-500/80 text-blue-300'
                  : 'bg-gray-950 border-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {item.icon}
              <span className="mt-1 text-[11px]">{item.label}</span>
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          {activeType === 'task' && (
            <>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Titel der Aufgabe</label>
                <input
                  type="text"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder="z. B. Kunde X bezüglich Angebot nachfassen"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Details / Notizen</label>
                <textarea
                  rows={2}
                  value={taskNotes}
                  onChange={(e) => setTaskNotes(e.target.value)}
                  placeholder="Zusätzliche Notizen zur Aufgabe..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Fälligkeit</label>
                <input
                  type="date"
                  value={taskDueDate}
                  onChange={(e) => setTaskDueDate(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {activeType === 'email' && (
            <>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Empfänger</label>
                <input
                  type="email"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder="empfaenger@beispiel.de"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Betreff</label>
                <input
                  type="text"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  placeholder="Betreff der E-Mail"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Nachricht</label>
                <textarea
                  rows={4}
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  placeholder="Guten Tag..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-sans"
                />
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="modal-draft"
                  checked={isDraft}
                  onChange={(e) => setIsDraft(e.target.checked)}
                  className="rounded border-gray-800 text-blue-600"
                />
                <label htmlFor="modal-draft" className="text-gray-300">
                  Als Entwurf in Gmail speichern (empfohlen)
                </label>
              </div>
            </>
          )}

          {activeType === 'calendar' && (
            <>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Termintitel</label>
                <input
                  type="text"
                  value={calSummary}
                  onChange={(e) => setCalSummary(e.target.value)}
                  placeholder="z. B. Architekturbesprechung"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-gray-400 mb-1 font-medium">Startzeit</label>
                  <input
                    type="datetime-local"
                    value={calStart}
                    onChange={(e) => setCalStart(e.target.value)}
                    className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 mb-1 font-medium">Endzeit</label>
                  <input
                    type="datetime-local"
                    value={calEnd}
                    onChange={(e) => setCalEnd(e.target.value)}
                    className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Beschreibung</label>
                <textarea
                  rows={2}
                  value={calDesc}
                  onChange={(e) => setCalDesc(e.target.value)}
                  placeholder="Agenda..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {activeType === 'chat' && (
            <>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Chat Nachricht</label>
                <textarea
                  rows={3}
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  placeholder="Nachricht an den Raum..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Chat-Raum Name (optional)</label>
                <input
                  type="text"
                  value={chatSpace}
                  onChange={(e) => setChatSpace(e.target.value)}
                  placeholder="spaces/..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {activeType === 'drive' && (
            <>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Dateiname (.md)</label>
                <input
                  type="text"
                  value={driveName}
                  onChange={(e) => setDriveName(e.target.value)}
                  placeholder="Notiz_Kundenbesprechung.md"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 mb-1 font-medium">Inhalt</label>
                <textarea
                  rows={4}
                  value={driveContent}
                  onChange={(e) => setDriveContent(e.target.value)}
                  placeholder="# Notizen..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {errorMsg && (
            <div className="p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-300 flex flex-col space-y-2">
              <div className="flex items-center space-x-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              {isAuthNeeded && (
                <button
                  type="button"
                  onClick={handleReAuth}
                  className="self-start mt-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium flex items-center space-x-1.5 text-xs transition-colors shadow"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  <span>Mit Google neu anmelden</span>
                </button>
              )}
            </div>
          )}

          {successMsg && (
            <div className="p-3 bg-emerald-950/60 border border-emerald-800 rounded-xl text-emerald-300 flex items-center space-x-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-gray-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-colors flex items-center space-x-1.5 disabled:opacity-50"
            >
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>Aktion ausführen</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
