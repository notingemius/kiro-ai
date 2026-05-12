// Kiro AI — benchmark page.
// Fetches the live list of free text models from OpenRouter and pings each
// one with the user's API key, measuring latency.

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const statusEl = $('status');

let running = false;
let aborter = null;
let results = []; // { slug, name, durations:[ms], successes, failures }
let availableModels = []; // from /api/v1/models

// ---------- helpers ----------
function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '—';
  return (ms / 1000).toFixed(2) + 'с';
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const min = (arr) => (arr.length ? Math.min(...arr) : null);
const max = (arr) => (arr.length ? Math.max(...arr) : null);

async function getApiKey() {
  const s = await chrome.storage.sync.get({ apiKey: '' });
  return (s.apiKey || '').trim();
}

// ---------- model discovery ----------
async function fetchFreeModels() {
  log('Загружаю список актуальных моделей с OpenRouter…');
  const res = await fetch('https://openrouter.ai/api/v1/models', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const models = body.data || body;

  // Keep only free text models.
  const isFree = (m) => {
    const p = m.pricing || {};
    const prompt = parseFloat(p.prompt || '0');
    const completion = parseFloat(p.completion || '0');
    return prompt === 0 && completion === 0;
  };
  const isText = (m) => {
    const mods = m.architecture?.output_modalities;
    if (Array.isArray(mods)) return mods.includes('text');
    if (typeof mods === 'string') return mods.includes('text');
    return true; // if unknown, keep
  };
  const filtered = models.filter(isFree).filter(isText);
  filtered.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  availableModels = filtered;
  log(`Нашёл ${filtered.length} бесплатных моделей.`);
  return filtered;
}

function renderModelPicker() {
  const wrap = $('modelPicker');
  wrap.innerHTML = '';

  if (!availableModels.length) {
    wrap.innerHTML = '<p class="hint">Не удалось загрузить список моделей.</p>';
    return;
  }

  // Curated recommended set — updated based on recent real-world availability.
  const curated = new Set([
    'z-ai/glm-4.5-air:free',
    'openai/gpt-oss-120b:free',
    'openai/gpt-oss-20b:free',
    'nvidia/nemotron-nano-9b-v2:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'deepseek/deepseek-r1:free',
  ]);

  const toolbar = document.createElement('div');
  toolbar.className = 'picker-toolbar';
  toolbar.innerHTML = `
    <button type="button" data-action="recommended" class="chip">Рекомендованные</button>
    <button type="button" data-action="all" class="chip">Все</button>
    <button type="button" data-action="none" class="chip">Снять все</button>
    <span class="picker-counter" id="pickerCounter"></span>
  `;
  wrap.appendChild(toolbar);

  const list = document.createElement('div');
  list.className = 'picker-list';
  availableModels.forEach((m) => {
    const row = document.createElement('label');
    row.className = 'picker-row';
    const ctxK = m.context_length ? `${Math.round(m.context_length / 1000)}K` : '';
    const isCurated = curated.has(m.id);
    row.innerHTML = `
      <input type="checkbox" value="${m.id}" ${isCurated ? 'checked' : ''}>
      <span class="picker-name">${m.name || m.id}</span>
      <span class="picker-slug">${m.id}</span>
      <span class="picker-ctx">${ctxK}</span>
    `;
    list.appendChild(row);
  });
  wrap.appendChild(list);

  updatePickerCounter();
  list.addEventListener('change', updatePickerCounter);
  toolbar.addEventListener('click', (e) => {
    const action = e.target.getAttribute?.('data-action');
    if (!action) return;
    const checks = list.querySelectorAll('input[type="checkbox"]');
    checks.forEach((ch) => {
      if (action === 'all') ch.checked = true;
      else if (action === 'none') ch.checked = false;
      else if (action === 'recommended') ch.checked = curated.has(ch.value);
    });
    updatePickerCounter();
  });
}

function updatePickerCounter() {
  const checked = document.querySelectorAll('#modelPicker input[type="checkbox"]:checked').length;
  const total = document.querySelectorAll('#modelPicker input[type="checkbox"]').length;
  const el = $('pickerCounter');
  if (el) el.textContent = `выбрано ${checked} из ${total}`;
}

function getSelectedModels() {
  const checks = document.querySelectorAll('#modelPicker input[type="checkbox"]:checked');
  const byId = Object.fromEntries(availableModels.map((m) => [m.id, m]));
  return Array.from(checks).map((ch) => byId[ch.value]).filter(Boolean);
}

// ---------- one call ----------
/**
 * Call the model once. Strategy:
 *   1. Try WITHOUT any `reasoning` parameter.
 *   2. If the provider returns "Reasoning is mandatory" (gpt-oss family),
 *      retry with `reasoning: { enabled: true, effort: 'low' }`.
 */
async function callModel(slug, prompt, apiKey, timeoutSec, signal) {
  const doFetch = async (reasoningParam) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutSec * 1000);
    signal.addEventListener('abort', () => controller.abort('user'), { once: true });

    const body = {
      model: slug,
      temperature: 0.7,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'Отвечай коротко и живо, 2-3 предложения.' },
        { role: 'user', content: prompt },
      ],
    };
    if (reasoningParam) body.reasoning = reasoningParam;

    const started = performance.now();
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/notingemius/kiro-ai',
          'X-Title': 'Kiro AI Bench',
        },
        body: JSON.stringify(body),
      });
      const elapsed = performance.now() - started;
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { ok: false, ms: elapsed, status: res.status, errText };
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      return { ok: true, ms: elapsed, sample: content.slice(0, 80) };
    } catch (e) {
      const elapsed = performance.now() - started;
      if (e.name === 'AbortError') return { ok: false, ms: elapsed, error: 'timeout' };
      return { ok: false, ms: elapsed, error: e.message || String(e) };
    } finally {
      clearTimeout(timer);
    }
  };

  let r = await doFetch(null);
  if (!r.ok && r.status === 400 && /Reasoning is mandatory/i.test(r.errText || '')) {
    r = await doFetch({ enabled: true, effort: 'low' });
  }
  if (r.ok) return r;
  const errMsg = r.error || `HTTP ${r.status}: ${(r.errText || '').slice(0, 120)}`;
  return { ok: false, ms: r.ms, error: errMsg };
}

