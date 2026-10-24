/* QL1 録音シミュレーター v2（録音・モニター・ケーブル差し替え） */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ---------------- constants ---------------- */
  const GAIN_MIN = -30, GAIN_MAX = 30;
  const MLEVEL_MIN = -60, MLEVEL_MAX = 10;
  const START_PEAK_DB = -30;          // 冒頭のピーク（GAIN 0dB時）
  const MAX_PEAK_DB = -8;             // 曲全体の最大ピークの上限（GAIN 0dB時）
  const HUM_DB = -36;                 // ハムノイズのピーク（GAIN 0dB時）
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

  // ケーブル盤（オス）のソケット
  const SOCKETS = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: 'WL' + (i + 1), label: 'WL' + (i + 1), group: 'ワイヤレスマイク' })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: 'SP' + (i + 1), label: '空き', group: '空き' })),
    { id: 'TL', label: 'L', group: '三点吊り', name: '吊りマイク L' }, { id: 'TR', label: 'R', group: '三点吊り', name: '吊りマイク R' },
    { id: 'AL', label: 'L', group: 'エアモニ', name: 'エアモニ L' }, { id: 'AR', label: 'R', group: 'エアモニ', name: 'エアモニ R' },
  ];
  const SOCK_BY_ID = {}; SOCKETS.forEach(s => SOCK_BY_ID[s.id] = s);
  const SIGNAL_SOCKS = ['TL', 'TR', 'AL', 'AR'];   // 音が来ているソケット
  const N_INPUTS = 12;                              // 卓へ伸びる短いケーブル（INPUT 1〜12）
  const DEFAULT_PATCH = () => ({ 1: 'WL1', 2: 'WL2', 3: 'WL3', 4: 'WL4', 5: 'WL5', 6: 'WL6', 7: 'SP1', 8: 'SP2', 9: 'SP3', 10: 'SP4', 11: 'TL', 12: 'TR' });
  const sockName = (id) => { const s = SOCK_BY_ID[id]; return s ? (s.name || (s.group === '空き' ? '空きソケット' : 'ワイヤレス ' + s.label)) : '未接続'; };

  /* ---------------- state ---------------- */
  const S = {
    ctx: null, buffer: null, srcName: '',
    nodes: {}, srcNode: null,
    assign: { L: 'STL', R: 'STR' },
    massign: { L: 'STL', R: 'STR' },
    patch: DEFAULT_PATCH(), held: null,
    gainDb: 0, mlevel: 0, spk: 0, mono: false, hum: false,
    rate: 128, cue: false, touch: null, page: 'recorder', view: 'desk',
    tstate: 'stop',
    rec: { chunksL: [], chunksR: [], samples: 0, maxPeak: -Infinity, overs: 0, gainMin: Infinity, gainMax: -Infinity, startedOk: null },
    files: [], selFile: -1, pbNode: null, pbStartAt: 0, pbOffset: 0,
    meter: { L: { disp: -120, hold: -120, holdT: 0 }, R: { disp: -120, hold: -120, holdT: 0 }, mL: { disp: -120, hold: -120, holdT: 0 }, mR: { disp: -120, hold: -120, holdT: 0 }, overUntil: 0, lastOverT: 0, hist: [] },
    overCount: 0, popCount: 0,
    steps: { rate: false, L: false, R: false, gain: false, standby: false, record: false, stop: false,
      mpage: false, mL: false, mR: false, spk: false, mono: false,
      hum: false, spk0: false, pullL: false, pullR: false, spkup: false },
    prac: 'rec',
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

  const CONSUMERS = ['recL', 'recR', 'monL', 'monR'];

  async function buildGraph() {
    const ctx = ensureCtx(), N = S.nodes;
    if (N.built) return;
    const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    // ---- 演奏（ステージ）
    N.calib = G();
    N.split = ctx.createChannelSplitter(2); N.calib.connect(N.split);
    // ---- 物理マイク
    N.phys = {}; SIGNAL_SOCKS.forEach(id => N.phys[id] = G());
    // 三点吊り：ステージに近い直接音
    N.split.connect(N.phys.TL, 0); N.split.connect(N.phys.TR, 1);
    // エアモニ：客席後方。残響が多く、高域が少ない、少し遠い
    N.airConv = ctx.createConvolver(); N.airConv.buffer = makeIR(ctx, 2.2, 2.6); N.airConv.normalize = true;
    N.airLP = ctx.createBiquadFilter(); N.airLP.type = 'lowpass'; N.airLP.frequency.value = 5200;
    N.airWet = G(0.9); N.airDry = G(0.35);
    N.calib.connect(N.airConv).connect(N.airWet).connect(N.airLP);
    N.calib.connect(N.airDry).connect(N.airLP);
    N.airOut = G(db2lin(-3)); N.airLP.connect(N.airOut);
    N.airSplit = ctx.createChannelSplitter(2); N.airOut.connect(N.airSplit);
    N.airSplit.connect(N.phys.AL, 0); N.airSplit.connect(N.phys.AR, 1);
    // 客席のざわめき（ごく小さい）
    N.crowd = ctx.createBufferSource(); N.crowd.buffer = makeNoise(ctx, 4); N.crowd.loop = true;
    N.crowdF = ctx.createBiquadFilter(); N.crowdF.type = 'bandpass'; N.crowdF.frequency.value = 900; N.crowdF.Q.value = 0.6;
    N.crowdG = G(db2lin(-58)); N.crowd.connect(N.crowdF).connect(N.crowdG);
    N.crowdSplit = ctx.createChannelSplitter(2); N.crowdG.connect(N.crowdSplit);
    N.crowdSplit.connect(N.phys.AL, 0); N.crowdSplit.connect(N.phys.AR, 1); N.crowd.start();
    // ハムノイズ（50Hz＋倍音）：吊りマイクに左右逆位相で混入
    const real = new Float32Array([0, 1, 0.55, 0.42, 0.18, 0.22, 0.08, 0.1]), imag = new Float32Array(real.length);
    N.hum = ctx.createOscillator(); N.hum.setPeriodicWave(ctx.createPeriodicWave(real, imag)); N.hum.frequency.value = 50;
    N.humG = G(0); N.hum.connect(N.humG);
    N.humL = G(1); N.humR = G(-0.94);
    N.humG.connect(N.humL).connect(N.phys.TL); N.humG.connect(N.humR).connect(N.phys.TR); N.hum.start();
    // ---- 卓の入力 → 消費先（レコーダー L/R、モニター L/R）のマトリクス
    N.cons = {}; N.mx = {};
    CONSUMERS.forEach(c => { N.cons[c] = G(); SIGNAL_SOCKS.forEach(p => { const g = G(0); N.phys[p].connect(g).connect(N.cons[c]); N.mx[c + p] = g; }); });
    // ---- レコーダー
    N.merge = ctx.createChannelMerger(2);
    N.cons.recL.connect(N.merge, 0, 0); N.cons.recR.connect(N.merge, 0, 1);
    N.recGain = G(); N.merge.connect(N.recGain);
    N.mSplit = ctx.createChannelSplitter(2); N.recGain.connect(N.mSplit);
    N.anL = ctx.createAnalyser(); N.anR = ctx.createAnalyser(); N.anL.fftSize = N.anR.fftSize = 2048;
    N.mSplit.connect(N.anL, 0); N.mSplit.connect(N.anR, 1);
    N.clip = ctx.createWaveShaper();
    const curve = new Float32Array(4097); for (let i = 0; i < curve.length; i++) curve[i] = (i / 2048) - 1;
    N.clip.curve = curve; N.recGain.connect(N.clip);
    // ---- モニター
    N.monMerge = ctx.createChannelMerger(2);
    N.cons.monL.connect(N.monMerge, 0, 0); N.cons.monR.connect(N.monMerge, 0, 1);
    N.monSrc = G(1); N.monMerge.connect(N.monSrc);
    N.cueSend = G(0); N.clip.connect(N.cueSend);
    N.pb = G(1);
    N.monPre = G(1); N.monSrc.connect(N.monPre); N.cueSend.connect(N.monPre); N.pb.connect(N.monPre);
    N.monPreSplit = ctx.createChannelSplitter(2); N.monPre.connect(N.monPreSplit);
    N.monOut = ctx.createChannelMerger(2);
    N.mm = {};
    [['LL', 0, 0], ['RL', 1, 0], ['LR', 0, 1], ['RR', 1, 1]].forEach(([k, i, o]) => { const g = G(0); N.monPreSplit.connect(g, i); g.connect(N.monOut, 0, o); N.mm[k] = g; });
    N.mlevel = G(1); N.monOut.connect(N.mlevel);
    N.mmSplit = ctx.createChannelSplitter(2); N.mlevel.connect(N.mmSplit);
    N.anML = ctx.createAnalyser(); N.anMR = ctx.createAnalyser(); N.anML.fftSize = N.anMR.fftSize = 2048;
    N.mmSplit.connect(N.anML, 0); N.mmSplit.connect(N.anMR, 1);
    N.bufL = new Float32Array(2048); N.bufR = new Float32Array(2048);
    // ---- 照明室のモニタースピーカー → PC出力
    N.spk = G(0); N.mlevel.connect(N.spk);
    N.anSpk = ctx.createAnalyser(); N.anSpk.fftSize = 1024; N.spk.connect(N.anSpk); N.bufS = new Float32Array(1024);
    N.master = G(0.5);
    N.limiter = ctx.createDynamicsCompressor(); N.limiter.threshold.value = -3; N.limiter.knee.value = 0; N.limiter.ratio.value = 20; N.limiter.attack.value = 0.002; N.limiter.release.value = 0.1;
    N.spk.connect(N.master); N.master.connect(N.limiter).connect(ctx.destination);
    // ---- レコーダーのタップ
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
    const sink = G(0);
    N.clip.connect(N.tap); N.tap.connect(sink).connect(ctx.destination);
    N.built = true;
  }

  function makeIR(ctx, secs, decay) {
    const len = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay || 3.2); }
    return b;
  }
  function makeNoise(ctx, secs) {
    const len = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let last = 0; for (let i = 0; i < len; i++) { last = 0.97 * last + 0.03 * (Math.random() * 2 - 1); d[i] = last * 6; } }
    return b;
  }

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
  }

  function startSource() {
    const ctx = S.ctx;
    if (S.srcNode) { try { S.srcNode.stop(); } catch {} S.srcNode.disconnect(); }
    const n = ctx.createBufferSource(); n.buffer = S.buffer; n.loop = true;
    n.connect(S.nodes.calib); n.start(); S.srcNode = n;
  }

  // 卓のチャンネル → ケーブル盤のソケット（音源）を解決
  function resolve(chId) {
    const m = /^IN(\d+)$/.exec(chId || ''); if (!m) return null;
    const n = +m[1]; if (n > N_INPUTS) return null;
    return S.patch[n] || null;
  }
  const hasSignal = (sock) => SIGNAL_SOCKS.includes(sock);

  function applyRouting() {
    if (!S.nodes.built) return;
    const t = S.ctx.currentTime;
    const want = { recL: resolve(S.assign.L), recR: resolve(S.assign.R), monL: resolve(S.massign.L), monR: resolve(S.massign.R) };
    CONSUMERS.forEach(c => SIGNAL_SOCKS.forEach(p => S.nodes.mx[c + p].gain.setTargetAtTime(want[c] === p ? 1 : 0, t, 0.004)));
  }
  function applyGain() { if (S.nodes.built) S.nodes.recGain.gain.setTargetAtTime(db2lin(S.gainDb), S.ctx.currentTime, 0.008); }
  function applyHum() {
    if (!S.nodes.built) return;
    S.nodes.humG.gain.setTargetAtTime(S.hum ? db2lin(HUM_DB) : 0, S.ctx.currentTime, 0.05);
  }
  const spkLin = (v) => (v <= 0 || S.spkBroken) ? 0 : db2lin(-36 + v * 3.6);
  function applyMonitor() {
    const N = S.nodes; if (!N.built) return;
    const t = S.ctx.currentTime, playing = S.tstate === 'play';
    N.monSrc.gain.setTargetAtTime(S.cue || playing ? 0 : 1, t, 0.02);
    N.cueSend.gain.setTargetAtTime(S.cue && !playing ? 1 : 0, t, 0.02);
    N.pb.gain.setTargetAtTime(playing ? 1 : 0, t, 0.02);
    const st = S.mono ? 0.5 : 1, x = S.mono ? 0.5 : 0;
    N.mm.LL.gain.setTargetAtTime(st, t, 0.01); N.mm.RR.gain.setTargetAtTime(st, t, 0.01);
    N.mm.RL.gain.setTargetAtTime(x, t, 0.01); N.mm.LR.gain.setTargetAtTime(x, t, 0.01);
    N.mlevel.gain.setTargetAtTime(S.mlevel <= MLEVEL_MIN ? 0 : db2lin(S.mlevel), t, 0.01);
    N.spk.gain.setTargetAtTime(spkLin(S.spk), t, 0.01);
    const v = +$('#mon-vol').value / 100; N.master.gain.setTargetAtTime(v * v, t, 0.02);
    $('#mon-cue-ind').classList.toggle('is-on', S.cue);
    updateMonNote();
  }
  function updateMonNote() {
    let msg;
    const src = (a) => `L: ${CH_BY_ID[a.L].name} / R: ${CH_BY_ID[a.R].name}`;
    if (S.tstate === 'play') msg = 'スピーカーから：USBメモリーの録音ファイルを再生中。';
    else if (S.cue) msg = 'スピーカーから：CUE（録音される音・GAIN適用後）。0dBを超えると歪みます。';
    else msg = `スピーカーから：MONITOR INPUT（${src(S.massign)}）${S.mono ? '・MONO' : ''}。`;
    if (S.spk <= 0) msg += ' ただしスピーカーのツマミが 0 なので音は出ません。';
    else if (S.mlevel <= MLEVEL_MIN) msg += ' ただし MONITOR LEVEL が −∞ です。';
    $('#mon-note').textContent = msg;
  }

  // 抜き差しの「ボツッ」音
  function pop(strength) {
    const ctx = S.ctx, N = S.nodes, sr = ctx.sampleRate, len = Math.floor(sr * 0.35);
    const b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) { const t = i / sr; d[i] = (Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 14) + (Math.random() * 2 - 1) * Math.exp(-t * 90) * 0.8); }
    const n = ctx.createBufferSource(); n.buffer = b; const g = ctx.createGain(); g.gain.value = 0.9 * strength;
    n.connect(g).connect(N.master); n.start();
    const cone = $('#spk-cone'); cone.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
  }

  $('#start-btn').addEventListener('click', async () => {
    if (!S.buffer) return;
    const ctx = ensureCtx();
    await ctx.resume();
    await buildGraph();
    calibrate(); applyRouting(); applyGain(); applyHum(); applyMonitor();
    startSource();
    $('#setup').hidden = true; $('#app').hidden = false; sfxInit(); setView('desk');
    $('#stage-text').textContent = 'ステージ：演奏中 — ' + S.srcName;
    layoutMeters(); renderPatch();
    if (!S.raf) loop();
    renderSteps();
    if (S.spk <= 0) setTimeout(() => toast('照明室のモニタースピーカーは音量 0 になっています。聴くには MONITOR の設定とスピーカーのツマミを。', 4200), 400);
  });

  /* ---------- screen pages ---------- */
  function showPage(p) {
    S.page = p;
    $$('.fab-btn[data-page]').forEach(b => b.classList.toggle('is-on', b.dataset.page === p));
    $('#page-recorder').hidden = p !== 'recorder'; $('#page-monitor').hidden = p !== 'monitor';
    if (p === 'monitor') { S.steps.mpage = true; }
    layoutMeters(); renderSteps();
  }
  $$('.fab-btn[data-page]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.page === 'none') { toast('このシミュレーターでは RECORDER と MONITOR 画面が使えます'); return; }
    showPage(b.dataset.page);
  }));

  /* ---------- REC RATE ---------- */
  const rateBtn = $('#rate-btn');
  function renderRate() { rateBtn.textContent = S.rate + 'kbps'; }
  rateBtn.addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause' || S.tstate === 'standby') { toast('録音待機中・録音中は REC RATE を変更できません'); return; }
    S.rate = RATES[(RATES.indexOf(S.rate) + 1) % RATES.length]; renderRate();
    rateBtn.classList.remove('is-flash'); void rateBtn.offsetWidth; rateBtn.classList.add('is-flash');
    S.steps.rate = S.rate === 192; renderSteps();
  });

  /* ---------- CH SELECT（レコーダー／モニター共通） ---------- */
  function renderAssign() {
    ['L', 'R'].forEach(side => {
      $('#assign-' + side + ' .ch-name').textContent = CH_BY_ID[S.assign[side]].name;
      $('#mon-assign-' + side + ' .ch-name').textContent = CH_BY_ID[S.massign[side]].name;
    });
  }
  let chT = 'rec', chSide = 'L', chCat = 'st';
  const target = () => chT === 'rec' ? S.assign : S.massign;
  function openChSel(t, side) {
    chT = t; chSide = side; chCat = CH_BY_ID[target()[side]].cat;
    $('#chsel-title').textContent = 'CH SELECT — ' + (t === 'rec' ? 'RECORDER INPUT ' : 'MONITOR INPUT ') + side;
    renderChSel(); $('#chsel').hidden = false;
    const on = $('#chsel-cats .cat-btn.is-on'); on && on.focus();
  }
  function renderChSel() {
    $('#chsel-cats').innerHTML = CATS.map(c => `<button class="cat-btn${c.id === chCat ? ' is-on' : ''}" data-cat="${c.id}">${c.label}</button>`).join('');
    const cat = CATS.find(c => c.id === chCat), cur = target()[chSide];
    $('#chsel-grid').innerHTML = cat.items.map(it => `<button class="ch-btn${it.id === cur ? ' is-on' : ''}" data-ch="${it.id}"><small>${it.top}</small><b>${it.main}</b></button>`).join('')
      + `<button class="ch-btn is-none${cur === 'NONE' ? ' is-on' : ''}" data-ch="NONE"><b>NONE</b></button>`;
  }
  $('#chsel-cats').addEventListener('click', (e) => { const b = e.target.closest('.cat-btn'); if (!b) return; chCat = b.dataset.cat; renderChSel(); });
  $('#chsel-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.ch-btn'); if (!b) return;
    target()[chSide] = b.dataset.ch; renderAssign(); applyRouting(); renderChSel();
    if (chT === 'rec' && !S.steps.gain) S.gainOkTime = 0;
    updateAssignSteps(); renderSteps(); updateMonNote();
    const sock = resolve(b.dataset.ch);
    if (!hasSignal(sock)) toast(`${CH_BY_ID[b.dataset.ch].name} には信号が来ていません（メーターが振れません）`);
    else if ((chSide === 'L' && /R$/.test(sock)) || (chSide === 'R' && /L$/.test(sock))) toast('信号は来ていますが、左右が逆です');
  });
  $('#chsel-close').addEventListener('click', () => { $('#chsel').hidden = true; });
  $('#chsel').addEventListener('click', (e) => { if (e.target.id === 'chsel') $('#chsel').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#chsel').hidden) $('#chsel').hidden = true; });
  $('#assign-L').addEventListener('click', () => openChSel('rec', 'L'));
  $('#assign-R').addEventListener('click', () => openChSel('rec', 'R'));
  $('#mon-assign-L').addEventListener('click', () => openChSel('mon', 'L'));
  $('#mon-assign-R').addEventListener('click', () => openChSel('mon', 'R'));
  function updateAssignSteps() {
    S.steps.L = S.assign.L === 'IN11'; S.steps.R = S.assign.R === 'IN12';
    S.steps.mL = S.massign.L === 'IN11'; S.steps.mR = S.massign.R === 'IN12';
  }

  /* ---------- 操作音・振動 ---------- */
  const SFX = { on: true, out: null, noise: null };
  function sfxInit() {
    const ctx = S.ctx; if (!ctx || SFX.out) return;
    SFX.out = ctx.createGain(); SFX.out.gain.value = 0.55; SFX.out.connect(ctx.destination);
    const len = Math.round(ctx.sampleRate * 0.25), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    SFX.noise = b;
  }
  function burst(t, dur, freq, q, gain, type = 'bandpass') {
    const ctx = S.ctx, src = ctx.createBufferSource(); src.buffer = SFX.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(SFX.out); src.start(t, Math.random() * 0.1); src.stop(t + dur + 0.02);
  }
  function thump(t, freq, dur, gain) {
    const ctx = S.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(SFX.out); o.start(t); o.stop(t + dur + 0.02);
  }
  function sfx(kind) {
    if (!SFX.on || !S.ctx || S.ctx.state !== 'running') return;
    sfxInit(); const t = S.ctx.currentTime + 0.002;
    switch (kind) {
      case 'btn': burst(t, 0.012, 2600, 1.2, 0.5); thump(t, 220, 0.045, 0.22); burst(t + 0.05, 0.01, 3400, 1.5, 0.22); break; // カチャ
      case 'touch': burst(t, 0.008, 4200, 2, 0.28); break;
      case 'tick': burst(t, 0.006, 5200 + Math.random() * 600, 3, 0.32); break;            // ノッチ
      case 'limit': thump(t, 140, 0.05, 0.25); break;
      case 'sw': burst(t, 0.01, 3000, 1.4, 0.45); burst(t + 0.03, 0.008, 2200, 1.4, 0.3); break;
      case 'pull': burst(t, 0.012, 3200, 2, 0.5); burst(t + 0.03, 0.14, 900, 0.6, 0.2, 'lowpass'); break; // カチッ＋ズズッ
      case 'insert': burst(t, 0.1, 900, 0.6, 0.18, 'lowpass'); burst(t + 0.1, 0.014, 2800, 1.6, 0.6); thump(t + 0.1, 160, 0.06, 0.3); break; // ズッ＋カチッ
    }
  }
  const buzz = (ms) => { if (SFX.on && navigator.vibrate) try { navigator.vibrate(ms); } catch {} };
  $('#sfx-toggle').addEventListener('change', (e) => { SFX.on = e.target.checked; });
  // 押した感（画面ボタン・物理ボタン）
  const PRESSABLE = '.qbtn, .tbtn, .fab-btn, .cat-btn, .ch-btn, .chsel-close, .btn-ghost, .prac-tab, .vbtn, .next-bar';
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest(PRESSABLE); if (!b) return;
    b.classList.add('is-press'); sfx(b.matches('.prac-tab, .vbtn, .next-bar, .btn-ghost') ? 'touch' : 'btn'); buzz(b.matches('.tbtn') ? 14 : 8);
    const up = () => { setTimeout(() => b.classList.remove('is-press'), 70); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }, true);
  $('#hum-sw').addEventListener('pointerdown', () => { sfx('sw'); buzz(8); });

  /* ---------- knobs ---------- */
  const hw = $('#hw-knob');
  // 画面上のツマミはタッチで「選ぶ」だけ。値は TOUCH AND TURN で変える。
  const KNOBS = {
    gain: { el: $('#gain-knob'), min: GAIN_MIN, max: GAIN_MAX, get: () => S.gainDb, set: (v) => setGain(v), name: 'GAIN', step: 0.5, fine: 0.1 },
    mlevel: { el: $('#mlevel-knob'), min: MLEVEL_MIN, max: MLEVEL_MAX, get: () => S.mlevel, set: (v) => setMLevel(v), name: 'MONITOR LEVEL', step: 1, fine: 0.5 },
  };
  function rotate(el, v, min, max) { const ang = (v - min) / (max - min) * 270 - 135; el.querySelector('.knob-cap, .spk-knob-cap').style.transform = `rotate(${ang}deg)`; }
  function setGain(db) {
    S.gainDb = clamp(Math.round(db * 10) / 10, GAIN_MIN, GAIN_MAX);
    rotate(KNOBS.gain.el, S.gainDb, GAIN_MIN, GAIN_MAX);
    $('#gain-val').textContent = (S.gainDb > 0 ? '+' : '') + S.gainDb.toFixed(1);
    KNOBS.gain.el.setAttribute('aria-valuenow', S.gainDb);
    applyGain();
    if (S.tstate === 'rec') { S.rec.gainMin = Math.min(S.rec.gainMin, S.gainDb); S.rec.gainMax = Math.max(S.rec.gainMax, S.gainDb); }
  }
  function setMLevel(db) {
    S.mlevel = clamp(Math.round(db * 10) / 10, MLEVEL_MIN, MLEVEL_MAX);
    rotate(KNOBS.mlevel.el, S.mlevel, MLEVEL_MIN, MLEVEL_MAX);
    $('#mlevel-val').textContent = S.mlevel <= MLEVEL_MIN ? '−∞' : (S.mlevel > 0 ? '+' : '') + S.mlevel.toFixed(1);
    KNOBS.mlevel.el.setAttribute('aria-valuenow', S.mlevel);
    applyMonitor();
  }
  function setTouch(k) {
    const prev = S.touch; S.touch = k;
    Object.entries(KNOBS).forEach(([key, o]) => o.el.classList.toggle('is-touched', key === k));
    hw.classList.toggle('is-armed', !!k);
    $('#hw-hint').innerHTML = k ? `<b>${KNOBS[k].name}</b> を選択中<br>このノブを回す` : '画面のツマミをタッチ<br>→ このノブで調整';
    if (k !== prev) renderSteps();
  }
  // 回転操作（ノッチ付き）。中心を囲むようにドラッグ／中央付近は上下ドラッグ／ホイール
  function rotary(el, { detent, onStart, onStep }) {
    let st = null;
    const ang = (e, r) => Math.atan2(e.clientY - r.cy, e.clientX - r.cx) * 180 / Math.PI;
    el.addEventListener('pointerdown', (e) => {
      if (onStart && onStart() === false) return;
      const b = el.getBoundingClientRect(), r = { cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
      const dist = Math.hypot(e.clientX - r.cx, e.clientY - r.cy);
      st = { r, mode: dist < b.width * 0.22 ? 'v' : 'a', last: ang(e, r), y: e.clientY, acc: 0 };
      el.setPointerCapture(e.pointerId); e.preventDefault(); el.focus({ preventScroll: true });
    });
    el.addEventListener('pointermove', (e) => {
      if (!st) return;
      let d;
      if (st.mode === 'a') {
        const a = ang(e, st.r); d = a - st.last; if (d > 180) d -= 360; if (d < -180) d += 360; st.last = a;
        if (Math.hypot(e.clientX - st.r.cx, e.clientY - st.r.cy) < 6) d = 0;
      } else { d = (st.y - e.clientY) * 1.6; st.y = e.clientY; }
      st.acc += d;
      while (st.acc >= detent) { st.acc -= detent; onStep(1, e.shiftKey); }
      while (st.acc <= -detent) { st.acc += detent; onStep(-1, e.shiftKey); }
    });
    const end = () => { st = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { e.preventDefault(); if (onStart && onStart(true) === false) return; onStep(e.deltaY < 0 ? 1 : -1, e.shiftKey); }, { passive: false });
  }
  function stepFeedback(el, changed) {
    if (changed) { sfx('tick'); buzz(3); }
    else { sfx('limit'); el.classList.remove('is-limit'); void el.offsetWidth; el.classList.add('is-limit'); }
  }
  Object.entries(KNOBS).forEach(([key, k]) => {
    k.el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); setTouch(key); sfx('touch'); buzz(6);
      k.el.classList.add('is-press'); setTimeout(() => k.el.classList.remove('is-press'), 90);
    });
    k.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTouch(key); return; }
      const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
      if (map[e.key] != null) { e.preventDefault(); setTouch(key); hwStep(map[e.key], e.shiftKey); }
    });
  });
  let hwAngle = 0;
  const HW_DETENT = 12;
  function hwStep(dir, fine) {
    if (!S.touch) return;
    const k = KNOBS[S.touch], before = k.get();
    k.set(before + dir * (fine ? k.fine : k.step));
    const changed = k.get() !== before;
    hwAngle += dir * HW_DETENT;
    hw.querySelector('.hw-knob-cap').style.transform = `rotate(${hwAngle}deg)`;
    stepFeedback(hw, changed);
  }
  rotary(hw, {
    detent: HW_DETENT,
    onStart: (quiet) => { if (!S.touch) { if (!quiet) { toast('先に画面のツマミ（GAIN や LEVEL）をタッチしてください'); sfx('limit'); } return false; } },
    onStep: hwStep,
  });
  hw.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
    if (map[e.key] != null) { e.preventDefault(); if (!S.touch) { toast('先に画面のツマミ（GAIN や LEVEL）をタッチしてください'); return; } hwStep(map[e.key], e.shiftKey); }
  });
  $('#screen').addEventListener('pointerdown', (e) => { if (!e.target.closest('.knob')) setTouch(null); });

  // モニタースピーカーのツマミ（0〜10、0.5 刻みのノッチ）
  const spkKnob = $('#spk-knob');
  function setSpk(v) {
    S.spk = clamp(Math.round(v * 10) / 10, 0, 10);
    rotate(spkKnob, S.spk, 0, 10);
    $('#spk-val').textContent = S.spk.toFixed(1).replace(/\.0$/, '');
    spkKnob.setAttribute('aria-valuenow', S.spk);
    const chip = $('#rack-spk'); chip.textContent = 'モニタースピーカー ' + $('#spk-val').textContent; chip.classList.toggle('is-up', S.spk > 0);
    applyMonitor();
    if (S.spk === 0 && S.steps.hum) S.steps.spk0 = true;
    if (S.spk > 0 && S.steps.pullL && S.steps.pullR) S.steps.spkup = true;
    renderSteps();
  }
  function spkStep(dir) { const b = S.spk; setSpk(S.spk + dir * 0.5); stepFeedback(spkKnob, S.spk !== b); }
  rotary(spkKnob, { detent: 13.5, onStep: spkStep });
  spkKnob.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
    if (map[e.key] != null) { e.preventDefault(); spkStep(map[e.key]); }
    if (e.key === 'Home') { e.preventDefault(); setSpk(0); sfx('tick'); }
    if (e.key === 'End') { e.preventDefault(); setSpk(10); sfx('tick'); }
  });

  /* ---------- 表示の切り替え（スマホ） ---------- */
  function setView(v) {
    S.view = v;
    const app = $('#app'); app.classList.remove('view-desk', 'view-rack', 'view-menu'); app.classList.add('view-' + v);
    $$('.vbtn').forEach(b => b.classList.toggle('is-on', b.dataset.viewBtn === v));
    if (v === 'menu') $('#menu-badge').hidden = true;
    if (v === 'desk') requestAnimationFrame(layoutMeters);
    renderSteps();
  }
  $$('.vbtn').forEach(b => b.addEventListener('click', () => setView(b.dataset.viewBtn)));
  $('#next-bar').addEventListener('click', () => setView('menu'));
  const isMobile = () => window.matchMedia('(max-width:760px)').matches;

  // CUE / MONO / PC volume / hum
  $('#cue-btn').addEventListener('click', () => {
    S.cue = !S.cue; $('#cue-btn').classList.toggle('is-on', S.cue); $('#cue-btn').setAttribute('aria-pressed', S.cue); applyMonitor();
  });
  $('#mono-btn').addEventListener('click', () => {
    S.mono = !S.mono; $('#mono-btn').classList.toggle('is-on', S.mono); $('#mono-btn').setAttribute('aria-pressed', S.mono);
    if (S.mono) S.steps.mono = true;
    applyMonitor(); renderSteps();
    if (S.mono && S.hum && (['TL', 'TR'].includes(resolve(S.massign.L)) && ['TL', 'TR'].includes(resolve(S.massign.R)))) toast('MONO：左右逆位相のハムノイズが打ち消し合って小さくなりました（録音には残ります）', 3800);
  });
  $('#mon-vol').addEventListener('input', applyMonitor);
  $('#hum-toggle').addEventListener('change', (e) => {
    S.hum = e.target.checked; applyHum();
    if (S.hum) { S.steps.hum = true; if (S.spk === 0) S.steps.spk0 = true; toast('吊りマイクにハムノイズ（ブーン）が入りました', 3000); }
    renderSteps();
  });

  /* ---------- patch panel (SVG) ---------- */
  const svg = $('#patch-svg'), NS = 'http://www.w3.org/2000/svg';
  const SX = (i) => 42 + i * 54 + (i >= 6 ? 12 : 0) + (i >= 10 ? 12 : 0) + (i >= 12 ? 12 : 0);
  const SY = 76, IY = 222;
  const IX = (n) => 70 + (n - 1) * 64;
  const CABLE_COL = (n) => n === 11 ? '#e5484d' : n === 12 ? '#e9ecef' : n <= 6 ? '#3e7bd6' : '#7b828b';
  function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
  function renderPatch() {
    svg.innerHTML = '';
    // panel plate
    el('rect', { x: 10, y: 6, width: SX(SOCKETS.length - 1) + 22, height: 110, rx: 8, fill: '#2b2e33', stroke: '#111' }, svg);
    // group labels
    const groups = {}; SOCKETS.forEach((s, i) => { (groups[s.group] = groups[s.group] || []).push(i); });
    Object.entries(groups).forEach(([g, idx]) => {
      const x0 = SX(idx[0]) - 24, x1 = SX(idx[idx.length - 1]) + 24;
      el('rect', { x: x0, y: 13, width: x1 - x0, height: 18, rx: 3, fill: g === '三点吊り' || g === 'エアモニ' ? '#3c3320' : '#22252a' }, svg);
      const t = el('text', { x: (x0 + x1) / 2, y: 26, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700 }, svg); t.textContent = g;
    });
    // sockets
    const occ = {}; Object.entries(S.patch).forEach(([n, s]) => { if (s) occ[s] = +n; });
    const guide = currentGuide();
    SOCKETS.forEach((s, i) => {
      const g = el('g', { class: 'sock' + (guide.sock === s.id ? ' is-target' : ''), 'data-sock': s.id }, svg);
      el('circle', { class: 'sock-ring', cx: SX(i), cy: SY, r: 20, fill: '#121315', stroke: '#6b7178', 'stroke-width': 1.5 }, g);
      [[-6, -4], [6, -4], [0, 6]].forEach(([dx, dy]) => el('circle', { cx: SX(i) + dx, cy: SY + dy, r: 2.6, fill: '#c9a54a' }, g));
      const t = el('text', { x: SX(i), y: SY - 26, 'text-anchor': 'middle', 'font-size': 10, fill: '#aeb4bb' }, g); t.textContent = s.label;
      el('title', {}, g).textContent = sockName(s.id);
    });
    // console female row
    el('rect', { x: 30, y: IY - 18, width: 780, height: 40, rx: 6, fill: '#1a1c1f', stroke: '#000' }, svg);
    const tl = el('text', { x: 36, y: IY - 24, 'font-size': 11, fill: '#8a9198' }, svg); tl.textContent = '音響卓へ（メス）';
    for (let n = 1; n <= N_INPUTS; n++) {
      el('circle', { cx: IX(n), cy: IY, r: 11, fill: '#0c0d0e', stroke: '#555', 'stroke-width': 1.2 }, svg);
      const t = el('text', { x: IX(n), y: IY + 4, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: n >= 11 ? '#ffb38a' : '#cfd4da' }, svg); t.textContent = n;
    }
    // cables
    for (let n = 1; n <= N_INPUTS; n++) {
      const s = S.patch[n], col = CABLE_COL(n);
      let tx, ty;
      if (s) { const i = SOCKETS.findIndex(x => x.id === s); tx = SX(i); ty = SY; }
      else { tx = IX(n); ty = 150; }
      const sx = IX(n), sy = IY - 11;
      const d = s ? `M${sx},${sy} C${sx},${sy - 60} ${tx},${ty + 70} ${tx},${ty + 16}` : `M${sx},${sy} C${sx},${sy - 20} ${tx},${ty + 30} ${tx},${ty + 14}`;
      el('path', { class: 'cable', d, stroke: '#000', 'stroke-width': 7, opacity: 0.5 }, svg);
      el('path', { class: 'cable', d, stroke: col, 'stroke-width': 4.5, 'stroke-dasharray': s ? '' : '6 4' }, svg);
    }
    // plugs (on top)
    for (let n = 1; n <= N_INPUTS; n++) {
      const s = S.patch[n]; let tx, ty;
      if (s) { const i = SOCKETS.findIndex(x => x.id === s); tx = SX(i); ty = SY; } else { tx = IX(n); ty = 150; }
      const g = el('g', { class: 'plug' + (S.held === n ? ' is-held' : '') + (guide.plug === n ? ' is-guide' : ''), 'data-in': n }, svg);
      el('circle', { class: 'plug-body', cx: tx, cy: ty, r: 15, fill: s ? '#3a3e44' : '#55402f', stroke: CABLE_COL(n), 'stroke-width': 2 }, g);
      el('rect', { x: tx - 4, y: ty - 19, width: 8, height: 5, rx: 1.5, fill: '#9aa1a9' }, g); // 突起（ラッチ）
      const t = el('text', { x: tx, y: ty + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#fff' }, g); t.textContent = n;
      el('title', {}, g).textContent = `INPUT ${n} のケーブル${s ? '（' + sockName(s) + '）' : '（抜いた状態）'}`;
    }
    const hint = $('#patch-hint');
    hint.textContent = S.held ? `INPUT ${S.held} のケーブルを持っています → 挿すソケットをタップ` : 'ケーブルの先（プラグ）をタップで抜く → 空いているソケットをタップで挿す';
    hint.classList.toggle('is-hold', !!S.held);
  }
  const BOOM_AT = 10;
  function plugAction(kind) {
    if (S.spk > 0 && !S.spkBroken) {
      S.popCount++; pop(Math.min(1, spkLin(S.spk) * 1.5 + 0.2));
      if (S.popCount >= BOOM_AT) { setTimeout(explode, 350); return; }
      const n = S.popCount, box = $('.spk-box');
      box.classList.toggle('is-smoke', n >= 5); box.classList.toggle('is-smoke-heavy', n >= 8);
      let extra = '';
      if (n >= 8) extra = '<em>スピーカーから煙が出ています。中から「ジジジ…」と嫌な音がします。</em>';
      else if (n >= 5) extra = '<em>なんだか焦げ臭いにおいがしてきました。</em>';
      else if (n >= 3) extra = '<em>スピーカーのコーンが苦しそうに震えています。</em>';
      const w = $('#pop-warn');
      w.innerHTML = `<strong>ボツッ</strong>スピーカーの音量が上がったまま${kind}しました。スピーカーのツマミを 0 にしてから抜き差ししましょう（壊れることがあります）。${extra}`;
      w.hidden = false; clearTimeout(plugAction.t); plugAction.t = setTimeout(() => { w.hidden = true; }, 4200);
    }
  }
  function boomSound() {
    const ctx = S.ctx, sr = ctx.sampleRate, len = Math.floor(sr * 3.2);
    const b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) { const t = i / sr; const nz = Math.random() * 2 - 1; lp += (nz - lp) * (0.08 + 0.5 * Math.exp(-t * 6));
        d[i] = (lp * 1.6 * Math.exp(-t * 1.3) + Math.sin(2 * Math.PI * (48 - t * 10) * t) * Math.exp(-t * 2.2) * 0.9 + (t > 0.25 && Math.random() < 0.0009 ? (Math.random() - 0.5) * 3 * Math.exp(-t) : 0)) * 0.55; } }
    const src = ctx.createBufferSource(); src.buffer = b;
    const g = ctx.createGain(); g.gain.value = 0.9; src.connect(g).connect(ctx.destination); src.start();
  }
  function explode() {
    S.spkBroken = true; applyMonitor();
    $('#pop-warn').hidden = true; setTouch(null);
    try { boomSound(); } catch {}
    if (navigator.vibrate) try { navigator.vibrate([400, 80, 250, 80, 600]); } catch {}
    const box = $('.spk-box'); box.classList.remove('is-smoke'); box.classList.add('is-broken', 'is-smoke-heavy');
    document.body.classList.add('is-shake'); setTimeout(() => document.body.classList.remove('is-shake'), 900);
    const ov = $('#boom'); ov.hidden = false; ov.classList.remove('is-dead'); void ov.offsetWidth; ov.classList.add('is-go');
    setTimeout(() => ov.classList.add('is-dead'), 1700);
  }
  $('#boom-retry').addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause' || S.tstate === 'standby') $('#stop-btn').click();
    S.spkBroken = false;
    $('.spk-box').classList.remove('is-broken', 'is-smoke', 'is-smoke-heavy');
    $('#boom').hidden = true; $('#boom').classList.remove('is-go', 'is-dead');
    setTimeout(() => { $('#reset-all').click(); toast('生き返りました。今度はスピーカーを 0 にしてから抜き差ししましょう', 3800); }, 50);
  });

  svg.addEventListener('click', (e) => {
    const plug = e.target.closest('.plug'), sock = e.target.closest('.sock');
    if (plug) {
      const n = +plug.dataset.in;
      if (!S.patch[n]) { if (S.held === n) toast('挿したいソケットをタップしてください'); else { toast(`先に INPUT ${S.held} のケーブルを挿してください`); } return; }
      if (S.held && S.held !== n) { toast(`先に INPUT ${S.held} のケーブルを挿してください`); return; }
      plugAction('抜き'); sfx('pull'); buzz([6, 30, 10]);
      const from = S.patch[n]; S.patch[n] = null; S.held = n;
      toast(`突起を押しながら INPUT ${n} のケーブルを ${sockName(from)} から抜きました`);
      applyRouting(); renderPatch(); renderSteps(); return;
    }
    if (sock) {
      const id = sock.dataset.sock;
      if (!S.held) { toast('先に、差し替えたいケーブルのプラグをタップして抜いてください'); return; }
      const occupied = Object.values(S.patch).includes(id);
      if (occupied) { toast(`${sockName(id)} には別のケーブルが挿さっています`); return; }
      plugAction('挿し'); sfx('insert'); buzz([10, 60, 18]);
      const n = S.held; S.patch[n] = id; S.held = null;
      toast(`INPUT ${n} を ${sockName(id)} に挿しました`);
      S.steps.pullL = S.patch[11] === 'AL'; S.steps.pullR = S.patch[12] === 'AR';
      if (S.steps.pullL && S.steps.pullR && S.spk > 0) S.steps.spkup = true;
      applyRouting(); renderPatch(); renderSteps();
    }
  });


  /* ---------- 練習メニュー ---------- */
  $$('.prac-tab').forEach(b => b.addEventListener('click', () => {
    S.prac = b.dataset.prac;
    $$('.prac-tab').forEach(x => x.classList.toggle('is-on', x === b));
    $$('[data-prac-panel]').forEach(p => p.hidden = p.dataset.pracPanel !== S.prac);
    if (S.prac === 'mon' && S.page !== 'monitor') {} // ガイドで誘導
    renderSteps();
  }));
  const ORDERS = { rec: ['rate', 'L', 'R', 'gain', 'standby', 'record', 'stop'], mon: ['mpage', 'mL', 'mR', 'spk', 'mono'], patch: ['hum', 'spk0', 'pullL', 'pullR', 'spkup'] };
  const LIST_ID = { rec: '#steps', mon: '#steps-mon', patch: '#steps-patch' };
  function curStep() {
    const st = S.steps, o = ORDERS[S.prac];
    if (S.prac === 'rec') {
      if (S.tstate === 'rec' || S.tstate === 'recpause') return 'stop';
      return o.find(k => !st[k] && !(k === 'rate' && (st.L || st.R)));
    }
    if (S.prac === 'patch') {
      // ケーブル作業中にスピーカーを上げてしまったら 0 に戻すよう促す
      if (st.hum && !(st.pullL && st.pullR) && S.spk > 0) return 'spk0';
    }
    return o.find(k => !st[k]);
  }
  function currentGuide() {
    const k = curStep(), g = { el: null, plug: null, sock: null };
    if (!k) return g;
    const needMon = S.page !== 'monitor' ? 'button.fab-btn[data-page="monitor"]' : null;
    const needRec = S.page !== 'recorder' ? 'button.fab-btn[data-page="recorder"]' : null;
    switch (k) {
      case 'L': g.el = needRec || '#assign-L'; break;
      case 'R': g.el = needRec || '#assign-R'; break;
      case 'gain': g.el = needRec || (S.touch === 'gain' ? '#hw-knob' : '#gain-knob'); break;
      case 'standby': g.el = needRec || '#rec-btn'; break;
      case 'record': g.el = needRec || '#play-btn'; break;
      case 'stop': g.el = needRec || '#stop-btn'; break;
      case 'mpage': g.el = 'button.fab-btn[data-page="monitor"]'; break;
      case 'mL': g.el = needMon || '#mon-assign-L'; break;
      case 'mR': g.el = needMon || '#mon-assign-R'; break;
      case 'mono': g.el = needMon || '#mono-btn'; break;
      case 'spk': case 'spk0': case 'spkup': g.el = '#spk-knob'; break;
      case 'hum': g.el = '#hum-sw'; break;
      case 'pullL': if (S.held === 11) g.sock = 'AL'; else if (!S.held) g.plug = 11; break;
      case 'pullR': if (S.held === 12) g.sock = 'AR'; else if (!S.held) g.plug = 12; break;
    }
    return g;
  }
  let lastGuideKey = '';
  function renderSteps() {
    const st = S.steps;
    Object.entries(LIST_ID).forEach(([m, id]) => {
      const cur = m === S.prac ? curStep() : null;
      $$(id + ' li').forEach(li => { const k = li.dataset.step; li.classList.toggle('is-done', !!st[k]); li.classList.toggle('is-current', k === cur); });
    });
    $$('.is-guide:not(.plug):not(.sock)').forEach(el => el.classList.remove('is-guide'));
    const g = currentGuide();
    if (g.el) { const e = $(g.el); e && e.classList.add('is-guide'); }
    const key = g.plug + '/' + g.sock;
    if (key !== lastGuideKey) { lastGuideKey = key; if (svg.childNodes.length) renderPatch(); }
    // スマホ：次の手順バーと表示切り替えの誘導
    const curLi = $(LIST_ID[S.prac] + ' li.is-current b');
    const nb = $('#next-bar');
    $('#next-text').textContent = curLi ? curLi.textContent : 'このメニューは完了しました。ほかの練習も試せます';
    nb.classList.toggle('is-done', !curLi);
    let tv = null;
    if (g.plug || g.sock) tv = 'rack';
    else if (g.el) { const e = $(g.el); const v = e && e.closest('.view'); tv = v ? v.dataset.view : null; }
    $$('.vbtn').forEach(b => b.classList.toggle('is-guide', !!tv && b.dataset.viewBtn === tv && tv !== S.view));
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
  const METERS = ['L', 'R', 'mL', 'mR'];
  function layoutMeters() {
    const html = [['OVER', 0.95, 'over'], ['6', 0.78], ['12', 0.64], ['18', 0.5], ['30', 0.28], ['60', 0.015]].map(([t, p, c]) => `<span class="${c || ''}" style="top:${(1 - p) * 100}%">${t}</span>`).join('');
    $$('.meter-scale').forEach(sc => sc.innerHTML = html);
    METERS.forEach(s => { const c = $('#meter-' + s), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; if (r.width) { c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr)); } });
  }
  window.addEventListener('resize', () => { if (!$('#app').hidden) layoutMeters(); });

  function drawMeter(side, m, over) {
    const c = $('#meter-' + side); if (!c.offsetParent) return;
    const g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const gap = Math.max(1, Math.round(H / SEGS * 0.28)), sh = (H - gap * (SEGS - 1)) / SEGS;
    const lit = dbToPos(m.disp), hold = dbToPos(m.hold);
    for (let i = 0; i < SEGS; i++) {
      const p0 = i / SEGS, p1 = (i + 1) / SEGS, y = H - (i + 1) * sh - i * gap;
      const isOver = p0 >= 0.9, isY = p0 >= 0.78 && !isOver;
      const on = isOver ? over : lit >= p1 - 0.0001 || (lit > p0 && lit < p1);
      const holdSeg = !isOver && hold > p0 && hold <= p1 + 0.0001 && m.hold > -59;
      const col = isOver ? '#ff3b30' : isY ? '#f0d43a' : '#36d860';
      g.fillStyle = on || holdSeg ? col : isOver ? '#3a1714' : isY ? '#2e2a12' : '#13291a';
      g.fillRect(0, y, W, sh);
    }
  }
  const peakOf = (an, buf) => { an.getFloatTimeDomainData(buf); let p = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; } return p; };
  const bufML = new Float32Array(2048), bufMR = new Float32Array(2048);

  function loop() {
    S.raf = requestAnimationFrame(loop);
    const N = S.nodes, now = performance.now(), dt = S.lastT ? Math.min(0.1, (now - S.lastT) / 1000) : 0.016; S.lastT = now;
    if (!N.anL) return;
    const pL = peakOf(N.anL, N.bufL), pR = peakOf(N.anR, N.bufR);
    const pmL = peakOf(N.anML, bufML), pmR = peakOf(N.anMR, bufMR);
    const pS = peakOf(N.anSpk, N.bufS);
    const peaks = { L: lin2db(pL), R: lin2db(pR), mL: lin2db(pmL), mR: lin2db(pmR) };
    const isOver = pL >= 1 || pR >= 1;
    if (isOver) {
      if (now - S.meter.lastOverT > 250) { S.overCount++; if (S.tstate === 'rec') S.rec.overs++; }
      S.meter.lastOverT = now; S.meter.overUntil = now + 1500;
    }
    const overLit = now < S.meter.overUntil;
    const mOver = pmL >= 1 || pmR >= 1;
    METERS.forEach(s => {
      const m = S.meter[s], p = isFinite(peaks[s]) ? peaks[s] : -120;
      m.disp = p > m.disp ? p : Math.max(p, m.disp - 26 * dt);
      if (p >= m.hold || now > m.holdT) { m.hold = p; m.holdT = now + 1200; }
      drawMeter(s, m, s.length === 1 ? overLit : mOver);
    });
    $$('.meter-scale-r .over').forEach(o => o.classList.toggle('lit', overLit));
    $$('.meter-scale-m .over').forEach(o => o.classList.toggle('lit', mOver));
    $('#clip-warn').hidden = !overLit;

    // スピーカーのコーン／LED
    const sdb = lin2db(pS);
    $('#spk-led').classList.toggle('is-on', S.spk > 0);
    $('#spk-cone').style.transform = `scale(${1 + clamp((sdb + 50) / 50, 0, 1) * 0.06 * Math.random()})`;
    if (!S.steps.spk && sdb > -50 && S.steps.mL && S.steps.mR) { S.steps.spk = true; renderSteps(); toast('スピーカーから音が出ました'); }

    const top = Math.max(peaks.L, peaks.R);
    if (S.tstate === 'rec') S.rec.maxPeak = Math.max(S.rec.maxPeak, top);
    const H = S.meter.hist; H.push([now, top]); while (H.length && H[0][0] < now - 5000) H.shift();
    const recentMax = H.reduce((a, b) => Math.max(a, b[1]), -Infinity);

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

    if (!S.steps.gain && S.steps.L && S.steps.R) {
      if (recentMax >= TARGET_LO - 0.5 && recentMax <= TARGET_HI + 0.5 && H.length > 30) { S.gainOkTime += dt; if (S.gainOkTime > 1.5) { S.steps.gain = true; renderSteps(); toast('いい音量です。ピークが −10〜−6dB に収まっています'); } }
      else S.gainOkTime = Math.max(0, S.gainOkTime - dt);
    }

    if (S.tstate === 'rec' || S.tstate === 'recpause') {
      const sec = S.rec.samples / S.ctx.sampleRate;
      $('#tp-time').textContent = fmtTime(sec);
      const bytes = S.freeBytes - sec * S.rate * 125 - S.files.reduce((a, f) => a + f.dur * f.stats.rate * 125, 0);
      $('#free-size').textContent = (bytes / 1024 ** 3).toFixed(2) + ' GB';
    } else if (S.tstate === 'play') {
      $('#tp-time').textContent = fmtTime(S.ctx.currentTime - S.pbStartAt);
    }
  }

  /* ---------- result ---------- */
  function showResult(f) {
    const s = f.stats, items = []; let grade = 'good', title = '良い録音です';
    const silent = !isFinite(s.maxPeak) || s.maxPeak < -55;
    const peakTxt = silent ? '−∞' : fmtDb(s.maxPeak) + ' dB';
    if (silent) { grade = 'bad'; title = 'ほぼ無音です'; items.push('入力元に信号が来ていません。RECORDER INPUT が L: INPUT 11 / R: INPUT 12 になっているか、ケーブル盤で INPUT 11/12 が吊りマイクかエアモニに挿さっているか確認しましょう。'); }
    else if (s.overs > 0) { grade = 'bad'; title = '音割れがありました'; items.push(`録音中に OVER（0dB超え）が ${s.overs} 回ありました。その部分は歪んで録音されています。`); }
    else if (s.maxPeak > -6) { grade = 'warn'; title = '音割れはしませんでしたが、ギリギリです'; items.push(`最大ピークが ${peakTxt} でした。−10〜−6dB くらいに収めると、急に大きな音が来ても余裕（ヘッドルーム）があります。`); }
    else if (s.maxPeak < -18) { grade = 'warn'; title = '音量が小さめです'; items.push(`最大ピークが ${peakTxt} でした。もう少し GAIN を上げると、後で音量を上げたときのノイズが目立ちにくくなります。`); }
    else items.push(`最大ピーク ${peakTxt}。ヘッドルームを確保できています。`);
    if (!silent && (s.L !== 'IN11' || s.R !== 'IN12')) items.push(`入力元は L: ${CH_BY_ID[s.L].name} / R: ${CH_BY_ID[s.R].name} でした（推奨は INPUT 11 / INPUT 12）。`);
    const srcs = s.srcs || [];
    if (!silent && srcs[0] && srcs[1] && /R$/.test(srcs[0]) && /L$/.test(srcs[1])) items.push('左右が逆に録音されています。');
    if (s.hum && srcs.some(x => x === 'TL' || x === 'TR')) {
      if (grade === 'good') { grade = 'warn'; title = 'ハムノイズが入っています'; }
      items.push('吊りマイクのハムノイズ（ブーン）が録音に入っています。MONO で聴くと消えても、録音（ステレオ）には残ります。どうしようもない時はケーブル盤で INPUT 11/12 をエアモニに差し替えましょう。');
    }
    if (!silent && srcs.some(x => x === 'AL' || x === 'AR')) items.push('エアモニ（客席側のマイク）で録音しました。ノイズは避けられますが、吊りマイクより残響や客席の物音が多めになります。');
    if (s.rate !== 192) items.push(`REC RATE は ${s.rate}kbps でした。最大の 192kbps がおすすめです。`);
    if (s.gainMax - s.gainMin >= 0.5) items.push(`録音中に GAIN を ${fmtDb(s.gainMin)} → ${fmtDb(s.gainMax)} dB の範囲で動かしました。録音中の変更は音量の段差になるので、なるべく録音前に決めましょう。`);
    items.push(`長さ ${fmtTime(f.dur)}。実機では MP3（${s.rate}kbps）で USB メモリーの YPE フォルダに保存されます（このアプリでは WAV）。`);
    $('#result-body').innerHTML = `<p class="res-grade ${grade}">${title}</p><ul class="res-list">${items.map(t => `<li>${t}</li>`).join('')}</ul>
      <div class="res-actions"><button class="btn-ghost" id="res-play">録音を聴く</button><a class="btn-ghost" href="${f.url}" download="${f.name}">${f.name} をダウンロード</a></div>`;
    $('#result-card').hidden = false;
    if (isMobile() && S.view !== 'menu') { $('#menu-badge').hidden = false; setTimeout(() => toast('録音結果を「メニュー」に表示しました', 3000), 900); }
    $('#res-play').addEventListener('click', () => {
      if (S.tstate === 'play' || S.tstate === 'playpause') stopFile();
      S.selFile = S.files.indexOf(f); renderFiles(); playFile(S.selFile, 0);
      if (S.spk <= 0) toast('再生音は照明室のスピーカーから出ます。スピーカーのツマミを上げてください', 3500);
    });
  }

  /* ---------- tools ---------- */
  $('#restart-src').addEventListener('click', () => { if (S.ctx) { startSource(); toast('演奏を最初から始めました'); } });
  $('#reset-all').addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause') { toast('録音中はリセットできません'); return; }
    if (S.tstate !== 'stop') stopFile();
    S.assign = { L: 'STL', R: 'STR' }; S.massign = { L: 'STL', R: 'STR' };
    S.patch = DEFAULT_PATCH(); S.held = null;
    setGain(0); setMLevel(0); setSpk(0); S.rate = 128; renderRate();
    if (S.cue) $('#cue-btn').click();
    if (S.mono) $('#mono-btn').click();
    S.hum = false; $('#hum-toggle').checked = false; applyHum();
    renderAssign(); applyRouting(); renderPatch();
    Object.keys(S.steps).forEach(k => S.steps[k] = false); S.gainOkTime = 0; S.overCount = 0; S.popCount = 0; S.spkBroken = false; $('.spk-box').classList.remove('is-broken', 'is-smoke', 'is-smoke-heavy'); S.meter.hist = [];
    renderSteps(); toast('設定を初期状態に戻しました');
  });
  $('#change-src').addEventListener('click', () => {
    if (S.tstate === 'rec' || S.tstate === 'recpause') { toast('録音中は音源を変更できません'); return; }
    if (S.tstate !== 'stop') stopFile();
    if (S.srcNode) { try { S.srcNode.stop(); } catch {} S.srcNode = null; }
    $('#app').hidden = true; $('#setup').hidden = false; $('#start-btn').textContent = 'この音源で再開';
  });

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
        S.rec.startedOk = { L: S.assign.L, R: S.assign.R, gain: S.gainDb, rate: S.rate, srcs: [resolve(S.assign.L), resolve(S.assign.R)], hum: S.hum };
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
      S.steps.stop = true; if (S.hum) S.rec.startedOk.hum = true; setT('stop'); renderFiles(); showResult(file);
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


  // init
  renderRate(); renderAssign(); setGain(0); setMLevel(0); setSpk(0); setT('stop'); renderPatch(); renderSteps();
})();
