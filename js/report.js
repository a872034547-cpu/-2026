/**
 * ReportGenerator - 将采集的完整数据整理为结构化 Markdown 报告
 * 适合直接发送给 AI 进行分析预测
 */
export class ReportGenerator {

  generate(stored) {
    const { matchId, fetchTime, data } = stored;
    if (!data) return { text: '无数据', markdown: '# 无数据', structured: {} };

    const { analysis, winDrawWin, asian, overunder, corner } = data;
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
    sections.push(`## 二、赛前简报（系统分析）`);
    if (analysis?.preBriefing) {
      sections.push(`> ${analysis.preBriefing.replace(/\n/g, '\n> ')}`);
    } else {
      sections.push(`> 暂无赛前简报数据。可点击“调试”查看原始页面文本长度，确认球探网分析页是否已完整加载。`);
    }
    sections.push('');

    // ========== 联赛战绩 ==========
    sections.push(`## 三、联赛战绩统计`);
    sections.push(this._formatFullStats(home, analysis?.homeStats, analysis?.homeHalfStats, 'home'));
    sections.push(this._formatFullStats(away, analysis?.awayStats, analysis?.awayHalfStats, 'away'));

    // ========== 盘路走势 ==========
    sections.push(`## 四、联赛盘路走势`);
    const ht = analysis?.handicapTrend || {};
    sections.push(this._formatTrendBlock(home, ht.home, '🏠'));
    sections.push(this._formatTrendBlock(away, ht.away, '✈️'));
    sections.push('');

    // ========== 相同盘路历史 ==========
    sections.push(`## 五、相同盘口历史走势`);
    if (analysis?.sameHandicapHistory?.length > 0) {
      analysis.sameHandicapHistory.forEach(block => {
        if (!block.handicap) return;
        sections.push(`**初盘: ${block.handicap}**`);
        if (block.total) {
          sections.push(`- 历史: 赢${block.total.win} 走${block.total.draw} 输${block.total.loss} → 赢盘率 **${block.total.rate}**`);
        }
        if (block.last6) sections.push(`- 近6场: \`${block.last6}\``);
      });
    } else {
      sections.push(`*暂无相同盘口历史数据。*`);
    }
    sections.push('');

    // ========== 进球数据 ==========
    sections.push(`## 六、进球数据分析`);

    const fmtObjRow = (label, obj, keys) => `| ${label} | ${keys.map(k => obj?.[k] || '-').join(' | ')} |`;
    const fmtPct = v => v ? `${v.games || '-'}场/${v.pct || '-'}%` : '-';

    // 入球数/上下半场入球分布
    if (analysis?.recentGoalDistribution?.home || analysis?.recentGoalDistribution?.away) {
      const goalKeys = ['0球','1球','2球','3球','4+','上半场','下半场'];
      sections.push(`### 入球数 / 上下半场入球分布`);
      sections.push(`| 队伍 | 0球 | 1球 | 2球 | 3球 | 4+ | 上半场入球 | 下半场入球 |`);
      sections.push(`|------|-----|-----|-----|-----|----|------------|------------|`);
      [['总', '总'], ['主', '主'], ['客', '客']].forEach(([label, key]) => {
        sections.push(fmtObjRow(`${home}${label}`, analysis.recentGoalDistribution.home?.[key], goalKeys));
      });
      [['总', '总'], ['主', '主'], ['客', '客']].forEach(([label, key]) => {
        sections.push(fmtObjRow(`${away}${label}`, analysis.recentGoalDistribution.away?.[key], goalKeys));
      });
      sections.push('');
    }

    // 半全场
    if (analysis?.halfFull?.home || analysis?.halfFull?.away) {
      const hfKeys = ['胜胜','胜和','胜负','和胜','和和','和负','负胜','负和','负负'];
      sections.push(`### 半全场分布`);
      sections.push(`| 队伍 | 胜胜 | 胜和 | 胜负 | 和胜 | 和和 | 和负 | 负胜 | 负和 | 负负 |`);
      sections.push(`|------|------|------|------|------|------|------|------|------|------|`);
      ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${home}${k}`, analysis.halfFull.home?.[k], hfKeys)));
      ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${away}${k}`, analysis.halfFull.away?.[k], hfKeys)));
      sections.push('');
    }

    // 进球数/单双
    if (analysis?.goalSingleDouble?.homeTotal || analysis?.goalSingleDouble?.home || analysis?.goalSingleDouble?.away) {
      const sd = analysis.goalSingleDouble;
      const sdKeys = ['大','小','走','单','双'];
      sections.push(`### 进球大小 / 单双`);
      sections.push(`| 队伍 | 大 | 小 | 走 | 单 | 双 |`);
      sections.push(`|------|---|---|---|---|---|`);
      if (sd.home || sd.away) {
        ['总','主','客'].forEach(k => sections.push(`| ${home}${k} | ${sdKeys.map(x => fmtPct(sd.home?.[k]?.[x])).join(' | ')} |`));
        ['总','主','客'].forEach(k => sections.push(`| ${away}${k} | ${sdKeys.map(x => fmtPct(sd.away?.[k]?.[x])).join(' | ')} |`));
      } else {
        const fmtSD = (obj) => obj ? `${obj.big?.pct||'-'}% | ${obj.small?.pct||'-'}% | ${obj.draw?.pct||'-'}% | ${obj.odd?.pct||'-'}% | ${obj.even?.pct||'-'}%` : '- | - | - | - | -';
        sections.push(`| ${home}总 | ${fmtSD(sd.homeTotal)} |`);
        sections.push(`| ${away}总 | ${fmtSD(sd.awayTotal)} |`);
      }
      sections.push('');
    }

    // 进球时间分布
    const gt = analysis?.goalTimeDistribution || {};
    if (gt.home || gt.away || gt.homeFirst || gt.awayFirst || gt.rows?.length > 0 || gt.firstRows?.length > 0) {
      const timeKeys = ['1-10','11-20','21-30','31-40','41-45','46-50','51-60','61-70','71-80','81-90+'];
      if (gt.home || gt.away || gt.rows?.length > 0) {
        sections.push(`### 进球时间分布`);
        sections.push(`| 队伍 | 1-10 | 11-20 | 21-30 | 31-40 | 41-45 | 46-50 | 51-60 | 61-70 | 71-80 | 81-90+ |`);
        sections.push(`|------|------|-------|-------|-------|-------|-------|-------|-------|-------|--------|`);
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${home}${k}`, gt.home?.[k], timeKeys)));
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${away}${k}`, gt.away?.[k], timeKeys)));
      }
      if (gt.homeFirst || gt.awayFirst || gt.firstRows?.length > 0) {
        sections.push('');
        sections.push(`**第一个进球时间统计**`);
        sections.push(`| 队伍 | 1-10 | 11-20 | 21-30 | 31-40 | 41-45 | 46-50 | 51-60 | 61-70 | 71-80 | 81-90+ |`);
        sections.push(`|------|------|-------|-------|-------|-------|-------|-------|-------|-------|--------|`);
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${home}${k}`, gt.homeFirst?.[k], timeKeys)));
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${away}${k}`, gt.awayFirst?.[k], timeKeys)));
      }
      sections.push('');
    }

    // 数据比较（平均进失球）
    const dc = analysis?.dataComparison;
    const sc = analysis?.seasonComparison;
    if (dc?.home?.avgGoal || sc?.home?.goals?.total || sc?.away?.goals?.total) {
      sections.push(`### 本赛季数据统计比较`);
      const fmtGoalBlock = (team, comp) => {
        const g = comp?.goals || {};
        const lines = [];
        if (g.total) lines.push(`- ${team} 总计: 进${g.total.goalsFor}失${g.total.goalsAgainst}，场均进${g.total.avgGoal}/失${g.total.avgLoss}`);
        if (g.venue) lines.push(`- ${team} 主/客场: 进${g.venue.goalsFor}失${g.venue.goalsAgainst}，场均进${g.venue.avgGoal}/失${g.venue.avgLoss}`);
        if (g.last6) lines.push(`- ${team} 近6场: 进${g.last6.goalsFor}失${g.last6.goalsAgainst}，场均进${g.last6.avgGoal}/失${g.last6.avgLoss}`);
        return lines;
      };
      sections.push(...fmtGoalBlock(home, sc?.home));
      sections.push(...fmtGoalBlock(away, sc?.away));
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

    // ========== 胜平负 / 欧赔 ==========
    sections.push(`## 九、胜平负盘口（欧赔 / 1x2）`);
    if (winDrawWin && !winDrawWin.error && winDrawWin.companies?.length > 0) {
      const sum = winDrawWin.summary || {};
      sections.push(`**欧赔公司数**: ${sum.count || winDrawWin.companies.length} 家`);
      if (sum.averageInitial || sum.averageCurrent) {
        sections.push(`| 类型 | 主胜 | 平局 | 客胜 | 返还率 |`);
        sections.push(`|------|------|------|------|--------|`);
        if (sum.averageInitial) sections.push(`| 初盘平均 | ${sum.averageInitial.win} | ${sum.averageInitial.draw} | ${sum.averageInitial.loss} | - |`);
        if (sum.averageCurrent) sections.push(`| 即时平均 | **${sum.averageCurrent.win}** | **${sum.averageCurrent.draw}** | **${sum.averageCurrent.loss}** | ${sum.averageReturnRate || '-'} |`);
      }
      if (sum.impliedAverage) {
        sections.push(`**平均隐含概率**: 主胜 ${sum.impliedAverage.win} / 平局 ${sum.impliedAverage.draw} / 客胜 ${sum.impliedAverage.loss}`);
      }
      if (sum.movement) {
        sections.push(`**赔率变化家数**: 主胜降 ${sum.movement.winDown || 0}/升 ${sum.movement.winUp || 0} | 平局降 ${sum.movement.drawDown || 0}/升 ${sum.movement.drawUp || 0} | 客胜降 ${sum.movement.lossDown || 0}/升 ${sum.movement.lossUp || 0}`);
      }
      sections.push('');

      const stats = winDrawWin.statistics;
      if (stats?.rows?.length > 0) {
        sections.push(`### ${stats.company || '36*(英国)'}欧指统计表`);
        sections.push(`| 类型 | 主胜 | 平局 | 客胜 | 返还率 | 概率(主/平/客) | 样本(总/主/平/客) |`);
        sections.push(`|------|------|------|------|--------|----------------|------------------|`);
        stats.rows.forEach(r => {
          const prob = r.probabilities ? `${r.probabilities.win || '-'} / ${r.probabilities.draw || '-'} / ${r.probabilities.loss || '-'}` : '-';
          const sample = r.total ? `${r.total}/${r.winCount || 0}/${r.drawCount || 0}/${r.lossCount || 0}` : '-';
          sections.push(`| ${r.label || r.type} | ${r.win || '-'} | ${r.draw || '-'} | ${r.loss || '-'} | ${r.returnRate || '-'} | ${prob} | ${sample} |`);
        });
        if (stats.summary?.sampleRates) {
          const sr = stats.summary.sampleRates;
          sections.push(`- 样本赛果分布: 主胜 ${sr.win} / 平局 ${sr.draw} / 客胜 ${sr.loss}${stats.summary.sampleTotal ? `（共${stats.summary.sampleTotal}场）` : ''}`);
        }
        if (stats.recent30?.length > 0) sections.push(`- 近30场走势: \`${stats.recent30.join(' ')}\``);
        sections.push('');
      }

      const fmtKelly = c => {
        if (!c.kelly) return '-';
        const one = (v, risk) => risk ? `**${v}⚠️**` : v;
        return `${one(c.kelly.win || '-', c.kellyRisk?.win)} / ${one(c.kelly.draw || '-', c.kellyRisk?.draw)} / ${one(c.kelly.loss || '-', c.kellyRisk?.loss)}`;
      };
      const fmtProb = c => c.currentProbabilities ? `${c.currentProbabilities.win || '-'} / ${c.currentProbabilities.draw || '-'} / ${c.currentProbabilities.loss || '-'}` : '-';
      sections.push(`| 公司 | 初主胜 | 初平 | 初客胜 | 即主胜 | 即平 | 即客胜 | 返还率 | 概率(主/平/客) | 凯利(主/平/客) | 变化时间 |`);
      sections.push(`|------|--------|------|--------|--------|------|--------|--------|----------------|----------------|----------|`);
      winDrawWin.companies.forEach(c => {
        const changed = c.initialWin && (
          c.initialWin !== c.currentWin || c.initialDraw !== c.currentDraw || c.initialLoss !== c.currentLoss
        );
        const time = c.changeTime ? `${c.changeTime}${c.recent30 ? ' 🔴近30分钟' : ''}` : '-';
        sections.push(`| ${c.name} | ${c.initialWin || '-'} | ${c.initialDraw || '-'} | ${c.initialLoss || '-'} | **${c.currentWin || '-'}**${changed ? ' ⚠️' : ''} | **${c.currentDraw || '-'}** | **${c.currentLoss || '-'}** | ${c.currentReturnRate || c.returnRate || '-'} | ${fmtProb(c)} | ${fmtKelly(c)} | ${time} |`);
      });
    } else {
      sections.push('*胜平负盘口数据获取失败*');
      if (winDrawWin?.error) sections.push(`- 错误: ${winDrawWin.error}`);
    }
    sections.push('');

    // ========== 亚让盘口 ==========
    sections.push(`## 十、亚让盘口`);
    if (asian && !asian.error) {
      const sum = asian.summary || {};
      sections.push(`**盘口动向**: 升盘 ${sum.up||0} 家 / 降盘 ${sum.down||0} 家 | 高水 ${sum.highWater||0} 家 / 低水 ${sum.lowWater||0} 家`);
      if (sum.mainLine) sections.push(`**主流盘口共识**: ${sum.mainLine}`);
      sections.push('');

      // 各公司完整盘口
      if (asian.companies?.length > 0) {
        sections.push(`> 水位说明：主水低（<0.9）= 主队被看好；客水低 = 客队被看好；水位差越大倾向越明显`);
        sections.push(`| 公司 | 初主水 | 初盘口 | 初客水 | 即主水 | 即盘口 | 即客水 |`);
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
        sections.push(`**盘口变化记录** (最近 ${Math.min(15, asian.history.length)} 条，主水低=主队被看好)`);
        sections.push(`| 时间 | 盘口 | 主队水位 | 客队水位 |`);
        sections.push(`|------|------|----------|----------|`);
        asian.history.slice(0, 15).forEach(h => {
          sections.push(`| ${h.time} | ${h.line} | ${h.v1} | ${h.v2} |`);
        });
      }
    } else {
      sections.push('*亚让盘数据获取失败*');
    }
    sections.push('');

    // ========== 大小球 ==========
    sections.push(`## 十一、大小球（进球数）`);
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
    sections.push(`## 十二、角球盘口`);
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
    sections.push('**请分析以下7个维度并给出明确推荐：**');
    sections.push('');
    sections.push('1. **胜平负/欧赔** - 分析主胜、平局、客胜赔率变化、平均隐含概率与市场倾向，给出胜平负方向及信心度');
    sections.push('2. **亚让盘** - 分析盘口变化、水位流向、升降盘趋势，给出推荐方向及信心度');
    sections.push('3. **大小球** - 结合进球线变化、双方进球率、近期走势，推荐大/小球');
    sections.push('4. **角球** - 分析角球盘口是否合理，推荐大/小角球');
    sections.push('5. **赛前简报解读** - 结合阵容情况（缺阵人数、位置）分析战力影响');
    sections.push('6. **盘路走势解读** - 分析赢盘率、相同盘口历史数据的参考价值');
    sections.push('7. **综合推荐** - 给出最终推荐方案（含具体盘口、方向、信心度0-100%）');
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
        winDrawWin: winDrawWin?.keyOdds,
        asian: asian?.keyOdds,
        overunder: overunder?.keyOdds,
        corner: { mainLine: corner?.mainLine, companies: corner?.companies?.slice(0,3) },
        recentStats: analysis?.recentStats,
        richStats: {
          recentGoalDistribution: analysis?.recentGoalDistribution,
          halfFull: analysis?.halfFull,
          goalSingleDouble: analysis?.goalSingleDouble,
          goalTimeDistribution: analysis?.goalTimeDistribution,
          seasonComparison: analysis?.seasonComparison
        },
        injuries: analysis?.injuries,
        preBriefing: analysis?.preBriefing,
        summary: this._quickSummary(analysis, winDrawWin, asian, overunder)
      }
    };
  }

  _formatTrendBlock(teamName, trend, icon) {
    const lines = [`### ${icon} ${teamName}`];
    let hasData = false;

    const labels = ['全场总', '全场主场', '全场客场', '近6场'];
    if (Array.isArray(trend?.winRates) && trend.winRates.some(Boolean)) {
      hasData = true;
      lines.push(`| 类型 | 赢盘率 |`);
      lines.push(`|------|--------|`);
      labels.forEach((label, i) => {
        const value = trend.winRates[i];
        lines.push(`| ${label} | ${value ? `**${value}%**` : '-'} |`);
      });
    }

    if (Array.isArray(trend?.bigBallRates) && trend.bigBallRates.some(Boolean)) {
      hasData = true;
      const bigLabels = ['全场总', '主/客场', '近6场'];
      const bigText = trend.bigBallRates
        .map((value, i) => value ? `${bigLabels[i] || `项${i + 1}`}: ${value}%` : '')
        .filter(Boolean)
        .join(' / ');
      if (bigText) lines.push(`- 大球率: ${bigText}`);
    }

    if (trend?.last6Asian) { hasData = true; lines.push(`- 近6场亚让走势: \`${trend.last6Asian}\``); }
    if (trend?.last6OU) { hasData = true; lines.push(`- 近6场大小球走势: \`${trend.last6OU}\``); }
    if (trend?.last6HalfAsian) { hasData = true; lines.push(`- 近6场半场亚让: \`${trend.last6HalfAsian}\``); }

    if (!hasData) {
      lines.push(`- 盘路走势采集未命中，请打开“调试”查看 analysis._debug.trendTables 输出。`);
    }

    return lines.join('\n');
  }

  _quickSummary(analysis, winDrawWin, asian, overunder) {
    const summary = [];
    if (winDrawWin?.summary) {
      const s = winDrawWin.summary;
      const avg = s.averageCurrent ? `即时均赔 ${s.averageCurrent.win}/${s.averageCurrent.draw}/${s.averageCurrent.loss}` : '即时均赔未知';
      const prob = s.impliedAverage ? `概率 ${s.impliedAverage.win}/${s.impliedAverage.draw}/${s.impliedAverage.loss}` : '';
      summary.push(`胜平负：${avg}${prob ? '，' + prob : ''}`);
    }
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
    if (analysis?.seasonComparison?.home?.goals?.total || analysis?.seasonComparison?.away?.goals?.total) {
      const hg = analysis.seasonComparison.home?.goals?.total;
      const ag = analysis.seasonComparison.away?.goals?.total;
      summary.push(`场均进失球：主 ${hg?.avgGoal || '-'}/${hg?.avgLoss || '-'}，客 ${ag?.avgGoal || '-'}/${ag?.avgLoss || '-'}`);
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
