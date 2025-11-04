// backend/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

/* ====== CONFIG ====== */
const PORT = parseInt(process.env.PORT || '5000', 10);
const SIGNAL_INTERVAL_MS = parseInt(process.env.SIGNAL_INTERVAL_MS || '5000', 10);
const MIN_CONF = parseInt(process.env.MIN_BROADCAST_CONF || '35', 10); // testing default lower
const BINARY_EXPIRY_SECONDS = parseInt(process.env.BINARY_EXPIRY_SECONDS || '60', 10);
const AUTO_BROADCAST_ON_START = (process.env.AUTO_BROADCAST_ON_START === 'true');
const AUTO_CLIENT_AUTOSTART = (process.env.AUTO_CLIENT_AUTOSTART === 'true');
const WATCH = (process.env.WATCH_SYMBOLS || 'EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD,USD/CHF,NZD/USD,BTC (OTC),Gold (OTC)').split(',').map(s=>s.trim()).filter(Boolean);
const OWNER = process.env.OWNER_NAME || 'David Mamun William';

/* ====== In-memory DB & bars ====== */
const bars = {};        // bars[symbol] = [{time,open,high,low,close,volume}]
const signals = [];     // stored signals

global.barsGlobal = bars;

/* ====== Helpers: OHLC append tick ====== */
function appendTick(sym, price, qty, tsSec){
  if(!sym) return;
  sym = String(sym).toUpperCase();
  bars[sym] = bars[sym] || [];
  const arr = bars[sym];
  const last = arr[arr.length-1];
  if(!last || last.time !== tsSec){
    arr.push({ time: tsSec, open: price, high: price, low: price, close: price, volume: qty || 0 });
    if(arr.length > 10000) arr.shift();
  } else {
    last.close = price;
    if(price > last.high) last.high = price;
    if(price < last.low) last.low = price;
    last.volume = (last.volume || 0) + (qty || 0);
  }
  global.barsGlobal = bars;
}

/* ====== Simulate ticks for testing (used if no real broker) ====== */
function simulateTick(sym){
  const ts = Math.floor(Date.now()/1000);
  const isCrypto = /BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE/i.test(sym);
  const base = isCrypto ? (30000 + (Math.random()-0.5)*2000) : (sym.startsWith('EUR') ? 1.09 : 1.0);
  const volatility = isCrypto ? 20 : 0.002;
  const price = +(base + (Math.random()-0.5)*volatility).toFixed(isCrypto ? 2 : 5);
  const qty = Math.random() * (isCrypto ? 3 : 100);
  appendTick(sym, price, qty, ts);
}

/* ====== Warmup: create initial bars so strategy has history ====== */
function warmupPairs(countPerPair = 600){
  const nowSec = Math.floor(Date.now()/1000);
  for(const s of WATCH){
    bars[s] = bars[s] || [];
    for(let i = countPerPair; i >= 1; i--){
      const ts = nowSec - i;
      const isCrypto = /BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE/i.test(s);
      const base = isCrypto ? (30000 + (Math.random()-0.5)*2000) : (s.startsWith('EUR') ? 1.09 : 1.0);
      const volatility = isCrypto ? 20 : 0.002;
      const price = +(base + (Math.random()-0.5) * volatility).toFixed(isCrypto ? 2 : 5);
      appendTick(s, price, Math.random() * (isCrypto ? 3 : 100), ts);
    }
  }
  console.log('Warmup completed for', WATCH.length, 'pairs');
}
warmupPairs(600);

