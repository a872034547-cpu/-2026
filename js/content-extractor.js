/**
 * content-extractor.js
 * 注入到球探网页面，直接从 DOM 提取数据，再通过消息发回 background
 */
(function() {
  const url = location.href;

  function extractAndSend() {
    let data = null;
    let type = null;

    if (url.includes('/analysis/')) {
      data = extractAnalysis();
      type = 'analysis';
    } else if (url.includes('1x2.titan007.com/oddslist/')) {
      data = extractWinDrawWin();
      type = 'winDrawWin';
    } else if (url.includes('goalCount.aspx')) {
      data = extractWinDrawWinStats();
      type = 'winDrawWinStats';
    } else if (url.includes('AsianOdds_n.aspx')) {
      data = extractAsian();
      type = 'asian';
    } else if (url.includes('OverDown_n.aspx')) {
      data = extractOverUnder();
      type = 'overunder';
    } else if (url.includes('Corner.aspx')) {
      data = extractCorner();
      type = 'corner';
    }

    if (data && type) {
      // 提取 matchId：analysis/oddslist 用路径，vip 页面用 id/sid 参数
      const idM = url.match(/[?&](?:id|sid)=(\d{6,8})/) || url.match(/\/(\d{6,8})(?=\D|$)/);
      const matchId = idM ? idM[1] : null;

      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        dataType: type,
        matchId,
        data
      });
    }
  }

  // ===== 赛前分析提取 =====
  function extractAnalysis() {
    const result = { matchInfo: {}, homeStats: {}, awayStats: {}, handicapTrend: { home: {}, away: {} } };

    // 比赛时间
    const timeEl = document.body.innerText.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (timeEl) result.matchInfo.time = timeEl[1] + ' ' + timeEl[2];

    // 天气
    const text = document.body.innerText;
    const weatherM = text.match(/天气[：:]\s*([^\s\n]{1,10})/);
    if (weatherM) result.matchInfo.weather = weatherM[1];
    const tempM = text.match(/温度[：:]\s*([^\n<]{2,20})/);
    if (tempM) result.matchInfo.temperature = tempM[1].trim();

    // 主客队名称
    const imgs = document.querySelectorAll('img[alt]');
    const names = [];
    imgs.forEach(img => {
      const alt = img.alt.trim();
      if (alt && alt.length >= 2 && alt.length <= 20 &&
          !alt.match(/^\d/) && names.indexOf(alt) === -1 &&
          !['image','icon','logo','banner'].some(k => alt.toLowerCase().includes(k))) {
        names.push(alt);
      }
    });
    result.matchInfo.home = names[0] || '';
    result.matchInfo.away = names[1] || '';

    // 联赛名称
    const leagueM = text.match(/(\d{4}-\d{4})赛季([^\n\-（(]{2,20})/);
    if (leagueM) result.matchInfo.league = leagueM[2].trim();

    // 解析战绩表格
    const tables = document.querySelectorAll('table');
    let teamTableIndex = 0;
    tables.forEach(tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const headers = rows[0] ? Array.from(rows[0].querySelectorAll('td,th')).map(c => c.textContent.trim()) : [];
      // 找到包含"赛"、"胜"、"平"、"负"的表格
      if (headers.some(h => h === '赛' || h === '胜')) {
        const statsObj = {};
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
          if (cells[0] === '总' && cells.length >= 8) {
            statsObj.total = {
              played: cells[1], win: cells[2], draw: cells[3], loss: cells[4],
              goalsFor: cells[5], goalsAgainst: cells[6], diff: cells[7],
              points: cells[8] || '', rank: cells[9] || '', winRate: cells[10] || ''
            };
          }
          if (cells[0] === '近6' || cells[0] === '近6场') {
            statsObj.last6 = {
              played: 6, win: cells[2], draw: cells[3], loss: cells[4],
              goalsFor: cells[5], goalsAgainst: cells[6]
            };
          }
          if (cells[0] === '主' || cells[0] === '主场') {
            statsObj.home = {
              played: cells[1], win: cells[2], draw: cells[3], loss: cells[4],
              goalsFor: cells[5], goalsAgainst: cells[6], winRate: cells[10] || ''
            };
          }
          if (cells[0] === '客' || cells[0] === '客场') {
            statsObj.away = {
              played: cells[1], win: cells[2], draw: cells[3], loss: cells[4],
              goalsFor: cells[5], goalsAgainst: cells[6], winRate: cells[10] || ''
            };
          }
        });
        if (Object.keys(statsObj).length > 0) {
          if (teamTableIndex === 0) result.homeStats = statsObj;
          else if (teamTableIndex === 1) result.awayStats = statsObj;
          teamTableIndex++;
        }
      }
    });

    // 盘路走势：表格优先，文本兜底。报告读取的是 home/away 结构，不能再只写 homeWinRate。
    const compact = v => (v || '').replace(/\s+/g, '').trim();
    const pctFromText = v => {
      const m = String(v || '').match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      return m ? m[1] : '';
    };
    const getCells = row => Array.from(row.querySelectorAll('th,td')).map(c => c.textContent.trim().replace(/\s+/g, ' '));
    const rowLabel = (cells, rowText) => {
      const first = compact(cells[0] || '');
      if (/近6|近六/.test(rowText) || first === '近6' || first === '近6场') return 'last6';
      if (first === '总' || first === '全部' || first === '全场') return 'total';
      if (first === '主' || first === '主场') return 'home';
      if (first === '客' || first === '客场') return 'away';
      return '';
    };
    const getHeaderIndex = (headers, words) => {
      for (let hi = 0; hi < headers.length; hi++) {
        const h = compact(headers[hi]);
        if (words.some(w => h.includes(w))) return hi;
      }
      return -1;
    };
    const getRateByIndex = (cells, idx) => {
      if (idx < 0) return '';
      return pctFromText(cells[idx]) || pctFromText(cells[idx + 1]) || pctFromText(cells[idx - 1]);
    };
    const oneCharSeq = (cells, re) => {
      const out = cells.map(compact).filter(c => re.test(c));
      return out.length >= 3 ? out.join(' ') : '';
    };
    const hasTrendData = trend => !!(trend && (
      (trend.winRates && trend.winRates.some(Boolean)) ||
      (trend.bigBallRates && trend.bigBallRates.some(Boolean)) ||
      trend.last6Asian || trend.last6OU
    ));
    const toTrend = (parsed, owner) => {
      const venueBig = owner === 'away' ? (parsed.big.away || parsed.big.home) : (parsed.big.home || parsed.big.away);
      return {
        winRates: [parsed.win.total || '', parsed.win.home || '', parsed.win.away || '', parsed.win.last6 || ''],
        bigBallRates: [parsed.big.total || '', venueBig || '', parsed.big.last6 || ''],
        last6Asian: parsed.last6Asian || '',
        last6OU: parsed.last6OU || '',
        source: parsed.source || ''
      };
    };
    const parseTrendTable = tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const parsed = { win: {}, big: {}, last6Asian: '', last6OU: '', source: 'content-table' };
      let headers = [];
      rows.slice(0, 4).some(row => {
        const cells = getCells(row);
        if (cells.join(' ').includes('赢盘率') || cells.join(' ').includes('大球率')) {
          headers = cells;
          return true;
        }
        return false;
      });
      const winIdx = getHeaderIndex(headers, ['赢盘率', '赢率']);
      const bigIdx = getHeaderIndex(headers, ['大球率']);
      rows.forEach(row => {
        const cells = getCells(row);
        if (!cells.length) return;
        const rowText = cells.join(' ');
        const rowCompact = compact(rowText);
        const label = rowLabel(cells, rowCompact);
        if (!label) return;

        let winRate = getRateByIndex(cells, winIdx);
        let bigRate = getRateByIndex(cells, bigIdx);
        const winLabelPos = rowText.indexOf('赢盘率');
        const bigLabelPos = rowText.indexOf('大球率');
        if (!winRate && winLabelPos >= 0) winRate = pctFromText(rowText.slice(winLabelPos));
        if (!bigRate && bigLabelPos >= 0) bigRate = pctFromText(rowText.slice(bigLabelPos));
        if (!winRate && rowCompact.includes('赢盘')) {
          const pcts = rowText.match(/\d{1,3}(?:\.\d+)?\s*%/g) || [];
          if (pcts.length) winRate = pctFromText(pcts[pcts.length - 1]);
        }
        if (!bigRate && rowCompact.includes('大球')) {
          const pcts = rowText.match(/\d{1,3}(?:\.\d+)?\s*%/g) || [];
          if (pcts.length) bigRate = pctFromText(pcts[pcts.length - 1]);
        }
        if (winRate) parsed.win[label] = winRate;
        if (bigRate) parsed.big[label] = bigRate;
        if (label === 'last6') {
          parsed.last6Asian = parsed.last6Asian || oneCharSeq(cells, /^[赢输走]$/);
          parsed.last6OU = parsed.last6OU || oneCharSeq(cells, /^[大小走]$/);
        }
      });
      return (Object.keys(parsed.win).length || Object.keys(parsed.big).length || parsed.last6Asian || parsed.last6OU) ? parsed : null;
    };
    const tableOwner = tbl => {
      const homeName = result.matchInfo.home || '';
      const awayName = result.matchInfo.away || '';
      let ctx = '';
      let node = tbl.previousElementSibling;
      for (let step = 0; node && step < 8; step++, node = node.previousElementSibling) ctx += ' ' + node.textContent;
      const near = ctx || tbl.textContent || '';
      if (homeName && near.includes(homeName) && (!awayName || !near.includes(awayName))) return 'home';
      if (awayName && near.includes(awayName) && (!homeName || !near.includes(homeName))) return 'away';
      return '';
    };

    const trendTables = [];
    tables.forEach((tbl, idx) => {
      const tblText = tbl.textContent || '';
      if (!/(赢盘率|大球率|近6场盘路走势|盘路走势)/.test(tblText)) return;
      const parsed = parseTrendTable(tbl);
      if (parsed) trendTables.push({ owner: tableOwner(tbl), parsed, idx });
    });
    result._debug = { textLen: text.length, tables: tables.length, trendTables: trendTables.map(x => ({ idx: x.idx, owner: x.owner, win: x.parsed.win, big: x.parsed.big })) };

    const pending = [];
    trendTables.forEach(item => {
      if (item.owner === 'home' && !hasTrendData(result.handicapTrend.home)) result.handicapTrend.home = toTrend(item.parsed, 'home');
      else if (item.owner === 'away' && !hasTrendData(result.handicapTrend.away)) result.handicapTrend.away = toTrend(item.parsed, 'away');
      else pending.push(item);
    });
    pending.forEach(item => {
      if (!hasTrendData(result.handicapTrend.home)) result.handicapTrend.home = toTrend(item.parsed, 'home');
      else if (!hasTrendData(result.handicapTrend.away)) result.handicapTrend.away = toTrend(item.parsed, 'away');
    });

    if (!hasTrendData(result.handicapTrend.home) || !hasTrendData(result.handicapTrend.away)) {
      const rates = [...text.matchAll(/(?:赢盘率[\s\S]{0,40}?(\d{1,3}\.?\d*)%|(\d{1,3}\.?\d*)%[\s\S]{0,20}?赢盘率)/g)].map(m => m[1] || m[2]);
      const bigRates = [...text.matchAll(/(?:大球率[\s\S]{0,40}?(\d{1,3}\.?\d*)%|(\d{1,3}\.?\d*)%[\s\S]{0,20}?大球率)/g)].map(m => m[1] || m[2]);
      if (!hasTrendData(result.handicapTrend.home)) {
        result.handicapTrend.home.winRates = rates.slice(0, 4);
        result.handicapTrend.home.bigBallRates = bigRates.slice(0, 3);
        result.handicapTrend.home.source = 'content-text-fallback';
      }
      if (!hasTrendData(result.handicapTrend.away)) {
        result.handicapTrend.away.winRates = rates.slice(4, 8);
        result.handicapTrend.away.bigBallRates = bigRates.slice(3, 6);
        result.handicapTrend.away.source = 'content-text-fallback';
      }
    }

    return result;
  }

  // ===== 亚让盘提取 =====
  function extractAsian() {
    const result = { companies: [], summary: {}, keyOdds: {} };
    const text = document.body.innerText;

    // 升降盘
    result.summary.up        = (text.match(/升盘[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.down      = (text.match(/降盘[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.highWater = (text.match(/高水[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.lowWater  = (text.match(/低水[_\s]*(\d+)/) || [,'0'])[1];

    // 遍历表格行
    const rows = document.querySelectorAll('table tr');
    const companiesData = [];
    let currentCompany = null;

    rows.forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim().replace(/\s+/g, ' '));
      if (cells.length < 4) return;

      // 判断是否含有盘口名称
      const hasHandicap = cells.some(c =>
        c.includes('平手') || c.includes('半球') || c.includes('一球') || c.includes('球半'));

      if (hasHandicap) {
        // 找盘口所在列
        let initHome = '', initLine = '', initAway = '', currHome = '', currLine = '', currAway = '';

        // 尝试解析：公司 初主 初盘 初客 即主 即盘 即客
        if (cells.length >= 7) {
          const companyName = cells[0].replace(/[*★\s]/g, '').substring(0, 10);
          // 找数字水位
          const nums = cells.filter(c => /^[01]\.\d{2}$/.test(c));
          const lines = cells.filter(c => c.includes('平手') || c.includes('球'));

          if (nums.length >= 4 && lines.length >= 1) {
            companiesData.push({
              name: companyName || `C${companiesData.length+1}`,
              initialHome: nums[0], initialHandicap: lines[0],
              initialAway: nums[1],
              currentHome: nums[nums.length >= 6 ? 3 : 2],
              currentHandicap: lines[lines.length > 1 ? 1 : 0],
              currentAway: nums[nums.length >= 6 ? 4 : 3]
            });
          }
        }
      }
    });

    result.companies = companiesData.slice(0, 15);

    // 如果表格方式没有数据，用正则
    if (companiesData.length === 0) {
      const LINES = '平手\\/半球|半球\\/一球|一球\\/球半|球半\\/两球|平手|半球|一球|球半|两球|两球半|三球';
      const re = new RegExp(`([01]\\.\\d{2})\\s+(${LINES})\\s+([01]\\.\\d{2})`, 'g');
      const all = [];
      let m;
      while ((m = re.exec(text)) !== null) all.push({ home: m[1], line: m[2], away: m[3] });

      for (let i = 0; i < all.length - 1; i += 2) {
        companiesData.push({
          name: `C${Math.floor(i/2)+1}`,
          initialHome: all[i].home, initialHandicap: all[i].line, initialAway: all[i].away,
          currentHome: all[i+1].home, currentHandicap: all[i+1].line, currentAway: all[i+1].away
        });
      }
      result.companies = companiesData.slice(0, 15);
    }

    if (result.companies[0]) result.keyOdds.ao    = { name: '澳门', ...result.companies[0] };
    if (result.companies[1]) result.keyOdds.crown = { name: '皇冠', ...result.companies[1] };
    result.keyOdds.allCurrent = result.companies.map(c => ({
      home: c.currentHome, line: c.currentHandicap, away: c.currentAway
    }));

    return result;
  }

  // ===== 大小球提取 =====
  function extractOverUnder() {
    const result = { companies: [], summary: {}, keyOdds: {}, allOdds: [] };
    const text = document.body.innerText || '';
    const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = v => clean(v).replace(/\s+/g, '');

    result.summary.up   = (text.match(/升盘[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.down = (text.match(/降盘[_\s]*(\d+)/) || [,'0'])[1];

    const WATER_RE = /^[01]\.\d{2}$/;
    const LINE_RE = /^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/;
    const SUB_RE = /^盘[2-9]$/;
    const isLine = v => LINE_RE.test(clean(v)) && parseFloat(v) >= 1.5 && parseFloat(v) <= 5.5;
    const normalizeCompanyName = raw => compact(raw).replace(/[*★]/g, '').replace(/(走势|详情|主流|多盘)$/g, '').substring(0, 15);
    const isValidName = name => {
      name = normalizeCompanyName(name);
      return !!name && name.length <= 15 && !/^(公司|初|即时|大球|小球|进球数|盘口|多盘|升盘|降盘)$/.test(name) && /[\u4e00-\u9fa5A-Za-z]/.test(name);
    };
    const extractName = row => {
      const td = row.querySelector('td');
      if (!td) return '';
      let raw = '';
      td.childNodes.forEach(node => { if (!raw && node.nodeType === 3) raw = clean(node.textContent); });
      if (!raw) {
        const a = td.querySelector('a');
        raw = a ? clean(a.textContent) : clean(td.textContent);
      }
      return normalizeCompanyName(raw);
    };
    const makeLine = (waters, lines) => {
      if (waters.length < 4 || lines.length < 1) return null;
      return {
        initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
        currentOver: waters[2], currentLine: lines[lines.length > 1 ? 1 : 0], currentUnder: waters[3]
      };
    };

    let currentCompany = null;
    let lastCompanyName = '';
    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => clean(c.textContent));
      if (!cells.length) return;
      const waters = cells.filter(c => WATER_RE.test(c));
      const lines = cells.filter(isLine);
      const line = makeLine(waters, lines);
      if (!line) return;

      const subLabel = SUB_RE.test(compact(cells[0])) ? compact(cells[0]) : (SUB_RE.test(compact(cells[1])) ? compact(cells[1]) : '');
      if (subLabel && currentCompany) {
        currentCompany.subLines = currentCompany.subLines || [];
        currentCompany.subLines.push({ label: subLabel, ...line });
        return;
      }

      let name = extractName(row);
      if (!isValidName(name) && lastCompanyName) name = lastCompanyName;
      if (!isValidName(name)) return;
      lastCompanyName = name;
      currentCompany = { name, mainLine: line, subLines: [] };
      result.companies.push(currentCompany);
      result.allOdds.push(line);
    });

    if (result.companies.length === 0) {
      const lineRe = /([01]\.\d{2})\s+((?:\d+(?:\/\d+)?(?:\.\d+)?))\s+([01]\.\d{2})/g;
      const allOdds = [];
      let m;
      while ((m = lineRe.exec(text)) !== null) {
        const line = parseFloat(m[2]);
        if (line >= 1.5 && line <= 5.5) allOdds.push({ over: m[1], line: m[2], under: m[3] });
      }
      for (let i = 0; i < allOdds.length - 1; i += 2) {
        const line = {
          initialOver: allOdds[i].over, initialLine: allOdds[i].line, initialUnder: allOdds[i].under,
          currentOver: allOdds[i+1].over, currentLine: allOdds[i+1].line, currentUnder: allOdds[i+1].under
        };
        result.companies.push({ name: `C${Math.floor(i / 2) + 1}`, mainLine: line, subLines: [] });
        result.allOdds.push(line);
      }
    }

    if (result.companies[0]) result.keyOdds.ao    = { name: result.companies[0].name, ...result.companies[0].mainLine };
    if (result.companies[1]) result.keyOdds.crown = { name: result.companies[1].name, ...result.companies[1].mainLine };
    result.keyOdds.allCurrent = result.companies.map(c => ({ name: c.name, over: c.mainLine.currentOver, line: c.mainLine.currentLine, under: c.mainLine.currentUnder }));

    const lineCounts = {};
    result.companies.forEach(c => {
      const line = c.mainLine && c.mainLine.currentLine;
      if (line) lineCounts[line] = (lineCounts[line] || 0) + 1;
    });
    result.summary.mainLine = Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    result.summary.lineConsensus = lineCounts;

    return result;
  }

  // ===== 胜平负 / 欧赔提取 =====
  function extractWinDrawWin() {
    const result = { companies: [], summary: {}, keyOdds: {}, allOdds: [], _debug: { textLen: document.body.innerText.length, tables: document.querySelectorAll('table').length, parsedRows: 0 } };
    const text = document.body.innerText || '';
    const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = v => clean(v).replace(/\s+/g, '');
    const fmt = n => Number.isFinite(n) ? Number(n).toFixed(2) : '';
    const fmtPct = n => Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '';
    const isSkipName = name => {
      name = compact(name);
      return !name || /^(公司|所有|主流|交易所|非交易所|初|即|主|和|客|主胜|客胜|返还率|凯利指数|变化时间|历史指数|筛选|设置自定义)$/.test(name) || /初盘|即时|最高值|最低值|平均值|高级筛选|删除选中|保留选中|导出Excel|欧亚转换|主胜率|和率|平率|客胜率|概率|返还|凯利|变化时间/.test(name);
    };
    const isOdds = n => { n = parseFloat(n); return Number.isFinite(n) && n >= 1.01 && n <= 30; };
    const calcReturnRate = (win, draw, loss) => {
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      return win > 0 && draw > 0 && loss > 0 ? win * draw * loss / (win * draw + draw * loss + win * loss) : null;
    };
    const isValidTriple = (win, draw, loss) => {
      if (!isOdds(win) || !isOdds(draw) || !isOdds(loss)) return false;
      const rate = calcReturnRate(win, draw, loss);
      return !!rate && rate >= 0.70 && rate <= 1.05;
    };
    const calcProbabilities = (win, draw, loss) => {
      const rate = calcReturnRate(win, draw, loss);
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      if (!rate || !(win > 0 && draw > 0 && loss > 0)) return null;
      return { win: fmtPct(rate / win), draw: fmtPct(rate / draw), loss: fmtPct(rate / loss), returnRate: fmtPct(rate), _decimal: { win: rate / win, draw: rate / draw, loss: rate / loss } };
    };
    const normalizeCompanyName = raw => {
      let name = compact(raw).replace(/[×√□☑★]/g, '');
      name = name.replace(/^[\s\-:：]+/, '');
      if (!/^\d+\*?[（(][^）)]{1,20}[）)]$/.test(name)) {
        name = name.replace(/^[\d一二三四五六七八九十]+[、.．\-]\s*/, '');
      }
      name = name.replace(/\[[^\]]*\]/g, '').replace(/[【】]/g, '').replace(/(走势|详情|历史|主流|交易所|非交易所)$/g, '').trim();
      return name.length > 24 ? name.substring(0, 24) : name;
    };
    const isValidCompanyName = name => {
      name = normalizeCompanyName(name);
      if (!name || name.length > 24) return false;
      if (/^\d+(?:\.\d+)?%?$/.test(name)) return false;
      if (/^[（(][^）)]*[）)]$/.test(name)) return false;
      if (/^[\d\s]+$/.test(name)) return false;
      if (isSkipName(name)) return false;
      return /[\u4e00-\u9fa5A-Za-z]/.test(name) || /^\d+\*?[（(][^）)]{1,20}[）)]$/.test(name);
    };
    const pickChangeTime = rowText => (String(rowText || '').match(/(?:(?:\d{4}[-/])?\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})/g) || []).pop() || '';
    const recentChange = timeText => {
      const m = String(timeText || '').match(/(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (!m) return false;
      const now = new Date();
      const dt = new Date(m[1] ? parseInt(m[1], 10) : now.getFullYear(), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10));
      const diff = now.getTime() - dt.getTime();
      return diff >= 0 && diff <= 30 * 60 * 1000;
    };
    const parseOddsFromCells = (cells, start = 1) => {
      const odds = [];
      for (let i = start; i < cells.length; i++) {
        const cell = clean(cells[i]);
        if (!cell || cell.includes('%') || /凯利|概率|主胜率|和率|平率|客胜率|返还/.test(cell)) continue;
        const re = /(^|[^\d.])(\d{1,2}\.\d{2,3})(?![\d.])/g;
        let m;
        while ((m = re.exec(cell)) !== null) {
          const v = parseFloat(m[2]);
          if (isOdds(v)) odds.push(v);
        }
      }
      return odds;
    };
    const firstValidTriple = (values, startAt = 0) => {
      for (let i = startAt; i <= values.length - 3; i++) {
        if (isValidTriple(values[i], values[i + 1], values[i + 2])) return [values[i], values[i + 1], values[i + 2]];
      }
      return null;
    };
    const addCompany = entry => {
      if (!entry || !isValidCompanyName(entry.name) || !isValidTriple(entry.currentWin, entry.currentDraw, entry.currentLoss)) return;
      entry.name = normalizeCompanyName(entry.name);
      const key = [entry.name, entry.currentWin, entry.currentDraw, entry.currentLoss].join('|');
      if (result.companies.some(c => [c.name, c.currentWin, c.currentDraw, c.currentLoss].join('|') === key)) return;
      result.companies.push(entry);
      result.allOdds.push(entry);
    };
    const makeEntry = (name, odds, rowText, source) => {
      if (!isValidCompanyName(name) || odds.length < 3) return null;
      const entry = { name: normalizeCompanyName(name), source };
      let initial = null;
      let current = null;
      if (odds.length >= 6 && isValidTriple(odds[0], odds[1], odds[2]) && isValidTriple(odds[3], odds[4], odds[5])) {
        initial = [odds[0], odds[1], odds[2]];
        current = [odds[3], odds[4], odds[5]];
      } else {
        current = firstValidTriple(odds);
      }
      if (!current) return null;
      if (initial) {
        entry.initialWin = fmt(initial[0]); entry.initialDraw = fmt(initial[1]); entry.initialLoss = fmt(initial[2]);
      } else {
        entry.initialWin = ''; entry.initialDraw = ''; entry.initialLoss = '';
      }
      entry.currentWin = fmt(current[0]); entry.currentDraw = fmt(current[1]); entry.currentLoss = fmt(current[2]);
      const time = pickChangeTime(rowText);
      if (time) entry.changeTime = time;
      return entry;
    };
    const extractName = (row, cells) => {
      let name = '';
      const firstTd = row.querySelector('td');
      if (firstTd) {
        firstTd.childNodes.forEach(node => { if (!name && node.nodeType === 3) name = clean(node.textContent); });
        if (!name) {
          const a = firstTd.querySelector('a');
          name = a ? clean(a.textContent) : clean(firstTd.textContent);
        }
      }
      name = normalizeCompanyName(name || cells[0] || '');
      if (isValidCompanyName(name)) return name;
      for (let i = 0; i < Math.min(3, cells.length); i++) {
        const cand = normalizeCompanyName(cells[i]);
        if (isValidCompanyName(cand)) return cand;
      }
      return '';
    };
    const detectRowKind = (cells, rowCompact) => {
      for (let i = 0; i < Math.min(4, cells.length); i++) {
        const c = compact(cells[i]);
        if (/^(初|初盘|初赔|初始)$/.test(c)) return 'initial';
        if (/^(即|即时|即赔)$/.test(c)) return 'current';
      }
      if (/^初盘/.test(rowCompact)) return 'initial';
      if (/^即时/.test(rowCompact)) return 'current';
      return '';
    };
    const pairedRows = {};
    let lastCompanyName = '';

    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th,td')).map(c => clean(c.textContent));
      if (cells.length < 4) return;
      const rowText = cells.join(' ');
      if (!/\d{1,2}\.\d{2,3}/.test(rowText)) return;
      const rowKind = detectRowKind(cells, compact(rowText));
      let name = extractName(row, cells);
      if (!name && rowKind && lastCompanyName) name = lastCompanyName;
      if (!name) return;
      if (name && !/^(初|即|初盘|即时|初赔|即赔)$/.test(name)) lastCompanyName = name;
      const odds = parseOddsFromCells(cells, 1);
      if (rowKind && odds.length >= 3) {
        const triple = firstValidTriple(odds);
        if (!triple) return;
        const entry = pairedRows[name] || { name, source: 'content-table-paired' };
        if (rowKind === 'initial') {
          entry.initialWin = fmt(triple[0]); entry.initialDraw = fmt(triple[1]); entry.initialLoss = fmt(triple[2]);
        } else {
          entry.currentWin = fmt(triple[0]); entry.currentDraw = fmt(triple[1]); entry.currentLoss = fmt(triple[2]);
          const time = pickChangeTime(rowText);
          if (time) entry.changeTime = time;
        }
        pairedRows[name] = entry;
        result._debug.parsedRows++;
        return;
      }
      const entry = makeEntry(name, odds, rowText, 'content-table');
      if (entry) {
        addCompany(entry);
        result._debug.parsedRows++;
      }
    });

    Object.keys(pairedRows).forEach(name => {
      const entry = pairedRows[name];
      if (!entry.currentWin && entry.initialWin) {
        entry.currentWin = entry.initialWin;
        entry.currentDraw = entry.initialDraw;
        entry.currentLoss = entry.initialLoss;
      }
      addCompany(entry);
    });

    if (result.companies.length === 0) {
      text.split(/\n+/).forEach(line => {
        line = clean(line);
        const firstNum = line.search(/\d{1,2}\.\d{2,3}/);
        if (firstNum <= 0) return;
        const name = normalizeCompanyName(line.slice(0, firstNum));
        if (!isValidCompanyName(name)) return;
        const odds = [];
        const re = /(^|[^\d.])(\d{1,2}\.\d{2,3})(?![\d.])/g;
        let m;
        while ((m = re.exec(line)) !== null) {
          const v = parseFloat(m[2]);
          if (isOdds(v)) odds.push(v);
        }
        addCompany(makeEntry(name, odds, line, 'content-text-fallback'));
      });
    }

    const avg = rows => {
      rows = rows.filter(x => x && isValidTriple(x.win, x.draw, x.loss));
      if (!rows.length) return null;
      const sum = rows.reduce((acc, x) => ({ win: acc.win + parseFloat(x.win), draw: acc.draw + parseFloat(x.draw), loss: acc.loss + parseFloat(x.loss) }), { win: 0, draw: 0, loss: 0 });
      return { win: fmt(sum.win / rows.length), draw: fmt(sum.draw / rows.length), loss: fmt(sum.loss / rows.length) };
    };
    result.summary.count = result.companies.length;
    result.summary.averageCurrent = avg(result.companies.map(c => ({ win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss })));
    result.summary.averageInitial = avg(result.companies.map(c => ({ win: c.initialWin, draw: c.initialDraw, loss: c.initialLoss })));
    let marketProbability = null;
    if (result.summary.averageCurrent) {
      const calc = calcProbabilities(result.summary.averageCurrent.win, result.summary.averageCurrent.draw, result.summary.averageCurrent.loss);
      if (calc) {
        marketProbability = calc._decimal;
        result.summary.impliedAverage = { win: calc.win, draw: calc.draw, loss: calc.loss };
        result.summary.averageReturnRate = calc.returnRate;
      }
    }
    result.companies.forEach(c => {
      const cp = calcProbabilities(c.currentWin, c.currentDraw, c.currentLoss);
      if (cp) {
        c.returnRate = cp.returnRate;
        c.currentReturnRate = cp.returnRate;
        c.probabilities = { win: cp.win, draw: cp.draw, loss: cp.loss };
        c.currentProbabilities = c.probabilities;
      }
      const ip = calcProbabilities(c.initialWin, c.initialDraw, c.initialLoss);
      if (ip) {
        c.initialReturnRate = ip.returnRate;
        c.initialProbabilities = { win: ip.win, draw: ip.draw, loss: ip.loss };
      }
      if (marketProbability && isValidTriple(c.currentWin, c.currentDraw, c.currentLoss)) {
        const kw = marketProbability.win * parseFloat(c.currentWin);
        const kd = marketProbability.draw * parseFloat(c.currentDraw);
        const kl = marketProbability.loss * parseFloat(c.currentLoss);
        c.kelly = { win: fmt(kw), draw: fmt(kd), loss: fmt(kl) };
        c.kellyRisk = { win: kw > 1, draw: kd > 1, loss: kl > 1 };
      }
      if (c.changeTime) c.recent30 = recentChange(c.changeTime);
    });
    result.keyOdds.allCurrent = result.companies.map(c => ({ name: c.name, win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss }));
    if (result.companies[0]) result.keyOdds.ao = { name: result.companies[0].name, ...result.companies[0] };
    if (result.companies[1]) result.keyOdds.crown = { name: result.companies[1].name, ...result.companies[1] };
    return result;
  }

  function extractWinDrawWinStats() {
    const text = document.body.innerText || '';
    const result = { company: '36*(英国)', source: 'goalCount', rows: [], summary: {}, recent30: [], _debug: { textLen: text.length, tables: document.querySelectorAll('table').length, parsedRows: 0 } };
    const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = v => clean(v).replace(/\s+/g, '');
    const fmt = n => Number.isFinite(n) ? Number(n).toFixed(2) : '';
    const fmtPct = n => Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '';
    const calcReturnRate = (win, draw, loss) => {
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      return win > 0 && draw > 0 && loss > 0 ? win * draw * loss / (win * draw + draw * loss + win * loss) : null;
    };
    const calcProbabilities = (win, draw, loss) => {
      const rate = calcReturnRate(win, draw, loss);
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      return rate ? { win: fmtPct(rate / win), draw: fmtPct(rate / draw), loss: fmtPct(rate / loss), returnRate: fmtPct(rate) } : null;
    };
    const parseType = (cells, rowText) => {
      const joined = compact(rowText);
      for (let i = 0; i < Math.min(3, cells.length); i++) {
        const c = compact(cells[i]);
        if (/^(初盘|初|初赔|初始)$/.test(c)) return 'initial';
        if (/^(即时|即|即赔)$/.test(c)) return 'current';
      }
      if (/^初盘/.test(joined)) return 'initial';
      if (/^即时/.test(joined)) return 'current';
      return '';
    };
    const parseStatsRow = (cells, rowText) => {
      const type = parseType(cells, rowText);
      if (!type) return null;
      const oddsItems = [];
      cells.forEach((c, idx) => {
        const cell = clean(c);
        if (!cell || cell.includes('%') || /概率|返还|凯利|主胜率|和率|平率|客胜率/.test(cell)) return;
        const re = /(^|[^\d.])(\d{1,2}\.\d{2,3})(?![\d.])/g;
        let m;
        while ((m = re.exec(cell)) !== null) {
          const v = parseFloat(m[2]);
          if (v >= 1.01 && v <= 30) oddsItems.push({ value: v, cellIndex: idx });
        }
      });
      if (oddsItems.length < 3) return null;
      const rateCheck = calcReturnRate(oddsItems[0].value, oddsItems[1].value, oddsItems[2].value);
      if (!rateCheck || rateCheck < 0.70 || rateCheck > 1.05) return null;
      const counts = [];
      for (let i = oddsItems[2].cellIndex + 1; i < cells.length; i++) {
        if (/^\d+$/.test(clean(cells[i]))) counts.push(parseInt(clean(cells[i]), 10));
      }
      const win = fmt(oddsItems[0].value), draw = fmt(oddsItems[1].value), loss = fmt(oddsItems[2].value);
      const prob = calcProbabilities(win, draw, loss);
      return {
        type,
        label: type === 'initial' ? '初盘' : '即时',
        win,
        draw,
        loss,
        total: counts[0] || '',
        winCount: counts[1] || '',
        drawCount: counts[2] || '',
        lossCount: counts[3] || '',
        probabilities: prob ? { win: prob.win, draw: prob.draw, loss: prob.loss } : null,
        returnRate: prob ? prob.returnRate : ''
      };
    };

    const companyM = clean(document.title + ' ' + text.slice(0, 300)).match(/(\d+\*?\([^)]{1,20}\))\s*欧指统计表/);
    if (companyM) result.company = companyM[1];
    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th,td')).map(c => clean(c.textContent));
      const parsed = parseStatsRow(cells, cells.join(' '));
      if (parsed) {
        result.rows.push(parsed);
        result._debug.parsedRows++;
      }
    });
    if (result.rows.length === 0) {
      text.split(/\n+/).forEach(line => {
        line = clean(line);
        if (!/^(初盘|即时|初|即)\s+\d/.test(line)) return;
        const parsed = parseStatsRow(line.split(/\s+/), line);
        if (parsed) result.rows.push(parsed);
      });
    }
    const summaryM = text.match(/共\s*(\d+)\s*场[\s\S]{0,60}?主胜\s*(\d{1,3}(?:\.\d+)?)%[\s\S]{0,30}?(?:和局|平局|和)\s*(\d{1,3}(?:\.\d+)?)%[\s\S]{0,30}?客胜\s*(\d{1,3}(?:\.\d+)?)%/);
    if (summaryM) result.summary.sampleRates = { total: summaryM[1], win: summaryM[2] + '%', draw: summaryM[3] + '%', loss: summaryM[4] + '%' };
    const recentM = text.match(/近\s*30\s*场[\s\S]{0,80}?([胜平负和]{10,})/);
    if (recentM) result.recent30 = recentM[1].replace(/和/g, '平').split('').slice(0, 30);
    result.summary.initial = result.rows.find(r => r.type === 'initial') || null;
    result.summary.current = result.rows.find(r => r.type === 'current') || null;
    return result;
  }

  // ===== 角球提取 =====
  function extractCorner() {
    const result = { companies: [], allOdds: [], keyOdds: {}, summary: {} };
    const text = document.body.innerText || '';
    const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = v => clean(v).replace(/\s+/g, '');
    const WATER_RE = /^[01]\.\d{2}$/;
    const LINE_RE = /^\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?$/;
    const isLine = v => LINE_RE.test(clean(v)) && parseFloat(v) >= 7 && parseFloat(v) <= 14;
    const normalizeCompanyName = raw => compact(raw).replace(/[*★]/g, '').replace(/(走势|详情|主流)$/g, '').substring(0, 15);
    const isValidName = name => {
      name = normalizeCompanyName(name);
      return !!name && name.length <= 15 && !/^(公司|初|即时|大球|小球|角球数|盘口)$/.test(name) && /[\u4e00-\u9fa5A-Za-z]/.test(name);
    };
    const extractName = row => {
      const td = row.querySelector('td');
      if (!td) return '';
      let raw = '';
      td.childNodes.forEach(node => { if (!raw && node.nodeType === 3) raw = clean(node.textContent); });
      if (!raw) {
        const a = td.querySelector('a');
        raw = a ? clean(a.textContent) : clean(td.textContent);
      }
      return normalizeCompanyName(raw);
    };
    const makeLine = (waters, lines) => {
      if (waters.length < 4 || lines.length < 1) return null;
      return {
        initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
        currentOver: waters[waters.length > 4 ? 3 : 2], currentLine: lines[lines.length > 1 ? 1 : 0], currentUnder: waters[waters.length > 4 ? 4 : 3]
      };
    };

    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => clean(c.textContent));
      if (!cells.length) return;
      const waters = cells.filter(c => WATER_RE.test(c));
      const lines = cells.filter(isLine);
      const line = makeLine(waters, lines);
      if (!line) return;
      let name = extractName(row);
      if (!isValidName(name)) name = `C${result.companies.length + 1}`;
      const entry = { name, ...line };
      result.companies.push(entry);
      result.allOdds.push(entry);
    });

    if (result.companies.length === 0) {
      const re = /([01]\.\d{2})\s+(\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?)\s+([01]\.\d{2})/g;
      const all = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        const line = parseFloat(m[2]);
        if (line >= 7 && line <= 14) all.push({ over: m[1], line: m[2], under: m[3] });
      }
      for (let i = 0; i < all.length - 1; i += 2) {
        const entry = {
          name: `C${Math.floor(i / 2) + 1}`,
          initialOver: all[i].over, initialLine: all[i].line, initialUnder: all[i].under,
          currentOver: all[i+1].over, currentLine: all[i+1].line, currentUnder: all[i+1].under
        };
        result.companies.push(entry);
        result.allOdds.push(entry);
      }
    }

    if (result.companies[0]) {
      result.mainLine  = result.companies[0].currentLine;
      result.mainOver  = result.companies[0].currentOver;
      result.mainUnder = result.companies[0].currentUnder;
      result.keyOdds.ao = { name: result.companies[0].name, ...result.companies[0] };
    }
    if (result.companies[1]) result.keyOdds.crown = { name: result.companies[1].name, ...result.companies[1] };
    result.keyOdds.allCurrent = result.companies.map(c => ({ name: c.name, over: c.currentOver, line: c.currentLine, under: c.currentUnder }));

    return result;
  }

  // 等页面加载完毕后提取
  if (document.readyState === 'complete') {
    extractAndSend();
  } else {
    window.addEventListener('load', extractAndSend);
  }

  // 监听来自 background 的请求（按需提取）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXTRACT_NOW') {
      let data = null;
      if (url.includes('/analysis/')) data = extractAnalysis();
      else if (url.includes('1x2.titan007.com/oddslist/')) data = extractWinDrawWin();
      else if (url.includes('goalCount.aspx')) data = extractWinDrawWinStats();
      else if (url.includes('AsianOdds_n.aspx')) data = extractAsian();
      else if (url.includes('OverDown_n.aspx')) data = extractOverUnder();
      else if (url.includes('Corner.aspx')) data = extractCorner();
      sendResponse({ ok: true, data });
    }
    return true;
  });
})();
