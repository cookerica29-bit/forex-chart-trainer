// netlify/functions/forex-data.js
// Serverless proxy that fetches Yahoo Finance OHLC candles and
// returns them in the shape: [{ time, open, high, low, close }]
//
// Query params:
//   symbol   Yahoo Finance symbol, e.g. EURUSD=X, GBPJPY=X, GC=F
//   interval Yahoo Finance interval: 5m, 15m, 30m, 60m (mapped from 1H), 4h (built from 60m if needed)
//   range    Yahoo Finance range:    1d, 5d, 1mo, 3mo, etc.
//
// Yahoo's public chart endpoint is:
//   https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=...&range=...

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

// Yahoo doesn't natively serve 4h forex bars; build them from 60m bars.
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
  return `${hh}:${mm}`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const params = event.queryStringParameters || {};
    const symbol = (params.symbol || "EURUSD=X").trim();
    let interval = (params.interval || "15m").trim().toLowerCase();

    if (!ALLOWED_SYMBOLS.has(symbol)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Symbol not allowed", symbol }),
      };
    }
    if (!ALLOWED_INTERVALS.has(interval)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Interval not allowed", interval }),
      };
    }

    const wants4h = interval === "4h";
    const fetchInterval = wants4h ? "60m" : interval === "1h" ? "60m" : interval;
    const range = pickRangeFor(fetchInterval);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?interval=${encodeURIComponent(fetchInterval)}&range=${encodeURIComponent(range)}`;

    const upstream = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
      },
    });

    if (!upstream.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "Upstream error",
          status: upstream.status,
        }),
      };
    }

    const json = await upstream.json();
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result || !result.timestamp || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "Malformed upstream payload" }),
      };
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

    if (wants4h) {
      candles = aggregateTo4h(candles);
    }

    // Cap payload size
    if (candles.length > 240) {
      candles = candles.slice(candles.length - 240);
    }

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Cache-Control": "public, max-age=60",
      },
      body: JSON.stringify({ symbol, interval, candles }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Function error", message: String(err && err.message) }),
    };
  }
};