// ---------- rendering ----------
function renderResults(sorted) {
  const tbody = $('resultsTable').querySelector('tbody');
  tbody.innerHTML = '';
  sorted.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (i === 0 && r.durations.length > 0) tr.classList.add('winner');
    const a = avg(r.durations);
    const mn = min(r.durations);
    const mx = max(r.durations);
    const total = r.successes + r.failures;
    const successRate = total ? `${r.successes}/${total}` : '0/0';

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>
        <div class="m-name">${r.name} ${i === 0 && r.durations.length > 0 ? '🏆' : ''}</div>
        <div class="m-slug">${r.slug}</div>
      </td>
      <td class="num">${fmtMs(a)}</td>
      <td class="num">${fmtMs(mn)}</td>
      <td class="num">${fmtMs(mx)}</td>
      <td class="num">${successRate}</td>
      <td><button data-slug="${r.slug}" class="pick">Выбрать</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button.pick').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.getAttribute('data-slug');
      await chrome.storage.sync.set({ model: slug });
      statusEl.textContent = `Модель "${slug}" установлена как дефолт ✓`;
      statusEl.classList.remove('error');
      setTimeout(() => (statusEl.textContent = ''), 2500);
    });
  });
}

function sortedResults() {
  const scored = results.map((r) => ({
    ...r,
    sortKey: r.durations.length ? avg(r.durations) : Number.POSITIVE_INFINITY,
  }));
  scored.sort((a, b) => a.sortKey - b.sortKey);
  return scored;
}

