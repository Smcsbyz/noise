/* ============ 浏览器窗口 ============ */

const Browser = (() => {
  let cur = 'home';
  const WID = 'browser';

  function go(key) {
    if (key.indexOf('__search:') === 0) { cur = key; }
    else if (SITES[key]) { cur = key; State.markSeen(key); }
    else { cur = 'home'; }
    WM.refresh(WID);
  }

  function resolve(key) {
    if (key.indexOf('__search:') === 0) {
      const q = key.slice(9);
      return { title: '搜索：' + q, url: 'http://search.local/s?q=' + encodeURIComponent(q), skin: 'y1998', html: searchResults(q) };
    }
    const s = SITES[key] || SITES['home'];
    return { title: s.title, url: s.url, skin: s.skin, html: s.render() };
  }

  function searchResults(q) {
    const hit = SEARCH_MAP.find(m => m.match.some(x => q.indexOf(x.toLowerCase()) >= 0));
    let html = '<div class="site y1998"><div class="search-results">';
    if (hit && hit.results.length) {
      hit.results.forEach(r => {
        html += '<div class="r"><div class="r-t">' + link(r.go, r.t) + '</div>' +
                '<div class="r-u">' + r.u + '</div><div class="r-s">' + r.s + '</div></div>';
      });
    } else {
      html += '<div class="none">没有找到相关结果。</div>';
      if (q.indexOf('nomed') >= 0) {
        html += '<div class="didyou">您是不是要找：<b>Ivan Nomed？</b></div>' +
                '<div class="none">（占位：这个名字，全网一片空白。）</div>';
      }
    }
    html += '<p class="footer"><a data-go="search">← 返回搜索首页</a></p></div></div>';
    return html;
  }

  APPS.browser = {
    title: '浏览器', icon: '🌐', w: 760, h: 540,
    render(body) {
      const p = resolve(cur);
      body.innerHTML =
        '<div style="margin-bottom:6px;display:flex;gap:6px;align-items:center">' +
        '<button class="btn95" data-nav="home" style="min-width:0">🏠</button>' +
        '<input class="input95" style="flex:1" readonly value="' + p.url + '"></div>' +
        '<div class="inset" style="height:calc(100% - 34px);overflow:auto;background:#FFF">' +
        p.html + '</div>';
      body.querySelector('[data-nav="home"]').onclick = () => go('home');
      body.querySelectorAll('[data-go]').forEach(a => {
        a.onclick = () => go(a.getAttribute('data-go'));
      });
      body.querySelectorAll('[data-open]').forEach(b => {
        b.onclick = () => WM.openApp(b.getAttribute('data-open'));
      });
      body.querySelectorAll('[data-cite9]').forEach(b => {
        b.onclick = () => { State.setNinth(b.getAttribute('data-cite9')); Toast.show('已引用', '第九格已填入：' + b.getAttribute('data-cite9')); };
      });
    },
    onShow() { State.markSeen(cur); }
  };

  return { go, get cur() { return cur; } };
})();
