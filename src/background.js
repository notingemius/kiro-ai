// Kiro AI — background service worker.
// Handles: message from content script -> call OpenRouter -> return structured suggestion.

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'deepseek/deepseek-chat-v3.1:free',
  customPrompt: '',
  temperature: 0.85,
};

const SYSTEM_PROMPT = `Ты — Kiro AI, помощник для живых человеческих ответов в переписке.
Пользователь выделил кусок текста (сообщение собеседника или пост). Твоя задача — помочь ему ответить ТЕПЛО, ОСМЫСЛЕННО и по-человечески, не как бот.

Всегда отвечай СТРОГО в формате JSON без пояснений до или после, без markdown-обёртки:
{
  "topic": "одной короткой фразой — о чём ответ, суть темы",
  "plan": ["шаг 1", "шаг 2", "шаг 3"],
  "parts": {
    "reaction": "короткая живая реакция на его слова (1 предложение)",
    "emotion": "эмоция или наблюдение от себя (1 предложение)",
    "self": "маленький кусочек себя — личный штрих, опыт, мысль (1-2 предложения)",
    "question": "вопрос, который копает глубже (1 предложение)"
  },
  "template": "все 4 части склеенные в естественный текст ответа, как будто пишет живой человек"
}

Правила:
- Пиши на том же языке, что и выделенный текст (по умолчанию — русский).
- Никакого канцелярита, никаких "я понимаю тебя", "это очень важная тема".
- Тон — как близкий друг: спокойно, внимательно, без пафоса.
- "template" должен читаться как одно цельное сообщение, а не как 4 отдельных куска.
- Не используй смайлики, если собеседник сам их не ставил.
- Будь конкретным, избегай общих слов.
- Отвечай быстро, не размышляй долго.`;

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function callOpenRouter(selectedText, settings) {
  if (!settings.apiKey) {
    throw new Error(
      'Не задан API-ключ. Открой настройки расширения (клик по иконке) и вставь ключ с https://openrouter.ai/keys'
    );
  }

  const sysPrompt = settings.customPrompt?.trim() ? settings.customPrompt : SYSTEM_PROMPT;

  const body = {
    model: settings.model,
    temperature: Number(settings.temperature) || 0.85,
    response_format: { type: 'json_object' },
    // Disable reasoning for models that support it — we want fast replies,
    // not long chain-of-thought. OpenRouter ignores this param for models
    // that don't support it.
    reasoning: { enabled: false },
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `Выделенный текст (на него нужно ответить):\n\n"""${selectedText}"""` },
    ],
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/notingemius/kiro-ai',
      'X-Title': 'Kiro AI Reply Helper',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Пустой ответ от модели.');

  const parsed = extractJson(content);
  if (!parsed) throw new Error('Модель вернула не-JSON:\n' + content.slice(0, 400));
  return normalizeResult(parsed);
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function normalizeResult(obj) {
  const parts = obj.parts || {};
  const result = {
    topic: String(obj.topic || '').trim(),
    plan: Array.isArray(obj.plan) ? obj.plan.map((s) => String(s).trim()).filter(Boolean) : [],
    parts: {
      reaction: String(parts.reaction || '').trim(),
      emotion: String(parts.emotion || '').trim(),
      self: String(parts.self || '').trim(),
      question: String(parts.question || '').trim(),
    },
    template: String(obj.template || '').trim(),
  };
  if (!result.template) {
    result.template = [result.parts.reaction, result.parts.emotion, result.parts.self, result.parts.question]
      .filter(Boolean).join(' ');
  }
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'KIRO_AI_SUGGEST') {
    (async () => {
      try {
        const settings = await getSettings();
        const data = await callOpenRouter(msg.text || '', settings);
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
  if (msg?.type === 'KIRO_AI_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'kiro-ai-suggest',
    title: 'Kiro AI: подсказать ответ',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'kiro-ai-suggest' || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'KIRO_AI_TRIGGER_FROM_MENU', text: info.selectionText || '' });
});

chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage(); });
