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
    const result = { matchInfo: {}, homeStats: {}, awayStats: {}, handicapTrend: {} };

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

    // 盘路赢盘率
    const winRates = [...text.matchAll(/(\d{1,3}\.?\d*)%.*?赢盘率|赢盘率.*?(\d{1,3}\.?\d*)%/g)];
    const rates = [...text.matchAll(/赢盘率\D{0,5}(\d+\.?\d*)%/g)];
    if (rates[0]) result.handicapTrend.homeWinRate = rates[0][1];
    if (rates[1]) result.handicapTrend.awayWinRate = rates[1][1];
    const bigM = text.match(/大球率\D{0,5}(\d+\.?\d*)%/);
    if (bigM) result.handicapTrend.bigBallRate = bigM[1];

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
      else if (url.includes('AsianOdds_n.aspx')) data = extractAsian();
      else if (url.includes('OverDown_n.aspx')) data = extractOverUnder();
      else if (url.includes('Corner.aspx')) data = extractCorner();
      sendResponse({ ok: true, data });
    }
    return true;
  });
})();
