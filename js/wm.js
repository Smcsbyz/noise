/* ============ 窗口管理器 ============ */

const APPS = {};   // 各 app 文件注册：APPS.chat = {title, icon, w, h, render(body), onShow, onClose}

const WM = (() => {
  const layer = () => document.getElementById('windows');
  const open = [];           // 打开顺序（用于挤掉最旧）
  const wins = {};           // id -> {el, btn, minimized, app}
  let z = 100;

  function focusWin(id) {
    document.querySelectorAll('.win').forEach(w => w.classList.remove('active'));
    document.querySelectorAll('.task-btn').forEach(b => b.classList.remove('active'));
    const w = wins[id];
    if (!w) return;
    w.el.classList.add('active');
    w.el.style.zIndex = ++z;
    w.btn.classList.add('active');
  }

  function create(id) {
    const app = APPS[id];
    if (!app) return null;

    /* 最多 4 个窗口，挤掉最旧 */
    if (open.length >= 4) close(open[0]);

    const el = document.createElement('div');
    el.className = 'win';
    el.style.width = (app.w || 420) + 'px';
    el.style.height = (app.h || 320) + 'px';
    const n = open.length;
    el.style.left = (120 + n * 28) + 'px';
    el.style.top = (40 + n * 24) + 'px';

    el.innerHTML =
      '<div class="titlebar">' +
      '<span class="t-ico">' + (app.icon || '▣') + '</span>' +
      '<span class="t-title">' + app.title + '</span>' +
      '<span class="t-btns">' +
      '<button data-a="min">_</button>' +
      '<button data-a="max" title="不可用">□</button>' +
      '<button data-a="close">×</button></span></div>' +
      '<div class="win-body inset"></div>';
    layer().appendChild(el);

    const btn = document.createElement('button');
    btn.className = 'task-btn';
    btn.textContent = app.title;
    btn.onclick = () => {
      if (wins[id].minimized) { restore(id); } else if (wins[id].el.classList.contains('active')) { minimize(id); } else { focusWin(id); }
    };
    document.getElementById('taskButtons').appendChild(btn);

    const rec = { el, btn, minimized: false, app };
    wins[id] = rec;
    open.push(id);

    /* 拖动 */
    const bar = el.querySelector('.titlebar');
    bar.addEventListener('mousedown', ev => {
      if (ev.target.tagName === 'BUTTON') return;
      focusWin(id);
      const sx = ev.clientX - el.offsetLeft, sy = ev.clientY - el.offsetTop;
      const move = e => {
        el.style.left = Math.max(0, e.clientX - sx) + 'px';
        el.style.top  = Math.max(0, e.clientY - sy) + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    bar.addEventListener('dblclick', ev => { if (ev.target.tagName !== 'BUTTON') { /* 最大化故意不可用 */ } });

    el.querySelector('[data-a="min"]').onclick = () => minimize(id);
    el.querySelector('[data-a="max"]').onclick = () => { /* 占位：这台电脑很破，最大化坏了 */ };
    el.querySelector('[data-a="close"]').onclick = () => close(id);

    focusWin(id);
    return rec;
  }

  function openApp(id) {
    const rec = wins[id] || create(id);
    if (!rec) return;
    if (rec.minimized) restore(id);
    rec.app.render && rec.app.render(rec.el.querySelector('.win-body'));
    rec.app.onShow && rec.app.onShow(rec.el);
    focusWin(id);
    return rec;
  }

  function minimize(id) {
    const w = wins[id]; if (!w) return;
    w.el.style.display = 'none';
    w.minimized = true;
    w.btn.classList.remove('active');
  }
  function restore(id) {
    const w = wins[id]; if (!w) return;
    w.el.style.display = '';
    w.minimized = false;
    focusWin(id);
  }
  function close(id) {
    const w = wins[id]; if (!w) return;
    w.app.onClose && w.app.onClose();
    w.el.remove(); w.btn.remove();
    delete wins[id];
    const i = open.indexOf(id); if (i >= 0) open.splice(i, 1);
  }
  function isOpen(id) { return !!wins[id]; }
  function refresh(id) {
    const w = wins[id];
    if (w && w.app.render) w.app.render(w.el.querySelector('.win-body'));
  }

  return { openApp, close, minimize, restore, refresh, isOpen, focusWin };
})();
