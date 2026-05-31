/**
 * quant-engine.js — 本地量化引擎 (2.0)
 *
 * 纯确定性数学计算，零API成本。所有结论均附带 `method` 字段说明推导过程，
 * 供 AI 参考而非照抄。AI 应基于这些结论做独立批判性裁决。
 *
 * 提供能力：
 *  1. 去水真实概率（remove margin / overround）
 *  2. 泊松比分矩阵 → 胜平负/大小球/比分概率
 *  3. 价值识别（模型概率 vs 市场概率 → +EV）
 *  4. 凯利公式仓位建议
 *  5. 赔率异动信号（初盘 → 即时）
 *
 * 设计原则：
 *  - 任何无法可靠计算的项，返回 null 并在 notes 中说明原因，绝不编造。
 *  - 每个输出对象都带 method（中文推导说明）。
 */

// ---------------------------------------------------------------------------
// 基础数学工具
// ---------------------------------------------------------------------------

/** 安全解析浮点；非法返回 NaN */
function num(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[^0-9.+\-]/g, '');
  if (s === '' || s === '+' || s === '-' || s === '.') return NaN;
  return parseFloat(s);
}

function isPos(n) { return typeof n === 'number' && isFinite(n) && n > 0; }

/**
 * 将"亚洲水位"(payout, 约0.6~1.2)转为十进制赔率(=水位+1)。
 * 已是欧洲十进制赔率(>1.3)的原样返回。用于把大小球/亚盘水位接入价值评估。
 */
function toDecimalOdds(v) {
  const n = num(v);
  if (!isFinite(n) || n <= 0) return NaN;
  if (n > 1.3) return n;        // 已是十进制赔率
  return n + 1;                 // 水位 → 十进制
}

/** 阶乘（带缓存，k 较小） */
const _factCache = [1, 1];
function factorial(k) {
  if (k < 0) return NaN;
  if (_factCache[k] !== undefined) return _factCache[k];
  let r = _factCache[_factCache.length - 1];
  for (let i = _factCache.length; i <= k; i++) {
    r *= i;
    _factCache[i] = r;
  }
  return _factCache[k];
}

