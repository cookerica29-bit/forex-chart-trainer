// netlify/functions/forex-data.js
// Live OHLC proxy. Primary provider: Twelve Data (requires TWELVE_DATA_API_KEY env var).
// Optional fallbacks: Yahoo Finance, Stooq (kept for resilience).
// Returns { symbol, interval, candles: [{ time, open, high, low, close }], source }

const ALLOWED_SYMBOLS = new Set([
  "EURUSD=X",
  "GBPUSD=X",
  "USDJPY=X",
  "GBPJPY=X",
  "GC=F",
  "XAUUSD=X",
]);
const ALLOWED_INTERVALS = new Set(["5m", "15m", "30m", "60m", "1h", "4h", "1d"]);

// In-memory cache (per warm Lambda instance). Keys are symbol|interval.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.v;
}
function cacheSet(key, value) {
  cache.set(key, { t: Date.now(), v: value });
}

function pickRangeFor(interval) {
  switch (interval) {
    case "5m": return "5d";
    case "15m": return "5d";
    case "30m": return "1mo";
    case "60m":
    case "1h": return "1mo";
    case "4h": return "3mo";
    case "1d": return "1y";
    default: return "1mo";
  }
}

function aggregateTo4h(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i += 4) {
    const slice = candles.slice(i, i + 4);
    if (slice.length === 0) continue;
    const open = slice[0].open;
    const close = slice[slice.length - 1].close;
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    const time = slice[0].time;
    out.push({ time, open, high, low, close });
  }
  return out;
}

function formatTimeFromUnix(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

// Twelve Data datetime is "YYYY-MM-DD HH:MM:SS" (intraday) or "YYYY-MM-DD" (daily).
function formatTimeFromTwelveData(datetime) {
  if (!datetime) return "";
  const t = String(datetime).trim();
  if (t.length >= 16 && t.indexOf(" ") === 10) return t.slice(11, 16); // HH:MM
  return t.slice(0, 10); // date
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

// ----------------------- Twelve Data (PRIMARY) -----------------------
// API: https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=15min&outputsize=240&apikey=KEY
const TWELVE_SYMBOL = {
  "EURUSD=X": "EUR/USD",
  "GBPUSD=X": "GBP/USD",
  "USDJPY=X": "USD/JPY",
  "GBPJPY=X": "GBP/JPY",
  "XAUUSD=X": "XAU/USD",
  "GC=F":     "XAU/USD", // map gold futures to spot gold pair on Twelve Data
};
function twelveInterval(interval) {
  if (interval === "5m") return "5min";
  if (interval === "15m") return "15min";
  if (interval === "30m") return "30min";
  if (interval === "60m" || interval === "1h") return "1h";
  if (interval === "4h") return "4h";
  return "1day";
}

async function fetchTwelveData(symbol, interval, apiKey) {
  const tdSymbol = TWELVE_SYMBOL[symbol];
  if (!tdSymbol) {
    return { error: { stage: "twelvedata-mapping", message: "No Twelve Data symbol mapped for " + symbol } };
  }
  const tdInterval = twelveInterval(interval);
  const url = "https://api.twelvedata.com/time_series" +
    "?symbol=" + encodeURIComponent(tdSymbol) +
    "&interval=" + encodeURIComponent(tdInterval) +
    "&outputsize=240" +
    "&format=JSON" +
    "&apikey=" + encodeURIComponent(apiKey);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    const text = await res.text();
    if (!res.ok) {
      return { error: { stage: "twelvedata-status", status: res.status, bodySnippet: text.slice(0, 200) } };
    }
    let json;
    try { json = JSON.parse(text); } catch (e) {
      return { error: { stage: "twelvedata-parse", message: String(e && e.message), bodySnippet: text.slice(0, 200) } };
    }
    // Twelve Data signals errors with status: "error"
    if (json && json.status === "error") {
      return { error: { stage: "twelvedata-api-error", code: json.code, message: json.message || "Twelve Data error" } };
    }
    const values = json && json.values;
    if (!Array.isArray(values) || values.length === 0) {
      return { error: { stage: "twelvedata-empty", message: "No values returned", bodySnippet: text.slice(0, 200) } };
    }
    // Twelve Data returns newest-first; reverse to chronological.
    const ordered = values.slice().reverse();
    const candles = [];
    for (const row of ordered) {
      const o = Number(row.open);
      const h = Number(row.high);
      const l = Number(row.low);
      const c = Number(row.close);
      if ([o, h, l, c].some((v) => !isFinite(v))) continue;
      candles.push({
        time: formatTimeFromTwelveData(row.datetime),
        open: o, high: h, low: l, close: c,
      });
    }
    if (candles.length === 0) {
      return { error: { stage: "twelvedata-no-usable-rows" } };
    }
    return { candles };
  } catch (e) {
    return { error: { stage: "twelvedata-fetch-throw", message: String(e && e.message) } };
  }
}

// ----------------------- Yahoo (optional fallback) -----------------------
async function fetchYahoo(symbol, interval, range) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastError = null;
  for (const host of hosts) {
    const url = "https://" + host + "/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=" + encodeURIComponent(interval) +
      "&range=" + encodeURIComponent(range) +
      "&includePrePost=false";
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      const text = await res.text();
      if (!res.ok) {
        lastError = { stage: "yahoo-status", host, status: res.status, bodySnippet: text.slice(0, 200) };
        if (res.status === 429) return { error: lastError, rateLimited: true };
        continue;
      }
      let json;
      try { json = JSON.parse(text); } catch (e) {
        lastError = { stage: "yahoo-parse", host, message: String(e && e.message), bodySnippet: text.slice(0, 200) };
        continue;
      }
      if (json && json.chart && json.chart.error) {
        lastError = { stage: "yahoo-error", host, error: json.chart.error };
        continue;
      }
      return { json, host };
    } catch (e) {
      lastError = { stage: "yahoo-fetch-throw", host, message: String(e && e.message) };
      continue;
    }
  }
  return { error: lastError };
}

