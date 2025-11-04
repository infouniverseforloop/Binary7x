// public/script.js
const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
const pairSelect = document.getElementById('pairSelect');
const modeSelect = document.getElementById('modeSelect');
const startBtn = document.getElementById('startBtn');
const nextBtn = document.getElementById('nextBtn');
const autoBtn = document.getElementById('autoBtn');
const ttsBtn = document.getElementById('ttsBtn');
const signalTitle = document.getElementById('signalTitle');
const signalBody = document.getElementById('signalBody');
const signalMeta = document.getElementById('signalMeta');
const countdownEl = document.getElementById('countdown');
const logBox = document.getElementById('logBox');
const stat_conf = document.getElementById('stat_conf');
const stat_mode = document.getElementById('stat_mode');
const stat_mtg = document.getElementById('stat_mtg');

let currentPair = null;
let countdownTimer = null;
let ttsReady = false;

function pushLog(t){ const d=new Date().toLocaleTimeString(); logBox.innerHTML = `<div>[${d}] ${t}</div>` + logBox.innerHTML; }

// TTS helpers
function initTTSOnUserGesture(){
  try{
    const u = new SpeechSynthesisUtterance('Audio enabled');
    u.volume = 0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    ttsReady = true;
  } catch(e){ ttsReady = false; console.warn('TTS init failed', e); }
}
function safeSpeak(text){
  try {
    if(!('speechSynthesis' in window)) return;
    if(!ttsReady) initTTSOnUserGesture();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1; u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch(e){ console.warn('TTS speak err', e); }
}

// populate list
function populatePairs(pairs){
  pairSelect.innerHTML = '';
  pairs.forEach(p => {
    const o = document.createElement('option'); o.value = p; o.textContent = p; pairSelect.appendChild(o);
  });
  if(pairSelect.options.length) { currentPair = pairSelect.value; }
}
pairSelect.onchange = () => currentPair = pairSelect.value;

// ws
ws.onopen = () => {
  pushLog('WS connected to backend');
  // auto-start if server requested (server sends hello with flags)
};
ws.onmessage = (evt) => {
  try {
    const msg = JSON.parse(evt.data);
    if(msg.type === 'hello'){
      document.getElementById('serverTime').innerText = `Server: ${msg.server_time || '-'}`;
      if(Array.isArray(msg.pairs)) populatePairs(msg.pairs);
      // auto client start if wanted
      if(msg.autoClientAutostart){
        try { ws.send(JSON.stringify({ type:'start', mode: modeSelect.value })); pushLog('Auto-start requested'); } catch(e){}
      }
    } else if(msg.type === 'signal'){
      showSignal(msg.data);
    } else if(msg.type === 'hold'){
      pushLog(`[HOLD] ${msg.data.symbol||''} -> ${msg.data.reason || msg.data}`);
    } else if(msg.type === 'log'){
      pushLog(msg.data);
    } else if(msg.type === 'debug'){
      pushLog('DEBUG: ' + JSON.stringify(msg.data));
    } else if(msg.type === 'signal_result'){
      pushLog(`Result ${msg.data.symbol} => ${msg.data.result} final:${msg.data.finalPrice}`);
    }
  } catch(e){ console.warn('ws message parse err', e); }
};

function showSignal(rec){
  clearInterval(countdownTimer);
  signalTitle.innerText = `${rec.symbol} — ${rec.direction} (conf ${rec.confidence}%)`;
  signalMeta.innerText = `Entry: ${rec.entry} • Entry(UTC): ${rec.entry_time_iso || '-'} • CandleSize: ${rec.candleSize || '-'}`;
  signalBody.innerHTML = `<div style="margin-top:8px">Notes: ${rec.notes || '-'}</div>`;
  stat_conf.innerText = `Confidence: ${rec.confidence}%`;
  stat_mode.innerText = `Mode: ${modeSelect.value.toUpperCase()}`;
  stat_mtg.innerText = `MTG: ${rec.mtg ? (rec.mtg.decision||'-') : '-'}`;
  let nowTs = Math.floor(Date.now()/1000);
  let secs = Math.max(0, (rec.expiry_ts || Math.floor(new Date(rec.expiry_at||rec.expiry).getTime()/1000)) - nowTs);
  countdownEl.textContent = `Countdown: ${secs}s`;
  countdownTimer = setInterval(()=> {
    secs--;
    if(secs <= 0){ clearInterval(countdownTimer); countdownEl.textContent = 'Signal closed — awaiting result'; }
    else countdownEl.textContent = `Countdown: ${secs}s`;
  }, 1000);
  pushLog(`Signal: ${rec.symbol} ${rec.direction} conf:${rec.confidence}% entry:${rec.entry}`);
  safeSpeak(`Signal ${rec.symbol} ${rec.direction} confidence ${rec.confidence} percent`);
}

// UI actions
startBtn.onclick = () => {
  initTTSOnUserGesture();
  const mode = (modeSelect && modeSelect.value) || 'normal';
  if(!currentPair) { ws.send(JSON.stringify({ type:'start', mode })); pushLog('Requested start (auto-pick)'); return; }
  ws.send(JSON.stringify({ type:'start', symbol: currentPair, mode }));
  pushLog('Requested start for ' + currentPair + ' mode:' + mode);
};
nextBtn.onclick = () => {
  initTTSOnUserGesture();
  const mode = (modeSelect && modeSelect.value) || 'normal';
  if(!currentPair) { ws.send(JSON.stringify({ type:'next', mode })); pushLog('Requested next (auto-pick)'); return; }
  ws.send(JSON.stringify({ type:'next', symbol: currentPair, mode }));
  pushLog('Requested next for ' + currentPair + ' mode:' + mode);
};
autoBtn.onclick = () => { ws.send(JSON.stringify({ type:'start', mode: modeSelect.value })); pushLog('Requested Auto-Pick Best'); };
ttsBtn.onclick = () => { initTTSOnUserGesture(); safeSpeak('T T S test. Binary sniper ready.'); };

// debug helper (open console to run)
// example: ws.send(JSON.stringify({ type:'reqDebug' }));
