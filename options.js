// options.js - 设置页面逻辑

const KEYS = [
  'aiProvider', 'aiApiKey', 'aiModel', 'aiCustomEndpoint',
  'tavilyApiKey',
  'publicSyncEnabled', 'publicApiUrl', 'publicAdminKey',
  'defaultInterval', 'sensitivity',
  'notifyOddsChange', 'autoReport', 'autoPreMatch',
  'srcAnalysis', 'srcAsian', 'srcOverUnder', 'srcCorner',
  'weightAo', 'weightUpDown', 'weightWater', 'weightStats'
];

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  initProviderCards();
  initEyeBtn();
  initButtons();
});

async function loadSettings() {
  const settings = await chrome.storage.sync.get(KEYS);

  // AI 配置
  setRadio('provider', settings.aiProvider || 'openai');
  setVal('apiKey', settings.aiApiKey || '');
  setVal('aiModel', settings.aiModel || '');
  setVal('customEndpoint', settings.aiCustomEndpoint || '');
  setVal('tavilyApiKey', settings.tavilyApiKey || '');

  // 公共数据同步
  setCheck('publicSyncEnabled', !!settings.publicSyncEnabled);
  setVal('publicApiUrl', settings.publicApiUrl || 'http://cdu.cc.cd/football-api/api.php');
  setVal('publicAdminKey', settings.publicAdminKey || '');

  // 监控配置
  setVal('defaultInterval', settings.defaultInterval || '2');
  setVal('sensitivity', settings.sensitivity || '0.05');
  setCheck('notifyOddsChange', settings.notifyOddsChange !== false);
  setCheck('autoReport', settings.autoReport !== false);
  setCheck('autoPreMatch', !!settings.autoPreMatch);

  // 数据源
  setCheck('srcAnalysis', settings.srcAnalysis !== false);
  setCheck('srcAsian', settings.srcAsian !== false);
  setCheck('srcOverUnder', settings.srcOverUnder !== false);
  setCheck('srcCorner', settings.srcCorner !== false);

  // 权重
  setVal('weightAo', settings.weightAo ?? 5);
  setVal('weightUpDown', settings.weightUpDown ?? 3);
  setVal('weightWater', settings.weightWater ?? 4);
  setVal('weightStats', settings.weightStats ?? 2);

  // 更新自定义端点显示
  updateProviderUI(settings.aiProvider || 'openai');
}

function initProviderCards() {
  document.querySelectorAll('.radio-card').forEach(card => {
    card.addEventListener('click', () => {
      const value = card.dataset.value;
      document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      card.querySelector('input[type="radio"]').checked = true;
      updateProviderUI(value);
    });
  });
}

function updateProviderUI(provider) {
  const customGroup = document.getElementById('customEndpointGroup');
  const hint = document.getElementById('modelHint');
  const modelInput = document.getElementById('aiModel');

  if (provider === 'custom') {
    customGroup.style.display = 'block';
    hint.innerHTML = '💡 支持任意 OpenAI 兼容接口，如 <code>DeepSeek</code>、<code>Ollama</code>、<code>Moonshot</code> 等。<br>模型名称填写对应服务的模型标识。';
    modelInput.placeholder = '如: deepseek-chat';
  } else if (provider === 'claude') {
    customGroup.style.display = 'none';
    hint.innerHTML = '💡 推荐模型：<code>claude-3-5-sonnet-20241022</code> 或 <code>claude-opus-4-5</code>。<br>需要 Anthropic API Key（<code>sk-ant-...</code>）。';
    modelInput.placeholder = '如: claude-3-5-sonnet-20241022';
  } else {
    customGroup.style.display = 'none';
    hint.innerHTML = '💡 推荐模型：<code>gpt-4o</code> 或 <code>gpt-4-turbo</code>。分析足球数据需要强推理能力，GPT-4 级别效果最佳。';
    modelInput.placeholder = '如: gpt-4o';
  }
}

