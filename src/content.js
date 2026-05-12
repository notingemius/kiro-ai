// Kiro AI content script: detects text selection, shows floating trigger,
// renders suggestion panel, sends selected text to background service worker.

(() => {
  const BTN_ID = 'kiro-ai-trigger';
  const PANEL_ID = 'kiro-ai-panel';
  const LOG = (...args) => console.log('[Kiro AI]', ...args);

  LOG('content script loaded on', location.href);

  let currentSelectionText = '';

  const $ = (id) => document.getElementById(id);
  const removeEl = (id) => { const el = $(id); if (el) el.remove(); };

  const getSelectionInfo = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    return { text, rect, range };
  };

  const showTrigger = (rect) => {
    removeEl(BTN_ID);
    LOG('showTrigger at', rect);
    const btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.className = 'kiro-ai-trigger';
    btn.title = 'Kiro AI — подсказать ответ';
    btn.textContent = 'K';

    // Use fixed positioning so it works on any layout.
    const top = rect.top - 34;
    const left = rect.right + 4;
    btn.style.top = `${Math.max(top, 4)}px`;
    btn.style.left = `${Math.max(left, 4)}px`;

    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(); });

    (document.body || document.documentElement).appendChild(btn);
  };

  const openPanel = () => {
    removeEl(PANEL_ID);
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'kiro-ai-panel';
    panel.innerHTML = `
      <div class="kiro-ai-header">
        <div class="kiro-ai-title">Kiro AI</div>
        <button class="kiro-ai-close" aria-label="Закрыть">×</button>
      </div>
      <div class="kiro-ai-quote"></div>
      <div class="kiro-ai-status">Думаю…</div>
      <div class="kiro-ai-body" hidden>
        <section>
          <h4>Тема ответа</h4>
          <div class="kiro-ai-topic"></div>
        </section>
        <section>
          <h4>План</h4>
          <ol class="kiro-ai-plan"></ol>
        </section>
        <section>
          <h4>Шаблон ответа</h4>
          <div class="kiro-ai-template"></div>
          <div class="kiro-ai-parts">
            <div><span class="lbl">Реакция:</span> <span class="p-reaction"></span></div>
            <div><span class="lbl">Эмоция/наблюдение:</span> <span class="p-emotion"></span></div>
            <div><span class="lbl">Кусочек себя:</span> <span class="p-self"></span></div>
            <div><span class="lbl">Вопрос глубже:</span> <span class="p-question"></span></div>
          </div>
          <div class="kiro-ai-actions">
            <button class="kiro-ai-copy">Скопировать шаблон</button>
            <button class="kiro-ai-regen">Ещё вариант</button>
          </div>
        </section>
      </div>
      <div class="kiro-ai-error" hidden></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.kiro-ai-quote').textContent =
      currentSelectionText.length > 280
        ? currentSelectionText.slice(0, 280) + '…'
        : currentSelectionText;

    panel.querySelector('.kiro-ai-close').addEventListener('click', () => removeEl(PANEL_ID));
    panel.querySelector('.kiro-ai-regen').addEventListener('click', () => requestSuggestion(currentSelectionText));
    panel.querySelector('.kiro-ai-copy').addEventListener('click', () => {
      const tmpl = panel.querySelector('.kiro-ai-template').textContent;
      navigator.clipboard.writeText(tmpl).catch(() => {});
      const btn = panel.querySelector('.kiro-ai-copy');
      const old = btn.textContent;
      btn.textContent = 'Скопировано ✓';
      setTimeout(() => (btn.textContent = old), 1200);
    });

    requestSuggestion(currentSelectionText);
  };

  const renderResult = (data) => {
    const panel = $(PANEL_ID);
    if (!panel) return;
    panel.querySelector('.kiro-ai-status').hidden = true;
    panel.querySelector('.kiro-ai-error').hidden = true;
    panel.querySelector('.kiro-ai-body').hidden = false;

    panel.querySelector('.kiro-ai-topic').textContent = data.topic || '—';

    const planEl = panel.querySelector('.kiro-ai-plan');
    planEl.innerHTML = '';
    (data.plan || []).forEach((step) => {
      const li = document.createElement('li');
      li.textContent = step;
      planEl.appendChild(li);
    });

    const parts = data.parts || {};
    panel.querySelector('.p-reaction').textContent = parts.reaction || '';
    panel.querySelector('.p-emotion').textContent = parts.emotion || '';
    panel.querySelector('.p-self').textContent = parts.self || '';
    panel.querySelector('.p-question').textContent = parts.question || '';

    const template =
      data.template ||
      [parts.reaction, parts.emotion, parts.self, parts.question].filter(Boolean).join(' ');
    panel.querySelector('.kiro-ai-template').textContent = template;
  };

  const renderError = (msg) => {
    const panel = $(PANEL_ID);
    if (!panel) return;
    panel.querySelector('.kiro-ai-status').hidden = true;
    panel.querySelector('.kiro-ai-body').hidden = true;
    const err = panel.querySelector('.kiro-ai-error');
    err.hidden = false;
    err.textContent = msg;
  };

  let thinkTimer = null;
  const stopThinkTimer = () => { if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; } };

  const requestSuggestion = (text) => {
    const panel = $(PANEL_ID);
    stopThinkTimer();
    if (panel) {
      const statusEl = panel.querySelector('.kiro-ai-status');
      statusEl.hidden = false;
      panel.querySelector('.kiro-ai-body').hidden = true;
      panel.querySelector('.kiro-ai-error').hidden = true;
      const startedAt = Date.now();
      const tick = () => {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        statusEl.textContent = `Думаю… ${sec}с`;
      };
      tick();
      thinkTimer = setInterval(tick, 250);
    }
    chrome.runtime.sendMessage({ type: 'KIRO_AI_SUGGEST', text }, (resp) => {
      stopThinkTimer();
      if (chrome.runtime.lastError) {
        renderError('Ошибка расширения: ' + chrome.runtime.lastError.message);
        return;
      }
      if (!resp || !resp.ok) {
        renderError(resp?.error || 'Не удалось получить ответ от AI.');
        return;
      }
      renderResult(resp.data);
    });
  };

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest && (e.target.closest(`#${BTN_ID}`) || e.target.closest(`#${PANEL_ID}`))) return;
    setTimeout(() => {
      const info = getSelectionInfo();
      if (!info) { removeEl(BTN_ID); currentSelectionText = ''; return; }
      LOG('selection captured:', info.text.slice(0, 80));
      currentSelectionText = info.text;
      showTrigger(info.rect);
    }, 10);
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest(`#${BTN_ID}`)) return;
    if (e.target.closest && e.target.closest(`#${PANEL_ID}`)) return;
    removeEl(BTN_ID);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { removeEl(BTN_ID); removeEl(PANEL_ID); }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'KIRO_AI_TRIGGER_FROM_MENU') {
      const text = (msg.text || '').trim();
      if (!text) return;
      currentSelectionText = text;
      openPanel();
    }
  });
})();
