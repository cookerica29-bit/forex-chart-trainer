// netlify/functions/forex-data.js
// Serverless proxy that fetches OHLC candles from a primary provider (Yahoo Finance)
// and falls back to a secondary provider (Stooq) if Yahoo is unavailable or rate-limits.
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
// Entries expire after CACHE_TTL_MS.
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

function formatTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

// ----------------------- Yahoo provider -----------------------
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
      time: formatTime(ts[i]),
      open: Number(o), high: Number(h), low: Number(l), close: Number(c),
    });
  }
  return candles;
}

// ----------------------- Stooq provider (fallback) -----------------------
const STOOQ_SYMBOL = {
  "EURUSD=X": "eurusd",
  "GBPUSD=X": "gbpusd",
  "USDJPY=X": "usdjpy",
  "GBPJPY=X": "gbpjpy",
  "XAUUSD=X": "xauusd",
  "GC=F": "xauusd",
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
      const o = cols[2], h = cols[3], l = cols[4], c = cols[5];
      const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
      if ([open, high, low, close].some((v) => !isFinite(v))) continue;
      const hhmm = (time || "").slice(0, 5);
      candles.push({ time: hhmm, open, high, low, close });
    } else {
      if (cols.length < 5) continue;
      const date = cols[0];
      const o = cols[1], h = cols[2], l = cols[3], c = cols[4];
      const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
      if ([open, high, low, close].some((v) => !isFinite(v))) continue;
      candles.push({ time: date, open, high, low, close });
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
    if (!text || text.toLowerCase().includes("no data")) {
      return { error: { stage: "stooq-empty", bodySnippet: text.slice(0, 200) } };
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

    const wants4h = interval === "4h";
    const fetchInterval = wants4h ? "60m" : interval === "1h" ? "60m" : interval;
    const range = pickRangeFor(fetchInterval);

    const yahoo = await fetchYahoo(symbol, fetchInterval, range);
    let candles = null;
    let source = null;
    let yahooError = null;

    if (yahoo && yahoo.json) {
      const parsed = yahooToCandles(yahoo.json);
      if (parsed && parsed.length > 0) {
        candles = parsed;
        source = "yahoo:" + yahoo.host;
      } else {
        yahooError = { stage: "yahoo-no-candles", host: yahoo.host };
      }
    } else if (yahoo && yahoo.error) {
      yahooError = yahoo.error;
    }

    let stooqError = null;
    if (!candles) {
      const stooq = await fetchStooq(symbol, fetchInterval);
      if (stooq && stooq.candles && stooq.candles.length > 0) {
        candles = stooq.candles;
        source = "stooq";
      } else {
        stooqError = (stooq && stooq.error) || { stage: "stooq-unknown" };
      }
    }

    if (!candles) {
      return fail(502, {
        error: "All providers failed",
        yahoo: yahooError,
        stooq: stooqError,
      });
    }

    if (wants4h) candles = aggregateTo4h(candles);
    if (candles.length > 240) candles = candles.slice(candles.length - 240);

    const payload = { symbol, interval, candles, source, yahooError: yahooError || undefined };
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
