import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Tag as TagIcon, ExternalLink } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
  onTagClick?: (tag: string) => void;
}

const getTagColorClass = (tag: string) => {
  const lower = tag.toLowerCase();
  if (lower.startsWith('kunde/') || lower === 'schwarz' || lower === 'dsv') {
    return 'bg-blue-900/40 text-blue-300 border-blue-700/60 hover:bg-blue-800/60';
  }
  if (lower.startsWith('squad/') || lower === 'marion' || lower === 'hardy') {
    return 'bg-purple-900/40 text-purple-300 border-purple-700/60 hover:bg-purple-800/60';
  }
  if (lower.startsWith('prio/')) {
    return 'bg-rose-900/40 text-rose-300 border-rose-700/60 hover:bg-rose-800/60';
  }
  if (lower.startsWith('status/')) {
    return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/60 hover:bg-emerald-800/60';
  }
  if (lower.startsWith('thema/')) {
    return 'bg-amber-900/40 text-amber-300 border-amber-700/60 hover:bg-amber-800/60';
  }
  return 'bg-gray-800/80 text-gray-300 border-gray-700 hover:bg-gray-700';
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, onTagClick }) => {
  // Custom text formatter to transform #hashtags into interactive pills
  const renderFormattedText = (text: string) => {
    if (typeof text !== 'string') return text;

    const parts: (string | React.ReactNode)[] = [];
    const tagRegex = /(?:^|\s)(#([a-zA-ZäöüÄÖÜß][\w\u00C0-\u017F/-]{1,40}))/g;
    let lastIndex = 0;
    let match;

    while ((match = tagRegex.exec(text)) !== null) {
      const fullMatch = match[1]; // e.g. "#kunde/dsv"
      const rawTag = match[2]; // e.g. "kunde/dsv"
      const matchIndex = match.index + (match[0].startsWith(' ') ? 1 : 0);

      // Skip hex color codes
      if (/^[0-9a-f]{3,6}$/i.test(rawTag)) {
        continue;
      }

      // Add text before match
      if (matchIndex > lastIndex) {
        parts.push(text.substring(lastIndex, matchIndex));
      }

      const colorClass = getTagColorClass(rawTag);

      parts.push(
        <button
          key={`tag-${matchIndex}-${rawTag}`}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTagClick?.(rawTag);
          }}
          title={`Wissens-Tag #${rawTag} filtern / analysieren`}
          className={`inline-flex items-center space-x-1 px-1.5 py-0.5 mx-0.5 rounded-md border text-[11px] font-mono font-medium transition-all duration-150 cursor-pointer align-baseline ${colorClass}`}
        >
          <TagIcon className="w-2.5 h-2.5 opacity-70" />
          <span>#{rawTag}</span>
        </button>
      );

      lastIndex = matchIndex + fullMatch.length;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  const components = {
    a: ({ href, children }: any) => {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium underline underline-offset-2 hover:bg-blue-950/40 px-1 py-0.5 rounded transition-all duration-150"
          title={`Quelle öffnen: ${href}`}
        >
          <span>{children}</span>
          <ExternalLink className="w-3 h-3 inline-block shrink-0 opacity-80" />
        </a>
      );
    },
    p: ({ children }: any) => {
      if (typeof children === 'string') {
        return <p className="my-1.5 leading-relaxed">{renderFormattedText(children)}</p>;
      }
      if (Array.isArray(children)) {
        return (
          <p className="my-1.5 leading-relaxed">
            {children.map((child, i) =>
              typeof child === 'string' ? <React.Fragment key={i}>{renderFormattedText(child)}</React.Fragment> : child
            )}
          </p>
        );
      }
      return <p className="my-1.5 leading-relaxed">{children}</p>;
    },
    li: ({ children }: any) => {
      if (typeof children === 'string') {
        return <li className="my-1">{renderFormattedText(children)}</li>;
      }
      if (Array.isArray(children)) {
        return (
          <li className="my-1">
            {children.map((child, i) =>
              typeof child === 'string' ? <React.Fragment key={i}>{renderFormattedText(child)}</React.Fragment> : child
            )}
          </li>
        );
      }
      return <li className="my-1">{children}</li>;
    }
  };

  return (
    <ReactMarkdown components={components}>
      {content}
    </ReactMarkdown>
  );
};
