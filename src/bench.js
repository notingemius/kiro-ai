// Kiro AI — benchmark page.
// Pings all free OpenRouter models with the user's API key and measures latency.

const MODELS = [
  { slug: 'deepseek/deepseek-chat-v3.1:free', name: 'DeepSeek V3.1', kind: 'fast' },
  { slug: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air', kind: 'fast' },
  { slug: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', kind: 'fast' },
  { slug: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B', kind: 'fast' },
  { slug: 'qwen/qwen3-235b-a22b:free', name: 'Qwen3 235B', kind: 'fast' },
  { slug: 'openai/gpt-oss-120b:free', name: 'gpt-oss-120b', kind: 'reasoning' },
  { slug: 'openai/gpt-oss-20b:free', name: 'gpt-oss-20b', kind: 'reasoning' },
  { slug: 'nvidia/nemotron-nano-9b-v2:free', name: 'Nemotron Nano 9B', kind: 'reasoning' },
];

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const statusEl = $('status');

let running = false;
let aborter = null;
let results = []; // { slug, name, kind, durations:[ms], successes, failures, error? }

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

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function min(arr) { return arr.length ? Math.min(...arr) : null; }
function max(arr) { return arr.length ? Math.max(...arr) : null; }

async function getApiKey() {
  const s = await chrome.storage.sync.get({ apiKey: '' });
  return (s.apiKey || '').trim();
}

// ---------- one call ----------
async function callModel(slug, prompt, apiKey, timeoutSec, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  // If outer aborter fires, also cancel us
  signal.addEventListener('abort', () => controller.abort(), { once: true });

  const body = {
    model: slug,
    temperature: 0.7,
    max_tokens: 200,
    reasoning: { enabled: false },
    messages: [
      { role: 'system', content: 'Отвечай коротко и живо, 2-3 предложения.' },
      { role: 'user', content: prompt },
    ],
  };

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
      return { ok: false, ms: elapsed, error: `HTTP ${res.status}: ${errText.slice(0, 120)}` };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return { ok: true, ms: elapsed, sample: content.slice(0, 80) };
  } catch (e) {
    const elapsed = performance.now() - started;
    if (e.name === 'AbortError') return { ok: false, ms: elapsed, error: 'timeout / abort' };
    return { ok: false, ms: elapsed, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- rendering ----------
function renderResults(sorted) {
  const tbody = $('resultsTable').querySelector('tbody');
  tbody.innerHTML = '';
  sorted.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (i === 0) tr.classList.add('winner');
    const a = avg(r.durations);
    const mn = min(r.durations);
    const mx = max(r.durations);
    const total = r.successes + r.failures;
    const successRate = total ? `${r.successes}/${total}` : '0/0';

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>
        <div class="m-name">${r.name} ${i === 0 ? '🏆' : ''}</div>
        <div class="m-slug">${r.slug}</div>
        <div class="m-kind ${r.kind}">${r.kind === 'fast' ? 'быстрая' : 'reasoning'}</div>
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
  // only models with at least one success
  const scored = results.map((r) => {
    const durs = r.durations;
    return {
      ...r,
      sortKey: durs.length ? avg(durs) : Number.POSITIVE_INFINITY,
    };
  });
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
  results = MODELS.map((m) => ({ ...m, durations: [], successes: 0, failures: 0 }));

  const total = MODELS.length * runs;
  let done = 0;

  log(`Старт: ${MODELS.length} моделей × ${runs} прогонов = ${total} запросов`);
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

$('runBench').addEventListener('click', runBench);
$('stopBench').addEventListener('click', () => {
  running = false;
  if (aborter) aborter.abort();
  log('-- остановлено пользователем --');
});
$('applyFastest').addEventListener('click', applyFastest);

// Show key warning early if no key
(async () => {
  const k = await getApiKey();
  if (!k) $('keyWarning').hidden = false;
})();
