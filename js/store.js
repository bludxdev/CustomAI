/* Состояние и хранение в localStorage. Экспорт: window.Store */
(function () {
  'use strict';

  const KEY = { cfg: 'siteai.cfg', chats: 'siteai.chats', active: 'siteai.active', theme: 'siteai.theme', ui: 'siteai.ui' };
  const DEFAULT_CFG = { type: 'openai', endpoint: '', apiKey: '', model: '', system: '', temperature: 0.7 };
  const THEMES = ['dark', 'black', 'oled', 'light'];

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const Store = {
    cfg: Object.assign({}, DEFAULT_CFG, read(KEY.cfg, {})),
    chats: [],
    activeId: null,
    theme: THEMES.includes(read(KEY.theme, 'dark')) ? read(KEY.theme, 'dark') : 'dark',
    ui: Object.assign({ showSpeed: true }, read(KEY.ui, {})),
    THEMES,
    uid,

    saveCfg() { return write(KEY.cfg, this.cfg); },
    saveTheme() { return write(KEY.theme, this.theme); },
    saveUi() { return write(KEY.ui, this.ui); },
    /* Пустые черновики в хранилище не попадают. */
    saveChats() {
      const kept = this.chats.filter((c) => c.messages.length);
      write(KEY.active, this.activeId);
      return write(KEY.chats, kept);
    },

    ready() { return !!(String(this.cfg.endpoint).trim() && String(this.cfg.model).trim()); },
    active() { return this.chats.find((c) => c.id === this.activeId) || null; },
    listed() { return this.chats.filter((c) => c.messages.length).sort((a, b) => b.updated - a.updated); },

    newChat() {
      const draft = this.chats.find((c) => !c.messages.length);
      const chat = draft || { id: uid(), title: 'Новый чат', messages: [], updated: Date.now() };
      if (!draft) this.chats.push(chat);
      this.activeId = chat.id;
      return chat;
    },
    remove(id) {
      this.chats = this.chats.filter((c) => c.id !== id);
      if (this.activeId === id) this.activeId = null;
      this.saveChats();
    },
  };

  const saved = read(KEY.chats, []);
  if (Array.isArray(saved)) {
    Store.chats = saved
      .filter((c) => c && c.id && Array.isArray(c.messages))
      .map((c) => {
        /* Ответ, оборванный перезагрузкой страницы, остаётся как есть — без «вечного» курсора. */
        c.messages = c.messages.filter((m) => m && m.role).map((m) => {
          if (m.status === 'streaming') m.status = 'done';
          return m;
        });
        return c;
      });
  }
  const last = read(KEY.active, null);
  if (last && Store.chats.some((c) => c.id === last)) Store.activeId = last;
  if (!Store.active()) Store.newChat();

  window.Store = Store;
})();
