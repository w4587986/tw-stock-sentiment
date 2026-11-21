import fs from 'node:fs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = path => {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return null; }
};
const number = value => {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/,/g, '').replace(/[％%]/g, '').replace(/\s/g, '').trim();
  if (!s || ['--', '-', 'X', 'N/A', '不適用'].includes(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const signedNumber = (value, sign) => {
  const n = number(value);
  if (n === null) return null;
  const s = String(sign ?? '').trim();
  if (s === '-') return -Math.abs(n);
  if (s === '+') return Math.abs(n);
  return n;
};
const dateParts = date => date.split('-').map(Number);
const compact = date => date.replaceAll('-', '');
const monthKey = date => date.slice(0, 7);
const priorMonthKey = date => {
  const [y, m] = dateParts(date);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
};
const rocDate = value => {
  const s = String(value || '').trim();
  let m = s.match(/(\d{2,3})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{1,2})/);
  if (!m) m = s.match(/(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  return (Number(m[1]) + 1911) + '-' + String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[3])).padStart(2, '0');
};
const pctRank = (values, current, minSamples = 60) => {
  const valid = values.filter(Number.isFinite);
  if (!Number.isFinite(current) || valid.length < minSamples) return null;
  return valid.filter(v => v <= current).length / valid.length * 100;
};

const lastCallAt = new Map();
async function throttle(url) {
  const host = new URL(url).host;
  const minGap = host.includes('twse.com.tw') ? 1700 : 1100;
  const previous = lastCallAt.get(host) || 0;
  const wait = minGap - (Date.now() - previous);
  if (wait > 0) await sleep(wait);
  lastCallAt.set(host, Date.now());
}
async function fetchText(url, label, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await throttle(url);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TaiwanMarketSentiment/3.2)',
          'Accept': 'application/json,text/html,*/*',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        },
        signal: AbortSignal.timeout(35000)
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1200 * attempt);
    }
  }
  throw new Error(label + ': ' + String(lastError?.message || lastError));
}
async function fetchJson(url, label) {
  const raw = await fetchText(url, label);
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(label + ': 回傳內容不是 JSON'); }
  const stat = String(data.stat || '').toUpperCase();
  if (stat && stat !== 'OK') throw new Error(label + ': ' + String(data.stat));
  return data;
}
function fieldIndex(fields, pattern) {
  return fields.findIndex(field => pattern.test(String(field || '').replace(/\s/g, '')));
}
function parseTwseIndex(body, date) {
  const tables = Array.isArray(body.tables) ? body.tables : [];
  let index = null;
  let listed = null;

  for (const table of tables) {
    const fields = (table.fields || []).map(v => String(v || '').trim());
    const rows = Array.isArray(table.data) ? table.data : [];
    if (!index && fields.length) {
      const labelIdx = fields.findIndex(f => /指數/.test(f) && !/漲跌|收盤/.test(f));
      const closeIdx = fieldIndex(fields, /收盤指數/);
      const pointsIdx = fieldIndex(fields, /漲跌點數/);
      const pctIdx = fieldIndex(fields, /漲跌百分比/);
      if (labelIdx >= 0 && closeIdx >= 0) {
        const row = rows.find(r => String(r[labelIdx] || '').includes('發行量加權股價指數'));
        if (row) {
          const signIdx = fieldIndex(fields, /漲跌\(\+\/-\)/);
          const sign = signIdx >= 0 ? row[signIdx] : null;
          index = {
            date,
            close: number(row[closeIdx]),
            changePoints: pointsIdx >= 0 ? signedNumber(row[pointsIdx], sign) : null,
            changePct: pctIdx >= 0 ? signedNumber(row[pctIdx], sign) : null
          };
        }
      }
    }

    if (!listed && fields.length) {
      const codeIdx = fieldIndex(fields, /證券代號|股票代號/);
      const changeIdx = fieldIndex(fields, /漲跌價差/);
      if (codeIdx >= 0 && changeIdx >= 0 && rows.length) {
        const signIdx = fieldIndex(fields, /漲跌\(\+\/-\)/);
        let advance = 0, decline = 0, unchanged = 0, examined = 0;
        for (const row of rows) {
          const code = String(row[codeIdx] || '').trim();
          if (!/^[0-9]{4}$/.test(code)) continue;
          const change = signedNumber(row[changeIdx], signIdx >= 0 ? row[signIdx] : null);
          if (change === null) continue;
          examined++;
          if (change > 0) advance++;
          else if (change < 0) decline++;
          else unchanged++;
        }
        if (examined > 0) listed = { advance, decline, unchanged, examined };
      }
    }
  }
  if (!index?.close || !listed) return null;
  return { index, listed };
}
async function fetchTwseIndex(date) {
  const url = 'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=' + compact(date) + '&type=ALLBUT0999&response=json';
  const body = await fetchJson(url, 'TWSE MI_INDEX ' + date);
  return parseTwseIndex(body, date);
}
async function fetchTwseMargin(date) {
  const url = 'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=' + compact(date) + '&selectType=MS&response=json';
  const body = await fetchJson(url, 'TWSE MI_MARGN ' + date);
  const rows = Array.isArray(body.creditList) ? body.creditList : [];
  const row = rows.find(item => String(item?.[0] || '').includes('融資金額'));
  if (!row || row.length < 6) throw new Error('融資金額統計列缺少欄位');
  const priorThousand = number(row[4]);
  const todayThousand = number(row[5]);
  if (!(priorThousand > 0) || !(todayThousand > 0)) throw new Error('融資餘額數值無效');
  return {
    date,
    todayBalanceYi: todayThousand / 100000,
    priorBalanceYi: priorThousand / 100000,
    deltaYi: (todayThousand - priorThousand) / 100000,
    deltaPct: (todayThousand / priorThousand - 1) * 100
  };
}
async function fetchTpexBreadth(date) {
  const [year, month, day] = dateParts(date);
  const dayString = year + '/' + String(month).padStart(2, '0') + '/' + String(day).padStart(2, '0');
  const url = 'https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=' + encodeURIComponent(dayString) + '&se=EW&o=json';
  const body = await fetchJson(url, 'TPEx daily quotes ' + date);
  const tables = Array.isArray(body.tables) ? body.tables : [];
  const table = tables.find(item => Array.isArray(item.data) && item.data.length > 0);
  if (!table) throw new Error('上櫃日行情沒有資料表');
  const fields = (table.fields || []).map(v => String(v || '').trim());
  const codeIdx = fieldIndex(fields, /證券代號|代號|代碼/);
  const changeIdx = fieldIndex(fields, /^漲跌$|漲跌價差/);
  if (codeIdx < 0 || changeIdx < 0) throw new Error('上櫃日行情欄位格式不符：' + fields.join('|'));
  let advance = 0, decline = 0, unchanged = 0, examined = 0;
  for (const row of table.data) {
    const code = String(row[codeIdx] || '').trim();
    if (!/^[0-9]{4}$/.test(code)) continue;
    const change = number(row[changeIdx]);
    if (change === null) continue;
    examined++;
    if (change > 0) advance++;
    else if (change < 0) decline++;
    else unchanged++;
  }
  if (!examined) throw new Error('上櫃行情沒有可判讀的四碼股票漲跌資料');
  return { advance, decline, unchanged, examined };
}
function htmlText(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}
function htmlRows(html) {
  return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match =>
    [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => htmlText(cell[1]))
  ).filter(cells => cells.length > 0);
}
const daytradeMonthCache = new Map();
async function fetchDaytradeMonth(date) {
  const key = monthKey(date);
  if (daytradeMonthCache.has(key)) return daytradeMonthCache.get(key);
  const url = 'https://www.twse.com.tw/exchangeReport/TWTB4U2?date=' + compact(date) + '&response=html&stockNo=';
  const html = await fetchText(url, 'TWSE TWTB4U2 ' + key);
  const map = new Map();
  for (const cells of htmlRows(html)) {
    const rowDate = rocDate(cells[0]);
    if (!rowDate || monthKey(rowDate) !== key) continue;
    const values = cells.slice(1).map(number);
    if (values.length < 6 || values.slice(0, 6).some(v => v === null)) continue;
    map.set(rowDate, {
      volumeShares: values[0],
      volumeSharePct: values[1],
      buyAmount: values[2],
      buyAmountSharePct: values[3],
      sellAmount: values[4],
      sellAmountSharePct: values[5]
    });
  }
  daytradeMonthCache.set(key, map);
  if (!map.size) console.log('當沖月報 ' + key + ' 沒有可解析的日期列；這個月的當沖歷史可能留空。');
  return map;
}
function latestAccountMonthForDate(date, accountHistory) {
  const cutoff = priorMonthKey(date);
  const candidates = accountHistory.filter(item => String(item.month || '') <= cutoff);
  return candidates.length ? candidates[candidates.length - 1].month : null;
}
function isComplete(item) {
  return Number.isFinite(item.close) &&
    Number.isFinite(item.advance) &&
    Number.isFinite(item.decline) &&
    Number.isFinite(item.marginBalanceYi) &&
    Number.isFinite(item.daytradeSharePct) &&
    item.breadthCoverage === '上市＋上櫃';
}
function buildDateCandidates(endDate, maxCalendarDays) {
  const [y, m, d] = dateParts(endDate);
  const end = new Date(Date.UTC(y, m - 1, d));
  const dates = [];
  for (let offset = 1; offset <= maxCalendarDays; offset++) {
    const dt = new Date(end);
    dt.setUTCDate(dt.getUTCDate() - offset);
    const weekday = dt.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    dates.push(dt.toISOString().slice(0, 10));
  }
  return dates;
}
function calculateScores(history, accountHistory) {
  const byMonth = new Map(accountHistory.map(item => [item.month, item]));
  const marginHistory = [];
  const daytradeHistory = [];
  const breadthHistory = [];
  const downMoveHistory = [];
  for (let i = 0; i < history.length; i++) {
    const row = history[i];
    if (Number.isFinite(row.marginBalanceYi)) marginHistory.push(row.marginBalanceYi);
    let currentMargin20d = null;
    const margin20Series = [];
    for (let j = 20; j < marginHistory.length; j++) {
      const start = marginHistory[j - 20];
      const end = marginHistory[j];
      if (start > 0 && end > 0) margin20Series.push((end / start - 1) * 100);
    }
    if (margin20Series.length) currentMargin20d = margin20Series[margin20Series.length - 1];
    const previousMargin20 = margin20Series.slice(0, -1);
    const marginPercentile = pctRank(previousMargin20, currentMargin20d, 60);

    const daytradePercentile = pctRank(daytradeHistory, row.daytradeSharePct, 60);
    const currentAccount = row.accountMonth ? byMonth.get(row.accountMonth) : null;
    const priorAccountRates = currentAccount
      ? accountHistory.filter(item => item.month < currentAccount.month).map(item => item.netChangePct)
      : [];
    const accountPercentile = currentAccount
      ? pctRank(priorAccountRates, currentAccount.netChangePct, 12)
      : null;

    const heatComponents = [];
    if (marginPercentile !== null) heatComponents.push({ key: 'margin20d', percentile: marginPercentile, weight: 0.4 });
    if (daytradePercentile !== null) heatComponents.push({ key: 'daytrade', percentile: daytradePercentile, weight: 0.4 });
    if (accountPercentile !== null) heatComponents.push({ key: 'accounts', percentile: accountPercentile, weight: 0.2 });
    const heatWeight = heatComponents.reduce((sum, item) => sum + item.weight, 0);
    row.heatIndex = heatComponents.length >= 2
      ? Math.round(heatComponents.reduce((sum, item) => sum + item.percentile * item.weight, 0) / heatWeight)
      : null;

    const currentCoverage = row.breadthCoverage || null;
    const currentBreadthRatio = Number.isFinite(row.advance) && Number.isFinite(row.decline) && row.advance + row.decline > 0
      ? row.decline / (row.advance + row.decline) * 100 : null;
    const priorBreadth = currentCoverage
      ? breadthHistory.filter(item => item.coverage === currentCoverage).map(item => item.value)
      : [];
    const currentDownMove = Number.isFinite(row.changePct) ? Math.max(0, -row.changePct) : null;
    const breadthPercentile = pctRank(priorBreadth, currentBreadthRatio, 60);
    const pricePercentile = pctRank(downMoveHistory, currentDownMove, 60);
    row.fearIndex = breadthPercentile !== null && pricePercentile !== null
      ? Math.round((breadthPercentile + pricePercentile) / 2)
      : null;

    if (Number.isFinite(row.daytradeSharePct)) daytradeHistory.push(row.daytradeSharePct);
    if (currentBreadthRatio !== null) breadthHistory.push({ coverage: currentCoverage, value: currentBreadthRatio });
    if (currentDownMove !== null) downMoveHistory.push(currentDownMove);
  }
}
function monthAvailableFromDate(date, accountHistory) {
  const target = latestAccountMonthForDate(date, accountHistory);
  return target || null;
}