/* ====== Strategy (compact, robust) ====== */
function sma(arr, period){ if(!arr || arr.length < period) return null; const a = arr.slice(-period); return a.reduce((s,v)=>s+v,0)/period; }
function rsi(closes, period = 14){
  if(!closes || closes.length < period+1) return 50;
  let gains=0, losses=0;
  for(let i=closes.length-period;i<closes.length;i++){ const d = closes[i]-closes[i-1]; if(d>0) gains+=d; else losses += Math.abs(d); }
  const avgG = gains/period, avgL = (losses/period)||1e-8, rs = avgG/avgL; return 100 - (100/(1+rs));
}
function aggregate(barsArr, secondsPerBar){
  if(!barsArr || barsArr.length === 0) return [];
  const out = []; let bucket = null;
  for(const b of barsArr){
    const t = Math.floor(b.time/secondsPerBar)*secondsPerBar;
    if(!bucket || bucket.time !== t){ bucket = { time:t, open:b.open, high:b.high, low:b.low, close:b.close, volume:b.volume||0 }; out.push(bucket); }
    else { bucket.high = Math.max(bucket.high, b.high); bucket.low = Math.min(bucket.low, b.low); bucket.close = b.close; bucket.volume += b.volume||0; }
  }
  return out;
}
function classifyCandleSize(bar, avgBody){
  if(!bar) return 'Normal';
  const body = Math.abs(bar.close - bar.open);
  if(avgBody <= 0) return 'Normal';
  const ratio = body / avgBody;
  if(ratio <= 0.4) return 'Micro';
  if(ratio > 0.4 && ratio <= 1.6) return 'Normal';
  if(ratio > 1.6 && ratio <= 3.5) return 'Impulse';
  if(ratio > 3.5) return 'Exhaustion';
  return 'Normal';
}
function detectOB(m1){
  if(!m1 || m1.length < 4) return false;
  const prev = m1[m1.length-2], last = m1[m1.length-1];
  const prevBody = Math.abs(prev.close - prev.open);
  const avgBody = Math.max(1e-6, m1.slice(-10).reduce((s,b)=>s+Math.abs(b.close-b.open),0)/Math.min(10,m1.length));
  if(prevBody > avgBody * 1.4 && ((last.close > last.open && prev.close < prev.open) || (last.close < last.open && prev.close > prev.open))) return true;
  return false;
}
function computeSignalForSymbol(symbol, barsRef){
  const barsArr = barsRef[symbol] || [];
  if(!barsArr || barsArr.length < 80) return null;
  const sample = barsArr.slice(-300);
  const closes = sample.map(b=>b.close);
  const sma5 = sma(closes, Math.min(5, closes.length));
  const sma20 = sma(closes, Math.min(20, closes.length));
  const r = rsi(closes, 14);
  const volArr = sample.map(b=>b.volume||0);
  const avgVol = volArr.slice(0, Math.max(1,volArr.length-1)).reduce((a,b)=>a+b,0)/Math.max(1,volArr.length-1);
  const lastVol = volArr[volArr.length-1] || 0;
  const volSpike = lastVol > avgVol * 2.2;
  const m1 = aggregate(barsArr, 60);
  if(m1.length < 20) return null;
  const last = sample[sample.length-1], prev = sample[sample.length-2];
  const priceDelta = last.close - prev.close;
  const ob = detectOB(m1);
  const bullishMomentum = priceDelta > 0 && sma5 > sma20;
  const bearishMomentum = priceDelta < 0 && sma5 < sma20;
  let score = 50;
  if(bullishMomentum) score += 10;
  if(bearishMomentum) score -= 10;
  if(r < 35) score += 7;
  if(r > 65) score -= 7;
  if(volSpike) score += 6;
  if(ob) score += 6;
  const bodies = sample.slice(-30).map(b => Math.abs(b.close - b.open));
  const avgBody = Math.max(1e-8, bodies.reduce((a,b)=>a+b,0)/Math.max(1,bodies.length));
  const candleSize = classifyCandleSize(last, avgBody);
  let layers = 0;
  if(bullishMomentum || bearishMomentum) layers++;
  if(ob) layers++;
  if(volSpike) layers++;
  if(r < 40 || r > 60) layers++;
  // conservative: require at least 1-2 layers for stronger signals
  if(layers < 1) return null;
  score = Math.max(10, Math.min(99, Math.round(score)));
  const direction = score >= 60 ? 'CALL' : (score <= 40 ? 'PUT' : (bullishMomentum ? 'CALL' : 'PUT'));
  return {
    market: 'binary',
    symbol,
    direction,
    confidence: score,
    entry: last.close,
    entry_ts: Math.floor(Date.now()/1000),
    entry_time_iso: new Date().toISOString(),
    expiry_at: new Date(Date.now() + BINARY_EXPIRY_SECONDS*1000).toISOString(),
    notes: `rsi:${Math.round(r)}|volSpike:${volSpike}|ob:${ob}`,
    time: new Date().toISOString(),
    candleSize
  };
}

