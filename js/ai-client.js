/**
 * AIClient - 调用外部 AI API 进行预测
 * 支持 OpenAI GPT / Anthropic Claude / 自定义 OpenAI 兼容接口
 */
export class AIClient {

  async predict(report, matchId) {
    const settings = await this._getSettings();

    // 自定义接口不强制要求 apiKey（本地模型如 Ollama 不需要）
    if (!settings.apiKey && settings.provider !== 'custom') {
      return { error: '请先在设置页面配置 AI API Key', needConfig: true };
    }

    const prompt = this._buildPrompt(report.markdown);

    try {
      if (settings.provider === 'openai') {
        return await this._callOpenAI(prompt, settings);
      } else if (settings.provider === 'claude') {
        return await this._callClaude(prompt, settings);
      } else if (settings.provider === 'custom') {
        return await this._callCustom(prompt, settings);
      }
      return { error: '未知 AI 提供商' };
    } catch (err) {
      return { error: `AI 调用失败: ${err.message}` };
    }
  }

  _buildPrompt(reportMarkdown) {
    return `你是一位专业的足球数据分析师，精通亚盘、大小球盘口分析和赔率解读。
请基于以下完整数据报告，给出精准的比赛预测分析。

${reportMarkdown}

---
请严格按以下格式输出预测报告（不超过1200字）：

## 🎯 核心预测
[一句话总结最核心的推荐方向]

## 🏆 全场预测
### 亚让盘
- 盘口倾向：[主队/客队/平手]
- 推荐：[具体推荐，如"主队-0.5让球"]
- 赔率依据：[分析当前赔率水位，高水位/低水位意义]
- 信心度：[0-100%]

### 大小球
- 推荐：[大球/小球 + 具体进球线，如"大球2.5"]
- 赔率依据：[大小球赔率水位分析]
- 理由：[数据支撑]
- 信心度：[0-100%]

### 角球
- 推荐：[大角球/小角球 + 角球线，如"大角球9.5"]
- 信心度：[0-100%]

## 🕐 半场预测
- 半场亚盘：[主队/客队/平手让球推荐]
- 半场大小球：[大/小 + 进球线]
- 半场角球：[大/小 + 角球线]
- 理由：[赛事节奏、主客场半场数据等]
- 信心度：[0-100%]

## 🔢 比分预测
- 最可能比分1：[X:X]（概率约X%）
- 最可能比分2：[X:X]（概率约X%）
- 最可能比分3：[X:X]（概率约X%）
- 分析依据：[基于球队近期进失球数据]

## 💰 投注建议（基于赔率）
| 投注项目 | 推荐方向 | 当前赔率 | 价值评估 | 建议仓位 |
|---------|---------|---------|---------|---------|
| 全场亚盘 | ... | ... | 高/中/低价值 | 低/中/高仓 |
| 全场大小球 | ... | ... | ... | ... |
| 全场角球 | ... | ... | ... | ... |
| 半场亚盘 | ... | ... | ... | ... |
| 比分 | ... | ... | ... | ... |

> 高价值=赔率被低估，值得投注；低价值=赔率过低，性价比差

## ⚠️ 风险提示
[主要不确定因素，如伤停、赔率异动、主场因素等]

## 📊 综合评分
- 比赛精彩程度：[1-10]
- 综合推荐信心：[0-100%]
- 重点关注：[最值得投注的1-2个方向]`;
  }

  async _callOpenAI(prompt, settings) {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model || 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.3
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return {
      provider: 'openai',
      model: data.model,
      content: data.choices[0].message.content,
      tokens: data.usage?.total_tokens,
      generatedAt: new Date().toISOString()
    };
  }