const latest = readJson('data/latest.json');
if (!latest?.tradingDate || !latest.normalized) throw new Error('缺少 data/latest.json 或交易日欄位，無法執行歷史回補。');
const accountHistory = readJson('data/accounts-history.json') || latest.normalized.accounts?.history || [];
let history = readJson('data/history.json') || latest.history || [];
if (!Array.isArray(history)) history = [];
const latestDate = latest.tradingDate;
const latestBreadth = latest.normalized.breadth || {};
const current = history.find(item => item.date === latestDate) || {
  date: latestDate,
  close: latest.normalized.index?.close ?? null,
  changePct: latest.normalized.index?.changePct ?? null
};
current.close = latest.normalized.index?.close ?? current.close;
current.changePct = latest.normalized.index?.changePct ?? current.changePct;
current.advance = latestBreadth.advance ?? current.advance;
current.decline = latestBreadth.decline ?? current.decline;
current.unchanged = latestBreadth.unchanged ?? current.unchanged;
current.breadthCoverage = latestBreadth.coverage || current.breadthCoverage || null;
current.marginBalanceYi = latest.normalized.margin?.status === 'ok' && !latest.normalized.margin?.stale
  ? latest.normalized.margin.todayBalanceYi : current.marginBalanceYi;
current.marginChangePct = latest.normalized.margin?.status === 'ok' && !latest.normalized.margin?.stale
  ? latest.normalized.margin.deltaPct : current.marginChangePct;
