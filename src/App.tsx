import React, { useState, useEffect, useRef } from 'react';
import { Bot, Send, User, Loader2, Database, ShieldAlert, CheckCircle, DatabaseZap, Mic, MicOff, Mail, RefreshCw, Clock, AlertCircle, Settings, Key, Globe, X, Server, CheckCircle2, Plus, Tag as TagIcon, Filter, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { parseMessageContent, ActionProposalCard, ActionProposal } from './components/ActionProposalCard';
import { ManualActionModal } from './components/ManualActionModal';
import { TagExplorerModal } from './components/TagExplorerModal';
import { MarkdownRenderer } from './components/MarkdownRenderer';

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  dismissedProposals?: string[];
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'agent',
      content: 'Hallo Hardy. Ich bin der PCG Agent Memory Manager. Dein lokales Memory-System ist bereit. Möchtest du einen **Daily Sync**, **Weekly Run** oder **Pflege-Run** starten?',
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [cronStatus, setCronStatus] = useState<{ dateStr?: string; emailSent?: boolean; emailErrorMsg?: string | null; lastRunAt?: string; success?: boolean } | null>(null);
  const [isTriggeringCron, setIsTriggeringCron] = useState(false);
  const [isManualActionOpen, setIsManualActionOpen] = useState(false);
  const [isTagsModalOpen, setIsTagsModalOpen] = useState(false);
  const [activeFilterTag, setActiveFilterTag] = useState<string | null>(null);

  const handleDismissProposal = (messageId: string, proposalId: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id === messageId) {
        const dismissed = m.dismissedProposals || [];
        return { ...m, dismissedProposals: [...dismissed, proposalId] };
      }
      return m;
    }));
  };

  // Gateway & API Key Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeyInvalidFormat, setApiKeyInvalidFormat] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-2.5-flash');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTestingSettings, setIsTestingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/ai-settings');
      if (res.ok) {
        const data = await res.json();
        setGatewayUrl(data.baseUrl || '');
        setApiKeyConfigured(data.apiKeyConfigured || false);
        setApiKeyInvalidFormat(data.apiKeyInvalidFormat || false);
        setApiKeyMasked(data.apiKeyMasked || '');
        if (data.model) setSelectedModel(data.model);
      }
    } catch (e) {
      console.error("Failed to fetch AI settings:", e);
    }
  };

  const handleTestSettings = async () => {
    if (apiKeyInput && /\s/.test(apiKeyInput.trim())) {
      setTestResult({
        success: false,
        message: 'Der eingegebene API-Key enthält Leerzeichen oder Fließtext. Bitte gib einen gültigen Schlüssel (z. B. sk-...) ein.'
      });
      return;
    }

    setIsTestingSettings(true);
    setTestResult(null);
    try {
      const { getAccessToken } = await import('./auth');
      const token = await getAccessToken();
      const res = await fetch('/api/ai-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          apiKey: apiKeyInput,
          baseUrl: gatewayUrl,
          model: selectedModel
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setTestResult({ success: true, message: data.message });
      } else {
        setTestResult({ success: false, message: data.error || 'Verbindungstest fehlgeschlagen.' });
      }
    } catch (e: any) {
      setTestResult({ success: false, message: e.message || 'Netzwerkfehler beim Testen.' });
    } finally {
      setIsTestingSettings(false);
    }
  };

  const handleSaveSettings = async () => {
    if (apiKeyInput && /\s/.test(apiKeyInput.trim())) {
      setTestResult({
        success: false,
        message: 'Der eingegebene API-Key enthält Leerzeichen oder Fließtext. Bitte gib einen gültigen Schlüssel (z. B. sk-...) ein.'
      });
      return;
    }

    setIsSavingSettings(true);
    try {
      const { getAccessToken } = await import('./auth');
      const token = await getAccessToken();
      const res = await fetch('/api/ai-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          apiKey: apiKeyInput,
          baseUrl: gatewayUrl,
          model: selectedModel
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchSettings();
        setApiKeyInput('');
        setTestResult({ success: true, message: 'Einstellungen erfolgreich gespeichert!' });
        setTimeout(() => {
          setIsSettingsOpen(false);
          setTestResult(null);
        }, 1200);
      } else {
        setTestResult({ success: false, message: data.error || 'Fehler beim Speichern.' });
      }
    } catch (e: any) {
      setTestResult({ success: false, message: e.message || 'Fehler beim Speichern.' });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const hasAutoTriggeredRef = useRef(false);

  const runDailyUpdate = async (manual = true, forceRefresh = true) => {
    if (isTriggeringCron) return;
    setIsTriggeringCron(true);
    try {
      const { getAccessToken } = await import('./auth');
      const token = await getAccessToken();
      if (!token) {
        setNeedsAuth(true);
        setIsTriggeringCron(false);
        return;
      }

      const res = await fetch('/api/cron/trigger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ forceRefresh: true })
      });

      if (res.status === 401) {
        const responseText = await res.text().catch(() => '');
        let errMsg = "Google API-Authentifizierung abgelaufen. Bitte neu anmelden.";
        try {
          const json = JSON.parse(responseText);
          if (json.error) errMsg = json.error;
        } catch {}

        if (errMsg.includes('LiteLLM') || errMsg.includes('AI Gateway') || errMsg.includes('API-Key')) {
          setIsTriggeringCron(false);
          if (manual) {
            setMessages(prev => [...prev, {
              id: Date.now().toString(),
              role: 'agent',
              content: `⚠️ **AI Gateway Konfiguration erforderlich:** ${errMsg}\n\nKlicke bitte oben rechts auf **AI Gateway**, um deinen API-Key einzutragen.`
            }]);
          }
          return;
        }

        console.warn("Auth notice in briefing trigger:", errMsg);
        const { clearToken } = await import('./auth');
        clearToken();
        setNeedsAuth(true);
        setIsTriggeringCron(false);
        if (manual) {
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'agent',
            content: `❌ **Authentifizierungsfehler:** ${errMsg}`
          }]);
        }
        return;
      }

      const responseText = await res.text();
      let data: any = {};
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(`Server-Fehler (HTTP ${res.status}): ${responseText.replace(/<[^>]*>/g, ' ').slice(0, 180).trim()}`);
      }

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Update konnte nicht ausgeführt werden.');
      }

      if (data.success) {
        setCronStatus({
          dateStr: data.dateStr,
          emailSent: data.emailSent,
          emailErrorMsg: data.emailErrorMsg,
          lastRunAt: data.lastRunAt || new Date().toISOString(),
          success: true
        });

        if (manual) {
          const emailInfo = data.emailSent 
            ? "📬 **E-Mail erfolgreich versendet!**" 
            : `⚠️ **E-Mail Hinweis:** ${data.emailErrorMsg || 'E-Mail konnte nicht gesendet werden.'}`;

          const agentMsg: Message = {
            id: Date.now().toString(),
            role: 'agent',
            content: `### 🚀 Tägliches Briefing ausgeführt!\n\n${emailInfo}\n\n---\n\n${data.summary}`
          };
          setMessages(prev => [...prev, agentMsg]);
        }
      } else {
        throw new Error(data.error || 'Update konnte nicht ausgeführt werden.');
      }
    } catch (err: any) {
      console.warn("Manual briefing trigger notice:", err?.message || err);
      const todayStr = new Date().toISOString().split('T')[0];
      setCronStatus(prev => ({
        ...prev,
        dateStr: todayStr,
        success: false,
        error: err.message || String(err)
      }));
      if (manual) {
        const errMsg = err.message || String(err);
        const isGatewayOrQuota = errMsg.includes('AI Gateway') || errMsg.includes('Quota') || errMsg.includes('API-Key') || errMsg.includes('LiteLLM') || errMsg.includes('429') || errMsg.includes('403') || errMsg.includes('Forbidden') || errMsg.includes('Zugriff auf Modell') || errMsg.includes('verweigert');
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'agent',
          content: isGatewayOrQuota 
            ? `⚠️ **AI Gateway / Modell-Hinweis:** ${errMsg}\n\nKlicke bitte oben rechts auf **AI Gateway**, um deine Einstellungen oder das Modell anzupassen.`
            : `❌ **Fehler beim Ausführen des Briefings:** ${errMsg}`
        }]);
      }
    } finally {
      setIsTriggeringCron(false);
    }
  };

  const syncTokenAndCheckCron = async () => {
    try {
      const { getAccessToken, clearToken } = await import('./auth');
      const token = await getAccessToken();
      if (!token) return;

      // Token mit Backend synchronisieren
      const syncRes = await fetch('/api/token-sync', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (syncRes.status === 401) {
        clearToken();
        setNeedsAuth(true);
        return;
      }

      // Cron Status abfragen
      const statusRes = await fetch('/api/cron/status', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (statusRes.ok) {
        const data = await statusRes.json();
        const currentStatus = data.status;
        setCronStatus(currentStatus);

        const todayStr = new Date().toISOString().split('T')[0];
        if ((!currentStatus || currentStatus.dateStr !== todayStr || !currentStatus.success) && !hasAutoTriggeredRef.current) {
          hasAutoTriggeredRef.current = true;
          console.log("Briefing for today missing or failed. Auto-triggering once now...");
          runDailyUpdate(false);
        }
      }
    } catch (e) {
      console.error("Token sync or cron check error:", e);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      let mimeType = 'audio/webm';
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
          mimeType = 'audio/ogg';
        }
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        if (audioBlob.size === 0) return;

        setIsTranscribing(true);

        try {
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = async () => {
            try {
              const base64Data = (reader.result as string).split(',')[1];
              const token = sessionStorage.getItem('google_access_token');

              const response = await fetch('/api/transcribe', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({
                  audio: base64Data,
                  mimeType: mimeType.split(';')[0]
                })
              });

              if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || 'Transkription fehlgeschlagen');
              }

              const data = await response.json();
              if (data.text) {
                setInput((prev) => (prev ? `${prev.trim()} ${data.text}` : data.text));
              } else {
                alert("Kein Text in der Aufnahme erkannt. Bitte erneut versuchen.");
              }
            } catch (err: any) {
              console.error("Transcribe process error:", err);
              alert(`Transkriptionsfehler: ${err.message || err}`);
            } finally {
              setIsTranscribing(false);
            }
          };
        } catch (err: any) {
          console.error("FileReader error:", err);
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err: any) {
      console.error("Microphone error:", err);
      alert("Mikrofonzugriff nicht möglich: " + (err.message || err));
      setIsRecording(false);
    }
  };

  useEffect(() => {
    fetchSettings();
    import('./auth').then(({ initAuth }) => {
      initAuth(
        () => {
          setNeedsAuth(false);
          syncTokenAndCheckCron();
        },
        () => setNeedsAuth(true)
      );
    });
  }, []);

  useEffect(() => {
    if (needsAuth === false) {
      syncTokenAndCheckCron();
    }
  }, [needsAuth]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const { googleSignIn } = await import('./auth');
      const result = await googleSignIn();
      if (result) {
        hasAutoTriggeredRef.current = false;
        setNeedsAuth(false);
        syncTokenAndCheckCron();
      }
    } catch (err) {
      console.error('Login failed:', err);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    const { logout } = await import('./auth');
    await logout();
    setNeedsAuth(true);
  };

  const sendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { id: Date.now().toString(), role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const { getAccessToken } = await import('./auth');
      const token = await getAccessToken();
      if (!token) {
        setNeedsAuth(true);
        setIsLoading(false);
        return;
      }

      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ message: userMessage.content }),
      });

      if (res.status === 401) {
        const responseText = await res.text().catch(() => '');
        let errMsg = "Google API-Authentifizierung abgelaufen. Bitte neu anmelden.";
        try {
          const json = JSON.parse(responseText);
          if (json.error) errMsg = json.error;
        } catch {}

        if (errMsg.includes('LiteLLM') || errMsg.includes('AI Gateway') || errMsg.includes('API-Key')) {
          setMessages(prev => [...prev, {
            id: (Date.now() + 1).toString(),
            role: 'agent',
            content: `⚠️ **AI Gateway Konfiguration erforderlich:** ${errMsg}\n\nKlicke bitte oben rechts auf **AI Gateway**, um deinen API-Key einzutragen.`
          }]);
          setIsLoading(false);
          return;
        }

        const { clearToken } = await import('./auth');
        clearToken();
        setNeedsAuth(true);
        setIsLoading(false);
        return;
      }

      const responseText = await res.text();
      let data: any = {};
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(`Server-Fehler (HTTP ${res.status}): ${responseText.replace(/<[^>]*>/g, ' ').slice(0, 180).trim()}`);
      }

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Fehler bei der Anfrage');
      }

      const agentMessage: Message = { id: (Date.now() + 1).toString(), role: 'agent', content: data.reply };
      setMessages(prev => [...prev, agentMessage]);
    } catch (error: any) {
      const errMsg = error.message || String(error);
      const isGatewayOrQuota = errMsg.includes('AI Gateway') || errMsg.includes('Quota') || errMsg.includes('API-Key') || errMsg.includes('LiteLLM') || errMsg.includes('429') || errMsg.includes('403') || errMsg.includes('Forbidden') || errMsg.includes('Zugriff auf Modell') || errMsg.includes('verweigert');
      const errorMessage: Message = { 
        id: (Date.now() + 1).toString(), 
        role: 'agent', 
        content: isGatewayOrQuota
          ? `⚠️ **AI Gateway / Modell-Hinweis:** ${errMsg}\n\nKlicke bitte oben rechts auf **AI Gateway**, um deine Einstellungen anzupassen.`
          : `**Fehler:** ${errMsg}`
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTrigger = (trigger: string) => {
    setInput(trigger);
  };

  if (needsAuth === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (needsAuth) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 font-sans text-gray-100 p-4">
        <div className="max-w-md w-full bg-gray-900 border border-gray-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center text-center space-y-6">
          <div className="bg-blue-900/30 p-4 rounded-full">
            <DatabaseZap className="h-10 w-10 text-blue-400" />
          </div>
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-white mb-2">Agent Memory Manager</h1>
            <p className="text-gray-400 text-sm">
              Authentifizierung erforderlich, um auf das lokale Memory-System (Google Drive) zuzugreifen.
            </p>
          </div>
          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium py-3 px-4 rounded-xl transition-colors duration-200 flex justify-center items-center"
          >
            {isLoggingIn ? <Loader2 className="h-5 w-5 animate-spin" /> : "Mit Google anmelden"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 font-sans text-gray-100">
      {/* Header */}
      <header className="flex-none flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur-md">
        <div className="flex items-center space-x-3">
          <div className="bg-blue-600 p-2 rounded-lg">
            <Database className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-medium tracking-tight">Memory Manager</h1>
            <p className="text-xs text-gray-400 font-mono tracking-wider">PCG AGENT // HARDY ENGWER</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {/* Briefing Status Indicator */}
          {(() => {
            const todayStr = new Date().toISOString().split('T')[0];
            const isToday = cronStatus?.dateStr === todayStr && cronStatus?.success;

            if (isTriggeringCron) {
              return (
                <div className="flex items-center space-x-2 text-xs text-blue-400 bg-blue-950/60 border border-blue-800/60 px-3 py-1.5 rounded-full">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Briefing wird erstellt...</span>
                </div>
              );
            }

            if (isToday) {
              return (
                <div className="flex items-center space-x-2 text-xs text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-3 py-1.5 rounded-full" title="Tägliches Update wurde heute erstellt und per Mail versendet">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Briefing heute gesendet</span>
                  {cronStatus?.emailSent && <Mail className="h-3 w-3 text-emerald-300 ml-1" />}
                </div>
              );
            }

            return (
              <div className="flex items-center space-x-2 text-xs text-amber-400 bg-amber-950/60 border border-amber-800/60 px-3 py-1.5 rounded-full" title="Für heute liegt noch kein neues Briefing vor">
                <Clock className="h-3.5 w-3.5" />
                <span>Briefing ausstehend</span>
              </div>
            );
          })()}

          {/* Manual Action Button */}
          <button
            onClick={() => setIsManualActionOpen(true)}
            title="Neue Google Workspace Aktion manuell erstellen (To-Do, E-Mail, Termin...)"
            className="flex items-center space-x-1.5 bg-blue-600/90 hover:bg-blue-500 text-xs text-white font-medium px-3 py-1.5 rounded-lg border border-blue-500/50 shadow-sm transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>+ Neue Aktion</span>
          </button>

          {/* Wissens-Tags Button (Obsidian-Style) */}
          <button
            onClick={() => setIsTagsModalOpen(true)}
            title="Wissens-Tags & Hierarchie (#kunde/..., #squad/...) öffnen"
            className="flex items-center space-x-1.5 bg-indigo-950/80 hover:bg-indigo-900/90 text-xs text-indigo-200 font-medium px-3 py-1.5 rounded-lg border border-indigo-700/60 shadow-sm transition-colors"
          >
            <TagIcon className="h-3.5 w-3.5 text-indigo-400" />
            <span>Tags</span>
            {activeFilterTag && (
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse ml-0.5" />
            )}
          </button>

          {/* Trigger Briefing Button */}
          <button
            onClick={() => runDailyUpdate(true, true)}
            disabled={isTriggeringCron}
            title="Jetzt neues Live-Briefing in Echtzeit generieren, im Drive speichern und per E-Mail versenden"
            className="flex items-center space-x-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-xs text-gray-200 font-medium px-3 py-1.5 rounded-lg border border-gray-700 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isTriggeringCron ? 'animate-spin text-blue-400' : 'text-gray-400'}`} />
            <span>Briefing jetzt auslösen</span>
          </button>

          {/* AI Gateway Settings Button */}
          <button
            onClick={() => {
              fetchSettings();
              setTestResult(null);
              setIsSettingsOpen(true);
            }}
            title="AI Gateway & API Key konfigurieren"
            className="flex items-center space-x-1.5 bg-gray-800 hover:bg-gray-700 text-xs text-gray-200 font-medium px-3 py-1.5 rounded-lg border border-gray-700 transition-colors relative"
          >
            <Settings className="h-3.5 w-3.5 text-gray-400" />
            <span>AI Gateway</span>
            {(gatewayUrl || apiKeyConfigured) && (
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse ml-0.5" title="Custom Gateway / Key aktiv" />
            )}
          </button>

          <button 
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-white transition-colors pl-2 border-l border-gray-800"
          >
            Abmelden
          </button>
        </div>
      </header>

      {/* Main Chat Area */}
      <main className="flex-grow overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Active Tag Filter Banner */}
          {activeFilterTag && (
            <div className="flex items-center justify-between bg-indigo-950/60 border border-indigo-700/60 px-4 py-2.5 rounded-xl text-xs text-indigo-200 shadow-md">
              <div className="flex items-center space-x-2">
                <Filter className="w-4 h-4 text-indigo-400" />
                <span>
                  Gefilterte Ansicht nach Tag: <strong className="font-mono bg-indigo-900/60 px-1.5 py-0.5 rounded border border-indigo-700">#{activeFilterTag}</strong>
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setIsTagsModalOpen(true)}
                  className="text-xs bg-indigo-900/80 hover:bg-indigo-800 text-indigo-200 px-2.5 py-1 rounded-lg transition-colors"
                >
                  Tags verwalten
                </button>
                <button
                  onClick={() => setActiveFilterTag(null)}
                  className="text-xs bg-indigo-700 hover:bg-indigo-600 text-white px-2.5 py-1 rounded-lg font-medium transition-colors"
                >
                  Filter aufheben
                </button>
              </div>
            </div>
          )}

          <AnimatePresence initial={false}>
            {(activeFilterTag
              ? messages.filter(m => m.content.toLowerCase().includes(activeFilterTag.toLowerCase()))
              : messages
            ).map((msg) => {
              const { cleanContent, proposals } = parseMessageContent(msg.content);
              const activeProposals = proposals.filter(p => !msg.dismissedProposals?.includes(p.id));

              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`flex max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'} items-start space-x-3 space-x-reverse sm:space-x-4`}>
                    
                    {/* Avatar */}
                    <div className={`flex-shrink-0 p-2 rounded-full ${msg.role === 'user' ? 'bg-gray-800 ml-3 sm:ml-4' : 'bg-blue-900/50 mr-3 sm:mr-4 border border-blue-800/50'}`}>
                      {msg.role === 'user' ? <User className="h-5 w-5 text-gray-300" /> : <Bot className="h-5 w-5 text-blue-400" />}
                    </div>

                    {/* Message Content & Action Cards */}
                    <div className="space-y-3 flex-1">
                      <div className={`rounded-2xl px-5 py-4 ${
                        msg.role === 'user' 
                           ? 'bg-blue-600 text-white' 
                          : 'bg-gray-900 border border-gray-800 text-gray-200 shadow-sm'
                      }`}>
                        <div className={`prose prose-sm ${msg.role === 'user' ? 'prose-invert' : 'prose-invert prose-p:leading-relaxed prose-pre:bg-gray-950 prose-pre:border prose-pre:border-gray-800'}`}>
                          <MarkdownRenderer 
                            content={cleanContent || msg.content} 
                            onTagClick={(tag) => {
                              setActiveFilterTag(tag);
                              setIsTagsModalOpen(true);
                            }}
                          />
                        </div>
                      </div>

                      {/* Action proposals cards list */}
                      {msg.role === 'agent' && activeProposals.length > 0 && (
                        <div className="bg-gray-950/70 border border-blue-900/40 rounded-2xl p-4 space-y-2 shadow-inner">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-2 text-xs font-semibold text-blue-400">
                              <CheckCircle2 className="h-4 w-4 text-blue-400" />
                              <span>Vorgeschlagene Nächste Schritte ({activeProposals.length})</span>
                            </div>
                            <button
                              onClick={() => {
                                activeProposals.forEach(p => handleDismissProposal(msg.id, p.id));
                              }}
                              className="text-[11px] text-gray-400 hover:text-red-400 transition-colors flex items-center space-x-1 px-2 py-0.5 rounded-lg hover:bg-red-950/30"
                              title="Alle Vorschläge dieser Nachricht verwerfen"
                            >
                              <Trash2 className="h-3 w-3" />
                              <span>Alle verwerfen</span>
                            </button>
                          </div>
                          <p className="text-[11px] text-gray-400">
                            Überprüfe und bestätige die folgenden vorbereiteten Aktionen oder lösche sie mit einem Klick.
                          </p>
                          <div className="space-y-2.5 pt-1">
                            {activeProposals.map(proposal => (
                              <ActionProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                onDismiss={(proposalId) => handleDismissProposal(msg.id, proposalId)}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {isLoading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="flex items-center space-x-4 max-w-[85%]">
                <div className="flex-shrink-0 p-2 rounded-full bg-blue-900/50 mr-4 border border-blue-800/50">
                  <Loader2 className="h-5 w-5 text-blue-400 animate-spin" />
                </div>
                <div className="text-gray-500 text-sm animate-pulse font-mono tracking-wider">
                  Analysiere Memory...
                </div>
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Footer / Input Area */}
      <footer className="flex-none p-4 sm:p-6 border-t border-gray-800 bg-gray-900/80 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto space-y-4">
          
          {/* Action Triggers */}
          <div className="flex flex-wrap gap-2">
            {["Daily Sync", "Weekly Run KW 42", "Pflege-Run", "Tägliches Update manuell starten"].map((trigger) => (
              <button
                key={trigger}
                onClick={() => {
                  if (trigger === "Tägliches Update manuell starten") {
                    runDailyUpdate(true);
                  } else {
                    handleTrigger(trigger);
                  }
                }}
                className="text-xs font-mono bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-full border border-gray-700 transition-colors"
              >
                &gt; {trigger}
              </button>
            ))}
          </div>

          <form onSubmit={sendMessage} className="relative flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  isRecording 
                    ? "Sprache wird aufgenommen... Klicken Sie auf das Mikrofon zum Beenden." 
                    : isTranscribing 
                    ? "Transkribiere Sprache mit KI..." 
                    : "Nachricht an Memory Manager..."
                }
                className={`w-full bg-gray-950 text-gray-100 rounded-xl pl-4 pr-12 py-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50 border transition-all placeholder:text-gray-600 ${
                  isRecording 
                    ? 'border-red-500 ring-2 ring-red-500/30 placeholder:text-red-400' 
                    : isTranscribing
                    ? 'border-blue-500 ring-2 ring-blue-500/30 placeholder:text-blue-400'
                    : 'border-gray-800'
                }`}
                disabled={isLoading || isTranscribing}
              />
              <button
                type="button"
                onClick={toggleRecording}
                disabled={isLoading || isTranscribing}
                title={
                  isTranscribing 
                    ? "Transkribiere..." 
                    : isRecording 
                    ? "Aufnahme stoppen & transkribieren" 
                    : "Spracheingabe starten"
                }
                className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-all ${
                  isRecording 
                    ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse' 
                    : 'text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-50'
                }`}
              >
                {isTranscribing ? (
                  <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                ) : isRecording ? (
                  <MicOff className="h-5 w-5" />
                ) : (
                  <Mic className="h-5 w-5" />
                )}
              </button>
            </div>
            <button
              type="submit"
              disabled={!input.trim() || isLoading || isTranscribing}
              className="p-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-xl transition-colors flex-shrink-0"
              title="Nachricht senden"
            >
              <Send className="h-5 w-5" />
            </button>
          </form>
        </div>
      </footer>

      {/* AI Gateway Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-lg w-full shadow-2xl space-y-6 relative"
            >
              <div className="flex items-center justify-between border-b border-gray-800 pb-4">
                <div className="flex items-center space-x-3">
                  <div className="p-2.5 bg-blue-600/20 text-blue-400 rounded-xl border border-blue-500/30">
                    <Server className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-white">AI Gateway & Key Konfiguration</h2>
                    <p className="text-xs text-gray-400">Gateway URL & eigenen API-Schlüssel verwalten</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 text-sm text-gray-300">
                <div className="p-3.5 bg-blue-950/40 border border-blue-800/50 rounded-xl text-xs text-blue-200 leading-relaxed flex items-start space-x-2.5">
                  <AlertCircle className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Bei Quota-Überschreitung:</strong> Trage hier deine benutzerdefinierte <strong>Gateway Base URL</strong> (z. B. AI Gateway / LiteLLM Proxy) oder deinen eigenen <strong>Gemini API-Schlüssel</strong> ein. Diese Einstellungen werden dauerhaft gespeichert.
                  </span>
                </div>

                {/* Gateway Base URL */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-300 flex items-center space-x-1.5">
                    <Globe className="h-3.5 w-3.5 text-blue-400" />
                    <span>Gateway Base URL (optional)</span>
                  </label>
                  <input
                    type="text"
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                    placeholder="z. B. https://my-gateway.example.com"
                    className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2.5 text-gray-100 placeholder:text-gray-600 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  />
                  <p className="text-[11px] text-gray-500">
                    Falls leer, wird die Standard Google Generative AI API aufgerufen.
                  </p>
                </div>

                {/* AI Model Selection */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-300 flex items-center justify-between">
                    <span className="flex items-center space-x-1.5">
                      <Bot className="h-3.5 w-3.5 text-purple-400" />
                      <span>KI-Modell auswählen</span>
                    </span>
                  </label>
                  
                  <input
                    type="text"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    placeholder="Standard, Pro, Expert, gemini-3.7-flash..."
                    className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2.5 text-gray-100 placeholder:text-gray-600 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  />

                  <div className="space-y-1 pt-1">
                    <span className="text-[11px] text-gray-400 font-medium block">Empfohlene Modelle für den Memory Manager:</span>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', desc: 'PCG Gateway Top-Speed & Qualität (Empfohlen)' },
                        { id: 'pcg-auto-pro', label: 'PCG Auto Pro', desc: 'Smarte Gateway Auto-Route' },
                        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', desc: 'Tiefes Reasoning & Context' },
                        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', desc: 'Gateway Anthropic Modell' },
                        { id: 'gpt-5.4', label: 'GPT 5.4', desc: 'Gateway OpenAI Modell' },
                        { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', desc: 'Google Gemini Direkt-API' },
                      ].map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setSelectedModel(m.id)}
                          className={`text-left p-2 rounded-xl border transition-all ${
                            selectedModel === m.id
                              ? 'bg-blue-600/20 border-blue-500/80 text-blue-200'
                              : 'bg-gray-950/80 border-gray-800/80 text-gray-400 hover:text-gray-200 hover:border-gray-700'
                          }`}
                        >
                          <div className="text-[11px] font-semibold flex items-center justify-between">
                            <span>{m.label}</span>
                            {selectedModel === m.id && <span className="text-[10px] text-blue-400 font-bold">✓</span>}
                          </div>
                          <div className="text-[10px] text-gray-500 line-clamp-1 mt-0.5">{m.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500 pt-0.5">
                    Wähle ein Modell, das für deinen API-Key / Gateway zugelassen ist. Das ausgewählte Modell wird dauerhaft für Briefings & Notizen gespeichert.
                  </p>
                </div>

                {/* Custom API Key */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-300 flex items-center justify-between">
                    <span className="flex items-center space-x-1.5">
                      <Key className="h-3.5 w-3.5 text-amber-400" />
                      <span>Benutzerdefinierter API-Key (optional)</span>
                    </span>
                    {apiKeyConfigured && (
                      <span className="text-[11px] text-emerald-400 font-normal">
                        ✓ Aktiv ({apiKeyMasked})
                      </span>
                    )}
                  </label>

                  {apiKeyInvalidFormat && (
                    <div className="p-3 bg-red-950/60 border border-red-800 rounded-xl text-xs text-red-200 flex items-start space-x-2.5">
                      <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-semibold text-red-300">Ungültiges Key-Format gespeichert</p>
                        <p className="text-[11px] text-red-300/80 mt-0.5">
                          Der aktuell gespeicherte Schlüssel ist Fließtext und kein echter API-Key. Bitte klicke unten auf "Gespeicherten Key löschen" und gib deinen echten Schlüssel ein (z. B. sk-...).
                        </p>
                      </div>
                    </div>
                  )}

                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={apiKeyConfigured ? "Neuen Key eingeben (oder leer lassen zum Beibehalten)" : "sk-..."}
                    className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3.5 py-2.5 text-gray-100 placeholder:text-gray-600 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  />
                  {(apiKeyConfigured || apiKeyInvalidFormat) && (
                    <div className="flex items-center justify-between pt-0.5">
                      <p className="text-[11px] text-gray-500">
                        {apiKeyConfigured ? "Key ist gespeichert." : "Ungültiger Text gespeichert."}
                      </p>
                      <button
                        type="button"
                        onClick={async () => {
                          setApiKeyInput('');
                          const { getAccessToken } = await import('./auth');
                          const token = await getAccessToken();
                          await fetch('/api/ai-settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
                            body: JSON.stringify({ removeApiKey: true })
                          });
                          await fetchSettings();
                        }}
                        className="text-[11px] text-red-400 hover:text-red-300 hover:underline font-medium"
                      >
                        Gespeicherten Key löschen
                      </button>
                    </div>
                  )}
                </div>

                {/* Test Feedback */}
                {testResult && (
                  <div className={`p-3 rounded-xl border text-xs flex items-start space-x-2.5 ${
                    testResult.success 
                      ? 'bg-emerald-950/50 border-emerald-800 text-emerald-300' 
                      : 'bg-red-950/50 border-red-800 text-red-300'
                  }`}>
                    {testResult.success ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    )}
                    <span>{testResult.message}</span>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between border-t border-gray-800 pt-4">
                <button
                  type="button"
                  onClick={handleTestSettings}
                  disabled={isTestingSettings || isSavingSettings}
                  className="px-3.5 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-xs text-gray-200 font-medium rounded-xl border border-gray-700 transition-colors flex items-center space-x-1.5"
                >
                  {isTestingSettings ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  <span>Verbindung testen</span>
                </button>

                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    className="px-3.5 py-2 text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    disabled={isSavingSettings}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs text-white font-medium rounded-xl transition-colors flex items-center space-x-1.5"
                  >
                    {isSavingSettings && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <span>Speichern</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Manual Action Modal */}
      <ManualActionModal
        isOpen={isManualActionOpen}
        onClose={() => setIsManualActionOpen(false)}
      />

      {/* Wissens-Tags Modal (Obsidian-Style) */}
      <TagExplorerModal
        isOpen={isTagsModalOpen}
        onClose={() => setIsTagsModalOpen(false)}
        activeFilterTag={activeFilterTag}
        onFilterByTag={(tag) => setActiveFilterTag(tag)}
        onSelectTagForChat={(tag, promptText) => {
          if (promptText) {
            setInput(promptText);
          } else {
            setInput(prev => prev ? `${prev} #${tag}` : `#${tag}`);
          }
        }}
      />
    </div>
  );
}
