u/**
 * DataCollector - 基于真实HTML结构的精准解析版
 * 实际HTML结构（从web_fetch观察）：
 * 亚让：澳* 0.95 平手/半球 0.89  即时: 1.00 平手/半球 0.84
 * 大小：澳* 1.00 2.5 0.80  即时: 0.86 2/2.5 0.94
 * 角球：澳* 0.94 9.5 0.82  即时: 0.96 9.5 0.80
 */
export class DataCollector {
  constructor() {
    this.baseAnalysis = 'https://zq.titan007.com/analysis/';
    this.baseVip = 'https://vip.titan007.com/';
  }

  async fetchAll(matchId) {
    const [analysis, asian, overunder, corner] = await Promise.allSettled([
      this.fetchAnalysis(matchId),
      this.fetchAsian(matchId),
      this.fetchOverUnder(matchId),
      this.fetchCorner(matchId)
    ]);

    return {
      matchId,
      fetchTime: new Date().toISOString(),
      analysis:  analysis.status === 'fulfilled'  ? analysis.value  : { error: analysis.reason?.message },
      asian:     asian.status === 'fulfilled'     ? asian.value     : { error: asian.reason?.message },
      overunder: overunder.status === 'fulfilled' ? overunder.value : { error: overunder.reason?.message },
      corner:    corner.status === 'fulfilled'    ? corner.value    : { error: corner.reason?.message }
    };
  }

  // ===== 赛前分析 =====
  async fetchAnalysis(matchId) {
    const url = `${this.baseAnalysis}${matchId}cn.htm`;
    const html = await this._fetch(url);
    return this._parseAnalysis(html);
  }

