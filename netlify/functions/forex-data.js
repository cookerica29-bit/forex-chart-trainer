// netlify/functions/forex-data.js
// Serverless proxy that fetches Yahoo Finance OHLC candles and
// returns them in the shape: { symbol, interval, candles: [{ time, open, high, low, close }] }
//
// Query params:
//   symbol   Yahoo Finance symbol, e.g. EURUSD=X, GBPJPY=X, GC=F
//   interval Yahoo Finance interval: 5m, 15m, 30m, 60m (or 1h), 4h (built from 60m), 1d

const ALLOWED_SYMBOLS = new Set([
  "EURUSD=X",
  "GBPUSD=X",
  "USDJPY=X",
  "GBPJPY=X",
  "GC=F",
  "XAUUSD=X",
]);

const ALLOWED_INTERVALS = new Set(["5m", "15m", "30m", "60m", "1h", "4h", "1d"]);

function pickRangeFor(interval) {
  switch (interval) {
    case "5m":
      return "5d";
    case "15m":
      return "5d";
    case "30m":
      return "1mo";
    case "60m":
    case "1h":
      return "1mo";
    case "4h":
      return "3mo";
    case "1d":
      return "1y";
    default:
      return "1mo";
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
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchYahoo(symbol, interval, range) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastError = null;
  for (const host of hosts) {
    const url =
      "https://" + host + "/v8/finance/chart/" + encodeURIComponent(symbol) +
      "?interval=" + encodeURIComponent(interval) +
      "&range=" + encodeURIComponent(range) +
      "&includePrePost=false";
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      const text = await res.text();
      if (!res.ok) {
        lastError = { stage: "upstream-status", host, status: res.status, bodySnippet: text.slice(0, 200) };
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        lastError = { stage: "upstream-parse", host, message: String(e && e.message), bodySnippet: text.slice(0, 200) };
        continue;
      }
      if (json && json.chart && json.chart.error) {
        lastError = { stage: "upstream-error", host, error: json.chart.error };
        continue;
      }
      return { json, host, url };
    } catch (e) {
      lastError = { stage: "fetch-throw", host, message: String(e && e.message) };
      continue;
    }
  }
  return { error: lastError };
}

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

    const wants4h = interval === "4h";
    const fetchInterval = wants4h ? "60m" : interval === "1h" ? "60m" : interval;
    const range = pickRangeFor(fetchInterval);

    const fetched = await fetchYahoo(symbol, fetchInterval, range);
    if (fetched.error) {
      return fail(502, { error: "Upstream fetch failed", detail: fetched.error });
    }

    const json = fetched.json;
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result || !result.timestamp || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) {
      return fail(502, {
        error: "Malformed upstream payload",
        host: fetched.host,
        chartErrorField: json && json.chart && json.chart.error,
        keys: result ? Object.keys(result) : null,
      });
    }

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const opens = q.open || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const closes = q.close || [];

    let candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({
        time: formatTime(ts[i]),
        open: Number(o),
        high: Number(h),
        low: Number(l),
        close: Number(c),
      });
    }

    if (candles.length === 0) {
      return fail(502, { error: "No usable candles in upstream response", host: fetched.host, tsLength: ts.length });
    }

    if (wants4h) {
      candles = aggregateTo4h(candles);
    }

    if (candles.length > 240) {
      candles = candles.slice(candles.length - 240);
    }

    return {
      statusCode: 200,
      headers: { ...headers, "Cache-Control": "public, max-age=60" },
      body: JSON.stringify({ symbol, interval, candles, source: fetched.host }),
    };
  } catch (err) {
    return fail(500, {
      error: "Function error",
      message: String(err && err.message),
      stack: String(err && err.stack || "").split("\n").slice(0, 5).join(" | "),
    });
  }
};