function initEyeBtn() {
  const btn = document.getElementById('eyeBtn');
  const input = document.getElementById('apiKey');
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '👁' : '🙈';
  });

  const tavilyBtn = document.getElementById('tavilyEyeBtn');
  const tavilyInput = document.getElementById('tavilyApiKey');
  tavilyBtn.addEventListener('click', () => {
    tavilyInput.type = tavilyInput.type === 'password' ? 'text' : 'password';
    tavilyBtn.textContent = tavilyInput.type === 'password' ? '👁' : '🙈';
  });

  const publicAdminBtn = document.getElementById('publicAdminEyeBtn');
  const publicAdminInput = document.getElementById('publicAdminKey');
  publicAdminBtn?.addEventListener('click', () => {
    publicAdminInput.type = publicAdminInput.type === 'password' ? 'text' : 'password';
    publicAdminBtn.textContent = publicAdminInput.type === 'password' ? '👁' : '🙈';
  });
}

function initButtons() {
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('clearDataBtn').addEventListener('click', clearCacheData);
  document.getElementById('exportBtn').addEventListener('click', exportConfig);
}

async function saveSettings() {
  const provider = getRadio('provider');
  const apiKey = getVal('apiKey').trim();

  // 简单验证
  if (apiKey) {
    if (provider === 'openai' && !apiKey.startsWith('sk-')) {
      showToast('OpenAI API Key 格式错误（应以 sk- 开头）', true);
      return;
    }
    if (provider === 'claude' && !apiKey.startsWith('sk-ant-')) {
      showToast('Claude API Key 格式错误（应以 sk-ant- 开头）', true);
      return;
    }
  }

  const publicSyncEnabled = getCheck('publicSyncEnabled');
  const publicApiUrl = getVal('publicApiUrl').trim();
  if (publicSyncEnabled && !/^https?:\/\//i.test(publicApiUrl)) {
    showToast('公共 API 地址必须以 http:// 或 https:// 开头', true);
    return;
  }

  const settings = {
    aiProvider: provider,
    aiApiKey: apiKey,
    aiModel: getVal('aiModel').trim(),
    aiCustomEndpoint: getVal('customEndpoint').trim(),
    tavilyApiKey: getVal('tavilyApiKey').trim(),
    publicSyncEnabled,
    publicApiUrl,
    publicAdminKey: getVal('publicAdminKey').trim(),
    defaultInterval: getVal('defaultInterval'),
    sensitivity: getVal('sensitivity'),
    notifyOddsChange: getCheck('notifyOddsChange'),
    autoReport: getCheck('autoReport'),
    autoPreMatch: getCheck('autoPreMatch'),
    srcAnalysis: getCheck('srcAnalysis'),
    srcAsian: getCheck('srcAsian'),
    srcOverUnder: getCheck('srcOverUnder'),
    srcCorner: getCheck('srcCorner'),
    weightAo: parseInt(getVal('weightAo')) || 5,
    weightUpDown: parseInt(getVal('weightUpDown')) || 3,
    weightWater: parseInt(getVal('weightWater')) || 4,
    weightStats: parseInt(getVal('weightStats')) || 2
  };

  await chrome.storage.sync.set(settings);
  showToast('✅ 设置已保存');
}

async function clearCacheData() {
  if (!confirm('确定要清除所有缓存的比赛数据吗？监控任务不会被删除。')) return;
  const all = await chrome.storage.local.get(null);
  const matchKeys = Object.keys(all).filter(k => k.startsWith('match_'));
  if (matchKeys.length > 0) {
    await chrome.storage.local.remove(matchKeys);
    showToast(`已清除 ${matchKeys.length} 条比赛数据缓存`);
  } else {
    showToast('没有可清除的缓存数据');
  }
}

async function exportConfig() {
  const settings = await chrome.storage.sync.get(KEYS);
  // 脱敏处理
  const exported = {
    ...settings,
    aiApiKey: settings.aiApiKey ? '***已隐藏***' : '',
    tavilyApiKey: settings.tavilyApiKey ? '***已隐藏***' : '',
    publicAdminKey: settings.publicAdminKey ? '***已隐藏***' : ''
  };
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `titan007-predictor-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 工具函数 =====
function getVal(id) { return document.getElementById(id)?.value || ''; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function getCheck(id) { return document.getElementById(id)?.checked || false; }
function setCheck(id, val) { const el = document.getElementById(id); if (el) el.checked = val; }
function getRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}
function setRadio(name, value) {
  const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (radio) {
    radio.checked = true;
    document.querySelectorAll('.radio-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === value);
    });
  }
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast show${isError ? ' error' : ''}`;
  setTimeout(() => toast.classList.remove('show'), 2500);
}
