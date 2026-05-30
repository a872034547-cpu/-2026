/**
 * ReportGenerator - 将采集的完整数据整理为结构化 Markdown 报告
 * 适合直接发送给 AI 进行分析预测
 */
export class ReportGenerator {

  generate(stored) {
    const { matchId, fetchTime, data } = stored;
    if (!data) return { text: '无数据', markdown: '# 无数据', structured: {} };

    const { analysis, asian, overunder, corner } = data;
    const home = analysis?.matchInfo?.home || '主队';
    const away = analysis?.matchInfo?.away || '客队';
    const matchTime = analysis?.matchInfo?.time || '';

    const sections = [];

    // ========== 标题 ==========
    sections.push(`# ⚽ 足球比赛数据分析报告`);
    sections.push(`> 比赛ID: ${matchId} | 数据采集: ${new Date(fetchTime).toLocaleString('zh-CN')}`);
    sections.push('');

    // ========== 基本信息 ==========
    sections.push(`## 一、比赛信息`);
    sections.push(`| 项目 | 内容 |`);
    sections.push(`|------|------|`);
    sections.push(`| 对阵 | **${home}** VS **${away}** |`);
    if (matchTime) sections.push(`| 时间 | ${matchTime} |`);
    if (analysis?.matchInfo?.league) sections.push(`| 赛事 | ${analysis.matchInfo.league} |`);
    if (analysis?.matchInfo?.venue) sections.push(`| 场地 | ${analysis.matchInfo.venue} |`);
    if (analysis?.matchInfo?.weather) sections.push(`| 天气 | ${analysis.matchInfo.weather} ${analysis.matchInfo.temperature || ''} |`);
    sections.push('');

    // ========== 赛前简报 ==========
    if (analysis?.preBriefing) {
      sections.push(`## 二、赛前简报（系统分析）`);
      sections.push(`> ${analysis.preBriefing.replace(/\n/g, '\n> ')}`);
      sections.push('');
    }

    // ========== 联赛战绩 ==========
    sections.push(`## 三、联赛战绩统计`);
    sections.push(this._formatFullStats(home, analysis?.homeStats, analysis?.homeHalfStats, 'home'));
    sections.push(this._formatFullStats(away, analysis?.awayStats, analysis?.awayHalfStats, 'away'));

    // ========== 盘路走势 ==========
    sections.push(`## 四、联赛盘路走势`);
    const ht = analysis?.handicapTrend;
    if (ht) {
      sections.push(`### 🏠 ${home}`);
      if (ht.home?.winRates?.length > 0) {
        sections.push(`| 类型 | 赢盘率 |`);
        sections.push(`|------|--------|`);
        const labels = ['全场总', '全场主场', '全场客场', '近6场'];
        ht.home.winRates.forEach((r, i) => { if (r) sections.push(`| ${labels[i]||i} | **${r}%** |`); });
      }
      if (ht.home?.bigBallRates?.length > 0) {
        sections.push(`- 大球率: ${ht.home.bigBallRates.join(' / ')}`);
      }
      if (ht.home?.last6Asian) sections.push(`- 近6场亚让走势: \`${ht.home.last6Asian}\``);
      if (ht.home?.last6OU) sections.push(`- 近6场大小球走势: \`${ht.home.last6OU}\``);
      if (ht.home?.last6HalfAsian) sections.push(`- 近6场半场亚让: \`${ht.home.last6HalfAsian}\``);

      sections.push(`### ✈️ ${away}`);
      if (ht.away?.winRates?.length > 0) {
        sections.push(`| 类型 | 赢盘率 |`);
        sections.push(`|------|--------|`);
        const labels = ['全场总', '全场主场', '全场客场', '近6场'];
        ht.away.winRates.forEach((r, i) => { if (r) sections.push(`| ${labels[i]||i} | **${r}%** |`); });
      }
      if (ht.away?.bigBallRates?.length > 0) {
        sections.push(`- 大球率: ${ht.away.bigBallRates.join(' / ')}`);
      }
      if (ht.away?.last6Asian) sections.push(`- 近6场亚让走势: \`${ht.away.last6Asian}\``);
      if (ht.away?.last6OU) sections.push(`- 近6场大小球走势: \`${ht.away.last6OU}\``);
    }
    sections.push('');

    // ========== 相同盘路历史 ==========
    if (analysis?.sameHandicapHistory?.length > 0) {
      sections.push(`## 五、相同盘口历史走势`);
      analysis.sameHandicapHistory.forEach(block => {
        if (!block.handicap) return;
        sections.push(`**初盘: ${block.handicap}**`);
        if (block.total) {
          sections.push(`- 历史: 赢${block.total.win} 走${block.total.draw} 输${block.total.loss} → 赢盘率 **${block.total.rate}**`);
        }
        if (block.last6) sections.push(`- 近6场: \`${block.last6}\``);
      });
      sections.push('');
    }

    // ========== 进球数据 ==========
    sections.push(`## 六、进球数据分析`);

    // 进球数/单双
    if (analysis?.goalSingleDouble?.homeTotal) {
      const sd = analysis.goalSingleDouble;
      sections.push(`### 进球大小/单双`);
      sections.push(`| 队伍 | 大球 | 小球 | 单数 | 双数 |`);
      sections.push(`|------|------|------|------|------|`);
      const fmtSD = (obj) => obj ? `${obj.big?.pct||'-'}% | ${obj.small?.pct||'-'}% | ${obj.odd?.pct||'-'}% | ${obj.even?.pct||'-'}%` : '-|-|-|-';
      sections.push(`| ${home}总 | ${fmtSD(sd.homeTotal)} |`);
      sections.push(`| ${away}总 | ${fmtSD(sd.awayTotal)} |`);
    }

    // 进球时间分布
    if (analysis?.goalTimeDistribution?.raw?.length > 0) {
      sections.push(`### 进球时间分布 (1-10 | 11-20 | 21-30 | 31-40 | 41-45 | 46-50 | 51-60 | 61-70 | 71-80 | 81-90+)`);
      analysis.goalTimeDistribution.raw.forEach(row => {
        sections.push(`- ${row}`);
      });
    }

    // 数据比较（平均进失球）
    const dc = analysis?.dataComparison;
    if (dc?.home?.avgGoal || dc?.allNumbers?.length > 0) {
      sections.push(`### 关键统计数据`);
      if (dc.home?.avgGoal) sections.push(`- ${home} 平均进球: **${dc.home.avgGoal}** / 平均失球: ${dc.home.avgLoss || '-'}`);
      if (dc.home?.netWin2Plus) sections.push(`- ${home} 净胜2球+: ${dc.home.netWin2Plus.pct}% (${dc.home.netWin2Plus.games}场)`);
      if (dc.home?.totalGoals) sections.push(`- ${home} 本赛季总进球: ${dc.home.totalGoals}`);
    }
    sections.push('');

    // ========== 阵容情况 ==========
    if (analysis?.injuries?.home?.length > 0 || analysis?.injuries?.away?.length > 0) {
      sections.push(`## 七、阵容缺阵情况`);
      if (analysis.injuries.home.length > 0) {
        sections.push(`### 🏠 ${home} 缺阵 (${analysis.injuries.home.length}人)`);
        analysis.injuries.home.forEach(p => {
          sections.push(`- [${p.number}] ${p.name} — ${p.reason}`);
        });
      }
      if (analysis.injuries.away.length > 0) {
        sections.push(`### ✈️ ${away} 缺阵 (${analysis.injuries.away.length}人)`);
        analysis.injuries.away.forEach(p => {
          sections.push(`- [${p.number}] ${p.name} — ${p.reason}`);
        });
      }
      sections.push('');
    }

    // ========== 球员评分 ==========
    const h10 = analysis?.playerRatings?.home10 || analysis?.playerRatings?.home10AvgScores;
    const a10 = analysis?.playerRatings?.away10 || analysis?.playerRatings?.away10AvgScores;
    if (h10?.length > 0 || a10?.length > 0) {
      sections.push(`## 八、近期球队评分`);
      if (h10?.length > 0) {
        const avg = (h10.reduce((s, v) => s + parseFloat(v), 0) / h10.length).toFixed(2);
        sections.push(`- ${home} 近10场平均: **${avg}** | 走势: ${h10.join(' ')}`);
      }
      if (a10?.length > 0) {
        const avg = (a10.reduce((s, v) => s + parseFloat(v), 0) / a10.length).toFixed(2);
        sections.push(`- ${away} 近10场平均: **${avg}** | 走势: ${a10.join(' ')}`);
      }
      sections.push('');
    }

    // ========== 亚让盘口 ==========
    sections.push(`## 九、亚让盘口`);
    if (asian && !asian.error) {
      const sum = asian.summary || {};
      sections.push(`**盘口动向**: 升盘 ${sum.up||0} 家 / 降盘 ${sum.down||0} 家 | 高水 ${sum.highWater||0} 家 / 低水 ${sum.lowWater||0} 家`);
      if (sum.mainLine) sections.push(`**主流盘口共识**: ${sum.mainLine}`);
      sections.push('');

      // 各公司完整盘口
      if (asian.companies?.length > 0) {
        sections.push(`| 公司 | 初盘主 | 初盘口 | 初盘客 | 即时主 | 即时盘 | 即时客 |`);
        sections.push(`|------|--------|--------|--------|--------|--------|--------|`);
        asian.companies.forEach(c => {
          const ml = c.mainLine || c;
          const initChanged = ml.initialHandicap !== ml.currentHandicap;
          sections.push(`| ${c.name} | ${ml.initialHome} | ${ml.initialHandicap} | ${ml.initialAway} | ${ml.currentHome} | **${ml.currentHandicap}**${initChanged ? ' ⚠️' : ''} | ${ml.currentAway} |`);
          // 子盘线
          if (c.subLines?.length > 0) {
            c.subLines.forEach(sub => {
              sections.push(`| └${sub.label} | ${sub.initialHome} | ${sub.initialHandicap} | ${sub.initialAway} | ${sub.currentHome} | ${sub.currentHandicap} | ${sub.currentAway} |`);
            });
          }
        });
      }

      // 历史变化记录
      if (asian.history?.length > 0) {
        sections.push('');
        sections.push(`**盘口变化记录** (最近 ${Math.min(15, asian.history.length)} 条)`);
        sections.push(`| 时间 | 盘口 | 主水 | 客水 |`);
        sections.push(`|------|------|------|------|`);
        asian.history.slice(0, 15).forEach(h => {
          sections.push(`| ${h.time} | ${h.line} | ${h.v1} | ${h.v2} |`);
        });
      }
    } else {
      sections.push('*亚让盘数据获取失败*');
    }
    sections.push('');

    // ========== 大小球 ==========
    sections.push(`## 十、大小球（进球数）`);
    if (overunder && !overunder.error) {
      const sum = overunder.summary || {};
      sections.push(`**盘口动向**: 升盘 ${sum.up||0} 家 / 降盘 ${sum.down||0} 家`);
      if (sum.mainLine) sections.push(`**主流进球线共识**: ${sum.mainLine}`);
      if (sum.lineConsensus) {
        const consensusStr = Object.entries(sum.lineConsensus).sort((a,b) => b[1]-a[1])
          .map(([k,v]) => `${k}(${v}家)`).join(' / ');
        sections.push(`**各档进球线分布**: ${consensusStr}`);
      }
      sections.push('');

      if (overunder.companies?.length > 0) {
        sections.push(`| 公司 | 初盘大 | 初盘线 | 初盘小 | 即时大 | 即时线 | 即时小 |`);
        sections.push(`|------|--------|--------|--------|--------|--------|--------|`);
        overunder.companies.forEach(c => {
          const ml = c.mainLine || c;
          const lineChanged = ml.initialLine !== ml.currentLine;
          sections.push(`| ${c.name} | ${ml.initialOver} | ${ml.initialLine} | ${ml.initialUnder} | ${ml.currentOver} | **${ml.currentLine}**${lineChanged ? ' ⚠️' : ''} | ${ml.currentUnder} |`);
          if (c.subLines?.length > 0) {
            c.subLines.forEach(sub => {
              sections.push(`| └${sub.label} | ${sub.initialOver} | ${sub.initialLine} | ${sub.initialUnder} | ${sub.currentOver} | ${sub.currentLine} | ${sub.currentUnder} |`);
            });
          }
        });
      }

      // 历史变化记录
      if (overunder.history?.length > 0) {
        sections.push('');
        sections.push(`**进球线变化记录** (最近 ${Math.min(15, overunder.history.length)} 条)`);
        sections.push(`| 时间 | 盘口 | 大球水 | 小球水 |`);
        sections.push(`|------|------|--------|--------|`);
        overunder.history.slice(0, 15).forEach(h => {
          sections.push(`| ${h.time} | ${h.line} | ${h.v1} | ${h.v2} |`);
        });
      }
    } else {
      sections.push('*大小球数据获取失败*');
    }
    sections.push('');

    // ========== 角球 ==========
    sections.push(`## 十一、角球盘口`);
    if (corner && !corner.error && corner.companies?.length > 0) {
      sections.push(`| 公司 | 初盘大 | 角球线 | 初盘小 | 即时大 | 即时线 | 即时小 |`);
      sections.push(`|------|--------|--------|--------|--------|--------|--------|`);
      corner.companies.forEach(c => {
        const lineChanged = c.initialLine !== c.currentLine;
        sections.push(`| ${c.name} | ${c.initialOver} | ${c.initialLine} | ${c.initialUnder} | ${c.currentOver} | **${c.currentLine}**${lineChanged ? ' ⚠️' : ''} | ${c.currentUnder} |`);
      });
    } else if (corner?.mainLine) {
      sections.push(`**主流角球线**: ${corner.mainLine} | 大球水: ${corner.mainOver} | 小球水: ${corner.mainUnder}`);
    } else {
      sections.push('*角球数据获取失败*');
    }
    sections.push('');

    // ========== AI 分析请求 ==========
    sections.push('---');
    sections.push(`## 📊 AI 分析请求`);
    sections.push(`请你作为专业足球数据分析师，基于以上完整数据对"**${home} vs ${away}**"进行深度分析：`);
    sections.push('');
    sections.push('**请分析以下6个维度并给出明确推荐：**');
    sections.push('');
    sections.push('1. **亚让盘** - 分析盘口变化、水位流向、升降盘趋势，给出推荐方向及信心度');
    sections.push('2. **大小球** - 结合进球线变化、双方进球率、近期走势，推荐大/小球');
    sections.push('3. **角球** - 分析角球盘口是否合理，推荐大/小角球');
    sections.push('4. **赛前简报解读** - 结合阵容情况（缺阵人数、位置）分析战力影响');
    sections.push('5. **盘路走势解读** - 分析赢盘率、相同盘口历史数据的参考价值');
    sections.push('6. **综合推荐** - 给出最终推荐方案（含具体盘口、方向、信心度0-100%）');
    sections.push('');
    sections.push('**输出格式要求**: 结构清晰，每个维度一段，最后给出"最佳推荐"汇总表格');

    const markdown = sections.join('\n');
    const plainText = markdown.replace(/[#*|`_>]/g, '').replace(/\n{3,}/g, '\n\n');

    return {
      text: plainText,
      markdown,
      structured: {
        matchInfo: analysis?.matchInfo,
        home, away,
        asian: asian?.keyOdds,
        overunder: overunder?.keyOdds,
        corner: { mainLine: corner?.mainLine, companies: corner?.companies?.slice(0,3) },
        injuries: analysis?.injuries,
        preBriefing: analysis?.preBriefing,
        summary: this._quickSummary(analysis, asian, overunder)
      }
    };
  }

  _quickSummary(analysis, asian, overunder) {
    const summary = [];
    if (asian?.summary) {
      const s = asian.summary;
      summary.push(`亚让盘：升${s.up}降${s.down}，高水${s.highWater}低水${s.lowWater}，主流盘${s.mainLine||'未知'}`);
    }
    if (overunder?.summary) {
      const s = overunder.summary;
      summary.push(`大小球：升${s.up}降${s.down}，主流线${s.mainLine||'未知'}`);
    }
    if (analysis?.preBriefing) {
      summary.push(`简报摘要：${analysis.preBriefing.substring(0, 100)}...`);
    }
    if (analysis?.injuries) {
      const hi = analysis.injuries.home?.length || 0;
      const ai = analysis.injuries.away?.length || 0;
      if (hi > 0 || ai > 0) summary.push(`伤停：主队${hi}人 / 客队${ai}人`);
    }
    return summary;
  }

  _formatFullStats(teamName, fullStats, halfStats, side) {
    let text = `### ${side === 'home' ? '🏠 主队' : '✈️ 客队'}: ${teamName}\n`;

    if (fullStats?.total) {
      const t = fullStats.total;
      text += `**全场**: ${t.played}场 ${t.win}胜${t.draw}平${t.loss}负 | 进${t.goalsFor}失${t.goalsAgainst} | 积分${t.points} | 排名第${t.rank} | 胜率**${t.winRate}**\n`;
    }
    if (fullStats?.home) {
      const h = fullStats.home;
      text += `- 主场: ${h.played}场 ${h.win}胜${h.draw}平${h.loss}负 进${h.goalsFor}失${h.goalsAgainst} 胜率${h.winRate}\n`;
    }
    if (fullStats?.away) {
      const a = fullStats.away;
      text += `- 客场: ${a.played}场 ${a.win}胜${a.draw}平${a.loss}负 进${a.goalsFor}失${a.goalsAgainst} 胜率${a.winRate}\n`;
    }
    if (fullStats?.last6) {
      const l = fullStats.last6;
      text += `- 近6场: ${l.win}胜${l.draw}平${l.loss}负 进${l.goalsFor}失${l.goalsAgainst}\n`;
    }

    if (halfStats?.total) {
      const t = halfStats.total;
      text += `**半场**: ${t.played}场 ${t.win}胜${t.draw}平${t.loss}负 | 胜率${t.winRate}\n`;
    }

    return text + '\n';
  }
}
