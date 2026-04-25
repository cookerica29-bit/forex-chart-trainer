import React, { useMemo, useState, useEffect } from "react";

const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "GBPJPY"];
const SESSIONS = ["Asia", "London", "New York"];
const TIMEFRAMES = ["5m", "15m", "1H", "4H"];

const YAHOO_SYMBOL = {
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "USDJPY=X",
  GBPJPY: "GBPJPY=X",
  XAUUSD: "GC=F",
};

const YAHOO_INTERVAL = {
  "5m": "5m",
  "15m": "15m",
  "1H": "60m",
  "4H": "4h",
};

function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function decimalsFor(pair) {
  if (pair === "XAUUSD") return 2;
  if (pair.includes("JPY")) return 3;
  return 5;
}

async function fetchYahooFinanceData(pair, timeframe) {
  const symbol = YAHOO_SYMBOL[pair];
  const interval = YAHOO_INTERVAL[timeframe] || "15m";
  if (!symbol) return null;
  const url = `/.netlify/functions/forex-data?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.candles) || json.candles.length === 0) return null;
    return json.candles.map((c, index) => ({
      index,
      time: c.time,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
  } catch (err) {
    return null;
  }
}

function makeScenario(pair, session, timeframe, seed = 12) {
  const baseMap = {
    EURUSD: 1.0825,
    GBPUSD: 1.264,
    USDJPY: 154.2,
    XAUUSD: 2325,
    GBPJPY: 192.5,
  };
  const base = baseMap[pair] || 1.1;
  const pip = pair === "XAUUSD" ? 1.2 : pair.includes("JPY") ? 0.04 : 0.00035;
  const sessionBias = session === "London" ? 1 : session === "New York" ? -1 : 0.35;
  const tfVol = timeframe === "5m" ? 0.75 : timeframe === "15m" ? 1 : timeframe === "1H" ? 1.35 : 1.8;
  const precision = decimalsFor(pair);
  let close = base;
  const data = [];
  for (let i = 0; i < 120; i++) {
    const open = close;
    const wave = Math.sin(i / 7) * pip * 1.4;
    const trendPush =
      i > 25 && i < 55
        ? sessionBias * pip * 0.75 * tfVol
        : i > 75 && i < 98
          ? -sessionBias * pip * 0.6 * tfVol
          : sessionBias * pip * 0.12;
    const noise = (seededRandom(seed + i * 9.33) - 0.5) * pip * 2.8 * tfVol;
    close = open + trendPush + wave + noise;
    if (i === 31) close = open - sessionBias * pip * 9;
    if (i === 42) close = open + sessionBias * pip * 12;
    if (i === 82) close = open + sessionBias * pip * 7;
    if (i === 91) close = open - sessionBias * pip * 13;
    const wickUp = (0.8 + seededRandom(seed + i * 2.1) * 2.4) * pip * tfVol;
    const wickDown = (0.8 + seededRandom(seed + i * 4.7) * 2.4) * pip * tfVol;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;
    data.push({
      index: i,
      time: `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`,
      open: Number(open.toFixed(precision)),
      high: Number(high.toFixed(precision)),
      low: Number(low.toFixed(precision)),
      close: Number(close.toFixed(precision)),
    });
  }
  const high = Math.max(...data.map((d) => d.high));
  const low = Math.min(...data.map((d) => d.low));
  const mid = (high + low) / 2;
  const bullish = session !== "New York";
  const answer = bullish
    ? {
        bias: "Bullish continuation",
        trend: "Higher highs / higher lows after sell-side liquidity sweep",
        liquidity: "Price swept sell-side liquidity, then displaced back up",
        poi: "Discount demand zone after displacement",
        entry: "Wait for pullback into demand and bullish confirmation",
        invalidation: "Below the swept low",
        target: "Previous high / buy-side liquidity",
        verdict: "This is a long idea only after confirmation. The sweep itself is not the entry.",
      }
    : {
        bias: "Bearish continuation",
        trend: "Lower highs / lower lows after buy-side liquidity sweep",
        liquidity: "Price swept buy-side liquidity, then displaced back down",
        poi: "Premium supply zone after displacement",
        entry: "Wait for pullback into supply and bearish confirmation",
        invalidation: "Above the swept high",
        target: "Previous low / sell-side liquidity",
        verdict: "This is a short idea only after confirmation. The sweep itself is not the entry.",
      };
  return {
    data,
    answer,
    levels: {
      high: Number(high.toFixed(precision)),
      low: Number(low.toFixed(precision)),
      mid: Number(mid.toFixed(precision)),
    },
    zones: bullish
      ? { poiStart: 31, poiEnd: 45, poiLabel: "Demand POI after sell-side sweep", poiClass: "fill-emerald-500/10 stroke-emerald-400/30" }
      : { poiStart: 31, poiEnd: 45, poiLabel: "Supply POI after buy-side sweep", poiClass: "fill-rose-500/10 stroke-rose-400/30" },
  };
}

const blankChecklist = {
  bias: "",
  trend: "",
  liquidity: "",
  poi: "",
  entry: "",
  invalidation: "",
  target: "",
};

// ----------------------------------------------------------------------
// A+ Setup Score Engine
// ----------------------------------------------------------------------
// Scores 7 components (each 0-100) then weights them into a final 0-100.
// Components:
//   htfBias            HTF bias alignment with model answer
//   liquidity          Liquidity sweep quality (swept vs targeted, side)
//   poi                POI quality (named zone in discount/premium)
//   displacement       Displacement strength (post-sweep momentum)
//   sessionTiming      Session timing (London / NY kill zones favored)
//   entryConfirmation  Entry confirmation present (waits for confirmation)
//   rrQuality          RR quality (target vs invalidation logic)
// ----------------------------------------------------------------------

const STRUCTURE_KEYWORDS = ["sweep", "swept", "liquidity", "displacement", "displaced", "bos", "choch", "fvg", "ob", "order block", "imbalance"];
const POI_KEYWORDS = ["demand", "supply", "ob", "order block", "fvg", "imbalance", "discount", "premium", "poi", "zone"];
const CONFIRMATION_KEYWORDS = ["confirm", "wait", "pullback", "retrace", "ltf", "1m", "5m", "displacement"];

function textHas(text, keywords) {
  if (!text) return false;
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

function lengthScore(text, target = 25) {
  if (!text) return 0;
  const len = text.trim().length;
  if (len === 0) return 0;
  return Math.min(100, Math.round((len / target) * 100));
}

function scoreSetup({ checklist, scenario, session, timeframe }) {
  const answer = scenario.answer;
  const userBias = (checklist.bias || "").toLowerCase();
  const userTrend = (checklist.trend || "").toLowerCase();
  const userLiq = (checklist.liquidity || "").toLowerCase();
  const userPoi = (checklist.poi || "").toLowerCase();
  const userEntry = (checklist.entry || "").toLowerCase();
  const userInval = (checklist.invalidation || "").toLowerCase();
  const userTarget = (checklist.target || "").toLowerCase();

  const modelBullish = answer.bias.toLowerCase().includes("bullish");

  // 1. HTF bias alignment
  let htfBias = 0;
  if (userBias) {
    const userBullish = userBias.includes("bull") || userBias.includes("long") || userBias.includes("up");
    const userBearish = userBias.includes("bear") || userBias.includes("short") || userBias.includes("down");
    if (modelBullish && userBullish) htfBias = 100;
    else if (!modelBullish && userBearish) htfBias = 100;
    else if (userBias.length > 0) htfBias = 35;
  }

  // 2. Liquidity sweep quality
  let liquidity = 0;
  if (userLiq) {
    const hasStructure = textHas(userLiq, STRUCTURE_KEYWORDS);
    const sideMatch = modelBullish
      ? userLiq.includes("sell") || userLiq.includes("low") || userLiq.includes("ssl")
      : userLiq.includes("buy") || userLiq.includes("high") || userLiq.includes("bsl");
    liquidity = (hasStructure ? 60 : 25) + (sideMatch ? 40 : 0);
    liquidity = Math.min(100, liquidity);
  }

  // 3. POI quality
  let poi = 0;
  if (userPoi) {
    const named = textHas(userPoi, POI_KEYWORDS);
    const sideMatch = modelBullish ? userPoi.includes("demand") || userPoi.includes("discount") : userPoi.includes("supply") || userPoi.includes("premium");
    poi = (named ? 55 : 20) + (sideMatch ? 45 : 0);
    poi = Math.min(100, poi);
  }

  // 4. Displacement strength (from trend description)
  let displacement = 0;
  if (userTrend) {
    const hasStruct = textHas(userTrend, ["bos", "choch", "displacement", "displaced", "higher high", "lower low", "hh", "ll"]);
    const trendDir = modelBullish
      ? userTrend.includes("higher") || userTrend.includes("bull") || userTrend.includes("up")
      : userTrend.includes("lower") || userTrend.includes("bear") || userTrend.includes("down");
    displacement = (hasStruct ? 55 : 25) + (trendDir ? 45 : 0);
    displacement = Math.min(100, displacement);
  }

  // 5. Session timing
  let sessionTiming = 0;
  if (session === "London") sessionTiming = 95;
  else if (session === "New York") sessionTiming = 90;
  else sessionTiming = 55;
  if (timeframe === "5m") sessionTiming = Math.max(0, sessionTiming - 10);

  // 6. Entry confirmation
  let entryConfirmation = 0;
  if (userEntry) {
    const waits = textHas(userEntry, CONFIRMATION_KEYWORDS);
    entryConfirmation = waits ? 90 : 40;
    if (userEntry.includes("market") && !waits) entryConfirmation = 20;
  }

  // 7. RR quality
  let rrQuality = 0;
  if (userInval && userTarget) {
    const invalScore = lengthScore(userInval, 18);
    const targetScore = lengthScore(userTarget, 18);
    const targetGood = modelBullish
      ? userTarget.includes("high") || userTarget.includes("buy") || userTarget.includes("bsl")
      : userTarget.includes("low") || userTarget.includes("sell") || userTarget.includes("ssl");
    rrQuality = Math.round((invalScore + targetScore) / 2);
    if (targetGood) rrQuality = Math.min(100, rrQuality + 15);
  } else if (userInval || userTarget) {
    rrQuality = 30;
  }

  const components = { htfBias, liquidity, poi, displacement, sessionTiming, entryConfirmation, rrQuality };
  const weights = { htfBias: 0.18, liquidity: 0.16, poi: 0.16, displacement: 0.14, sessionTiming: 0.10, entryConfirmation: 0.16, rrQuality: 0.10 };

  let total = 0;
  Object.keys(components).forEach((k) => {
    total += components[k] * weights[k];
  });
  total = Math.round(total);

  let grade;
  if (total >= 90) grade = "A+ Setup";
  else if (total >= 80) grade = "A Setup";
  else if (total >= 65) grade = "B Setup";
  else if (total >= 50) grade = "C Setup";
  else grade = "Avoid";

  return { components, total, grade };
}

function gradeBadgeClasses(grade) {
  if (grade === "A+ Setup") return "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
  if (grade === "A Setup") return "bg-emerald-500/15 text-emerald-200 border border-emerald-500/25";
  if (grade === "B Setup") return "bg-amber-500/15 text-amber-200 border border-amber-500/25";
  if (grade === "C Setup") return "bg-orange-500/15 text-orange-200 border border-orange-500/25";
  return "bg-rose-500/15 text-rose-200 border border-rose-500/25";
}

function Button({ children, onClick, variant = "primary", disabled = false }) {
  const base = "rounded-xl px-4 py-2 font-semibold transition border disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-indigo-600 hover:bg-indigo-500 border-indigo-500 text-white"
      : "bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-100";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles}`} type="button">
      {children}
    </button>
  );
}