// ---------- main loop ----------
async function runBench() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    $('keyWarning').hidden = false;
    return;
  }
  $('keyWarning').hidden = true;

  const selected = getSelectedModels();
  if (!selected.length) {
    statusEl.textContent = 'Выбери хотя бы одну модель.';
    statusEl.classList.add('error');
    return;
  }

  const prompt = $('testPrompt').value.trim() || 'Привет, как дела?';
  const runs = Math.max(1, Math.min(5, parseInt($('runsPerModel').value) || 2));
  const timeoutSec = Math.max(5, Math.min(120, parseInt($('timeout').value) || 30));

  running = true;
  aborter = new AbortController();
  $('runBench').disabled = true;
  $('stopBench').disabled = false;
  $('applyFastest').disabled = true;
  $('resultsCard').hidden = false;
  logEl.textContent = '';
  results = selected.map((m) => ({
    slug: m.id,
    name: m.name || m.id,
    durations: [],
    successes: 0,
    failures: 0,
  }));

  const total = results.length * runs;
  let done = 0;

  log(`Старт: ${results.length} моделей × ${runs} прогонов = ${total} запросов`);
  log(`Промпт: "${prompt}"`);

  for (const r of results) {
    if (!running) break;
    for (let i = 0; i < runs; i++) {
      if (!running) break;
      statusEl.textContent = `Тестирую ${r.name} (${i + 1}/${runs})… ${done}/${total}`;
      log(`→ ${r.slug} #${i + 1}`);
      const res = await callModel(r.slug, prompt, apiKey, timeoutSec, aborter.signal);
      done++;
      if (res.ok) {
        r.durations.push(res.ms);
        r.successes++;
        log(`  ✓ ${fmtMs(res.ms)} — "${(res.sample || '').replace(/\s+/g, ' ')}"`);
      } else {
        r.failures++;
        log(`  ✗ ${fmtMs(res.ms)} — ${res.error}`);
      }
      renderResults(sortedResults());
    }
  }

  running = false;
  aborter = null;
  $('runBench').disabled = false;
  $('stopBench').disabled = true;
  statusEl.textContent = `Готово: ${done}/${total} запросов`;

  const ok = sortedResults().filter((r) => r.durations.length > 0);
  if (ok.length) {
    $('applyFastest').disabled = false;
    const fastest = ok[0];
    $('resultsHint').textContent =
      `Самая быстрая: ${fastest.name} (${fmtMs(avg(fastest.durations))} в среднем). ` +
      `Нажми «Поставить самую быструю как дефолт» или выбери любую вручную.`;
  } else {
    $('resultsHint').textContent = 'Ни одна модель не ответила успешно. Проверь ключ и квоты.';
  }
}

async function applyFastest() {
  const ok = sortedResults().filter((r) => r.durations.length > 0);
  if (!ok.length) return;
  const fastest = ok[0];
  await chrome.storage.sync.set({ model: fastest.slug });
  statusEl.textContent = `Установлено: ${fastest.name} (${fastest.slug}) ✓`;
  statusEl.classList.remove('error');
  setTimeout(() => (statusEl.textContent = ''), 2500);
}

// ---------- bindings ----------
$('runBench').addEventListener('click', runBench);
$('stopBench').addEventListener('click', () => {
  running = false;
  if (aborter) aborter.abort();
  log('-- остановлено пользователем --');
});
$('applyFastest').addEventListener('click', applyFastest);

// ---------- init ----------
(async () => {
  const k = await getApiKey();
  if (!k) $('keyWarning').hidden = false;
  try {
    await fetchFreeModels();
    renderModelPicker();
  } catch (e) {
    log('Ошибка загрузки моделей: ' + (e.message || e));
    $('modelPicker').innerHTML = '<p class="hint" style="color:#ff8aa3">Не удалось загрузить список моделей с OpenRouter.</p>';
  }
})();
