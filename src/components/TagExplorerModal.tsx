import React, { useState, useEffect } from 'react';
import { 
  Tag as TagIcon, 
  X, 
  Search, 
  RefreshCw, 
  Sparkles, 
  FolderGit2, 
  Users, 
  AlertCircle, 
  CheckCircle2, 
  Lightbulb, 
  ExternalLink,
  MessageSquare,
  Filter
} from 'lucide-react';
import { getAccessToken } from '../auth';

export interface TagItem {
  tag: string;
  namespace: string;
  name: string;
  count: number;
}

interface TagExplorerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTagForChat: (tag: string, promptText?: string) => void;
  onFilterByTag?: (tag: string | null) => void;
  activeFilterTag?: string | null;
}

export const TagExplorerModal: React.FC<TagExplorerModalProps> = ({
  isOpen,
  onClose,
  onSelectTagForChat,
  onFilterByTag,
  activeFilterTag
}) => {
  const [tags, setTags] = useState<TagItem[]>([]);
  const [categories, setCategories] = useState<Record<string, TagItem[]>>({});
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTags = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/tags', {
        headers: {
          'Authorization': token ? `Bearer ${token}` : ''
        }
      });
      if (!res.ok) {
        throw new Error(`Fehler beim Laden (HTTP ${res.status})`);
      }
      const data = await res.json();
      if (data.success) {
        setTags(data.allTags || []);
        setCategories(data.categories || {});
      } else {
        throw new Error(data.error || 'Fehler beim Abrufen der Tags');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Tags konnten nicht geladen werden.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchTags();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const getNamespaceIcon = (ns: string) => {
    switch (ns) {
      case 'kunde':
        return <FolderGit2 className="w-3.5 h-3.5 text-blue-400" />;
      case 'squad':
        return <Users className="w-3.5 h-3.5 text-purple-400" />;
      case 'prio':
        return <AlertCircle className="w-3.5 h-3.5 text-rose-400" />;
      case 'status':
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
      case 'thema':
        return <Lightbulb className="w-3.5 h-3.5 text-amber-400" />;
      default:
        return <TagIcon className="w-3.5 h-3.5 text-gray-400" />;
    }
  };

  const getNamespaceStyle = (ns: string) => {
    switch (ns) {
      case 'kunde':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20';
      case 'squad':
        return 'bg-purple-500/10 text-purple-400 border-purple-500/30 hover:bg-purple-500/20';
      case 'prio':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20';
      case 'status':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20';
      case 'thema':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20';
      default:
        return 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-750';
    }
  };

  const getCategoryLabel = (cat: string) => {
    switch (cat) {
      case 'all': return 'Alle Tags';
      case 'kunde': return '🏢 Kunden (#kunde/*)';
      case 'squad': return '👥 Squad (#squad/*)';
      case 'prio': return '⚡ Priorität (#prio/*)';
      case 'status': return '📌 Status (#status/*)';
      case 'thema': return '💡 Themen (#thema/*)';
      case 'andere': return '📁 Andere Tags';
      default: return cat;
    }
  };

  // Filter tags by category and search
  const filteredTags = tags.filter(t => {
    const matchesCat = selectedCategory === 'all' || t.namespace === selectedCategory;
    const matchesSearch = searchQuery.trim() === '' || 
      t.tag.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesSearch;
  });

  const categoryKeys = ['all', 'kunde', 'squad', 'prio', 'status', 'thema', 'andere'].filter(
    k => k === 'all' || (categories[k] && categories[k].length > 0)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="bg-gray-900 border border-gray-800 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900/90">
          <div className="flex items-center space-x-2.5">
            <div className="bg-indigo-950/80 border border-indigo-700/60 p-2 rounded-lg">
              <TagIcon className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-semibold text-white">Wissens-Tags & Hierarchie</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 font-mono">
                  Obsidian PKM
                </span>
              </div>
              <p className="text-xs text-gray-400">
                Hierarchische Schlagworte (#kunde/..., #squad/...) aus Google Drive, Aufgaben & Kalender
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={fetchTags}
              disabled={isLoading}
              title="Tags neu scannen"
              className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-blue-400' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Search & Active Filter Bar */}
        <div className="px-6 pt-4 pb-2 space-y-3 bg-gray-900/50">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Tags filtern (z. B. schwarz, dsv, marion, prio)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-gray-950 border border-gray-800 rounded-xl text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Category Tabs */}
          <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 scrollbar-none text-xs">
            {categoryKeys.map((cat) => {
              const count = cat === 'all' ? tags.length : (categories[cat]?.length || 0);
              const isActive = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1.5 rounded-lg whitespace-nowrap font-medium transition-colors flex items-center space-x-1.5 ${
                    isActive 
                      ? 'bg-indigo-600 text-white shadow-sm' 
                      : 'bg-gray-800/80 text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  <span>{getCategoryLabel(cat)}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-indigo-700/80 text-white' : 'bg-gray-900 text-gray-400'}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {activeFilterTag && (
            <div className="flex items-center justify-between bg-indigo-950/40 border border-indigo-800/50 px-3 py-1.5 rounded-lg text-xs">
              <div className="flex items-center space-x-2 text-indigo-300">
                <Filter className="w-3.5 h-3.5 text-indigo-400" />
                <span>Aktiver Chat-Filter: <strong>#{activeFilterTag}</strong></span>
              </div>
              <button
                onClick={() => onFilterByTag?.(null)}
                className="text-[11px] text-indigo-400 hover:text-indigo-200 underline ml-2"
              >
                Filter zurücksetzen
              </button>
            </div>
          )}
        </div>

        {/* Tags Grid / List */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {isLoading && tags.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500 space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
              <p className="text-xs">Scanne Google Workspace & Knowledge Base nach Tags...</p>
            </div>
          ) : error ? (
            <div className="bg-rose-950/40 border border-rose-800/50 p-4 rounded-xl text-rose-300 text-xs flex items-start space-x-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          ) : filteredTags.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">
              Keine Tags für die aktuellen Suchkriterien gefunden.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {filteredTags.map((item) => {
                const isFiltered = activeFilterTag === item.tag;
                return (
                  <div
                    key={item.tag}
                    className={`group border rounded-xl p-3 flex flex-col justify-between transition-all duration-150 ${
                      isFiltered 
                        ? 'border-indigo-500 bg-indigo-950/40 ring-1 ring-indigo-500' 
                        : 'border-gray-800 bg-gray-950/60 hover:border-gray-700 hover:bg-gray-950'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center space-x-2 min-w-0">
                        {getNamespaceIcon(item.namespace)}
                        <span className="font-mono text-xs font-semibold text-gray-200 truncate" title={`#${item.tag}`}>
                          #{item.tag}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-gray-400 bg-gray-900 border border-gray-800 px-1.5 py-0.5 rounded-full flex-shrink-0">
                        {item.count}×
                      </span>
                    </div>

                    {/* Action buttons on card */}
                    <div className="flex items-center gap-1.5 pt-2 border-t border-gray-900">
                      <button
                        onClick={() => {
                          onSelectTagForChat(
                            item.tag,
                            `Fasse bitte alle aktuellen Notizen, To-Dos, E-Mails und offenen Punkte zum Tag #${item.tag} strukturiert zusammen.`
                          );
                          onClose();
                        }}
                        className="flex-1 flex items-center justify-center space-x-1 py-1 px-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded-lg text-[11px] font-medium transition-colors"
                        title="Im Chat analysieren"
                      >
                        <Sparkles className="w-3 h-3 text-indigo-400" />
                        <span>Analysieren</span>
                      </button>

                      <button
                        onClick={() => {
                          onSelectTagForChat(item.tag);
                          onClose();
                        }}
                        className="p-1 px-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-[11px] font-mono transition-colors"
                        title="Tag in Chat-Eingabe einfügen"
                      >
                        + #{item.tag}
                      </button>

                      {onFilterByTag && (
                        <button
                          onClick={() => {
                            onFilterByTag(isFiltered ? null : item.tag);
                          }}
                          className={`p-1 px-2 rounded-lg text-[11px] transition-colors ${
                            isFiltered 
                              ? 'bg-indigo-600 text-white' 
                              : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                          }`}
                          title="Chat-Verlauf filtern"
                        >
                          <Filter className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-gray-800 bg-gray-900/90 flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center space-x-2">
            <span>Tipp: Du kannst Tags direkt im Chat verwenden (z. B. <code>#kunde/dsv</code>).</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg font-medium transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