function SelectBox({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-xl bg-slate-950 border border-slate-700 px-4 py-2 text-slate-100 outline-none focus:border-indigo-400"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function Card({ children }) {
  return <div className="bg-slate-900/85 border border-slate-800 rounded-2xl shadow-xl p-4 md:p-5">{children}</div>;
}

function CandlestickChart({ data, pair, levels, zones, showLevels, showAnswer }) {
  const width = 1200;
  const height = 430;
  const margin = { top: 24, right: 76, bottom: 34, left: 18 };
  const chartW = width - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;
  const precision = decimalsFor(pair);
  const allHighs = data.map((d) => d.high);
  const allLows = data.map((d) => d.low);
  const maxPrice = Math.max(...allHighs, levels.high);
  const minPrice = Math.min(...allLows, levels.low);
  const padding = (maxPrice - minPrice) * 0.12 || 1;
  const topPrice = maxPrice + padding;
  const bottomPrice = minPrice - padding;
  const xFor = (index) => margin.left + (index / Math.max(data.length - 1, 1)) * chartW;
  const yFor = (price) => margin.top + ((topPrice - price) / (topPrice - bottomPrice)) * chartH;
  const candleW = Math.max(4, Math.min(12, chartW / data.length * 0.58));
  const ticks = Array.from({ length: 5 }, (_, i) => bottomPrice + ((topPrice - bottomPrice) * i) / 4).reverse();
  const zoneRect = (start, end, label, className) => {
    const visibleStart = Math.max(start, 0);
    const visibleEnd = Math.min(end, data.length - 1);
    if (visibleStart >= data.length || visibleEnd <= 0 || visibleEnd <= visibleStart) return null;
    const x = xFor(visibleStart);
    const w = Math.max(0, xFor(visibleEnd) - x);
    return (
      <g>
        <rect x={x} y={margin.top} width={w} height={chartH} className={className} rx="8" strokeWidth="1" />
        <text x={x + 8} y={margin.top + 22} fill="#cbd5e1" fontSize="13">{label}</text>
      </g>
    );
  };
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full rounded-2xl bg-slate-950">
      <rect x="0" y="0" width={width} height={height} fill="#020617" />
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={margin.left} x2={width - margin.right + 18} y1={yFor(tick)} y2={yFor(tick)} stroke="#1e293b" strokeDasharray="5 5" />
          <text x={width - margin.right + 24} y={yFor(tick) + 4} fill="#94a3b8" fontSize="14">
            {tick.toFixed(precision === 5 ? 4 : precision)}
          </text>
        </g>
      ))}
      {data.filter((_, i) => i % 12 === 0).map((d) => (
        <g key={d.index}>
          <line x1={xFor(d.index)} x2={xFor(d.index)} y1={margin.top} y2={height - margin.bottom} stroke="#1e293b" strokeDasharray="5 5" />
          <text x={xFor(d.index) - 18} y={height - 10} fill="#94a3b8" fontSize="13">{d.time}</text>
        </g>
      ))}
      {showAnswer ? zoneRect(zones.poiStart, zones.poiEnd, zones.poiLabel, zones.poiClass) : null}
      {showLevels ? (
        <g>
          <line x1={margin.left} x2={width - margin.right + 18} y1={yFor(levels.high)} y2={yFor(levels.high)} stroke="#64748b" strokeDasharray="8 6" />
          <text x={width - margin.right - 110} y={yFor(levels.high) - 8} fill="#94a3b8" fontSize="13">High liquidity</text>
          <line x1={margin.left} x2={width - margin.right + 18} y1={yFor(levels.low)} y2={yFor(levels.low)} stroke="#64748b" strokeDasharray="8 6" />
          <text x={width - margin.right - 105} y={yFor(levels.low) + 18} fill="#94a3b8" fontSize="13">Low liquidity</text>
          <line x1={margin.left} x2={width - margin.right + 18} y1={yFor(levels.mid)} y2={yFor(levels.mid)} stroke="#475569" strokeDasharray="4 6" />
          <text x={width / 2 - 38} y={yFor(levels.mid) - 8} fill="#94a3b8" fontSize="13">Equilibrium</text>
        </g>
      ) : null}
      {data.map((d) => {
        const bullish = d.close >= d.open;
        const color = bullish ? "#22c55e" : "#ef4444";
        const x = xFor(d.index);
        const yHigh = yFor(d.high);
        const yLow = yFor(d.low);
        const yOpen = yFor(d.open);
        const yClose = yFor(d.close);
        const bodyY = Math.min(yOpen, yClose);
        const bodyH = Math.max(2, Math.abs(yClose - yOpen));
        return (
          <g key={d.index}>
            <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth="1.4" />
            <rect x={x - candleW / 2} y={bodyY} width={candleW} height={bodyH} fill={bullish ? "#22c55e" : "#ef4444"} stroke={color} rx="1.5" />
          </g>
        );
      })}
      <rect x={margin.left} y={margin.top} width={chartW} height={chartH} fill="none" stroke="#334155" />
    </svg>
  );
}

