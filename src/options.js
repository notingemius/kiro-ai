const DEFAULTS = {
  apiKey: '',
  model: 'z-ai/glm-4.5-air:free',
  customPrompt: '',
  temperature: 0.85,
};

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('apiKey').value = s.apiKey || '';
  $('customPrompt').value = s.customPrompt || '';
  $('temperature').value = s.temperature ?? 0.85;

  const select = $('model');
  const options = Array.from(select.options).map((o) => o.value);
  if (options.includes(s.model)) {
    select.value = s.model;
  } else {
    select.value = '__custom__';
    $('customModel').value = s.model;
  }
  toggleCustomWrap();
}

function toggleCustomWrap() {
  const isCustom = $('model').value === '__custom__';
  $('customModelWrap').hidden = !isCustom;
}

async function save() {
  const modelVal = $('model').value;
  const model = modelVal === '__custom__'
    ? $('customModel').value.trim() || DEFAULTS.model
    : modelVal;

  const data = {
    apiKey: $('apiKey').value.trim(),
    model,
    customPrompt: $('customPrompt').value,
    temperature: parseFloat($('temperature').value) || 0.85,
  };
  await chrome.storage.sync.set(data);
  const status = $('status');
  status.textContent = 'Сохранено ✓';
  status.classList.remove('error');
  setTimeout(() => (status.textContent = ''), 1500);
}

$('save').addEventListener('click', save);
$('model').addEventListener('change', toggleCustomWrap);
$('toggleKey').addEventListener('click', () => {
  const inp = $('apiKey');
  if (inp.type === 'password') {
    inp.type = 'text';
    $('toggleKey').textContent = 'Скрыть ключ';
  } else {
    inp.type = 'password';
    $('toggleKey').textContent = 'Показать ключ';
  }
});

load();