/* ====== Broadcast helper ====== */
function broadcast(obj){
  const raw = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if(c.readyState === WebSocket.OPEN) c.send(raw);
  });
}

/* ====== Scanner loop ====== */
setInterval(()=>{
  try{
    const candidates = [];
    for(const s of WATCH){
      try{
        if(!bars[s] || bars[s].length < 120){ simulateTick(s); continue; }
        const sig = computeSignalForSymbol(s, bars);
        if(!sig) continue;
        // quick score adjust (no sentiment engine here for simplicity)
        const score = sig.confidence;
        candidates.push({ symbol: s, sig, score });
      }catch(e){}
    }
    if(candidates.length === 0) return;
    candidates.sort((a,b)=>b.score - a.score);
    const top = candidates[0];
    if(!top) return;
    if(top.sig.confidence >= MIN_CONF){
      const rec = {
        id: signals.length + 1,
        symbol: top.symbol,
        market: 'binary',
        direction: top.sig.direction,
        confidence: top.sig.confidence,
        entry: top.sig.entry,
        entry_ts: top.sig.entry_ts,
        entry_time_iso: top.sig.entry_time_iso,
        expiry_ts: Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS,
        notes: top.sig.notes,
        time: new Date().toISOString(),
        result: null,
        candleSize: top.sig.candleSize
      };
      signals.push(rec);
      broadcast({ type:'signal', data: rec });
      broadcast({ type:'log', data: `Signal ${rec.symbol} ${rec.direction} conf:${rec.confidence}% id:${rec.id}` });
    } else {
      // no candidate high enough — optional debug log
      // console.log('No top candidate above MIN_CONF', top.symbol, top.sig.confidence);
    }
  }catch(e){ console.warn('scanner error', e && e.message); }
}, SIGNAL_INTERVAL_MS);

/* ====== Auto-broadcast at startup (one-shot) ====== */
function findBestCandidateOnce(){
  try{
    const list = [];
    for(const s of WATCH){
      if(!bars[s] || bars[s].length < 120) continue;
      const sig = computeSignalForSymbol(s, bars);
      if(sig) list.push({ symbol: s, conf: sig.confidence, sig });
    }
    if(!list.length) { console.log('AutoBroadcast: no candidate at startup'); return; }
    list.sort((a,b)=>b.conf - a.conf);
    const top = list[0];
    if(AUTO_BROADCAST_ON_START && top.conf >= Math.max(10, MIN_CONF - 10)){
      const rec = {
        id: signals.length + 1,
        symbol: top.symbol,
        market:'binary',
        direction: top.sig.direction,
        confidence: top.sig.confidence,
        entry: top.sig.entry,
        entry_ts: top.sig.entry_ts,
        entry_time_iso: top.sig.entry_time_iso,
        expiry_ts: Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS,
        notes: top.sig.notes,
        time: new Date().toISOString(),
        result: null,
        candleSize: top.sig.candleSize
      };
      signals.push(rec);
      broadcast({ type:'signal', data: rec });
      console.log('AutoBroadcast fired:', rec.symbol, rec.confidence);
    } else {
      console.log('AutoBroadcast: nothing passed threshold or disabled');
    }
  }catch(e){ console.warn('findBestCandidateOnce err', e && e.message); }
}
setTimeout(findBestCandidateOnce, 2000);

