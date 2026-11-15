/* Окно «Настройки»: вкладка подключения (тип API, endpoint, ключ, модель) и
   вкладка оформления (тема, показ скорости). Экспорт: window.Settings */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const dlg = $('settings');
  const el = {
    type: $('apiType'), endpoint: $('endpoint'), key: $('apiKey'), toggleKey: $('toggleKey'),
    model: $('model'), fetch: $('fetchModels'), list: $('modelList'), note: $('modelNote'),
    system: $('system'), temp: $('temp'), tempOut: $('tempOut'),
    test: $('testBtn'), result: $('testResult'), presets: $('presets'), form: $('settingsForm'),
    tabs: $('settingsTabs'), tabConn: $('tabConn'), tabLook: $('tabLook'),
    themes: $('themes'), showSpeed: $('showSpeed'),
  };

  let type = 'openai';
  let models = [];
  let token = 0; // защита от устаревших ответов: каждый запрос помнит свой номер
  let onSave = () => {};
  let onTheme = () => {};

  function setType(next) {
    type = next;
    el.type.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.type === type)));
  }

  function syncTheme(name) {
    if (!el.themes) return;
    el.themes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === name)));
  }

  function showTab(name) {
    const tab = name === 'look' ? 'look' : 'conn';
    el.tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    el.tabConn.hidden = tab !== 'conn';
    el.tabLook.hidden = tab !== 'look';
    /* Каждая вкладка открывается с начала, а не с позиции прокрутки прошлой. */
    el[tab === 'look' ? 'tabLook' : 'tabConn'].scrollTop = 0;
    /* Кнопка «Проверить» относится к подключению — на вкладке темы она лишняя. */
    el.test.style.visibility = tab === 'conn' ? 'visible' : 'hidden';
    if (tab === 'look') el.result.textContent = '';
  }

  function draft() {
    return {
      type,
      endpoint: el.endpoint.value.trim(),
      apiKey: el.key.value,
      model: el.model.value.trim(),
      system: el.system.value,
      temperature: Number(el.temp.value),
    };
  }

  function note(text, isError) {
    el.note.textContent = text || '';
    el.note.classList.toggle('err', !!isError);
  }
  function result(text, kind) {
    el.result.textContent = text || '';
    el.result.className = 'test' + (kind ? ' ' + kind : '');
  }

  function renderList() {
    if (!models.length) { el.list.hidden = true; return; }
    const q = el.model.value.trim().toLowerCase();
    const exact = models.includes(el.model.value.trim());
    const shown = exact || !q ? models : models.filter((m) => m.toLowerCase().includes(q));
    el.list.hidden = false;
    el.list.textContent = '';
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'В списке такой модели нет — будет использован введённый id.';
      el.list.appendChild(empty);
      return;
    }
    for (const id of shown) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(id === el.model.value.trim()));
      b.textContent = id;
      b.title = id;
      b.addEventListener('click', () => { el.model.value = id; renderList(); });
      el.list.appendChild(b);
    }
    const selected = el.list.querySelector('[aria-selected="true"]');
    if (selected) el.list.scrollTop = Math.max(0, selected.offsetTop - 60);
  }

  async function loadModels() {
    const my = ++token;
    el.fetch.disabled = true;
    el.fetch.textContent = 'Загрузка…';
    note('');
    try {
      const found = await Api.listModels(draft());
      if (my !== token || !dlg.open) return;
      models = found;
      note(found.length ? 'Найдено моделей: ' + found.length + '.' : 'Сервер вернул пустой список — введите id модели вручную.');
      renderList();
    } catch (e) {
      if (my !== token || !dlg.open) return;
      note(Api.explain(e) + ' Id модели можно ввести вручную.', true);
    } finally {
      if (my === token) {
        el.fetch.disabled = false;
        el.fetch.textContent = 'Загрузить список';
      }
    }
  }

  /* Проверка: короткий настоящий запрос к модели с теми же настройками, что и в чате. */
  async function test() {
    const cfg = draft();
    if (!cfg.endpoint) { result('Укажите endpoint.', 'err'); el.endpoint.focus(); return; }
    if (!cfg.model) { result('Укажите модель.', 'err'); el.model.focus(); return; }
    const my = ++token;
    el.test.disabled = true;
    result('Отправляю тестовый запрос…');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    let got = '';
    try {
      await Api.streamChat(cfg, [{ role: 'user', content: 'Ответь одним словом: привет' }], {
        onText: (t) => { got += t; },
        onReasoning: (t) => { got += t; },
      }, ctl.signal);
      if (my !== token || !dlg.open) return;
      if (got.trim()) result('Работает: модель ответила.', 'ok');
      else result('Сервер ответил без текста. Проверьте id модели.', 'err');
    } catch (e) {
      if (my !== token || !dlg.open) return;
      result(e.name === 'AbortError' ? 'Сервер не ответил за 45 секунд.' : Api.explain(e), 'err');
    } finally {
      clearTimeout(timer);
      el.test.disabled = false;
    }
  }

  function open(tab) {
    const cfg = Store.cfg;
    token++;
    setType(cfg.type || 'openai');
    el.endpoint.value = cfg.endpoint || '';
    el.key.value = cfg.apiKey || '';
    el.key.type = 'password';
    el.toggleKey.textContent = 'Показать';
    el.model.value = cfg.model || '';
    el.system.value = cfg.system || '';
    el.temp.value = String(cfg.temperature == null ? 0.7 : cfg.temperature);
    el.tempOut.textContent = Number(el.temp.value).toFixed(1);
    syncTheme(Store.theme);
    el.showSpeed.checked = Store.ui.showSpeed !== false;
    models = [];
    el.list.hidden = true;
    note('');
    result('');
    showTab(tab || 'conn');
    if (!dlg.open) dlg.showModal();
    if (!tab || tab === 'conn') (cfg.endpoint ? el.model : el.endpoint).focus();
  }

  function close() { token++; if (dlg.open) dlg.close(); }

  for (const p of Api.PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name;
    b.title = p.endpoint;
    b.addEventListener('click', () => {
      el.endpoint.value = p.endpoint;
      setType(p.type);
      models = [];
      el.list.hidden = true;
      note('');
      result('');
    });
    el.presets.appendChild(b);
  }

  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  el.type.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (b) { setType(b.dataset.type); result(''); }
  });
  el.themes.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (!b) return;
    syncTheme(b.dataset.theme);
    onTheme(b.dataset.theme);
  });
  el.showSpeed.addEventListener('change', () => {
    Store.ui.showSpeed = el.showSpeed.checked;
    Store.saveUi();
  });
  el.toggleKey.addEventListener('click', () => {
    const show = el.key.type === 'password';
    el.key.type = show ? 'text' : 'password';
    el.toggleKey.textContent = show ? 'Скрыть' : 'Показать';
  });
  el.temp.addEventListener('input', () => { el.tempOut.textContent = Number(el.temp.value).toFixed(1); });
  el.model.addEventListener('input', renderList);
  el.fetch.addEventListener('click', loadModels);
  el.test.addEventListener('click', test);
  $('closeSettings').addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('close', () => { token++; });

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cfg = draft();
    if (!cfg.endpoint) { showTab('conn'); result('Укажите endpoint.', 'err'); el.endpoint.focus(); return; }
    if (!/^https?:\/\//i.test(cfg.endpoint)) { showTab('conn'); result('Endpoint должен начинаться с http:// или https://', 'err'); el.endpoint.focus(); return; }
    if (!cfg.model) { showTab('conn'); result('Укажите модель.', 'err'); el.model.focus(); return; }
    Object.assign(Store.cfg, cfg);
    Store.ui.showSpeed = el.showSpeed.checked;
    Store.saveUi();
    const stored = Store.saveCfg();
    close();
    onSave(stored);
  });

  window.Settings = {
    open, close, syncTheme,
    set onSave(fn) { onSave = fn; },
    set onTheme(fn) { onTheme = fn; },
  };
})();
