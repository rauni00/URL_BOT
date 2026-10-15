/**
 * Mitra AI — answer_stream SSE client (backend: api.ultimabot.ai)
 *
 * API format (verified):
 * GET https://api.ultimabot.ai/bot/answer_stream?session=XXX&query=YYY
 *
 * Response is Server-Sent Events:
 *   id: 1
 *   data: {"content":"Hi"}
 *
 *   id: 2
 *   data: {"content":" there"}
 *   ...
 *   data: {"content":"","sources":[]}
 *   data: [DONE]
 */

export const DEFAULT_API_BASE = 'https://api.ultimabot.ai/bot/answer_stream';
export const DEFAULT_SESSION = '6a5fa21fd88b1a3dd2c91b01';

export function buildStreamUrl({ baseUrl = DEFAULT_API_BASE, session, query }) {
  const url = new URL(baseUrl);
  url.searchParams.set('session', session);
  url.searchParams.set('query', query);
  return url.toString();
}

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newSessionId() {
  // 24 hex chars like example session
  let s = '';
  const hex = '0123456789abcdef';
  for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

/**
 * Stream chat completion.
 * @param {Object} opts
 * @param {string} opts.query
 * @param {string} opts.session
 * @param {string} opts.baseUrl
 * @param {AbortSignal} opts.signal
 * @param {(token:string)=>void} opts.onToken
 * @param {(sources:any[])=>void} opts.onSources
 * @returns {Promise<{fullText:string, sources:any[]}>}
 */
export async function streamChat({ query, session, baseUrl = DEFAULT_API_BASE, signal, onToken, onSources }) {
  const url = buildStreamUrl({ baseUrl, session, query });

  const res = await fetch(url, {
    method: 'GET',
    signal,
    headers: {
      Accept: 'text/event-stream',
    },
  });

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error('Streaming not supported in this browser');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let sources = [];

  const processEventBlock = (block) => {
    // block like: "id: 5\ndata: {\"content\":\" Hi\"}"
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;
      if (dataStr === '[DONE]') {
        return 'DONE';
      }
      try {
        const json = JSON.parse(dataStr);
        if (typeof json.content === 'string' && json.content) {
          fullText += json.content;
          onToken?.(json.content);
        }
        if (Array.isArray(json.sources)) {
          sources = json.sources;
          onSources?.(sources);
        }
      } catch {
        // ignore partial JSON, will come in next chunk normally complete
      }
    }
    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events separated by blank line (\n\n)
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const result = processEventBlock(block);
      if (result === 'DONE') {
        // drain cancelled? just finish
        try { reader.cancel(); } catch {}
        return { fullText, sources };
      }
    }
  }

  // leftover buffer (in case stream didn't end with \n\n)
  if (buffer.trim()) {
    processEventBlock(buffer);
  }

  return { fullText, sources };
}

export { randomId };
