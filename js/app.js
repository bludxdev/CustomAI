/* Чат: список, лента, отправка и стриминг ответа. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const box = $('messages');
  const input = $('input');
  const sendBtn = $('send');
  const scroll = Render.scroller(box);

  const STARTERS = [
    'Объясни простыми словами, как работает нейросеть',
    'Сравни Python и JavaScript в таблице',
    'Придумай план изучения Python на месяц — и спроси меня, с чего начать',
  ];

  let stream = null; // {chatId, msgId, controller}
  let draftText = '';
  let toastTimer = 0;

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function copy(text, okText) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okText || 'Скопировано');
    } catch (_) {
      toast('Не удалось скопировать — выделите текст вручную');
    }
  }

  /* ---------- Тема ---------- */
  const THEME_NAMES = { dark: 'Тёмная', black: 'Black', oled: 'OLED', light: 'Белая' };

  function applyTheme() {
    document.documentElement.dataset.theme = Store.theme;
  }

  function setTheme(name) {
    if (!Store.THEMES.includes(name)) return;
    Store.theme = name;
    Store.saveTheme();
    applyTheme();
    Settings.syncTheme(name);
  }

  function renderMode() {
    const m = $('mode');
    m.className = 'mode ' + (Api.proxy ? 'on' : 'off');
    m.querySelector('span').textContent = Api.proxy ? 'локальный прокси активен' : 'без прокси · возможен CORS';
    m.title = Api.proxy
      ? 'Запросы идут через server.py, ограничения CORS не мешают'
      : 'Запросы идут прямо из браузера. Если провайдер их блокирует, запустите server.py';
  }

  /* ---------- Шапка и список чатов ---------- */
  function renderHead() {
    const chat = Store.active();
    $('chatTitle').textContent = chat && chat.messages.length ? chat.title : 'Новый чат';
    const chip = $('modelChip');
    chip.textContent = '';
    const span = document.createElement('span');
    span.textContent = Store.ready() ? Store.cfg.model : 'Подключить API';
    chip.appendChild(span);
    chip.title = Store.ready()
      ? 'Модель: ' + Store.cfg.model + ' · модель: ' + THEME_NAMES[Store.theme] + ' — открыть настройки'
      : 'Настройки подключения';
    chip.classList.toggle('unset', !Store.ready());
  }

  function renderChats() {
    const nav = $('chatList');
    nav.textContent = '';
    const items = Store.listed();
    if (!items.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'Здесь появятся ваши чаты';
      nav.appendChild(none);
      return;
    }
    for (const chat of items) {
      const row = document.createElement('div');
      row.className = 'chat-item' + (chat.id === Store.activeId ? ' active' : '');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      open.textContent = chat.title;
      open.title = chat.title;
      open.addEventListener('click', () => selectChat(chat.id));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn del';
      del.setAttribute('aria-label', 'Удалить чат «' + chat.title + '»');
      del.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3 3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      del.addEventListener('click', () => deleteChat(chat.id));
      row.append(open, del);
      nav.appendChild(row);
    }
  }

  /* ---------- Лента ---------- */
  function thinkBlock(m, live) {
    const d = document.createElement('details');
    d.className = 'think';
    d.open = !!live;
    const s = document.createElement('summary');
    if (live) {
      const sp = document.createElement('i');
      sp.className = 'spin';
      s.appendChild(sp);
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = live ? 'Думает…' : 'Рассуждение' + (m.thinkMs ? ' · ' + Math.max(1, Math.round(m.thinkMs / 1000)) + ' с' : '');
    s.appendChild(label);
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = m.reasoning || '';
    d.append(s, text);
    return d;
  }

  function speedBadge(m) {
    if (!Store.ui.showSpeed || !m.tps) return null;
    const el = document.createElement('span');
    el.className = 'speed done';
    el.textContent = m.tps.toFixed(1) + ' ток/с · ' + Math.round(m.tokens || 0) + ' ток';
    el.title = 'Средняя скорость генерации: ' + m.tps.toFixed(1) + ' токенов в секунду. '
      + 'Токены посчитаны приблизительно (около 2 символов кириллицы или 4 латиницы на токен).';
    return el;
  }

  function actions(m) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const c = document.createElement('button');
    c.type = 'button';
    c.textContent = 'Копировать';
    c.addEventListener('click', () => copy(m.content, 'Ответ скопирован'));
    bar.appendChild(c);
    const speed = speedBadge(m);
    if (speed) bar.appendChild(speed);
    return bar;
  }

  function renderMessage(m) {
    const wrap = document.createElement('article');
    wrap.className = 'msg ' + m.role;
    wrap.dataset.id = m.id;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = m.role === 'user' ? 'Вы' : (m.model || 'Нейросеть');
    wrap.appendChild(who);

    if (m.role === 'user') {
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = m.content;
      wrap.appendChild(body);
      return wrap;
    }
    if (m.reasoning) wrap.appendChild(thinkBlock(m, false));
    if (m.content) {
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = Render.markdown(m.content, m.picks);
      wrap.appendChild(body);
    }
    if (m.status === 'error') {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = m.error || 'Не удалось получить ответ.';
      wrap.appendChild(err);
    } else if (m.content) {
      wrap.appendChild(actions(m));
    }
    return wrap;
  }

  function renderEmpty() {
    const e = document.createElement('div');
    e.className = 'empty';
    const h = document.createElement('h2');
    const p = document.createElement('p');
    e.append(h, p);
    if (!Store.ready()) {
      h.innerHTML = 'Подключите свою <em>нейросеть</em>';
      p.textContent = 'Укажите endpoint, API key и модель. Подойдёт любой сервис с OpenAI-совместимым API, а также Anthropic и Gemini.';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-primary';
      b.textContent = 'Настроить подключение';
      b.addEventListener('click', () => Settings.open('conn'));
      e.appendChild(b);
      return e;
    }
    h.innerHTML = 'О чём <em>поговорим?</em>';
    p.textContent = 'Напишите сообщение ниже или начните с одного из вопросов.';
    const list = document.createElement('div');
    list.className = 'starters';
    for (const text of STARTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => send(text));
      list.appendChild(b);
    }
    e.appendChild(list);
    return e;
  }

  function renderThread() {
    scroll.cancel();
    const chat = Store.active();
    box.textContent = '';
    if (!chat || !chat.messages.length) {
      box.appendChild(renderEmpty());
      return;
    }
    const thread = document.createElement('div');
    thread.className = 'thread';
    thread.id = 'thread';
    chat.messages.forEach((m) => thread.appendChild(renderMessage(m)));
    box.appendChild(thread);
    scroll.pin(true);
  }

  /* Свежая пара сообщений въезжает с подъёмом и расфокусом. */
  function markEnter(...ids) {
    for (const id of ids) {
      const el = box.querySelector('[data-id="' + id + '"]');
      if (el) el.classList.add('enter');
    }
  }

  function renderAll() {
    renderHead();
    renderChats();
    renderThread();
    syncComposer();
  }

  /* ---------- Поле ввода ---------- */
  function capInput() {
    /* На телефоне строка ввода не должна съедать ленту: предел в долях экрана. */
    const vh = window.innerHeight || 800;
    return Math.max(120, Math.min(220, Math.round(vh * 0.32)));
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, capInput()) + 'px';
  }
  /* Поворот экрана и появление клавиатуры меняют доступную высоту. */
  window.addEventListener('resize', () => { autosize(); });
  window.addEventListener('orientationchange', () => setTimeout(autosize, 120));
  function syncComposer() {
    const busy = !!stream;
    sendBtn.classList.toggle('busy', busy);
    sendBtn.setAttribute('aria-label', busy ? 'Остановить ответ' : 'Отправить');
    sendBtn.disabled = !busy && !input.value.trim();
    /* Счётчик скорости живёт ровно столько, сколько идёт генерация. */
    $('speed').classList.toggle('on', busy && Store.ui.showSpeed);
  }

  /* ---------- Действия ---------- */
  function closeSide() { app.classList.remove('side-open'); }

  function stop() { if (stream) stream.controller.abort(); }

  function selectChat(id) {
    if (id === Store.activeId) { closeSide(); return; }
    stop();
    Store.activeId = id;
    Store.saveChats();
    closeSide();
    renderAll();
  }

  function newChat() {
    stop();
    Store.newChat();
    closeSide();
    renderAll();
    input.focus();
  }

  function deleteChat(id) {
    const chat = Store.chats.find((c) => c.id === id);
    if (!chat || !window.confirm('Удалить чат «' + chat.title + '»? Восстановить его не получится.')) return;
    if (stream && stream.chatId === id) stop();
    Store.remove(id);
    if (!Store.active()) Store.newChat();
    renderAll();
  }

  function history(chat, uptoId) {
    const out = [];
    for (const m of chat.messages) {
      if (m.id === uptoId) break;
      if (m.status === 'error' || !String(m.content || '').trim()) continue;
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  /* Клик по варианту ответа внутри сообщения модели. */
  function pickAnswer(btn) {
    const askEl = btn.closest('.ask');
    const article = btn.closest('.msg');
    const chat = Store.active();
    if (!askEl || !article || !chat) return;
    const msg = chat.messages.find((m) => m.id === article.dataset.id);
    if (!msg) return;
    const index = Number(askEl.dataset.ask || 0);
    const value = btn.dataset.value || btn.textContent.trim();

    msg.picks = msg.picks || {};
    if (msg.picks[index] != null) return;
    msg.picks[index] = value;
    chat.updated = Date.now();
    Store.saveChats();

    /* Заменяем только этот блок — остальной ответ остаётся на месте. */
    const all = Array.from(article.querySelectorAll('.ask'));
    msg.content = msg.content || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = Render.markdown(msg.content, msg.picks);
    const fresh = tmp.querySelector('.ask[data-ask="' + index + '"]');
    if (fresh) askEl.replaceWith(fresh);
    if (!all.length) return;

    /* Если модель всё ещё пишет этот ответ — останавливаем и продолжаем диалог. */
    const busy = stream && stream.msgId === msg.id;
    send(value, { fromPick: true, stopStream: busy });
  }

  async function send(text, opts) {
    const o = opts || {};
    text = String(text == null ? input.value : text).trim();
    if (!text || (stream && !o.stopStream)) return;
    if (!Store.ready()) {
      toast('Сначала настройте подключение');
      Settings.open('conn');
      return;
    }
    const chat = Store.active() || Store.newChat();
    if (o.stopStream && stream) {
      const ctl = stream.controller;
      stream = null;
      ctl.abort();
    }
    const first = !chat.messages.length;
    const user = { id: Store.uid(), role: 'user', content: text };
    const bot = { id: Store.uid(), role: 'assistant', content: '', reasoning: '', status: 'streaming', model: Store.cfg.model };
    chat.messages.push(user, bot);
    if (first) chat.title = text.replace(/\s+/g, ' ').slice(0, 48) + (text.length > 48 ? '…' : '');
    chat.updated = Date.now();
    Store.saveChats();

    input.value = '';
    draftText = '';
    autosize();

    const controller = new AbortController();
    stream = { chatId: chat.id, msgId: bot.id, controller };
    renderAll();
    markEnter(user.id, bot.id);

    /* Живой узел ответа строится поверх уже отрисованного сообщения. */
    const node = box.querySelector('[data-id="' + bot.id + '"]');
    const body = document.createElement('div');
    body.className = 'body';
    node.appendChild(body);
    const writer = Render.liveWriter(body, bot.picks);
    let think = null;
    let thinkStart = 0;
    const alive = () => stream && stream.msgId === bot.id && Store.activeId === chat.id && node.isConnected;

    /* --- Счётчик скорости ---------------------------------------------------
       Токены считаем оценкой по символам, время — от первого куска текста
       до текущего момента, поэтому цифра перестаёт «прыгать» после первых
       секунд и показывает среднюю скорость по всему ответу. Живая цифра
       живёт в подписи под полем ввода; в сообщении остаётся итоговая. */
    const speedEl = $('speed');
    const paintSpeed = (tps) => {
      speedEl.innerHTML = tps == null ? '<b>0.0</b>&nbsp;ток/с' : '<b>' + tps.toFixed(1) + '</b>&nbsp;ток/с';
    };

    const meter = Store.ui.showSpeed ? (() => {
      const started = { at: performance.now() };
      let timer = 0;
      const tick = () => {
        const secs = (performance.now() - started.at) / 1000;
        const tk = Render.tokens(bot.content);
        if (secs > 0.25 && tk > 0) {
          paintSpeed(tk / secs);
          bot.tps = tk / secs;
          bot.tokens = Math.round(tk);
        }
      };
      paintSpeed(null);
      timer = setInterval(tick, 220);
      return {
        stop() {
          clearInterval(timer);
          tick();
        },
      };
    })() : null;

    const endThinking = () => {
      if (!thinkStart || bot.thinkMs) return;
      bot.thinkMs = Date.now() - thinkStart;
      if (think && alive()) {
        const fresh = thinkBlock(bot, false);
        think.replaceWith(fresh);
        think = fresh;
      }
    };

    try {
      await Api.streamChat(Store.cfg, history(chat, bot.id), {
        onReasoning(t) {
          bot.reasoning += t;
          if (!thinkStart) thinkStart = Date.now();
          if (!alive()) return;
          if (!think) {
            think = thinkBlock(bot, true);
            node.insertBefore(think, body);
          } else {
            think.querySelector('.text').textContent = bot.reasoning;
          }
          scroll.pin();
        },
        onText(t) {
          endThinking();
          bot.content += t;
          if (!alive()) return;
          writer.push(t);
          scroll.pin();
        },
      }, controller.signal);
      endThinking();
      bot.status = 'done';
      if (!bot.content.trim()) {
        bot.status = 'error';
        bot.error = 'Сервер вернул пустой ответ. Проверьте id модели в настройках подключения.';
      }
    } catch (e) {
      endThinking();
      if (e.name === 'AbortError') {
        bot.status = 'done'; // остановлено пользователем: частичный текст остаётся
        if (!bot.content.trim() && !bot.reasoning) chat.messages = chat.messages.filter((m) => m.id !== bot.id);
      } else {
        bot.status = 'error';
        bot.error = Api.explain(e);
      }
    } finally {
      if (meter) meter.stop();
      if (stream && stream.msgId === bot.id) stream = null;
      chat.updated = Date.now();
      Store.saveChats();
      if (Store.activeId === chat.id && node.isConnected) {
        const stillThere = chat.messages.some((m) => m.id === bot.id);
        if (stillThere) {
          const fresh = renderMessage(bot);
          node.replaceWith(fresh);
          bindPicks(fresh);
        } else node.remove();
        scroll.pin();
      }
      renderChats();
      renderHead();
      syncComposer();
    }
  }

  /* Варианты ответа активны и в готовом сообщении; ловим их делегированием. */
  function bindPicks(root) {
    root.querySelectorAll('.ask[data-pending]').forEach((el) => el.removeAttribute('data-pending'));
  }

  /* ---------- События ---------- */
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (stream) stop(); else send();
  });
  input.addEventListener('input', () => { draftText = input.value; autosize(); syncComposer(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!stream) send();
    }
  });
  box.addEventListener('click', (e) => {
    const pick = e.target.closest('.ask-opt');
    if (pick) { pickAnswer(pick); return; }
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const code = b.closest('.codeblock').querySelector('code');
    copy(code.textContent, 'Код скопирован');
  });
  $('newChat').addEventListener('click', newChat);
  $('openSettings').addEventListener('click', () => { closeSide(); Settings.open(); });
  $('modelChip').addEventListener('click', () => Settings.open());
  $('menuBtn').addEventListener('click', () => app.classList.toggle('side-open'));
  $('scrim').addEventListener('click', closeSide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSide(); });

  Settings.onSave = (stored) => {
    toast(stored ? 'Настройки сохранены' : 'Настройки применены, но браузер не дал их сохранить');
    applyTheme();
    renderAll();
    input.value = draftText;
    autosize();
    syncComposer();
    input.focus();
  };
  Settings.onTheme = (name) => setTheme(name);

  /* ---------- Запуск ---------- */
  applyTheme();
  renderAll();
  renderMode();
  Api.detectProxy().then(() => { renderMode(); });
  if (Store.ready()) input.focus();
})();
