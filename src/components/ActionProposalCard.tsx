import React, { useState } from 'react';
import { 
  CheckSquare, Mail, Calendar, MessageSquare, FileText, 
  Check, Edit3, Trash2, Send, Loader2, AlertCircle, ChevronDown, ChevronUp, ExternalLink, X, Plus, LogIn
} from 'lucide-react';

export interface ActionProposal {
  id: string;
  type: 'task' | 'email' | 'calendar' | 'chat' | 'drive';
  title: string;
  details: {
    title?: string;
    notes?: string;
    dueDate?: string;
    to?: string;
    subject?: string;
    body?: string;
    isDraft?: boolean;
    summary?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
    text?: string;
    fileName?: string;
    content?: string;
    spaceName?: string;
  };
  status?: 'pending' | 'executing' | 'success' | 'error';
  errorMessage?: string;
  successMessage?: string;
  resultLink?: string;
}

export function parseMessageContent(rawContent: string): { cleanContent: string; proposals: ActionProposal[] } {
  if (!rawContent) return { cleanContent: '', proposals: [] };

  const match = rawContent.match(/<ACTION_PROPOSALS>([\s\S]*?)(?:<\/ACTION_PROPOSALS>|$)/i);
  if (!match) {
    return { cleanContent: rawContent, proposals: [] };
  }

  // Always strip out the ACTION_PROPOSALS tags and block from markdown text view
  const cleanContent = rawContent.replace(/<ACTION_PROPOSALS>[\s\S]*?(?:<\/ACTION_PROPOSALS>|$)/gi, '').trim();

  let jsonStr = match[1].trim();
  // Strip code fences if present
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Remove trailing commas before closing braces/brackets
  jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1');

  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      const proposals: ActionProposal[] = parsed.map((item, index) => ({
        id: item.id || `proposal-${Date.now()}-${index}`,
        type: item.type || 'task',
        title: item.title || 'Aktion vorschlagen',
        details: item.details || {},
        status: 'pending'
      }));
      return { cleanContent, proposals };
    }
  } catch (e) {
    console.warn("Standard JSON parse failed for ACTION_PROPOSALS, trying resilient extraction:", e);
    // Fallback: extract individual JSON objects
    try {
      const objectRegex = /\{[\s\S]*?"type"\s*:\s*"([^"]+)"[\s\S]*?\}/g;
      const fallbackProposals: ActionProposal[] = [];
      let objMatch;
      let idx = 0;
      while ((objMatch = objectRegex.exec(jsonStr)) !== null) {
        try {
          const singleObj = JSON.parse(objMatch[0].replace(/,\s*([\]}])/g, '$1'));
          fallbackProposals.push({
            id: singleObj.id || `proposal-${Date.now()}-${idx++}`,
            type: singleObj.type || 'task',
            title: singleObj.title || 'Aktion vorschlagen',
            details: singleObj.details || {},
            status: 'pending'
          });
        } catch {}
      }
      if (fallbackProposals.length > 0) {
        return { cleanContent, proposals: fallbackProposals };
      }
    } catch {}
  }

  return { cleanContent, proposals: [] };
}

interface ActionProposalCardProps {
  proposal: ActionProposal;
  onDismiss: (id: string) => void;
}