  async _callClaude(prompt, settings) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.model || 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return {
      provider: 'claude',
      model: data.model,
      content: data.content[0].text,
      tokens: data.usage?.input_tokens + data.usage?.output_tokens,
      generatedAt: new Date().toISOString()
    };
  }

  async _callCustom(prompt, settings) {
    // 支持自定义 OpenAI 兼容接口（DeepSeek、Ollama、本地模型等）
    // 自动补全 /v1/chat/completions 路径
    let endpoint = (settings.customEndpoint || 'http://localhost:11434').trim();
    // 移除末尾斜杠
    endpoint = endpoint.replace(/\/+$/, '');
    // 如果没有以 /chat/completions 结尾，自动补全标准路径
    if (!endpoint.endsWith('/chat/completions')) {
      // 如果已经有 /v1，只补 /chat/completions；否则补全 /v1/chat/completions
      if (endpoint.endsWith('/v1')) {
        endpoint = endpoint + '/chat/completions';
      } else {
        endpoint = endpoint + '/v1/chat/completions';
      }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.model || 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
          temperature: 0.3,
          stream: false
        })
      });
    } catch (fetchErr) {
      throw new Error(`无法连接到自定义端点 ${endpoint}：${fetchErr.message}`);
    }

    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const errBody = await resp.json();
        errMsg = errBody.error?.message || errBody.message || errMsg;
      } catch {}
      throw new Error(`自定义接口错误 [${endpoint}]: ${errMsg}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`自定义接口响应格式异常: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return {
      provider: 'custom',
      model: data.model || settings.model,
      content,
      tokens: data.usage?.total_tokens,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 多轮对话 - messages: [{role:'user'|'assistant'|'system', content:'...'}]
   * systemContext: 报告原文（作为 system 背景）
   */
  async chat(messages, systemContext) {
    const settings = await this._getSettings();
    if (!settings.apiKey && settings.provider !== 'custom') {
      return { error: '请先配置 AI API Key', needConfig: true };
    }
    const fullMessages = systemContext
      ? [{ role: 'system', content: `你是一位专业足球数据分析师。以下是当前比赛的完整数据报告，请基于这些数据回答用户问题：\n\n${systemContext}` }, ...messages]
      : messages;
    try {
      if (settings.provider === 'openai') return await this._chatOpenAI(fullMessages, settings);
      if (settings.provider === 'claude') return await this._chatClaude(fullMessages, settings);
      if (settings.provider === 'custom') return await this._chatCustom(fullMessages, settings);
      return { error: '未知 AI 提供商' };
    } catch (err) {
      return { error: `AI 调用失败: ${err.message}` };
    }
  }

  async _chatOpenAI(messages, settings) {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model || 'gpt-4o', messages, max_tokens: 2000, temperature: 0.3 })
    });
    if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
    const data = await resp.json();
    return { provider:'openai', model:data.model, content:data.choices[0].message.content, tokens:data.usage?.total_tokens, generatedAt:new Date().toISOString() };
  }

  async _chatClaude(messages, settings) {
    const systemMsg = messages[0]?.role === 'system' ? messages[0].content : '';
    const userMessages = systemMsg ? messages.slice(1) : messages;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: settings.model || 'claude-3-5-sonnet-20241022', max_tokens: 2000, system: systemMsg || undefined, messages: userMessages })
    });
    if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
    const data = await resp.json();
    return { provider:'claude', model:data.model, content:data.content[0].text, tokens:(data.usage?.input_tokens||0)+(data.usage?.output_tokens||0), generatedAt:new Date().toISOString() };
  }

  async _chatCustom(messages, settings) {
    let endpoint = (settings.customEndpoint || 'http://localhost:11434').trim().replace(/\/+$/, '');
    if (!endpoint.endsWith('/chat/completions')) {
      endpoint = endpoint.endsWith('/v1') ? endpoint + '/chat/completions' : endpoint + '/v1/chat/completions';
    }
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
    // 合并 system 消息到首条 user 消息（部分接口不支持 system role）
    let msgs = [...messages];
    if (msgs[0]?.role === 'system') {
      const sys = msgs.shift();
      if (msgs[0]?.role === 'user') msgs[0] = { role:'user', content: sys.content + '\n\n' + msgs[0].content };
    }
    let resp;
    try {
      resp = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify({ model: settings.model||'deepseek-chat', messages: msgs, max_tokens:2000, temperature:0.3, stream:false }) });
    } catch (fe) { throw new Error(`无法连接 ${endpoint}：${fe.message}`); }
    if (!resp.ok) { let m=`HTTP ${resp.status}`; try{const b=await resp.json();m=b.error?.message||b.message||m;}catch{} throw new Error(`[${endpoint}] ${m}`); }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`响应格式异常: ${JSON.stringify(data).slice(0,200)}`);
    return { provider:'custom', model:data.model||settings.model, content, tokens:data.usage?.total_tokens, generatedAt:new Date().toISOString() };
  }

  async _getSettings() {
    const result = await chrome.storage.sync.get(['aiProvider', 'aiApiKey', 'aiModel', 'aiCustomEndpoint']);
    return {
      provider: result.aiProvider || 'openai',
      apiKey: result.aiApiKey || '',
      model: result.aiModel || '',
      customEndpoint: result.aiCustomEndpoint || ''
    };
  }
}