  _parseAnalysis(html) {
    const result = { matchInfo: {}, homeStats: {}, awayStats: {}, handicapTrend: {} };

    // 比赛时间
    const timeM = html.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
    if (timeM) result.matchInfo.time = timeM[1] + ' ' + timeM[2];

    // 主客队名称（从 <img ... alt="xxx" title="xxx"> 或 href 中提取）
    // 方式1：alt 属性
    const altNames = [];
    const altRe = /alt="([^"]{2,25})"/g;
    let m;
    while ((m = altRe.exec(html)) !== null) {
      const n = m[1].trim();
      if (n.length >= 2 && !n.match(/^\d/) && !['image','icon','logo','HGreen','HBlue','HSky','HPurple','HYellow'].includes(n)) {
        if (!altNames.includes(n)) altNames.push(n);
      }
    }
    result.matchInfo.home = altNames[0] || '';
    result.matchInfo.away = altNames[1] || '';

    // 天气温度（编码后可能是GB2312，先尝试）
    const weatherM = html.match(/天气[：:uff1a]([^\s<&\n]{1,8})/);
    if (weatherM) result.matchInfo.weather = weatherM[1];
    const tempM = html.match(/温度[：:uff1a]([^<&\n]{3,15})/);
    if (tempM) result.matchInfo.temperature = tempM[1].trim();

    // 联赛
    const leagueM = html.match(/(\d{4}-\d{4})赛季([^<\)\n\-（]{2,20})/);
    if (leagueM) result.matchInfo.league = leagueM[2].trim();

    // 战绩统计 - 寻找表格中的数字行
    // 典型格式：总</td><td>34</td><td>24</td><td>4</td><td>6</td><td>74</td><td>29</td><td>45</td><td>76</td><td>1</td><td>70.6%</td>
    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/g;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;

    const extractRow = (rowHtml) => {
      const cells = [];
      let cm;
      while ((cm = tdRe.exec(rowHtml)) !== null) {
        cells.push(cm[1].replace(/<[^>]+>/g, '').trim());
      }
      tdRe.lastIndex = 0;
      return cells;
    };

    let teamIndex = 0;
    while ((m = rowRe.exec(html)) !== null) {
      const cells = extractRow(m[0]);
      if (cells[0] === '总' && cells.length >= 8 && !isNaN(parseInt(cells[1]))) {
        const statsObj = {
          played: cells[1], win: cells[2], draw: cells[3], loss: cells[4],
          goalsFor: cells[5], goalsAgainst: cells[6], diff: cells[7],
          points: cells[8] || '', rank: cells[9] || '', winRate: cells[10] || ''
        };
        if (teamIndex === 0) result.homeStats.total = statsObj;
        else if (teamIndex === 1) result.awayStats.total = statsObj;
      }
      if (cells[0] === '主场' || cells[0] === '主') {
        const homeMatch = {
          played: cells[1], win: cells[2], draw: cells[3], loss: cells[4],
          goalsFor: cells[5], goalsAgainst: cells[6], winRate: cells[10] || ''
        };
        if (teamIndex === 0) result.homeStats.homeRecord = homeMatch;
        else result.awayStats.homeRecord = homeMatch;
      }
      if (cells[0] === '近6') {
        const last6 = {
          played: 6, win: cells[2], draw: cells[3], loss: cells[4],
          goalsFor: cells[5], goalsAgainst: cells[6]
        };
        if (teamIndex === 0) { result.homeStats.last6 = last6; teamIndex++; }
        else result.awayStats.last6 = last6;
      }
    }
    rowRe.lastIndex = 0;

    // 盘路赢盘率（从文本提取）
    const rateRe = /赢盘率[\s\S]{0,5}(\d{1,3}\.?\d*)%/g;
    const rates = [];
    while ((m = rateRe.exec(html)) !== null) rates.push(m[1]);
    if (rates[0]) result.handicapTrend.homeWinRate = rates[0];
    if (rates[1]) result.handicapTrend.awayWinRate = rates[1];

    const bigM = html.match(/大球率[\s\S]{0,5}(\d{1,3}\.?\d*)%/);
    if (bigM) result.handicapTrend.bigBallRate = bigM[1];

    return result;
  }

  // ===== 亚让盘 =====
  async fetchAsian(matchId) {
    const url = `${this.baseVip}AsianOdds_n.aspx?id=${matchId}&l=0`;
    const html = await this._fetch(url);
    return this._parseAsian(html);
  }

  _parseAsian(html) {
    const result = { companies: [], summary: {}, keyOdds: {} };

    // 升降盘
    result.summary.up        = (html.match(/升盘_(\d+)_/) || [,'0'])[1];
    result.summary.down      = (html.match(/降盘_(\d+)_/) || [,'0'])[1];
    result.summary.highWater = (html.match(/高水_(\d+)_/) || [,'0'])[1];
    result.summary.lowWater  = (html.match(/低水_(\d+)_/) || [,'0'])[1];

    // 从 HTML 表格提取盘口
    // 表格行结构：公司名 | 初主水 | 初盘口 | 初客水 | 即主水 | 即盘口 | 即客水
    const companies = this._extractOddsTable(html, 'asian');
    result.companies = companies;

    if (companies[0]) result.keyOdds.ao    = { name: companies[0].name || '澳门', ...companies[0] };
    if (companies[1]) result.keyOdds.crown = { name: companies[1].name || '皇冠', ...companies[1] };
    result.keyOdds.allCurrent = companies.map(c => ({
      home: c.currentHome, line: c.currentHandicap, away: c.currentAway
    }));

    return result;
  }

  // ===== 大小球 =====
  async fetchOverUnder(matchId) {
    const url = `${this.baseVip}OverDown_n.aspx?id=${matchId}&l=0`;
    const html = await this._fetch(url);
    return this._parseOverUnder(html);
  }

  _parseOverUnder(html) {
    const result = { companies: [], summary: {}, keyOdds: {}, allOdds: [] };

    result.summary.up   = (html.match(/升盘_(\d+)_/) || [,'0'])[1];
    result.summary.down = (html.match(/降盘_(\d+)_/) || [,'0'])[1];

    const companies = this._extractOddsTable(html, 'ou');
    result.allOdds = companies;

    if (companies[0]) result.keyOdds.ao    = { name: '澳门', ...companies[0] };
    if (companies[1]) result.keyOdds.crown = { name: '皇冠', ...companies[1] };

    return result;
  }

  // ===== 角球 =====
  async fetchCorner(matchId) {
    const url = `${this.baseVip}Corner.aspx?id=${matchId}&l=0`;
    const html = await this._fetch(url);
    return this._parseCorner(html);
  }

  _parseCorner(html) {
    const result = { allOdds: [] };
    const companies = this._extractOddsTable(html, 'corner');
    result.allOdds = companies;

    if (companies[0]) {
      result.mainLine  = companies[0].currentLine;
      result.mainOver  = companies[0].currentOver;
      result.mainUnder = companies[0].currentUnder;
    }

    return result;
  }

  // ===== 通用表格提取 =====
  _extractOddsTable(html, type) {
    const results = [];

    // 提取所有 <tr> 行
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let trM;

    while ((trM = trRe.exec(html)) !== null) {
      const rowHtml = trM[1];
      const cells = [];
      let tdM;
      while ((tdM = tdRe.exec(rowHtml)) !== null) {
        // 去除HTML标签，提取纯文本
        const text = tdM[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) cells.push(text);
      }
      tdRe.lastIndex = 0;

      if (cells.length < 3) continue;

      if (type === 'asian') {
        // 寻找含盘口名称的行
        const handRe = /平手|半球|一球|球半|两球/;
        const lineIdx = cells.findIndex(c => handRe.test(c));
        if (lineIdx >= 0) {
          const waterRe = /^[01]\.\d{2}$/;
          const waters = cells.filter(c => waterRe.test(c));
          const lines = cells.filter(c => handRe.test(c));

          if (waters.length >= 4 && lines.length >= 1) {
            const name = cells[0].replace(/[*★\s\t]/g, '').substring(0, 10);
            results.push({
              name,
              initialHome: waters[0], initialHandicap: lines[0], initialAway: waters[1],
              currentHome: waters[waters.length >= 6 ? 3 : 2],
              currentHandicap: lines[lines.length > 1 ? 1 : 0],
              currentAway: waters[waters.length >= 6 ? 4 : 3]
            });
          }
        }
      } else if (type === 'ou') {
        // 寻找含进球线的行（数字如 2.5 / 3 / 2/2.5）
        const lineRe = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)$/;
        const waterRe = /^[01]\.\d{2}$/;
        const lines = cells.filter(c => lineRe.test(c) && parseFloat(c) >= 1.5 && parseFloat(c) <= 5.5);
        const waters = cells.filter(c => waterRe.test(c));

        if (lines.length >= 1 && waters.length >= 4) {
          const name = cells[0].replace(/[*★\s\t]/g, '').substring(0, 10);
          results.push({
            name,
            initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
            currentOver: waters[waters.length >= 6 ? 3 : 2],
            currentLine: lines[lines.length > 1 ? 1 : 0],
            currentUnder: waters[waters.length >= 6 ? 4 : 3]
          });
        }
      } else if (type === 'corner') {
        const lineRe = /^\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?$/;
        const waterRe = /^[01]\.\d{2}$/;
        const lines = cells.filter(c => lineRe.test(c) && parseFloat(c) >= 7 && parseFloat(c) <= 14);
        const waters = cells.filter(c => waterRe.test(c));

        if (lines.length >= 1 && waters.length >= 4) {
          const name = cells[0].replace(/[*★\s\t]/g, '').substring(0, 10);
          results.push({
            name,
            initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
            currentOver: waters[waters.length >= 6 ? 3 : 2],
            currentLine: lines[lines.length > 1 ? 1 : 0],
            currentUnder: waters[waters.length >= 6 ? 4 : 3]
          });
        }
      }

      if (results.length >= 15) break;
    }

    // 如果 HTML 表格方式没有结果，尝试纯文本正则
    if (results.length === 0) {
      return this._extractByRegex(html, type);
    }

    return results;
  }

  _extractByRegex(html, type) {
    const results = [];

    if (type === 'asian') {
      // 匹配：数字 盘口名 数字 ... 数字 盘口名 数字（忽略中间内容）
      const lineNames = '(?:平手\\/半球|半球\\/一球|一球\\/球半|球半\\/两球|平手|半球|一球|球半|两球|两球半|三球)';
      // 提取所有 [水位 盘口名 水位] 三元组
      const re = new RegExp(`([01]\\.\\d{2})\\s+(${lineNames})\\s+([01]\\.\\d{2})`, 'g');
      const triples = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        triples.push({ home: m[1], line: m[2], away: m[3] });
      }
      // 奇数为初盘，偶数为即时（每两个一组）
      for (let i = 0; i + 1 < triples.length; i += 2) {
        results.push({
          name: `C${Math.floor(i/2)+1}`,
          initialHome: triples[i].home, initialHandicap: triples[i].line, initialAway: triples[i].away,
          currentHome: triples[i+1].home, currentHandicap: triples[i+1].line, currentAway: triples[i+1].away
        });
        if (results.length >= 15) break;
      }
    } else if (type === 'ou') {
      const re = /([01]\.\d{2})\s+((?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?))(?=\s+[01]\.\d{2})\s+([01]\.\d{2})/g;
      const triples = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        const line = parseFloat(m[2]);
        if (line >= 1.5 && line <= 5.5) triples.push({ over: m[1], line: m[2], under: m[3] });
      }
      for (let i = 0; i + 1 < triples.length; i += 2) {
        results.push({
          name: `C${Math.floor(i/2)+1}`,
          initialOver: triples[i].over, initialLine: triples[i].line, initialUnder: triples[i].under,
          currentOver: triples[i+1].over, currentLine: triples[i+1].line, currentUnder: triples[i+1].under
        });
        if (results.length >= 15) break;
      }
    } else if (type === 'corner') {
      const re = /([01]\.\d{2})\s+(\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?)\s+([01]\.\d{2})/g;
      const triples = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        const line = parseFloat(m[2]);
        if (line >= 7 && line <= 14) triples.push({ over: m[1], line: m[2], under: m[3] });
      }
      for (let i = 0; i + 1 < triples.length; i += 2) {
        results.push({
          name: `C${Math.floor(i/2)+1}`,
          initialOver: triples[i].over, initialLine: triples[i].line, initialUnder: triples[i].under,
          currentOver: triples[i+1].over, currentLine: triples[i+1].line, currentUnder: triples[i+1].under
        });
        if (results.length >= 15) break;
      }
    }

    return results;
  }

  // ===== 通用 fetch =====
  async _fetch(url) {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.titan007.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache'
      },
      credentials: 'include'
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status} - ${url}`);

    const buffer = await resp.arrayBuffer();

    // 先 UTF-8 解码，检查 meta charset
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    // 如果 meta 指定了 GBK/GB2312，重新解码
    if (/charset=["']?\s*(?:gb2312|gbk|gb_2312)/i.test(text)) {
      try {
        text = new TextDecoder('gbk').decode(buffer);
      } catch (e) {
        console.warn('GBK decode failed, using UTF-8');
      }
    }

    return text;
  }
}