current.daytradeSharePct = latest.normalized.daytrade?.status === 'ok' && !latest.normalized.daytrade?.stale
  ? latest.normalized.daytrade.volumeSharePct : current.daytradeSharePct;
current.accountMonth = latest.normalized.accounts?.month || current.accountMonth;
const filtered = history.filter(item => item.date !== latestDate);
filtered.push(current);
history = filtered.sort((a, b) => String(a.date).localeCompare(String(b.date)));

const targetCompleteDays = 90;
let completeCount = history.filter(isComplete).length;
let fetchedDates = 0;
let missingIndexDays = 0;
let missingTpexDays = 0;
let missingMarginDays = 0;
let missingDaytradeDays = 0;

console.log('歷史回補起始：現有 ' + history.length + ' 個日期；完整樣本 ' + completeCount + '/' + targetCompleteDays + '。');
const candidates = buildDateCandidates(latestDate, 260);
const byDate = new Map(history.map(item => [item.date, item]));

for (const date of candidates) {
  if (completeCount >= targetCompleteDays) break;
  const prior = byDate.get(date);
  if (prior && isComplete(prior)) continue;

  let twse;
  try {
    twse = await fetchTwseIndex(date);
  } catch (error) {
    missingIndexDays++;
    continue;
  }
  if (!twse) {
    missingIndexDays++;
    continue;
  }

  let margin = null;
  try { margin = await fetchTwseMargin(date); }
  catch (error) { missingMarginDays++; console.log('融資 ' + date + '：' + error.message); }

  let otc = null;
  try { otc = await fetchTpexBreadth(date); }
  catch (error) { missingTpexDays++; console.log('上櫃廣度 ' + date + '：' + error.message); }

  let daytrade = null;
  try {
    const monthRows = await fetchDaytradeMonth(date);
    daytrade = monthRows.get(date) || null;
  } catch (error) {
    missingDaytradeDays++;
    console.log('當沖 ' + date + '：' + error.message);
  }
  if (!daytrade) missingDaytradeDays++;

  const advance = twse.listed.advance + (otc?.advance || 0);
  const decline = twse.listed.decline + (otc?.decline || 0);
  const unchanged = twse.listed.unchanged + (otc?.unchanged || 0);
  const merged = {
    ...(prior || {}),
    date,
    close: twse.index.close,
    changePct: twse.index.changePct,
    advance,
    decline,
    unchanged,
    breadthCoverage: otc ? '上市＋上櫃' : '僅上市',
    marginBalanceYi: margin?.todayBalanceYi ?? prior?.marginBalanceYi ?? null,
    marginChangePct: margin?.deltaPct ?? prior?.marginChangePct ?? null,
    daytradeSharePct: daytrade?.volumeSharePct ?? prior?.daytradeSharePct ?? null,
    accountMonth: monthAvailableFromDate(date, accountHistory) || prior?.accountMonth || null,
    backfilled: true
  };
  byDate.set(date, merged);
  fetchedDates++;
  if (isComplete(merged)) completeCount++;
  if (fetchedDates % 10 === 0) {
    console.log('歷史回補進度：新增/更新 ' + fetchedDates + ' 日；完整樣本 ' + completeCount + '/' + targetCompleteDays + '。');
  }
}
history = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-500);
calculateScores(history, accountHistory);

