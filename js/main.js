/* ============ 桌面主控：图标 / 时钟 / 发布流程 / 结局屏 ============ */

const Main = (() => {
  /* ---------- 时钟（含 03:14 机制） ---------- */
  let evilClock = false;
  const Clock = {
    setEvil(v) { evilClock = v; tick(); },
    get evil() { return evilClock; }
  };
  function tick() {
    const el = document.getElementById('clock');
    if (evilClock) { el.textContent = '03:14'; el.classList.add('evil'); return; }
    el.classList.remove('evil');
    const d = new Date();
    el.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ---------- 桌面图标 ---------- */
  const ICONS = [
    { id: 'chat',     lbl: '聊天',       ico: '💬' },
    { id: 'browser',  lbl: '浏览器',     ico: '🌐' },
    { id: 'wayback',  lbl: '网页时光机', ico: '⏳' },
    { id: 'compare',  lbl: '录像对比器', ico: '🎬' },
    { id: 'notepad',  lbl: '记事本',     ico: '📝' },
    { id: 'mypc',     lbl: '我的电脑',   ico: '🖥' },
    { id: 'trash',    lbl: '回收站',     ico: '🗑' },
    { id: 'bbspost',  lbl: 'BBS 发帖',   ico: '📮', hidden: () => !State.flag('bbsPostIcon') }
  ];

  function buildIcons() {
    const box = document.getElementById('icons');
    box.innerHTML = '';
    ICONS.forEach(ic => {
      if (ic.hidden && ic.hidden()) return;
      const el = document.createElement('div');
      el.className = 'd-icon';
      el.innerHTML = '<div class="ico">' + ic.ico + '</div><div class="lbl">' + ic.lbl + '</div>';
      el.ondblclick = () => {
        if (ic.id === 'bbspost') { WM.openApp('browser'); Browser.go('forum/postd'); return; }
        if (ic.id === 'mypc' || ic.id === 'trash') { WM.openApp(ic.id); return; }
        WM.openApp(ic.id);
      };
      el.onclick = () => {
        document.querySelectorAll('.d-icon').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
      };
      box.appendChild(el);
    });
  }

  /* ---------- 假对话框 ---------- */
  APPS.mypc = {
    title: '我的电脑', icon: '🖥', w: 380, h: 240,
    render(body) {
      body.innerHTML = '<div class="fake-dialog"><p><b>3.5 英寸软盘 (A:)</b></p><p style="color:#888">此驱动器不可用。</p>' +
        '<p style="color:#888">（占位：这台电脑里没有别的东西了。）</p></div>';
    }
  };
  APPS.trash = {
    title: '回收站', icon: '🗑', w: 420, h: 280,
    render(body) {
      body.innerHTML = '<div class="fake-dialog"><p><b>稿子_废稿_不要发.txt</b> ' +
        '<button class="btn95" id="openTrash" style="min-width:0">打开</button></p>' +
        '<div id="trashBody"></div></div>';
      body.querySelector('#openTrash').onclick = () => {
        body.querySelector('#trashBody').innerHTML =
          '<p style="margin-top:8px;color:#555">（占位：一段被转成文字的语音。）</p>' +
          '<p style="margin-top:8px">"那个稿子毙了。谁让你往回改的？听着，我们吃这碗饭靠的是……（后文无法识别）"</p>';
      };
    }
  };

  /* ---------- 事件消息接线 ---------- */
  function wireEvents() {
    State.on('kw', id => {
      if (id === 'K11') Chat.push('lu', DLG_LU_EVENTS.m3);                 /* 找齐剪辑点 */
      if (id === 'K12') Chat.push('lu', DLG_LU_EVENTS.m4);                 /* 看到备忘录 */
      if (id === 'K14') Toast.show('第九个词条', '占位：把这个名字写进稿子里。');
    });
  }

  /* ---------- 发布流程 ---------- */
  function publish() {
    const s = State.s;
    const code = State.judge();
    if (State.chosenWords().length < 4) {
      Toast.show('提示', '占位：还需要填满 4 个词条。');
      return;
    }
    if (s.ending) { Toast.show('提示', '稿子已经发出去了。'); return; }

    /* 第一次提交 = 初稿：不锁结局，老板反馈 + 主持人上线 */
    if (!s.flags.draft1Submitted) {
      State.flag('draft1Submitted', true);
      State.flag('hostContacted', true);
      const neg = State.chosenWords().filter(w => w.p === '-').length;
      Chat.push('lu', neg >= 3 ? DLG_LU_EVENTS.m2_neg : DLG_LU_EVENTS.m2_pos);
      Toast.show('新联系人', '汤姆·哈洛 已加入好友列表');
      buildIcons();
      WM.refresh('notepad');
      return;
    }

    if (code === 'D') {
      Chat.push('lu', DLG_LU_EVENTS.m5_refuse);
      State.flag('bbsPostIcon', true);
      buildIcons();
      Toast.show('提示', '老板不发。占位：你可以用自己的账号，在论坛上把话说出来。');
      return;
    }
    if (code) { State.setEnding(code); showEnding(code); }
  }

  /* BBS 发帖（结局 D） */
  function postD() {
    const c = document.getElementById('postCounter');
    const steps = ['正在被 1 人浏览…', '正在被 4 人浏览…', '正在被 37 人浏览…', '正在被 1,204 人浏览…'];
    let i = 0;
    const t = setInterval(() => {
      c.textContent = steps[i++];
      if (i >= steps.length) {
        clearInterval(t);
        State.setEnding('D');
        showEnding('D');
      }
    }, 1100);
  }

  /* ---------- 结局屏 ---------- */
  const ENDINGS = {
    A: { title: '结局 A · 流量狂欢', body: [
      '阅读量 10 万+。评论区前三条：',
      '"我就说！" / "当年看这节目的小孩现在都有阴影吧" / "她在哪？"',
      '第二天，论坛出现新帖：《玛格丽特·维尔现住址（已核实）》。',
      '第三天，她的回应只有一句："我不认识网上那个我。我只认识一个每天早上五点起来缝皮套的女人。"',
      '第七天，小满发来：她搬走了。邻居说她再也不出门。',
      '而陆哥的消息是：下个月还有一篇，这个选题能吃一年。'
    ], sub: '你写对了所有人的想象。你写错了一个人。' },
    B: { title: '结局 B · 无人问津', body: [
      '阅读量 2,317。评论区："所以到底是不是邪教啊？"',
      '陆哥：这个不行。没有结论的东西没人看。你这周不用来了。',
      '小满发来一个句号。'
    ], sub: '你谁也没得罪。你也谁都没救。' },
    B_warn: { title: '结局 B′ · 查无实据', body: [
      '陆哥：你凭什么这么说？证据呢？',
      '稿件被退回。你写了那个名字，却拿不出能把名字钉住的东西。',
      '（占位：差一点。就差那三处剪辑痕迹。）'
    ], sub: '差一点。就差一点。' },
    C: { title: '结局 C · 刺破黑夜', body: [
      '陆哥：这个……算了，你发吧。反正没人看。',
      '三天后，帖子被转到论坛。一位自称当年小观众的网友留言："我小时候给她写过信，她回了。"',
      '一周后，新闻站转载，标题改了，但内容没改。',
      '她的回应：你们找到他了。我一直以为，只要我不说，那些孩子就能当没发生过。是我错了。'
    ], sub: '你没能找到那个恶魔。但你至少把一个人，从她没做过的事情里捞了出来。' },
    D: { title: '结局 D · 凝视深渊', body: [
      '帖子被搬运到英文 lost media 论坛，标题：《The man who was edited out》。',
      '汤姆·哈洛的最后一条消息：我等了二十年，等的不是平反，是有人肯把那个名字写出来。谢谢你，孩子。',
      '一条 2019 年的旧帖被顶起来，tape_hunter_91 回了一句：我就知道我没记错。',
      '她的回应：你们找到他了。不说，才让他在别的地方又待了十年。'
    ], sub: '一个名字，用了三十年才被写对。你写的不是爆款。你写的是墓志铭。' }
  };

  function showEnding(code) {
    const e = ENDINGS[code];
    const el = document.getElementById('ending');
    el.innerHTML = '<div class="ending-inner"><h1>' + e.title + '</h1>' +
      '<div class="end-body">' + e.body.map(p => '<p>' + p + '</p>').join('') + '</div>' +
      '<div class="end-sub">' + e.sub + '</div>' +
      '<div class="end-btns"><button class="btn95" id="endRestart">重新开始</button></div></div>';
    el.classList.remove('hidden');
    el.querySelector('#endRestart').onclick = () => { State.reset(); location.reload(); };
  }

  /* ---------- 全局事件委托 ---------- */
  function wireGlobal() {
    document.addEventListener('click', ev => {
      const kw = ev.target.closest && ev.target.closest('.collect-btn, .kw-inline');
      if (kw && kw.getAttribute('data-kw')) {
        State.addKw(kw.getAttribute('data-kw'));
        WM.refresh('browser'); WM.refresh('wayback');
        return;
      }
      const go = ev.target.closest && ev.target.closest('a[data-go]');
      if (go) {
        ev.preventDefault();
        if (!WM.isOpen('browser')) WM.openApp('browser');
        Browser.go(go.getAttribute('data-go'));
      }
      const post = ev.target.closest && ev.target.closest('#postD');
      if (post) postD();
    });
  }

  /* ---------- 开始按钮彩蛋 ---------- */
  function wireStart() {
    document.getElementById('startBtn').onclick = () => {
      Toast.show('开始', '现在不能关闭，稿子还没交。');
    };
  }

  function onDesktopReady() {
    buildIcons();
    wireStart();
    wireGlobal();
    wireEvents();
    tick();
    setInterval(tick, 15000);
    /* 开局消息 */
    setTimeout(() => { Chat.push('lu', DLG_LU_EVENTS.m1); Chat.push('man', DLG_MAN_EVENTS.m1); }, 800);
  }

  return { onDesktopReady, publish, Clock };
})();

Boot.run(() => Main.onDesktopReady());

/* 暴露给其他模块使用（wayback.js 的 2008 时钟联动） */
window.Clock = Main.Clock;
