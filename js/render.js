/* Markdown -> безопасный HTML, живой вывод, вопросы с выбором, плавная прокрутка.
   Экспорт: window.Render */
(function () {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(src) {
    const codes = [];
    let s = src.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[+i]) + '</code>');
  }

  /* Таблицы: | a | b | + строка-разделитель |---|---| */
  const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  /* --- Вопросы с выбором ответа -------------------------------------------
     Модель пишет блок:

         ```ask
         Какой вариант ближе?
         - Первый
         - Второй
         ```

     Строки до списка — вопрос, пункты списка — варианты ответа.
     Кнопки работают сразу: даже пока ответ ещё печатается (незакрытый блок),
     выбрать вариант можно, не дожидаясь конца генерации. */
  function parseAsk(lines) {
    const q = [];
    const opts = [];
    for (const l of lines) {
      const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) { if (m[1].trim()) opts.push(m[1].trim()); }
      else if (l.trim() && !opts.length) q.push(l.trim());
    }
    return { q: q.join(' ') || 'Выберите вариант', opts };
  }

  function askHtml(a, index, closed, picks) {
    const options = a.opts.length ? a.opts : ['Да', 'Нет'];
    const picked = picks ? picks[index] : undefined;
    return '<div class="ask" data-ask="' + index + '"' + (closed ? '' : ' data-pending') + '>' +
      '<p class="ask-q">' + inline(a.q) + '</p>' +
      '<div class="ask-opts">' +
      options.map((o, k) => {
        const value = o.replace(/[*`~]/g, '');
        const on = picked != null && picked === value;
        /* Пока блок не закрыт, последний вариант может быть ещё не дописан —
           его не даём нажать, остальные работают уже во время генерации. */
        const partial = !closed && k === options.length - 1;
        return '<button type="button" class="ask-opt" data-value="' + esc(value) + '"' +
          (on ? ' data-picked="true"' : '') + (picked != null || partial ? ' disabled' : '') + '>' + inline(o) + '</button>';
      }).join('') +
      '</div></div>';
  }

  const markdown = (text, picks) => blocks(text, picks).join('');

  /* Каждый элемент массива — ровно один блочный HTML-элемент. */
  function blocks(text, picks) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null;
    let askIndex = 0;
    const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushList = () => { if (list) { out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
    const flush = () => { flushPara(); flushList(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (fence) {
        const isAsk = fence[1].toLowerCase() === 'ask';
        const code = [];
        let j = i + 1;
        let closed = false;
        while (j < lines.length) {
          if (/^\s*```\s*$/.test(lines[j])) { closed = true; break; }
          code.push(lines[j++]);
        }
        flush();
        i = closed ? j : j - 1;
        if (isAsk) { out.push(askHtml(parseAsk(code), askIndex++, closed, picks)); continue; }
        out.push('<div class="codeblock"><header><span>' + esc(fence[1] || 'код') + '</span>' +
          '<button type="button" data-copy>Копировать</button></header><pre><code>' + esc(code.join('\n')) + '</code></pre></div>');
        continue;
      }
      if (!line.trim()) { flush(); continue; }

      /* Таблица */
      if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && SEP.test(lines[i + 1])) {
        flush();
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
        i--;
        const cell = (tag, c, k) => '<' + tag + (align[k] ? ' style="text-align:' + align[k] + '"' : '') + '>' + inline(c || '') + '</' + tag + '>';
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k], k)).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { flush(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
      const q = line.match(/^>\s?(.*)$/);
      if (q) { flush(); out.push('<blockquote>' + inline(q[1]) + '</blockquote>'); continue; }
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
        continue;
      }
      flushList();
      para.push(line);
    }
    flush();
    return out;
  }

  /* Оценка числа токенов: кириллица ≈ 2 символа на токен, латиница ≈ 4, прочее ≈ 3.
     Точный счётчик знает только провайдер; для показа скорости оценки хватает. */
  function tokens(text) {
    let cyr = 0, word = 0, other = 0;
    for (const ch of String(text || '')) {
      if (/[а-яёА-ЯЁ]/.test(ch)) cyr++;
      else if (/[A-Za-z0-9_]/.test(ch)) word++;
      else other++;
    }
    return cyr / 2 + word / 4 + other / 3;
  }

  /* Плавное появление свежих символов: последние n символов последнего блока
     оборачиваются в span.in и мягко проявляются из блюра. Так стриминг
     читается как живое письмо, а не как рывки по словам. Внутрь кода,
     таблиц и виджетов не лезем. */
  const NO_FADE = /^(PRE|CODE|TABLE|THEAD|TBODY|TR|SVG|BUTTON)$/;
  function fadeTail(root, n) {
    if (!n || n < 1) return;
    /* Ищем последний текстовый узел в глубине блока. */
    let target = null;
    const walk = (node) => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === 3) { if ((c.nodeValue || '').trim()) target = c; }
        else if (c.nodeType === 1 && !NO_FADE.test(c.tagName)) walk(c);
      }
    };
    walk(root);
    if (!target) return;

    const full = target.nodeValue;
    const cut = Math.min(n, full.length);
    const span = document.createElement('span');
    span.className = 'in';
    span.textContent = full.slice(-cut);
    target.nodeValue = full.slice(0, full.length - cut);
    target.parentNode.insertBefore(span, target.nextSibling);
  }

  /* Куда поставить курсор стрима: последняя текстовая ячейка блока.
     Возвращает null, если печатать некуда (например, блок ввода кода). */
  function caretSlot(root) {
    if (!root) return null;
    if (root.tagName === 'PRE') {
      const code = root.querySelector('code') || root;
      return /^(CODE|PRE)$/.test(code.tagName) ? code : null;
    }
    const container = root.querySelector('table') || root;
    let slot = null;
    const walk = (n) => {
      for (let i = 0; i < n.childNodes.length; i++) {
        const c = n.childNodes[i];
        if (c.nodeType === 3) { if ((c.nodeValue || '').trim()) slot = n; }
        else if (c.nodeType === 1 && !/^(BUTTON|SVG|PRE)$/.test(c.tagName)) walk(c);
      }
    };
    walk(container);
    return slot || (/^(P|LI|H1|H2|H3|H4|BLOCKQUOTE|TD|TH|DIV)$/.test(root.tagName) ? root : null);
  }

  /* Кадры. Шаг перерисовки близок к длительности фейда (.in, 0.16s):
     к следующему кадру хвост почти проявился, поэтому символы не мигают
     повторно, а «живой край» текста остаётся мягким. */
  const FRAME = 140;
  const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function liveWriter(node, picks) {
    node.classList.add('live');
    node.textContent = '';
    let text = '';
    let painted = '';
    let timer = 0;
    let prev = [];
    let added = 0;
    let caret = null;

    const paint = () => {
      timer = 0;
      if (text === painted) return;
      const fresh = Math.min(added, 48);
      const grew = text.length - painted.length;
      painted = text;
      added = 0;

      const htmls = blocks(text, picks);
      /* Общий префикс неизменных блоков — его не трогаем, чтобы не мигало. */
      let keep = 0;
      while (keep < prev.length && keep < htmls.length && prev[keep] === htmls[keep]) keep++;
      const known = prev.length;
      while (node.children.length > keep) node.lastElementChild.remove();

      const tmp = document.createElement('div');
      let lastNew = false;
      for (let i = keep; i < htmls.length; i++) {
        tmp.innerHTML = htmls[i];
        const el = tmp.firstElementChild;
        if (!el) continue;
        const isNew = i >= known;
        const isLast = i === htmls.length - 1;
        if (isLast) lastNew = isNew;
        /* Законченный новый блок въезжает с подъёмом и расфокусом один раз. */
        if (!REDUCE && isNew && !isLast) el.classList.add('enter');
        node.appendChild(el);
      }
      prev = htmls;

      const last = node.lastElementChild;
      if (!last) return;

      /* Фейд только у символов, доехавших в этом кадре, и только в растущем
         блоке: новый блок уже анимируется целиком через .enter. */
      if (!REDUCE && grew > 0 && !lastNew && fresh > 0 &&
          /^(P|LI|H1|H2|H3|BLOCKQUOTE|TD|TH)$/.test(last.tagName)) {
        fadeTail(last, fresh);
      }

      /* Курсор — один и тот же узел на весь ответ: создаём один раз и просто
         переносим в конец последнего блока, чтобы его пульсация не сбивалась
         с частотой перерисовки. Если блок «составной» (таблица, код, цитата),
         ставим курсор в его последнюю текстовую ячейку. */
      const slot = caretSlot(last);
      if (slot) {
        if (!caret) { caret = document.createElement('span'); caret.className = 'caret'; }
        if (caret.parentNode !== slot || slot.lastChild !== caret) slot.appendChild(caret);
      }
    };

    return {
      push(chunk) {
        if (!chunk) return;
        text += chunk;
        added += chunk.length;
        if (!timer) timer = setTimeout(() => requestAnimationFrame(paint), FRAME);
      },
      get text() { return text; },
      finish(fullText) {
        if (timer) { clearTimeout(timer); timer = 0; }
        node.classList.remove('live');
        if (fullText != null) text = fullText;
        painted = text;
        prev = [];
        added = 0;
        node.innerHTML = markdown(text, picks);
      },
    };
  }

  /* Плавная прокрутка вниз — только если читатель и так у нижнего края. */
  function scroller(box) {
    let raf = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cancel = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 220;
    const step = () => {
      const delta = box.scrollHeight - box.clientHeight - box.scrollTop;
      if (delta <= 0.5) { raf = 0; return; }
      box.scrollTop += Math.max(0.8, delta * 0.18);
      raf = requestAnimationFrame(step);
    };
    box.addEventListener('wheel', cancel, { passive: true });
    box.addEventListener('touchstart', cancel, { passive: true });
    return {
      cancel,
      pin(force) {
        if (!force && !nearBottom()) return;
        if (reduced || force) { cancel(); box.scrollTop = box.scrollHeight; return; }
        if (!raf) raf = requestAnimationFrame(step);
      },
    };
  }

  window.Render = { esc, markdown, liveWriter, scroller, tokens, parseAsk };
})();
