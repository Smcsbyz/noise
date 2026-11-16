/* ============ 状态与存档 ============ */
/* 文案均为占位稿，正式文本后续替换 —— 结构已按 GDD v0.2 固定 */

const State = (() => {
  const SAVE_KEY = 'hwu.save.v1';
  const END_KEY  = 'hwu.endings.v1';

  const fresh = () => ({
    v: 1,
    keywords: [],            // 已采集词条 id
    seen: [],                // 已访问页面 key（已访问链接变紫）
    flags: {
      draft1Submitted: false,
      hostContacted: false,  // 汤姆出现在好友列表
      hostStage: 0,          // 0未开场 1..3拒绝 4谈钱 5给带子 6真名
      hostBadPath: false,
      tapeObtained: false,
      clipsFound: [false, false, false],
      memoRead: false,
      seen2015: false,
      kesslerFound: false,   // K14 可采集
      bbsPostIcon: false     // 结局D发帖图标出现
    },
    draft: { words: [null, null, null, null], ninth: '' },
    ending: null
  });

  let S = load();
  const listeners = {};

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.v === 1) return Object.assign(fresh(), d);
      }
    } catch (e) {}
    return fresh();
  }

  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {}
    emit('change');
  }

  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  function emit(ev, data) { (listeners[ev] || []).forEach(fn => fn(data)); }

  /* ---- 词条 ---- */
  function hasKw(id) { return S.keywords.includes(id); }
  function addKw(id) {
    if (!KW[id] || hasKw(id)) return false;
    S.keywords.push(id);
    save();
    emit('kw', id);
    Toast.show('证据已存档', '【' + KW[id].label + '】已加入词库');
    return true;
  }

  /* ---- 页面访问 ---- */
  function markSeen(key) {
    if (!S.seen.includes(key)) { S.seen.push(key); save(); }
  }

  /* ---- flags ---- */
  function flag(k, v) {
    if (typeof v === 'undefined') return S.flags[k];
    S.flags[k] = v;
    save();
    emit('flag:' + k, v);
    emit('flag', k);
  }

  /* ---- 稿件 ---- */
  function setSlot(i, kwId) { S.draft.words[i] = kwId; save(); emit('draft'); }
  function clearSlot(i)     { S.draft.words[i] = null; save(); emit('draft'); }
  function setNinth(txt)    { S.draft.ninth = txt; save(); emit('draft'); }
  function chosenWords() {
    return S.draft.words.filter(Boolean).map(id => KW[id]);
  }

  /* ---- 结局判定（GDD 9.1） ---- */
  function normalize(t) {
    return (t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function judge() {
    const words = chosenWords();
    const neg  = words.filter(w => w.p === '-').length;
    const pos  = words.filter(w => w.p === '+').length;
    const fact = words.filter(w => w.p === '!').length;
    const n = normalize(S.draft.ninth);
    const ninthOK = ['ivan kessler', 'kessler', '伊万·凯斯勒', '伊万凯斯勒', '凯斯勒']
      .includes(n);
    if (ninthOK) return fact >= 1 ? 'D' : 'D_warn';
    if (words.length < 4) return null;      // 未填满
    if (neg === 4) return 'A';
    if (pos === 4) return 'C';
    return 'B';
  }

  function setEnding(code) {
    S.ending = code;
    try {
      const r = JSON.parse(localStorage.getItem(END_KEY) || '[]');
      if (!r.includes(code)) { r.push(code); localStorage.setItem(END_KEY, JSON.stringify(r)); }
    } catch (e) {}
    save();
  }
  function endingsUnlocked() {
    try { return JSON.parse(localStorage.getItem(END_KEY) || '[]'); } catch (e) { return []; }
  }

  function reset() { S = fresh(); save(); }

  return {
    get s() { return S; },
    save, on, hasKw, addKw, markSeen, flag,
    setSlot, clearSlot, setNinth, chosenWords,
    judge, setEnding, endingsUnlocked, reset
  };
})();

/* ---- 轻量事件总线之上的通用提示 ---- */
const Toast = (() => {
  let timer = null;
  function show(title, body) {
    const el = document.getElementById('toast');
    el.innerHTML = '<div class="tt"></div><div class="tb"></div>';
    el.querySelector('.tt').textContent = title;
    el.querySelector('.tb').textContent = body;
    el.classList.remove('hidden');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.add('hidden'), 3500);
  }
  return { show };
})();