/** 泊松概率质量函数 P(X=k; λ) = e^(-λ)·λ^k / k! */
function poissonPmf(k, lambda) {
  if (!isPos(lambda) || k < 0) return 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function round(n, d = 4) {
  if (!isFinite(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function pct(n, d = 1) {
  if (!isFinite(n)) return null;
  return round(n * 100, d);
}

// ---------------------------------------------------------------------------
// 1) 去水真实概率
// ---------------------------------------------------------------------------

/**
 * 由胜平负欧赔计算去水后的真实概率。
 * 输入 odds: { win, draw, loss } 十进制赔率
 * 方法：隐含概率 q_i = 1/o_i（含抽水，三者之和=overround>1）；
 *       去水真实概率 p_i = q_i / Σq_j。
 */
function deMargin(odds) {
  const w = num(odds?.win), d = num(odds?.draw), l = num(odds?.loss);
  if (!isPos(w) || !isPos(d) || !isPos(l)) {
    return {
      ok: false,
      notes: '胜平负赔率不完整，无法去水',
      method: 'q_i=1/o_i; p_i=q_i/Σq_j'
    };
  }
  const qw = 1 / w, qd = 1 / d, ql = 1 / l;
  const overround = qw + qd + ql;            // 博彩公司总抽水后的概率和
  const margin = overround - 1;              // 抽水率
  return {
    ok: true,
    impliedRaw: { win: pct(qw), draw: pct(qd), loss: pct(ql) },
    overround: round(overround, 4),
    marginPct: pct(margin),
    trueProb: {
      win: pct(qw / overround),
      draw: pct(qd / overround),
      loss: pct(ql / overround)
    },
    method: '隐含概率 q=1/赔率（和为overround，多出部分=抽水）；去水真实概率 p=q/Σq。抽水越低说明市场越有效。'
  };
}

// ---------------------------------------------------------------------------
// 2) 泊松模型
// ---------------------------------------------------------------------------

/**
 * 估计两队期望进球 λ。
 * 输入：
 *   homeFor / homeAgainst：主队场均进球 / 失球
 *   awayFor / awayAgainst：客队场均进球 / 失球
 *   leagueAvg：联赛场均进球（缺失时用 (homeFor+awayFor)/2 兜底）
 * 方法（攻防交叉，含主场增益）：
 *   λ主 = 主队进攻力 × 客队防守弱点 × 联赛基准 × 主场系数
 * 这里用简化稳健版：
 *   λ主 = homeFor × (awayAgainst / leagueAvg) × homeBoost
 *   λ客 = awayFor × (homeAgainst / leagueAvg)
 */
function estimateLambda(input) {
  const hf = num(input?.homeFor), ha = num(input?.homeAgainst);
  const af = num(input?.awayFor), aa = num(input?.awayAgainst);
  let lg = num(input?.leagueAvg);

  const have = [hf, af].every(isFinite);
  if (!have) {
    return { ok: false, notes: '缺少双方场均进球数据，无法估计λ', method: 'λ主=homeFor×(awayAgainst/联赛均)×主场系数' };
  }
  if (!isPos(lg)) {
    // 联赛基准兜底：用双方场均进球均值
    lg = (Math.max(hf, 0) + Math.max(af, 0)) / 2;
    if (!isPos(lg)) lg = 1.3; // 全球足球场均进球经验值
  }

  const homeBoost = isPos(num(input?.homeBoost)) ? num(input.homeBoost) : 1.10; // 主场增益经验值
  const defH = isFinite(aa) && isPos(lg) ? (aa / lg) : 1; // 客队防守弱点系数
  const defA = isFinite(ha) && isPos(lg) ? (ha / lg) : 1; // 主队防守弱点系数

  let lambdaHome = Math.max(0.05, hf * defH * homeBoost);
  let lambdaAway = Math.max(0.05, af * defA);

  // 上限保护，避免异常数据导致 λ 爆炸
  lambdaHome = Math.min(lambdaHome, 6);
  lambdaAway = Math.min(lambdaAway, 6);

  return {
    ok: true,
    lambdaHome: round(lambdaHome, 3),
    lambdaAway: round(lambdaAway, 3),
    leagueAvgUsed: round(lg, 3),
    homeBoost,
    method: 'λ主=主队场均进球×(客队场均失球/联赛均)×主场系数(默认1.10)；λ客=客队场均进球×(主队场均失球/联赛均)。攻防交叉法。'
  };
}

/**
 * 基于 λ主/λ客 构建比分联合概率矩阵（假设两队进球独立泊松）。
 * 返回胜平负、大小球、最可能比分。
 */
function poissonModel(lambdaHome, lambdaAway, opts = {}) {
  const maxGoals = opts.maxGoals || 8;
  const ouLines = opts.ouLines || [0.5, 1.5, 2.5, 3.5];
  if (!isPos(lambdaHome) || !isPos(lambdaAway)) {
    return { ok: false, notes: 'λ无效，无法运行泊松模型' };
  }

  const ph = [], pa = [];
  for (let i = 0; i <= maxGoals; i++) {
    ph[i] = poissonPmf(i, lambdaHome);
    pa[i] = poissonPmf(i, lambdaAway);
  }

  let pWin = 0, pDraw = 0, pLoss = 0;
  const scoreList = [];
  // 大小球累计
  const overProb = {}; ouLines.forEach(L => overProb[L] = 0);

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = ph[i] * pa[j];
      if (i > j) pWin += p; else if (i === j) pDraw += p; else pLoss += p;
      scoreList.push({ home: i, away: j, p });
      const total = i + j;
      ouLines.forEach(L => { if (total > L) overProb[L] += p; });
    }
  }

  scoreList.sort((a, b) => b.p - a.p);
  const topScores = scoreList.slice(0, 5).map(s => ({
    score: `${s.home}:${s.away}`,
    prob: pct(s.p)
  }));

  const overUnder = ouLines.map(L => ({
    line: L,
    over: pct(overProb[L]),
    under: pct(1 - overProb[L])
  }));

  // BTTS（双方进球）
  const pHomeScore = 1 - ph[0];
  const pAwayScore = 1 - pa[0];
  const bttsYes = pHomeScore * pAwayScore;

  return {
    ok: true,
    lambdaHome: round(lambdaHome, 3),
    lambdaAway: round(lambdaAway, 3),
    outcome: { win: pct(pWin), draw: pct(pDraw), loss: pct(pLoss) },
    expectedGoals: round(lambdaHome + lambdaAway, 2),
    topScores,
    overUnder,
    btts: { yes: pct(bttsYes), no: pct(1 - bttsYes) },
    method: '假设两队进球服从独立泊松分布：P(比分i:j)=P(i;λ主)·P(j;λ客)；胜=Σ_{i>j}，平=Σ_{i=j}，负=Σ_{i<j}；大N=Σ_{i+j>N}。'
  };
}

// ---------------------------------------------------------------------------
// 3) 价值识别 + 4) 凯利
// ---------------------------------------------------------------------------

/**
 * 凯利公式仓位。
 * f = (b·p − q)/b，b=赔率−1，p=命中概率，q=1−p。
 * f<=0 → 无价值，不投。实战用分数凯利降波动。
 */
function kelly(prob, decimalOdds, fraction = 0.25) {
  const p = num(prob), o = num(decimalOdds);
  if (!(p > 0 && p < 1) || !isPos(o) || o <= 1) {
    return { ok: false, full: null, suggested: null, notes: '概率或赔率无效' };
  }
  const b = o - 1, q = 1 - p;
  const full = (b * p - q) / b;
  const suggested = Math.max(0, full * fraction);
  return {
    ok: true,
    fullKelly: round(full, 4),
    fractionalKelly: round(suggested, 4),
    fraction,
    method: `凯利 f=(b·p−q)/b，b=赔率−1。f≤0不投。建议用${fraction}分数凯利(f×${fraction})降低破产风险。`
  };
}

/**
 * 单个投注项的价值评估：对比模型真实概率与市场赔率隐含概率。
 * edge = modelProb − marketImplied；edge>0 即 +EV。
 */
function evaluateValue(label, modelProb, decimalOdds) {
  const p = num(modelProb), o = num(decimalOdds);
  if (!(p > 0 && p < 1) || !isPos(o) || o <= 1) {
    return { label, ok: false, notes: '数据不足，跳过' };
  }
  const marketImplied = 1 / o;          // 含抽水隐含概率
  const edge = p - marketImplied;       // 优势（正=低估，值得投）
  const ev = p * (o - 1) - (1 - p);     // 每1单位的期望收益
  const k = kelly(p, o, 0.25);

  let tier;
  if (edge >= 0.08) tier = '高价值';
  else if (edge >= 0.04) tier = '中高价值';
  else if (edge >= 0.01) tier = '中价值';
  else if (edge >= -0.02) tier = '中性';
  else tier = '低价值';

  return {
    label,
    ok: true,
    modelProb: pct(p),
    marketImplied: pct(marketImplied),
    edgePct: pct(edge),
    expectedValue: round(ev, 4),
    tier,
    kelly: k.ok ? k.fractionalKelly : null,
    method: 'edge=模型真实概率−市场隐含概率(1/赔率)；edge>0为+EV(低估)。EV=p·(赔率−1)−(1−p)。仓位用1/4凯利。'
  };
}

// ---------------------------------------------------------------------------
// 5) 赔率异动信号（初盘 → 即时）
// ---------------------------------------------------------------------------

/**
 * 检测水位/盘口异动。输入关键盘口对象（含 initial / current 字段）。
 * 临场水位大幅下调常代表资金流入（聪明钱）。
 */
function oddsMovement(keyOdds) {
  const signals = [];
  if (!keyOdds) return { ok: false, signals, notes: '无盘口数据' };

  const ao = keyOdds.ao || keyOdds;
  const ih = num(ao.initialHome ?? ao.initialHomePay);
  const ch = num(ao.currentHome ?? ao.currentHomePay);
  const ia = num(ao.initialAway ?? ao.initialAwayPay);
  const ca = num(ao.currentAway ?? ao.currentAwayPay);
  const ihc = num(ao.initialHandicap);
  const chc = num(ao.currentHandicap);

  if (isFinite(ih) && isFinite(ch)) {
    const dHome = ch - ih;
    if (Math.abs(dHome) >= 0.06) {
      signals.push({
        market: '亚盘主水',
        change: round(dHome, 3),
        msg: dHome < 0
          ? `主队水位下调(${ih}→${ch})，资金流向主队`
          : `主队水位上调(${ih}→${ch})，主队receiving减弱`,
        strength: Math.abs(dHome) >= 0.12 ? 'strong' : 'medium'
      });
    }
  }
  if (isFinite(ia) && isFinite(ca)) {
    const dAway = ca - ia;
    if (Math.abs(dAway) >= 0.06) {
      signals.push({
        market: '亚盘客水',
        change: round(dAway, 3),
        msg: dAway < 0
          ? `客队水位下调(${ia}→${ca})，资金流向客队`
          : `客队水位上调(${ia}→${ca})，客队receiving减弱`,
        strength: Math.abs(dAway) >= 0.12 ? 'strong' : 'medium'
      });
    }
  }
  if (isFinite(ihc) && isFinite(chc) && ihc !== chc) {
    signals.push({
      market: '亚盘盘口',
      change: round(chc - ihc, 3),
      msg: `盘口由 ${ihc} 升降至 ${chc}`,
      strength: Math.abs(chc - ihc) >= 0.25 ? 'strong' : 'medium'
    });
  }

  return {
    ok: true,
    signals,
    method: '对比初盘与即时水位/盘口。临场水位明显下调(≥0.06)常代表资金流入该侧(聪明钱)；盘口升降反映庄家对实力差的重新评估。'
  };
}

// ---------------------------------------------------------------------------
// 主入口：综合量化分析
// ---------------------------------------------------------------------------

/**
 * 综合分析。输入 matchData（含 winDrawWin/asian/overunder/analysis 等采集结构）
 * 以及可选 recentStats（近期场均进失球）。
 * 返回结构化量化结论，全部带 method 说明。
 */
function analyze(matchData, recentStats) {
  const out = {
    generatedAt: new Date().toISOString(),
    deMargin: null,
    lambda: null,
    poisson: null,
    valueBets: [],
    movement: null,
    notes: [],
    disclaimer: '以下为本地数学模型推导结果，仅供AI参考与交叉验证，不可直接照抄；模型基于统计假设，存在系统性偏差，需结合实时情报与盘口独立判断。'
  };

  const wdw = matchData?.winDrawWin || {};
  const asian = matchData?.asian || {};
  const ou = matchData?.overunder || {};

  // --- 去水概率：优先用全市场即时均值赔率(averageCurrent)，更稳健；否则退关键公司/首家 ---
  let wdwOdds = null;
  let wdwOddsSource = '';
  const ac = wdw.summary?.averageCurrent;
  if (ac && isPos(num(ac.win)) && isPos(num(ac.draw)) && isPos(num(ac.loss))) {
    wdwOdds = { win: ac.win, draw: ac.draw, loss: ac.loss };
    wdwOddsSource = '全市场即时均值';
  }
  if (!wdwOdds && wdw.keyOdds?.ao) {
    const k = wdw.keyOdds.ao;
    wdwOdds = {
      win: k.currentWin ?? k.currentHome ?? k.initialWin,
      draw: k.currentDraw ?? k.initialDraw,
      loss: k.currentLoss ?? k.currentAway ?? k.initialLoss
    };
    wdwOddsSource = '关键公司(' + (k.name || '首家') + ')即时';
  }
  if (!wdwOdds && Array.isArray(wdw.keyOdds?.allCurrent) && wdw.keyOdds.allCurrent[0]) {
    const a = wdw.keyOdds.allCurrent[0];
    wdwOdds = { win: a.win ?? a.home, draw: a.draw, loss: a.loss ?? a.away };
    wdwOddsSource = '首家公司即时';
  }
  if (wdwOdds) {
    out.deMargin = deMargin(wdwOdds);
    if (out.deMargin) out.deMargin.oddsSource = wdwOddsSource;
  } else {
    out.notes.push('未获取到可用的胜平负赔率，跳过去水概率计算');
  }

  // --- 泊松模型：需要近期进失球数据 ---
  if (recentStats && (recentStats.homeFor !== undefined || recentStats.home)) {
    const li = estimateLambda(normalizeRecent(recentStats));
    out.lambda = li;
    if (li.ok) {
      out.poisson = poissonModel(li.lambdaHome, li.lambdaAway);
    }
  } else {
    out.notes.push('未提供近期场均进失球(recentStats)，无法运行泊松模型；可在滚球/分析页补充该数据');
  }

  // --- 价值识别：用泊松模型概率 vs 市场赔率 ---
  if (out.poisson?.ok && wdwOdds) {
    const o = {
      win: num(wdwOdds.win),
      draw: num(wdwOdds.draw),
      loss: num(wdwOdds.loss)
    };
    const mp = out.poisson.outcome;
    if (isFinite(o.win)) out.valueBets.push(evaluateValue('主胜', (mp.win || 0) / 100, o.win));
    if (isFinite(o.draw)) out.valueBets.push(evaluateValue('平局', (mp.draw || 0) / 100, o.draw));
    if (isFinite(o.loss)) out.valueBets.push(evaluateValue('客胜', (mp.loss || 0) / 100, o.loss));
  }
  // 大小球价值（若有大小球赔率与泊松大小球概率）
  // 注意：titan007 大小球赔率是"亚洲水位"(payout，约0.7~1.05)，需转十进制赔率(=水位+1)再评估价值
  if (out.poisson?.ok && ou.keyOdds?.ao) {
    const line = num(ou.keyOdds.ao.currentLine ?? ou.keyOdds.ao.initialLine);
    const overOdds = toDecimalOdds(ou.keyOdds.ao.currentOver ?? ou.keyOdds.ao.initialOver);
    const underOdds = toDecimalOdds(ou.keyOdds.ao.currentUnder ?? ou.keyOdds.ao.initialUnder);
    const match = out.poisson.overUnder.find(x => Math.abs(x.line - line) < 0.01);
    if (match) {
      if (isFinite(overOdds)) out.valueBets.push(evaluateValue(`大${line}球`, (match.over || 0) / 100, overOdds));
      if (isFinite(underOdds)) out.valueBets.push(evaluateValue(`小${line}球`, (match.under || 0) / 100, underOdds));
    }
  }
  out.valueBets = out.valueBets.filter(v => v && v.ok);

  // --- 赔率异动 ---
  out.movement = oddsMovement(asian.keyOdds);

  return out;
}

/** 把多种 recentStats 形态归一为 estimateLambda 所需输入 */
function normalizeRecent(rs) {
  if (!rs) return {};
  // 形态A：已是 {homeFor, homeAgainst, awayFor, awayAgainst, leagueAvg}
  if (rs.homeFor !== undefined || rs.awayFor !== undefined) return rs;
  // 形态B：来自滚球页 recentStats.home/away[label]={n3,n10}
  const pickAvg = (obj, label) => {
    const o = obj?.[label];
    if (!o) return NaN;
    const n10 = num(o.n10), n3 = num(o.n3);
    if (isFinite(n10)) return n10;
    if (isFinite(n3)) return n3;
    return NaN;
  };
  return {
    homeFor: pickAvg(rs.home, '进球'),
    homeAgainst: pickAvg(rs.home, '失球'),
    awayFor: pickAvg(rs.away, '进球'),
    awayAgainst: pickAvg(rs.away, '失球'),
    leagueAvg: rs.leagueAvg
  };
}

// ---------------------------------------------------------------------------
// 渲染为 Markdown（供注入 AI 提示词 / 前端展示）
// ---------------------------------------------------------------------------

function toMarkdown(result) {
  if (!result) return '';
  const L = [];
  L.push('### 📐 本地量化模型参考结论');
  L.push('> ' + result.disclaimer);
  L.push('');

  if (result.deMargin?.ok) {
    const d = result.deMargin;
    L.push('**1. 去水真实概率**（' + d.method + '）');
    if (d.oddsSource) L.push(`- 赔率取值：${d.oddsSource}`);
    L.push(`- 抽水率：${d.marginPct}%（overround=${d.overround}）`);
    L.push(`- 去水概率：主胜 ${d.trueProb.win}% / 平 ${d.trueProb.draw}% / 客胜 ${d.trueProb.loss}%`);
    L.push('');
  }

  if (result.lambda?.ok && result.poisson?.ok) {
    const p = result.poisson;
    L.push('**2. 泊松进球模型**（' + result.lambda.method + '）');
    L.push(`- 期望进球 λ：主 ${p.lambdaHome} / 客 ${p.lambdaAway}（合计 ${p.expectedGoals}）`);
    L.push(`- 模型胜平负：主胜 ${p.outcome.win}% / 平 ${p.outcome.draw}% / 客胜 ${p.outcome.loss}%`);
    L.push(`- 最可能比分：${p.topScores.map(s => s.score + '(' + s.prob + '%)').join('、')}`);
    L.push(`- 大小球：${p.overUnder.map(x => '大' + x.line + '=' + x.over + '%').join(' / ')}`);
    L.push(`- 双方进球(BTTS)：是 ${p.btts.yes}% / 否 ${p.btts.no}%`);
    L.push('');
  }

  if (result.valueBets?.length) {
    L.push('**3. 价值识别**（edge=模型概率−市场隐含概率，>0为低估+EV；仓位=1/4凯利）');
    L.push('| 项目 | 模型概率 | 市场隐含 | edge | 评级 | 凯利仓位 |');
    L.push('|---|---|---|---|---|---|');
    result.valueBets.forEach(v => {
      L.push(`| ${v.label} | ${v.modelProb}% | ${v.marketImplied}% | ${v.edgePct}% | ${v.tier} | ${v.kelly != null ? (v.kelly * 100).toFixed(1) + '%' : '-'} |`);
    });
    L.push('');
  }

  if (result.movement?.ok && result.movement.signals.length) {
    L.push('**4. 赔率异动信号**（' + result.movement.method + '）');
    result.movement.signals.forEach(s => {
      L.push(`- [${s.strength === 'strong' ? '强' : '中'}] ${s.market}：${s.msg}`);
    });
    L.push('');
  }

  if (result.notes?.length) {
    L.push('**模型数据局限**：');
    result.notes.forEach(n => L.push(`- ${n}`));
    L.push('');
  }

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 导出（ESM）+ 自测兼容（Node CommonJS）
// ---------------------------------------------------------------------------

const QuantEngine = {
  num, poissonPmf, factorial,
  deMargin, estimateLambda, poissonModel,
  kelly, evaluateValue, oddsMovement,
  analyze, normalizeRecent, toMarkdown
};

export {
  deMargin, estimateLambda, poissonModel, kelly, evaluateValue,
  oddsMovement, analyze, toMarkdown, poissonPmf, QuantEngine
};

// Node 自测入口（`node js/quant-engine.js --selftest`）
if (typeof process !== 'undefined' && process.argv && process.argv.includes('--selftest')) {
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } else console.log('PASS: ' + msg); };

  // 去水：1/2.0+1/3.0+1/4.0 = 0.5+0.333+0.25 = 1.0833 → 主胜=0.5/1.0833≈46.15%
  const dm = deMargin({ win: 2.0, draw: 3.0, loss: 4.0 });
  assert(dm.ok && Math.abs(dm.trueProb.win - 46.15) < 0.2, '去水概率主胜≈46.15% (得到 ' + dm.trueProb.win + ')');
  assert(Math.abs(dm.marginPct - 8.33) < 0.2, '抽水率≈8.33% (得到 ' + dm.marginPct + ')');

  // 泊松：λ=1.5,1.5 → P(0:0)=e^-3≈0.0498
  const p00 = poissonPmf(0, 1.5) * poissonPmf(0, 1.5);
  assert(Math.abs(p00 - Math.exp(-3)) < 1e-6, 'P(0:0|λ=1.5,1.5)=e^-3 (得到 ' + p00.toFixed(5) + ')');

  const pm = poissonModel(1.5, 1.2);
  assert(pm.ok, '泊松模型运行成功');
  const sum = (pm.outcome.win + pm.outcome.draw + pm.outcome.loss);
  assert(Math.abs(sum - 100) < 1.5, '胜平负概率和≈100% (得到 ' + sum.toFixed(1) + ')');
  assert(pm.outcome.win > pm.outcome.loss, 'λ主>λ客时主胜概率应更大');

  // 凯利：p=0.5, o=2.2 → b=1.2, f=(1.2*0.5-0.5)/1.2=0.0833
  const k = kelly(0.5, 2.2, 1);
  assert(Math.abs(k.fullKelly - 0.0833) < 0.001, '凯利 f≈0.0833 (得到 ' + k.fullKelly + ')');

  // 价值：模型60%，赔率2.0(隐含50%) → edge=10% 高价值
  const ev = evaluateValue('主胜', 0.6, 2.0);
  assert(ev.ok && ev.tier === '高价值' && Math.abs(ev.edgePct - 10) < 0.1, '价值评级=高价值, edge≈10% (得到 ' + ev.edgePct + ')');

  // λ估计
  const li = estimateLambda({ homeFor: 1.8, homeAgainst: 1.0, awayFor: 1.2, awayAgainst: 1.4, leagueAvg: 1.3 });
  assert(li.ok && li.lambdaHome > li.lambdaAway, 'λ估计：强主队λ主>λ客 (主=' + li.lambdaHome + ', 客=' + li.lambdaAway + ')');

  // analyze 端到端
  const res = analyze(
    { winDrawWin: { keyOdds: { ao: { currentWin: 2.0, currentDraw: 3.3, currentLoss: 3.6 } } }, asian: {}, overunder: {} },
    { home: { 进球: { n10: 1.8 }, 失球: { n10: 1.0 } }, away: { 进球: { n10: 1.2 }, 失球: { n10: 1.4 } }, leagueAvg: 1.3 }
  );
  assert(res.deMargin?.ok, 'analyze: 去水概率计算成功');
  assert(res.poisson?.ok, 'analyze: 泊松模型计算成功');
  assert(res.valueBets.length >= 3, 'analyze: 生成价值评估项 (' + res.valueBets.length + ')');
  const md = toMarkdown(res);
  assert(md.includes('量化模型参考结论') && md.includes('泊松'), 'toMarkdown: 输出含关键章节');

  // analyze2：优先全市场均值赔率(averageCurrent) + 赔率异动 + 大小球价值
  const res2 = analyze(
    {
      winDrawWin: { summary: { averageCurrent: { win: '2.10', draw: '3.30', loss: '3.40' } } },
      asian: { keyOdds: { ao: { initialHome: '0.95', currentHome: '0.78', initialAway: '0.95', currentAway: '1.05', initialHandicap: '-0.5', currentHandicap: '-0.5' } } },
      overunder: { keyOdds: { ao: { currentLine: 2.5, currentOver: '0.90', currentUnder: '0.95' } } }
    },
    { home: { 进球: { n10: 1.8 }, 失球: { n10: 1.0 } }, away: { 进球: { n10: 1.2 }, 失球: { n10: 1.4 } }, leagueAvg: 1.3 }
  );
  assert(res2.deMargin?.ok && res2.deMargin.oddsSource === '全市场即时均值', 'analyze2: 优先采用全市场均值赔率 (' + res2.deMargin?.oddsSource + ')');
  assert(res2.movement?.ok && res2.movement.signals.length > 0, 'analyze2: 检出赔率异动信号 (' + (res2.movement?.signals.length || 0) + ')');
  assert(res2.valueBets.some(v => /2\.5球/.test(v.label)), 'analyze2: 含大小球价值评估');

  console.log('\n✅ quant-engine 全部自测通过');
}