const currentRow = history.find(item => item.date === latestDate);
const priorHistory = history.filter(item => item.date < latestDate);
const currentDeclineRatio = currentRow && currentRow.advance + currentRow.decline > 0
  ? currentRow.decline / (currentRow.advance + currentRow.decline) * 100 : null;
const currentDownMove = Number.isFinite(currentRow?.changePct) ? Math.max(0, -currentRow.changePct) : null;
const priorBreadthRatios = priorHistory
  .filter(item => item.breadthCoverage === currentRow?.breadthCoverage && Number.isFinite(item.advance) && Number.isFinite(item.decline) && item.advance + item.decline > 0)
  .map(item => item.decline / (item.advance + item.decline) * 100);
const priorDownMoves = priorHistory.filter(item => Number.isFinite(item.changePct)).map(item => Math.max(0, -item.changePct));
const breadthPctl = pctRank(priorBreadthRatios, currentDeclineRatio, 60);
const downMovePctl = pctRank(priorDownMoves, currentDownMove, 60);
const fearIndex = breadthPctl !== null && downMovePctl !== null ? Math.round((breadthPctl + downMovePctl) / 2) : null;

const marginPoints = history.filter(item => Number.isFinite(item.marginBalanceYi));
const margin20Series = [];
for (let i = 20; i < marginPoints.length; i++) {
  const start = marginPoints[i - 20].marginBalanceYi;
  const end = marginPoints[i].marginBalanceYi;
  if (start > 0 && end > 0) margin20Series.push((end / start - 1) * 100);
}
const currentMargin20d = margin20Series.at(-1) ?? null;
const priorMargin20d = margin20Series.slice(0, -1);
const marginPctl = pctRank(priorMargin20d, currentMargin20d, 60);
const priorDaytrade = priorHistory.filter(item => Number.isFinite(item.daytradeSharePct)).map(item => item.daytradeSharePct);
const currentDaytrade = Number.isFinite(currentRow?.daytradeSharePct) ? currentRow.daytradeSharePct : null;
const daytradePctl = pctRank(priorDaytrade, currentDaytrade, 60);
const currentAccount = latest.normalized.accounts?.month
  ? accountHistory.find(item => item.month === latest.normalized.accounts.month)
  : null;