function yahooToCandles(json) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) {
    return null;
  }
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const closes = q.close || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      time: formatTimeFromUnix(ts[i]),
      open: Number(o), high: Number(h), low: Number(l), close: Number(c),
    });
  }
  return candles;
}

// ----------------------- Stooq (optional fallback) -----------------------
const STOOQ_SYMBOL = {
  "EURUSD=X": "eurusd",
  "GBPUSD=X": "gbpusd",
  "USDJPY=X": "usdjpy",
  "GBPJPY=X": "gbpjpy",
  "XAUUSD=X": "xauusd",
  "GC=F":     "xauusd",
};
function stooqInterval(interval) {
  if (interval === "5m") return "5";
  if (interval === "15m") return "15";
  if (interval === "30m") return "30";
  if (interval === "60m" || interval === "1h") return "60";
  if (interval === "4h") return "60";
  return "d";
}
function parseStooqCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  const intraday = header.includes("time");
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (intraday) {
      if (cols.length < 6) continue;
      const time = cols[1];
      const o = Number(cols[2]), h = Number(cols[3]), l = Number(cols[4]), c = Number(cols[5]);
      if ([o, h, l, c].some((v) => !isFinite(v))) continue;
      candles.push({ time: (time || "").slice(0, 5), open: o, high: h, low: l, close: c });
    } else {
      if (cols.length < 5) continue;
      const date = cols[0];
      const o = Number(cols[1]), h = Number(cols[2]), l = Number(cols[3]), c = Number(cols[4]);
      if ([o, h, l, c].some((v) => !isFinite(v))) continue;
      candles.push({ time: date, open: o, high: h, low: l, close: c });
    }
  }
  return candles;
}
async function fetchStooq(symbol, interval) {
  const stooqSym = STOOQ_SYMBOL[symbol];
  if (!stooqSym) {
    return { error: { stage: "stooq-mapping", message: "No Stooq symbol mapped for " + symbol } };
  }
  const i = stooqInterval(interval);
  const url = "https://stooq.com/q/d/l/?s=" + encodeURIComponent(stooqSym) + "&i=" + encodeURIComponent(i);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    const text = await res.text();
    if (!res.ok) {
      return { error: { stage: "stooq-status", status: res.status, bodySnippet: text.slice(0, 200) } };
    }
    if (!text || text.toLowerCase().includes("no data") || text.toLowerCase().includes("captcha")) {
      return { error: { stage: "stooq-blocked", bodySnippet: text.slice(0, 200) } };
    }
    const candles = parseStooqCsv(text);
    if (candles.length === 0) {
      return { error: { stage: "stooq-parse-empty", bodySnippet: text.slice(0, 200) } };
    }
    return { candles };
  } catch (e) {
    return { error: { stage: "stooq-fetch-throw", message: String(e && e.message) } };
  }
}

