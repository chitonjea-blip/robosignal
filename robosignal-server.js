// ─────────────────────────────────────────────────────────────
// RoboSignal Pro — Capital.com Auto-Trading Server
// Deploy free on Render.com or Railway.app
// Required env vars: CAPITAL_API_KEY, CAPITAL_EMAIL, CAPITAL_PASSWORD
// Optional:  CAPITAL_DEMO=false  (default: true — demo mode)
//            PORT (default: 3000)
//            SCORE_THRESHOLD (default: 3)
//            TRAILING_FACTOR (default: 1.0 — multiplier on ATR for trail distance)
// ─────────────────────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const app      = express();

app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const CFG = {
  apiKey    : process.env.CAPITAL_API_KEY    || 'IFqUldRDlv0jkDAY',
  email     : process.env.CAPITAL_EMAIL      || '',   // set in Render env vars
  password  : process.env.CAPITAL_PASSWORD   || '',   // set in Render env vars
  demo      : process.env.CAPITAL_DEMO !== 'false',   // true = demo account
  threshold : parseInt(process.env.SCORE_THRESHOLD)  || 3,
  trailFact : parseFloat(process.env.TRAILING_FACTOR) || 1.0,
  port      : parseInt(process.env.PORT) || 3000,
};

CFG.baseUrl = CFG.demo
  ? 'https://demo-api-capital.backend.capitalinterface.com'
  : 'https://api-capital.backend.capitalinterface.com';

console.log(`Mode: ${CFG.demo ? 'DEMO' : '*** LIVE ***'} | Threshold: ${CFG.threshold}/5 | Base: ${CFG.baseUrl}`);

// ── Session management ────────────────────────────────────────
let session = { cst: null, token: null, expiresAt: 0 };