export default function ForexChartPractice() {
  const [pair, setPair] = useState("EURUSD");
  const [session, setSession] = useState("London");
  const [timeframe, setTimeframe] = useState("15m");
  const [seed, setSeed] = useState(12);
  const [visibleBars, setVisibleBars] = useState(62);
  const [playing, setPlaying] = useState(false);
  const [showLevels, setShowLevels] = useState(true);
  const [showAnswer, setShowAnswer] = useState(false);
  const [checklist, setChecklist] = useState(blankChecklist);
  const [dataMode, setDataMode] = useState("demo");
  const [liveData, setLiveData] = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState(null);

  const demoScenario = useMemo(() => makeScenario(pair, session, timeframe, seed), [pair, session, timeframe, seed]);

  // When in live mode, build a scenario whose .data is the real candles
  // but keep the answer/zones/levels framework around the live data.
  const scenario = useMemo(() => {
    if (dataMode !== "live" || !liveData || liveData.length === 0) return demoScenario;
    const precision = decimalsFor(pair);
    const high = Math.max(...liveData.map((d) => d.high));
    const low = Math.min(...liveData.map((d) => d.low));
    const mid = (high + low) / 2;
    const reindexed = liveData.map((d, i) => ({ ...d, index: i }));
    return {
      data: reindexed,
      answer: demoScenario.answer,
      levels: {
        high: Number(high.toFixed(precision)),
        low: Number(low.toFixed(precision)),
        mid: Number(mid.toFixed(precision)),
      },
      zones: demoScenario.zones,
    };
  }, [dataMode, liveData, demoScenario, pair]);

  const visibleData = scenario.data.slice(0, visibleBars);
  const filled = Object.values(checklist).filter(Boolean).length;
  const score = useMemo(() => scoreSetup({ checklist, scenario, session, timeframe }), [checklist, scenario, session, timeframe]);

  // Fetch live candles when mode is live (or when pair/timeframe changes while live)
  useEffect(() => {
    if (dataMode !== "live") return undefined;
    let cancelled = false;
    setLiveLoading(true);
    setLiveError(null);
    fetchYahooFinanceData(pair, timeframe).then((candles) => {
      if (cancelled) return;
      if (!candles) {
        setLiveError("Could not load live candles. Falling back to demo.");
        setLiveData(null);
      } else {
        setLiveData(candles);
        setVisibleBars(Math.min(62, candles.length));
      }
      setLiveLoading(false);
    });
    return () => { cancelled = true; };
  }, [dataMode, pair, timeframe]);

  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => {
      setVisibleBars((current) => {
        if (current >= scenario.data.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 220);
    return () => clearInterval(id);
  }, [playing, scenario.data.length]);

  const resetScenario = () => {
    setSeed((current) => current + 19);
    setVisibleBars(62);
    setPlaying(false);
    setShowAnswer(false);
    setChecklist(blankChecklist);
  };

  const updateChecklist = (field, value) => {
    setChecklist((current) => ({ ...current, [field]: value }));
  };

  const toggleDataMode = () => {
    setDataMode((current) => {
      const next = current === "demo" ? "live" : "demo";
      if (next === "demo") {
        setLiveData(null);
        setLiveError(null);
      }
      setVisibleBars(62);
      setPlaying(false);
      setShowAnswer(false);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-5xl font-bold tracking-tight">Forex Chart Analysis Practice</h1>
            <p className="text-slate-400 mt-2 max-w-2xl">
              Practice with real Yahoo Finance OHLC data or demo replay. Mark bias, liquidity, structure, POI, entry, invalidation, and target — then reveal the model breakdown and compare against the A+ score engine.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20 px-4 py-2 w-fit">
              {filled}/7 checklist complete
            </div>
            <div className={`rounded-full px-4 py-2 w-fit text-sm font-semibold ${gradeBadgeClasses(score.grade)}`}>
              {score.grade} ({score.total}/100)
            </div>
          </div>
        </div>

        <Card>
          <div className="mb-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-amber-100">
            <div className="font-semibold mb-1">Yahoo Finance Live Replay Mode</div>
            <div className="text-xs mt-1 opacity-80">
              Current mode: {dataMode === "demo" ? "Demo candles" : liveLoading ? "Loading live candles..." : liveError ? "Live mode (error — using demo)" : "Live Yahoo Finance feed"}
            </div>
            <div className="text-sm text-amber-200/90 mt-1">
              Click "Switch to Live Mode" to load real OHLC candles from /.netlify/functions/forex-data and replay them candle by candle.
            </div>
            {liveError ? (
              <div className="text-sm text-rose-300 mt-2">{liveError}</div>
            ) : null}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-5">
            <SelectBox value={pair} onChange={setPair} options={PAIRS} />
            <SelectBox value={session} onChange={setSession} options={SESSIONS} />
            <SelectBox value={timeframe} onChange={setTimeframe} options={TIMEFRAMES} />
            <Button onClick={() => setShowLevels((current) => !current)} variant="secondary">
              {showLevels ? "Hide Levels" : "Show Levels"}
            </Button>
            <Button onClick={resetScenario}>New Chart</Button>
            <Button onClick={toggleDataMode} variant="secondary">
              {dataMode === "demo" ? "Switch to Live Mode" : "Using Live Mode"}
            </Button>
          </div>

          <div className="h-[430px] w-full rounded-2xl bg-slate-950 p-3 border border-slate-800 overflow-hidden">
            <CandlestickChart
              data={visibleData}
              pair={pair}
              levels={scenario.levels}
              zones={scenario.zones}
              showLevels={showLevels}
              showAnswer={showAnswer}
            />
          </div>

          <div className="flex flex-wrap gap-3 mt-4">
            <Button onClick={() => setPlaying((current) => !current)} disabled={liveLoading}>
              {playing ? "Pause" : "Replay"}
            </Button>
            <Button onClick={() => setVisibleBars((current) => Math.min(current + 8, scenario.data.length))} variant="secondary">
              Print 8 bars
            </Button>
            <Button onClick={() => setVisibleBars(scenario.data.length)} variant="secondary">
              Show full chart
            </Button>
            <Button onClick={() => setShowAnswer((current) => !current)} variant="secondary">
              {showAnswer ? "Hide answer" : "Reveal answer"}
            </Button>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-semibold">Your Analysis Checklist</h2>
              <div className={`rounded-full px-3 py-1 text-sm font-semibold ${gradeBadgeClasses(score.grade)}`}>
                {score.grade} · {score.total}/100
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[
                ["bias", "Market bias"],
                ["trend", "Trend / structure"],
                ["liquidity", "Liquidity swept or targeted"],
                ["poi", "POI / zone"],
                ["entry", "Entry trigger"],
                ["invalidation", "Invalidation"],
                ["target", "Target"],
              ].map(([field, label]) => (
                <div key={field}>
                  <label className="text-sm text-slate-400">{label}</label>
                  <textarea
                    value={checklist[field]}
                    onChange={(e) => updateChecklist(field, e.target.value)}
                    placeholder="Type what you see..."
                    className="mt-1 w-full min-h-[76px] rounded-xl bg-slate-950 border border-slate-700 p-3 text-sm outline-none focus:border-indigo-400"
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              {[
                ["HTF bias", score.components.htfBias],
                ["Liquidity", score.components.liquidity],
                ["POI", score.components.poi],
                ["Displacement", score.components.displacement],
                ["Session", score.components.sessionTiming],
                ["Confirmation", score.components.entryConfirmation],
                ["RR", score.components.rrQuality],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5">
                  <div className="text-slate-500 uppercase tracking-wide text-[10px]">{label}</div>
                  <div className="text-slate-100 font-semibold">{value}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="text-2xl font-semibold">Model Breakdown</h2>
              <div className={`rounded-full px-3 py-1 text-sm ${showAnswer ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>
                {showAnswer ? "Answer visible" : "Hidden"}
              </div>
            </div>
            {!showAnswer ? (
              <div className="rounded-2xl bg-slate-950 border border-slate-800 p-6 text-slate-400">
                Complete your checklist first. Then reveal the answer and compare your read against the model breakdown.
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(scenario.answer).map(([key, value]) => (
                  <div key={key} className="rounded-xl bg-slate-950 border border-slate-800 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">{key}</div>
                    <div className="text-slate-100 mt-1">{value}</div>
                  </div>
                ))}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                  <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4">
                    Good habit: wait for confirmation after liquidity.
                  </div>
                  <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 p-4">
                    Avoid: entering directly into the sweep candle.
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