const priorAccountRates = currentAccount
  ? accountHistory.filter(item => item.month < currentAccount.month).map(item => item.netChangePct)
  : [];
const accountPctl = currentAccount ? pctRank(priorAccountRates, currentAccount.netChangePct, 12) : null;
const heatComponents = [];
if (marginPctl !== null) heatComponents.push({ key: 'margin20d', label: '融資餘額 20 日變化', value: currentMargin20d, unit: '%', percentile: marginPctl, samples: priorMargin20d.filter(Number.isFinite).length, weight: 0.4 });
if (daytradePctl !== null) heatComponents.push({ key: 'daytrade', label: '當沖成交股數占比', value: currentDaytrade, unit: '%', percentile: daytradePctl, samples: priorDaytrade.length, weight: 0.4 });
if (accountPctl !== null) heatComponents.push({ key: 'accounts', label: '開戶總數月淨增率', value: currentAccount.netChangePct, unit: '%', percentile: accountPctl, samples: priorAccountRates.filter(Number.isFinite).length, weight: 0.2 });
const heatWeight = heatComponents.reduce((sum, item) => sum + item.weight, 0);
const heatIndex = heatComponents.length >= 2
  ? Math.round(heatComponents.reduce((sum, item) => sum + item.percentile * item.weight, 0) / heatWeight)
  : null;

