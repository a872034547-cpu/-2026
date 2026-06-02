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

  /**
   * 深度预测 (2.0)：
   *  - 保留原始数据报告（rawReportMarkdown）继续投喂
   *  - 注入本地量化模型结论（quantMarkdown，含推导过程，仅供参考不可照抄）
   *  - 注入扩展端联网情报线索（intelMarkdown，需AI交叉核实）
   *  - 要求AI自行联网检索最新信息，独立综合思考后给出建议
   * extras: { quantMarkdown, intelMarkdown }
   */
  async predictDeep(report, matchId, extras = {}) {
    const settings = await this._getSettings();
    if (!settings.apiKey && settings.provider !== 'custom') {
      return { error: '请先在设置页面配置 AI API Key', needConfig: true };
    }

    const prompt = this._buildDeepPrompt(report.markdown, extras.quantMarkdown, extras.intelMarkdown);

    try {
      if (settings.provider === 'openai') {
        return await this._callOpenAI(prompt, settings, { deep: true });
      } else if (settings.provider === 'claude') {
        return await this._callClaude(prompt, settings, { deep: true });
      } else if (settings.provider === 'custom') {
        return await this._callCustom(prompt, settings, { deep: true });
      }
      return { error: '未知 AI 提供商' };
    } catch (err) {
      return { error: `AI 深度调用失败: ${err.message}` };
    }
  }

  _buildPrompt(reportMarkdown) {
    return `你是一位顶级足球数据分析师团队的负责人，精通亚盘、大小球盘口分析、赔率解读和足球战术分析。
你拥有以下能力：
1. 深度数据分析：精通各类盘口数据、赔率变化规律、球队战绩走势
2. 实时信息整合：你需要结合你所知道的关于这两支球队的最新信息（伤停、阵容、近期状态、转会、教练变动、天气、主场优势等）
3. 辩证思维：从正反两面分析每个推荐，指出支持和反对的证据，最终给出权衡后的结论

## 分析要求
- **必须结合你已知的最新球队动态**：包括近期伤停名单、首发阵容预测、球员状态、转会动态、教练战术调整等
- **辩证分析**：每个推荐必须列出"支持因素"和"风险因素"，不能只说利好
- **赔率解读**：深入分析赔率水位变化背后的含义（庄家意图、资金流向）
- **交叉验证**：用多个维度的数据互相印证，数据矛盾时要明确指出并解释

## 数据报告
${reportMarkdown}

---
请严格按以下格式输出预测报告（不超过2000字）：

## 🔍 赛前情报（基于你的知识库）
- 主队近况：[最新伤停、阵容、状态、战术等你所知的信息]
- 客队近况：[最新伤停、阵容、状态、战术等你所知的信息]
- 关键对位：[影响比赛走势的关键球员/战术匹配]

## 🎯 核心预测
[一句话总结最核心的推荐方向 + 核心逻辑]

## 🏆 全场预测
### 亚让盘
- 盘口倾向：[主队/客队/平手]
- 推荐：[具体推荐，如"主队-0.5让球"]
- ✅ 支持因素：[列出2-3个支持该推荐的数据/信息]
- ⚠️ 风险因素：[列出1-2个可能导致推荐失败的因素]
- 赔率解读：[分析当前赔率水位变化，庄家意图]
- 信心度：[0-100%]

### 大小球
- 推荐：[大球/小球 + 具体进球线，如"大球2.5"]
- ✅ 支持因素：[进攻数据、防守数据、交锋历史等]
- ⚠️ 风险因素：[可能导致走势相反的因素]
- 赔率解读：[大小球赔率水位分析]
- 信心度：[0-100%]

### 角球
- 推荐：[大角球/小角球 + 角球线，如"大角球9.5"]
- 理由：[球队角球数据、战术风格]
- 信心度：[0-100%]

## 🕐 半场预测
- 半场亚盘：[主队/客队/平手让球推荐]
- 半场大小球：[大/小 + 进球线]
- 半场角球：[大/小 + 角球线]
- 理由：[赛事节奏、主客场半场数据、球队慢热/快热特点]
- 信心度：[0-100%]

## 🔢 比分预测
- 最可能比分1：[X:X]（概率约X%）
- 最可能比分2：[X:X]（概率约X%）
- 最可能比分3：[X:X]（概率约X%）
- 分析依据：[基于球队近期进失球数据 + 战术匹配分析]

## 💰 投注建议（基于赔率价值）
| 投注项目 | 推荐方向 | 当前赔率 | 价值评估 | 建议仓位 |
|---------|---------|---------|---------|---------|
| 全场亚盘 | ... | ... | 高/中/低价值 | 低/中/高仓 |
| 全场大小球 | ... | ... | ... | ... |
| 全场角球 | ... | ... | ... | ... |
| 半场亚盘 | ... | ... | ... | ... |
| 比分 | ... | ... | ... | ... |

> 高价值=赔率被低估，值得投注；低价值=赔率过低，性价比差

## ⚠️ 风险提示与辩证总结
- 最大不确定因素：[伤停、赔率异动、天气、心理因素等]
- 数据矛盾点：[如果数据之间有矛盾，明确指出]
- 庄家陷阱警示：[是否存在诱盘可能]

## 📊 综合评分
- 比赛精彩程度：[1-10]
- 数据可靠度：[高/中/低，数据越充分越高]
- 综合推荐信心：[0-100%]
- 重点关注：[最值得投注的1-2个方向，附简要理由]`;
  }

  /**
   * 深度提示词 (2.0)
   * 三层信息：原始数据报告 + 本地量化结论(带推导) + 联网情报线索。
   * 核心原则：量化结论与情报均"仅供参考"，AI 必须独立联网核实并批判性思考。
   */
  _buildDeepPrompt(rawReportMarkdown, quantMarkdown, intelMarkdown) {
    const quantBlock = quantMarkdown
      ? quantMarkdown
      : '### 📐 本地量化模型参考结论\n> 本场未能生成量化结论（数据不足），请完全依赖原始数据与你的联网检索独立判断。';
    const intelBlock = intelMarkdown
      ? intelMarkdown
      : '### 🌐 扩展端联网情报线索\n> 扩展端未检索到情报，请务必使用你自己的联网搜索能力获取最新伤停/阵容/状态信息。';

    return `你是一位顶级足球数据分析师团队的首席决策人，精通亚盘、大小球、赔率解读、统计建模与战术分析。

# 你的工作方式（务必严格遵守）
1. **深度解读已提供的情报**：本次分析已通过扩展端 Tavily 实时搜索为你准备了最新情报（见【扩展端联网情报】部分），请**仔细阅读每条摘要与来源**，从中提取伤停/阵容/近期状态/排名/动机等关键信息，作为分析的重要依据。
2. **三类输入分层对待**：
   - **【原始数据报告】**：来自球探网的盘口/赔率/战绩原始采集数据，这是事实基础，可信度高。
   - **【本地量化模型参考结论】**：扩展用确定性数学（去水概率、泊松、凯利等）算出的结论，**附带了推导方法**。它只是一个统计视角的参考坐标，**不是答案**。模型基于"进球独立泊松"等简化假设，会系统性忽略伤停、战术、动机等因素。**你要理解它怎么来的，判断它在本场是否成立，可以质疑甚至推翻它**，但若推翻需说明理由。
   - **【扩展端联网情报】**：通过 Tavily 实时搜索已为你获取的最新公开网页内容（含标题、摘要、来源），**这是本场分析的重要情报输入，请认真提取并引用**。如发现矛盾或不确定的信息，标注"待确认"，不要编造。
3. **独立综合裁决**：综合以上三类信息，做出**你自己的**专业判断。当量化模型与实时情报冲突时（如模型看好主胜但主力前锋伤停），以真实情报与你的专业判断为准，并解释取舍逻辑。
4. **诚实标注**：凡引用具体情报（如"某球员伤停"），请标注来自哪条情报线索；无法从提供情报中确认的要标注"待确认"，绝不编造。

---

# 【原始数据报告】（球探网采集，事实基础）
${rawReportMarkdown}

---

# ${quantBlock}

---

# ${intelBlock}

---

请先在内部完成联网检索与交叉验证，然后严格按以下格式输出最终报告（结构清晰、有据可依）：

## 🔍 赛前情报核实（务必基于你的最新联网检索）
- 主队最新动态：[伤停/首发/状态/动机 + 信息来源或时效标注]
- 客队最新动态：[同上]
- 关键变量：[影响走势的最关键1-3个因素]
- 与量化模型的差异：[实时情报是否支持/修正了量化模型的假设？具体说明]

## 🧮 对量化模型的采信判断
- 去水概率：[是否采信？为什么]
- 泊松进球模型：[λ估计是否合理？本场是否有模型未捕捉的因素需要修正]
- 价值识别：[模型标出的价值点，结合情报后是否依然成立]

## 🎯 核心预测
[一句话核心推荐方向 + 核心逻辑]

## 🏆 全场预测
### 亚让盘
- 推荐：[具体方向]
- ✅ 支持因素 / ⚠️ 风险因素
- 赔率与盘口解读：[结合水位异动与量化edge]
- 信心度：[0-100%]
### 大小球
- 推荐：[大/小 + 进球线]
- ✅ 支持 / ⚠️ 风险 / 赔率解读 / 信心度
### 角球
- 推荐 + 理由 + 信心度

## 🕐 半场预测
- 半场亚盘 / 半场大小球 / 半场角球 + 理由 + 信心度

## 🔢 比分预测
- 给出3个最可能比分及概率（参考但不照抄泊松TopScores，可结合情报调整）+ 依据

## 💰 投注建议（综合裁决，非照抄模型）
| 投注项目 | 推荐方向 | 当前赔率 | 价值评估 | 建议仓位 |
|---------|---------|---------|---------|---------|
| 全场亚盘 | ... | ... | 高/中高/中/低价值 | 低/中/高仓 |
| 全场大小球 | ... | ... | ... | ... |
| 全场角球 | ... | ... | ... | ... |
| 半场亚盘 | ... | ... | ... | ... |
| 比分 | ... | ... | ... | ... |

> 价值评估须综合"量化edge + 实时情报"给出，并在下方一句话说明你与量化模型结论的异同。

## ⚠️ 风险提示与辩证总结
- 最大不确定因素 / 数据矛盾点 / 庄家陷阱警示
- 信息时效说明：[你检索到的情报截至何时]

## 📊 综合评分
- 数据可靠度：[高/中/低] | 情报充分度：[高/中/低]
- 综合推荐信心：[0-100%]
- 重点关注：[最值得关注的1-2个方向 + 理由]`;
  }

  async _callOpenAI(prompt, settings, opts = {}) {
    const maxTokens = opts.deep ? 4000 : 2000;
    const body = {
      model: settings.model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3
    };
    // 深度模式启用联网搜索工具（兼容支持 web_search 的模型，不支持会被忽略）
    if (opts.deep) {
      body.tools = [{ type: 'web_search' }];
      body.tool_choice = 'auto';
    }
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body)
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

  async _callClaude(prompt, settings, opts = {}) {
    const maxTokens = opts.deep ? 4000 : 2000;
    const body = {
      model: settings.model || 'claude-3-5-sonnet-20241022',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    };
    // 深度模式启用 Claude 原生联网搜索工具
    if (opts.deep) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    }
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    // 联网工具调用会产生多个 content block，需拼接所有 text 块
    const text = Array.isArray(data.content)
      ? data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : (data.content?.[0]?.text || '');
    return {
      provider: 'claude',
      model: data.model,
      content: text,
      tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      generatedAt: new Date().toISOString()
    };
  }

  async _callCustom(prompt, settings, opts = {}) {
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
          max_tokens: opts.deep ? 4000 : 2000,
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
      ? [{ role: 'system', content: `你是一位顶级足球数据分析师，精通亚盘、大小球盘口分析、赔率解读和足球战术分析。
你的分析原则：
1. 结合你所知道的最新球队动态（伤停、阵容、状态、转会等）
2. 辩证思维：从正反两面分析，指出支持和反对的证据
3. 赔率解读：分析水位变化背后的庄家意图
4. 交叉验证：多维度数据互相印证，矛盾时明确指出

以下是当前比赛的完整数据报告：
${systemContext}

请基于以上数据和你的知识库回答用户问题，给出真实准确的分析。` }, ...messages]
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
    const result = await chrome.storage.sync.get(['aiProvider', 'aiApiKey', 'aiModel', 'aiCustomEndpoint', 'tavilyApiKey']);
    return {
      provider: result.aiProvider || 'openai',
      apiKey: result.aiApiKey || '',
      model: result.aiModel || '',
      customEndpoint: result.aiCustomEndpoint || '',
      tavilyApiKey: result.tavilyApiKey || ''
    };
  }
}