async function authenticate() {
  if (session.cst && Date.now() < session.expiresAt) return;

  if (!CFG.email || !CFG.password) {
    throw new Error('CAPITAL_EMAIL and CAPITAL_PASSWORD env vars not set');
  }

  const res = await fetch(`${CFG.baseUrl}/api/v1/session`, {
    method  : 'POST',
    headers : { 'X-CAP-API-KEY': CFG.apiKey, 'Content-Type': 'application/json' },
    body    : JSON.stringify({ identifier: CFG.email, password: CFG.password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Auth failed ${res.status}: ${err.errorCode || res.statusText}`);
  }

  session.cst      = res.headers.get('CST');
  session.token    = res.headers.get('X-SECURITY-TOKEN');
  session.expiresAt = Date.now() + 9 * 60 * 1000; // refresh before 10-min expiry
  console.log(`[${ts()}] Session refreshed`);
}

async function api(method, path, body) {
  await authenticate();
  const res = await fetch(`${CFG.baseUrl}${path}`, {
    method,
    headers: {
      'X-CAP-API-KEY'   : CFG.apiKey,
      'CST'             : session.cst,
      'X-SECURITY-TOKEN': session.token,
      'Content-Type'    : 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errorCode || `Capital API ${res.status}`);
  return data;
}

// ── Symbol → Capital.com epic ─────────────────────────────────
// Search Capital.com's market catalogue for the correct epic
const epicCache = {};
async function getEpic(sym) {
  if (epicCache[sym]) return epicCache[sym];
  const data = await api('GET', `/api/v1/markets?searchTerm=${encodeURIComponent(sym)}&limit=5`);
  const markets = data.markets || [];
  // Prefer exact match on instrumentName or epic
  const match =
    markets.find(m => m.epic === sym) ||
    markets.find(m => m.instrumentName?.toUpperCase().includes(sym.toUpperCase())) ||
    markets[0];
  if (!match) throw new Error(`No market found for ${sym}`);
  epicCache[sym] = match.epic;
  console.log(`[${ts()}] Epic for ${sym} → ${match.epic} (${match.instrumentName})`);
  return match.epic;
}

// ── News blackout filter (Forex Factory calendar) ─────────────
async function isHighImpactNews() {
  try {
    const res   = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { signal: AbortSignal.timeout(3000) });
    const events = await res.json();
    const now    = Date.now();
    const window = 30 * 60 * 1000; // 30 min either side
    const hit    = events.find(e => e.impact === 'High' && Math.abs(new Date(e.date).getTime() - now) < window);
    if (hit) console.log(`[${ts()}] News blackout: ${hit.title} @ ${hit.date}`);
    return !!hit;
  } catch {
    return false; // if calendar unreachable, don't block
  }
}

// ── Open trade tracker ────────────────────────────────────────
// { [sym]: { dealId, dir, entry, sl, tp, size, atr, openedAt } }
const openTrades = {};

// ── POST /signal — called by dashboard when a signal fires ────
app.post('/signal', async (req, res) => {
  const { sym, dir, price, sl, tp, size, score, atr } = req.body;
  const log = (msg) => console.log(`[${ts()}] /signal ${sym}: ${msg}`);

  try {
    // Guards
    if (!sym || !dir || !price) return res.json({ ok: false, reason: 'Missing fields' });
    if ((score || 0) < CFG.threshold) return res.json({ ok: false, reason: `Score ${score} < threshold ${CFG.threshold}` });
    if (openTrades[sym])             return res.json({ ok: false, reason: `Already in ${sym} position` });

    // News blackout
    if (await isHighImpactNews()) return res.json({ ok: false, reason: 'High-impact news within 30 min — blocked' });

    const epic    = await getEpic(sym);
    const slDist  = Math.abs(parseFloat(price) - parseFloat(sl));
    // Express trailing stop distance in points (pips × 10 for most pairs)
    const trailPts = Math.round(slDist * 10000 * CFG.trailFact);

    const order = {
      epic,
      direction       : dir,          // 'BUY' or 'SELL'
      size            : parseFloat(size),
      guaranteedStop  : false,
      trailingStop    : true,
      trailingStopDistance : trailPts,
      stopLevel       : parseFloat(sl),
      profitLevel     : parseFloat(tp),
    };

    log(`Placing ${dir} size=${size} SL=${sl} TP=${tp} trail=${trailPts}pts`);
    const result = await api('POST', '/api/v1/positions', order);

    openTrades[sym] = {
      dealId   : result.dealReference,
      dir, entry: price, sl, tp, size,
      atr      : atr || 0,
      openedAt : new Date().toISOString(),
    };

    log(`✓ Opened — dealRef: ${result.dealReference}`);
    res.json({ ok: true, dealId: result.dealReference, message: `${dir} ${sym} @ ${price}` });

  } catch (e) {
    log(`✗ Error: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /close — manually close a position ───────────────────
app.post('/close', async (req, res) => {
  const { sym } = req.body;
  const trade   = openTrades[sym];
  if (!trade) return res.json({ ok: false, error: `No open trade for ${sym}` });

  try {
    await api('DELETE', `/api/v1/positions/${trade.dealId}`);
    const closed = { ...trade };
    delete openTrades[sym];
    console.log(`[${ts()}] Closed ${sym} dealId=${closed.dealId}`);
    res.json({ ok: true, message: `Closed ${sym}`, trade: closed });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /positions — current open positions ───────────────────
app.get('/positions', async (req, res) => {
  try {
    const data = await api('GET', '/api/v1/positions');
    res.json({ ok: true, broker: data.positions || [], local: openTrades });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /account — account summary ───────────────────────────
app.get('/account', async (req, res) => {
  try {
    const data = await api('GET', '/api/v1/accounts');
    res.json({ ok: true, accounts: data.accounts || [] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok        : true,
    mode      : CFG.demo ? 'DEMO' : 'LIVE',
    threshold : CFG.threshold,
    openTrades: Object.keys(openTrades),
    time      : new Date().toISOString(),
  });
});

// ── Trailing stop monitor (runs every 15 seconds) ─────────────
// Capital.com handles trailing stops natively, but this loop
// also checks if broker-side positions are still open and cleans
// up our local state if they were closed (SL/TP hit).
setInterval(async () => {
  if (!Object.keys(openTrades).length) return;
  try {
    const data      = await api('GET', '/api/v1/positions');
    const brokerIds = new Set((data.positions || []).map(p => p.position?.dealId));
    for (const [sym, trade] of Object.entries(openTrades)) {
      if (!brokerIds.has(trade.dealId)) {
        console.log(`[${ts()}] ${sym} position closed by broker (SL/TP hit)`);
        delete openTrades[sym];
      }
    }
  } catch { /* session may be refreshing — retry next tick */ }
}, 15_000);

// ── Helpers ───────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

app.listen(CFG.port, () =>
  console.log(`RoboSignal server listening on port ${CFG.port}`)
);