const completeDailySamples = history.filter(isComplete).length;
const sentiment = {
  heatIndex,
  fearIndex,
  heatStatus: heatIndex === null ? '樣本不足' : heatIndex >= 90 ? '極端過熱' : heatIndex >= 80 ? '偏熱' : heatIndex <= 20 ? '冷淡' : '中性區間',
  fearStatus: fearIndex === null ? '樣本不足' : fearIndex >= 90 ? '極端恐慌' : fearIndex >= 80 ? '恐慌偏高' : '未達恐慌門檻',
  heatComponents,
  fearComponents: [
    { key: 'breadth', label: '下跌家數占比', value: currentDeclineRatio, percentile: breadthPctl, samples: priorBreadthRatios.length },
    { key: 'downMove', label: '指數單日跌幅', value: currentDownMove, percentile: downMovePctl, samples: priorDownMoves.length }
  ],
  dailySamples: history.length,
  completeDailySamples,
  accountMonths: accountHistory.length,
  targetCompleteDailySamples: targetCompleteDays,
  backfillStatus: completeDailySamples >= targetCompleteDays ? 'completed' : 'partial',
  methodology: '群眾過熱：融資餘額20個有效交易觀測值變化、上市當沖成交股數占比、開戶總數月淨增率的歷史百分位加權；恐慌：上市＋上櫃下跌家數占比與指數單日跌幅的歷史百分位平均。每日比較至少60筆歷史樣本；開戶成長率至少12個前期月度樣本。'
};
latest.normalized.sentiment = sentiment;
latest.history = history;
latest.historyCount = history.length;
latest.completeDailySamples = completeDailySamples;
latest.accountHistoryCount = accountHistory.length;
latest.generatedAt = new Date().toISOString();
fs.writeFileSync('data/history.json', JSON.stringify(history, null, 2) + '\n');
fs.writeFileSync('data/latest.json', JSON.stringify(latest, null, 2) + '\n');
fs.writeFileSync('data/backfill-status.json', JSON.stringify({
  generatedAt: latest.generatedAt,
  tradingDate: latestDate,
  targetCompleteDailySamples: targetCompleteDays,
  completeDailySamples,
  historyRows: history.length,
  accountMonths: accountHistory.length,
  fetchedDates,
  skippedIndexDates: missingIndexDays,
  missingTpexDays,
  missingMarginDays,
  missingDaytradeDays,
  status: completeDailySamples >= targetCompleteDays ? 'completed' : 'partial'
}, null, 2) + '\n');

console.log('歷史回補完成：' + completeDailySamples + '/' + targetCompleteDays + ' 個完整日樣本；歷史總列數 ' + history.length + '；月開戶資料 ' + accountHistory.length + '；過熱指數 ' + (heatIndex ?? '樣本不足') + '；恐慌指數 ' + (fearIndex ?? '樣本不足') + '。');
if (completeDailySamples < 60) {
  console.log('注意：完整日樣本尚未達到60筆，情緒指數保持未計算，不會以缺值替代。');
}
