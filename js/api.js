/* Работа с API: три семейства провайдеров, прокси, стриминг. Экспорт: window.Api */
(function () {
  'use strict';

  const PRESETS = [
    { name: 'OpenAI', type: 'openai', endpoint: 'https://api.openai.com/v1' },
    { name: 'OpenRouter', type: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
    { name: 'Groq', type: 'openai', endpoint: 'https://api.groq.com/openai/v1' },
    { name: 'DeepSeek', type: 'openai', endpoint: 'https://api.deepseek.com/v1' },
    { name: 'Ollama', type: 'openai', endpoint: 'http://localhost:11434/v1' },
    { name: 'LM Studio', type: 'openai', endpoint: 'http://localhost:1234/v1' },
    { name: 'Anthropic', type: 'anthropic', endpoint: 'https://api.anthropic.com/v1' },
    { name: 'Gemini', type: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
  ];

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status || 0;
    }
  }

  let proxy = false;

  async function detectProxy() {
    if (!/^https?:$/.test(location.protocol)) return (proxy = false);
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      proxy = !!(r.ok && j && j.ok);
    } catch (_) {
      proxy = false;
    }
    return proxy;
  }

  function contentText(value, depth = 0) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((p) => contentText(p, depth + 1)).join('');
    if (value && typeof value === 'object' && depth < 3) {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
      return contentText(value.content, depth + 1);
    }
    return '';
  }

  function errorText(value, depth = 0) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && depth < 4) {
      for (const k of ['message', 'error', 'detail', 'reason', 'description']) {
        if (value[k] != null) {
          const t = errorText(value[k], depth + 1);
          if (t) return t;
        }
      }
      try { return JSON.stringify(value).slice(0, 400); } catch (_) { return ''; }
    }
    return value == null ? '' : String(value);
  }

  /* Одна функция превращает код ответа в понятный текст — и для списка моделей, и для чата. */
  function explain(err) {
    const s = err && err.status;
    const raw = (err && err.message) || '';
    const tail = raw ? ' Ответ сервера: ' + raw.slice(0, 300) : '';
    if (err && err.name === 'AbortError') return 'Запрос остановлен.';
    if (s === 401 || s === 403) return 'Сервер отклонил API key (' + s + '). Проверьте ключ и права доступа.' + tail;
    if (s === 404) return 'Адрес или модель не найдены (404). Проверьте endpoint и id модели.' + tail;
    if (s === 429) return 'Слишком много запросов или закончился лимит (429).' + tail;
    if (s >= 500) return 'Ошибка на стороне сервера (' + s + ').' + tail;
    if (s >= 400) return 'Сервер не принял запрос (' + s + ').' + tail;
    if (!s && /^Не удалось подключиться/.test(raw)) {
      return 'Не удалось подключиться к серверу. Проверьте endpoint и что сервер запущен.';
    }
    if (!s && /failed to fetch|networkerror|load failed/i.test(raw)) {
      return proxy
        ? 'Не удалось подключиться к серверу. Проверьте endpoint.'
        : 'Браузер заблокировал запрос (CORS) или сервер недоступен. Запустите сайт через server.py — тогда запросы пойдут через локальный прокси.';
    }
    return raw || 'Неизвестная ошибка.';
  }

  const base = (cfg) => String(cfg.endpoint || '').trim().replace(/\/+$/, '');

  /* Возможности интерфейса: модель должна знать про интерактивные вопросы и таблицы. */
  const CAPABILITIES = [
    'Интерфейс умеет показывать интерактивные вопросы с выбором ответа. Если тебе нужно уточнить у пользователя',
    'что-то одно из нескольких вариантов, добавь в ответ блок:',
    '',
    '```ask',
    'Твой вопрос одной строкой?',
    '- Вариант 1',
    '- Вариант 2',
    '```',
    '',
    'Первая строка — вопрос, строки, начинающиеся с "-", — варианты. Пользователь нажмёт кнопку, и его ответ придёт',
    'как обычное сообщение. Блок можно ставить в любом месте ответа, в том числе не в конце. Не задавай больше',
    'двух таких вопросов в одном ответе и не оборачивай в этот блок обычный код.',
    'Таблицы оформляй обычным markdown (| столбец | столбец |, затем строка |---|---|) — они отрисуются на странице.',
  ].join('\n');

  const systemText = (cfg) => {
    const own = String(cfg.system || '').trim();
    return own ? own + '\n\n' + CAPABILITIES : CAPABILITIES;
  };

  function headers(cfg) {
    const h = { 'Content-Type': 'application/json' };
    const key = String(cfg.apiKey || '').trim();
    if (cfg.type === 'anthropic') {
      if (key) h['x-api-key'] = key;
      h['anthropic-version'] = '2023-06-01';
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (cfg.type === 'gemini') {
      if (key) h['x-goog-api-key'] = key;
    } else if (key) {
      h.Authorization = 'Bearer ' + key;
    }
    return h;
  }

  /* Обычный (не потоковый) запрос. Возвращает {status, data}. */
  async function request(url, opts, signal) {
    if (proxy) {
      const r = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body }),
        signal,
      });
      const j = await r.json();
      if (j.error) throw new ApiError(errorText(j.error), 0);
      return { status: j.status, data: j.json !== undefined ? j.json : j.text };
    }
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
      signal,
    });
    const text = await r.text();
    let data = text;
    try { data = JSON.parse(text); } catch (_) { /* не JSON */ }
    return { status: r.status, data };
  }

  function parseModels(data) {
    const list = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
    const ids = list
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name || m.model || m.slug)))
      .filter((x) => typeof x === 'string' && x)
      .map((x) => x.replace(/^models\//, ''));
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }

  async function listModels(cfg) {
    if (!base(cfg)) throw new ApiError('Укажите endpoint.', 0);
    const path = cfg.type === 'anthropic' ? '/models?limit=100' : cfg.type === 'gemini' ? '/models?pageSize=200' : '/models';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const res = await request(base(cfg) + path, { method: 'GET', headers: headers(cfg) }, ctl.signal);
      if (res.status >= 400) throw new ApiError(errorText(res.data), res.status);
      return parseModels(res.data);
    } catch (e) {
      if (e.name === 'AbortError') throw new ApiError('Сервер не ответил за 30 секунд.', 0);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Anthropic и Gemini требуют чередования ролей — склеиваем соседние сообщения одной роли. */
  function mergeTurns(messages) {
    const out = [];
    for (const m of messages) {
      const last = out[out.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + m.content;
      else out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  function buildChat(cfg, messages) {
    const sys = systemText(cfg);
    const temp = Number(cfg.temperature);
    const hasTemp = Number.isFinite(temp);
    if (cfg.type === 'anthropic') {
      const body = { model: cfg.model, max_tokens: 4096, messages: mergeTurns(messages), stream: true };
      if (sys) body.system = sys;
      if (hasTemp) body.temperature = Math.min(temp, 1);
      return { url: base(cfg) + '/messages', body };
    }
    if (cfg.type === 'gemini') {
      const body = {
        contents: mergeTurns(messages).map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      };
      if (sys) body.systemInstruction = { parts: [{ text: sys }] };
      if (hasTemp) body.generationConfig = { temperature: temp };
      return { url: base(cfg) + '/models/' + encodeURIComponent(cfg.model) + ':streamGenerateContent?alt=sse', body };
    }
    const body = { model: cfg.model, messages: (sys ? [{ role: 'system', content: sys }] : []).concat(messages), stream: true };
    if (hasTemp) body.temperature = temp;
    return { url: base(cfg) + '/chat/completions', body };
  }

  /* Разбор одного события потока (или целого ответа, если сервер проигнорировал stream). */
  function dispatch(obj, on) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.error) throw new ApiError(errorText(obj.error), obj.error.code > 99 ? obj.error.code : 0);
    if (obj.type === 'error') throw new ApiError(errorText(obj), 0);

    const choice = obj.choices && obj.choices[0];
    if (choice) {
      const d = choice.delta || choice.message || {};
      const think = contentText(d.reasoning_content || d.reasoning || d.thinking);
      if (think) on.reasoning(think);
      const text = contentText(d.content);
      if (text) on.text(text);
      return;
    }
    if (obj.type === 'content_block_delta' && obj.delta) {
      if (obj.delta.type === 'thinking_delta') on.reasoning(contentText(obj.delta.thinking));
      else if (obj.delta.type === 'text_delta') on.text(contentText(obj.delta.text));
      return;
    }
    if (obj.type === 'content_block_start' && obj.content_block) {
      const b = obj.content_block;
      if (b.type === 'thinking' && b.thinking) on.reasoning(contentText(b.thinking));
      else if (b.type === 'text' && b.text) on.text(contentText(b.text));
      return;
    }
    if (obj.type === 'message' && Array.isArray(obj.content)) {
      for (const b of obj.content) {
        if (b.type === 'thinking') on.reasoning(contentText(b.thinking));
        else if (b.type === 'text') on.text(contentText(b.text));
      }
      return;
    }
    const cands = Array.isArray(obj) ? obj : [obj];
    for (const item of cands) {
      const parts = item && item.candidates && item.candidates[0] && item.candidates[0].content && item.candidates[0].content.parts;
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        const t = contentText(p.text);
        if (!t) continue;
        if (p.thought) on.reasoning(t); else on.text(t);
      }
    }
  }

  async function streamChat(cfg, messages, handlers, signal) {
    if (!base(cfg)) throw new ApiError('Укажите endpoint в настройках подключения.', 0);
    if (!String(cfg.model || '').trim()) throw new ApiError('Укажите модель в настройках подключения.', 0);
    const on = {
      text: (t) => { if (t) handlers.onText(String(t)); },
      reasoning: (t) => { if (t && handlers.onReasoning) handlers.onReasoning(String(t)); },
    };
    const { url, body } = buildChat(cfg, messages);
    const h = headers(cfg);

    const resp = proxy
      ? await fetch('/api/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, method: 'POST', headers: h, body }),
          signal,
        })
      : await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal });

    const upstream = Number(resp.headers.get('x-upstream-status')) || resp.status;
    const type = (resp.headers.get('content-type') || '').toLowerCase();

    if (upstream >= 400) {
      const raw = await resp.text();
      let data = raw;
      try { data = JSON.parse(raw); } catch (_) { /* текст */ }
      throw new ApiError(errorText(data), upstream);
    }
    if (type.includes('application/json')) {
      const data = await resp.json();
      if (proxy && data && typeof data.error === 'string' && !data.choices) throw new ApiError(data.error, 0);
      dispatch(data, on);
      return;
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    const feed = (line) => {
      line = line.replace(/\r$/, '');
      if (!line.startsWith('data:')) return false;
      const payload = line.slice(5).trim();
      if (!payload) return false;
      if (payload === '[DONE]') return true;
      let obj;
      try { obj = JSON.parse(payload); } catch (_) { return false; }
      dispatch(obj, on);
      return false;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (feed(line)) { reader.cancel().catch(() => {}); return; }
      }
    }
    buf += dec.decode();
    if (buf) feed(buf);
  }

  window.Api = {
    PRESETS, ApiError, detectProxy, listModels, streamChat, explain, contentText, errorText,
    get proxy() { return proxy; },
  };
})();
