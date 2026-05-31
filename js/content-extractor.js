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
      // 提取 matchId
      const idM = url.match(/[?&/](\d{6,8})/);
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
    const text = document.body.innerText;

    result.summary.up   = (text.match(/升盘[_\s]*(\d+)/) || [,'0'])[1];
    result.summary.down = (text.match(/降盘[_\s]*(\d+)/) || [,'0'])[1];

    // 进球线
    const lineRe = /([01]\.\d{2})\s+((?:\d+(?:\/\d+)?(?:\.\d+)?))\s+([01]\.\d{2})/g;
    const allOdds = [];
    let m;
    while ((m = lineRe.exec(text)) !== null) {
      const line = parseFloat(m[2]);
      if (line >= 1.5 && line <= 5.5) {
        allOdds.push({ over: m[1], line: m[2], under: m[3] });
      }
    }

    // 配对初盘/即时
    for (let i = 0; i < allOdds.length - 1; i += 2) {
      result.allOdds.push({
        initialOver: allOdds[i].over, initialLine: allOdds[i].line, initialUnder: allOdds[i].under,
        currentOver: allOdds[i+1].over, currentLine: allOdds[i+1].line, currentUnder: allOdds[i+1].under
      });
    }

    if (result.allOdds[0]) result.keyOdds.ao    = { name: '澳门', ...result.allOdds[0] };
    if (result.allOdds[1]) result.keyOdds.crown = { name: '皇冠', ...result.allOdds[1] };

    return result;
  }

  // ===== 胜平负 / 欧赔提取 =====
  function extractWinDrawWin() {
    const result = { companies: [], summary: {}, keyOdds: {}, allOdds: [], _debug: { textLen: document.body.innerText.length, tables: document.querySelectorAll('table').length, parsedRows: 0 } };
    const text = document.body.innerText || '';
    const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = v => clean(v).replace(/\s+/g, '');
    const fmt = n => Number.isFinite(n) ? Number(n).toFixed(2) : '';
    const isSkipName = name => !name || /^(公司|所有|主流|交易所|非交易所|初|即|主|和|客|主胜|客胜|返还率|凯利指数|变化时间|历史指数|筛选|设置自定义)$/.test(name) || /初盘|即时|最高值|最低值|平均值|高级筛选|导出Excel|欧亚转换/.test(name);
    const isOdds = n => n >= 1.01 && n <= 30;
    const addCompany = entry => {
      if (!entry) return;
      const key = [entry.name, entry.currentWin, entry.currentDraw, entry.currentLoss].join('|');
      if (result.companies.some(c => [c.name, c.currentWin, c.currentDraw, c.currentLoss].join('|') === key)) return;
      result.companies.push(entry);
      result.allOdds.push(entry);
    };
    const makeEntry = (name, odds, source) => {
      if (!name || odds.length < 3) return null;
      const entry = { name, source };
      if (odds.length >= 6 && odds.slice(0, 6).every(isOdds)) {
        entry.initialWin = fmt(odds[0]); entry.initialDraw = fmt(odds[1]); entry.initialLoss = fmt(odds[2]);
        entry.currentWin = fmt(odds[3]); entry.currentDraw = fmt(odds[4]); entry.currentLoss = fmt(odds[5]);
      } else {
        entry.initialWin = ''; entry.initialDraw = ''; entry.initialLoss = '';
        entry.currentWin = fmt(odds[0]); entry.currentDraw = fmt(odds[1]); entry.currentLoss = fmt(odds[2]);
      }
      return entry;
    };

    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th,td')).map(c => clean(c.textContent));
      if (cells.length < 4) return;
      const rowText = cells.join(' ');
      if (!/\d{1,2}\.\d{2,3}/.test(rowText)) return;
      let name = '';
      const firstTd = row.querySelector('td');
      if (firstTd) {
        firstTd.childNodes.forEach(node => { if (!name && node.nodeType === 3) name = clean(node.textContent); });
        if (!name) {
          const a = firstTd.querySelector('a');
          name = a ? clean(a.textContent) : clean(firstTd.textContent);
        }
      }
      name = compact(name || cells[0] || '').replace(/^[\d一二三四五六七八九十]+[、.．\-]?/, '').replace(/[×√□☑★*]/g, '').substring(0, 20);
      if (isSkipName(name)) return;
      const odds = cells.slice(1).join(' ').match(/\d{1,2}\.\d{2,3}/g)?.map(Number).filter(isOdds) || [];
      const entry = makeEntry(name, odds, 'content-table');
      if (entry) {
        addCompany(entry);
        result._debug.parsedRows++;
      }
    });

    if (result.companies.length === 0) {
      text.split(/\n+/).forEach(line => {
        line = clean(line);
        const firstNum = line.search(/\d{1,2}\.\d{2,3}/);
        if (firstNum <= 0) return;
        const name = compact(line.slice(0, firstNum)).replace(/^[\d一二三四五六七八九十]+[、.．\-]?/, '').replace(/[×√□☑★*]/g, '').substring(0, 20);
        if (isSkipName(name)) return;
        const odds = line.match(/\d{1,2}\.\d{2,3}/g)?.map(Number).filter(isOdds) || [];
        addCompany(makeEntry(name, odds, 'content-text-fallback'));
      });
    }

    const avg = rows => {
      rows = rows.filter(x => x && Number.isFinite(parseFloat(x.win)) && Number.isFinite(parseFloat(x.draw)) && Number.isFinite(parseFloat(x.loss)));
      if (!rows.length) return null;
      const sum = rows.reduce((acc, x) => ({ win: acc.win + parseFloat(x.win), draw: acc.draw + parseFloat(x.draw), loss: acc.loss + parseFloat(x.loss) }), { win: 0, draw: 0, loss: 0 });
      return { win: fmt(sum.win / rows.length), draw: fmt(sum.draw / rows.length), loss: fmt(sum.loss / rows.length) };
    };
    result.summary.count = result.companies.length;
    result.summary.averageCurrent = avg(result.companies.map(c => ({ win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss })));
    result.summary.averageInitial = avg(result.companies.map(c => ({ win: c.initialWin, draw: c.initialDraw, loss: c.initialLoss })));
    if (result.summary.averageCurrent) {
      const aw = parseFloat(result.summary.averageCurrent.win), ad = parseFloat(result.summary.averageCurrent.draw), al = parseFloat(result.summary.averageCurrent.loss);
      const invW = 1 / aw, invD = 1 / ad, invL = 1 / al, total = invW + invD + invL;
      result.summary.impliedAverage = { win: (invW / total * 100).toFixed(1) + '%', draw: (invD / total * 100).toFixed(1) + '%', loss: (invL / total * 100).toFixed(1) + '%' };
    }
    result.keyOdds.allCurrent = result.companies.map(c => ({ name: c.name, win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss }));
    if (result.companies[0]) result.keyOdds.ao = { name: result.companies[0].name, ...result.companies[0] };
    if (result.companies[1]) result.keyOdds.crown = { name: result.companies[1].name, ...result.companies[1] };
    return result;
  }

  // ===== 角球提取 =====
  function extractCorner() {
    const result = { allOdds: [] };
    const text = document.body.innerText;

    const re = /([01]\.\d{2})\s+(\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?)\s+([01]\.\d{2})/g;
    const all = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = parseFloat(m[2]);
      if (line >= 7 && line <= 14) all.push({ over: m[1], line: m[2], under: m[3] });
    }

    for (let i = 0; i < all.length - 1; i += 2) {
      result.allOdds.push({
        initialOver: all[i].over, initialLine: all[i].line, initialUnder: all[i].under,
        currentOver: all[i+1].over, currentLine: all[i+1].line, currentUnder: all[i+1].under
      });
    }

    if (result.allOdds[0]) {
      result.mainLine  = result.allOdds[0].currentLine;
      result.mainOver  = result.allOdds[0].currentOver;
      result.mainUnder = result.allOdds[0].currentUnder;
    }

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
      else if (url.includes('AsianOdds_n.aspx')) data = extractAsian();
      else if (url.includes('OverDown_n.aspx')) data = extractOverUnder();
      else if (url.includes('Corner.aspx')) data = extractCorner();
      sendResponse({ ok: true, data });
    }
    return true;
  });
})();