/* ====== WebSocket interface ====== */
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'hello', server_time: new Date().toISOString(), pairs: WATCH, owner: OWNER, autoClientAutostart: AUTO_CLIENT_AUTOSTART }));
  ws.on('message', msg => {
    try{
      const m = JSON.parse(msg.toString());
      if(m.type === 'start' || m.type === 'next'){
        const mode = (m.mode || 'normal').toString().toLowerCase();
        let symbol = (m.symbol || '').toString().trim();
        // if no symbol and auto-pick allowed, choose highest confidence from current scan
        if(!symbol){
          const quick = [];
          for(const s of WATCH){
            if(!bars[s] || bars[s].length < 120) continue;
            const sc = computeSignalForSymbol(s, bars);
            if(sc) quick.push({ s, conf: sc.confidence, sc });
          }
          quick.sort((a,b)=>b.conf - a.conf);
          if(quick.length && quick[0].conf >= Math.max(10, MIN_CONF - 10)) symbol = quick[0].s;
        }
        if(!symbol){ ws.send(JSON.stringify({ type:'hold', data: { reason: 'No suitable pair found' } })); return; }
        let sig = computeSignalForSymbol(symbol, bars);
        if(!sig) { ws.send(JSON.stringify({ type:'hold', data: { symbol, reason: 'No confirmed opportunity now — hold' } })); return; }
        // apply mode simple tweak: god mode demands confidence bump
        let conf = sig.confidence;
        if(mode === 'god') conf = Math.min(99, conf + 6);
        if(conf < MIN_CONF){ ws.send(JSON.stringify({ type:'hold', data: { symbol, reason: 'Confidence too low: ' + conf } })); return; }
        const rec = {
          id: signals.length + 1,
          symbol,
          market: 'binary',
          direction: sig.direction,
          confidence: conf,
          entry: sig.entry,
          entry_ts: sig.entry_ts,
          entry_time_iso: sig.entry_time_iso,
          expiry_ts: Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS,
          notes: sig.notes,
          time: new Date().toISOString(),
          result: null,
          candleSize: sig.candleSize
        };
        signals.push(rec);
        ws.send(JSON.stringify({ type:'signal', data: rec }));
      } else if(m.type === 'reqDebug'){
        ws.send(JSON.stringify({ type:'debug', data: { pairs: WATCH.length, barsCounts: Object.fromEntries(WATCH.map(s=>[s, (bars[s]||[]).length])) } }));
      }
    }catch(e){}
  });
});

/* ====== Debug endpoints ====== */
app.get('/debug/status', (req,res) => {
  try{
    const info = WATCH.map(sym => ({ symbol: sym, barsCount: (bars[sym]||[]).length, last: (bars[sym]||[]).slice(-1)[0] || null }));
    res.json({ ok:true, server_time: new Date().toISOString(), info });
  }catch(e){ res.json({ ok:false, err: e.message }); }
});
app.get('/debug/force/:sym', (req,res) => {
  const sym = req.params.sym;
  try{
    const fake = computeSignalForSymbol(sym, bars) || {};
    const forced = {
      id: signals.length + 1,
      symbol: sym,
      confidence: fake.confidence || 60,
      entry: fake.entry || ((bars[sym] && bars[sym].length) ? bars[sym].slice(-1)[0].close : null),
      entry_ts: Math.floor(Date.now()/1000),
      entry_time_iso: new Date().toISOString(),
      expiry_ts: Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS
    };
    signals.push(forced);
    broadcast({ type:'signal', data: forced });
    res.json({ ok:true, forced });
  }catch(e){ res.json({ ok:false, err: e.message }); }
});
app.get('/signals/history', (req,res) => res.json({ ok:true, rows: signals.slice(-200) }));

/* ====== Start server ====== */
server.listen(PORT, ()=> {
  console.log(`Binary Sniper server listening on port ${PORT} — owner: ${OWNER}`);
  console.log('WATCH list:', WATCH);
});