// ----------------------- Handler -----------------------
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  const fail = (statusCode, payload) => ({
    statusCode,
    headers,
    body: JSON.stringify(payload),
  });

  try {
    if (typeof fetch !== "function") {
      return fail(500, {
        error: "fetch is not available in this Node runtime",
        hint: "Set Node 18+ in netlify.toml [build.environment] NODE_VERSION = '18'",
      });
    }

    const params = (event && event.queryStringParameters) || {};
    const symbol = (params.symbol || "EURUSD=X").trim();
    let interval = (params.interval || "15m").trim().toLowerCase();
    const allowFallback = params.fallback !== "0";

    if (!ALLOWED_SYMBOLS.has(symbol)) {
      return fail(400, { error: "Symbol not allowed", symbol, allowed: Array.from(ALLOWED_SYMBOLS) });
    }
    if (!ALLOWED_INTERVALS.has(interval)) {
      return fail(400, { error: "Interval not allowed", interval, allowed: Array.from(ALLOWED_INTERVALS) });
    }

    const cacheKey = symbol + "|" + interval;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return {
        statusCode: 200,
        headers: { ...headers, "Cache-Control": "public, max-age=600", "X-Cache": "HIT" },
        body: JSON.stringify(cached),
      };
    }

    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      return fail(500, { error: "Missing TWELVE_DATA_API_KEY" });
    }

    const wants4h = interval === "4h";
    const fetchInterval = wants4h ? "60m" : interval === "1h" ? "60m" : interval;
    const range = pickRangeFor(fetchInterval);

    let candles = null;
    let source = null;
    const providerErrors = {};

    // ---- Provider 1: Twelve Data (primary) ----
    const twelveInt = wants4h ? "4h" : (interval === "1h" || interval === "60m") ? "1h" : interval;
    const td = await fetchTwelveData(symbol, twelveInt, apiKey);
    if (td && td.candles && td.candles.length > 0) {
      candles = td.candles;
      source = "twelvedata";
    } else if (td && td.error) {
      providerErrors.twelvedata = td.error;
    }

    // ---- Provider 2: Yahoo (optional fallback) ----
    if (!candles && allowFallback) {
      const yahoo = await fetchYahoo(symbol, fetchInterval, range);
      if (yahoo && yahoo.json) {
        const parsed = yahooToCandles(yahoo.json);
        if (parsed && parsed.length > 0) {
          candles = parsed;
          source = "yahoo:" + yahoo.host;
        } else {
          providerErrors.yahoo = { stage: "yahoo-no-candles", host: yahoo.host };
        }
      } else if (yahoo && yahoo.error) {
        providerErrors.yahoo = yahoo.error;
      }
    }

    // ---- Provider 3: Stooq (optional fallback) ----
    if (!candles && allowFallback) {
      const stooq = await fetchStooq(symbol, fetchInterval);
      if (stooq && stooq.candles && stooq.candles.length > 0) {
        candles = stooq.candles;
        source = "stooq";
      } else if (stooq && stooq.error) {
        providerErrors.stooq = stooq.error;
      }
    }

    if (!candles) {
      return fail(502, {
        error: "All providers failed",
        providers: providerErrors,
      });
    }

    if (wants4h && source !== "twelvedata") candles = aggregateTo4h(candles);
    if (candles.length > 240) candles = candles.slice(candles.length - 240);

    const payload = {
      symbol,
      interval,
      candles,
      source,
      providerErrors: Object.keys(providerErrors).length ? providerErrors : undefined,
    };
    cacheSet(cacheKey, payload);

    return {
      statusCode: 200,
      headers: { ...headers, "Cache-Control": "public, max-age=600", "X-Cache": "MISS" },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return fail(500, {
      error: "Function error",
      message: String(err && err.message),
      stack: String(err && err.stack || "").split("\n").slice(0, 5).join(" | "),
    });
  }
};