export function ActionProposalCard({ proposal, onDismiss }: ActionProposalCardProps) {
  const [details, setDetails] = useState({ ...proposal.details });
  const [isEditing, setIsEditing] = useState(false);
  const [status, setStatus] = useState<'pending' | 'executing' | 'success' | 'error'>(proposal.status || 'pending');
  const [errorMessage, setErrorMessage] = useState<string | null>(proposal.errorMessage || null);
  const [successMessage, setSuccessMessage] = useState<string | null>(proposal.successMessage || null);
  const [resultLink, setResultLink] = useState<string | null>(proposal.resultLink || null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isAuthNeeded, setIsAuthNeeded] = useState(false);

  const handleReAuthAndExecute = async () => {
    try {
      setStatus('executing');
      setErrorMessage(null);
      const { googleSignIn } = await import('../auth');
      await googleSignIn();
      setIsAuthNeeded(false);
      await handleExecute();
    } catch (err: any) {
      console.error("Re-auth error:", err);
      setStatus('error');
      setErrorMessage("Anmeldung abgebrochen oder fehlgeschlagen: " + (err.message || ''));
    }
  };

  const handleExecute = async () => {
    setStatus('executing');
    setErrorMessage(null);
    setIsAuthNeeded(false);
    try {
      const { getAccessToken, clearToken } = await import('../auth');
      let token = await getAccessToken();
      if (!token) {
        setStatus('error');
        setIsAuthNeeded(true);
        setErrorMessage("Bitte melde dich mit Google an, um die Aktion auszuführen.");
        return;
      }

      let endpoint = '';
      let payload: any = {};

      if (proposal.type === 'task') {
        endpoint = '/api/actions/task';
        payload = {
          title: details.title || proposal.title,
          notes: details.notes || '',
          dueDate: details.dueDate || ''
        };
      } else if (proposal.type === 'email') {
        endpoint = '/api/actions/email';
        payload = {
          to: details.to,
          subject: details.subject,
          body: details.body,
          isDraft: details.isDraft !== false
        };
      } else if (proposal.type === 'calendar') {
        endpoint = '/api/actions/calendar';
        payload = {
          summary: details.summary || proposal.title,
          description: details.description || '',
          startTime: details.startTime,
          endTime: details.endTime
        };
      } else if (proposal.type === 'chat') {
        endpoint = '/api/actions/chat';
        payload = {
          text: details.text,
          spaceName: details.spaceName
        };
      } else if (proposal.type === 'drive') {
        endpoint = '/api/actions/drive';
        payload = {
          fileName: details.fileName || `Notiz_${new Date().toISOString().split('T')[0]}.md`,
          content: details.content || details.notes || ''
        };
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
        clearToken();
        setStatus('error');
        setIsAuthNeeded(true);
        setErrorMessage(data.error || "Google-Authentifizierung abgelaufen oder Berechtigung fehlt. Bitte neu anmelden.");
        return;
      }

      if (res.ok && data.success) {
        setStatus('success');
        setSuccessMessage(data.message || 'Aktion erfolgreich ausgeführt!');
        if (data.link || data.htmlLink) {
          setResultLink(data.link || data.htmlLink);
        }
        setIsEditing(false);
      } else {
        setStatus('error');
        setErrorMessage(data.error || 'Fehler bei der Ausführung der Aktion.');
      }
    } catch (err: any) {
      console.error("Action execution error:", err);
      setStatus('error');
      setErrorMessage(err.message || 'Netzwerkfehler bei der Ausführung.');
    }
  };

  const getBadgeStyle = () => {
    switch (proposal.type) {
      case 'task':
        return {
          badge: 'bg-emerald-950/80 border-emerald-800/80 text-emerald-300',
          icon: <CheckSquare className="h-4 w-4 text-emerald-400" />,
          label: 'Google To-Do'
        };
      case 'email':
        return {
          badge: 'bg-blue-950/80 border-blue-800/80 text-blue-300',
          icon: <Mail className="h-4 w-4 text-blue-400" />,
          label: 'Gmail E-Mail'
        };
      case 'calendar':
        return {
          badge: 'bg-amber-950/80 border-amber-800/80 text-amber-300',
          icon: <Calendar className="h-4 w-4 text-amber-400" />,
          label: 'Google Kalender'
        };
      case 'chat':
        return {
          badge: 'bg-purple-950/80 border-purple-800/80 text-purple-300',
          icon: <MessageSquare className="h-4 w-4 text-purple-400" />,
          label: 'Google Chat'
        };
      case 'drive':
        return {
          badge: 'bg-cyan-950/80 border-cyan-800/80 text-cyan-300',
          icon: <FileText className="h-4 w-4 text-cyan-400" />,
          label: 'Google Drive'
        };
      default:
        return {
          badge: 'bg-gray-800 border-gray-700 text-gray-300',
          icon: <CheckSquare className="h-4 w-4 text-gray-400" />,
          label: 'Aktion'
        };
    }
  };

  const badgeInfo = getBadgeStyle();

  return (
    <div className={`my-3 rounded-xl border transition-all ${
      status === 'success' 
        ? 'bg-emerald-950/30 border-emerald-800/60 shadow-lg'
        : status === 'error'
        ? 'bg-red-950/30 border-red-800/60'
        : 'bg-gray-900/90 border-gray-800 hover:border-gray-700 shadow-md'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between p-3.5 border-b border-gray-800/60">
        <div className="flex items-center space-x-2.5">
          <div className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold ${badgeInfo.badge}`}>
            {badgeInfo.icon}
            <span>{badgeInfo.label}</span>
          </div>
          <span className="text-sm font-medium text-gray-100 line-clamp-1">{proposal.title}</span>
        </div>

        <div className="flex items-center space-x-1.5">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 text-gray-400 hover:text-white rounded-lg transition-colors"
            title={isExpanded ? "Einklappen" : "Ausklappen"}
          >
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <button
            onClick={() => onDismiss(proposal.id)}
            className="p-1 text-gray-400 hover:text-red-400 rounded-lg transition-colors"
            title="Aktion verwerfen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content / Form */}
      {isExpanded && (
        <div className="p-4 space-y-3.5 text-xs">
          {status === 'success' ? (
            <div className="flex items-start space-x-2.5 text-emerald-300 bg-emerald-950/60 border border-emerald-800/80 p-3 rounded-xl">
              <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold">{successMessage || 'Aktion erfolgreich ausgeführt!'}</p>
                {resultLink && (
                  <a
                    href={resultLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center space-x-1 text-emerald-400 hover:underline font-medium"
                  >
                    <span>Eintrag / Dokument öffnen</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          ) : (
            <>
              {errorMessage && (
                <div className="flex flex-col space-y-2 text-red-300 bg-red-950/60 border border-red-800/80 p-3 rounded-xl">
                  <div className="flex items-start space-x-2.5">
                    <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    <span className="flex-1">{errorMessage}</span>
                  </div>
                  {isAuthNeeded && (
                    <button
                      type="button"
                      onClick={handleReAuthAndExecute}
                      className="self-start mt-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium flex items-center space-x-1.5 text-xs transition-colors shadow"
                    >
                      <LogIn className="h-3.5 w-3.5" />
                      <span>Mit Google neu anmelden & erneut versuchen</span>
                    </button>
                  )}
                </div>
              )}

              {isEditing ? (
                /* Edit Form */
                <div className="space-y-3 bg-gray-950/80 p-3 rounded-xl border border-gray-800">
                  {proposal.type === 'task' && (
                    <>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Titel der Aufgabe</label>
                        <input
                          type="text"
                          value={details.title || ''}
                          onChange={(e) => setDetails({ ...details, title: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Notizen / Details</label>
                        <textarea
                          rows={2}
                          value={details.notes || ''}
                          onChange={(e) => setDetails({ ...details, notes: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Fälligkeitsdatum (YYYY-MM-DD)</label>
                        <input
                          type="date"
                          value={details.dueDate || ''}
                          onChange={(e) => setDetails({ ...details, dueDate: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                    </>
                  )}

                  {proposal.type === 'email' && (
                    <>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Empfänger (E-Mail)</label>
                        <input
                          type="email"
                          value={details.to || ''}
                          onChange={(e) => setDetails({ ...details, to: e.target.value })}
                          placeholder="kundenadresse@beispiel.de"
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Betreff</label>
                        <input
                          type="text"
                          value={details.subject || ''}
                          onChange={(e) => setDetails({ ...details, subject: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">E-Mail Text</label>
                        <textarea
                          rows={4}
                          value={details.body || ''}
                          onChange={(e) => setDetails({ ...details, body: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-blue-500 font-sans"
                        />
                      </div>
                      <div className="flex items-center space-x-2 pt-1">
                        <input
                          type="checkbox"
                          id={`draft-${proposal.id}`}
                          checked={details.isDraft !== false}
                          onChange={(e) => setDetails({ ...details, isDraft: e.target.checked })}
                          className="rounded border-gray-800 text-blue-600 focus:ring-blue-500"
                        />
                        <label htmlFor={`draft-${proposal.id}`} className="text-[11px] text-gray-300">
                          Als Entwurf in Gmail speichern (empfohlen zur Überprüfung)
                        </label>
                      </div>
                    </>
                  )}

                  {proposal.type === 'calendar' && (
                    <>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Titel des Termins</label>
                        <input
                          type="text"
                          value={details.summary || details.title || ''}
                          onChange={(e) => setDetails({ ...details, summary: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-amber-500"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-medium text-gray-400 mb-1">Startzeit</label>
                          <input
                            type="datetime-local"
                            value={details.startTime ? details.startTime.slice(0, 16) : ''}
                            onChange={(e) => setDetails({ ...details, startTime: e.target.value })}
                            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-amber-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-gray-400 mb-1">Endzeit</label>
                          <input
                            type="datetime-local"
                            value={details.endTime ? details.endTime.slice(0, 16) : ''}
                            onChange={(e) => setDetails({ ...details, endTime: e.target.value })}
                            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-amber-500"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Beschreibung / Agenda</label>
                        <textarea
                          rows={2}
                          value={details.description || ''}
                          onChange={(e) => setDetails({ ...details, description: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-amber-500"
                        />
                      </div>
                    </>
                  )}

                  {proposal.type === 'chat' && (
                    <>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Nachrichtentext</label>
                        <textarea
                          rows={3}
                          value={details.text || ''}
                          onChange={(e) => setDetails({ ...details, text: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Chat-Raum (optional)</label>
                        <input
                          type="text"
                          value={details.spaceName || ''}
                          onChange={(e) => setDetails({ ...details, spaceName: e.target.value })}
                          placeholder="Standardmäßig erster verfügbarer Raum"
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-purple-500"
                        />
                      </div>
                    </>
                  )}

                  {proposal.type === 'drive' && (
                    <>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Dateiname (.md)</label>
                        <input
                          type="text"
                          value={details.fileName || ''}
                          onChange={(e) => setDetails({ ...details, fileName: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-cyan-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-400 mb-1">Inhalt / Dokumenttext</label>
                        <textarea
                          rows={4}
                          value={details.content || details.notes || ''}
                          onChange={(e) => setDetails({ ...details, content: e.target.value })}
                          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-100 text-xs focus:ring-1 focus:ring-cyan-500"
                        />
                      </div>
                    </>
                  )}

                  <div className="flex justify-end space-x-2 pt-1">
                    <button
                      onClick={() => setIsEditing(false)}
                      className="px-3 py-1 text-gray-400 hover:text-white"
                    >
                      Fertig
                    </button>
                  </div>
                </div>
              ) : (
                /* Read Preview */
                <div className="space-y-1.5 text-gray-300">
                  {proposal.type === 'task' && (
                    <div className="space-y-1 bg-gray-950/40 p-2.5 rounded-lg border border-gray-800/80">
                      <p><strong className="text-gray-400">Aufgabe:</strong> {details.title || proposal.title}</p>
                      {details.notes && <p><strong className="text-gray-400">Details:</strong> {details.notes}</p>}
                      {details.dueDate && <p><strong className="text-gray-400">Fällig am:</strong> {details.dueDate}</p>}
                    </div>
                  )}

                  {proposal.type === 'email' && (
                    <div className="space-y-1 bg-gray-950/40 p-2.5 rounded-lg border border-gray-800/80">
                      <p><strong className="text-gray-400">An:</strong> {details.to || '(E-Mail eintragen)'}</p>
                      <p><strong className="text-gray-400">Betreff:</strong> {details.subject || '(Betreff eintragen)'}</p>
                      <p><strong className="text-gray-400">Typ:</strong> {details.isDraft !== false ? 'Entwurf in Gmail erstellen' : 'Direkt als E-Mail senden'}</p>
                      {details.body && (
                        <div className="mt-2 pt-2 border-t border-gray-800/80 text-gray-400 whitespace-pre-wrap font-sans text-[11px]">
                          {details.body}
                        </div>
                      )}
                    </div>
                  )}

                  {proposal.type === 'calendar' && (
                    <div className="space-y-1 bg-gray-950/40 p-2.5 rounded-lg border border-gray-800/80">
                      <p><strong className="text-gray-400">Termin:</strong> {details.summary || proposal.title}</p>
                      {details.startTime && <p><strong className="text-gray-400">Start:</strong> {details.startTime.replace('T', ' ')}</p>}
                      {details.description && <p><strong className="text-gray-400">Beschreibung:</strong> {details.description}</p>}
                    </div>
                  )}

                  {proposal.type === 'chat' && (
                    <div className="space-y-1 bg-gray-950/40 p-2.5 rounded-lg border border-gray-800/80">
                      <p><strong className="text-gray-400">Google Chat Nachricht:</strong></p>
                      <p className="text-gray-300 italic">{details.text}</p>
                    </div>
                  )}

                  {proposal.type === 'drive' && (
                    <div className="space-y-1 bg-gray-950/40 p-2.5 rounded-lg border border-gray-800/80">
                      <p><strong className="text-gray-400">Datei:</strong> {details.fileName || 'Notiz.md'}</p>
                      <p className="text-gray-300 whitespace-pre-wrap text-[11px]">{details.content || details.notes}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-3 border-t border-gray-800/60 gap-2 flex-wrap">
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => onDismiss(proposal.id)}
                    className="flex items-center space-x-1.5 text-red-400 hover:text-red-300 hover:bg-red-950/50 border border-red-900/40 transition-colors px-3 py-1.5 rounded-lg text-xs font-medium"
                    title="Diesen Vorschlag löschen / ablehnen"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Löschen</span>
                  </button>

                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="flex items-center space-x-1.5 text-gray-400 hover:text-gray-200 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-gray-800 border border-gray-800 text-xs"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    <span>{isEditing ? "Vorschau" : "Bearbeiten"}</span>
                  </button>
                </div>

                <button
                  onClick={handleExecute}
                  disabled={status === 'executing'}
                  className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-xl font-medium text-white transition-all shadow-md disabled:opacity-50 text-xs ${
                    proposal.type === 'task' 
                      ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/50' 
                      : proposal.type === 'email'
                      ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-950/50'
                      : proposal.type === 'calendar'
                      ? 'bg-amber-600 hover:bg-amber-500 shadow-amber-950/50'
                      : proposal.type === 'chat'
                      ? 'bg-purple-600 hover:bg-purple-500 shadow-purple-950/50'
                      : 'bg-cyan-600 hover:bg-cyan-500 shadow-cyan-950/50'
                  }`}
                >
                  {status === 'executing' ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Wird ausgeführt...</span>
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>
                        {proposal.type === 'task' && 'Bestätigen & To-Do anlegen'}
                        {proposal.type === 'email' && (details.isDraft !== false ? 'Bestätigen & Entwurf speichern' : 'Bestätigen & E-Mail senden')}
                        {proposal.type === 'calendar' && 'Bestätigen & Termin anlegen'}
                        {proposal.type === 'chat' && 'Bestätigen & Chat senden'}
                        {proposal.type === 'drive' && 'Bestätigen & in Drive speichern'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
