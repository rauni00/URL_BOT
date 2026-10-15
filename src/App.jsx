import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_API_BASE, DEFAULT_SESSION, newSessionId, streamChat } from './lib/chatApi.js';

const SUGGESTIONS = [
  'Hello',
  'What chatbot services do you offer?',
  'How can you help me?',
  'What is the pricing?',
];

function load(key, fallback) {
  try {
    // migrate from old ultimabot- keys so the session is not lost
    const oldKey = key.replace('mitra-ai-', 'ultimabot-');
    return localStorage.getItem(key) || localStorage.getItem(oldKey) || fallback;
  } catch {
    return fallback;
  }
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------- rich message rendering: fenced code blocks + inline code ---------- */

function parseSegments(text) {
  const segs = [];
  const re = /```(\w*)\n?([\s\S]*?)(```|$)/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      segs.push({ type: 'text', key: `t${k++}`, text: text.slice(last, m.index) });
    }
    segs.push({ type: 'code', key: `c${k++}`, lang: (m[1] || 'code').toLowerCase(), code: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
    if (m[3] === '') break; // unclosed fence (streaming) — rest is code
  }
  if (last < text.length) {
    segs.push({ type: 'text', key: `t${k++}`, text: text.slice(last) });
  }
  return segs;
}

function renderInline(text, prefix, inlineClass) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((p, i) =>
    p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
      <code key={`${prefix}-i${i}`} className={inlineClass}>
        {p.slice(1, -1)}
      </code>
    ) : (
      <span key={`${prefix}-i${i}`}>{p}</span>
    ),
  );
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const lines = code.split('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-slate-700 bg-[#0d1117] text-left shadow-lg">
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/5 px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 rounded-md bg-white/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-300">
          {lang}
        </span>
        <button
          onClick={copy}
          className="ml-auto rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-400 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="code-scroll overflow-x-auto p-3 font-mono text-xs leading-relaxed text-slate-200">
        {lines.map((ln, i) => (
          <div key={i} className="flex">
            <span className="sticky left-0 w-8 shrink-0 select-none bg-[#0d1117] pr-3 text-right text-slate-600">
              {i + 1}
            </span>
            <code className="whitespace-pre pr-4">{ln || ' '}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderRichText(text, role, msgId) {
  const inlineClass =
    role === 'user'
      ? 'rounded bg-black/30 px-1.5 py-0.5 font-mono text-[0.85em] text-amber-100'
      : 'rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[0.85em] text-amber-200';
  return parseSegments(text).map((s) =>
    s.type === 'code' ? (
      <CodeBlock key={`${msgId}-${s.key}`} lang={s.lang} code={s.code} />
    ) : (
      <span key={`${msgId}-${s.key}`}>{renderInline(s.text, `${msgId}-${s.key}`, inlineClass)}</span>
    ),
  );
}

export default function App() {
  const [messages, setMessages] = useState(() => [
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Hello! I am Mitra AI — your smart assistant. Ask me anything about our chatbot services.',
      sources: [],
      time: now(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [session, setSession] = useState(() => load('mitra-ai-session', DEFAULT_SESSION));
  const [baseUrl, setBaseUrl] = useState(() => load('mitra-ai-base', DEFAULT_API_BASE));
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');

  const abortRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem('mitra-ai-session', session);
      localStorage.setItem('mitra-ai-base', baseUrl);
    } catch {}
  }, [session, baseUrl]);

  // Smart auto-scroll: instant while streaming, smooth otherwise
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: isLoading ? 'auto' : 'smooth' });
    }
  }, [messages, isLoading]);

  const send = useCallback(
    async (textOverride) => {
      const query = (textOverride ?? input).trim();
      if (!query || isLoading) return;
      setError('');
      setInput('');

      const userMsg = { id: `u-${Date.now()}`, role: 'user', content: query, time: now() };
      const botId = `a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: botId, role: 'assistant', content: '', sources: [], streaming: true, time: now() },
      ]);
      setIsLoading(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat({
          query,
          session,
          baseUrl,
          signal: controller.signal,
          onToken: (token) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === botId ? { ...m, content: m.content + token } : m)),
            );
          },
          onSources: (sources) => {
            setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, sources } : m)));
          },
        });
        setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, streaming: false } : m)));
      } catch (e) {
        if (e.name === 'AbortError') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botId ? { ...m, content: m.content + ' (stopped)', streaming: false } : m,
            ),
          );
        } else {
          setError(e.message || 'Something went wrong. Please try again.');
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botId
                ? { ...m, content: m.content || `Error: ${e.message}`, streaming: false, error: true }
                : m,
            ),
          );
        }
      } finally {
        setIsLoading(false);
        abortRef.current = null;
        inputRef.current?.focus();
      }
    },
    [input, isLoading, session, baseUrl],
  );

  const stop = () => abortRef.current?.abort();

  const resetChat = () => {
    stop();
    setMessages([
      {
        id: 'welcome-' + Date.now(),
        role: 'assistant',
        content: 'New chat started! What would you like to ask?',
        sources: [],
        time: now(),
      },
    ]);
    setError('');
  };

  const copyText = async (id, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(''), 1500);
    } catch {}
  };

  return (
    <div className="relative min-h-dvh w-full overflow-hidden bg-slate-100 flex items-center justify-center sm:p-4 lg:p-6">
      {/* ambient background blobs */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="animate-drift absolute -top-24 -left-24 h-72 w-72 sm:h-96 sm:w-96 rounded-full bg-indigo-300/50 blur-3xl" />
        <div className="animate-drift-slow absolute -bottom-28 -right-24 h-72 w-72 sm:h-96 sm:w-96 rounded-full bg-fuchsia-300/50 blur-3xl" />
        <div className="absolute top-1/3 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-sky-200/40 blur-3xl" />
      </div>

      <div className="animate-pop-in relative flex h-dvh w-full flex-col overflow-hidden bg-white/90 shadow-2xl ring-1 ring-slate-900/5 backdrop-blur sm:h-[92dvh] sm:max-w-2xl sm:rounded-3xl lg:max-w-3xl">
        {/* Header */}
        <header className="animate-gradient relative flex items-center justify-between gap-2 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 px-3 py-3 text-white sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <div className="animate-glow flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/20 text-lg font-bold backdrop-blur transition-transform duration-300 hover:rotate-6 hover:scale-105 sm:h-11 sm:w-11">
              M
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold leading-tight sm:text-lg">Mitra AI</h1>
              <p className="flex items-center gap-1.5 text-[11px] text-white/85 sm:text-xs">
                <span className="relative flex h-2 w-2">
                  {isLoading && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-300 opacity-75" />
                  )}
                  <span
                    className={`relative inline-flex h-2 w-2 rounded-full ${
                      isLoading ? 'bg-yellow-300' : 'bg-emerald-400'
                    }`}
                  />
                </span>
                <span className="truncate">{isLoading ? 'Typing...' : 'Online'}</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <button
              onClick={resetChat}
              className="rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium backdrop-blur transition hover:scale-105 hover:bg-white/25 active:scale-95 sm:px-4"
            >
              + New
            </button>
            <button
              onClick={() => setShowSettings((s) => !s)}
              aria-expanded={showSettings}
              title="Settings"
              className={`rounded-full p-2 backdrop-blur transition hover:scale-105 active:scale-95 ${
                showSettings ? 'bg-white/30' : 'bg-white/15 hover:bg-white/25'
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`h-4 w-4 transition-transform duration-300 ${showSettings ? 'rotate-90' : ''}`}
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Settings panel */}
        {showSettings && (
          <div className="animate-fade-in grid gap-2.5 border-b border-slate-200 bg-slate-50/90 px-3 py-3 text-sm backdrop-blur sm:px-5">
            <label className="grid gap-1">
              <span className="text-xs font-medium text-slate-600">API URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-slate-600">Session ID</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
                <button
                  onClick={() => setSession(newSessionId())}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:scale-[1.02] hover:bg-slate-700 active:scale-95"
                >
                  Random
                </button>
              </div>
            </label>
          </div>
        )}

        {/* Messages */}
        <div
          ref={listRef}
          className="chat-scroll flex-1 space-y-3 overflow-y-auto bg-gradient-to-b from-slate-50 to-indigo-50/40 px-3 py-4 sm:space-y-4 sm:px-5"
        >
          {messages.map((m, i) => (
            <div
              key={m.id}
              style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
              className={`animate-msg-in group flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {m.role === 'assistant' && (
                <div className="mr-2 mt-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-[11px] font-bold text-white shadow sm:flex">
                  M
                </div>
              )}
              <div className="min-w-0 max-w-[88%] sm:max-w-[78%]">
                <div
                  className={`whitespace-pre-wrap break-words px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm transition-shadow hover:shadow-md sm:px-4 sm:text-sm ${
                    m.role === 'user'
                      ? 'rounded-2xl rounded-br-md bg-gradient-to-br from-indigo-600 to-violet-600 text-white'
                      : m.error
                        ? 'rounded-2xl rounded-bl-md border border-red-200 bg-red-50 text-red-700'
                        : `rounded-2xl rounded-bl-md border bg-white text-slate-800 ${
                            m.streaming
                              ? 'streaming-glow border-indigo-200'
                              : 'border-slate-200'
                          }`
                  }`}
                >
                  {m.content ? (
                    renderRichText(m.content, m.role, m.id)
                  ) : m.streaming ? (
                    <span className="flex items-center gap-1.5 py-0.5">
                      <span className="flex gap-1">
                        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-indigo-500" />
                        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-indigo-500" />
                        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-indigo-500" />
                      </span>
                    </span>
                  ) : null}
                  {m.sources && m.sources.length > 0 && (
                    <details className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
                      <summary className="cursor-pointer font-semibold hover:text-indigo-600">
                        Sources ({m.sources.length})
                      </summary>
                      <ul className="ml-4 mt-1 list-disc space-y-0.5">
                        {m.sources.map((s, idx) => (
                          <li key={idx} className="break-all">
                            {typeof s === 'string' ? s : s.url || s.title || JSON.stringify(s)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                <div
                  className={`mt-1 flex items-center gap-2 px-1 text-[10px] text-slate-400 sm:text-[11px] ${
                    m.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {m.time && <span>{m.time}</span>}
                  {m.role === 'assistant' && m.content && !m.streaming && (
                    <button
                      onClick={() => copyText(m.id, m.content)}
                      className="rounded transition hover:text-indigo-600 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      {copiedId === m.id ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {error && (
            <p className="animate-fade-in rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-center text-xs text-red-600">
              {error}
            </p>
          )}
        </div>

        {/* Suggestions */}
        <div className="no-scrollbar flex gap-2 overflow-x-auto border-t border-slate-100 bg-white px-3 pb-1 pt-2.5 sm:flex-wrap sm:px-4">
          {SUGGESTIONS.map((s, i) => (
            <button
              key={s}
              disabled={isLoading}
              onClick={() => send(s)}
              style={{ animationDelay: `${i * 60}ms` }}
              className="pill animate-msg-in shrink-0 snap-start rounded-full border border-indigo-200 bg-indigo-50/60 px-3 py-1.5 text-xs text-indigo-700 hover:border-indigo-400 hover:bg-indigo-100 hover:text-indigo-800 disabled:cursor-not-allowed disabled:opacity-50 sm:shrink"
            >
              {s}
            </button>
          ))}
        </div>

        {/* Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex items-center gap-2 bg-white p-2.5 sm:gap-2.5 sm:p-4"
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message... (Enter to send)"
            className="min-w-0 flex-1 rounded-2xl border border-slate-300 bg-slate-50 px-3.5 py-3 text-sm text-slate-800 placeholder:text-slate-400 transition focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40 sm:px-4"
          />
          {isLoading ? (
            <button
              type="button"
              onClick={stop}
              className="btn-send flex shrink-0 items-center gap-1.5 rounded-2xl bg-gradient-to-r from-rose-500 to-red-600 px-4 py-3 text-sm font-medium text-white sm:px-5"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
              </span>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send message"
              className="btn-send flex shrink-0 items-center gap-1.5 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none sm:px-5"
            >
              <span className="hidden sm:inline">Send</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </form>
        <p className="hidden bg-white pb-2 text-center text-[10px] text-slate-400 sm:block">
          Mitra AI • Streaming responses • Press Enter to send
        </p>
      </div>
    </div>
  );
}
