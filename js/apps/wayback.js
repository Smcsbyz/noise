/* ============ 时光机窗口 ============ */

const Wayback = (() => {
  const WID = 'wayback';
  const YEARS = { 1998: 'svt/1998', 2003: 'svt/2003', 2008: 'svt/2008', 2015: 'svt/2015', 2019: 'svt/404' };
  let curYear = 1998;

  function setYear(y) {
    curYear = y;
    WM.refresh(WID);
    /* 2008 特殊演出：桌面抖动 + 时钟跳到 03:14 */
    Clock.setEvil(y === 2008);
    document.body.classList.toggle('shake', y === 2008);
    if (y === 2008) setTimeout(() => document.body.classList.remove('shake'), 500);
  }

  APPS.wayback = {
    title: '网页时光机', icon: '⏳', w: 720, h: 520,
    render(body) {
      const key = YEARS[curYear];
      const s = SITES[key];
      let inner;
      if (s) {
        inner = s.render();
        State.markSeen(key);
        if (s.year === 2015) State.flag('seen2015', true);
      } else {
        inner = '<div class="site y404"><h2>该日期没有快照</h2><p>（占位：抓取器只到过那几个年头。）</p></div>';
      }
      const btns = Object.keys(YEARS).map(y =>
        '<button class="btn95 ' + (Number(y) === curYear ? 'cur' : '') + '" data-y="' + y + '">' + y + '</button>').join('');
      body.innerHTML =
        '<div class="wb-head">⏳ 快照回放：<b>http://happywithus.svt.veyland.tv/crew.html</b></div>' +
        '<div class="wb-years">' + btns +
        '<input id="wbYear" class="input95" style="width:64px" placeholder="年份">' +
        '<button class="btn95" id="wbGo" style="min-width:0">跳转</button></div>' +
        '<div class="inset" style="height:calc(100% - 92px);overflow:auto;background:#FFF">' + inner + '</div>';

      body.querySelectorAll('[data-y]').forEach(b => b.onclick = () => setYear(Number(b.getAttribute('data-y'))));
      body.querySelector('#wbGo').onclick = () => {
        const v = Number(body.querySelector('#wbYear').value);
        if (YEARS[v]) setYear(v);
        else { curYear = -1; WM.refresh(WID); Clock.setEvil(false); }
      };
      /* 站内词条按钮（时光机内页也需要） */
      bindKw(body);
    },
    onClose() { Clock.setEvil(false); }
  };

  function bindKw(scope) {
    scope.querySelectorAll('.collect-btn').forEach(b => {
      b.onclick = () => { State.addKw(b.getAttribute('data-kw')); WM.refresh(WID); };
    });
    scope.querySelectorAll('.kw-inline').forEach(s => {
      s.onclick = () => { State.addKw(s.getAttribute('data-kw')); WM.refresh(WID); };
    });
  }

  return { setYear };
})();
