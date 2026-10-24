/* QL1 録音シミュレーター */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ---------------- constants ---------------- */
  const GAIN_MIN = -30, GAIN_MAX = 30;
  const START_PEAK_DB = -30;          // 冒頭のピーク（GAIN 0dB時）
  const MAX_PEAK_DB = -8;             // 曲全体の最大ピークの上限（GAIN 0dB時）
  const RATES = [96, 128, 192];
  const TARGET_LO = -10, TARGET_HI = -6;

  const CATS = [
    { id: 'input', label: 'INPUT CH', items: Array.from({ length: 32 }, (_, i) => ({ id: 'IN' + (i + 1), top: 'INPUT', main: String(i + 1), name: 'INPUT ' + (i + 1) })) },
    { id: 'stin', label: 'ST IN', items: Array.from({ length: 16 }, (_, i) => { const n = Math.floor(i / 2) + 1, s = i % 2 ? 'R' : 'L'; return { id: 'STIN' + n + s, top: 'ST IN', main: n + s, name: 'STIN' + n + s }; }) },
    { id: 'mix', label: 'MIX', items: Array.from({ length: 16 }, (_, i) => ({ id: 'MIX' + (i + 1), top: 'MIX', main: String(i + 1), name: 'MIX ' + (i + 1) })) },
    { id: 'mtrx', label: 'MATRIX', items: Array.from({ length: 8 }, (_, i) => ({ id: 'MTRX' + (i + 1), top: 'MATRIX', main: String(i + 1), name: 'MTRX ' + (i + 1) })) },
    { id: 'st', label: 'STEREO / MONO', items: [{ id: 'STL', top: 'STEREO', main: 'L', name: 'ST L' }, { id: 'STR', top: 'STEREO', main: 'R', name: 'ST R' }, { id: 'MONO', top: 'MONO', main: 'C', name: 'MONO' }] },
  ];
  const CH_BY_ID = {}; CATS.forEach(c => c.items.forEach(it => { CH_BY_ID[it.id] = { ...it, cat: c.id }; }));
  CH_BY_ID.NONE = { id: 'NONE', name: '----', cat: 'input' };

  // 講堂の吊りマイク：INPUT 11 = L, INPUT 12 = R
  const signalOf = (id) => id === 'IN11' ? 0 : id === 'IN12' ? 1 : -1;

  /* ---------------- state ---------------- */
  const S = {
    ctx: null, buffer: null, srcName: '',
    nodes: {}, srcNode: null, srcStartAt: 0,
    assign: { L: 'STL', R: 'STR' },
    gainDb: 0, rate: 128, cue: false, touched: false,
    tstate: 'stop',                    // stop | standby | rec | recpause | play | playpause
    rec: { chunksL: [], chunksR: [], samples: 0, maxPeak: -Infinity, overs: 0, gainMin: Infinity, gainMax: -Infinity, startedOk: null },
    files: [], selFile: -1, pbNode: null, pbStartAt: 0, pbOffset: 0,
    meter: { L: { disp: -120, hold: -120, holdT: 0 }, R: { disp: -120, hold: -120, holdT: 0 }, overUntil: 0, lastOverT: 0, hist: [] },
    overCount: 0,
    steps: { rate: false, L: false, R: false, gain: false, standby: false, record: false, stop: false },
    gainOkTime: 0,
    freeBytes: 28.62 * 1024 ** 3,
  };

  /* ---------------- utils ---------------- */
  const db2lin = (d) => Math.pow(10, d / 20);
  const lin2db = (v) => v > 0 ? 20 * Math.log10(v) : -Infinity;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmtDb = (d) => !isFinite(d) || d < -90 ? '−∞' : (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1);
  const fmtTime = (sec) => { sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60; return [h, m, s].map(n => String(n).padStart(2, '0')).join(':'); };

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function ensureCtx() {
    if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return S.ctx;
  }

  /* ================= SETUP SCREEN ================= */
  const status = $('#src-status');
  function setStatus(msg, kind) { status.textContent = msg; status.className = 'src-status' + (kind ? ' is-' + kind : ''); }

  $$('.src-tab').forEach(b => b.addEventListener('click', () => {
    $$('.src-tab').forEach(x => { x.classList.toggle('is-active', x === b); x.setAttribute('aria-selected', x === b); });
    $$('.src-panel').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.src; });
  }));

  async function acceptArrayBuffer(ab, name) {
    const ctx = ensureCtx();
    let buf;
    try { buf = await ctx.decodeAudioData(ab.slice(0)); }
    catch (e) { throw new Error('音声として読み込めませんでした（形式が未対応か、音声ファイルではありません）'); }
    S.buffer = toStereo(ctx, buf); S.srcName = name;
    setStatus(`準備完了：${name}（${fmtTime(buf.duration).replace(/^00:/, '')}）`, 'ok');
    $('#start-btn').disabled = false;
  }

  function toStereo(ctx, buf) {
    if (buf.numberOfChannels >= 2) return buf;
    const out = ctx.createBuffer(2, buf.length, buf.sampleRate);
    out.copyToChannel(buf.getChannelData(0), 0); out.copyToChannel(buf.getChannelData(0), 1);
    return out;
  }

  async function loadFile(file) {
    if (!file) return;
    $('#file-name').textContent = file.name;
    setStatus('読み込み中…');
    try { await acceptArrayBuffer(await file.arrayBuffer(), file.name); }
    catch (e) { setStatus(e.message, 'err'); }
  }
  $('#file-input').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const drop = $('#file-drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  function urlCandidates(raw) {
    let u; try { u = new URL(raw.trim()); } catch { return null; }
    const host = u.hostname;
    if (/drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com/.test(host)) {
      const m = u.pathname.match(/\/d\/([^/]+)/); const id = (m && m[1]) || u.searchParams.get('id');
      if (id) return [
        `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
        `https://drive.google.com/uc?export=download&id=${id}`,
      ];
    }
    if (/dropbox\.com$/.test(host)) { u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); return [u.toString().replace('www.dropbox.com', 'dl.dropboxusercontent.com'), u.toString()]; }
    return [u.toString()];
  }

  $('#url-load').addEventListener('click', async () => {
    const raw = $('#url-input').value;
    const cands = urlCandidates(raw);
    if (!cands) { setStatus('URLの形式が正しくありません', 'err'); return; }
    setStatus('URLから読み込み中…');
    let lastErr = '';
    for (const c of cands) {
      try {
        const res = await fetch(c, { mode: 'cors', redirect: 'follow' });
        if (!res.ok) { lastErr = `サーバーがエラーを返しました（${res.status}）`; continue; }
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('text/html')) { lastErr = 'ファイルではなくWebページが返されました（共有設定やファイルサイズを確認してください）'; continue; }
        const ab = await res.arrayBuffer();
        let name = decodeURIComponent((new URL(raw).pathname.split('/').pop() || 'URL音源'));
        const cd = res.headers.get('content-disposition'); const mm = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
        if (mm) name = decodeURIComponent(mm[1]);
        if (/^(view|edit|download|uc)$/i.test(name)) name = 'Googleドライブの音源';
        await acceptArrayBuffer(ab, name); return;
      } catch (e) {
        lastErr = e.message && e.message.startsWith('音声') ? e.message : 'このURLはブラウザから直接読み込めませんでした（配信元の制限）';
      }
    }
    setStatus(lastErr + '。ファイルをダウンロードして「PCのファイル」から選んでください。', 'err');
  });

  $('#demo-load').addEventListener('click', async () => {
    setStatus('デモ音源を生成中…（数秒かかります）');
    try {
      const buf = await renderDemo();
      S.buffer = buf; S.srcName = 'デモ音源（合成）';
      setStatus('準備完了：デモ音源（約70秒）', 'ok');
      $('#start-btn').disabled = false;
    } catch (e) { setStatus('生成に失敗しました：' + e.message, 'err'); }
  });

  /* ---------- demo synth (offline render) ---------- */
  async function renderDemo() {
    ensureCtx();
    const sr = 44100, dur = 70;
    const oc = new OfflineAudioContext(2, sr * dur, sr);
    const master = oc.createGain(); master.connect(oc.destination);
    // dynamics: soft → medium → climax → fade
    const g = master.gain;
    g.setValueAtTime(db2lin(-10), 0);
    g.linearRampToValueAtTime(db2lin(-10), 18);
    g.linearRampToValueAtTime(db2lin(-5), 34);
    g.linearRampToValueAtTime(db2lin(0), 50);
    g.setValueAtTime(db2lin(0), 58);
    g.linearRampToValueAtTime(db2lin(-14), 68);
    g.linearRampToValueAtTime(0.0001, 70);

    const rev = oc.createConvolver(); rev.buffer = makeIR(oc, 2.4); const revG = oc.createGain(); revG.gain.value = 0.35;
    rev.connect(revG).connect(master);
    const dry = oc.createGain(); dry.gain.value = 0.8; dry.connect(master);
    const bus = oc.createGain(); bus.connect(dry); bus.connect(rev);

    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    // progression (Dm - Bb - F - C - Gm - A ...)
    const prog = [[50, 57, 62, 65, 69], [46, 58, 62, 65, 70], [41, 57, 60, 65, 69], [48, 55, 60, 64, 67], [43, 58, 62, 67, 70], [45, 57, 61, 64, 69], [50, 57, 62, 65, 69], [45, 57, 61, 64, 67]];
    const beat = 0.6, barLen = beat * 4;
    const panL = (x) => { const p = oc.createStereoPanner(); p.pan.value = x; p.connect(bus); return p; };
    const pianoOut = panL(-0.25), strOut = panL(0.3), bassOut = panL(0.05), timpOut = panL(0);

    function piano(t, m, vel) {
      const o1 = oc.createOscillator(), o2 = oc.createOscillator(), e = oc.createGain(), f = oc.createBiquadFilter();
      o1.type = 'triangle'; o2.type = 'sine'; o1.frequency.value = mtof(m); o2.frequency.value = mtof(m) * 2.003;
      f.type = 'lowpass'; f.frequency.value = 1800 + vel * 3000;
      e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.16 * vel, t + 0.006); e.gain.exponentialRampToValueAtTime(0.0008, t + 2.6);
      o1.connect(f); o2.connect(f); f.connect(e).connect(pianoOut);
      o1.start(t); o2.start(t); o1.stop(t + 2.7); o2.stop(t + 2.7);
    }
    function strings(t, len, notes, vel) {
      notes.forEach((m, k) => [-6, 6].forEach(det => {
        const o = oc.createOscillator(), e = oc.createGain(), f = oc.createBiquadFilter();
        o.type = 'sawtooth'; o.frequency.value = mtof(m + 12); o.detune.value = det + k;
        f.type = 'lowpass'; f.frequency.value = 900 + vel * 1600;
        e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.018 * vel, t + 0.5); e.gain.setValueAtTime(0.018 * vel, t + len - 0.3); e.gain.linearRampToValueAtTime(0, t + len + 0.3);
        o.connect(f).connect(e).connect(strOut); o.start(t); o.stop(t + len + 0.35);
      }));
    }
    function bass(t, m, vel) {
      const o = oc.createOscillator(), e = oc.createGain();
      o.type = 'sine'; o.frequency.value = mtof(m - 12);
      e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.25 * vel, t + 0.02); e.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
      o.connect(e).connect(bassOut); o.start(t); o.stop(t + 1.9);
    }
    function timp(t, vel) {
      const o = oc.createOscillator(), e = oc.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.4);
      e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.5 * vel, t + 0.005); e.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      o.connect(e).connect(timpOut); o.start(t); o.stop(t + 1.3);
    }

    let bar = 0;
    for (let t = 0.3; t < dur - 3; t += barLen, bar++) {
      const ch = prog[bar % prog.length];
      const sec = t < 18 ? 0 : t < 34 ? 1 : t < 58 ? 2 : 3;
      const vel = [0.55, 0.75, 1, 0.6][sec];
      bass(t, ch[0], vel);
      // arpeggio
      const pat = sec === 0 ? [1, 2, 3, 4, 3, 2, 1, 2] : [1, 3, 4, 2, 3, 4, 2, 3];
      pat.forEach((ix, k) => piano(t + k * beat / 2, ch[ix] + (sec >= 2 && k % 4 === 0 ? 12 : 0), vel * (k % 2 ? 0.8 : 1)));
      if (sec >= 1) strings(t, barLen, ch.slice(1, 4), vel);
      if (sec === 2) { timp(t, vel); if (bar % 2) timp(t + beat * 2, vel * 0.8); [0, 2].forEach(k => ch.slice(1).forEach(m => piano(t + k * beat, m + 12, 0.7))); }
    }
    const rendered = await oc.startRendering();
    return rendered;
  }
  function makeIR(oc, secs) {
    const len = Math.floor(oc.sampleRate * secs), b = oc.createBuffer(2, len, oc.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    return b;
  }

  /* ================= AUDIO ENGINE ================= */
  const WORKLET = `
  class RecTap extends AudioWorkletProcessor {
    constructor(){ super(); this.size=4096; this.l=new Float32Array(this.size); this.r=new Float32Array(this.size); this.n=0; this.on=false;
      this.port.onmessage=(e)=>{ if(e.data==='flush'){ this.flush(); } else { this.on=e.data; } }; }
    flush(){ if(this.n>0){ this.port.postMessage([this.l.slice(0,this.n), this.r.slice(0,this.n)]); this.n=0; } }
    process(inputs){ const inp=inputs[0]; if(!this.on||!inp||!inp.length) return true;
      const L=inp[0], R=inp[1]||inp[0];
      for(let i=0;i<L.length;i++){ this.l[this.n]=L[i]; this.r[this.n]=R[i]; this.n++; if(this.n===this.size){ this.port.postMessage([this.l.slice(0), this.r.slice(0)]); this.n=0; } }
      return true; }
  }
  registerProcessor('rec-tap', RecTap);`;

  async function buildGraph() {
    const ctx = ensureCtx(), N = S.nodes;
    if (N.built) return;
    N.calib = ctx.createGain();
    N.split = ctx.createChannelSplitter(2);
    N.calib.connect(N.split);
    N.merge = ctx.createChannelMerger(2);
    // routing matrix: recorder L/R ← source ch0/ch1
    N.mx = {};
    ['L', 'R'].forEach((side, outIx) => [0, 1].forEach(srcIx => {
      const g = ctx.createGain(); g.gain.value = 0;
      N.split.connect(g, srcIx); g.connect(N.merge, 0, outIx);
      N.mx[side + srcIx] = g;
    }));
    N.recGain = ctx.createGain();
    N.merge.connect(N.recGain);
    // meters (pre-clip so OVER can be detected)
    N.mSplit = ctx.createChannelSplitter(2);
    N.recGain.connect(N.mSplit);
    N.anL = ctx.createAnalyser(); N.anR = ctx.createAnalyser();
    N.anL.fftSize = N.anR.fftSize = 2048;
    N.mSplit.connect(N.anL, 0); N.mSplit.connect(N.anR, 1);
    N.bufL = new Float32Array(2048); N.bufR = new Float32Array(2048);
    // hard clip = digital overload
    N.clip = ctx.createWaveShaper();
    const curve = new Float32Array(4097); for (let i = 0; i < curve.length; i++) { const x = (i / 2048) - 1; curve[i] = x; }
    N.clip.curve = curve; // input beyond ±1 is clamped to ±1 by WaveShaper
    N.recGain.connect(N.clip);
    // monitor bus
    N.mon = ctx.createGain(); N.mon.connect(ctx.destination);
    N.cue = ctx.createGain(); N.cue.gain.value = 0; N.clip.connect(N.cue).connect(N.mon);
    N.hall = ctx.createGain(); N.hall.gain.value = 0; N.calib.connect(N.hall).connect(N.mon);
    N.pb = ctx.createGain(); N.pb.connect(N.mon);
    // recorder tap
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      N.tap = new AudioWorkletNode(ctx, 'rec-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      N.tap.port.onmessage = (e) => onChunk(e.data[0], e.data[1]);
      N.tapOn = (v) => N.tap.port.postMessage(v);
      N.tapFlush = () => N.tap.port.postMessage('flush');
    } catch (err) {
      N.tap = ctx.createScriptProcessor(4096, 2, 2); let on = false;
      N.tap.onaudioprocess = (e) => { if (on) onChunk(e.inputBuffer.getChannelData(0).slice(0), e.inputBuffer.getChannelData(1).slice(0)); };
      N.tapOn = (v) => { on = v; }; N.tapFlush = () => {};
    }
    const sink = ctx.createGain(); sink.gain.value = 0;
    N.clip.connect(N.tap); N.tap.connect(sink).connect(ctx.destination);
    N.built = true;
  }

  // 演奏の冒頭（最初に音が出てから約12秒）のピークが −30dB 前後になるよう合わせる。
  // ただし曲全体の最大ピークは −8dB を超えないように抑える。
  function calibrate() {
    const b = S.buffer, sr = b.sampleRate; let peak = 0, startPeak = 0, first = -1;
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 2) { const a = Math.abs(d[i]); if (a > peak) peak = a; if (a > 0.003 && (first < 0 || i < first)) first = i; } }
    if (first < 0) first = 0;
    const end = Math.min(b.length, first + sr * 12);
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = first; i < end; i += 2) { const a = Math.abs(d[i]); if (a > startPeak) startPeak = a; } }
    if (!(peak > 0)) { S.nodes.calib.gain.value = 1; return; }
    let g = db2lin(START_PEAK_DB) / (startPeak || peak);
    g = Math.min(g, db2lin(MAX_PEAK_DB) / peak);
    S.nodes.calib.gain.value = g;
    S.hallLin = db2lin(-3) / (peak * g); // 会場モニター：曲の最大音量で −3dBFS
  }

  function startSource() {
    const ctx = S.ctx;
    if (S.srcNode) { try { S.srcNode.stop(); } catch {} S.srcNode.disconnect(); }
    const n = ctx.createBufferSource(); n.buffer = S.buffer; n.loop = true;
    n.connect(S.nodes.calib); n.start(); S.srcNode = n; S.srcStartAt = ctx.currentTime;
  }

  function applyRouting() {
    const t = S.ctx ? S.ctx.currentTime : 0;
    ['L', 'R'].forEach(side => {
      const sig = signalOf(S.assign[side]);
      [0, 1].forEach(ix => S.nodes.mx[side + ix].gain.setTargetAtTime(sig === ix ? 1 : 0, t, 0.005));
    });
  }
  function applyGain() { if (S.nodes.recGain) S.nodes.recGain.gain.setTargetAtTime(db2lin(S.gainDb), S.ctx.currentTime, 0.008); }
  function applyMonitor() {
    if (!S.nodes.mon) return;
    const t = S.ctx.currentTime, v = +$('#mon-vol').value / 100;
    S.nodes.mon.gain.setTargetAtTime(v * v, t, 0.02);
    const playing = S.tstate === 'play';
    S.nodes.cue.gain.setTargetAtTime(S.cue && !playing ? 1 : 0, t, 0.02);
    S.nodes.hall.gain.setTargetAtTime(S.cue || playing ? 0 : (S.hallLin || 1), t, 0.02);
    $('#mon-note').textContent = playing ? 'USBメモリーの録音ファイルを再生しています。' :
      S.cue ? 'CUE：録音される音（GAIN適用後）を聴いています。0dBを超えると音が歪みます。' :
      'いま聴こえているのは会場の音です。CUE を押すと録音される音（GAIN 適用後）を聴けます。';
  }

  $('#start-btn').addEventListener('click', async () => {
    if (!S.buffer) return;
    const ctx = ensureCtx();
    await ctx.resume();
    await buildGraph();
    calibrate(); applyRouting(); applyGain(); applyMonitor();
    startSource();
    $('#setup').hidden = true; $('#app').hidden = false;
    $('#stage-text').textContent = 'ステージ：演奏中 — ' + S.srcName;
    layoutMeters();
    if (!S.raf) loop();
    renderSteps();
  });

  /* ================= RECORDER UI ================= */
  // REC RATE
  const rateBtn = $('#rate-btn');
  function renderRate() { rateBtn.textContent = S.rate + 'kbps'; }
  rateBtn.addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause' || S.tstate === 'standby') { toast('録音待機中・録音中は REC RATE を変更できません'); return; }
    S.rate = RATES[(RATES.indexOf(S.rate) + 1) % RATES.length]; renderRate();
    rateBtn.classList.remove('is-flash'); void rateBtn.offsetWidth; rateBtn.classList.add('is-flash');
    S.steps.rate = S.rate === 192; renderSteps();
  });

  // assign buttons
  function renderAssign() {
    ['L', 'R'].forEach(side => { $('#assign-' + side + ' .ch-name').textContent = CH_BY_ID[S.assign[side]].name; });
  }
  let chselSide = 'L', chselCat = 'st';
  function openChSel(side) {
    chselSide = side; chselCat = CH_BY_ID[S.assign[side]].cat;
    $('#chsel-title').textContent = 'CH SELECT — RECORDER INPUT ' + side;
    renderChSel(); $('#chsel').hidden = false;
    const on = $('#chsel-cats .cat-btn.is-on'); on && on.focus();
  }
  function renderChSel() {
    $('#chsel-cats').innerHTML = CATS.map(c => `<button class="cat-btn${c.id === chselCat ? ' is-on' : ''}" data-cat="${c.id}">${c.label}</button>`).join('');
    const cat = CATS.find(c => c.id === chselCat), cur = S.assign[chselSide];
    $('#chsel-grid').innerHTML = cat.items.map(it => `<button class="ch-btn${it.id === cur ? ' is-on' : ''}" data-ch="${it.id}"><small>${it.top}</small><b>${it.main}</b></button>`).join('')
      + `<button class="ch-btn is-none${cur === 'NONE' ? ' is-on' : ''}" data-ch="NONE"><b>NONE</b></button>`;
  }
  $('#chsel-cats').addEventListener('click', (e) => { const b = e.target.closest('.cat-btn'); if (!b) return; chselCat = b.dataset.cat; renderChSel(); });
  $('#chsel-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.ch-btn'); if (!b) return;
    S.assign[chselSide] = b.dataset.ch; renderAssign(); applyRouting(); renderChSel();
    S.steps.L = S.assign.L === 'IN11'; S.steps.R = S.assign.R === 'IN12';
    if (!S.steps.gain) S.gainOkTime = 0;
    renderSteps();
    const sig = signalOf(b.dataset.ch);
    if (sig < 0) toast(`${CH_BY_ID[b.dataset.ch].name} には信号が来ていません（メーターが振れません）`);
    else if ((chselSide === 'L' && sig === 1) || (chselSide === 'R' && sig === 0)) toast('信号は来ていますが、左右が逆です');
  });
  $('#chsel-close').addEventListener('click', () => { $('#chsel').hidden = true; });
  $('#chsel').addEventListener('click', (e) => { if (e.target.id === 'chsel') $('#chsel').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#chsel').hidden) $('#chsel').hidden = true; });
  $('#assign-L').addEventListener('click', () => openChSel('L'));
  $('#assign-R').addEventListener('click', () => openChSel('R'));

  // GAIN knob
  const knob = $('#gain-knob'), hw = $('#hw-knob');
  function setGain(db) {
    S.gainDb = clamp(Math.round(db * 10) / 10, GAIN_MIN, GAIN_MAX);
    const ang = (S.gainDb - GAIN_MIN) / (GAIN_MAX - GAIN_MIN) * 270 - 135;
    knob.querySelector('.knob-cap').style.transform = `rotate(${ang}deg)`;
    $('#gain-val').textContent = (S.gainDb > 0 ? '+' : '') + S.gainDb.toFixed(1);
    knob.setAttribute('aria-valuenow', S.gainDb);
    applyGain();
    if (S.tstate === 'rec') { S.rec.gainMin = Math.min(S.rec.gainMin, S.gainDb); S.rec.gainMax = Math.max(S.rec.gainMax, S.gainDb); }
  }
  function setTouched(v) {
    S.touched = v; knob.classList.toggle('is-touched', v); hw.classList.toggle('is-armed', v);
    $('#hw-hint').textContent = v ? 'GAIN を操作中（上下にドラッグ）' : '画面のGAINをタッチすると操作できます';
  }
  function dragControl(el, onStart) {
    let lastY = 0, active = false, hwAngle = 0;
    el.addEventListener('pointerdown', (e) => {
      if (onStart && onStart() === false) return;
      active = true; lastY = e.clientY; el.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dy = lastY - e.clientY; lastY = e.clientY;
      const step = e.shiftKey ? 0.05 : 0.2;
      setGain(S.gainDb + dy * step);
      if (el === hw) { hwAngle += dy * 2; hw.querySelector('.hw-knob-cap').style.transform = `rotate(${hwAngle}deg)`; }
    });
    const end = () => { active = false; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { if (onStart && onStart(true) === false) return; e.preventDefault(); setGain(S.gainDb + (e.deltaY < 0 ? 0.5 : -0.5)); }, { passive: false });
  }
  dragControl(knob, () => { setTouched(true); });
  dragControl(hw, (quiet) => { if (!S.touched) { if (!quiet) toast('先に画面の GAIN ツマミをタッチしてください'); return false; } });
  knob.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 };
    if (map[e.key] != null) { e.preventDefault(); setTouched(true); setGain(S.gainDb + map[e.key]); }
  });
  $('#screen').addEventListener('pointerdown', (e) => { if (!e.target.closest('#gain-knob')) setTouched(false); });

  // CUE
  $('#cue-btn').addEventListener('click', () => {
    S.cue = !S.cue; $('#cue-btn').classList.toggle('is-on', S.cue); $('#cue-btn').setAttribute('aria-pressed', S.cue); applyMonitor();
  });
  $('#mon-vol').addEventListener('input', applyMonitor);

  /* ---------- transport ---------- */
  function setT(st) {
    S.tstate = st;
    const lab = { stop: 'STOP', standby: 'REC STANDBY', rec: '● RECORDING', recpause: 'REC PAUSE', play: '▶ PLAY', playpause: 'PAUSE' }[st];
    const el = $('#tp-status'); el.textContent = lab;
    el.className = 'tp-status' + ({ standby: ' is-standby', rec: ' is-rec', recpause: ' is-pause', play: ' is-play', playpause: ' is-pause' }[st] || '');
    $('#rec-btn').classList.toggle('is-standby', st === 'standby' || st === 'recpause');
    $('#rec-btn').classList.toggle('is-rec', st === 'rec');
    $('#play-btn').classList.toggle('is-play', st === 'rec' || st === 'play');
    $('#play-btn').classList.toggle('is-pause', st === 'recpause' || st === 'playpause');
    applyMonitor(); renderSteps();
  }

  $('#rec-btn').addEventListener('click', () => {
    if (S.tstate === 'stop') { setT('standby'); S.steps.standby = true; resetRecBuf(); $('#tp-time').textContent = fmtTime(0); renderSteps(); }
    else if (S.tstate === 'standby') { setT('stop'); toast('録音待機を解除しました'); }
    else if (S.tstate === 'play' || S.tstate === 'playpause') toast('再生中は録音できません。■で停止してください');
    else toast('録音中です。終わったら ■（STOP）を押してください');
  });
  $('#play-btn').addEventListener('click', () => {
    switch (S.tstate) {
      case 'standby':
        S.rec.startedOk = { L: S.assign.L, R: S.assign.R, gain: S.gainDb, rate: S.rate };
        S.rec.gainMin = S.rec.gainMax = S.gainDb;
        S.nodes.tapOn(true); setT('rec'); S.steps.record = true; renderSteps(); break;
      case 'rec': S.nodes.tapOn(false); S.nodes.tapFlush(); setT('recpause'); break;
      case 'recpause': S.nodes.tapOn(true); setT('rec'); break;
      case 'stop':
        if (S.selFile >= 0) playFile(S.selFile, 0);
        else toast(S.files.length ? '再生するファイルをリストから選んでください' : '録音するには、先に ●（REC）を押して録音待機にしてください', 3200);
        break;
      case 'play': pauseFile(); break;
      case 'playpause': playFile(S.selFile, S.pbOffset); break;
    }
  });
  $('#stop-btn').addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause') finishRec();
    else if (S.tstate === 'standby') setT('stop');
    else if (S.tstate === 'play' || S.tstate === 'playpause') stopFile();
  });

  function resetRecBuf() { S.rec.chunksL = []; S.rec.chunksR = []; S.rec.samples = 0; S.rec.maxPeak = -Infinity; S.rec.overs = 0; }
  function onChunk(l, r) { if (S.tstate !== 'rec' && S.tstate !== 'recpause') return; S.rec.chunksL.push(l); S.rec.chunksR.push(r); S.rec.samples += l.length; }

  function finishRec() {
    S.nodes.tapOn(false); S.nodes.tapFlush();
    setTimeout(() => {
      const sr = S.ctx.sampleRate, n = S.rec.samples;
      if (n < sr * 0.5) { setT('stop'); toast('録音が短すぎたため保存しませんでした'); return; }
      const buf = S.ctx.createBuffer(2, n, sr);
      let off = 0; S.rec.chunksL.forEach((c, i) => { buf.copyToChannel(c, 0, off); buf.copyToChannel(S.rec.chunksR[i], 1, off); off += c.length; });
      const no = S.files.length + 1;
      const file = { no, name: `REC${String(no).padStart(3, '0')}.wav`, buf, dur: n / sr, url: URL.createObjectURL(encodeWav(buf)), stats: { maxPeak: S.rec.maxPeak, overs: S.rec.overs, ...S.rec.startedOk, gainMin: S.rec.gainMin, gainMax: S.rec.gainMax, rateNow: S.rate } };
      S.files.push(file); S.selFile = S.files.length - 1;
      S.steps.stop = true; setT('stop'); renderFiles(); showResult(file);
      toast(`YPE フォルダに ${file.name} を保存しました`);
    }, 120);
  }

  function encodeWav(buf) {
    const ch = 2, sr = buf.sampleRate, n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
    const ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
    let o = 44; for (let i = 0; i < n; i++) { for (const d of [L, R]) { const s = clamp(d[i], -1, 1); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; } }
    return new Blob([ab], { type: 'audio/wav' });
  }

  function renderFiles() {
    const rows = $('#fl-rows');
    if (!S.files.length) { rows.innerHTML = '<div class="fl-empty">ファイルがありません</div>'; return; }
    rows.innerHTML = S.files.map((f, i) => `<button class="fl-row${i === S.selFile ? ' is-sel' : ''}" data-i="${i}"><span class="fl-no">${String(f.no).padStart(3, '0')}</span><span class="fl-name">${f.name}</span><span class="fl-artist">QL1</span><span class="fl-time">${fmtTime(f.dur)}</span></button>`).join('');
  }
  $('#fl-rows').addEventListener('click', (e) => {
    const b = e.target.closest('.fl-row'); if (!b) return;
    if (S.tstate === 'play' || S.tstate === 'playpause') stopFile();
    S.selFile = +b.dataset.i; renderFiles();
    if (S.tstate === 'stop') toast('▶❚❚ で選んだファイルを再生します');
  });

  function playFile(i, offset) {
    const f = S.files[i]; if (!f) return;
    const n = S.ctx.createBufferSource(); n.buffer = f.buf; n.connect(S.nodes.pb);
    n.onended = () => { if (S.pbNode === n && S.tstate === 'play') { S.pbNode = null; S.pbOffset = 0; setT('stop'); } };
    n.start(0, offset); S.pbNode = n; S.pbStartAt = S.ctx.currentTime - offset; setT('play');
  }
  function pauseFile() { if (!S.pbNode) return; S.pbOffset = S.ctx.currentTime - S.pbStartAt; const n = S.pbNode; S.pbNode = null; n.stop(); setT('playpause'); }
  function stopFile() { if (S.pbNode) { const n = S.pbNode; S.pbNode = null; n.stop(); } S.pbOffset = 0; setT('stop'); $('#tp-time').textContent = fmtTime(0); }

  /* ---------- result ---------- */
  function showResult(f) {
    const s = f.stats, items = []; let grade = 'good', title = '良い録音です';
    const silent = !isFinite(s.maxPeak) || s.maxPeak < -55;
    const peakTxt = silent ? '−∞' : fmtDb(s.maxPeak) + ' dB';
    if (silent) { grade = 'bad'; title = 'ほぼ無音です'; items.push('入力元に信号が来ていません。RECORDER INPUT が L: INPUT 11 / R: INPUT 12 になっているか確認しましょう。'); }
    else if (s.overs > 0) { grade = 'bad'; title = '音割れがありました'; items.push(`録音中に OVER（0dB超え）が ${s.overs} 回ありました。その部分は歪んで録音されています。`); }
    else if (s.maxPeak > -6) { grade = 'warn'; title = '音割れはしませんでしたが、ギリギリです'; items.push(`最大ピークが ${peakTxt} でした。−10〜−6dB くらいに収めると、急に大きな音が来ても余裕（ヘッドルーム）があります。`); }
    else if (s.maxPeak < -18) { grade = 'warn'; title = '音量が小さめです'; items.push(`最大ピークが ${peakTxt} でした。もう少し GAIN を上げると、後で音量を上げたときのノイズが目立ちにくくなります。`); }
    else items.push(`最大ピーク ${peakTxt}。ヘッドルームを確保できています。`);
    if (!silent) {
      if (s.L !== 'IN11' || s.R !== 'IN12') items.push(`入力元は L: ${CH_BY_ID[s.L].name} / R: ${CH_BY_ID[s.R].name} でした（推奨は INPUT 11 / INPUT 12）。`);
    }
    if (s.rate !== 192) items.push(`REC RATE は ${s.rate}kbps でした。最大の 192kbps がおすすめです。`);
    if (s.gainMax - s.gainMin >= 0.5) items.push(`録音中に GAIN を ${fmtDb(s.gainMin)} → ${fmtDb(s.gainMax)} dB の範囲で動かしました。録音中の変更は音量の段差になるので、なるべく録音前に決めましょう。`);
    items.push(`長さ ${fmtTime(f.dur)}。実機では MP3（${s.rate}kbps）で USB メモリーの YPE フォルダに保存されます（このアプリでは WAV）。`);
    $('#result-body').innerHTML = `<p class="res-grade ${grade}">${title}</p><ul class="res-list">${items.map(t => `<li>${t}</li>`).join('')}</ul>
      <div class="res-actions"><button class="btn-ghost" id="res-play">録音を聴く</button><a class="btn-ghost" href="${f.url}" download="${f.name}">${f.name} をダウンロード</a></div>`;
    $('#result-card').hidden = false;
    $('#res-play').addEventListener('click', () => { if (S.tstate === 'play' || S.tstate === 'playpause') stopFile(); S.selFile = S.files.indexOf(f); renderFiles(); playFile(S.selFile, 0); });
  }

  /* ---------- steps ---------- */
  const STEP_ORDER = ['rate', 'L', 'R', 'gain', 'standby', 'record', 'stop'];
  const GUIDE_EL = { L: '#assign-L', R: '#assign-R', standby: '#rec-btn', record: '#play-btn', stop: '#stop-btn' };
  function renderSteps() {
    const st = S.steps;
    // rate は推奨（スキップ可）：L 以降が進んでいれば current にしない
    let cur = STEP_ORDER.find(k => !st[k] && !(k === 'rate' && (st.L || st.R)));
    if (S.tstate === 'rec' || S.tstate === 'recpause') cur = 'stop';
    $$('#steps li').forEach(li => { const k = li.dataset.step; li.classList.toggle('is-done', !!st[k]); li.classList.toggle('is-current', k === cur); });
    $$('.is-guide').forEach(el => el.classList.remove('is-guide'));
    if (cur && GUIDE_EL[cur]) $(GUIDE_EL[cur]).classList.add('is-guide');
  }

  /* ================= METER LOOP ================= */
  const POS = [[-60, 0], [-30, 0.28], [-18, 0.5], [-12, 0.64], [-6, 0.78], [0, 0.9]];
  function dbToPos(d) {
    if (d > 0) return 1;
    if (d <= -60) return 0;
    for (let i = 1; i < POS.length; i++) if (d <= POS[i][0]) { const [a, pa] = POS[i - 1], [b, pb] = POS[i]; return pa + (d - a) / (b - a) * (pb - pa); }
    return 0.9;
  }
  const SEGS = 40;
  function layoutMeters() {
    const sc = $('#meter-scale');
    sc.innerHTML = [['OVER', 0.95, 'over'], ['6', 0.78], ['12', 0.64], ['18', 0.5], ['30', 0.28], ['60', 0.015]].map(([t, p, c]) => `<span class="${c || ''}" style="top:${(1 - p) * 100}%">${t}</span>`).join('');
    ['L', 'R'].forEach(s => { const c = $('#meter-' + s), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr)); });
  }
  window.addEventListener('resize', () => { if (!$('#app').hidden) layoutMeters(); });

  function drawMeter(side, m, over) {
    const c = $('#meter-' + side), g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const gap = Math.max(1, Math.round(H / SEGS * 0.28)), sh = (H - gap * (SEGS - 1)) / SEGS;
    const lit = dbToPos(m.disp), hold = dbToPos(m.hold);
    for (let i = 0; i < SEGS; i++) {
      const p0 = i / SEGS, p1 = (i + 1) / SEGS, y = H - (i + 1) * sh - i * gap;
      const isOver = p0 >= 0.9, isY = p0 >= 0.78 && !isOver;
      const on = isOver ? over : lit >= p1 - 0.0001 || (lit > p0 && lit < p1);
      const holdSeg = !isOver && hold > p0 && hold <= p1 + 0.0001 && m.hold > -59;
      let col = isOver ? '#ff3b30' : isY ? '#f0d43a' : '#36d860';
      g.fillStyle = on || holdSeg ? col : isOver ? '#3a1714' : isY ? '#2e2a12' : '#13291a';
      g.fillRect(0, y, W, sh);
    }
  }

  function loop() {
    S.raf = requestAnimationFrame(loop);
    const N = S.nodes, now = performance.now(), dt = S.lastT ? (now - S.lastT) / 1000 : 0.016; S.lastT = now;
    if (!N.anL) return;
    N.anL.getFloatTimeDomainData(N.bufL); N.anR.getFloatTimeDomainData(N.bufR);
    let pL = 0, pR = 0; for (let i = 0; i < 2048; i++) { const a = Math.abs(N.bufL[i]), b = Math.abs(N.bufR[i]); if (a > pL) pL = a; if (b > pR) pR = b; }
    const peaks = { L: lin2db(pL), R: lin2db(pR) };
    const isOver = pL >= 1 || pR >= 1;
    if (isOver) {
      if (now - S.meter.lastOverT > 250) { S.overCount++; if (S.tstate === 'rec') S.rec.overs++; }
      S.meter.lastOverT = now; S.meter.overUntil = now + 1500;
    }
    const overLit = now < S.meter.overUntil;
    ['L', 'R'].forEach(s => {
      const m = S.meter[s], p = isFinite(peaks[s]) ? peaks[s] : -120;
      m.disp = p > m.disp ? p : Math.max(p, m.disp - 26 * dt);
      if (p >= m.hold || now > m.holdT) { m.hold = p; m.holdT = now + 1200; }
      drawMeter(s, m, overLit);
    });
    const ov = $('#meter-scale .over'); ov && ov.classList.toggle('lit', overLit);
    $('#clip-warn').hidden = !overLit;

    const top = Math.max(peaks.L, peaks.R);
    if (S.tstate === 'rec') S.rec.maxPeak = Math.max(S.rec.maxPeak, top);
    const H = S.meter.hist; H.push([now, top]); while (H.length && H[0][0] < now - 5000) H.shift();
    const recentMax = H.reduce((a, b) => Math.max(a, b[1]), -Infinity);

    // readouts (throttled)
    if (!S.lastRO || now - S.lastRO > 90) {
      S.lastRO = now;
      const cls = (d) => d > 0 ? 'is-bad' : d > TARGET_HI ? 'is-warn' : d >= TARGET_LO ? 'is-good' : '';
      const rp = $('#ro-peak'), rm = $('#ro-max');
      rp.textContent = fmtDb(top); rp.className = 'ro-v ' + cls(top);
      rm.textContent = fmtDb(recentMax); rm.className = 'ro-v ' + cls(recentMax);
      $('#ro-over').textContent = S.overCount; $('#ro-over').className = 'ro-v' + (S.overCount ? ' is-bad' : '');
      const pos = isFinite(recentMax) ? clamp((recentMax + 30) / 30, 0, 1) : 0;
      $('#tb-cursor').style.left = (pos * 100) + '%';
    }

    // gain step detection
    if (!S.steps.gain && S.steps.L && S.steps.R) {
      if (recentMax >= TARGET_LO - 0.5 && recentMax <= TARGET_HI + 0.5 && H.length > 30) { S.gainOkTime += dt; if (S.gainOkTime > 1.5) { S.steps.gain = true; renderSteps(); toast('いい音量です。ピークが −10〜−6dB に収まっています'); } }
      else S.gainOkTime = Math.max(0, S.gainOkTime - dt);
    }

    // transport time / free size
    if (S.tstate === 'rec' || S.tstate === 'recpause') {
      const sec = S.rec.samples / S.ctx.sampleRate;
      $('#tp-time').textContent = fmtTime(sec);
      const bytes = S.freeBytes - S.rec.samples / S.ctx.sampleRate * S.rate * 125 - S.files.reduce((a, f) => a + f.dur * f.stats.rate * 125, 0);
      $('#free-size').textContent = (bytes / 1024 ** 3).toFixed(2) + ' GB';
    } else if (S.tstate === 'play') {
      $('#tp-time').textContent = fmtTime(S.ctx.currentTime - S.pbStartAt);
    }
  }

  /* ---------- tools ---------- */
  $('#restart-src').addEventListener('click', () => { if (S.ctx) { startSource(); toast('演奏を最初から始めました'); } });
  $('#reset-all').addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause') { toast('録音中はリセットできません'); return; }
    if (S.tstate !== 'stop') stopFile();
    S.assign = { L: 'STL', R: 'STR' }; renderAssign(); applyRouting();
    setGain(0); S.rate = 128; renderRate();
    if (S.cue) $('#cue-btn').click();
    Object.keys(S.steps).forEach(k => S.steps[k] = false); S.gainOkTime = 0; S.overCount = 0; S.meter.hist = [];
    renderSteps(); toast('設定を初期状態に戻しました');
  });
  $('#change-src').addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause') { toast('録音中は音源を変更できません'); return; }
    if (S.tstate !== 'stop') stopFile();
    if (S.srcNode) { try { S.srcNode.stop(); } catch {} S.srcNode = null; }
    $('#app').hidden = true; $('#setup').hidden = false; $('#start-btn').textContent = 'この音源で再開';
  });

  // init
  renderRate(); renderAssign(); setGain(0); setT('stop');
})();
