/* ============================================================
   desktop.js —— 调查终端
   职责：视图切换 / 时钟 / 插件安装 / 实时通讯 / 资讯浏览器
        / 写稿页面 / 时光机（Internet Archive 三视图）
        / 记事本 + localStorage
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     〇、视频持久缓存（IndexedDB → Blob URL）
     ------------------------------------------------------------
     目的：静默预加载把视频存进 IndexedDB 后，播放直接读本地
           Blob，第二次及以后进游戏是 0 网络请求、0 等待。

     红线：
       1) IndexedDB 不可用（隐私模式 / 老内核 / 被清）→ broken=true，
          所有方法静默退化为「不缓存、播网络地址」，行为与旧版一致。
       2) 只存完整 Blob：预加载被打断时绝不落库（防半截文件）。
       3) 库名 hwu-media-cache 与存档库完全无关，互不影响。
       4) KEY_VER 是内容版本戳：以后重编码视频时改它，
          旧缓存自然失效，不会拿旧画质配新索引。
     ============================================================ */
  const VideoCache = (function () {
    const DB_NAME = 'hwu-media-cache';
    const STORE = 'videos';
    const KEY_VER = 'v20261118';   /* 视频内容版本：重编码后改这里 */
    let dbPromise = null;
    let broken = false;

    function openDb() {
      if (broken) return Promise.resolve(null);
      if (!dbPromise) {
        dbPromise = new Promise(function (resolve) {
          try {
            if (!window.indexedDB) { broken = true; return resolve(null); }
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
              try { req.result.createObjectStore(STORE); } catch (e) {}
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { broken = true; resolve(null); };
            req.onblocked = function () { resolve(null); };
          } catch (e) {
            broken = true;
            resolve(null);
          }
        });
      }
      return dbPromise;
    }

    function keyOf(url) { return url + '|' + KEY_VER; }

    function get(url) {
      return openDb().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve) {
          try {
            const tx = db.transaction(STORE, 'readonly');
            const rq = tx.objectStore(STORE).get(keyOf(url));
            rq.onsuccess = function () {
              resolve(rq.result instanceof Blob ? rq.result : null);
            };
            rq.onerror = function () { resolve(null); };
          } catch (e) { resolve(null); }
        });
      });
    }

    function put(url, blob) {
      return openDb().then(function (db) {
        if (!db) return false;
        return new Promise(function (resolve) {
          try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(blob, keyOf(url));
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { resolve(false); };
            tx.onabort = function () { resolve(false); };
          } catch (e) { resolve(false); }
        });
      });
    }

    function has(url) { return get(url).then(function (b) { return !!b; }); }

    /* 播放入口：命中缓存 → Blob URL；否则原样返回网络地址 */
    function srcFor(url) {
      return get(url).then(function (blob) {
        if (blob) {
          try { return URL.createObjectURL(blob); } catch (e) {}
        }
        return url;
      });
    }

    return { get: get, put: put, has: has, srcFor: srcFor };
  })();

  /* 把 DOM 里「还没升级」的 <video src="assets/video/..."> 换成 Blob 地址。
     只动命中缓存的元素；未命中保持原样（继续走 HTTP 缓存 / 网络）。
     Blob URL 挂在元素私有属性上，元素被移出文档时统一 revoke。 */
  function upgradeVideosIn(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const list = scope.querySelectorAll('video[src^="assets/video/"]');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.dataset.vc) continue;           /* 已处理过，跳过 */
      el.dataset.vc = 'pending';
      const netSrc = el.getAttribute('src') || '';
      VideoCache.srcFor(netSrc).then(function (blobUrl) {
        if (!el.isConnected || el.dataset.vc !== 'pending') return;
        el.dataset.vc = 'done';
        if (blobUrl !== netSrc) {
          el._vcBlobUrl = blobUrl;
          el.src = blobUrl;
        }
      }).catch(function () {
        el.dataset.vc = 'done';
      });
    }

    /* 只挂一次的清扫器：video 离开文档就回收 Blob URL */
    if (!upgradeVideosIn._sweeper && window.MutationObserver) {
      upgradeVideosIn._sweeper = new MutationObserver(function (muts) {
        for (let m = 0; m < muts.length; m++) {
          const gone = muts[m].removedNodes || [];
          for (let j = 0; j < gone.length; j++) {
            const n = gone[j];
            if (n.nodeType !== 1) continue;
            const vids = n.tagName === 'VIDEO' ? [n]
              : (n.querySelectorAll ? n.querySelectorAll('video') : []);
            for (let k = 0; k < vids.length; k++) {
              const v = vids[k];
              if (v._vcBlobUrl) {
                try { URL.revokeObjectURL(v._vcBlobUrl); } catch (e) {}
                v._vcBlobUrl = null;
              }
            }
          }
        }
      });
      upgradeVideosIn._sweeper.observe(document, { childList: true, subtree: true });
    }
  }

  /* ============================================================
     一、视图切换（不刷新页面，仅切换主内容区显示状态）
     ============================================================ */

  /* ============================================================
     一、左侧导航（图标完全由安装状态渲染，HTML 里不再写死）
     ------------------------------------------------------------
     未安装：聊天 / 浏览器 / 邮件 / 资料库   → 4 个
     已安装：再加 写稿 / 时光机             → 6 个
     点击统一用「事件委托」绑在 #rail 上，重渲染后无需重新绑定。
     ============================================================ */

  const rail = document.getElementById('rail');
  const railCenter = document.getElementById('railCenter');

  /* 需要安装 LinkWriter 才可进入的模块 */
  const PLUGIN_TABS = ['write', 'wayback'];

  /* 导航项定义：requiresPlugin 为 true 的只有装完插件才渲染 */
  const RAIL_ITEMS = [
    {
      tab: 'chat', label: '实时通讯',
      icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
    },
    {
      tab: 'browser', label: '资讯浏览器',
      icon: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'
    },
    {
      tab: 'mail', label: '收件箱',
      icon: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
    },
    {
      tab: 'library', label: '资料库',
      icon: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>'
    },
    {
      tab: 'write', label: '写稿页面', requiresPlugin: true,
      icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'
    },
    {
      tab: 'wayback', label: '时光机', requiresPlugin: true,
      icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'
    }
  ];

  /* 当前激活的视图名（用于重渲染后恢复高亮） */
  function activeViewName() {
    const v = document.querySelector('.view.active');
    return v ? v.id.replace(/^view-/, '') : 'chat';
  }

  /* 按 localStorage 的真实状态重建左侧图标 */
  function renderSidebar() {
    if (!railCenter) return;

    const installed = isPluginInstalled();
    const current = activeViewName();

    railCenter.innerHTML = '';

    RAIL_ITEMS.forEach(item => {
      if (item.requiresPlugin && !installed) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-btn';
      btn.dataset.tab = item.tab;
      btn.title = item.label;
      btn.setAttribute('aria-label', item.label);
      if (item.requiresPlugin) btn.dataset.requiresPlugin = 'true';
      btn.innerHTML = '<svg viewBox="0 0 24 24">' + item.icon + '</svg>';
      if (item.tab === current) btn.classList.add('active');

      railCenter.appendChild(btn);
    });

    /* 图标是刚重建的，未读红点得重新贴一次 */
    syncRailUnread();
  }

  function switchTab(name, el) {
    /* 切页前先核对存档：DevTools 里清过档就整块回到初始态（清档不触发任何事件，
       只能在下一次交互时兜底） */
    ensureStorageSynced();

    /* 崩坏态是全局的：不管切到聊天、写稿还是资料库，红化与慢放都得锁死。
       放在核对存档之后 —— 清过档的话这一步才读得到「已经被清掉」的状态。 */
    syncGlitchTheme();

    /* 未安装时写稿 / 时光机一律进不去，并把导航刷回真实状态 */
    if (PLUGIN_TABS.indexOf(name) >= 0 && !isPluginInstalled()) {
      renderSidebar();
      return;
    }

    const btns = railCenter ? railCenter.querySelectorAll('.rail-btn') : [];
    btns.forEach(btn => {
      btn.classList.toggle('active', el ? btn === el : btn.dataset.tab === name);
    });
    document.querySelectorAll('.view').forEach(v => {
      v.classList.toggle('active', v.id === 'view-' + name);
    });
    if (name === 'write') renderWrite();
    if (name === 'mail') renderMail();
    if (name === 'library') renderLibrary();
    if (name === 'browser') maybeShowTranslateTip();
    if (name === 'chat') resumeChat();

    /* 音乐跟随当前视图：
       进浏览器顺便用这次真实点击解锁第一次播放；
       离开网页（聊天 / 写稿 / 资料库）就把慢放恢复正常。
       崩坏期这个「恢复」会被 syncBgmMood 里的存档判断截住，恒为慢放。 */
    if (name === 'browser') {
      startBgmOnce();
      syncBgmMood(currentPageId);
    } else if (name === 'wayback') {
      syncBgmMood(currentSnapshotPageId);
    } else {
      syncBgmMood('');
    }
  }

  /* 事件委托：图标重渲染多少次都不用重新绑定 */
  if (rail) {
    rail.addEventListener('click', e => {
      const btn = e.target.closest('.rail-btn');
      if (!btn || !railCenter || !railCenter.contains(btn)) return;
      switchTab(btn.dataset.tab, btn);
    });
  }

  /* ---------- 首次进入资讯浏览器：LinkWriter 自动翻译提示 ---------- */

  const TRANSLATE_TIP_KEY = 'hasShownTranslateTip';
  const translateTip = document.getElementById('translateTip');
  const translateTipOk = document.getElementById('translateTipOk');

  function isTranslateTipShown() {
    try { return localStorage.getItem(TRANSLATE_TIP_KEY) === 'true'; } catch (e) { return false; }
  }

  function markTranslateTipShown() {
    try { localStorage.setItem(TRANSLATE_TIP_KEY, 'true'); } catch (e) {}
  }

  let translateTipTimer = 0;

  function hideTranslateTip() {
    if (!translateTip || translateTip.classList.contains('hidden')) return;
    if (translateTipTimer) {
      clearTimeout(translateTipTimer);
      translateTipTimer = 0;
    }
    /* 先跑 0.3s 透明度渐变，动画结束再真正隐藏 */
    translateTip.classList.add('tt-out');
    setTimeout(() => {
      translateTip.classList.add('hidden');
      translateTip.classList.remove('tt-out');
    }, 320);
  }

  function maybeShowTranslateTip() {
    if (!translateTip || isTranslateTipShown()) return;
    markTranslateTipShown();
    translateTip.classList.remove('hidden');
    /* 5 秒内没有点「知道了」也自动淡出 */
    translateTipTimer = setTimeout(hideTranslateTip, 5000);
  }

  if (translateTipOk) {
    translateTipOk.addEventListener('click', () => {
      markTranslateTipShown();
      hideTranslateTip();
    });
  }

  /* 导航的点击已在上面用委托绑定到 #rail，这里无需逐项绑定。 */

  /* ============================================================
     二、弹窗（稿件通过 / 系统提示）
     结局不走这里，走第十节末尾的全屏黑场演出。
     ============================================================ */

  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalText = document.getElementById('modalText');

  function showModal(title, text) {
    modalTitle.textContent = title;
    modalText.textContent = text;
    modal.classList.remove('hidden');
  }
  document.getElementById('modalClose').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  function toast(text) {
    showModal('提示', text);
  }

  /* ============================================================
     三、背景音乐（BGM）播放器
     ------------------------------------------------------------
     按钮在 index.html 的 #bgmDock（body 直属，主视窗外的左下角），
     <audio> 在这里动态创建，避免 HTML 与 JS 各存一份状态。

       单击 → 播放 / 暂停
       双击 → 切到下一首，并继续播放
       一首播完 → 自动切下一首（bgm1 → bgm2 → bgm3 → bgm1，不再单曲重放）
       单击 / 双击靠 250ms 防抖区分：单击先挂起，250ms 内来了第二下就取消。

     进入「特殊网页」时慢放（0.25 倍速 + 音量 0.3），离开恢复 1.0 / 0.5。
     音频文件暂缺时 onerror 只打一条 warn，绝不打断游戏流程。
     ============================================================ */

  const bgmDock = document.getElementById('bgmDock');
  const bgmToggle = document.getElementById('bgmToggle');

  /* 三个曲目：assets/audio/ 下的真实文件，由双击轮换 */
  const BGM_TRACKS = [
    'assets/audio/bgm1.mp3',
    'assets/audio/bgm2.mp3',
    'assets/audio/bgm3.mp3'
  ];

  const BGM_VOLUME = 0.5;         /* 普通页面 */
  const BGM_VOLUME_CREEPY = 0.3;  /* 特殊页面：压低，留出环境音的空隙 */
  const BGM_RATE = 1.0;
  const BGM_RATE_CREEPY = 0.25;   /* 降速变慢 → 诡异感（0.25 倍 ≈ 磁带快没电） */
  const BGM_CLICK_DELAY = 250;    /* 单击 / 双击判定窗口 */

  /* 音量渐变：每 50ms 走一小步，步数 = 时长 ÷ 50，步长 = 总差值 ÷ 步数。
     默认 500ms 走完，具体时长由调用方给：起播渐入 1s，曲尾渐出 3s。
     这是一条「线性斜坡」，不追求等响度曲线，只求听感上不再「啪」地一下变响或变没。 */
  const BGM_FADE_TICK = 50;       /* 一拍 50ms */
  const BGM_FADE_MS = 500;        /* fadeToVolume 的默认时长 */
  const BGM_FADE_IN_MS = 1000;    /* 起播 / 循环接力的渐入 */
  const BGM_LOOP_FADE_MS = 3000;  /* 曲尾渐出：最后 3 秒把音量收到 0 */

  /* 需要慢放的「特殊网页」ID（暗网档案） */
  const creepyPages = [
    'darknet-file'
  ];

  /* 时光机快照的 pageId 与页面 ID 之间的别名表。
     2005 / 2010 两份粉丝站已随页面一起删除，目前没有需要归一的名字；
     保留空表，以后再加别名时不必改动下面的查表逻辑。 */
  const BGM_PAGE_ALIAS = {};

  let bgmIndex = 0;           /* 当前曲目下标 */
  let bgmEverPlayed = false;  /* 真的出过声：之后不再自动抢播放 */
  let bgmUserPaused = false;  /* 玩家主动暂停：切页也不该自己响起来 */
  let bgmCreepy = false;      /* 当前是否处于慢放状态 */
  let bgmClickTimer = 0;
  let bgmClickCount = 0;
  const bgmWarned = {};       /* 同一个 src 只警告一次，免得刷屏 */

  /* ============================================================
     系统崩坏（Glitch）—— 持久状态
     ------------------------------------------------------------
     特里博 / Trebor 一旦被搜到，整套 UI 就此「坏掉」：
     桌面变黑、导航血红、BGM 降速变轻、浏览器里的网页全部翻成负片。
     这个状态要能扛过刷新、扛过切页、扛过之后的每一次普通搜索 ——
     所以它不能只挂在 body 的类上（刷新就没了），必须落进 localStorage。

       GLITCH_KEY   唯一的存档键。'true' = 崩坏中。
       出口只有两个：第三篇稿件交出去、或者从结局里点「重新撰稿」。
       两处都走 setSystemGlitch(false)，此外没有任何地方能把它关掉。

     localStorage 在某些隐私模式下会抛异常，读写一律 try/catch：
     存不进去顶多是「刷新后复位」，不该让整局游戏卡在报错里。
     ============================================================ */
  const GLITCH_KEY = 'hwu.systemGlitchActive';

  function isSystemGlitch() {
    try { return localStorage.getItem(GLITCH_KEY) === 'true'; } catch (e) { return false; }
  }

  /* 开 / 关：只负责写存档，画面与声音全部交给 syncGlitchTheme() */
  function setSystemGlitch(on) {
    try {
      if (on) localStorage.setItem(GLITCH_KEY, 'true');
      else localStorage.removeItem(GLITCH_KEY);
    } catch (e) {}
    syncGlitchTheme();
  }

  /* 把「存档里的崩坏态」翻译成「此刻的界面与声音」。
     凡是需要确认外表的地方（init / switchTab / renderPage / runSearch）
     都在开头调它一次，于是不管从哪条路进来，红化与慢放都不会掉。 */
  function syncGlitchTheme() {
    const isGlitch = isSystemGlitch();
    document.body.classList.toggle('theme-search-dark', isGlitch);
    /* BGM 交给 syncBgmMood：它内部也认同一个存档，
       崩坏期直接锁死在慢放上，切页救不回来。 */
    syncBgmMood(isGlitch ? 'darknet-file' : '');
  }

  /* 全局唯一的淡入淡出定时器。
     整个播放器同一时刻只允许一条音量曲线在跑：
     任何一次淡入、切歌、切页、暂停都会先把它掐掉再重新开始，
     否则两条 setInterval 会互相覆盖 volume，音量就会来回抽搐。 */
  let bgmFadeTimer = null;

  /* 曲尾轮换的两件小状态：
       isFadingOutForLoop  这一首已经开过渐出了，别在每一拍 timeupdate 上重复开
       bgmSwitchTimer       ended 之后延迟切下一首的那个定时器，人为干预时要能掐掉 */
  let isFadingOutForLoop = false;
  let bgmSwitchTimer = 0;

  /* 取 index.html 里那颗 <audio id="bgm-player">；
     万一模板被改坏了，就地补一个，保证播放器不会整个哑掉。 */
  function getBgmElement() {
    let el = document.getElementById('bgm-player');
    if (!el) {
      el = document.createElement('audio');
      el.id = 'bgm-player';
      document.body.appendChild(el);
    }
    return el;
  }

  /* 默认 0.5 音量；循环交给 JS 自己管（原生 loop 会在最后一个采样点硬切回开头） */
  const bgm = getBgmElement();
  bgm.loop = false;
  bgm.preload = 'auto';
  bgm.volume = BGM_VOLUME;
  bgm.src = BGM_TRACKS[bgmIndex];

  /* ---------- 音频缺失 / 解码失败 / 自动播放被拦：只警告 ---------- */
  function bgmWarn(reason) {
    const src = bgm.getAttribute('src') || '(空)';
    if (bgmWarned[src]) return;
    bgmWarned[src] = true;
    console.warn('[BGM] ' + reason + '：' + src + '（不影响游戏，继续调查即可）');
  }

  bgm.addEventListener('error', () => {
    bgmWarn('音频文件缺失或无法解码，已跳过这一首');
    syncBgmButton();
  });

  /* 元数据就绪后补一次速率：个别浏览器在换源时会把 playbackRate 打回默认。
     这里只补速率不走 applyBgmParams —— 那会把正在进行中的 1 秒渐入截断。 */
  bgm.addEventListener('loadedmetadata', applyBgmRate);

  bgm.addEventListener('playing', () => {
    bgmEverPlayed = true;
    syncBgmButton();
  });

  /* 暂停（不管是玩家点按钮还是视频抢占）都要顺手收掉淡入曲线：
     否则音乐已经停了，定时器还在把 volume 往上抬，下次恢复会从半路冒出来。 */
  bgm.addEventListener('pause', () => {
    clearBgmFade();
    syncBgmButton();
  });

  /* ---------- 按钮状态（播放中 → 呼吸；暂停 → 静止） ---------- */
  function syncBgmButton() {
    if (!bgmToggle) return;
    const playing = !bgm.paused && !bgm.ended;
    bgmToggle.classList.toggle('is-playing', playing);
    bgmToggle.setAttribute('aria-label', playing ? '背景音乐：暂停' : '背景音乐：播放');
    bgmToggle.title = (playing ? '单击暂停' : '单击播放') + ' · 双击切换曲目';
  }

  /* ---------- 音量淡入淡出 ----------
     两个小工具：
       bgmTargetVol()      当前页面「应该」是多少音量（普通 0.5 / 诡异 0.3）
       fadeToVolume(vol)   从当前实际音量平滑爬到 vol

     所有改音量的地方都走这两个函数，绝不再直接写 bgm.volume = xx，
     这样切页、切歌、从暂停里恢复都不会出现音量跳变。 */

  /* 目标音量只看 bgmCreepy，不另存一份状态，免得两处失去同步 */
  function bgmTargetVol() {
    return bgmCreepy ? BGM_VOLUME_CREEPY : BGM_VOLUME;
  }

  /* 收掉还在跑的淡入曲线（不会改当前音量，只停手） */
  function clearBgmFade() {
    if (bgmFadeTimer !== null) {
      window.clearInterval(bgmFadeTimer);
      bgmFadeTimer = null;
    }
  }

  /* 从当前音量平滑爬到 targetVolume，整段耗时 durationMs（默认 500ms）。
     步数由时长算：steps = round(durationMs / 50)，步长 = 总差值 ÷ 步数 ——
     于是 1s 的渐入和 3s 的渐出用的是同一条线性曲线，只是步子疏密不同。
     每次进来先清掉上一条曲线，保证任何时候只有一个定时器在改 bgm.volume。 */
  function fadeToVolume(targetVolume, durationMs = BGM_FADE_MS) {
    clearBgmFade();

    /* 夹到 0~1：volume 超范围在部分浏览器会直接抛 IndexSizeError */
    let target = Number(targetVolume);
    if (!isFinite(target)) target = BGM_VOLUME;
    target = Math.max(0, Math.min(1, target));

    /* 起点就贴着目标，没必要开表，直接对齐（避免残留 0.4999 这种尾巴） */
    if (Math.abs(bgm.volume - target) < 0.005) {
      bgm.volume = target;
      return;
    }

    /* 时长兜底：至少走一拍，避免传 0 / NaN 时步数发散 */
    let dur = Number(durationMs);
    if (!isFinite(dur) || dur < BGM_FADE_TICK) dur = BGM_FADE_TICK;

    let steps = Math.max(1, Math.round(dur / BGM_FADE_TICK));
    const stepDelta = (target - bgm.volume) / steps;

    bgmFadeTimer = window.setInterval(() => {
      steps -= 1;

      /* 最后一拍直接对齐目标；途中按固定步长推进，不拿 bgm.volume 重算，
         免得外部（换源 / 暂停）动过音量之后曲线突然变形。 */
      let next;
      if (steps <= 0) {
        next = target;
      } else {
        next = bgm.volume + stepDelta;
        /* 浮点累加会差一点点，夹一下，别越界也别永远差 0.0001 */
        next = stepDelta > 0 ? Math.min(next, target) : Math.max(next, target);
      }

      try {
        bgm.volume = next;
      } catch (e) {
        /* 极少数浏览器在元数据就绪前不让改，这一拍跳过，下一拍再试 */
        return;
      }

      /* 到站：补一次精确值后立刻收表，定时器句柄归 null */
      if (steps <= 0) {
        try { bgm.volume = target; } catch (e) {}
        clearBgmFade();
      }
    }, BGM_FADE_TICK);
  }

  /* ---------- 慢放参数 ---------- */
  function applyBgmParams() {
    const rate = bgmCreepy ? BGM_RATE_CREEPY : BGM_RATE;
    const vol = bgmTargetVol();
    try {
      bgm.defaultPlaybackRate = rate;   /* 换源 / 重新加载后仍保持这个速率 */
      bgm.playbackRate = rate;

      /* 暂停（或还没出过声）时没有听感可过渡，直接给值最快；
         正在播就交给淡入淡出，切页时音量是「滑」过去而不是「跳」过去。 */
      if (bgm.paused || bgm.ended) {
        clearBgmFade();                 /* 暂停态不需要过渡，顺手收掉残留定时器 */
        bgm.volume = vol;
      } else {
        fadeToVolume(vol);
      }
    } catch (e) {
      /* 个别浏览器在元数据就绪前不让改，下一次渲染会再设一遍 */
    }
  }

  /* 只补播放速率，不碰音量。
     换源（切下一首）时有些浏览器会把 playbackRate 打回默认，需要在
     loadedmetadata 之后补一次；但那一刻正赶上 bgmPlay 的 1 秒渐入，
     要是顺手再 fadeToVolume 一次，就会把 1 秒的渐入截成半截。
     所以元数据就绪只走这个轻量函数，音量仍旧交给 bgmPlay 的曲线。 */
  function applyBgmRate() {
    const rate = bgmCreepy ? BGM_RATE_CREEPY : BGM_RATE;
    try {
      bgm.defaultPlaybackRate = rate;
      bgm.playbackRate = rate;
    } catch (e) {}
  }

  /* 网页切换时调用：传 pageId，特殊页慢放，其余恢复。
     崩坏态优先于一切：存档里写着崩坏，就永远停在 0.25 倍 / 0.3 音量，
     玩家切到聊天、写稿、资料库都救不回来 —— 这是「坏了」的一部分。 */
  function syncBgmMood(pageId) {
    const key = BGM_PAGE_ALIAS[pageId] || pageId;

    if (isSystemGlitch()) {
      bgmCreepy = true;
      applyBgmParams();
      if (bgmDock) bgmDock.classList.add('is-creepy');
      return;
    }

    bgmCreepy = creepyPages.indexOf(key) >= 0;
    applyBgmParams();
    if (bgmDock) bgmDock.classList.toggle('is-creepy', bgmCreepy);
  }

  /* ---------- 播放 / 暂停 / 换曲 ---------- */
  function bgmPlay() {
    /* 起播即视为「人为干预」：曲尾渐出的标记与换曲定时器一律作废，
       否则上一首的收尾逻辑会把这一首也当成「正在渐出」，永远不淡入。 */
    isFadingOutForLoop = false;
    if (bgmSwitchTimer) {
      window.clearTimeout(bgmSwitchTimer);
      bgmSwitchTimer = 0;
    }

    /* 每次起播先把上一条音量曲线掐死，防止上一首的淡入还在往 volume 里写 */
    clearBgmFade();

    let p = null;
    try {
      p = bgm.play();
    } catch (err) {
      bgmWarn('播放被浏览器拒绝');
      return;
    }

    /* 起播瞬间先把音量归零：即使浏览器立刻出声，也是从「听不见」开始，
       再由下面的曲线一格格推上去，不会先炸一下满音量。 */
    try { bgm.volume = 0; } catch (e) {}

    /* play() 真落地（开始出声）之后再淡入。
       直接同步淡入的话，文件还在缓冲时曲线已经跑完，一出声就是满音量，反而更硬。 */
    if (p && typeof p.then === 'function') {
      p.then(() => {
        fadeToVolume(bgmTargetVol(), BGM_FADE_IN_MS);
      }).catch(err => {
        /* NotAllowedError = 浏览器拦了自动播放；其余多为文件缺失 / 格式不支持 */
        const name = err && err.name ? err.name : '';
        bgmWarn(name === 'NotAllowedError'
          ? '自动播放被浏览器拦截，点一下左下角的音符即可'
          : '这一首暂时播不了，点一下按钮可换下一首');
        /* 没播成：把音量还原到目标值，下次真正播起来不至于卡在 0 */
        try { bgm.volume = bgmTargetVol(); } catch (e) {}
        syncBgmButton();
      });
    } else {
      /* 老浏览器 play() 不返回 Promise：退化成同步淡入 */
      fadeToVolume(bgmTargetVol(), BGM_FADE_IN_MS);
    }

    syncBgmButton();
  }

  /* 第一次播放：只在「装完插件」「点左侧导航进浏览器」这两个真实点击后触发。
     出过声就不再抢播放，玩家自己按的暂停优先。 */
  function startBgmOnce() {
    if (bgmEverPlayed || bgmUserPaused) return;
    bgmPlay();
  }

  /* ---------- 崩坏搜索命中的那一下：把音乐「叫醒」 ----------
     哪怕玩家刚刚亲手按下了暂停。两件事同时成立才动手：

       · 调用点是 runSearch 里、由玩家按回车或点搜索按钮同步触发的那一段。
         浏览器只认「用户手势里发起」的 play()：错了这一拍，后面切页、
         刷新再想强制起播，只会换来一条 NotAllowedError 警告。
         所以这段逻辑不能塞进 syncGlitchTheme() —— 那里在 init（刷新）、
         切页、渲染网页时都会被调用，既借不到手势，又会反复顶掉玩家的暂停。

       · 当前的 BGM 确实是暂停的。本来就在响的话，交给 applyBgmParams
         把速率与音量平滑滑过去就好（0.5 → 0.3、1.0× → 0.25×），
         再 play 一次只会打断那段过渡。

     强制起播仍旧走 bgmPlay()：它内部先把 volume 归零，等 play() 真正落地
     再用 fadeToVolume(目标, 1s) 一格格推上去 —— 听到的是「从无声慢慢浮上来」，
     不会在玩家耳朵里啪一下炸开。此刻 bgmCreepy 已被 syncBgmMood 置真，
     目标音量 0.3、速率 0.25，浮上来的就是那段沉闷的慢放。 */
  function forceBgmOnGlitch() {
    /* 「玩家关过音乐」这件事，在这一下被机器夺走了 —— 崩坏本来就不是讲道理的状态 */
    bgmUserPaused = false;
    if (!bgm.paused) return;
    bgmPlay();
  }

  function bgmTogglePlay() {
    /* 人为干预：先作废曲尾渐出状态和换曲定时器，
       否则暂停后再恢复，会带着上一遍的「已在渐出」标记一路播到硬切；
       再收掉淡入曲线，否则刚按下暂停，曲线还在把音量往上推。 */
    isFadingOutForLoop = false;
    if (bgmSwitchTimer) {
      window.clearTimeout(bgmSwitchTimer);
      bgmSwitchTimer = 0;
    }
    clearBgmFade();

    if (bgm.paused) {
      bgmUserPaused = false;
      bgmPlay();                 /* 里面会从 0 重新淡入 */
    } else {
      bgm.pause();
      bgmUserPaused = true;
    }
  }

  function bgmNextTrack() {
    /* 换曲同样算人为干预：不清标记的话，新歌若在开头就被 timeupdate
       判成「正在渐出」，音量会一路躺平；不清定时器则会凭空多起一次播。 */
    isFadingOutForLoop = false;
    if (bgmSwitchTimer) {
      window.clearTimeout(bgmSwitchTimer);
      bgmSwitchTimer = 0;
    }

    /* 换曲前先清掉上一首的淡入 / 渐出曲线，杜绝两条定时器抢同一个 volume */
    clearBgmFade();

    /* 三首顺次轮换：bgm1 → bgm2 → bgm3 → bgm1（列表本身不循环，靠取模兜回来） */
    bgmIndex = (bgmIndex + 1) % BGM_TRACKS.length;
    bgm.src = BGM_TRACKS[bgmIndex];

    /* 换源会把速率先打回默认，这里补一次；
       音量必须先归零再 play —— 否则新曲第一拍就会以默认音量炸出来，
       等 fadeToVolume 接手时已经晚了。 */
    try {
      const rate = bgmCreepy ? BGM_RATE_CREEPY : BGM_RATE;
      bgm.defaultPlaybackRate = rate;
      bgm.playbackRate = rate;
      bgm.volume = 0;            /* 新曲从无声起，交给 bgmPlay 淡入 */
    } catch (e) {}

    bgmUserPaused = false;
    bgmPlay();                   /* 内部 play() 落地后再 fadeToVolume(目标, 1s) 渐入 */
  }

  /* ---------- 曲尾渐出 → 切下一首（替代原生 loop） ----------
     原生 loop 会在最后一个采样点直接跳回 0 秒，听感上就是「啪」一下。
     现在把 loop 关掉、单曲也不再重放，改由我们收尾并换曲：
       timeupdate  剩 3 秒时开始把音量线性压到 0
       ended       换源到下一首，交给 bgmPlay 从 0 淡入 1 秒
     两首接起来就是「渐出 → 静音 → 下一首渐入」，接缝处本来就没有声音，谈不上接缝。 */

  bgm.addEventListener('timeupdate', () => {
    /* 已经在渐出 / 已暂停 / 已结束：什么都不做，避免每一拍都重开一条曲线 */
    if (isFadingOutForLoop || bgm.paused || bgm.ended) return;

    const total = bgm.duration;
    if (!isFinite(total) || total <= 0) return;   /* 元数据还没到，duration 是 NaN */

    /* 剩最后 3 秒才动手；跳到差不多结尾再按播放，也能立刻接上 */
    const timeLeft = total - bgm.currentTime;
    if (timeLeft <= 0 || timeLeft > BGM_LOOP_FADE_MS / 1000) return;

    isFadingOutForLoop = true;

    /* 渐出时长按播放速率折算：慢放 0.25 倍时，这 3 秒素材实际要放 12 秒，
       曲线跟着拉长，才会正好在曲尾收到 0，而不是提前一段就哑了。 */
    const rate = bgm.playbackRate > 0 ? bgm.playbackRate : 1;
    fadeToVolume(0, Math.round(BGM_LOOP_FADE_MS / rate));
  });

  bgm.addEventListener('ended', () => {
    /* 一首自然播完：不再「回到 0 秒重放」，而是顺次切到下一首。
       渐出已经在上面的 timeupdate 里把音量压到 0，换源等于从静音接上，
       再交给 bgmPlay 从 0 淡入 1 秒 —— 两首之间既没有硬切，也没有多余的静默。 */
    isFadingOutForLoop = false;
    clearBgmFade();

    /* 少数浏览器在 ended 之后还会补发一个 pause，那个监听里会 clearBgmFade()，
       把刚起头的淡入掐掉、音量卡死在 0。隔一拍再切歌，等收尾事件全部派发完；
       此刻音量本来就是 0，这点静默听不出来。 */
    if (bgmSwitchTimer) window.clearTimeout(bgmSwitchTimer);
    bgmSwitchTimer = window.setTimeout(() => {
      bgmSwitchTimer = 0;
      bgmNextTrack();
    }, 60);
  });

  /* ---------- 单击 / 双击（250ms 防抖，仅鼠标） ----------
     触屏没有「双击」：两下点击的间隔通常 >250ms，切歌永远触发不了，
     而 250ms 的挂起又让人以为「按了没反应」。所以触屏走另一套：
       轻点           → 立刻播放 / 暂停
       长按 600ms     → 切下一首
     鼠标（hover: hover）仍走原来的单击 / 双击防抖，行为完全不变。 */
  if (bgmToggle) {
    const bgmTouchUI = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

    if (bgmTouchUI) {
      let bgmPressTimer = 0;
      let bgmLongPressed = false;

      const cancelBgmPress = () => {
        if (!bgmPressTimer) return;
        window.clearTimeout(bgmPressTimer);
        bgmPressTimer = 0;
      };

      bgmToggle.addEventListener('touchstart', () => {
        bgmLongPressed = false;
        cancelBgmPress();
        bgmPressTimer = window.setTimeout(() => {
          bgmPressTimer = 0;
          bgmLongPressed = true;          /* 这次抬手别再触发播放 / 暂停 */
          bgmNextTrack();
        }, 600);
      }, { passive: true });

      ['touchend', 'touchcancel'].forEach(evt => {
        bgmToggle.addEventListener(evt, cancelBgmPress, { passive: true });
      });

      bgmToggle.addEventListener('click', () => {
        if (bgmLongPressed) {
          bgmLongPressed = false;
          return;
        }
        bgmTogglePlay();
      });
    } else {
      bgmToggle.addEventListener('click', () => {
        bgmClickCount += 1;

        /* 第一下：先等 250ms，确认不是双击再执行播放 / 暂停 */
        if (bgmClickCount === 1) {
          bgmClickTimer = window.setTimeout(() => {
            bgmClickTimer = 0;
            bgmClickCount = 0;
            bgmTogglePlay();
          }, BGM_CLICK_DELAY);
          return;
        }

        /* 第二下落在窗口内：取消挂起的单击，只做「切歌」 */
        window.clearTimeout(bgmClickTimer);
        bgmClickTimer = 0;
        bgmClickCount = 0;
        bgmNextTrack();
      });
    }
  }

  /* ---------- 手机端：贴左边缘的「半露」收纳 ----------
     手机竖屏 / 横屏时，按钮常态只露出左边缘的一半（样式在
     @media (max-width: 768px) 里，PC 完全不受影响）。
     碰一下父容器 #bgmDock 就把 .is-expanded 打上，按钮滑出来；
     3 秒内没有新的触碰就自动缩回去。

     展开动作绑在【父容器】上，不碰按钮自身的 click：
     #bgmToggle 上那套「单击播放 / 暂停、双击切歌」的 250ms 防抖
     原样保留 —— 点一下既滑出来、又照常播放，两者互不干扰。 */
  const BGM_DOCK_AUTO_COLLAPSE = 3000;
  let bgmDockHideTimer = 0;

  function expandBgmDock() {
    if (!bgmDock) return;
    bgmDock.classList.add('is-expanded');
    if (bgmDockHideTimer) window.clearTimeout(bgmDockHideTimer);
    bgmDockHideTimer = window.setTimeout(() => {
      bgmDockHideTimer = 0;
      bgmDock.classList.remove('is-expanded');
    }, BGM_DOCK_AUTO_COLLAPSE);
  }

  function collapseBgmDock() {
    if (!bgmDock) return;
    if (bgmDockHideTimer) {
      window.clearTimeout(bgmDockHideTimer);
      bgmDockHideTimer = 0;
    }
    bgmDock.classList.remove('is-expanded');
  }

  if (bgmDock) {
    /* touchstart 让「按下就滑出」，click 兜住鼠标与部分老浏览器；
       两个都只是加一个 class，重复触发没有副作用 */
    ['touchstart', 'click'].forEach(evt => {
      bgmDock.addEventListener(evt, expandBgmDock, { passive: true });
    });

    /* 点了别处就当作「不再操作」，立刻收回，不必等满 3 秒。
       捕获阶段先跑，只判目标在不在 dock 里，不拦任何事件。 */
    document.addEventListener('pointerdown', e => {
      if (!bgmDock.classList.contains('is-expanded')) return;
      if (bgmDock.contains(e.target)) return;
      collapseBgmDock();
    }, true);
  }

  /* 初始态：普通速率 / 音量，按钮显示「暂停」以外的状态 */
  applyBgmParams();
  syncBgmButton();

  /* ---------- 与视频互斥：视频一开播，BGM 让位 ----------
     <video> 是动态插进来的（邮件附件里的录像 1 / 录像 2，以后再加也一样），
     所以监听挂在 document 的捕获阶段：元素什么时候插进来都躲不过，
     也不用给每个播放器单独绑一次。

     视频暂停 / 播完都【不】自动恢复 BGM：
     真暂停时会把 bgmUserPaused 置 true，于是 startBgmOnce()、切页、
     重进浏览器都不会偷偷把音乐放回来 —— 只能玩家自己点左下角音符。 */
  document.addEventListener('play', e => {
    const el = e.target;
    if (!el || el.tagName !== 'VIDEO') return;
    if (el === bgm) return;                 /* 保险：别把自己算进去 */

    if (!bgm.paused) {
      bgm.pause();
      bgmUserPaused = true;                 /* 手动接管：之后不自动续播 */
      syncBgmButton();                      /* 左下角图标切回「已暂停」 */
    }
  }, true);

  /* ============================================================
     四、状态持久化（localStorage）
     ============================================================ */

  const CLIP_KEY = 'hwu.clipSolved.v1';
  const PLUGIN_KEY = 'pluginInstalled';       /* LinkWriter 安装状态，默认 false */

  function isClipSolved() {
    try { return localStorage.getItem(CLIP_KEY) === '1'; } catch (e) { return false; }
  }
  function setClipSolved() {
    try { localStorage.setItem(CLIP_KEY, '1'); } catch (e) {}
  }

  /* 玩家是否已经看过那份「警方机密档案」（在浏览器里搜到了 K 的真名）。
     这是第二层唯一的门：只有它能把写稿器的第九个词【真正的恶魔】点亮。 */
  const SECRET_KEY = 'secretUnlocked';

  function isSecretUnlocked() {
    try { return localStorage.getItem(SECRET_KEY) === 'true'; } catch (e) { return false; }
  }
  function setSecretUnlocked() {
    try { localStorage.setItem(SECRET_KEY, 'true'); } catch (e) {}
  }

  function isPluginInstalled() {
    try { return localStorage.getItem(PLUGIN_KEY) === 'true'; } catch (e) { return false; }
  }
  function setPluginInstalled() {
    try { localStorage.setItem(PLUGIN_KEY, 'true'); } catch (e) {}
  }

  /* 把安装状态同步到界面：body 主题类 + 顶栏徽标 */
  function applyPluginState() {
    const on = isPluginInstalled();
    document.body.classList.toggle('plugin-on', on);
    const badge = document.getElementById('pluginBadge');
    if (badge) badge.classList.toggle('hidden', !on);
  }

  /* ============================================================
     五、实时通讯模块
     ------------------------------------------------------------
     联系人全部由 CONTACTS 数组渲染，每一行单独绑定 click（外加
     keydown 回车），不依赖静态 DOM、不依赖事件委托。
     行内子元素统一 pointer-events:none（见 desktop.css），
     点击命中永远落在 .contact 上，不存在被遮挡或吞掉的路径。
     ============================================================ */

  /* 联系人列表（老板 + 同事小李，两个都在开场就常驻）
     time / preview 只是「还没聊过时的占位」：一旦有消息，侧栏摘要
     会按真实进度替换（见 contactPreview），不会剧透后面的台词。 */
  const CONTACTS = [
    {
      id: 'boss',
      name: '老板',
      initial: '老',
      /* 真人头像：有图就优先用图，initial 只在图片没加载出来时兜底。
         路径相对 index.html，和网页里那些 assets/image/... 一致。 */
      avatarSrc: 'assets/image/avatars/boss.jpg',
      time: '09:41',
      preview: '三篇稿件，今天下班前交上来。没问题吧？'
    },
    {
      id: 'colleague',
      name: '同事小李',
      initial: '李',
      avatarSrc: 'assets/image/avatars/colleague.jpg',
      time: '',
      preview: ''
    },
    {
      /* 第三个联系人：通关过任意一个普通结局、并且真的走出黑屏之后才存在。
         名字、头像、摘要全是问号 —— 在玩家点进来之前，只留下「有这么个人」。
         故意不给 avatarSrc：他要的不是照片，是一块纯黑的圆（见 CSS 里的
         .contact[data-contact="shadow"] .avatar，文字被透明掉）。 */
      id: 'shadow',
      name: '？？？',
      initial: '？',
      time: '',
      preview: ''
    }
  ];

  /* ---------- 对话剧本 ----------------------------------------------------
     联系人不再是一次性吐完的字符串数组，而是一条线性步骤表：

       sender: 'boss' | 'colleague'  → NPC 自动发言，每条间隔 CHAT_LINE_GAP
       sender: 'player'              → 流程暂停，底部弹「发送：…」，点一下才继续
       kind:   'install'             → 渲染成蓝色可点链接，蓝屏走完才继续

     剧本一旦接进队列就写进 localStorage，刷新 / 换页都不会重播。
     ==================================================================== */

  const CHAT_LINE_GAP = 1800;    /* NPC 两条之间的间隔 */
  const CHAT_AFTER_SEND = 800;   /* 玩家发完后，NPC 开口前的停顿 */

  const CHAT_SCRIPTS = {
    boss: {
      /* 开场：三句交代任务，玩家回两句 */
      intro: [
        { sender: 'boss', text: '没记错的话，你来公司实习已经五个月了吧。' },
        { sender: 'boss', text: '五个月，人力成本也是成本。公司对你的工作能力还算认可，决定提前给你一个转正考核的机会。' },
        { sender: 'boss', text: '三篇稿件，今天下班前交上来。没问题吧？' },
        { sender: 'player', text: '收到。' },
        { sender: 'player', text: '（一天三篇也太多了……幸好我已经写好了草稿，去写稿器看看吧）' }
      ],

      /* 稿件 1 交掉 */
      draft1: [
        { sender: 'boss', text: '娱乐八卦？当红小花跟乐坛王子，噱头够足，现在的人就爱吃这一套。' },
        { sender: 'boss', text: '继续保持，公司要的就是这种能抓眼球的东西。' },
        { sender: 'player', text: '好的' }
      ],

      /* 稿件 2 交掉 */
      draft2: [
        { sender: 'boss', text: '游戏圈……不，商业板块？题材流量一般，数据不会太好看。' },
        { sender: 'boss', text: '不过写得还算扎实，至少没浪费公司给你的版面。' },
        { sender: 'boss', text: '最后一篇，我要看到爆款潜力，别浪费公司对你的栽培' },
        { sender: 'player', text: '我知道了' }
      ],

      /* 第 3 篇不再排老板的台词：稿子一交出去就直接进黑场演出，
         结局只存在于 #ending-overlay 里，聊天记录不再承载结局。 */
    },

    /* 小李：老板讲完才来搭话，装完插件玩家道谢 */
    colleague: {
      intro: [
        { sender: 'colleague', text: '公司最近研发了一个智能插件，据说写稿特别方便。' },
        { sender: 'colleague', text: '我托研发部的朋友搞来了内测版，你试试看。' },
        { sender: 'colleague', text: '【点击安装：LinkWriter v1.0】', kind: 'install' },
        { sender: 'player', text: '谢谢李哥。' }
      ]
    },

    /* 「？？？」：通关普通结局后点「重新撰稿」的那一刻才排进队列。
       只有两句，没有落款，也没有可发送的回复 —— 说完就停在那里。 */
    shadow: {
      intro: [
        { sender: 'shadow', text: '准备在这里停下脚步吗？' },
        { sender: 'shadow', text: '还有什么东西是没能注意到的吧。' }
      ]
    }
  };

  /* 剧本的固定先后顺序：不管玩家按什么顺序交稿，队列都按这张表排 */
  const CHAT_ORDER = {
    boss: ['intro', 'draft1', 'draft2'],
    colleague: ['intro'],
    shadow: ['intro']
  };

  const INSTALL_TEXT = '【点击安装：LinkWriter v1.0】';

  /* ---------- 神秘联系人「？？？」的解锁标记 ----------
     只有一个地方会把它写成 true：通关过普通结局之后点「重新撰稿」。
     和 hwu.normalEndingCleared 一样只增不删，唯一的清除方式是清空整档，
     所以二周目、三周目里这个人会一直躺在列表最下面。 */
  const SHADOW_KEY = 'hwu.shadowContactUnlocked';

  function isShadowUnlocked() {
    try { return localStorage.getItem(SHADOW_KEY) === 'true'; } catch (e) { return false; }
  }
  function markShadowUnlocked() {
    try { localStorage.setItem(SHADOW_KEY, 'true'); } catch (e) {}
  }

  const chatTitle = document.getElementById('chatTitle');
  const chatHeadAvatar = document.getElementById('chatHeadAvatar');
  const chatLog = document.getElementById('chatLog');
  const contactList = document.getElementById('contactList');
  const contactSearch = document.getElementById('contactSearch');
  const chatGate = document.getElementById('chatGate');
  const chatGateBtn = document.getElementById('chatGateBtn');
  const chatComposer = document.getElementById('chatComposer');

  let currentContact = '';

  function contactById(id) {
    for (let i = 0; i < CONTACTS.length; i++) if (CONTACTS[i].id === id) return CONTACTS[i];
    return null;
  }

  function scrollLog() { chatLog.scrollTop = chatLog.scrollHeight; }

  /* ---------- 对话进度存档 ----------
     shown       : 已经渲染进日志的步骤数（玩家那条在点发送时才 +1）
     applied     : 已经接入队列的剧本 key
     waitInstall : 卡在安装那一步，等蓝屏走完
     unread      : 这通会话有玩家没看到的新消息（侧栏小红点）
     log 本身不存：它是 steps.slice(0, shown) 推导出来的，永远不会跑偏。 */
  const CHAT_KEY = 'hwu.chat.v1';

  const chatStore = {};
  let chatTimer = 0;

  function chatDefaultState() {
    return { shown: 0, applied: [], waitInstall: false, unread: false };
  }

  function chatSteps(id) {
    const st = chatStore[id];
    const book = CHAT_SCRIPTS[id];
    if (!st || !book) return [];

    let out = [];
    st.applied.forEach(key => {
      if (book[key]) out = out.concat(book[key]);
    });
    return out;
  }

  function saveChatStore() {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatStore)); } catch (e) {}
  }

  function loadChatStore() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(CHAT_KEY) || 'null'); } catch (e) { raw = null; }

    Object.keys(CHAT_SCRIPTS).forEach(id => {
      const saved = raw && raw[id] ? raw[id] : null;
      const st = chatDefaultState();

      if (saved) {
        const len = chatStepsWith(saved.applied, id).length;
        st.shown = Math.min(Math.max(0, parseInt(saved.shown, 10) || 0), len);
        st.applied = (Array.isArray(saved.applied) ? saved.applied : [])
          .filter(key => !!CHAT_SCRIPTS[id][key]);
        st.waitInstall = !!saved.waitInstall;
        st.unread = !!saved.unread;
      }

      chatStore[id] = st;
    });

    /* 老板的开场永远是第一条，缺了就补回来 */
    if (chatStore.boss.applied.indexOf('intro') < 0) chatStore.boss.applied.unshift('intro');
  }

  /* loadChatStore 里还没写进 chatStore，先用同一个规则算一遍长度 */
  function chatStepsWith(applied, id) {
    const book = CHAT_SCRIPTS[id];
    if (!book) return [];
    let out = [];
    (applied || []).forEach(key => {
      if (book[key]) out = out.concat(book[key]);
    });
    return out;
  }

  function ensureChatState(id) {
    if (!chatStore[id]) chatStore[id] = chatDefaultState();
    return chatStore[id];
  }

  /* 把某段剧本接进会话队列（已经接过就不再重复接） */
  function queueChat(id, key) {
    if (!CHAT_SCRIPTS[id] || !CHAT_SCRIPTS[id][key]) return;

    const st = ensureChatState(id);
    if (st.applied.indexOf(key) < 0) {
      st.applied.push(key);
      const order = CHAT_ORDER[id] || [];
      st.applied.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      saveChatStore();
    }

    /* 只有「人确实停在这通会话的聊天页上」才直接往下播。
       光有 currentContact 不算：玩家可能已经切到写稿 / 浏览器去了。 */
    if (id === currentContact && activeViewName() === 'chat') {
      if (!chatTimer) pumpChat(id);
      return;
    }

    /* 其余情况一律只挂红点 + 响一声，绝不替玩家切页 ——
       等他自己从左侧图标或联系人列表点进来。
       声音必须挂在这里：消息落地的那一刻玩家正看着写稿器 / 网页，
       红点在左上角、眼睛未必扫得到，铃声是唯一能把他拽回来的信号。
       （人在聊天页时不需要响 —— 那一路由 pumpChat 落地气泡时自己播。） */
    if (st.shown < chatSteps(id).length) {
      markChatUnread(id);
      playChatSound();
    }
  }

  /* ---------- 未读红点 ----------
     去掉自动切页之后，「有新消息」这件事只能靠红点自己讲清楚：
       ① 左侧联系人行上的 .c-unread 小圆点
       ② 最左侧导航条聊天图标右上角的总红点（任意一通会话未读就亮） */
  function hasAnyUnread() {
    for (const id in chatStore) {
      if (chatStore[id] && chatStore[id].unread) return true;
    }
    return false;
  }

  function syncRailUnread() {
    if (!railCenter) return;
    const chatOn = hasAnyUnread();
    const mailOn = hasUnreadMail();

    railCenter.querySelectorAll('.rail-btn').forEach(btn => {
      if (btn.dataset.tab === 'chat') btn.classList.toggle('has-unread', chatOn);
      if (btn.dataset.tab === 'mail') btn.classList.toggle('has-unread', mailOn);
    });
  }

  function markChatUnread(id) {
    const st = ensureChatState(id);
    if (!st.unread) {
      st.unread = true;
      saveChatStore();
    }
    renderContactList();
    syncRailUnread();
  }

  /* 看过了：连行带点整段重建，比逐个 remove 稳 */
  function clearChatUnread(id) {
    const st = ensureChatState(id);
    if (!st.unread) return;
    st.unread = false;
    saveChatStore();
    renderContactList();
    syncRailUnread();
  }

  /* ---------- 消息提示音 ----------
     音频对象住在 js/chat.js（window.HWUMsgSound），这里只负责「什么时候响」：
     每有一句 NPC（老板 / 小李）消息落地就调一次；玩家自己发的、
     切换联系人时重绘历史记录都不会响。

     文件缺失 / 被浏览器拦截时 chat.js 内部已经吞掉，最多留一条 warn，
     不会影响聊天推进。 */
  const CHAT_SOUND_ON = true;
  const CHAT_SOUND_SRC = 'assets/audio/message.mp3';

  function chatSoundApi() {
    return window.HWUMsgSound || null;
  }

  function playChatSound() {
    if (!CHAT_SOUND_ON) return;

    const api = chatSoundApi();
    if (api) { api.play(); return; }

    /* chat.js 万一没加载成功（被缓存 / 路径改了），退回内置的一份，
       保证提示音不会整个消失。 */
    try {
      if (!chatFallbackAudio) {
        chatFallbackAudio = new Audio(CHAT_SOUND_SRC);
        chatFallbackAudio.volume = 0.5;
        chatFallbackAudio.preload = 'auto';
      }
      chatFallbackAudio.currentTime = 0;
      const p = chatFallbackAudio.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  /* 真实点击里静默播一次：解开浏览器对新消息音效的自动播放限制。
     安装链接、发送按钮、左下角音符按钮三处都会调。 */
  function unlockChatSound() {
    const api = chatSoundApi();
    if (api && api.unlock) api.unlock();
  }

  let chatFallbackAudio = null;

  /* 老板交代完任务、玩家把最后一句发出去之后，小李隔 1 秒才「上线」：
     先亮红点，剧本等他点进来再播。不自动切页，也不抢当前会话。
     定时器只挂一次：重复调用 syncChatUnlocks 不会排出第二份剧本。 */
  const CHAT_COLLEAGUE_DELAY = 1000;
  let colleagueTimer = 0;

  function syncChatUnlocks() {
    const boss = chatStore.boss;
    if (!boss || boss.shown < CHAT_SCRIPTS.boss.intro.length) return;

    const col = chatStore.colleague;
    if (col && col.applied.indexOf('intro') >= 0) return;   /* 已经排过 */
    if (colleagueTimer) return;                             /* 正在等这一秒 */

    colleagueTimer = window.setTimeout(() => {
      colleagueTimer = 0;
      queueChat('colleague', 'intro');
    }, CHAT_COLLEAGUE_DELAY);
  }

  /* 先读档：后面 renderContactList / selectContact 都直接读 chatStore */
  loadChatStore();
  syncChatUnlocks();

  /* ---------- 联系人列表渲染 ---------- */

  /* 老板和小李两个人都常驻：老板一开始就在，小李从第一帧就挂在列表里，
     只是他还不会说话 —— 剧本要等老板交代完、隔 1 秒才排进队列。
     这样玩家随时能看到「有这么个人」，而不是等剧情把人变出来。

     「？？？」是唯一的例外：它不进常驻名单，只认解锁标记。
     标记没写（没通关过普通结局）→ 列表里连一行都不该有；
     写了 → 不管剧本排没排进来，这个人都得挂在最下面。 */
  function isContactAvailable(c) {
    if (!c) return false;
    if (c.id === 'shadow') return isShadowUnlocked();
    return !!chatStore[c.id];
  }

  /* 真正要画进左栏的人：顺序沿用 CONTACTS，过滤规则集中在 isContactAvailable */
  function visibleContacts() {
    return CONTACTS.filter(isContactAvailable);
  }

  /* 侧栏摘要：有未读就预览「第一条没看到的」，全读完了才显示最后一条。
     一条都没有的人（小李还没开口）回落到 CONTACTS 里的占位文案。 */
  function contactPreview(c) {
    const st = chatStore[c.id];
    const steps = chatSteps(c.id);
    const upto = st ? Math.min(st.shown, steps.length) : 0;

    const start = (st && st.unread && upto < steps.length) ? upto : upto - 1;

    for (let i = start; i >= 0; i--) {
      const s = steps[i];
      if (s.kind === 'install') return '【点击安装：LinkWriter v1.0】';
      if (s.text) return s.text;
    }
    return c.preview || '';
  }

  function renderContactList() {
    contactList.innerHTML = '';
    visibleContacts().forEach(c => {
      contactList.appendChild(buildContactRow(c));
    });
    applyContactFilter();
  }

  function buildContactRow(c) {
    const row = document.createElement('div');
    const unread = !!(chatStore[c.id] && chatStore[c.id].unread);
    row.className = 'contact' + (c.id === currentContact ? ' active' : '') + (unread ? ' unread' : '');
    row.dataset.contact = c.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', c.name);
    row.innerHTML =
      '<span class="avatar">' +
      (c.avatarSrc
        ? '<img src="' + escapeHtml(c.avatarSrc) + '" alt="' + escapeHtml(c.name) + '">'
        : escapeHtml(c.initial)) +
      '</span>' +
      '<div class="c-info">' +
      '<div class="c-top"><b>' + escapeHtml(c.name) + '</b>' +
      (c.time ? '<time>' + escapeHtml(c.time) + '</time>' : '') +
      (unread ? '<span class="c-unread" aria-hidden="true"></span>' : '') +
      '</div>' +
      '<small>' + escapeHtml(contactPreview(c)) + '</small>' +
      '</div>';
    bindContactRow(row, () => selectContact(c.id));
    return row;
  }

  /* 点击 / 回车 → 同一个处理函数 */
  function bindContactRow(row, handler) {
    row.addEventListener('click', e => {
      e.preventDefault();
      handler();
      openChatPane(row);
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler();
        openChatPane(row);
      }
    });
  }

  /* 手机窄屏横屏：点联系人后收起中间栏，右侧会话占满全屏。
     宽屏 / 桌面加了这个 class 也没有任何视觉变化（CSS 里只在窄屏生效）。 */
  function openChatPane(row) {
    const shell = row.closest ? row.closest('.chat-shell') : null;
    if (shell) shell.classList.add('is-chat-open');
  }

  /* 联系人搜索（仅过滤列表显示） */
  function applyContactFilter() {
    const q = contactSearch.value.trim().toLowerCase();
    contactList.querySelectorAll('.contact').forEach(c => {
      const name = c.querySelector('b').textContent.toLowerCase();
      const preview = c.querySelector('small').textContent.toLowerCase();
      c.hidden = !!q && name.indexOf(q) < 0 && preview.indexOf(q) < 0;
    });
  }

  contactSearch.addEventListener('input', applyContactFilter);

  /* ---------- 聊天气泡渲染 ---------- */

  /* 一个 step → 一个气泡。玩家自己的消息永远在右侧 */
  function buildBubble(step) {
    const div = document.createElement('div');
    div.className = 'msg ' + (step.sender === 'player' ? 'me' : 'them');

    if (step.kind === 'install') {
      div.appendChild(buildInstallLink());
      return div;
    }

    div.textContent = step.text || '';
    return div;
  }

  function buildInstallLink() {
    const installed = isPluginInstalled();
    const el = document.createElement('a');
    el.className = 'chat-link install-link' + (installed ? ' installed' : '');

    if (installed) {
      el.textContent = '✓ LinkWriter v1.0 已安装';
      el.setAttribute('aria-disabled', 'true');
      return el;
    }

    el.href = '#';
    el.setAttribute('role', 'link');
    el.textContent = INSTALL_TEXT;
    el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      /* 真实点击：先解锁提示音，再走安装流程（蓝屏期间不会响） */
      unlockChatSound();
      runInstall();
    });
    return el;
  }

  /* ---------- 发送闸门 ----------
     轮到玩家时，输入框整行被替换成一个大按钮，按钮上直接写着要发的话。 */
  function syncComposer(st) {
    if (!st) st = ensureChatState(currentContact);

    const steps = chatSteps(currentContact);
    const step = st.shown < steps.length ? steps[st.shown] : null;
    const mine = !!(step && step.sender === 'player' && !st.waitInstall);

    if (mine) {
      chatGateBtn.textContent = '发送：' + (step.text || '');
      chatGate.hidden = false;
      chatComposer.hidden = true;
      chatGateBtn.disabled = false;
      /* 闸门比输入框高，聊天区会被压矮一截：等这一帧排版完再贴回底部 */
      window.requestAnimationFrame(scrollLog);
    } else {
      chatGate.hidden = true;
      chatComposer.hidden = false;
    }
  }

  function clearChatTimer() {
    if (chatTimer) {
      window.clearTimeout(chatTimer);
      chatTimer = 0;
    }
  }

  /* 核心循环：NPC 一条一条往外吐，碰到玩家 / 安装就停下来等人 */
  function pumpChat(id) {
    clearChatTimer();

    if (!id || id !== currentContact) return;
    if (activeViewName() !== 'chat') return;

    const st = ensureChatState(id);
    const steps = chatSteps(id);

    /* 卡在安装：等高亮链接被点过、蓝屏走完才放行 */
    if (st.waitInstall) {
      if (!isPluginInstalled()) { syncComposer(st); return; }
      st.waitInstall = false;
      saveChatStore();
    }

    if (st.shown >= steps.length) {
      syncComposer(st);
      syncChatUnlocks();
      return;
    }

    const step = steps[st.shown];

    /* 安装链接：先把气泡画出来，然后停在这一步等玩家点 */
    if (step.kind === 'install') {
      chatLog.appendChild(buildBubble(step));
      scrollLog();
      playChatSound();
      st.shown += 1;
      st.waitInstall = !isPluginInstalled();
      saveChatStore();
      syncComposer(st);

      if (!st.waitInstall) {
        chatTimer = window.setTimeout(() => pumpChat(id), CHAT_LINE_GAP);
      }
      return;
    }

    /* 轮到玩家：只亮按钮，不往下走 */
    if (step.sender === 'player') {
      syncComposer(st);
      return;
    }

    chatLog.appendChild(buildBubble(step));
    scrollLog();
    playChatSound();
    st.shown += 1;
    saveChatStore();

    /* 注意：这里不要顺手刷新底部按钮。下一条如果正好是玩家的，
       按钮会比这一拍早一个 CHAT_LINE_GAP 亮起来，玩家提前点发送就会顶掉
       这一拍还没走完的定时器。等这一拍走完、pumpChat 走到那一步再亮。 */
    chatTimer = window.setTimeout(() => pumpChat(id), CHAT_LINE_GAP);
  }

  /* 玩家点了「发送：…」 */
  function sendPlayerStep() {
    const id = currentContact;
    if (!id) return;

    /* 这是一次真实点击：顺手解锁提示音，之后老板的回复才响得出来 */
    unlockChatSound();

    const st = ensureChatState(id);
    const steps = chatSteps(id);
    const step = steps[st.shown];
    if (!step || step.sender !== 'player' || st.waitInstall) return;

    /* 先把还没落地的定时器收干净：否则它稍后触发会把这次的收尾顶掉 */
    clearChatTimer();

    chatGate.hidden = true;
    chatComposer.hidden = false;

    chatLog.appendChild(buildBubble(step));
    scrollLog();

    st.shown += 1;
    saveChatStore();

    syncChatUnlocks();
    syncComposer(st);

    chatTimer = window.setTimeout(() => {
      chatTimer = 0;
      pumpChat(id);
    }, CHAT_AFTER_SEND);
  }

  if (chatGateBtn) chatGateBtn.addEventListener('click', sendPlayerStep);

  /* 把已播放的部分按顺序重画一遍（切换联系人也靠它复原） */
  function renderChatLog(id) {
    chatLog.innerHTML = '';

    const steps = chatSteps(id);

    /* 小李常驻列表，但剧本还没排进来（老板还没交代完）：
       点进去看到一句灰提示，而不是一片空白让人以为坏了。 */
    if (!steps.length) {
      const tip = document.createElement('div');
      tip.className = 'msg system';
      tip.textContent = '你们还没有聊过。';
      chatLog.appendChild(tip);
      return;
    }

    const st = ensureChatState(id);
    const upto = Math.min(st.shown, steps.length);

    for (let i = 0; i < upto; i++) chatLog.appendChild(buildBubble(steps[i]));
    scrollLog();
  }

  /* ---------- 选中联系人：高亮 + 重绘聊天区 ---------- */

  function selectContact(id) {
    const data = contactById(id);
    if (!data) return;

    /* 锁着的「？？？」不存在于任何一条正常路径上，这里再兜一层：
       控制台里手点、或者收藏了一个旧链接，都不该把会话页叫出来。 */
    if (id === 'shadow' && !isShadowUnlocked()) return;

    const changed = currentContact !== id;
    currentContact = id;

    clearChatTimer();

    /* 先清掉所有高亮，再给当前项加 active */
    contactList.querySelectorAll('.contact').forEach(row => {
      row.classList.toggle('active', row.dataset.contact === id);
    });

    chatTitle.textContent = data.name;
    /* 大头像：有图就用图（img 铺满 34px 的圆框，object-fit 裁切），
       没图就退回首字母 —— 注意两条路都必须把上一次的内容整个换掉，
       否则从「老板」切到「？？？」时，旧 img 会留在框里。 */
    chatHeadAvatar.dataset.contact = id;
    if (data.avatarSrc) {
      chatHeadAvatar.innerHTML = '<img src="' + escapeHtml(data.avatarSrc) + '" alt="' + escapeHtml(data.name) + '">';
    } else {
      chatHeadAvatar.textContent = data.initial;
    }
    /* 会话页右上角那个头像也跟着换皮：普通联系人是默认紫，只有「？？？」是黑的 */
    document.body.classList.toggle('chat-shadow', id === 'shadow');

    const st = ensureChatState(id);

    /* 点进来就算看过了 */
    if (st.unread) {
      st.unread = false;
      saveChatStore();
      const row = contactList.querySelector('.contact[data-contact="' + id + '"]');
      if (row) {
        row.classList.remove('unread');
        const dot = row.querySelector('.c-unread');
        if (dot) dot.remove();
      }
    }
    syncRailUnread();

    /* 装完插件但还没走过那一步（刷新 / 切页撞上的）：直接放行 */
    if (st.waitInstall && isPluginInstalled()) {
      st.waitInstall = false;
      saveChatStore();
    }

    if (changed) {
      chatLog.classList.remove('swap-in');
      void chatLog.offsetWidth;
      chatLog.classList.add('swap-in');
    }

    renderChatLog(id);
    syncComposer(st);

    /* 停在安装那一步就别动，等玩家自己去点那个蓝色链接 */
    if (!st.waitInstall) pumpChat(id);
  }

  /* 切回聊天页 / 从别的页回来：接着往下走 */
  function resumeChat() {
    if (!currentContact) return;
    clearChatTimer();

    /* 人已经在聊天页、脸就贴在当前会话上，红点没有留着的道理 */
    if (activeViewName() === 'chat') clearChatUnread(currentContact);

    const st = ensureChatState(currentContact);
    syncComposer(st);
    if (!st.waitInstall) pumpChat(currentContact);
  }

  /* ============================================================
     五之二、插件安装（蓝屏 → 打字机 → 解锁功能）
     ------------------------------------------------------------
     状态机：
       runInstall()  清屏、显示蓝屏
         └ typing    每 100ms 追加一个字符（光标始终在末尾）
            └ hold   打完后再停 0.8s，让玩家看清 Please wait...
               └ fade  .bsod-out 淡出 0.34s
                  └ finishInstall()  写状态 + 重建侧栏 + 系统提示
     三个定时器都存起来，重入时先清掉，保证不会打出重复的字。
     ============================================================ */

  const bsod = document.getElementById('bsod');

  /* 要逐字打出的文本（换行用 \n，靠 CSS 的 pre-wrap 生效） */
  const BSOD_TEXT =
    'LINKWRITER OS INSTALLING...\n\n' +
    '> 正在连接云端服务器...\n' +
    '> 正在注入底层组件...\n' +
    '> 正在挂载历史回溯模块...\n\n' +
    'Please wait...';

  const BSOD_TYPE_MS = 100;   /* 每个字的间隔：100ms，89 个字约 8.9 秒，逐字看得清 */
  const BSOD_HOLD_MS = 800;   /* 打完字后的停顿 */
  const BSOD_FADE_MS = 340;   /* 淡出时长，需与 .bsod 的 transition 一致 */

  let installing = false;
  let bsodTypeTimer = 0;
  let bsodHoldTimer = 0;
  let bsodFadeTimer = 0;

  /* 文字容器：优先取 HTML 里的 #blue-screen-text，缺失时兜底创建 */
  function getBsodTextEl() {
    let el = document.getElementById('blue-screen-text');
    if (el) return el;

    const inner = bsod.querySelector('.bsod-inner') || bsod;
    inner.innerHTML = '';
    el = document.createElement('div');
    el.id = 'blue-screen-text';
    inner.appendChild(el);
    return el;
  }

  const bsodText = getBsodTextEl();

  /* 光标是容器里最后一个子节点，打字时把字符插到它前面即可 */
  const bsodCursor = document.createElement('span');
  bsodCursor.className = 'bsod-cursor';
  bsodCursor.setAttribute('aria-hidden', 'true');

  function resetBsod() {
    bsodText.textContent = '';
    bsodText.appendChild(bsodCursor);
  }

  /* 预留“整段文本”的高度：否则文本每多一行，居中的块就会整体上移，
     打字过程中会看到文字上下跳动。这里按行数 × 行高把高度锁死。 */
  function reserveBsodHeight() {
    const inner = bsod.querySelector('.bsod-inner');
    if (!inner) return;

    const lh = parseFloat(window.getComputedStyle(bsodText).lineHeight) || 32;
    const lines = BSOD_TEXT.split('\n').length;
    inner.style.minHeight = (lines * lh) + 'px';
  }

  /* 逐字输出；用 Array.from 切分，避免把中文/符号切坏 */
  function typeBsodText(onDone) {
    const chars = Array.from(BSOD_TEXT);
    let i = 0;

    window.clearInterval(bsodTypeTimer);

    function step() {
      /* 先判断收尾，再取字符：保证最后一个字一定打出去 */
      if (i >= chars.length) {
        window.clearInterval(bsodTypeTimer);
        bsodTypeTimer = 0;
        if (typeof onDone === 'function') onDone();
        return;
      }

      bsodText.insertBefore(document.createTextNode(chars[i]), bsodCursor);
      i += 1;
    }

    step();                                     /* 立刻出第一个字，不留空白 */
    bsodTypeTimer = window.setInterval(step, BSOD_TYPE_MS);
  }

  function runInstall() {
    if (installing || isPluginInstalled()) return;
    installing = true;

    /* 复位上一次的定时器与样式（重复安装 / 快速点击都不会串台） */
    window.clearInterval(bsodTypeTimer);
    window.clearTimeout(bsodHoldTimer);
    window.clearTimeout(bsodFadeTimer);

    bsod.classList.remove('hidden', 'bsod-out');
    resetBsod();
    void bsod.offsetWidth;                     /* 重启 0.07s 的闪入动画 */
    reserveBsodHeight();                       /* 锁死高度，打字时不跳动 */

    typeBsodText(() => {
      /* 打字完成 → 停顿 0.8 秒，让最后一行和光标留在屏幕上 */
      bsodHoldTimer = window.setTimeout(() => {
        bsod.classList.add('bsod-out');

        bsodFadeTimer = window.setTimeout(() => {
          bsod.classList.add('hidden');
          bsod.classList.remove('bsod-out');
          finishInstall();
        }, BSOD_FADE_MS);
      }, BSOD_HOLD_MS);
    });
  }

  /* 蓝屏彻底消失后再落地存档，避免中途关页面出现“已安装但没有提示” */
  function finishInstall() {
    setPluginInstalled();
    applyPluginState();

    /* 关键：按新的安装状态重建左侧导航（4 → 6 个图标） */
    renderSidebar();

    /* 链接近安装态，聊天记录里的那行也变成“已安装” */
    renderContactList();
    if (contactById(currentContact)) {
      /* selectContact 会把 waitInstall 摘掉并接着往下走 → 下一条正是「谢谢李哥。」 */
      selectContact(currentContact);
    }

    installing = false;

    /* 安装是玩家亲手点的：借这次交互放出第一段 BGM */
    startBgmOnce();
  }

  /* 聊天区里的安装链接都在 buildBubble 里直接绑定，
     这里不再需要额外的点击委托。 */

  /* ============================================================
     五之三、收件箱（独立邮件模块）
     ------------------------------------------------------------
     三个子页面：发邮件 / 收件箱 / 查看附件（点开附件进预览页）
     剧情数据全部集中在下面两张表里，UI 只负责渲染：
       inboxMails     : 四封信的唯一来源（发件人 / 主题 / 正文 / 附件）
       attachmentList : 附件 id → 文件名 / 类型 / 真实文件 / 来路
     收件状态存在 localStorage 的 hwu.mailState.v2：
       { 'mail-host': { opened:false, at: 时间戳 }, … }
     某个 id 出现在这张表里 = 这封信已经收到了。
     ============================================================ */

  const MAIL_ADDR_HOST = 'henryclark@ww.com';   /* 主持人回信地址（比较时忽略大小写） */
  const MAIL_ADDR_EGG = 'xy0806@ww.com';        /* 前作彩蛋地址 */

  const MAIL_STATE_KEY = 'hwu.mailState.v2';
  const MAIL_HOST_SENT_KEY = 'hwu.mailHostSent.v1';   /* 是否已经给主持人寄过信 */
  const ATTACH_KEY = 'downloadedAttachments';
  const ATTACH_SEEN_KEY = 'hwu.attachSeen.v1';

  /* 主持人回信的前置条件：寄过信 + 通关过普通结局 + 稿件 3 的 A~H 一个都不能少
     （三者都齐了才回信，判定只写在 checkHostMailCondition 一处） */
  const HOST_REPLY_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  /* ---------- 附件总表 ---------- */

  const attachmentList = [
    { id: 'video-happy', name: 'HappyWithUs.mp4', type: 'video',
      src: 'assets/video/HappyWithUs.mp4', from: 'HenryClark@ww.com' },
    { id: 'video-auto-1', name: '未播出录像1.mp4', type: 'video',
      src: 'assets/video/video-auto-1.mp4', from: 'LinkWriter自动抓取' },
    { id: 'video-auto-2', name: '未播出录像2.mp4', type: 'video',
      src: 'assets/video/video-auto-2.mp4', from: 'LinkWriter自动抓取' },
    { id: 'img-flower', name: '鸢尾花.png', type: 'image',
      src: 'assets/image/iris.png', from: 'xy0806@ww.com' }
  ];

  /* ---------- 收件箱里的四封信 ----------
     content 为空字符串 = 这封信没有正文，阅读区只留附件按钮。 */

  const inboxMails = [
    {
      id: 'mail-host',
      sender: 'HenryClark@ww.com',
      title: '这会是最后一封邮件',
      content: '听着，年轻人。我不知道你们为什么对这档节目如此热衷，在它停播后的十多年里，一直有像你一样的人给我发邮件，试图从我的嘴里获得更多关于它的消息。但我只能说，我不知道。\n' +
        '宣布停播的那一天，一切都很正常。我们在演播厅穿好毛绒外衣，像往常一样，等待那些孩子们入场，然后拍摄今天的份。我们等了很久，录制一般是早上九点开始，但那天直到十点，我们仍然没有收到开工的信号。我太热了，把头套摘下，正想询问“今天到底什么情况”。紧接着，我就看到维恩女士走了进来。\n' +
        '她什么时候离开演播厅的？我不知道。但她走了进来，脸色非常难看，好像要说什么了不得的事情。我们所有人都看向她，然后，维恩女士就告诉了我们那个可怕的噩耗：节目被停播了，我们所有人都必须打道回府。\n' +
        '这对我的事业产生了很大影响，天知道我还有下个月的房租需要支付！所以我追了上去，试图得到一个答案，但他们什么都不肯说。\n' +
        '直到现在，我也不知道当年到底发生了什么，那些录像带也不在我的手里。我猜或许在电视台？但那里早几年发了大火，把仓库烧了，可能都没了吧。\n' +
        '好了，不管你相信与否，这就是我知道的所有。我已经开启了新生活，不想要再去思考当年那件事。不过，既然你有疑问，我可以送给你一段录像，那是我第一次出演节目时，我的母亲在家里的电视机上录下的，“绝对没有进行任何修改”，希望对你有用。\n' +
        '就是这样。',
      attachment: { id: 'video-happy', name: 'HappyWithUs.mp4' }
    },
    {
      id: 'mail-auto-1',
      sender: 'LinkWriter自动抓取',
      title: '《访谈聚焦：走进刘盈莹》2026-08-05',
      content: '',
      attachment: { id: 'video-auto-1', name: '未播出录像1.mp4' }
    },
    {
      id: 'mail-auto-2',
      sender: 'LinkWriter自动抓取',
      title: '《悄悄夜谈：星火游戏特辑》2023-09-06',
      content: '',
      attachment: { id: 'video-auto-2', name: '未播出录像2.mp4' }
    },
    {
      id: 'mail-easter-egg',
      sender: 'xy0806@ww.com',
      title: '你喜欢花吗-v-',
      content: '',
      attachment: { id: 'img-flower', name: '鸢尾花.png' }
    }
  ];

  /* 发件箱预填：玩家只需要把收件人填对，主题和正文已经写在框里 */
  const COMPOSE_PRESET = {
    subject: '关于《Happy With Us》的调查',
    body: '您好，我是知节报社的记者。我正在调查《Happy With Us》的停播原因，希望能向您了解一些情况。'
  };

  const mailNav = document.getElementById('mailNav');
  const mailDot = document.getElementById('mailDot');
  const mailAttachDot = document.getElementById('mailAttachDot');
  const mailListEl = document.getElementById('mailList');
  const mailReaderEl = document.getElementById('mailReader');
  const mailAttachBody = document.getElementById('mailAttachBody');
  const mailForm = document.getElementById('mailForm');
  const mailTo = document.getElementById('mail-to');
  const mailSubject = document.getElementById('mail-subject');
  const mailBody = document.getElementById('mail-body');
  const mailHint = document.getElementById('mailHint');
  const mailToast = document.getElementById('mailToast');

  let mailView = 'compose';
  let mailTimer = null;
  let openMailId = '';        /* 当前阅读区里是哪一封（空 = 未选择） */

  /* ---------- 收件状态读写 ---------- */

  function readMailState() {
    try {
      const raw = localStorage.getItem(MAIL_STATE_KEY);
      const obj = raw ? JSON.parse(raw) : null;
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) { return {}; }
  }

  function saveMailState(state) {
    try { localStorage.setItem(MAIL_STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function mailById(id) {
    return inboxMails.filter(m => m.id === id)[0] || null;
  }

  function isMailReceived(id) {
    return !!readMailState()[id];
  }

  /* 收下这封信；已经收过就什么都不做（返回 false） */
  function receiveMail(id) {
    if (!mailById(id) || isMailReceived(id)) return false;
    const state = readMailState();
    state[id] = { opened: false, at: Date.now() };
    saveMailState(state);
    return true;
  }

  function markMailOpened(id) {
    const state = readMailState();
    const rec = state[id];
    if (rec && !rec.opened) {
      rec.opened = true;
      saveMailState(state);
    }
  }

  function mailAt(id) {
    const rec = readMailState()[id];
    return rec ? (rec.at || 0) : 0;
  }

  /* 收件箱红点：任何一封未读都要亮 */
  function hasUnreadMail() {
    const state = readMailState();
    return Object.keys(state).some(id => state[id] && !state[id].opened);
  }

  /* 稿件 1 / 2 提交后各触发一封「自动抓取」邮件，同一篇只发一次 */
  function maybeSendAutoMail(no) {
    const id = no === 1 ? 'mail-auto-1' : (no === 2 ? 'mail-auto-2' : '');
    if (!id) return;
    if (receiveMail(id)) refreshMailAfterReceive();
  }

  /* ---------- 时间格式 ---------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatMailDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
  }

  function formatMailDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ---------- 附件状态（localStorage：downloadedAttachments） ---------- */

  function getDownloadedAttachments() {
    try {
      const raw = localStorage.getItem(ATTACH_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.filter(a => a && a.id && a.name);
    } catch (e) { return []; }
  }

  function saveDownloadedAttachments(list) {
    try { localStorage.setItem(ATTACH_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function isAttachDownloaded(id) {
    return getDownloadedAttachments().some(a => a.id === id);
  }

  function isAttachSeen() {
    try { return localStorage.getItem(ATTACH_SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  function setAttachSeen() {
    try { localStorage.setItem(ATTACH_SEEN_KEY, '1'); } catch (e) {}
  }

  function attachById(id) {
    return attachmentList.filter(a => a.id === id)[0] || null;
  }

  /* ---------- 「发送中…」浮层 ----------
     注意：这里不能叫 showToast —— 文件下方还有一个全局的右下角 toast，
     同名的 function 声明会互相覆盖，邮件浮层就会失灵。 */
  function showMailToast(text) {
    mailToast.textContent = text;
    mailToast.classList.remove('hidden');
  }
  function hideMailToast() { mailToast.classList.add('hidden'); }

  /* ---------- 空状态小部件 ---------- */

  function mailEmptyBlock(title, desc) {
    return '<div class="mail-empty">' +
      '<svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
      '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>' +
      '<b>' + escapeHtml(title) + '</b>' +
      '<span>' + escapeHtml(desc) + '</span>' +
      '</div>';
  }

  function readerEmptyBlock(title, desc) {
    return '<div class="mail-reader-empty">' +
      '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><polyline points="4 7 12 13 20 7"/></svg>' +
      '<b>' + escapeHtml(title) + '</b>' +
      '<span>' + escapeHtml(desc) + '</span>' +
      '</div>';
  }

  /* ---------- 中间栏：三个按钮 + 子页面切换 ---------- */

  function applyMailBadges() {
    mailDot.classList.toggle('hidden', !hasUnreadMail());
    applyAttachDot();

    /* 收件箱未读也要同步到最左侧的全局导航栏（信封图标右上角那颗点）：
       玩家可能正停在写稿器 / 浏览器，根本看不到邮件模块里的红点，
       只靠导航栏那颗点才能把他引过去。读完最后一封时这里同样会把它熄掉。 */
    syncRailUnread();
  }

  /* 「查看附件」上的红点：下载了、但还没点开看过 */
  function applyAttachDot() {
    if (!mailAttachDot) return;
    const pending = getDownloadedAttachments().length > 0 && !isAttachSeen();
    mailAttachDot.classList.toggle('hidden', !pending);
  }

  function setMailView(view) {
    /* 离开附件页时先掐掉抽屉里的声音：
       抽屉不销毁（只是 hidden），不 pause 的话切到收件箱还会在背后放。 */
    if (view !== 'attach') pauseAttachDrawer();

    mailView = view;

    /* 预览页是从附件列表点进去的，导航高亮留在「查看附件」上，
       玩家再点一下就能退回列表。 */
    const navKey = view === 'video' ? 'attach' : view;
    mailNav.querySelectorAll('.mail-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mailView === navKey);
    });
    document.querySelectorAll('.mail-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === 'mail-pane-' + view);
    });

    if (view === 'inbox') renderInbox();
    if (view === 'attach') renderAttach();
  }

  mailNav.addEventListener('click', e => {
    const btn = e.target.closest('.mail-nav-item');
    if (!btn) return;
    setMailView(btn.dataset.mailView);
    if (btn.dataset.mailView === 'compose') window.setTimeout(() => mailTo.focus(), 60);
  });

  /* 收到新信：红点 + 如果正停在收件箱 / 附件页，就地重画 */
  function refreshMailAfterReceive() {
    applyMailBadges();
    if (mailView === 'inbox') renderInbox();
    if (mailView === 'attach') renderAttach();
  }

  /* ---------- 收件箱：列表 + 阅读区 ---------- */

  function senderAvatar(sender) {
    if (String(sender).indexOf('LinkWriter') === 0) return '抓';
    return (String(sender).charAt(0) || '?').toUpperCase();
  }

  /* 当前收件箱里能看到的邮件（收到的都算，按收信时间倒序） */
  function inboxMessages() {
    const state = readMailState();

    return inboxMails
      .filter(m => !!state[m.id])
      .sort((a, b) => mailAt(b.id) - mailAt(a.id))
      .map(m => ({
        id: m.id,
        ava: senderAvatar(m.sender),
        from: m.sender,
        subject: m.title,
        preview: m.content ? String(m.content).split('\n')[0] : '',
        time: formatMailDate(mailAt(m.id)),
        unread: !state[m.id].opened
      }));
  }

  function mailItemHtml(m) {
    return '<button type="button" class="mail-item' + (m.unread ? ' unread' : '') + '"' +
        ' data-mail="' + escapeHtml(m.id) + '">' +
        '<span class="mi-ava">' + escapeHtml(m.ava) + '</span>' +
        '<span class="mi-text">' +
          '<b>来自：' + escapeHtml(m.from) + '</b>' +
          '<span class="mi-subject">主题：' + escapeHtml(m.subject) + '</span>' +
          (m.preview ? '<small>' + escapeHtml(m.preview) + '</small>' : '') +
        '</span>' +
        (m.time ? '<time class="mi-time">' + escapeHtml(m.time) + '</time>' : '') +
      '</button>';
  }

  function renderInbox() {
    const msgs = inboxMessages();

    if (!msgs.length) {
      openMailId = '';
      mailListEl.innerHTML = mailEmptyBlock('暂无邮件', '发出第一封信后，回信会出现在这里。');
      mailReaderEl.innerHTML = '';
      return;
    }

    mailListEl.innerHTML = msgs.map(mailItemHtml).join('');
    mailListEl.querySelectorAll('.mail-item').forEach(btn => {
      btn.addEventListener('click', () => openMail(btn.dataset.mail));
    });

    if (!msgs.some(m => m.id === openMailId)) {
      openMailId = '';
      mailReaderEl.innerHTML = readerEmptyBlock('未选择邮件', '点击左侧任意一封邮件，查看正文。');
      return;
    }

    mountMessage(openMailId);
  }

  /* 阅读区：正文按 \n 分段；正文为空的信不输出 .letter-body */
  function letterHtml(mail) {
    const paras = String(mail.content || '')
      .split('\n')
      .filter(p => p.trim() !== '');

    return '<article class="letter">' +
        '<h1 class="letter-subject">' + escapeHtml(mail.title) + '</h1>' +
        '<div class="letter-meta">' +
          '<div class="lm-row"><span>发件人</span><b>' + escapeHtml(mail.sender) + '</b></div>' +
          '<div class="lm-row"><span>收件人</span><b>撰稿人 &lt;reporter@linkwriter.mail&gt;</b></div>' +
          '<div class="lm-row"><span>时间</span><b>' + escapeHtml(formatMailDateTime(mailAt(mail.id))) + '</b></div>' +
        '</div>' +
        (paras.length
          ? '<div class="letter-body">' + paras.map(p => '<p>' + escapeHtml(p) + '</p>').join('') + '</div>'
          : '') +
        (mail.attachment ? attachTipHtml(mail.attachment) : '') +
        (mail.attachment ? '<div class="letter-actions">' + attachButtonHtml(mail.attachment) + '</div>' : '') +
      '</article>';
  }

  function attachTipHtml(attach) {
    const done = isAttachDownloaded(attach.id);
    const meta = attachById(attach.id) || {};

    return '<div class="letter-attach-tip">' +
        '<svg viewBox="0 0 24 24"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
        '<span id="attachTipText">1 个附件：' + escapeHtml(attach.name) +
          (done ? ' · 已保存到左侧「查看附件」' : '') +
        '</span>' +
      '</div>';
  }

  /* 正文右下角的下载按钮：下载过就是置灰的「已下载」 */
  function attachButtonHtml(attach) {
    const done = isAttachDownloaded(attach.id);
    return '<button type="button" class="attach-download' + (done ? ' is-done' : '') + '"' +
      ' id="attachDownload" data-attach="' + escapeHtml(attach.id) + '"' +
      (done ? ' disabled' : '') + '>' +
      (done ? '已下载' : '📎 下载附件：' + escapeHtml(attach.name)) +
      '</button>';
  }

  /* 把某一封写进阅读区，并给下载按钮绑上事件 */
  function mountMessage(id) {
    const mail = mailById(id);
    if (!mail) return;

    mailReaderEl.innerHTML = letterHtml(mail);

    const btn = document.getElementById('attachDownload');
    if (btn && !btn.disabled) {
      btn.addEventListener('click', () => downloadAttachment(btn.dataset.attach));
    }
  }

  function openMail(id) {
    if (!inboxMessages().some(m => m.id === id)) return;

    openMailId = id;
    markMailOpened(id);
    applyMailBadges();
    renderInbox();
    mailReaderEl.scrollTop = 0;
  }

  /* ---------- 下载附件 ---------- */

  function downloadAttachment(id) {
    const attach = attachById(id);
    if (!attach) return;

    const list = getDownloadedAttachments();
    if (!list.some(a => a.id === attach.id)) {
      /* 只存必要字段，避免把页面里的展示信息一起写进存档 */
      list.push({ id: attach.id, name: attach.name, type: attach.type });
      saveDownloadedAttachments(list);
    }

    const btn = document.getElementById('attachDownload');
    if (btn) {
      btn.textContent = '已下载';
      btn.disabled = true;
      btn.classList.add('is-done');
    }

    /* 提示行同步，别让正文还写着附件名却看不出已经存下来了 */
    const tip = document.getElementById('attachTipText');
    if (tip) {
      tip.textContent = '1 个附件：' + attach.name + ' · 已保存到左侧「查看附件」';
    }

    applyAttachDot();
  }

  /* ---------- 查看附件（手风琴：预览块插在被点卡片正下方） ---------- */

  /* 这里没有固定的「抽屉容器」：每点开一件，就现场 new 一个 .attach-drawer，
     用 insertAdjacentElement('afterend') 插到那张卡片的紧后面。卡片是列表里的
     普通块级项，所以下面的附件会被自然顶下去 —— 不占右侧一栏、不跳页，
     也不会出现「抽屉和列表对不上号」的错位。全页只允许存在一个 .attach-drawer，
     这就是手风琴的互斥。 */

  function attachCardOf(id) {
    if (!mailAttachBody) return null;
    const cards = mailAttachBody.querySelectorAll('.attach-card');
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].dataset.attach === id) return cards[i];
    }
    return null;
  }

  function getAttachDrawers() {
    if (!mailAttachBody) return [];
    return [].slice.call(mailAttachBody.querySelectorAll('.attach-drawer'));
  }

  /* 全部收起：先 pause 再摘节点 —— 节点一摘，视频还可能在背后缓冲出声 */
  function closeAttachDrawers() {
    getAttachDrawers().forEach(el => {
      const v = el.querySelector('video');
      if (v && !v.paused) v.pause();
      el.remove();
    });
    markAttachCardActive('');
  }

  /* 左侧列表的选中态：正在下面播 / 看的那一张描紫边 */
  function markAttachCardActive(id) {
    if (!mailAttachBody) return;
    mailAttachBody.querySelectorAll('.attach-card').forEach(card => {
      card.classList.toggle('is-active', !!id && card.dataset.attach === id);
    });
  }

  /* 切走 / 关窗口之前，先掐掉正在放的视频（节点还挂在列表里） */
  function pauseAttachDrawer() {
    getAttachDrawers().forEach(el => {
      const v = el.querySelector('video');
      if (v && !v.paused) v.pause();
    });
  }

  /* 媒体读不出来时把这一个预览块换成一句话，卡片和列表都留着 */
  function attachErrorHtml(text) {
    return '<div class="attach-media-wrap">' +
        '<p class="attach-empty-tip">' + escapeHtml(text) + '</p>' +
      '</div>';
  }

  function renderAttach() {
    const list = getDownloadedAttachments();
    applyAttachDot();

    /* 重画列表前先摘掉展开中的预览块（顺带掐声音）：
       旧的 data-attach 可能已经指向不存在的附件了。 */
    closeAttachDrawers();

    if (!mailAttachBody) return;

    if (!list.length) {
      mailAttachBody.innerHTML = mailEmptyBlock('暂无附件', '在「收件箱」里打开来信，下载附件后会出现在这里。');
      return;
    }

    /* 列表里只放卡片，一个预览块都不预埋。
       也不再拼底部那条「原始录像没有剪辑标记……」的注释 ——
       原片有没有剪辑标记，是玩家自己看录像时该发现的事。 */
    mailAttachBody.innerHTML = list.map(attachCardHtml).join('');

    bindAttachCards();
  }

  /* innerHTML 一重写，卡片上的监听就全没了，所以每次渲染后重新绑一遍 */
  function bindAttachCards() {
    if (!mailAttachBody) return;
    mailAttachBody.querySelectorAll('.attach-card').forEach(card => {
      card.addEventListener('click', () => openAttachment(card.dataset.attach));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openAttachment(card.dataset.attach);
        }
      });
    });
  }

  function attachCardHtml(file) {
    const meta = attachById(file.id) || {};
    const from = meta.from || '未知';
    const kind = file.type === 'image' ? 'PNG' : 'MP4';

    return '<div class="attach-card" data-attach="' + escapeHtml(file.id) + '" role="button" tabindex="0">' +
        '<span class="attach-thumb' + (file.type === 'image' ? ' is-image' : '') + '">' +
          '<svg viewBox="0 0 24 24">' +
            (file.type === 'image'
              ? '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>'
              : '<polygon points="8 6 19 12 8 18"/>') +
          '</svg>' +
        '</span>' +
        '<span class="attach-info">' +
          '<b>' + escapeHtml(file.name) + '</b>' +
          '<small>' + escapeHtml(kind + ' · 来自「' + from + '」') + '</small>' +
        '</span>' +
        '<span class="attach-open">打开</span>' +
      '</div>';
  }

  /* 点附件 = 手风琴。
     1) 预览块就贴在卡片后面，所以「下一个兄弟是 .attach-drawer」= 这件正开着
     2) 不论开还是关，先把所有预览块摘掉（互斥只靠这一句）
     3) 刚点的就是开着那件 → 摘掉即收起，直接 return
     4) 否则现场造一个新的，插到这张卡片正下方，下面的卡片自动让位
     全程不碰 setMailView —— 页面不跳转，列表也不重画。 */
  function openAttachment(id) {
    const file = getDownloadedAttachments().filter(a => a.id === id)[0];
    if (!file) return;

    setAttachSeen();
    applyAttachDot();

    const clickedCard = attachCardOf(id);
    if (!clickedCard) return;

    /* 判断当前状态：抽屉是 insertAdjacentElement('afterend') 插进来的，
       所以「下一个兄弟节点是 .attach-drawer」就说明这件是展开的 */
    const nextEl = clickedCard.nextElementSibling;
    const isCurrentlyOpen = !!nextEl && nextEl.classList.contains('attach-drawer');

    /* 无论怎样先把已展开的摘掉（实现互斥） */
    closeAttachDrawers();

    /* 刚才点的就是已经展开的那个 → 本次语义是「收起」 */
    if (isCurrentlyOpen) return;

    const meta = attachById(id) || {};

    /* 主持人那盘带子的路径是写死的剧情资源：元数据里虽然也有 src，
       这里再兜一层，免得哪天改表把它改没了就播不出来。 */
    const src = id === 'video-happy'
      ? 'assets/video/HappyWithUs.mp4'
      : (meta.src || '');
    const name = file.name || '未知附件';

    let html = '';

    if (file.type === 'image') {
      html = '<div class="attach-media-wrap">' +
          '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(name) + '">' +
        '</div>';
    } else if (file.type === 'video') {
      /* controls：浏览器原生控制条
         playsinline / webkit-playsinline：iPhone 上在页面内播，别一按就劫持成系统全屏
         preload="metadata"：先只取时长和首帧，别一插进来就整段下载 */
      html = '<div class="attach-media-wrap">' +
          '<video controls playsinline webkit-playsinline preload="metadata"' +
            ' poster="assets/image/poster-default.jpg"' +
            (src ? ' src="' + escapeHtml(src) + '"' : '') + '></video>' +
        '</div>';
    } else {
      return;
    }

    const drawer = document.createElement('div');
    drawer.className = 'attach-drawer';
    drawer.dataset.attach = id;
    drawer.innerHTML = html;

    /* 关键一句：插到被点卡片的紧后面 */
    clickedCard.insertAdjacentElement('afterend', drawer);

    /* 附件视频升级：预加载已落 IndexedDB 的，直接换本地 Blob 地址（零网络） */
    upgradeVideosIn(drawer);

    /* 媒体读不出来时只把这一块换成一句话：卡片和列表都还在，能再点一次收起 */
    const media = drawer.querySelector('img, video');
    if (media) {
      media.addEventListener('error', () => {
        console.warn('[' + (file.type === 'image' ? 'IMAGE' : 'VIDEO') + '] 附件缺失或无法读取：' +
          (src || name) + '（不影响游戏）');
        drawer.innerHTML = attachErrorHtml(file.type === 'image'
          ? '这张图已经打不开了'
          : '这段录像已经损坏，无法播放');
      });
    }

    markAttachCardActive(id);

    /* 展开后再滚：此时布局已经算完，block:'nearest' 只做最小位移，
       不会把整页顶飞；100ms 让展开动画先走一小段，观感更顺。 */
    window.setTimeout(() => {
      if (!drawer.isConnected) return;
      drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }

  /* ---------- 写邮件 → 发送 ---------- */

  mailForm.addEventListener('submit', e => {
    e.preventDefault();
    sendMail();
  });

  /* ---------- 发件箱的填充规则 ----------
     刚进来是空白的：主题和正文不再预先摆好。
     只有收件人写成了「真实存在的那个地址」，预设文案才会浮出来 ——
     填错地址、或者只是随手打了几个字，两个框都还是空的。
     force = true 是「整张表单复位」：四样一起清空，不写回预设。 */
  function prefillCompose(force) {
    if (force) {
      mailTo.value = '';
      mailSubject.value = '';
      mailBody.value = '';
      mailHint.textContent = '';
      return;
    }
    mailSubject.value = COMPOSE_PRESET.subject;
    mailBody.value = COMPOSE_PRESET.body;
  }

  /* ---------- 收件人 → 主题 / 正文的唯一同步点 ----------
     两种地址是两套规矩，绝不能共用一个「填上预设」的分支：

       · 主持人 henryclark@ww.com —— 这封信是有剧本的：主题和正文就是
         知节报社记者的约访，玩家只要把地址写对就该看见它。
         两个框都还空着才补；已经写了字就一律不覆盖，别冲掉玩家自己敲的。

       · 彩蛋 xy0806@ww.com —— 这封信**不能有预设文案**。它是写给前作
         那位发信人的私人信，套上「关于《Happy With Us》的调查」既不搭、
         也等于把彩蛋提前说破。所以不但不补，还要**主动清干净**：
         玩家常常是先试主持人地址（预设已经填上），发现没回音才改填彩蛋，
         那两行预设会跟着一起寄出去，所以这里无条件清空。
         （主题留空是允许的，输入框占位符就是「（无主题）」。）

       · 其它任何输入（打了一半、写错、清空收件人）—— 只把「还原封不动的
         预设」收回去：逐字段比对，空 或 恰好等于预设，才算还是我们写的；
         玩家动过任何一个字，两个框都原样留着不动。 */
  function syncComposePreset() {
    const addr = String(mailTo.value || '').trim().toLowerCase();

    if (addr === MAIL_ADDR_HOST) {
      if (mailSubject.value || mailBody.value) return false;
      prefillCompose(false);
      return true;
    }

    if (addr === MAIL_ADDR_EGG) {
      if (!mailSubject.value && !mailBody.value) return false;
      mailSubject.value = '';
      mailBody.value = '';
      mailHint.textContent = '';
      return true;
    }

    /* 别把「玩家清空收件人准备重打」也当成残留处理：
       两个框本来就空就直接返回，免得每敲一个字都白跑一遍赋值。 */
    if (!mailSubject.value && !mailBody.value) return false;
    const subjectIsOurs = !mailSubject.value || mailSubject.value === COMPOSE_PRESET.subject;
    const bodyIsOurs = !mailBody.value || mailBody.value === COMPOSE_PRESET.body;
    if (!subjectIsOurs || !bodyIsOurs) return false;

    mailSubject.value = '';
    mailBody.value = '';
    mailHint.textContent = '';
    return true;
  }

  /* input：边打边判（粘贴、拖选替换、退格都会触发）。
     blur：兜住那些不派发 input 的填写方式 —— 浏览器自动填充、
           以及任何直接改 value 的脚本，离开输入框时补齐 / 清干净。 */
  mailTo.addEventListener('input', syncComposePreset);
  mailTo.addEventListener('blur', syncComposePreset);

  function sendMail() {
    const to = mailTo.value.trim();
    const key = to.toLowerCase();

    if (!to) {
      mailHint.textContent = '请填写收件人地址。';
      mailTo.focus();
      return;
    }

    const targetId = key === MAIL_ADDR_HOST ? 'mail-host'
      : (key === MAIL_ADDR_EGG ? 'mail-easter-egg' : '');

    if (!targetId) {
      mailHint.textContent = '发送失败，邮箱地址不存在';
      return;
    }

    const isHost = key === MAIL_ADDR_HOST;

    /* 主持人这条线不再拦发送：一开局就把信寄出去也照样「发送成功」，
       只是对方永远不会回 —— 石沉大海。
       寄件动作只负责把「寄过」这件事记下来（在下面那一拍里落盘），
       回不回信全部交给 checkHostMailCondition() 一个函数去判。 */

    /* 命中：先提示发送中，1 秒后信才落到收件箱 */
    mailHint.textContent = '';
    window.clearTimeout(mailTimer);
    showMailToast('邮件发送中...');

    mailTimer = window.setTimeout(() => {
      if (isHost) {
        /* ① 「寄过」的标记落在这一拍里：提示先出去，存档后落地。
              写的是 'true'（老档里的 '1' 由 isHostMailSent 一并认） */
        setHostMailSent();

        /* ② 发件箱复位：收件人 / 主题 / 正文 / 提示一起清空 */
        prefillCompose(true);

        /* ③ 回不回信只看这一个函数：通关过普通结局 + 前 8 个词齐 + 还没收过。
              没齐就什么都不发生，红点不亮，也没有任何失败提示 ——
              玩家不该因为「这封信好像没回音」而怀疑地址写错了。 */
        const replied = checkHostMailCondition();

        applyMailBadges();

        if (!replied && !isMailReceived('mail-host')) {
          mailHint.textContent = '邮件已发送，对方可能需要时间回复';
        }

        showMailToast('邮件已发送');
        mailTimer = window.setTimeout(hideMailToast, 1800);
        return;
      }

      receiveMail(targetId);

      /* 发件箱复位：与上面同一套 —— 三个框全清，提示不残留 */
      mailTo.value = '';
      mailSubject.value = '';
      mailBody.value = '';
      mailHint.textContent = '';

      applyMailBadges();

      showMailToast('邮件已发送');
      mailTimer = window.setTimeout(hideMailToast, 1800);
    }, 1000);
  }

  /* ---------- 主持人回信的唯一判定入口 ----------
     玩家可以反复寄信，寄的时候一律「发送成功」；但信有没有回音，
     只由这一个函数说了算。四个条件全部满足才补发回信：
       ① 玩家给 henryclark@ww.com 寄过信（localStorage 标记，刷新不丢）；
       ② 已经通关过任意一个普通结局（hwu.normalEndingCleared）；
       ③ 收件箱里还没有这封（isMailReceived，避免重复落信 / 重复响铃）；
       ④ 稿件 3 的 A~H 已经收齐。
     任何一处不满足都静默返回 false —— 不写存档、不提示、不亮红点。
     调用点只有四处：寄信后、收词后（unlockKeyword）、点「重新撰稿」
     那一刻（leaveEndingForRewrite）、以及每次打开邮件模块（renderMail）。
     这四个点覆盖了「条件可能在别后才齐」的全部情况。 */

  function setHostMailSent() {
    try { localStorage.setItem(MAIL_HOST_SENT_KEY, 'true'); } catch (e) {}
  }

  /* 老存档（第 70 项那一版）写的是 '1'，新档写 'true'，两种都认 */
  function isHostMailSent() {
    try {
      const v = localStorage.getItem(MAIL_HOST_SENT_KEY);
      return v === 'true' || v === '1';
    } catch (e) { return false; }
  }

  /* 前 8 个词是否一个不缺（顺序无所谓，只认字母） */
  function hasHostReplyKeywords() {
    const list = unlockedByScope[3] || [];
    return HOST_REPLY_LETTERS.every(letter => list.indexOf(letter) >= 0);
  }

  function checkHostMailCondition() {
    if (!isHostMailSent()) return false;
    if (!isNormalEndingCleared()) return false;
    if (isMailReceived('mail-host')) return false;
    if (!hasHostReplyKeywords()) return false;

    if (!receiveMail('mail-host')) return false;

    /* 红点 / 收件箱就地重画走现有链路；提示音和聊天共用同一个音频，
       不新做弹窗，也不抢当前正在看的页面 */
    refreshMailAfterReceive();
    playChatSound();

    return true;
  }

  /* 进入邮件模块时刷新一次状态（红点 / 附件角标 / 当前子页面）
     这里不再调 prefillCompose：第一次打开时三个框都是空的，
     主题与正文要等收件人填对，才由 syncComposePreset() 补上。 */
  function renderMail() {
    /* 进模块先补一次判定：条件可能在别处才齐（收齐第 8 个词、刚通关完
       一个普通结局、或者刷新前就已经寄出）—— 这样「信早就寄了，
       只是当时还差一口气」的存档，一打开邮件就能收到回信。 */
    checkHostMailCondition();
    applyMailBadges();
    setMailView(mailView || 'compose');
  }


  /* ============================================================
     六、资讯浏览器：页面库 / 星标收藏 / 搜索引擎
     ------------------------------------------------------------
     PAGE_HTML      : pageId → 页面 HTML（唯一的渲染来源，浏览器与
                      资料库共用，保证「点卡片重开」和「搜索打开」一致）
     PAGE_META      : pageId → 资料库卡片元数据（标题 / 主色 / 图标 / 站点）
     SEARCH_INDEX   : 搜索词 → pageId（查询词包含任一搜索词即命中，取最长）
     bookmarkedPages: localStorage 里的收藏数组，只存 pageId
     ============================================================ */

  /* ---------- IMDb 词条页（Happy With Us）：完整深色页面结构 ---------- */

  const IMDB_PAGE =
    '<div class="imdb-page">' +

      /* ===== 顶部导航栏 ===== */
      '<header class="imdb-nav">' +
        '<span class="imdb-logo">IMDb</span>' +
        '<div class="imdb-nav-right"><span>待看清单</span><span>登录</span></div>' +
      '</header>' +

      /* ===== Hero：海报 + 剧集信息 ===== */
      '<section class="imdb-hero">' +

        '<div class="imdb-poster">' +
          '<img src="assets/image/imdb/poster.png" alt="Happy With Us 海报">' +
        '</div>' +

        '<div class="imdb-hero-info">' +
          '<h1 class="imdb-title">Happy With Us</h1>' +
          '<p class="imdb-sub">电视剧 · 1988–2010 · TV-Y · 30分钟</p>' +

          '<div class="imdb-tags"><span>家庭</span><span>儿童</span></div>' +

          '<p class="imdb-plot">要相信，兔子博士（Dr.R）总是对的。</p>' +

          '<p class="imdb-stars"><span class="imdb-label">主演</span>' +
            '<span class="imdb-star-name">兔子博士</span>' +
            '<span class="imdb-comma">,</span>' +
            '<span class="imdb-star-name">蓝犬哥哥</span>' +
            '<span class="imdb-comma">,</span>' +
            '<span class="imdb-star-name">狮子姐姐</span>' +
          '</p>' +

          '<p class="imdb-stars"><span class="imdb-label">制片人</span>' +
            '<span class="imdb-star-name">维恩·肖</span>' +
          '</p>' +

          '<div class="imdb-actions">' +
            '<button type="button" class="imdb-btn-primary">+ 添加到待看清单</button>' +
            '<button type="button" class="imdb-btn-ghost">标记为已看</button>' +
          '</div>' +
        '</div>' +

      '</section>' +

      /* ===== 底部：主要演员 ===== */
      '<section class="imdb-bottom">' +

        '<div class="imdb-col imdb-col-cast">' +
          '<div class="imdb-sec-head"><h2>主要演员</h2><span>查看全部</span></div>' +
          '<ul class="imdb-cast-list">' +
            '<li class="imdb-cast-item">' +
              '<img class="imdb-ava" src="assets/image/imdb/actor_henry.jpeg" alt="亨利·克拉肯">' +
              '<div class="imdb-cast-text"><b>亨利·克拉肯</b><small>兔子博士</small></div>' +
            '</li>' +
            '<li class="imdb-cast-item">' +
              '<img class="imdb-ava" src="assets/image/imdb/actor_taylor.jpeg" alt="泰勒·布朗">' +
              '<div class="imdb-cast-text"><b>泰勒·布朗</b><small>狮子姐姐</small></div>' +
            '</li>' +
            '<li class="imdb-cast-item">' +
              '<img class="imdb-ava" src="assets/image/imdb/actor_gordon.jpeg" alt="戈登·惠特克">' +
              '<div class="imdb-cast-text"><b>戈登·惠特克</b><small>蓝犬哥哥</small></div>' +
            '</li>' +
          '</ul>' +
        '</div>' +

      '</section>' +

      /* 这一页只从时光机的搜索结果列表进来，页内不再放「← 返回搜索结果」：
         那个按钮原本是普通搜索的 data-action="back"，在这里既回不到列表，
         也不该把玩家拽回普通搜索 —— 所以连节点都不生成。
         要离开就靠浏览器后退，或从菜单栏重新打开时光机。 */

    '</div>';

  /* ============================================================
     页面正文库：pageId → HTML
     ------------------------------------------------------------
     其中 'tutorial-doc' 不是真正的网页，而是资料库默认附带的
     内部手册：它同样以 pageId 的形式存进 PAGE_HTML / PAGE_META /
     bookmarkedPages，因此可以像普通收藏一样被抓取与取消收藏。
     ============================================================ */

  const TUTORIAL_PAGE_ID = 'tutorial-doc';

  /* ---------- LinkWriter 内部使用手册（资料库默认收藏） ---------- */

  const TUTORIAL_HTML =
    '<article class="tdoc">' +

      /* ===== 文档抬头 ===== */
      '<header class="tdoc-brand">' +
        '<span class="tdoc-mark" aria-hidden="true">LW</span>' +
        '<span class="tdoc-brand-txt"><b>LinkWriter</b><small>调查终端</small></span>' +
        '<span class="tdoc-secret">内部资料 · 请勿外传</span>' +
      '</header>' +

      '<h1 class="tdoc-title">LinkWriter调查终端-快速上手指南</h1>' +
      '<p class="tdoc-sub">该版本为测试版，不代表最终开发成果，请勿外传</p>' +

      '<ul class="tdoc-meta">' +
        '<li><b>文档编号</b><span>LW-MAN-001</span></li>' +
        '<li><b>发布版本</b><span>v0.8.1</span></li>' +
        '<li><b>更新日期</b><span>2026-09-04</span></li>' +
        '<li><b>密级</b><span>普通</span></li>' +
      '</ul>' +

      '<p class="tdoc-lead">欢迎使用由公司研发部负责开发的辅助插件。本手册会带你在五分钟内熟悉终端的六个模块，以便快速上手调查工作。</p>' +

      /* ===== 01 功能说明 ===== */
      '<h2 class="tdoc-h2"><i>01</i>功能说明</h2>' +

      '<ul class="tdoc-list">' +

        '<li class="tdoc-item" data-tone="indigo">' +
          '<span class="tdoc-ico" aria-hidden="true">🗨️</span>' +
          '<div class="tdoc-txt">' +
            '<b>实时通讯</b>' +
            '<p>联系部门内外同事，协同合作</p>' +
          '</div>' +
        '</li>' +

        '<li class="tdoc-item" data-tone="blue">' +
          '<span class="tdoc-ico" aria-hidden="true">🌐</span>' +
          '<div class="tdoc-txt">' +
            '<b>资讯浏览器</b>' +
            '<p>全网搜索。输入关键词后按回车（或点“搜索”），结果会覆盖在右侧主区域。' +
              '本插件已默认开启外文网页实时翻译。</p>' +
            '<p class="tdoc-note">在阅读资讯、百科或邮件时，' +
              '系统会自行甄别出有价值的人名、地名或事件名，请手动收集词语，' +
              '系统将同步至写稿器内部。</p>' +
          '</div>' +
        '</li>' +

        '<li class="tdoc-item" data-tone="amber">' +
          '<span class="tdoc-ico" aria-hidden="true">📥</span>' +
          '<div class="tdoc-txt">' +
            '<b>邮箱</b>' +
            '<p>用于发出和接收关键人物发来的邮件及附件。</p>' +
          '</div>' +
        '</li>' +

        '<li class="tdoc-item" data-tone="green">' +
          '<span class="tdoc-ico" aria-hidden="true">📚</span>' +
          '<div class="tdoc-txt">' +
            '<b>收藏夹</b>' +
            '<p>点击任意网页右上角的“星标（☆）”即可收藏。' +
              '收藏夹会保存网页快照，方便随时调阅。</p>' +
          '</div>' +
        '</li>' +

        '<li class="tdoc-item" data-tone="purple">' +
          '<span class="tdoc-ico" aria-hidden="true">📝</span>' +
          '<div class="tdoc-txt">' +
            '<b>写稿器</b>' +
            '<p>根据收集的线索素材撰写并发布报道。</p>' +
          '</div>' +
        '</li>' +

        '<li class="tdoc-item" data-tone="slate">' +
          '<span class="tdoc-ico" aria-hidden="true">⏳</span>' +
          '<div class="tdoc-txt">' +
            '<b>网页时光机</b>' +
            '<p>随时查看已折叠、被删除的历史网页快照。</p>' +
          '</div>' +
        '</li>' +

      '</ul>' +

      /* ===== 02 小贴士 ===== */
      '<h2 class="tdoc-h2"><i>02</i>小贴士</h2>' +
      '<ul class="tdoc-tips">' +
        '<li>为了防止工作太过无聊，我们还特意加入了音乐功能，单击暂停，双击切歌，' +
          '觉得贴心记得给研发部一个好评（笑）</li>' +
      '</ul>' +

      '<footer class="tdoc-foot">本手册由 LinkWriter 研发部维护 · 内部资料，请勿外传</footer>' +

    '</article>';

  /* ============================================================
     现代新闻门户文章页（cnn-news-page）
     ------------------------------------------------------------
     所有现代门户稿（Lost Media / 八卦头条 / 星火三条 / 蓝星两条…）共用这一套骨架：
       导航 → 面包屑 → 红竖线大标题 → 元数据 → 配图 → 正文
     配色只有黑、灰、红（#cc0000）；正文里所有词都是普通文本，
     没有链接、没有下划线、没有蓝色，玩家自己复制去搜。
     ============================================================ */

  const CNN_CATS = ['世界', '美洲', '亚洲', '欧洲', '中东', '科技', '文化', '社会', '体育', '视频'];

  const CNN_ICO_WATCH =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2"/>' +
    '<path d="M10.3 9.4 15.4 12l-5.1 2.6z"/></svg>';

  const CNN_ICO_SEARCH =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
    '<line x1="20" y1="20" x2="16.3" y2="16.3"/></svg>';

  /* o = { section, trail[], reading, title, updated, author,
           imgClass, imgSrc, caption, paragraphs[], related, commentCount, comments[] } */
  function cnnNewsPage(o) {
    const cats = CNN_CATS.map(c =>
      '<span class="cnn-cat' + (c === o.section ? ' is-active' : '') + '">' + c + '</span>'
    ).join('');

    /* 面包屑：世界 › 文化 · 12 分钟阅读 */
    const crumb = o.trail.map((t, i) =>
      (i ? '<span class="cnn-crumb-sep">&rsaquo;</span>' : '') + '<span>' + t + '</span>'
    ).join('') +
      '<span class="cnn-crumb-dot">&middot;</span>' +
      '<span>' + o.reading + ' 分钟阅读</span>';

    const body = o.paragraphs.map(p => '<p>' + p + '</p>').join('');

    const comments = (o.comments && o.comments.length)
      ? '<section class="cnn-comments">' +
          '<h3>' + (o.commentTitle || '评论') + ' <span>' + o.commentCount + '</span></h3>' +
          o.comments.map(c =>
            '<div class="cnn-comment">' +
              '<div class="cnn-comment-body">' +
                '<b>' + c[0] + '</b>' +
                '<p>' + c[1] + '</p>' +
              '</div>' +
            '</div>'
          ).join('') +
        '</section>'
      : '';

    return '<div class="cnn-news-page">' +

      /* ===== 1. 顶部导航 ===== */
      '<header class="cnn-nav">' +
        '<span class="cnn-logo">今日视界</span>' +
        '<nav class="cnn-cats">' + cats + '</nav>' +
        '<div class="cnn-nav-right">' +
          '<span class="cnn-nav-item">' + CNN_ICO_WATCH + '观看</span>' +
          '<span class="cnn-nav-item">' + CNN_ICO_SEARCH + '搜索</span>' +
          '<span class="cnn-login">登录</span>' +
        '</div>' +
      '</header>' +

      '<article class="cnn-article">' +

        /* ===== 2. 面包屑 + 阅读时间 ===== */
        '<p class="cnn-breadcrumb">' + crumb + '</p>' +

        /* ===== 3. 红色竖线 + 大标题 ===== */
        '<div class="cnn-title-wrap">' +
          '<span class="cnn-rule" aria-hidden="true"></span>' +
          '<h1 class="cnn-title">' + o.title + '</h1>' +
        '</div>' +

        /* ===== 4. 元数据 ===== */
        '<p class="cnn-meta">' +
          '<span>更新于 ' + o.updated + '</span>' +
          '<span class="cnn-meta-sep" aria-hidden="true"></span>' +
          '<span>作者：' + o.author + '</span>' +
        '</p>' +

        /* ===== 5. 配图 =====
           传了 imgSrc 就上真图：容器高度照旧（clamp 240~400），
           图片 object-fit: cover 填满，比例不同时裁的是边角、不拉伸。
           没传就退回原来的 CSS 渐变占位图，老页面一行都不用改。
           has-img 用来关掉 ::before 的渐层与 ::after 的斜纹
           （两者都是绝对定位，否则会盖在静态的 <img> 上面）。
           onerror 兜底：图真挂了就摘掉 has-img 并移除 <img>，
           退回渐变底，而不是留一个裂图图标。 */
        '<figure class="cnn-image">' +
          (o.imgSrc
            ? '<div class="cnn-ph has-img">' +
                '<img src="' + o.imgSrc + '" alt="配图" ' +
                  'onerror="this.parentNode.classList.remove(\'has-img\');this.remove();">' +
              '</div>'
            : '<div class="cnn-ph ' + o.imgClass + '" aria-hidden="true"></div>') +
          '<figcaption>' + o.caption + '</figcaption>' +
        '</figure>' +

        /* ===== 6. 正文 ===== */
        '<div class="cnn-content">' + body + '</div>' +

        (o.related ? '<p class="cnn-related">' + o.related + '</p>' : '') +
        comments +

      '</article>' +
    '</div>';
  }

  /* ============================================================
     2004 年古早门户新闻页（news-2004-page）
     ------------------------------------------------------------
     o = { title, source, date, paragraphs[], related[] }
     排版语言照抄 2004 年的门户：深蓝通栏、黑体大标题居中、
     宋体正文首行缩进、右侧 200px 相关新闻框、蓝色下划线链接。
     正文只做最简单的 <p> 拼接；[[关键词]] 与 *加粗* 不在这里处理，
     统一交给 renderPage() 里的 applyRichText() 兜底，
     和 cnn-news-page / tabloid-news-page 走的是同一条链路。
     ============================================================ */

  const NEWS_2004_NAV = ['首页', '新闻', '社会', '娱乐', '科技', '游戏', '论坛', '邮箱'];

  function news2004Page(o) {
    const nav = NEWS_2004_NAV.map((t, i) =>
      (i ? '<span class="n04-nav-sep">|</span>' : '') +
      '<span class="n04-nav-link">' + t + '</span>'
    ).join('');

    /* 正文：一段一个 <p>，不额外包 span，富文本留给 applyRichText */
    const body = o.paragraphs.map(p => '<p>' + p + '</p>').join('');

    /* 右侧「相关新闻」：200px 定宽，老式方框 + 浅灰标题条。
       条目只做文本占位 —— 不包 <a>、不带 href、不挂 data-page，
       点了没有任何反应，就是老报纸侧栏里那种「标题在、链接早死了」的样子。 */
    const related = (o.related && o.related.length)
      ? '<div class="n04-side">' +
          '<h2 class="n04-side-title">相关新闻</h2>' +
          '<ul class="n04-side-list">' +
            o.related.map(t => '<li>' + t + '</li>').join('') +
          '</ul>' +
        '</div>'
      : '';

    return '<div class="news-2004-page">' +

      /* ===== 1. 深蓝通栏 ===== */
      '<div class="n04-nav">' +
        '<div class="n04-nav-inner">' +
          '<span class="n04-logo">今日视界</span>' +
          nav +
        '</div>' +
      '</div>' +

      '<div class="n04-shell">' +

        /* ===== 2. 大标题 / 元数据 / 贯穿虚线 ===== */
        '<h1 class="n04-title">' + o.title + '</h1>' +
        '<p class="n04-meta">' +
          '<span>来源：' + o.source + '</span>' +
          '<span>时间：' + o.date + '</span>' +
        '</p>' +
        '<hr class="n04-rule">' +

        /* ===== 3. 右侧相关新闻（float，正文自动绕排） ===== */
        related +

        /* ===== 4. 正文 ===== */
        '<div class="n04-body">' + body + '</div>' +

        /* 清浮动：相关新闻比正文高时，页脚不能贴着浮动框往上跑 */
        '<div class="n04-clear"></div>' +

        /* ===== 5. 页脚 ===== */
        '<hr class="n04-foot-rule">' +
        '<p class="n04-copy">版权所有 未经授权禁止转载 &copy; 2004 今日视界</p>' +

      '</div>' +
    '</div>';
  }

  /* ============================================================
     传统报纸电子版（old-news-page）
     ------------------------------------------------------------
     o = { title, author, date, paragraphs[], related[] }
     用在三篇旧稿上：2004 恶魔暗示、2004 多州联合警告、2009 义工投诉。
     版式照着晚报电子版抄：深红报头「今日视界」、灰色信息条、
     蓝色黑体大标题、居中署名 + 一条虚线、宋体正文首行缩进两字。
     与 cnn-news-page（现代门户）/ tabloid-news-page（娱乐小报）/
     news-2004-page（2004 老门户）互不影响：外层只有一个
     .old-news-page，内部类名统一带 on- 前缀。
     正文里的 [[关键词]] / *加粗* / <br> 照旧不在这里处理，
     交给 renderPage() 里的 applyRichText() 兜底，
     和三套现有模板走的是同一条链路。
     ============================================================ */

  function oldNewsPage(o) {
    /* 正文段落。末尾那句免责声明不参与首行缩进：
       .on-body p 是 text-indent: 2em，靠 .on-disclaimer 自己盖回 0（见 css）。 */
    const body = (o.paragraphs || []).map(p => '<p>' + p + '</p>').join('') +
      '<p class="on-disclaimer">文章转载自外网，内容仅供参考</p>';

    /* 底部「相关新闻」：报纸常见的延伸阅读栏，双线压顶。
       没有 related 就整块不出，页面以正文收尾。 */
    const related = (o.related && o.related.length)
      ? '<div class="on-related">' +
          '<h2 class="on-related-title">相关新闻</h2>' +
          '<ul class="on-related-list">' +
            o.related.map(item => '<li>' + item + '</li>').join('') +
          '</ul>' +
        '</div>'
      : '';

    return '<div class="old-news-page">' +

      /* ===== 1. 深红报头 ===== */
      '<div class="on-header">' +
        '<div class="on-header-title">今日视界</div>' +
        '<div class="on-header-links">' +
          '<span>返回本版</span>|<span>版面导航</span>|<span>标题导航</span>|<span>在线订阅</span>' +
        '</div>' +
      '</div>' +

      /* ===== 2. 灰色信息条：翻版 / 日期 / 字号 ===== */
      '<div class="on-nav-bar">' +
        '<div class="on-prev">下一篇 ▶</div>' +
        '<div class="on-date">' + o.date + '</div>' +
        '<div class="on-tools">放大 ⨁ &nbsp; 缩小 ⊖ &nbsp; 默认</div>' +
      '</div>' +

      /* ===== 3. 版心 ===== */
      '<div class="on-content-wrap">' +
        '<h1 class="on-title">' + o.title + '</h1>' +
        '<div class="on-meta">转载来源 ' + o.author + ' &nbsp;&nbsp; 来源：今日视界</div>' +
        '<div class="on-body">' + body + '</div>' +
        related +
      '</div>' +

    '</div>';
  }

  /* ============================================================
     百科词条页（baike-page）
     ------------------------------------------------------------
     o = { title, sub, facts[[名, 值]...], lead, paragraphs[] }
     排版照中文百科：蓝色页眉、黑体大标题、右侧信息表格、
     正文首段不缩进、其余段落首行缩进两字。
     正文里的 [[关键词]] / *强调* 仍然交给 applyRichText 解析。

     结构分四层，各管一件事：
       .baike-page       —— 极浅蓝灰的页面底色（整页铺满）
       .baike-head       —— 百科蓝导航条，白字
       .baike-body       —— 只负责给白卡片留一圈边距
       .baike-card-wrap  —— 白底圆角卡片，标题 / 信息表格 / 正文都装在里面
       最底下的返回按钮统一走 .global-page-back（全站同一个组件）。
     ============================================================ */

  function baikePage(o) {
    const facts = (o.facts || [])
      .map(f => '<tr><th>' + f[0] + '</th><td>' + f[1] + '</td></tr>')
      .join('');

    const body = (o.paragraphs || []).map(p => '<p>' + p + '</p>').join('');

    return '<div class="baike-page">' +

      '<header class="baike-head">' +
        '<span class="baike-logo">百科</span>' +
        '<span class="baike-crumb">' + (o.crumb || '首页 &gt; 词条') + '</span>' +
      '</header>' +

      '<div class="baike-body">' +

        '<div class="baike-card-wrap">' +

          '<h1 class="baike-title">' + o.title + '</h1>' +
          (o.sub ? '<p class="baike-sub">' + o.sub + '</p>' : '') +

          '<div class="baike-summary">' +
            (facts ? '<table class="baike-facts"><tbody>' + facts + '</tbody></table>' : '') +
            '<p class="baike-lead">' + (o.lead || '') + '</p>' +
          '</div>' +

          '<div class="baike-content">' +
            '<h2 class="baike-h2">简介</h2>' +
            '<div class="baike-text">' + body + '</div>' +
          '</div>' +

        '</div>' +

      '</div>' +

      '<div class="global-page-back"><span class="back-link" data-action="back">← 返回搜索结果</span></div>' +

    '</div>';
  }

  /* ============================================================
     娱乐八卦小报页（tabloid-news-page）
     ------------------------------------------------------------
     和 cnn-news-page 共用同一批字段（title / paragraphs / comments），
     排版语言却完全相反：大红通栏、荧光黄高亮、米黄纸底、
     一句一段的超短段落、随时插话的「小编有话说」、彩框歪评论。
     正文仍然交给 applyRichText，*强调* 与 [[关键词]] 照常生效。
     ============================================================ */

  const TB_QUIPS = [
    '这瓜保熟吗？小编已经把小板凳搬到楼下便利店了，坐等当事人回应。',
    '以上内容均来自网友爆料，小编只负责把瓜端上桌，真伪自辨。'
  ];

  /* "2026 年 9 月 13 日 10:20" → "2026-09-13" */
  function tbDate(v) {
    const raw = String(v == null ? '' : v);
    const m = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (!m) return raw;
    const pad = n => (String(n).length < 2 ? '0' + n : String(n));
    return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  }

  /* 按句号断句：只在标签外、且不处于任何内联标签内部时才断，
     否则会把 <span> 切成两半，页面直接崩掉。 */
  function tbSentences(html) {
    const s = String(html == null ? '' : html);
    const out = [];
    let buf = '';
    let depth = 0;
    let inTag = false;
    let closing = false;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (inTag) {
        buf += ch;
        if (ch === '>') {
          inTag = false;
          depth += closing ? -1 : 1;
          if (depth < 0) depth = 0;
        }
        continue;
      }

      if (ch === '<') {
        inTag = true;
        closing = s[i + 1] === '/';
        buf += ch;
        continue;
      }

      buf += ch;
      if ((ch === '。' || ch === '！' || ch === '？') && depth === 0) {
        let j = i + 1;
        while (j < s.length && '”」』）】'.indexOf(s[j]) >= 0) { buf += s[j]; j++; }
        i = j - 1;
        out.push(buf);
        buf = '';
      }
    }

    if (buf.trim()) out.push(buf);
    return out;
  }

  /* 小报没有大段落：按句攒到 34 个字就换一段 */
  function tbShortParagraphs(paragraphs) {
    const out = [];
    (paragraphs || []).forEach(p => {
      let buf = '';
      tbSentences(p).forEach(sentence => {
        buf += sentence;
        if (buf.length >= 34) { out.push(buf); buf = ''; }
      });
      if (buf) out.push(buf);
    });
    return out;
  }

  /* 把指定短语包成 <mark>：只处理标签外的文字，每个短语只标第一次 */
  function tbMark(html, phrases) {
    if (!phrases || !phrases.length) return html;
    const left = new Set(phrases.filter(Boolean));

    return String(html).split(/(<[^>]+>)/).map(seg => {
      if (!seg || seg.charAt(0) === '<') return seg;
      let s = seg;
      left.forEach(ph => {
        const i = s.indexOf(ph);
        if (i < 0) return;
        s = s.slice(0, i) + '<mark>' + ph + '</mark>' + s.slice(i + ph.length);
        left.delete(ph);
      });
      return s;
    }).join('');
  }

  function tbQuip(text) {
    return '<aside class="tb-say"><b>小编有话说</b><span>' + text + '</span></aside>';
  }

  /* o = { tag, title, updated, author, imgClass, imgSrc, caption, paragraphs[],
           marks[], quips[], related, commentCount, comments[] } */
  function tabloidNewsPage(o) {
    const tag = o.tag || '【独家爆料】';
    const quips = (o.quips && o.quips.length) ? o.quips : TB_QUIPS;

    const paras = tbShortParagraphs(o.paragraphs).map(p => tbMark(p, o.marks));

    let body = '';
    paras.forEach((p, i) => {
      body += '<p>' + p + '</p>';
      if (i === 1) body += tbQuip(quips[0]);
    });
    /* 收尾再来一句，像极了公众号文末的「结语」 */
    body += tbQuip(quips.length > 1 ? quips[quips.length - 1] : TB_QUIPS[1]);

    const comments = (o.comments && o.comments.length)
      ? '<section class="tb-comments">' +
          '<h3>网友炸锅了！<span>' + o.commentCount + ' 条</span></h3>' +
          o.comments.map(c =>
            '<div class="tb-comment">' +
              '<span class="tb-ava" aria-hidden="true">' + String(c[0]).charAt(0) + '</span>' +
              '<div class="tb-cbody">' +
                '<b>' + c[0] + '</b>' +
                '<p>' + c[1] + '</p>' +
              '</div>' +
            '</div>'
          ).join('') +
        '</section>'
      : '';

    return '<div class="tabloid-news-page">' +

      /* ===== 1. 大红通栏 ===== */
      '<header class="tb-nav">' +
        '<span class="tb-logo">娱乐前线</span>' +
        '<nav class="tb-tags">' +
          '<span class="tb-tag">吃瓜</span>' +
          '<span class="tb-tag">热搜</span>' +
          '<span class="tb-tag">扒一扒</span>' +
        '</nav>' +
      '</header>' +

      /* 通栏下面那条荧光黄的免责声明，纯粹为了更吵 */
      '<p class="tb-strip">★ 本栏目内容均由网友爆料整理，未经当事人证实 ★ 吃瓜要理性，转发需谨慎 ★</p>' +

      '<article class="tb-article">' +

        /* ===== 2. 标签 + 巨型标题 + 灰色署名 ===== */
        '<header class="tb-head">' +
          '<p class="tb-kicker"><span>' + tag + '</span></p>' +
          '<h1 class="tb-title"><span>' + o.title + '</span></h1>' +
          '<p class="tb-meta">' +
            '<span>文/' + o.author + '</span>' +
            '<i aria-hidden="true">·</i>' +
            '<span>' + tbDate(o.updated) + '</span>' +
          '</p>' +
        '</header>' +

        /* ===== 3. 「独家画面」 =====
           同一套规则：有 imgSrc 上真图，没有就是原来的渐变底。
           .tb-image 的边框、红色错位投影、以及::after 那个「独家画面」红标
           都挂在容器上，所以照片会被包进同一个版式里，红标压在照片左上角。
           图挂了同样只摘掉 <img>，渐变底与红标自动回位。 */
        '<figure class="tb-image">' +
          (o.imgSrc
            ? '<div class="tb-ph">' +
                '<img src="' + o.imgSrc + '" alt="配图" ' +
                  'onerror="this.remove();">' +
              '</div>'
            : '<div class="tb-ph ' + (o.imgClass || '') + '" aria-hidden="true"></div>') +
          '<figcaption>' + o.caption + '</figcaption>' +
        '</figure>' +

        /* ===== 4. 正文 ===== */
        '<div class="tb-content">' + body + '</div>' +

        (o.related ? '<p class="tb-related">' + o.related + '</p>' : '') +
        comments +

      '</article>' +

      /* ===== 5. 文末返回 =====
         小报页之前漏了这一块，玩家点进稿子后只能靠浏览器的后退。
         和其它正文页共用 .global-page-back / data-action="back"，
         结构一字不差；只是纸是米黄的，白胶囊会糊成一片，
         所以颜色换成「白底 + 2px 纯黑描边 + 4px 红色硬投影」（见 css）。
         放在 .tabloid-news-page 里面：这层是 flex 列，.tb-article 占满剩余高度，
         按钮自然落到纸的底部。 */
      '<div class="global-page-back"><span class="back-link" data-action="back">← 返回搜索结果</span></div>' +

    '</div>';
  }

  /* ============================================================
     搜索结果列表页（sr-page）
     ------------------------------------------------------------
     三个搜索页（欢乐好时光 / Happy With Us / 兔子哥哥）共用这一套骨架：
       统计行（含星标位）→ 结果卡片（网址 / 标题 / 摘要）
     列表到底就结束，底部不再拼接任何「相关搜索」区块。
     卡片只有三种点击语义：data-page 打开页面、data-error 弹提示、
     什么都没有就是一条纯展示结果。摘要里命中搜索词的片段用 <b> 加粗。
     标题为「（该消息已折叠）」的条目走第四条路：渲染成一行灰字，
     不带网址 / 摘要 / tabindex，也不参与任何点击。
     ============================================================ */

  /* 被折叠的结果：只有一行字，没有网址、没有摘要、没有点击。
     这是内容侧的「空白」，不是一条可以打开的网页。 */
  const FOLDED_TITLE = '（该消息已折叠）';

  function srEscapeRe(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 摘要高亮：优先整串命中（"Happy With Us" 只包一次），
     整串不中再退回逐词匹配；纯 ASCII 的词加 \b 边界，避免 "us" 命中 "because"。 */
  function srHighlight(text, query) {
    const q = String(query || '').trim();
    const tokens = q.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);

    const parts = [];
    const push = str => {
      const esc = srEscapeRe(str);
      if (/^[A-Za-z0-9]+$/.test(str)) parts.push('\\b' + esc + '\\b');
      else parts.push(esc);
    };

    if (tokens.length > 1) push(q);
    tokens.forEach(t => push(t));
    if (!parts.length) return text;

    return String(text).replace(
      new RegExp('(' + parts.join('|') + ')', 'gi'),
      '<b class="sr-hl">$1</b>'
    );
  }

  /* ============================================================
     加密档案：一条特殊的搜索结果（it.locked === true）
     ------------------------------------------------------------
     未解锁：整条只剩一个血红色的方块，里面只有锁和一行字。
             不渲染网址（域名里的 sealed 也是线索）、不渲染标题、
             不渲染摘要 —— 一个字都不泄露。
     已解锁：直接变回一条普通新闻结果，挂着 data-page 可以点开。

     解锁状态每次渲染都现读一次 localStorage，所以解锁之后不论
     是新开搜索、返回上一页，还是刷新，这一条都会立刻变回正常形态。
     ============================================================ */
  const ROBERT_UNLOCK_KEY = 'hwu.robertUnlocked';

  /* 解封之后要还原成的那条新闻结果（原本被封在搜索页里的真身） */
  const ROBERT_SEALED_ITEM = {
    url: 'records.utah.gov/sealed/2010/0823',
    title: '罗伯特·本内特被逮捕入狱',
    lines: ['2010 年 8 月 23 日 · 犹他州：一名儿童剧演员在其住所被警方带走。'],
    page: 'news-2010-robert'
  };

  function isRobertSealOpen() {
    try { return localStorage.getItem(ROBERT_UNLOCK_KEY) === 'true'; } catch (e) { return false; }
  }

  /* o = { query, elapsed, count, items[], empty } */
  function searchPage(o) {
    const q = o.query || '';
    const items = o.items || [];
    const count = typeof o.count === 'number' ? o.count : items.length;

    /* 普通结果条：网址 + 标题 + 摘要，能点就挂 data-page */
    const renderItem = it => {
      const url = String(it.url || '');
      const cut = url.indexOf('/');
      const site = cut > 0 ? url.slice(0, cut) : url;
      const path = cut > 0 ? url.slice(cut) : '';

      const attrs =
        (it.page ? ' data-page="' + it.page + '"' : '') +
        (it.error ? ' data-error="' + it.error + '"' : '');

      const cls = 'sr-item' + (it.dead ? ' is-dead' : '') + (attrs ? ' is-clickable' : '');

      const lines = (it.lines || [])
        .map(l => '<p class="sr-snippet">' + srHighlight(l, q) + '</p>')
        .join('');

      return '<article class="' + cls + '"' + attrs + (attrs ? ' tabindex="0"' : '') + '>' +
          '<p class="sr-url">' +
            '<span class="sr-site">' + site + '</span>' +
            '<span class="sr-path">' + path + '</span>' +
          '</p>' +
          '<h3 class="sr-title">' + it.title + '</h3>' +
          lines +
        '</article>';
    };

    const cards = items.map(it => {
      /* 折叠条目：一行灰字，任何可点的东西都不生成 */
      if (it.folded || it.title === FOLDED_TITLE) {
        return '<div class="sr-folded" aria-label="该消息已折叠">' + FOLDED_TITLE + '</div>';
      }

      /* 加密档案：未解锁只给一块红方块；解锁后按普通新闻条渲染 */
      if (it.locked === true) {
        if (isRobertSealOpen()) return renderItem(ROBERT_SEALED_ITEM);

        return '<article class="sr-item is-red-locked" data-locked="robert"' +
          ' tabindex="0" role="button" title="' + (it.error || '访问受限 · 绝密档案') + '"' +
          ' aria-label="访问受限 · 绝密档案">' +
            '<div class="lock-box">' +
              '<span class="lock-glyph" aria-hidden="true">🔒</span>' +
              '<span class="lock-text">访问受限 · 绝密档案</span>' +
            '</div>' +
          '</article>';
      }

      return renderItem(it);
    }).join('');

    /* 两种「空」：
       ① noResult —— 浏览器搜索两步都没命中，只给一句结论，不带任何推荐语；
       ② empty   —— 页面自己设计好的空状态说明（如「兔子哥哥」的搜索结果页）。 */
    let empty = '';

    if (o.noResult) {
      empty =
        '<div class="sr-empty">' +
          '<p class="sr-empty-title">未找到相关结果。</p>' +
        '</div>';
    } else if (o.empty) {
      empty =
        '<div class="sr-empty">' +
          '<p class="sr-empty-title">未找到相关结果</p>' +
          '<p class="sr-empty-text">' + o.empty + '</p>' +
        '</div>';
    }

    return '<div class="sr-page">' +
      '<div class="sr-head">' +
        '<p class="sr-stats">找到 ' + count + ' 条结果（用时 ' +
          (o.elapsed || '0.04') + ' 秒）</p>' +
        '<span class="sr-starslot" id="searchStarSlot"></span>' +
      '</div>' +
      '<div class="sr-list">' + cards + '</div>' +
      empty +
    '</div>';
  }

  /* ============================================================
     搜索：特里博·特内布（三条结果，第三条是加密档案）
     ------------------------------------------------------------
     前两条是「认识他的人」给的线索：家长投诉的义工新闻、起名求助帖。
     第三条是 2010 年那篇逮捕新闻 —— 标题里直接写着真名，所以整条被封存：
     未解锁时它只是一个血红方块（不泄露标题、摘要、域名），
     点开先进验证界面，答出真名才变回普通新闻条并打开（见 submitRobertName）。

     用函数而不是一次性字符串，是因为解锁之后要把这一页重新生成一遍，
     下次再搜、再返回时，第三条就已经是正常的新闻条了。
     ============================================================ */
  function buildTreborSearch() {
    return searchPage({
      query: '特里博·特内布',
      elapsed: '0.05',
      count: 3,
      items: [
        {
          url: 'web.archive.org/web/2009/news/volunteer',
          title: '多名家长投诉社区义工行为不端，同事辩护：他有着金子般的心',
          lines: ['2009 年 8 月 10 日 · 今日美国：常在周末邀请孩子们到其家中吃烧烤。'],
          page: 'news-2009-jimmy'
        },
        {
          url: 'oldtv-bbs.net/thread/2290',
          title: '【求助】我想要起一个足够酷炫的艺名！',
          lines: ['楼主：我不想说出自己的真实姓名，那样别人就会把“查尔斯”跟“小丑”联系在一起。'],
          page: 'forum-2007-name'
        },
        {
          locked: true,
          error: '该档案已封存：需要先验证嫌疑人真实姓名。'
        }
      ]
    });
  }

  /* ============================================================
     搜索：邪典（两条结果）
     ------------------------------------------------------------
     索引里「邪典」是主词，「邪典节目」只作长尾别名，两个词落到同一页，
     所以 query 不再写死成某一个词：玩家打哪个，摘要就按哪个标亮。
     唯一要注意的是长词整串在摘要里不一定出现（「邪典节目」只写在
     标题上），直接拿整串去比会一条都标不亮，所以高亮统一收窄到
     最核心的「邪典」两个字。

     只放两条：警告新闻 + 反驳帖。2004 年那篇《儿童节目暗藏恶魔暗示？》
     被收进了 WB_ONLY_PAGES，普通浏览器这里既不放卡片、也不留 data-page，
     玩家只能从时光机搜「Happy With Us」从存档列表里点开。

     写成函数而不是一次性字符串，和 buildTreborSearch 同理：
     每次搜索时按这次实际输入的词重新生成一份，覆盖回 PAGE_HTML。
     ============================================================ */
  function buildCultSearch(rawQuery) {
    const typed = String(rawQuery == null ? '' : rawQuery).trim();
    const hl = typed.indexOf('邪典') >= 0 ? '邪典' : (typed || '邪典');

    return searchPage({
      query: hl,
      elapsed: '0.07',
      count: 2,
      items: [
        {
          url: 'web.archive.org/web/2004/news/warning',
          title: '美国多州青少年保护中心发出联合警告：小心电视中的“邪典节目”！',
          lines: ['2004 年 11 月 12 日 · 今日美国：警惕部分儿童节目中潜藏的“邪典”倾向。'],
          page: 'news-warning'
        },
        {
          url: 'oldtv-bbs.net/thread/3341',
          title: '【讨论】《HWU》变成邪典了？造谣的人能不能歇一歇',
          lines: ['楼主：你们一定要给所有童年回忆加上“黑深残”的帽子？'],
          page: 'forum-cult'
        }
      ]
    });
  }

  /* ============================================================
     生活 / 求助帖（life-post）
     ------------------------------------------------------------
     和论坛长文共用同一张通栏白纸，只是末尾多一串「楼层」回复。
     目前只服务木子餐厅那条店庆帖：正文是广告，回复里藏着人名线索。
     ============================================================ */

  function lifePostPage(o) {
    const replies = (o.replies || []).map(r => {
      if (r.op) {
        return '<p class="ar-floor is-op"><b>楼主回复</b><span>' + r.text + '</span></p>';
      }
      return '<p class="ar-floor"><b>' + r.floor + '楼</b><span>' + r.text + '</span></p>';
    }).join('');

    return '<div class="article-page is-forum">' +
      '<h1 class="article-title">' + o.title + '</h1>' +
      '<div class="article-meta">' +
        '<span class="article-tag">求助</span>' +
        '<span>' + o.author + '</span>' +
        '<span>' + o.date + '</span>' +
        '<span>' + (o.place || '南谷') + '</span>' +
      '</div>' +
      '<div class="article-content">' +
        o.paragraphs.map(p => '<p>' + p + '</p>').join('') +
      '</div>' +
      '<section class="article-replies">' +
        '<div class="ar-head"><b>全部回复</b><span>' + (o.replies || []).length + '</span></div>' +
        replies +
      '</section>' +
    '</div>' +
    '<div class="global-page-back"><span class="back-link" data-action="back">← 返回搜索结果</span></div>';
  }

  /* ============================================================
     2002 · 星火工作室（FrontPage 草台风 / 极度廉价）
     ------------------------------------------------------------
     一个不懂设计的人用 FrontPage 拖出来的个人站：
     纯青色底、纯黄 / 纯粉方块、5px 纯黑直角边框、
     3px 纯黑描边 + 4px 错位硬阴影、全页居中、歪歪扭扭的旋转、
     方块拼的像素星星，以及永远停在 000069 的访客计数器。
     同一份 HTML 同时供「浏览器搜索」与「时光机 2002 快照」使用，
     样式全部锁在 .spark-studio-page / .snap-2002 下，不污染别的页面。
     ============================================================ */

  /* 创始人名字：只改这一处，卡片正文会跟着变 */
  const SPARK_FOUNDER = '韦德';

  const SPARK_STUDIO_HTML = `
<div class="spark-studio-page">
  <span class="spk-star spk-star-a" aria-hidden="true"></span>
  <span class="spk-star spk-star-b" aria-hidden="true"></span>

  <header class="spk-hero">
    <p class="spk-kicker">SPARK STUDIO &middot; EST. 2001 &middot; 本地最酷的互动娱乐小组</p>

    <h1 class="spk-logo">
      <span class="spk-logo-cn">星火工作室</span>
      <span class="spk-logo-en">SPARK STUDIO</span>
    </h1>

    <div class="spk-cd" aria-hidden="true"><i></i></div>

    <p class="spk-ticker">★ 2002 全新改版 ★ 全站最酷 ★ 不接受反驳 ★</p>
  </header>

  <section class="spk-slogan">
    <h2>梦想是最好的助燃剂</h2>
    <p class="spk-slogan-en">DREAMS ARE THE BEST FUEL</p>
  </section>

  <section class="spk-about">
    <h2 class="spk-about-title">关于我们</h2>
    <p class="spk-about-text">创始人 ${SPARK_FOUNDER} 寄语：只要心里有火，哪里都是舞台。星火工作室致力于创造最懂年轻人的互动娱乐内容……</p>
    <p class="spk-about-sign">—— SPARK STUDIO 全体成员</p>
  </section>

  <footer class="spk-foot">
    <p class="spk-counter">您是第 <b>000069</b> 位点燃梦想的人</p>
    <p class="spk-copy">© 2002 星火工作室 &middot; 最佳浏览分辨率 1024&times;768 &middot; IE 6.0</p>
  </footer>
</div>`;

  /* ============================================================
     现代 · 星火游戏有限公司官网（不是快照，是「现在」的官网）
     ------------------------------------------------------------
     和 2002 年那份手工作坊式的涂鸦站形成直接的视觉断裂：
     深色金属 #1a1a1a → #2a2a2a 底、亮银 #e2e8f0 文字、亮橙 #f97316 只做点缀，
     金属拉丝 + 顶光、1px 发丝边框、严格三栏对称网格、大面积深色留白。
     全站无倾斜、无描边、无动效 —— 资本的秩序感。
     选择器全部锁在 .spark-corp-page 下，不污染别的页面。
     ============================================================ */

  const SPARK_CORP_HTML = `
<div class="spark-corp-page">

  <!-- ===== 顶部导航：银色 Logo + 四个静默的栏目 ===== -->
  <header class="sc-nav">
    <div class="sc-nav-inner">
      <span class="sc-logo">
        <span class="sc-logo-mark" aria-hidden="true">SG</span>
        <span class="sc-logo-text">星火游戏<em>SPARK GAMES</em></span>
      </span>
      <nav class="sc-nav-links">
        <span class="sc-nav-link is-active">首页</span>
        <span class="sc-nav-link">产品矩阵</span>
        <span class="sc-nav-link">投资者关系</span>
        <span class="sc-nav-link">加入我们</span>
      </nav>
    </div>
  </header>

  <!-- ===== Hero：拉丝金属区块，居中大标语 ===== -->
  <section class="sc-hero">
    <div class="sc-hero-inner">
      <p class="sc-hero-kicker">SPARK GAMES CO., LTD.</p>
      <h1 class="sc-hero-title">为了玩家的笑脸</h1>
      <div class="sc-hero-rule" aria-hidden="true"></div>
      <p class="sc-hero-sub">全球领先的互动娱乐提供商，用心创造快乐。</p>
    </div>
  </section>

  <!-- ===== 商业成就：三格数据板 ===== -->
  <section class="sc-stats">
    <div class="sc-stats-inner">
      <div class="sc-stat">
        <p class="sc-stat-num">10<span class="sc-stat-cn">亿</span><span class="sc-stat-plus">+</span></p>
        <p class="sc-stat-label">全球累计玩家</p>
        <p class="sc-stat-en">GLOBAL PLAYERS</p>
      </div>
      <div class="sc-stat">
        <p class="sc-stat-num">50<span class="sc-stat-plus">+</span></p>
        <p class="sc-stat-label">年度畅销游戏</p>
        <p class="sc-stat-en">ANNUAL BEST-SELLERS</p>
      </div>
      <div class="sc-stat">
        <p class="sc-stat-num">2025<span class="sc-stat-unit">年</span></p>
        <p class="sc-stat-label">全球营收破百亿</p>
        <p class="sc-stat-en">ANNUAL REVENUE</p>
      </div>
    </div>
  </section>

  <!-- ===== 企业简介 ===== -->
  <section class="sc-about">
    <div class="sc-about-inner">
      <div class="sc-about-head">
        <p class="sc-sec-label">关于我们 / ABOUT US</p>
        <h2 class="sc-sec-title">星火游戏有限公司</h2>
      </div>
      <div class="sc-about-body">
        <p class="sc-about-text">星火游戏有限公司成立于 2005&nbsp;年，致力于为全球玩家提供高品质的游戏体验。我们拥有顶尖的研发团队与全球化发行网络，业务覆盖 12 个国家和地区，累计服务用户超过 10&nbsp;亿。</p>
        <p class="sc-about-text">公司以长期主义为经营原则，持续投入自研引擎与工业化生产管线，通过稳定的版本节奏与本地化运营，为全球玩家提供可持续的内容与服务。</p>
      </div>
    </div>
  </section>

  <!-- ===== 页脚：一行版权 + 一排法务链接 ===== -->
  <footer class="sc-foot">
    <div class="sc-foot-inner">
      <p class="sc-foot-copy">© 2025 星火游戏有限公司 版权所有</p>
      <div class="sc-foot-links">
        <span>隐私政策</span>
        <span>服务条款</span>
        <span>联系我们</span>
        <span>投资者关系</span>
      </div>
    </div>
  </footer>

</div>`;

  const PAGE_HTML = {

    /* ---------- 0) 内部手册：不参与网页搜索，只从资料库进入 ---------- */
    'tutorial-doc': TUTORIAL_HTML,

    /* ---------- 0.6) 星火游戏有限公司官网（现代，非快照） ---------- */
    'spark-corp': SPARK_CORP_HTML,

    /* ---------- 0.5) 2002 星火工作室（与时光机快照共用同一份 HTML） ---------- */
    'spark-studio': SPARK_STUDIO_HTML,

    /* ---------- 0) 首页：现代新闻门户（未搜索状态） ---------- */
    'home':
      '<div class="news-home">' +

        /* ===== 顶部吸顶导航 ===== */
        '<header class="nh-nav">' +
          '<div class="nh-nav-inner">' +
            '<div class="nh-logo">今日视界</div>' +
            '<nav class="nh-cats">' +
              '<span class="nh-cat active" data-cat="首页">首页</span>' +
              '<span class="nh-cat" data-cat="社会">社会</span>' +
              '<span class="nh-cat" data-cat="科技">科技</span>' +
              '<span class="nh-cat" data-cat="娱乐">娱乐</span>' +
              '<span class="nh-cat" data-cat="游戏">游戏</span>' +
            '</nav>' +
            /* 搜索框与搜索按钮由 renderPage() 从浏览器工具条搬进来 */
            '<div class="nh-nav-actions" id="homeSearchSlot"></div>' +
          '</div>' +
        '</header>' +

        '<div class="nh-body">' +

          /* ================= 左栏 70% ================= */
          '<main class="nh-main">' +

            /* ---- 头条：Lost Media 特稿 ---- */
            '<section class="nh-hero" data-page="lost-media" role="button" tabindex="0">' +
              '<div class="nh-hero-cover">' +
                '<span class="nh-chip">深度 · Lost Media</span>' +
                '<h1 class="nh-hero-title">Lost Media：互联网时代，我们距离冰山有多近？</h1>' +
                '<p class="nh-hero-sub">那些找不到完整影像的节目，正被一群陌生人一点点拼回来。</p>' +
              '</div>' +
            '</section>' +

            /* ---- 普通新闻 ---- */
            '<div class="nh-list">' +

              '<article class="nh-item is-link" data-page="ent-zhang-rumor" role="button" tabindex="0">' +
                '<span class="nh-thumb" style="background-image:linear-gradient(135deg,#db2777,#f9a8d4)"></span>' +
                '<div class="nh-item-text">' +
                  '<h3>情歌王子张文举深陷婚变疑云？深夜密会红发辣妹，甜蜜互动全被拍！</h3>' +
                  '<p>据网民爆料，9 月 12 日深夜，有网友夜跑时撞见疑似张文举的男子与一名红发女子先后走出餐厅，' +
                    '两人一路有说有笑。</p>' +
                  '<div class="nh-item-meta"><span>娱乐</span><i>·</i><span>八卦</span><i>·</i><span>2 小时前</span></div>' +
                '</div>' +
              '</article>' +

              '<article class="nh-item" data-fold="1">' +
                '<span class="nh-thumb" style="background-image:linear-gradient(135deg,#f59e0b,#fb923c)"></span>' +
                '<div class="nh-item-text">' +
                  '<h3>今日气温回升，适宜出行</h3>' +
                  '<p>气象台预计，未来三天本市以晴到多云为主，最高气温将回升至 24℃，' +
                    '早晚温差较大，提醒市民适时增减衣物。</p>' +
                  '<div class="nh-item-meta"><span>民生</span><i>·</i><span>46 分钟前</span></div>' +
                '</div>' +
              '</article>' +

              '<article class="nh-item is-link" data-page="news-spark-seal" role="button" tabindex="0">' +
                '<span class="nh-thumb" style="background-image:linear-gradient(135deg,#b91c1c,#ef4444)"></span>' +
                '<div class="nh-item-text">' +
                  '<h3>“星火”公章争夺战：创始人与董事长的博弈闹剧何时休！</h3>' +
                  '<p>星火游戏创始人韦德率人带走数十枚公章并宣布接管公司，董事长钱德勒方面随即报警，宣布公章作废。</p>' +
                  '<div class="nh-item-meta"><span>科技</span><i>·</i><span>今日</span></div>' +
                '</div>' +
              '</article>' +

              '<article class="nh-item" data-fold="1">' +
                '<span class="nh-thumb" style="background-image:linear-gradient(135deg,#0d9488,#5eead4)"></span>' +
                '<div class="nh-item-text">' +
                  '<h3>地铁 4 号线将增开夜间班次</h3>' +
                  '<p>自下月起，4 号线末班车由 23:00 延后至 23:40，周五、周六再加开两列区间车，' +
                    '方便夜间返程乘客。</p>' +
                  '<div class="nh-item-meta"><span>城市</span><i>·</i><span>3 小时前</span></div>' +
                '</div>' +
              '</article>' +

            '</div>' +
          '</main>' +

          /* ================= 右栏 30% ================= */
          '<aside class="nh-side">' +

            '<section class="nh-panel">' +
              '<div class="nh-panel-head"><h3>热门排行榜</h3><span>实时</span></div>' +
              '<ol class="nh-rank">' +
                '<li data-fold="1"><b>1</b><span>台风外围云系今夜影响本市，明日有阵雨</span></li>' +
                '<li data-fold="1"><b>2</b><span>新一代折叠屏上手：折痕几乎消失</span></li>' +
                '<li data-fold="1"><b>3</b><span>老城区改造第二批名单公布，共 14 个片区</span></li>' +
                '<li data-fold="1"><b>4</b><span>国产动画电影票房突破 12 亿</span></li>' +
                '<li data-fold="1"><b>5</b><span>高校新增 21 个本科专业，人工智能方向最多</span></li>' +
              '</ol>' +
            '</section>' +

            '<section class="nh-panel">' +
              '<div class="nh-panel-head"><h3>猜你喜欢</h3><span>编辑推荐</span></div>' +
              '<div class="nh-like">' +
                '<div class="nh-like-item" data-fold="1">' +
                  '<span class="nh-like-thumb" style="background-image:linear-gradient(135deg,#6366f1,#a5b4fc)"></span>' +
                  '<span>秋季养生：多吃这几种白色食物，润肺又去燥</span>' +
                '</div>' +
                '<div class="nh-like-item" data-fold="1">' +
                  '<span class="nh-like-thumb" style="background-image:linear-gradient(135deg,#78716c,#d6d3d1)"></span>' +
                  '<span>周末去哪儿？城市周边小众旅游路线推荐</span>' +
                '</div>' +
                '<div class="nh-like-item" data-fold="1">' +
                  '<span class="nh-like-thumb" style="background-image:linear-gradient(135deg,#0ea5e9,#7dd3fc)"></span>' +
                  '<span>新手跑步指南：如何挑选一双合适的跑鞋</span>' +
                '</div>' +
              '</div>' +
            '</section>' +

            /* 最后浏览：由 renderRecentHistory() 填充最近 3 个详情页 */
            '<section class="news-side-card" id="recent-history-card">' +
              '<div class="nh-panel-head"><h3>🕒 最后浏览</h3></div>' +
              '<div class="nr-list" id="recent-history-list"></div>' +
            '</section>' +

          '</aside>' +

        '</div>' +
      '</div>',

    /* ---------- 1) 失落媒体：现代新闻门户文章页 ---------- */
    'lost-media': cnnNewsPage({
      section: '文化',
      trail: ['世界', '文化'],
      reading: 9,
      title: 'Lost Media：互联网时代，我们距离冰山有多近？',
      updated: '2026 年 9 月 14 日 10:20',
      author: '叫我大佬A',
      imgClass: 'is-archive',
      imgSrc: 'assets/image/news/lost-media.jpg',
      caption: '（图：插图 / 今日视界）',
      paragraphs: [
        '在网上，我们通常有一句话：“互联网永不忘记。”似乎我们无论上传什么光怪陆离的小众东西上去，' +
        '都能永久保存在因特奈特这颗巨大的、彼此连接的电子大脑上，让你的孩子、你孩子的孩子，' +
        '都能看见你在中二病时期发的 QQ 空间，尝试理解一个十七岁的少年在失恋后的痛苦黑化。',

        '但，果真如此吗？',

        '视频网站上的投稿数量以秒为单位不断增加，但在十年之后，留存下来的数量恐怕没有如今的十分之一。' +
        '事实上，除了那些及其有趣、或在在整活史上青史留名的作品，其余的绝大部分数据并不会被互联网记住，' +
        '成为某次服务器焕新过程中需要清除的冗余，被轻飘飘一键删除。',

        '那些被互联网删除的数据，也就变成了所谓的 Lost Media——“失传媒体”。',

        '但电脑忘了，人脑还没有。有那么一群人，坚信这些曾被人创造出来的艺术品并非凭空失踪，' +
        '而是被扫到了某个不起眼的角落；只要有人愿意寻找，就一定能找到其中的蛛丝马迹。',

        '艺术自古便具有一种神奇的魔法，能够以自身启发他人创造更多的艺术，追寻艺术的过程也是一样。' +
        '上至 86 版的《画皮》电影，下到残酷猎奇的《Go For A Pouch》，' +
        '人们一直在追寻着那一种神秘的魅力，不遗余力地挥舞镐头，往冰山下挖得更深。'
      ],
      commentCount: 7,
      comments: [
        ['谁家琵琶在扰民', '你好冰山，我是你的泰坦尼克'],
        ['AAA工地扛水泥刘姐', '时代发展太快了，有些东西失传了就是失传了，怎么也找不回来'],
        ['谁偷了我的充电宝', '这期有意思，给大佬赞一个'],
        ['布鲁克塞牙', '寻找的过程比结果要有意思，就像“pouch”这种可能根本不存在的东西，' +
          '人们争论的聊天记录说不定已经超过原作的价值了，有些谜语解开了才发现原来是低质脑筋急转弯，那还不如不解开'],
        ['美丽童年', '借楼，有没有人看过一档主角是紫色兔子的儿童节目'],
        ['辩护CDV', '楼上眼熟，难道是这个帖子的帖主吗？' +
          '<span class="cnn-inline-link" data-page="forum-lost">【求助】有谁看过这档节目吗？</span>'],
        ['就是爱凑热闹886', '我小时候借我舅舅的 mp3 听歌，记得有一首歌特别好听，' +
          '后来有了电脑想去网上继续听，结果怎么也找不到，mp3 也丢了']
      ]
    }),

    /* ---------- 1.5) 2004 版门户新闻页：只挂在时光机存档里，正式线索暂不挂 ---------- */
    'news-2004-demo': news2004Page({
      title: '本地少儿节目《欢乐好时光》下月起重播 电视台称「应观众要求」',
      source: '今日视界·社会新闻',
      date: '2004 年 8 月 16 日 09:12',
      paragraphs: [
        '本报讯（记者 林素芬）昨天下午，记者从市电视台了解到，已经停播一年多的少儿节目' +
        '《欢乐好时光》将于下月三日起在工作日傍晚时段重播，每周五期，每期三十分钟。',

        '电视台节目编排科的一位工作人员表示，此次重播是「应广大观众要求」。' +
        '据其介绍，节目停播之后，编辑部几乎每周都能收到观众来信，其中不少是家长代孩子写的。',

        '市民王女士在电话里告诉记者，她的女儿今年六岁，最喜欢节目里的兔子哥哥，' +
        '「每天吃完饭就守在电视机前面，一听到片头音乐就笑」。' +
        '她说，很多家长都把这段守着电视的时光，当成孩子的[[寓教于乐]]。',

        '不过，也有观众对重播持保留意见。一位不愿透露姓名的中学教师说，' +
        '节目停播前曾有过一些「不太好的传闻」，但电视台方面始终没有正面回应。',

        '重播版是否会对原有内容进行删改，电视台方面没有给出明确答复，' +
        '只表示「会严格按照有关规定编排」。'
      ],
      /* 相关新闻：纯版式占位，只放日常民生标题。
         这些条目只是文本，不带 data-page / 不绑点击，点了没有反应。 */
      related: [
        '本市下周将迎来降温，请市民注意增添衣物',
        '秋季养生：多吃这几种白色食物，润肺又去燥',
        '周末去哪儿？城市周边小众旅游路线推荐',
        '新手跑步指南：如何挑选一双合适的跑鞋'
      ]
    }),

    /* ---------- 2) 欢乐好时光：求助帖 + 百科 ---------- */
    'search-hwu': searchPage({
      query: '欢乐好时光',
      elapsed: '0.04',
      count: 2,
      items: [
        {
          url: 'tieba.example.com/p/8823001',
          title: '【求助】有谁看过这档节目吗？',
          lines: ['楼主：小时候看过一部真人节目，主角是一只很大的紫色兔子，还有三只动物……'],
          page: 'forum-lost'
        },
        {
          url: 'baike.example.com/item/欢乐好时光',
          title: '欢乐好时光_百科',
          lines: ['欢乐好时光（原名：Happy With Us），2007 年引进国内，在蓝星少儿频道独播，2010 年停播。'],
          page: 'baike-happy'
        }
      ]
    }),

    /* ---------- 3) Happy With Us：三条结果一律折叠 ----------
       这一页就是「这部剧在普通互联网上还剩下什么」的答案：什么都不剩。
       IMDb、粉丝站快照、2004 年那篇旧新闻，三条全部是空的灰框 ——
       没有网址、没有标题、没有摘要，也没有任何可点的属性，
       玩家只能自己走进时光机去翻。

       被折叠的是「这一页的展示」，不是那些页面本身：
         · 粉丝站快照仍走时光机（2001 / 2010 两年都在）；
         · 2004 年那篇旧新闻《儿童节目暗藏恶魔暗示？》已登记进
           WB_ONLY_PAGES：普通浏览器搜不到、也点不开（搜「邪典」只会
           拿到警告新闻与反驳帖两条），只能从时光机搜「Happy With Us」
           在存档列表里点开；
         · IMDb 词条页已经没有搜索入口：原来「imdb」「happy with us imdb」
           两条映射已删，普通浏览器搜不到、也进不去。页面本身仍留在
           PAGE_HTML 里，普通玩家没有入口，仅供内部核对文案。 */
    'search-imdb': searchPage({
      query: 'Happy With Us',
      elapsed: '0.06',
      count: 3,
      items: [
        { folded: true, title: FOLDED_TITLE },
        { folded: true, title: FOLDED_TITLE },
        { folded: true, title: FOLDED_TITLE }
      ]
    }),

    /* ---------- 4) 视频网站：论坛帖的跳转落点 ---------- */
    'video-site':
      '<div class="page-detail">' +
      '<h3>视频网站 · 播放页</h3>' +
      '<p class="result-url">videoshare.example.com/watch?v=hwu001</p>' +
      '<div class="video-player">' +
      '<div class="vp-screen" id="vpScreen">' +
      '<button class="vp-play" data-action="vp-play">▶</button>' +
      '<p>正在播放：Happy With Us 第一季片头</p>' +
      '</div>' +
      '<div class="vp-controls">' +
      '<button class="btn-ghost" data-action="vp-play">正常播放</button>' +
      '<button class="btn-ghost" data-action="vp-pause">暂停找茬</button>' +
      '<span id="vpSolvedTag"></span>' +
      '</div>' +
      '<p class="vp-hint" id="vpHint">点“暂停找茬”，在关键的一帧上停下来看看。</p>' +
      '<p class="vp-desc">简介中提到，该节目的原版名称是《Happy With Us》。</p>' +
      '</div>' +
      '</div>',

    /* ---------- 4.5) dilidili 视频页（B 站风格 · 纯展示，不含任何解谜交互） ----------
       播放器是原生 <video>：控制条、全屏全交给浏览器，不弹提示、不发线索。
       版面为居中单列：标题 → 播放器 → 操作栏 → 用户信息 → 简介，
       没有搜索框、没有右侧推荐栏。 */
    'video-happy-original':
      '<div class="bili-page">' +

        '<header class="bili-nav">' +
          '<div class="bili-nav-inner">' +
            '<span class="bili-logo">dilidili</span>' +
            '<span class="bili-user"><span class="bili-avatar" aria-hidden="true"></span></span>' +
          '</div>' +
        '</header>' +

        '<main class="bili-main">' +

          '<h1 class="bili-title">【已确认失传】上世纪儿童节目《欢乐好时光》片头曲</h1>' +
          '<p class="bili-meta">播放量 6011 · 弹幕 0 · 2025-02-21 12:38:22</p>' +

          '<div class="bili-player">' +
            '<div class="bili-stage">' +
              '<video class="bili-video" src="assets/video/hwu_opening.mp4"' +
                ' poster="assets/image/poster-default.jpg"' +
                ' controls playsinline webkit-playsinline preload="metadata"></video>' +
            '</div>' +
          '</div>' +

          '<div class="bili-actions">' +
            '<button type="button" class="bili-act"><span class="bili-act-icon" aria-hidden="true">👍</span>点赞 318</button>' +
            '<button type="button" class="bili-act"><span class="bili-act-icon" aria-hidden="true">⭐</span>收藏</button>' +
            '<button type="button" class="bili-act"><span class="bili-act-icon" aria-hidden="true">↗</span>分享</button>' +
          '</div>' +

          '<div class="bili-up">' +
            '<span class="bili-up-avatar" aria-hidden="true"></span>' +
            '<span class="bili-up-info">' +
              '<span class="bili-up-name">该用户已注销</span>' +
              '<span class="bili-up-sub">粉丝 0 · 投稿 0</span>' +
            '</span>' +
          '</div>' +

          '<p class="bili-desc">简介：上世纪九十年代，由蓝星少儿引进的一档儿童教育节目，' +
            '故事围绕虚构地点“萝卜村”，讲述了博学多才的紫色兔子 R 博士（Dr.R）与他的伙伴们，' +
            '为孩子们指点迷津的[[寓教于乐]]单元剧。' +
            '母带资源已失传，本片段转录自观众家中保存的录像带。</p>' +

        '</main>' +

      '</div>',

    /* ---------- 8) 兔子哥哥：查无此人（用来制造挫败感） ---------- */
    'search-bunny': searchPage({
      query: '兔子哥哥',
      elapsed: '0.03',
      empty: '没有与「兔子哥哥」匹配的网页。这个角色的资料似乎已经被清理干净了，' +
             '只剩一些无法确认出处的零散提及。'
    }),

    /* ---------- 8.1) 暗网档案：只有搜到真名才会被打开 ----------
       没有星标、不进最后浏览、不进收藏：它不属于「网页」，
       只是一次被允许看见的卷宗。 */
    'darknet-file':
      '<div class="dn-page">' +
        '<div class="dn-frame">' +

          '<header class="dn-head">' +
            '<p class="dn-warn">【警方机密档案 - 严禁外传】</p>' +
            '<p class="dn-no">CASE NO. 1995-K-0417 &nbsp;/&nbsp; 查阅权限 LEVEL 4</p>' +
          '</header>' +

          '<div class="dn-rows">' +
            '<div class="dn-row">' +
              '<span class="dn-key">嫌疑人</span>' +
              '<span class="dn-val dn-strong">罗伯特·本内特 (Robert Bennett)</span>' +
            '</div>' +
            '<div class="dn-row">' +
              '<span class="dn-key">化名</span>' +
              '<span class="dn-val">Ivan Nomed &nbsp;/&nbsp; 艺名 K.</span>' +
            '</div>' +
            '<div class="dn-row">' +
              '<span class="dn-key">罪名</span>' +
              '<span class="dn-val">涉嫌侵害未成年人、非法持有违禁录像。</span>' +
            '</div>' +
          '</div>' +

          '<section class="dn-detail">' +
            '<p class="dn-key">案件详情</p>' +
            '<p class="dn-text">警方在调查另一起案件时，突袭了嫌疑人的地下室。' +
              '在地下室的暗格中，搜出了数百盘未经备案的录像带。' +
              '经鉴定，这些录像带拍摄于他在《Happy With Us》任职期间，' +
              '录制地点正是节目组后台的封闭隔间。</p>' +
            '<p class="dn-text">卷宗末尾另有一行手写批注，墨迹已经洇开：' +
              '<span class="collectible-keyword" data-key="I" data-text="真正的恶魔">真正的恶魔</span>' +
              '从来不在镜头前。</p>' +
          '</section>' +

          '<p class="dn-foot">卷宗 1995-K-0417 &middot; 承办单位已撤销 &middot; 原始证物未随案移交</p>' +
          '<div class="dn-seal">证据已封存</div>' +

        '</div>' +
      '</div>',

    /* ---------- 8.3) 娱乐头条：稿件 1 的主线新闻 ----------
       正文、评论、可收集词都按剧情稿原样落地；
       「婚内出轨」只在评论里出现一次，点一下即可收进素材库。
       这一篇是首页「今日视界」的次条，必须走严肃的 CNN 版式，
       不能套小报皮 —— 排在头条 Lost Media 下面，样式一旦花掉就穿帮。 */
    'ent-zhang-rumor': cnnNewsPage({
      section: '文化',
      trail: ['娱乐', '八卦'],
      reading: 4,
      title: '情歌王子张文举深陷婚变疑云？深夜密会红发辣妹，甜蜜互动全被拍！',
      updated: '2026 年 9 月 13 日 10:20',
      author: '小娱唠唠嗑',
      imgClass: 'is-street',
      imgSrc: 'assets/image/news/ent-zhang-rumor.jpg',
      caption: '（图：爆料视频截图）',
      paragraphs: [
        '在当代音乐领域，有一位备受瞩目的音乐人，他就是张文举。这位年轻的艺人凭借其深情的音乐和独特的音乐才华，' +
        '在短时间内迅速崭露头角，还被粉丝捧为新一代“情歌王子”。可谁能想到，这样一位才华与颜值兼备的英俊青年，' +
        '最近却在娱乐圈掀起了不小的风波。到底咋回事？小编这就带大家扒一扒！',

        '除了音乐，张文举的感情生活也一直是粉丝津津乐道的话题。据本人描述，张文举的妻子李女士并不是“圈内人”。' +
        '两人自高中相识相知，当年老师的一次座位安排，硬是把两个人牵到了一起。大学毕业后，' +
        '彼时刚在音乐界崭露头角的张文举，面对未来的不确定性，选择和妻子结束五年恋爱长跑，' +
        '在亲朋好友的祝福下步入婚姻殿堂，距今已有八年之久。两人婚后育有一子，生活美满，甜蜜非常。',

        '可谁能想到，这段让无数人艳羡的婚姻，如今似乎突然冒出了“红灯”信号！就在 9 月 12 日，' +
        '有网民爆料向小编称，自己在夜跑时意外撞见了疑似张文举的男性与一红发美女私会。在视频里，' +
        '张文举身着黑色西装，风度翩翩，而那位红发女孩容貌艳丽，穿着牛仔上衣和短裤，倍显火辣身材。' +
        '两人前后走出餐厅，看上去聊得不错，张文举表情兴奋，看上去像是一个顽皮的大男孩，' +
        '而女孩则笑得娇羞又甜美，宛如一对热恋中的小情侣。哎呀呀，这画面，难怪网友们要炸锅！',

        '小编不禁大胆猜测：这难道意味着张文举与素人妻子的婚姻已然破裂？看来，就算是两小无猜的婚姻，' +
        '也未必躲得过现实的重量呀。至于后续如何，咱们只能搬好小板凳，继续等瓜了！'
      ],
      commentTitle: '精选评论',
      commentCount: 5,
      comments: [
        ['站务室不哈', '张文举是谁？'],
        ['荷塘月色', '肯定是<span class="collectible-keyword" data-key="C" data-draft="1" data-text="婚内出轨">婚内出轨</span>' +
          '了，心疼他老婆，男人真是有了钱就变坏'],
        ['山崩海啸', '不是吧，我刚粉上他，这么快就塌房了（裂开）'],
        ['小珊瑚', '这人看着不像啊'],
        ['香水百合子', '那红发美女怎么看着像刘盈莹']
      ]
    }),

    /* ---------- 8.4) 歌词争议：负面词「“风流王子”」的来源 ---------- */
    'ent-zhang-lyrics': tabloidNewsPage({
      section: '文化',
      trail: ['娱乐', '音乐'],
      reading: 3,
      tag: '【深扒】',
      marks: ['再度翻红', '深夜发声', '理性吃瓜'],
      quips: [
        '歌是歌，人是人，小编只想说：别拿歌词当传记。',
        '翻红是好事，被贴上标签就不好玩了。'
      ],
      title: '歌词遐想引争议？张文举否认“风流”标签',
      updated: '2025 年 4 月 25 日 22:06',
      author: '老鬼爱吐槽',
      imgClass: 'is-archive',
      imgSrc: 'assets/image/news/ent-zhang-lyrics.jpg',
      caption: '（图：资料图）',
      paragraphs: [
        '近日，歌手张文举的出道作《我的思念是月亮》在短视频平台再度翻红，连带歌词中关于心动、' +
        '暧昧与感情纠葛的描写也被网友逐句放大解读。部分网友将歌词内容与张文举的私人生活对号入座，' +
        '质疑其笔下那些“风流”桥段是否正是生活写照，“情歌王子”变身' +
        '<span class="collectible-keyword" data-key="D" data-draft="1" data-text="“风流王子”">“风流王子”</span>，' +
        '一时被推上舆论风口。',

        '面对越演越烈的猜测，张文举于深夜发声否认。他在回应中写道：“都是创作，我很爱我的妻子。”' +
        '并强调歌词是艺术表达，不应被过度联想为私人生活的实录，希望外界不要把创作情节与真实感情混为一谈。' +
        '此番回应语气坚定，也让不少粉丝松了一口气，纷纷留言支持：“歌是歌，人是人，别拿歌词当传记。”',

        '不过，也有网友认为，作品一经发布，公众人物难免要面对解读。说到底，出道作翻红本是好事，' +
        '若因歌词遐想被贴上“风流”标签，恐怕也是歌手本人最不想看到的局面，各位还是要理性吃瓜，' +
        '切莫“阴谋论”。'
      ],
      commentCount: 1,
      comments: [
        ['3G冲浪太快了', '这也能起节奏，无聊']
      ]
    }),

    /* ---------- 8.5) 刘盈莹新剧：搜索「刘盈莹」的第一条 ---------- */
    'ent-liu-drama': tabloidNewsPage({
      section: '文化',
      trail: ['娱乐', '电视剧'],
      reading: 2,
      tag: '【独家爆料】',
      marks: ['热度飙升', '还没有做到最好', '值得期待'],
      quips: [
        '夸一句就飘的艺人见多了，这么清醒的还真不多。',
        '剧好不好看另说，这份态度先给个赞。'
      ],
      title: '新剧《问鼎苍穹》大爆，女主刘盈莹谦虚回答：还没有做到最好',
      updated: '2026 年 7 月 21 日 16:40',
      author: '好剧搜搜',
      imgClass: 'is-archive',
      imgSrc: 'assets/image/news/ent-liu-drama.jpg',
      caption: '（图：剧方宣传物料）',
      paragraphs: [
        '近日，由新晋小花刘盈莹领衔主演的新剧《问鼎苍穹》一经播出便热度飙升，收视与口碑双双走高，' +
        '相关话题频频登上热搜，成为当下讨论度最高的剧集之一。剧中，刘盈莹凭借细腻灵动的演技和' +
        '极具感染力的角色塑造，将女主的坚韧、聪慧与柔情演绎得层次分明，收获大批观众好评，' +
        '不少网友直呼“刘盈莹把角色演活了”。',

        '面对剧集大爆和如潮夸赞，刘盈莹依旧保持清醒与谦逊。她在采访中低调回应：“还没有做到最好，' +
        '还有很多需要向前辈学习和提升的地方。”一番话既真诚又圈粉，展现出青年演员难得的踏实与自省。' +
        '据悉，拍摄期间她认真打磨每一场戏，反复揣摩人物情绪，敬业态度也获得剧组一致认可。' +
        '从喜剧演员成功转型，颜值与实力并存，热度与口碑齐飞，相信谦逊努力的刘盈莹未来还会带来更多惊喜，' +
        '值得期待！'
      ],
      commentCount: 2,
      comments: [
        ['莹莹の小狗', '爱生活，爱盈莹，爱每一天'],
        ['金丹大后期', '请支持《问鼎苍穹》，入股不亏！']
      ]
    }),

    /* ---------- 8.6) 刘盈莹专访：正面词「朋友小清」的来源 ----------
       正文不再点明店庆日期（挪走了「9 月 2 日」这个旧钩子）：「9 月 12 日」只活在第 1 篇稿件正文里，由 SEARCH_INDEX 直接把它指到木子餐厅那条帖。 */
    'ent-liu-friend': tabloidNewsPage({
      section: '文化',
      trail: ['娱乐', '人物'],
      reading: 4,
      tag: '【深扒】',
      marks: ['友谊是我人生的河流', '年少丧母', '店庆'],
      quips: [
        '娱乐圈里能把「朋友」两个字说得这么重的，不多了。',
        '有些人只是路过，有些人会一直在。'
      ],
      title: '刘盈莹：友谊是我人生的河流',
      updated: '2026-08-05',
      author: '访谈聚焦',
      imgClass: 'is-archive',
      imgSrc: 'assets/image/news/ent-liu-friend.jpg',
      caption: '（图：受访者供图）',
      paragraphs: [
        '从喜剧舞台转型的新晋小花刘盈莹，近期因影视作品受到关注。在采访中，她很少主动谈及私人生活，' +
        '但提到“友谊”时，她的语气明显柔和下来。她说：“友谊是我人生的河流，载着我渡过很多难熬的时刻。”',

        '刘盈莹年少丧母，父亲外出打工，大多数之后家中只有她一人。谈及那段日子，她坦言，' +
        '邻居家的<span class="collectible-keyword" data-key="A" data-draft="1" data-text="朋友小清">朋友小清</span>' +
        '曾在生活上接济她，也陪她走过情绪最低落的时期：“那时候我不太爱说话，' +
        '很感谢她们能接纳这样一个沉默又倔强的小孩。”',

        '如今她仍会常去小清家经营的餐厅做客，每年店庆是生意最忙的时候，她无论工作再多，' +
        '那一天都会专程去帮忙。对刘盈莹而言，那里不只是吃饭的场所，' +
        '更是一个能让她放松下来的老地方。两人关系一直很好，被问及友谊中最气恼的事，' +
        '刘盈莹更是直言：“她的丈夫太过黏腻，阻碍了我们的相处时间。”',

        '从喜剧演员到新晋小花，刘盈莹的转型并非一蹴而就。她表示，友谊给她的不是戏剧化的鼓励，' +
        '而是一种稳定的支撑，让她在行业变化中保持清醒。采访结束时，她再次提到小清家的餐厅：' +
        '“有空还会去，熟客嘛。”一句轻描淡写，比刻意煽情更显分量。'
      ],
      commentCount: 3,
      comments: [
        ['读一本好书', '👍👍👍'],
        ['宁静致远', '👍👍👍'],
        ['打野购物店', '👍👍👍']
      ]
    }),

    /* ---------- 8.7) 木子餐厅店庆帖：正面词「木子餐厅」的来源 ---------- */
    'life-muzi': lifePostPage({
      title: '木子餐厅周年店庆等你来',
      author: '水边小青蛇',
      date: '2026-09-01',
      place: '南谷',
      paragraphs: [
        '[[木子餐厅]]' +
        '周年店庆来啦！一路走来，感谢每一位顾客的陪伴与支持。为感恩回馈新老朋友，' +
        '店庆期间特别推出多重福利：全场菜品享店庆折扣，招牌菜限时特价，消费满额即赠精美小食或饮品，' +
        '会员充值更享专属加赠！带上家人朋友来木子餐厅，共享美味与欢喜。' +
        '我们坚持用好食材、好味道、好服务回馈每一份信任。周年庆，福利多多，诚意满满，木子餐厅等你来！'
      ],
      replies: [
        { floor: 1, text: '周年快乐！这家餐厅我真是从小吃到大了' },
        { floor: 2, text: '位置可以提前预定吗？我想要个包厢' },
        { op: true, text: '可以的哦' },
        { floor: 3, text: '上次路过去吃了，清丫头做的菜进步很大！姨看好你，早晚超越你老爸！' },
        { floor: 4, text: '悄悄问一嘴，老板夫会来不？' },
        { op: true, text: '嘘' }
      ]
    }),

    /* ---------- 8.8) 三条新的搜索结果页 ---------- */
    'search-zhang': searchPage({
      query: '张文举',
      elapsed: '0.05',
      count: 1,
      items: [
        {
          url: 'ent.newsnow.com/star/20250425',
          title: '歌词遐想引争议？张文举否认“风流”标签',
          lines: ['出道作《我的思念是月亮》再度翻红，歌词被逐句放大解读，张文举深夜发声否认。'],
          page: 'ent-zhang-lyrics'
        }
      ]
    }),

    'search-liu': searchPage({
      query: '刘盈莹',
      elapsed: '0.06',
      count: 2,
      items: [
        {
          url: 'ent.newsnow.com/tv/20260721',
          title: '新剧《问鼎苍穹》大爆，女主刘盈莹谦虚回答：还没有做到最好',
          lines: ['收视与口碑双双走高，刘盈莹在采访中低调回应：“还有很多需要向前辈学习的地方。”'],
          page: 'ent-liu-drama'
        },
        {
          url: 'ent.newsnow.com/people/20260805',
          title: '刘盈莹：友谊是我人生的河流',
          lines: ['她很少谈私人生活，但提到邻居家的朋友小清时，语气明显柔和下来。'],
          page: 'ent-liu-friend'
        }
      ]
    }),

    'search-muzi': searchPage({
      query: '9月12日',
      elapsed: '0.04',
      count: 1,
      items: [
        {
          url: 'bbs.nangu.local/thread/6621',
          title: '木子餐厅周年店庆等你来',
          lines: ['南谷论坛的店庆帖：木子餐厅周年庆，全场菜品享折扣、招牌菜限时特价，充值再送加赠。'],
          page: 'life-muzi'
        }
      ]
    }),

    /* ============================================================
       8.9) 稿件 2（星火游戏权力之争）的全部网页
       ------------------------------------------------------------
       一条新闻带出两个人名，一个人名牵出一段旧事：
         星火游戏 → 公章争夺（韦德 / 钱德勒） + 老玩家的求助帖
         韦德     → 上市分歧的访谈（正面词：理念不合）
         钱德勒   → 豪门私生子风波（负面词：自私自利）
                    + 地下室的创业回忆（正面词：志投意合）
       求助帖 3 楼再补一个负面词：作威作福。
       正文里的 [[ ]] 由 applyRichText 统一解析成可点的蓝字，
       这里只负责把节点文本原样排进去，不改任何页面骨架。
       ============================================================ */

    'news-spark-seal': cnnNewsPage({
      section: '科技',
      trail: ['科技', '公司'],
      reading: 6,
      title: '“星火”公章争夺战：创始人与董事长的博弈闹剧何时休！',
      updated: '2026 年 9 月 14 日 09:12',
      author: '今日说事',
      imgClass: 'is-archive',
      imgSrc: 'assets/image/news/news-spark-seal.jpg',
      caption: '（图：星火游戏总部大楼）',
      paragraphs: [
        '“星火”作为当前国内头部游戏公司之一，成立仅十年便向市场推出数十款热门游戏，其代表作《英雄巅峰》曾一度位居应用商店畅销榜第一。' +
          '然而，这家业绩亮眼的游戏公司近期却陷入一场公章争夺风波，其中原因到底为何，就让编者来陪你们看一看。',

        '谈及“星火”，绕不开公司前最大股东韦德。2014 年，刚刚大学毕业的韦德意气风发，与人合资创办“星火工作室”，' +
          '也就是“星火”的前身。',

        '由于缺乏经验，韦德在早期市场竞争中屡屡受挫，员工相继离开。危急之际，韦德在美国寻求融资时，' +
          '结识了外出游学的钱德勒。两人相谈甚欢，后者决定向韦德投资 100 万元，将濒临破产的“星火工作室”重组，' +
          '成立了如今的“星火游戏”。',

        '此后，面对数亿美元的收购计划，韦德与钱德勒选择放弃套现，继续将“星火”控制在自己手中。两人的目标并非“拿钱走人”，' +
          '而是建立一个商业帝国，这也是“星火”选择在美国上市的重要原因。',

        '至此，一切都是相当美好的画面。',

        '转折出现在 2026 年 4 月。韦德突然发布公开信，宣布离开“星火”，公司结束了和平治理的局面，' +
          '友人钱德勒将成为“星火”的董事长兼 CEO。',

        '这背后的原因，我们不得而知。但是，就在今年 8 月 10 日，韦德在参加某访谈节目时，突然狠狠的把水杯摔倒在地，' +
          '痛斥钱德勒，把他踢出了一手创立的“星火”。',

        '就在闹剧不断上演的时候，昨天，韦德又有了重大动作：',

        '9 月 13 日，韦德进一步采取行动，率 5 名随行人员进入“星火”拿走数十枚公章，并发布《告星火全体员工书》，' +
          '宣布接管“星火”。',

        '韦德称，其已于 9 月 13 日依法召开临时股东会，当选董事长与总经理，全面接管公司；钱德勒仅为董事，无任何职权。' +
          '对此，“星火”方面随即报警，并宣布相关公章作废。',

        '截至目前，事件仍不明朗。围绕公司控制权与公章效力的争议，后续进展仍值得关注。'
      ],
      commentTitle: '精选评论',
      commentCount: 4,
      comments: [
        ['阿斯顿全文', '真实的商战就是如此朴实无华'],
        ['玫瑰山庄', '我真的活在 21 世纪吗？'],
        ['咋混个数学150', '我老板叫我去偷隔壁公司发财树'],
        ['四点半の婚纱', '魔幻现实主义。。。']
      ]
    }),

    'forum-spark': lifePostPage({
      title: '[讨论] 现在的星火已经不是以前的味道了',
      author: '国服第一杨二郎',
      date: '2026-05-18',
      place: '星火玩家社区',
      paragraphs: [
        '楼主 18 年刚开服的时候就入坑了，当时什么也不懂，拿着免费送的杨二郎去打竞技场，被大佬打得差点自闭，' +
          '但还是觉得好玩，一直玩到了现在。但是我要说，自从去年春节版本之后，游戏就跟开了加速键一样，' +
          '氪金内容越来越多，实质更新越来越少。直到这几天看了新闻，才知道韦德佬走了。。唉怎么会这样。。。'
      ],
      replies: [
        { floor: 1, text: '内部消息，去年春节就是韦德佬负责的最后一个版本，某人老早就给他架空了' },
        { op: true, text: '不是为啥啊' },
        { floor: 2, text: '某人不是私生吗，都想在正牌少爷小姐面前证明自己的啦' },
        { floor: 3, text: '楼上韦孝子别演了，钱德勒把他踢了就是对了，整天抱着规矩[[作威作福]]，真当自己是公司土皇帝了？' },
        { op: true, text: '别吵架别吵架' }
      ]
    }),

    'news-wade-talk': cnnNewsPage({
      section: '文化',
      trail: ['文化', '人物'],
      reading: 5,
      title: '对谈明星制作人韦德：星火不会变质，我的前进是为了梦想',
      updated: '2022 年 7 月 4 日 20:30',
      author: '深度访谈101',
      imgClass: 'is-archive',
      imgSrc: 'assets/image/news/news-wade-talk.jpg',
      caption: '（图：受访者供图）',
      paragraphs: [
        '近日，我们 101 与星火创始人、明星制作人韦德进行了一次深度对谈。谈及星火上市，韦德坦言，' +
          '自己与钱德勒曾就上市一事爆发过激烈争吵。双方在公司节奏、资本安排和未来方向上[[理念不合]]。',

        '最终，韦德选择了妥协，但他也提出了一个前提：自己必须对星火的发展保有绝对的主动权。' +
          '韦德说，这不是贪恋权柄或是金钱，而是因为星火从一开始就是他为梦想创立的，' +
          '“如果方向被别人完全拿走，那星火就不是我认识的星火了。”',

        '在韦德看来，上市只是公司发展阶段中的一个工具，而不是终点。他承认资本能带来资源与速度，' +
          '但也强调，星火不能因为上市就丢掉最初做产品的初心。',

        '“星火不会变质，我的前进是为了梦想。”',

        '韦德表示，自己可以接受争论，也可以接受阶段性让步，但在涉及星火长期发展的问题上，他必须保留话语权。',

        '对于玩家群体所担心的“分家”“内斗”问题，韦德并未过多展开，只表示他愿意相信钱德勒，' +
          '也更愿意把注意力放回产品和团队上。',

        '“无论如何，星火都不会因风波而停下脚步。这是我和钱德勒的共识。”',

        '星火接下来仍会围绕核心项目推进，至于这场围绕上市与控制权的分歧最终会走向何处，' +
          '或许正如韦德所说，星火仍在磕磕绊绊中成长，希望外界能够给他们足够的信心。'
      ],
      commentTitle: '精选评论',
      commentCount: 3,
      comments: [
        ['打团不叫我', '抢公章时期前来考古，唏嘘'],
        ['相杀相爱才是top', '完全 be 来的'],
        ['不会写十八号', '那我游戏咋办']
      ]
    }),

    'news-chandler-family': cnnNewsPage({
      section: '社会',
      trail: ['社会', '人物'],
      reading: 4,
      title: '无心之言引争议？钱德勒怒喷家族矛盾，称“真情都是谎言”',
      updated: '2022 年 7 月 4 日 11:08',
      author: '豪门那些事儿',
      imgClass: 'is-street',
      imgSrc: 'assets/image/news/news-chandler-family.jpg',
      caption: '（图：资料图）',
      paragraphs: [
        '海外权贵布鲁斯家族最近真是瓜田大丰收！73 岁的掌权人克莱恩突发脑梗去世，灵堂还没冷清下来，' +
          '钱德勒就被确认为私生子之一，直接把这出豪门继承大戏推上高潮。面对兄姐轮番施压，' +
          '钱德勒也不是省油的灯，据爆料他当场大闹灵堂，场面一度相当难看，争议瞬间拉满。',

        '更让吃瓜群众上头的是，钱德勒早前谈母亲形象的一段旧话被翻了出来：' +
          '“母亲自小对我的要求就很高……如今才知道，真情都是谎言。”',

        '当时听着像随口感慨，如今放在私生子认亲、灵堂风波、家产争端这套连招里，味道立马就不一样了。',

        '网友纷纷开麦：这到底是无心之言，还是早就意有所指？有人觉得他是在暗指家族内部虚情假意，' +
          '也有人吐槽这话说得太绝，私生子的身份难免[[自私自利]]，引得矛盾越烧越旺。',

        '目前布鲁斯家族方面还没有给出更明确的说法，钱德勒也未进一步解释。接下来是握手言和还是继续开撕？' +
          '小编只能说，瓜子先备好，这豪门连续剧怕是还有下文！'
      ],
      commentTitle: '精选评论',
      commentCount: 4,
      comments: [
        ['念头一通达', '外国人？原来他不姓钱啊'],
        ['刑事辩护CDV', '这老头私生子能有一个连了吧'],
        ['香水百合', '不管怎么说，大闹灵堂还是太过了'],
        ['韦德', '已经联系你的公司，请立刻删除关于我司人员不实言论！']
      ]
    }),

    'news-chandler-basement': cnnNewsPage({
      section: '文化',
      trail: ['文化', '访谈'],
      reading: 4,
      title: '也曾挤过地下室！提及创业，钱德勒难免哽咽《悄悄夜谈203期》',
      updated: '2023 年 8 月 21 日 21:00',
      author: '深夜轻悄悄',
      imgClass: 'is-archive',
      imgSrc: 'assets/image/news/news-chandler-basement.jpg',
      caption: '（图：节目组提供）',
      paragraphs: [
        '各位听众朋友们，大家好！本期《悄悄夜谈》邀请到的嘉宾，是星火游戏合伙人钱德勒先生。' +
          '大家一定很好奇，这期节目会聊些什么吧？我们先放出一段文字版，让大家尝尝鲜：',

        'Q：钱德勒先生，您和韦德先生的创业过程中一定发生过不少事情，其中让你印象最为深刻的是什么呢，' +
          '可不可以给大家透露一下？',

        '钱德勒：嗯，让我想想……大概是在地下室的那段日子吧。',

        'Q：诶？钱德勒先生还住过地下室吗？',

        '钱德勒：创业可是很花钱的（笑），我当时就一百万，脑袋一热全投进去了，结果就是很快花光。' +
          '我和韦德兜里空空，家里……也提供不了什么帮助，只能两个人一起挤在地下室里，房租一个月 600 块。',

        '钱德勒：最穷的时候，我们连房租都交不起。但是两个人[[志投意合]]，也不觉得苦。',

        '钱德勒：我就去楼下快餐店刷盘子，一天 80，包一顿饭。我刷盘子的时候，韦德就在家里敲代码，' +
          '等我回来，饭也做好了。',

        'Q：韦德先生还会做饭？做的好吃吗？',

        '钱德勒：特别难吃。',

        '钱德勒：所以后来都是我来做了（笑）。',

        '（以下省略 500 字）',

        '看过先导版，不知道大家是不是对节目更加期待了？记得关注我们，下周六晚上八点，我们不见不散！'
      ],
      commentTitle: '精选评论',
      commentCount: 3,
      comments: [
        ['不合适选拔', '好奇能有多难吃'],
        ['浑身解数办公', '我以为钱德勒很有钱，也要住地下室'],
        ['白话小说', '地下室到底住了多少人']
      ]
    }),

    /* ---------- 三条新的搜索结果页（稿件 2） ---------- */

    /* 星火游戏的搜索结果。
       第一条必须是官网（sparkgames.com → spark-corp）：品牌词搜索的第一条
       就该是官网，玩家点一下即进那座深灰金属的大厂站点，绝不至于「搜了名字
       却找不到公司」。后两条是稿件 2 的线索（公章争夺战 / 论坛吐槽），
       入口只在这里，所以这条结果页不能删、也不能被官网顶掉。 */
    'search-spark': searchPage({
      query: '星火游戏',
      elapsed: '0.07',
      count: 3,
      items: [
        {
          url: 'sparkgames.com',
          title: '星火游戏 SPARK GAMES · 官方网站',
          lines: ['为了玩家的笑脸 —— 全球领先的互动娱乐提供商。公司简介、产品矩阵、投资者关系。'],
          page: 'spark-corp'
        },
        {
          url: 'jrss.example.com/company/20260914',
          title: '“星火”公章争夺战：创始人与董事长的博弈闹剧何时休！',
          lines: ['星火游戏创始人韦德率人带走数十枚公章并宣布接管公司，董事长钱德勒方面随即报警，宣布公章作废。'],
          page: 'news-spark-seal'
        },
        {
          url: 'bbs.sparkfans.net/thread/88231',
          title: '[讨论] 现在的星火已经不是以前的味道了',
          lines: ['老玩家吐槽《星火游戏》春节版本之后更新缩水，评论区里有人提到了韦德佬和某位“私生”股东。'],
          page: 'forum-spark'
        }
      ]
    }),

    'search-wade': searchPage({
      query: '韦德',
      elapsed: '0.05',
      count: 1,
      items: [
        {
          url: 'deep101.example.com/people/20220704',
          title: '对谈明星制作人韦德：星火不会变质，我的前进是为了梦想',
          lines: ['韦德承认与钱德勒就上市一事争吵过，也第一次谈起自己为什么必须保留话语权。'],
          page: 'news-wade-talk'
        }
      ]
    }),

    'search-chandler': searchPage({
      query: '钱德勒',
      elapsed: '0.06',
      count: 2,
      items: [
        {
          url: 'haomen.example.com/wealth/20220704',
          title: '无心之言引争议？钱德勒怒喷家族矛盾，称“真情都是谎言”',
          lines: ['钱德勒被指大闹灵堂，一段谈母亲的旧话也被翻了出来。'],
          page: 'news-chandler-family'
        },
        {
          url: 'qiaoqiaoye.example.com/203/20230821',
          title: '也曾挤过地下室！提及创业，钱德勒难免哽咽《悄悄夜谈203期》',
          lines: ['钱德勒讲了一百万元、600 块房租和楼下的快餐店——那段和韦德同住地下室的日子。'],
          page: 'news-chandler-basement'
        }
      ]
    }),

    /* ============================================================
       稿件 3（Happy With Us 线）的网页群
       ------------------------------------------------------------
       全部按新设定重写：R 博士、蓝犬哥哥、狮子姐姐、小猪笨笨、
       制片人维恩·肖、引进方蓝星少儿。
       关键词分布（A~H 全部落在这些页面里，I 在逮捕新闻里）：
         A 寓教于乐 —— 片头曲视频简介
         B 诽谤造谣 —— 讨论帖正文
         C 因爱而生 —— 奥普拉秀切片简介
         D 一落千丈 —— 塞德里克·肖被捕新闻
         E 恶魔暗示 / F “小众信仰” —— 2004 年「恶魔暗示」旧闻
         G 邪典动画 / H 可疑内容 —— 2004 年多州联合警告
         I 罗伯特·本内特无期徒刑 —— 2010 年被捕新闻
       ============================================================ */

    /* ---------- 3.1) 求助帖：紫兔子的节目叫什么 ---------- */
    'forum-lost': lifePostPage({
      title: '【求助】有谁看过这档节目吗？',
      author: '美丽童年',
      date: '2026-08-20',
      place: '旧时光论坛',
      paragraphs: [
        '我想找一下小时候看过的一部动画片，不，更接近于真人节目吧。' +
        '我记得是在我小学时候看的，大概是十年前，在我姥姥家的炕头上看的。' +
        '我已经记不住名字了，只记得主角应该是一只很大的紫色兔子，说话是男人的声音，' +
        '每集就是跟其他孩子们一块玩，还有一点科普。',

        '哦对，除了兔子之外，还有三只动物，也是五颜六色的特别奇怪，' +
        '一个是狗，一个是狮子，还有一个忘了是什么了。',

        '我一直想重温这档节目，但是始终没有找到，各位有没有看过的知道名字的？'
      ],
      replies: [
        { floor: 1, text: '没印象' },
        { floor: 2, text: '还记得是哪个电视台上看的吗？说不定能找到播放单' },
        { op: true, text: '那时候太小，记不得了' },
        { floor: 3, text: '看楼主的描述，总感觉很熟悉，难道我小时候也看过？' },
        { floor: 4, text: '楼主，是不是这个叫《欢乐好时光》的？' +
          '<span class="article-link" data-page="video-happy-original">片头曲：已确认失传</span>' },
        { op: true, text: '是的！就是这个！我终于知道它的名字了！' },
        { floor: 5, text: '已经成为失传媒体了？这种东西很难找了吧' },
        { floor: 6, text: '去上面的链接围观了一下，画质这么老的译制片，还是儿童节目，感觉找回来的概率太小了' },
        { op: true, text: '唉' },
        { floor: 7, text: '我好像也看过，不过和楼主不太一样，我记得有四只动物来着' },
        { floor: 8, text: '好奇怪，播出时间这么久的节目，怎么会连完整的一集都没有留下来' },
        { op: true, text: '是啊，而且也不知道为什么会停播' }
      ]
    }),

    /* ---------- 3.2) 百科：蓝星少儿 ---------- */
    'baike-lanxing': baikePage({
      title: '蓝星少儿',
      sub: '中文百科 · 电视台词条',
      crumb: '首页 &gt; 电视 &gt; 少儿频道',
      facts: [
        ['中文名', '蓝星少儿'],
        ['外文名', 'Blue Star Children&#39;s Channel'],
        ['创办时间', '2006 年'],
        ['停播时间', '2012 年'],
        ['机构性质', '中外合资少儿节目电视台'],
        ['母公司', '美国蓝星集团'],
        ['主要业务', '少儿节目引进与播出']
      ],
      lead: '蓝星少儿，全称蓝星少儿电视台，是一家中外合资少儿节目电视台，母公司为美国蓝星集团。',
      paragraphs: [
        '该台于 2006 年合作创办，办台初期以大量引进美国蓝星集团旗下儿童节目为主要内容特色，' +
        '后因经营效果未达预期，蓝星集团于 2012 年撤资，蓝星少儿电视台随之关停。'
      ]
    }),

    /* ---------- 3.3) 百科：欢乐好时光 ---------- */
    'baike-happy': baikePage({
      title: '欢乐好时光',
      sub: '中文百科 · 电视节目词条',
      crumb: '首页 &gt; 电视 &gt; 儿童节目',
      facts: [
        ['中文名', '欢乐好时光'],
        ['外文名', 'HappyWithUs'],
        ['节目类型', '儿童节目'],
        ['引进时间', '2007 年'],
        ['播出平台', '蓝星少儿频道'],
        ['播出状态', '已停播'],
        ['停播时间', '2010 年']
      ],
      lead: '欢乐好时光（原名：Happy With Us），是一档引进自海外的儿童节目，' +
        '于 2007 年引进国内，并在蓝星少儿频道独播，2010 年停播。',
      paragraphs: [
        '节目围绕虚构地点“萝卜村”展开，由紫色兔子 R 博士（Dr.R）与蓝犬哥哥、狮子姐姐、小猪笨笨一起，' +
        '在每集三十分钟的篇幅里为孩子们解答一个小问题。'
      ]
    }),

    /* ---------- 3.4) 视频页：奥普拉秀切片 ---------- */
    'video-oprah':
      '<div class="bili-page">' +

        '<header class="bili-nav">' +
          '<div class="bili-nav-inner">' +
            '<span class="bili-logo">dilidili</span>' +
            '<span class="bili-user"><span class="bili-avatar" aria-hidden="true"></span></span>' +
          '</div>' +
        '</header>' +

        '<main class="bili-main">' +

          '<h1 class="bili-title">奥普拉秀切片：第 2003-12-16 期</h1>' +
          '<p class="bili-meta">播放量 2.3 万 · 弹幕 41 · 2023-03-09 20:14:02</p>' +

          /* 这段素材是 4:3（640×480），不能塞进 16:9 的 .bili-stage，
             否则上下会被黑框切掉。直接用它自己的黑底外壳，宽度封顶 800。
             居中与上间距（24px）写在 CSS 的 .bili-main > .video-oprah-wrap 里，
             内联只留宽高与底色，避免内联 margin 把外部的间距规则压掉。 */
          '<div class="video-oprah-wrap" style="width:100%; max-width:800px; background:#000;">' +
            '<video src="assets/video/oprah_interview.mp4"' +
              ' poster="assets/image/poster-default.jpg"' +
              ' controls playsinline webkit-playsinline preload="metadata"' +
              ' style="width:100%; display:block;"></video>' +
          '</div>' +

          '<div class="bili-actions">' +
            '<button type="button" class="bili-act"><span class="bili-act-icon" aria-hidden="true">👍</span>点赞 1832</button>' +
            '<button type="button" class="bili-act"><span class="bili-act-icon" aria-hidden="true">⭐</span>收藏</button>' +
            '<button type="button" class="bili-act"><span class="bili-act-icon" aria-hidden="true">↗</span>分享</button>' +
          '</div>' +

          '<div class="bili-up">' +
            '<span class="bili-up-avatar" aria-hidden="true"></span>' +
            '<span class="bili-up-info">' +
              '<span class="bili-up-name">奥普拉秀精选</span>' +
              '<span class="bili-up-sub">粉丝 12.4 万 · 投稿 318</span>' +
            '</span>' +
          '</div>' +

          '<p class="bili-desc">简介：对话“儿童女王”维恩·肖，她表示：这部作品是[[因爱而生]]，' +
            '孩子是我握笔的动力。</p>' +

        '</main>' +

      '</div>',

    /* ---------- 3.5) 新闻 · 塞德里克·肖被捕（2015） ---------- */
    'news-cedric': cnnNewsPage({
      section: '国际',
      trail: ['世界', '国际'],
      reading: 4,
      title: '塞德里克·肖被捕，警方在其家中发现大量违禁品',
      updated: '2015 年 7 月 16 日 08:36',
      author: '新鲜日报',
      imgClass: 'is-crime',
      imgSrc: 'assets/image/news/news-2015-cedric.jpg',
      caption: '（图：警方通报 / 资料图）',
      paragraphs: [
        '警方通报一起非法藏匿违禁品案件，35 岁男子塞德里克·肖因在其住所内非法藏匿大量违禁品被依法逮捕。',

        '据警方介绍，执法人员在掌握相关线索后，依法对塞德里克·肖的住所进行检查，现场发现大量违禁品。' +
        '经初步清点与鉴定，相关物品已被依法扣押。35 岁的塞德里克·肖随后被带离接受调查。',

        '在警方审讯室内，塞德里克·肖对其行为作出供述，并陈述了个人成长经历。' +
        '他称，父亲在其出生后不久去世，母亲把绝大部分时间投放在工作上，对他疏于照顾，却持续对外表达自己如何爱他。',

        '塞德里克·肖称，他自小在母亲的漠视中成长，母亲失业后，这种情况更加严重，甚至上升到肢体冲突。' +
        '他声泪俱下地控诉母亲，认为自己是因母亲长期的精神虐待而走上歪路。',

        '而在案件处理过程中，其母亲、前知名节目制作人维恩·肖全程保持沉默，未就相关情况作出公开说明，并拒绝假释。' +
        '她表示，自从自己的事业[[一落千丈]]，儿子与自己的关系就变得跟以前不同了：“我很心碎，拒绝回应一切。”'
      ],
      commentCount: 1,
      comments: [
        ['飞跃篮球框', '维恩·肖是谁啊？']
      ]
    }),

    /* ---------- 3.6) 旧新闻（2004）· 恶魔暗示 ---------- */
    'news-demon-2004': oldNewsPage({
      title: '儿童节目暗藏恶魔暗示？揭开《HWU》的秘密',
      author: '艾迪说',
      date: '2004年8月9日 星期一',
      paragraphs: [
        '你看过《HWU》吗？这档播送数十年的节目，几乎霸占了一代人的童年，' +
        '但如果我说，你可能已经在不知不觉中，接收了一整套精心伪装的[[恶魔暗示]]呢？' +
        '别觉得我是危言耸听，且听我慢慢分析，你就会明白这档邪典节目隐藏着怎样的黑暗理论！',

        '首先，这节目的角色配色很值得说道。紫色的兔子，还有蓝色的狗？' +
        '这样完全不会在现实里出现的动物，有着异常的高饱和配色。' +
        '这会本能地吸引那些处于视觉敏感期的孩子，让他们一刻不停地看向这个节目。' +
        '而当目光到齐，这个节目就能将他们想要说的“东西”倾倒给孩子们了。',

        /* 以下三处原本用 <br> 断在同一个 <p> 里，换行不换段 ——
           .on-body p 的 text-indent 只作用在段首，第二行起就顶格了。
           拆成独立数组元素后，每个 <p> 各自缩进两字，排版才对得上。 */
        '还记得兔子博士那句每集都要说的口头禅吗？',
        '“兔子博士总是对的。”',
        '总是？一个角色凭什么“总是对的”？这句话在剧中反反复复出现，让孩子们不要质疑，不要思考，' +
        '兔子博士说的就是真理，这在教育里或许是好用的手段，可要是这只兔子说的，是更为恐怖的东西呢？',

        '让我们回看第二季第十一集。这一集里，孩子们一开始在踢足球，' +
        '但那头粉色的猪显然没有控制好自己的力度，他一脚将足球踢飞，卡在了树上。' +
        '路过的蓝狗过来帮忙，却也没有拿得下来。' +
        '是狮子姐姐领头，让孩子们齐声呼唤兔子博士Dr.R的名字，才让兔子博士到场，将球拿了下来。' +
        '这一集在孩子们亢奋的欢呼声中结束。',

        '乍一看平平无奇，但是，没人觉得“狮子姐姐”这个角色本身，就很奇怪吗？' +
        '一个外表是雄狮的家伙，它的扮演者却是女性？' +
        '在制作组披露的手记中，我们可以发现，这个角色最开始并不是狮子，而是一头山羊。',

        '——巴风特（Baphomet）最著名的雌雄同体形象，山羊头、女性乳房、男性特征并存，是撒旦教的象征。',

        '得知这个信息，我们再回看那一集节目，故事便会截然不同：',

        '人类遇到了麻烦，而撒旦教徒让他们齐声欢呼，召唤了真正的恶魔。',

        '而孩子们还不知道，自己已经成为召唤恶魔的祭品。',

        '顺着这些线索往下挖，矛头最终指向了制片人维恩·肖女士。多方求证得知，' +
        '这位早年丧夫的女性，长期热衷于某些[[“小众信仰”]]，' +
        '节目里那些符号、口令和反常设计，或许正是她向教会递上的投名状。',

        '艾迪说的观众们，我们不敢下定论，但有一点可以肯定：' +
        '在你的孩子试图观看这档节目的时候，一定要小心，小心，再小心，' +
        '《HWU》绝不像它看起来那么天衣无缝！'
      ],
      /* 相关新闻：底部延伸阅读栏只做版式占位。
         原标题会把玩家直接指向「邪典警告」「维恩·肖访谈」等主线线索，
         这里统一换成日常民生标题，纯文本、不带任何跳转。 */
      related: [
        '本市下周将迎来降温，请市民注意增添衣物',
        '秋季养生：多吃这几种白色食物，润肺又去燥',
        '周末去哪儿？城市周边小众旅游路线推荐',
        '新手跑步指南：如何挑选一双合适的跑鞋'
      ],
      /* 网友评论：本页版式（2004 老门户）目前只渲染正文与右侧相关新闻，
         这组数据先随页面一起备着，接上评论样式即可显示，不影响正文。 */
      commentCount: 6,
      comments: [
        ['白胡须', '我的天啊'],
        ['因为去彩虹', '光明会！我就知道！'],
        ['黑色星期天', '开什么玩笑，我可是看着它长大的'],
        ['MMJK', '这一切都是蜥蜴人的计划，就是为了占领整个世界'],
        ['恰恰胡', '他们就连孩子也不放过'],
        ['万一是网图', '我早觉得这玩意的主题曲很诡异了']
      ]
    }),

    /* ---------- 3.7) 旧新闻（2004）· 多州联合警告 ---------- */
    'news-warning': oldNewsPage({
      title: '美国多州青少年保护中心发出联合警告：小心电视中的“邪典节目”！',
      author: '今日美国·社会',
      date: '2004年11月12日 星期五',
      paragraphs: [
        '近日，美国多州青少年保护中心联合发布消费警示，提醒家长及监护人密切关注儿童收视内容，' +
        '警惕部分电视节目中潜藏的“邪典”倾向。警告指出，某些以儿童为目标受众的节目，' +
        '表面包装轻松活泼，实则可能夹杂隐晦的不当暗示、反常的价值导向及易于被未成年人模仿的危险行为，' +
        '对青少年心理健康构成潜在风险。',

        '联合警告称，此类[[邪典动画]]' +
        '往往借助卡通形象、歌舞编排或游戏环节掩盖其真正意图，普通家长在陪看过程中不易察觉。' +
        '部分内容可能刻意模糊现实与虚构的边界，诱导儿童对异常行为产生认同，' +
        '甚至形成类似邪典式的反复观看与模仿冲动。多州保护中心已接到相关家长咨询，' +
        '反映未成年子女在观看某些节目后出现焦虑、恐惧或行为偏差等情况。',

        '警告强调，家长应主动核查子女日常观看的节目来源、制作背景及内容评价，' +
        '对来源不明、评价异常或刻意回避内容说明的儿童节目保持警惕。' +
        '各州青少年保护机构建议，如发现节目存在[[可疑内容]]，' +
        '应及时向平台及监管机构举报，并避免未成年子女继续接触。'
      ],
      /* 相关新闻：纯版式占位，只放日常民生标题。
         原标题会提前点出「恶魔暗示」「邪典」与审查争议，改为无关内容。 */
      related: [
        '本市下周将迎来降温，请市民注意增添衣物',
        '秋季养生：多吃这几种白色食物，润肺又去燥',
        '周末去哪儿？城市周边小众旅游路线推荐',
        '新手跑步指南：如何挑选一双合适的跑鞋'
      ]
    }),

    /* ---------- 3.8) 讨论帖：造谣的人能不能歇一歇 ---------- */
    'forum-cult': lifePostPage({
      title: '【讨论】《HWU》变成邪典了？造谣的人能不能歇一歇',
      author: '不是很开心',
      date: '2005-12-16',
      place: '旧时光论坛',
      paragraphs: [
        '我不明白现在这些人是怎么了？你们一定要给所有童年回忆加上“黑深残”的帽子？' +
        '这是中潮流还是怎么的，米某鼠自杀也好，章某哥自杀也好，给这些东西加上血腥和死亡会让你们惨淡厄生活变得更好受些吗？' +
        '我受够了你们的[[诽谤造谣]]，' +
        '能不能停止这场毫无意义的狂欢？！'
      ],
      replies: [
        { floor: 1, text: '那咋了，又关你什么事？' },
        { floor: 2, text: '你有什么证据这些没发生过吗？' },
        { floor: 3, text: '拜托，别来逗我笑了' },
        { floor: 4, text: '我看你也是邪教的吧！是撒旦指引你过来洗白的？' },
        { op: true, text: '你的脑子才是被洗衣机洗过了！傻X！' }
      ]
    }),

    /* ---------- 3.9) 旧新闻（2009）· 社区义工投诉 ---------- */
    'news-volunteer': oldNewsPage({
      title: '多名家长投诉社区义工行为不端，同事辩护：他有着金子般的心',
      author: '今日美国·社区',
      date: '2009年8月10日 星期一',
      paragraphs: [
        '美国犹他州某社区多名家长集体投诉称，一名社区义工与孩子们过于亲近，' +
        '常在周末邀请孩子们到其家中吃烧烤，引发部分家长对其行为的担忧。',

        '据家长反映，该名义工长期参与社区儿童活动，与孩子们互动频繁，' +
        '但其周末邀请孩子到家中聚餐的做法让一些家长感到不安。' +
        '有家长认为，此类一对多的私人聚会缺乏必要的监督与规范，' +
        '希望社区机构对义工与未成年人接触的边界作出更明确的管理。',

        '对此，该义工的同事吉米·拉克斯（Jimmy）为其辩护称，这个人对大家都很好，外界存在“完全的误解”。' +
        '吉米表示，该义工在社区服务中一直热心负责，所谓投诉并不能反映其真实为人，他“有着金子般的心”。'
      ],
      /* 相关新闻：纯版式占位，只放日常民生标题。
         原标题里的「背景审查」「金子般的心」会把玩家往吉米/罗伯特那条线带，换掉。 */
      related: [
        '本市下周将迎来降温，请市民注意增添衣物',
        '秋季养生：多吃这几种白色食物，润肺又去燥',
        '周末去哪儿？城市周边小众旅游路线推荐',
        '新手跑步指南：如何挑选一双合适的跑鞋'
      ]
    }),

    /* ---------- 3.10) 求助帖：起一个足够酷炫的艺名 ---------- */
    'forum-name': lifePostPage({
      title: '【求助】我想要起一个足够酷炫的艺名！',
      author: '谁在乎？',
      date: '2007-10-16',
      place: '旧时光论坛',
      paragraphs: [
        '朋友们，我即将作为一名职业小丑外出工作，但那妆容太过滑稽，' +
        '我不想说出自己的真实姓名，那样别人就会把“查尔斯（Charles）”跟“小丑”联系在一起。' +
        '但我不知道要怎么起一个好听的艺名，谁能教教我！'
      ],
      replies: [
        { floor: 1, text: '叫“滑稽的香蕉”如何？' },
        { floor: 2, text: '作为同样跟孩子保持近距离接触的工作人员，我必须说，' +
          '你的顾虑是对的，不然你不会知道自己的名字被起出怎样的外号。' },
        { floor: 3, text: '至于艺名，这很好解决，有个不错的法子，就是将自己的名字倒过来写。' },
        { op: true, text: '哦天呐，谢谢你，你的建议很珍贵。从现在起，我就是小丑塞尔拉克（Selrahc）了！' }
      ]
    }),

    /* ---------- 3.11) 新闻 · 罗伯特·本内特被逮捕（I 词在这里） ---------- */
    'news-bennett': cnnNewsPage({
      section: '国际',
      trail: ['世界', '国际'],
      reading: 6,
      title: '罗伯特·本内特被逮捕入狱',
      updated: '2010 年 8 月 23 日 07:15',
      author: '今日美国',
      imgClass: 'is-crime',
      imgSrc: 'assets/image/news/news-2010-robert.jpg',
      caption: '（图：法院外景 / 资料图）',
      paragraphs: [
        '据警方通报，近日，犹他州一名儿童剧演员兼社区社工罗伯特·本内特因涉嫌持有大量儿童色情影像，' +
        '已被依法逮捕，并经法院审理判处无期徒刑。',

        '案件线索源于另一名涉案人员吉米·拉克斯。吉米·拉克斯系罗伯特·本内特的同事，' +
        '因试图对儿童实施性犯罪被警方逮捕入狱。',

        '执法人员在依法搜查其住所时，对其电脑等电子设备进行取证，发现其与罗伯特的聊天记录。' +
        '相关内容涉及对未成年人的血腥暴力想象，警方随后依据线索对罗伯特的公寓展开搜查。',

        '警方称，在罗伯特公寓的地下室中，执法人员发现大量儿童色情影像以及用于捆绑的绳子、刀具等物品。' +
        '相关物品已被依法扣押，电子存储介质等也交由专业部门进一步检验。',

        '因涉案影像数量较大，相关取证和鉴定工作持续了一段时间，' +
        '负责审理录像的警员在查看结束后均面露不适，表示需要进一步的心理疏导。',

        '罗伯特身为儿童剧演员及社区社工，日常需要与儿童进行大量亲密接触。' +
        '虽然罗伯特坚称自己并未将相关行为付诸行动，但警方在其房屋附近发现的大量非自然痕迹戳破了他的谎言……' +
        '最终，法院判处[[罗伯特·本内特无期徒刑]]。'
      ],
      commentCount: 3,
      comments: [
        ['盐湖城居民', '这人以前还在社区活动上给孩子们发过糖。'],
        ['mike_ut', '无期徒刑，太轻了。'],
        ['路过的人', '不敢想象那些孩子的家长现在是什么心情。']
      ]
    }),

    /* ---------- 3.12) 新闻 · 蓝星电视台仓库大火（2011） ---------- */
    'news-fire': cnnNewsPage({
      section: '国际',
      trail: ['世界', '国际'],
      reading: 3,
      title: '蓝星电视台仓库突发大火，百年底蕴毁于一旦！',
      updated: '2011 年 6 月 10 日 22:08',
      author: '今日美国',
      imgClass: 'is-fire',
      imgSrc: 'assets/image/news/news-2011-fire.jpg',
      caption: '（图：现场画面 / 路透社）',
      paragraphs: [
        '昨日，蓝星电视台一处仓库突发大火，火势迅速蔓延，仓库内储存的大量胶卷受到大面积焚毁。' +
        '事故发生后，消防部门迅速赶赴现场处置，明火已被扑灭，具体起火原因目前尚不明确，' +
        '相关调查工作正在进行中。',

        '据现场情况显示，此次火灾对仓库内存放的影视资料造成严重毁坏，大量胶卷在火中被毁。' +
        '蓝星电视台方面表示，相关损失情况仍在进一步清点核实中。',

        '蓝星电视台长期从事节目制作与播出，仓库内保存的胶卷资料承载着多年积累的影像档案。' +
        '此次火灾造成大面积焚毁，被外界视为一次重大损失。'
      ],
      commentCount: 3,
      comments: [
        ['并非红脖子', '不是吧！着火了！那秘密博士的胶卷还好吗？'],
        ['微生物lxx', '怎么会突然着火'],
        ['审讯室不会写', '不会是蓝星自己放的火吧，他们绝对干的出来']
      ]
    }),

    /* ---------- 3.13) 搜索：邪典（两条结果） ----------
       主词是「邪典」，「邪典节目」是它的长尾别名，两个词共用这一页。
       页面在启动时先按默认词生成一份，之后每次搜索会由 runSearch
       按实际输入重生成（见 buildCultSearch）。
       只放警告新闻与反驳帖；2004 年那篇恶魔暗示新闻在 WB_ONLY_PAGES 里，
       普通浏览器这一页不放它的卡片。 */
    'search-cult': buildCultSearch(),

    /* ---------- 3.14) 搜索：特里博·特内布（三条结果，第三条是加密档案） ----------
       前两条是「认识他的人」给的线索：家长投诉的义工新闻、起名求助帖。
       第三条是 2010 年那篇逮捕新闻 —— 标题里写着真名，所以整条被封存，
       未解锁时只渲染成一个血红方块，必须进验证界面答出真名才打开
       （渲染见 searchPage 里的 it.locked 分支，验证见 submitRobertName）。 */
    'search-trebor': buildTreborSearch(),

    /* ---------- 9) IMDb 词条页：由「Happy With Us」结果第一条点开 ---------- */
    'imdb-happy': IMDB_PAGE,

    /* ---------- 10) 现代 404：电视台排期表（缓存页已失效） ---------- */
    'schedule-404':
      '<div class="error-404">' +
        '<div class="e404-code">404</div>' +
        '<p class="e404-text">该页面不存在或已删除</p>' +
        '<p class="e404-hint">xx-tv.example.com/schedule/1990s.html</p>' +
        '<div class="global-page-back"><span class="back-link" data-action="back">← 返回搜索结果</span></div>' +
      '</div>',

    /* ---------- 11) 论坛帖：录像线索的入口 ----------
       仍是通栏长文（.article-page），但挂上 is-forum 换成复古论坛皮：
       米黄纸张 + 宋体 + 虚线元信息，和纯白现代的新闻页彻底切开。 */
    'forum-thread':
      '<div class="article-page is-forum">' +

        '<h1 class="article-title">有人看过《欢乐好时光》这档节目吗？</h1>' +

        '<div class="article-meta">' +
          '<span class="article-tag">原创</span>' +
          '<span>怀旧老哥</span>' +
          '<span>2024-05-12</span>' +
          '<span>北京</span>' +
        '</div>' +

        '<div class="article-content">' +

          '<p>上周末回家帮我妈收拾阳台，从一堆落灰的纸箱底下翻出一盒录像带。' +
            '塑料壳已经发黄，侧面贴着一条白胶布，上面用圆珠笔写着五个字：欢乐好时光。</p>' +

          '<p>我盯着那行字愣了半天，才想起自己小时候有多惦记这档节目。' +
            '每天下午五点半，片头那段电子琴一响，我就搬着小板凳坐到电视机跟前，谁也不许换台。' +
            '那只蓝色的大家伙从幕布后面晃出来的时候，我一天里最踏实的半小时才刚开始。</p>' +

          '<p>那时候家里还是十四寸的彩电，屏幕上有两道怎么擦也擦不掉的水波纹。' +
            '我妈在厨房喊吃饭，我永远是那句“等这集演完”。后来电视台改版，' +
            '节目说停就停，连一句预告都没有。</p>' +

          /* 正文中的视频占位块：浅灰圆角大色块 + 封面占位 + 播放键 + 标题 */
          '<div class="article-video">' +
            '<div class="av-cover">' +
              '<span class="av-play" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="22" height="22">' +
                  '<path d="M9 6.2v11.6L18.4 12 9 6.2z" fill="#fff"/>' +
                '</svg>' +
              '</span>' +
              '<span class="av-duration">02:41</span>' +
            '</div>' +
            '<div class="av-info">' +
              '<span class="av-title">《Happy With Us》第一季原版录像</span>' +
              '<span class="av-meta">视频</span>' +
            '</div>' +
          '</div>' +

          '<p>真正让我难受的是这两年。我想把它完完整整看一遍，翻遍了几个大站，' +
            '只找到一段两分多钟的片头、几张糊得连脸都看不清的截图，' +
            '剩下就是几个和我一样在问“还有人记得吗”的帖子，底下清一色是“没印象”“是你记错了吧”。</p>' +

          '<p>我明明记得有一集在下雨。那只蓝色的玩偶蹲在屋檐底下，一动不动地等到天黑，' +
            '雨水顺着它的耳朵往下淌。可我描述不出它到底在等谁，也记不清那一集是怎么结束的。</p>' +

          '<p>所以想问问这里有没有同龄人。如果你也看过，哪怕只记得一句台词、一个镜头、' +
            '一段跑调的配乐，都请回我。要是谁手上还留着完整的带子，我愿意出钱转录。</p>' +

          '<p class="article-note">本帖最后由 怀旧老哥 于 2024-05-12 21:40 编辑：' +
            '录像已经转成数字版，传到「视频网站」了，在顶部搜索框检索站名就能看到。</p>' +

        '</div>' +

        /* 底部互动栏：左作者，右四个灰色图标 + 数字（纯展示，不可点、无悬停） */
        '<div class="article-foot">' +
          '<div class="article-author-box">' +
            '<span class="article-avatar" aria-hidden="true">怀</span>' +
            '<span class="article-nick">怀旧老哥</span>' +
          '</div>' +
          '<div class="article-actions">' +
            '<span class="article-act">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                '<path d="M7 10.5v9M7 10.5H5a1 1 0 0 0-1 1V18.5a1 1 0 0 0 1 1h2m0-9 3.6-6.2A1.5 1.5 0 0 1 13 3.4l.4 5.1H18a1.8 1.8 0 0 1 1.8 2.2l-1.1 5.6a2 2 0 0 1-2 1.6H7"/>' +
              '</svg>169</span>' +
            '<span class="article-act">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                '<path d="M12 15.5V4m0 0L8.2 7.8M12 4l3.8 3.8"/>' +
                '<path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/>' +
              '</svg>86</span>' +
            '<span class="article-act">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                '<path d="M12 20.2c-1.2-.9-7-4.7-7-9.4A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7 3.2c0 4.7-5.8 8.5-7 9.4z"/>' +
              '</svg>20</span>' +
            '<span class="article-act">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                '<path d="M19.5 12.4c0 3.4-3.4 6.2-7.5 6.2-.9 0-1.8-.1-2.6-.4L5 20l1.2-3.3a6 6 0 0 1-1.7-4.3c0-3.4 3.4-6.2 7.5-6.2s7.5 2.8 7.5 6.2z"/>' +
              '</svg>9</span>' +
          '</div>' +
        '</div>' +

      '</div>' +

      '<div class="global-page-back"><span class="back-link" data-action="back">← 返回搜索结果</span></div>'
  };

  /* ============================================================
     真名解锁：罗伯特·本内特
     ------------------------------------------------------------
     搜「特里博·特内布」时，第三条结果是 2010 年那篇逮捕新闻。
     它不挂 data-page、只挂 data-locked，点开先进「验证真实姓名」，
     答对才放行 —— 解锁结果写进 localStorage，之后永久有效。

     三份注册：
       ① 'news-2010-robert' —— 终极新闻的正式 pageId，
          内容与老的 'news-bennett' 同一份（隐藏词 I 就藏在里面），
          老 id 留着只为兼容已有收藏 / 最近浏览。
       ② 'news-2009-jimmy' / 'forum-2007-name' —— 搜索页前两条的正式 id，
          同样与 'news-volunteer' / 'forum-name' 共用一份内容。
       ③ 'unlock-robert' —— 验证界面本身。不写进 PAGE_META：
          它不是网页，不该进资料库、最近浏览，也不该长出一颗星标。
     ============================================================ */

  PAGE_HTML['news-2010-robert'] = PAGE_HTML['news-bennett'];
  PAGE_HTML['news-2009-jimmy']  = PAGE_HTML['news-volunteer'];
  PAGE_HTML['forum-2007-name']  = PAGE_HTML['forum-name'];

  PAGE_HTML['unlock-robert'] =
    /* 两个类名分工：
         .unlock-page      —— 版式：出血铺满内容区、居中、深底
         .unlock-interface —— 暗黑态的隔离标记：反色滤镜那条规则会挑
                              #browser-content-area 的直接子元素翻负片，
                              这一屏是**故意设计的黑红终端**，翻过去就成粉白，
                              所以用它把自己摘出来（css 里 filter:none !important）。 */
    '<div class="unlock-page unlock-interface">' +
      '<div class="unlock-box">' +
        '<p class="unlock-tag">RESTRICTED ACCESS</p>' +
        '<h1 class="unlock-title">机密档案：请验证嫌疑人真实姓名</h1>' +
        '<div class="unlock-row">' +
          '<input type="text" id="unlockInput" class="unlock-input" ' +
            'placeholder="真实姓名" autocomplete="off" spellcheck="false">' +
          '<button type="button" id="unlockBtn" class="unlock-btn">验证身份</button>' +
        '</div>' +
        '<p class="unlock-error" id="unlockError" role="alert"></p>' +
        '<p class="unlock-back">' +
          '<span class="back-link" data-action="back">← 返回搜索结果</span>' +
        '</p>' +
      '</div>' +
    '</div>';

  /* ============================================================
     页面元数据：资料库卡片的标题 / 主色 / 图标 / 站点
     app = 'browser' → 点击卡片后在资讯浏览器中重开
     app = 'wayback' → 点击卡片后在时光机快照中重开
     ============================================================ */

  const PAGE_META = {
    /* 资料库默认附带的内部手册（不是网页，卡片本身即内容） */
    'tutorial-doc': { title: 'LinkWriter v1.0 使用手册',      color: '#10b981', icon: '📘', src: '研发部 · 新手教程', app: 'library' },
    'lost-media':   { title: 'Lost Media：寻宝与遗憾',        color: '#3b82f6', icon: '📰', src: 'echoarchive.org',       app: 'browser' },
    'imdb-happy':   { title: 'Happy With Us - IMDb',          color: '#f5c518', icon: '🎬', src: 'imdb.example.com',      app: 'browser' },
    'video-site':   { title: '视频网站 · 播放页',             color: '#ef4444', icon: '▶',  src: 'videoshare.example.com', app: 'browser' },
    'video-happy-original': { title: '童年回忆！《Happy With Us》引进版片头曲', color: '#fb7299', icon: '📺', src: 'dilidili.com', app: 'browser' },
    'forum-thread': { title: '有人看过这档节目吗？',          color: '#0ea5e9', icon: '💬', src: 'oldtv-bbs.net',         app: 'browser' },
    'ent-zhang-rumor': { title: '情歌王子张文举深陷婚变疑云？', color: '#db2777', icon: '🎤', src: 'ent.newsnow.com',      app: 'browser' },
    'ent-zhang-lyrics': { title: '歌词遐想引争议？张文举否认“风流”标签', color: '#b45309', icon: '🎵', src: 'ent.newsnow.com', app: 'browser' },
    'ent-liu-drama': { title: '新剧《问鼎苍穹》大爆',           color: '#7c3aed', icon: '📺', src: 'ent.newsnow.com',      app: 'browser' },
    'ent-liu-friend': { title: '刘盈莹：友谊是我人生的河流',     color: '#0d9488', icon: '📰', src: 'ent.newsnow.com',      app: 'browser' },
    'life-muzi':    { title: '木子餐厅周年店庆等你来',          color: '#ea580c', icon: '🍜', src: 'bbs.nangu.local',       app: 'browser' },
    'search-hwu':   { title: '《欢乐好时光》搜索结果',        color: '#6366f1', icon: '🔎', src: 'search.example.com',    app: 'browser' },
    'search-imdb':  { title: 'Happy With Us · 搜索结果',      color: '#6b7280', icon: '🔎', src: 'search.example.com',    app: 'browser' },
    'search-bunny': { title: '兔子哥哥 · 搜索结果',           color: '#94a3b8', icon: '🐰', src: 'search.example.com',    app: 'browser' },
    'search-zhang': { title: '张文举 · 搜索结果',             color: '#db2777', icon: '🔎', src: 'search.example.com',    app: 'browser' },
    'search-liu':   { title: '刘盈莹 · 搜索结果',             color: '#7c3aed', icon: '🔎', src: 'search.example.com',    app: 'browser' },
    'search-muzi':  { title: '9月12日 · 搜索结果',             color: '#ea580c', icon: '🔎', src: 'search.example.com',    app: 'browser' },
    'schedule-404': { title: 'XX电视台排期表',                color: '#334155', icon: '🧾', src: 'xx-tv.example.com',     app: 'browser' },
    /* 粉丝站快照：同样走时光机，用 pageId 区分年份 */
    'fan-2001':     { title: '欢乐好时光中文站 · 2001 快照',     color: '#c00000', icon: '★',  src: 'happywithus.8u8.com', app: 'wayback', year: 2001 },

    /* 2002：星火工作室。浏览器搜索与资料库收藏都走时光机快照 */
    'spark-studio': { title: '星火工作室 SPARK STUDIO · 2002 快照', color: '#ff00ff', icon: '✦', src: 'sparkstudio.126.com', app: 'wayback', year: 2002 },

    /* 同一个名字的两种命运：这是「现在」的官网，不改写任何历史 */
    'spark-corp': { title: '星火游戏 SPARK GAMES · 官方网站', color: '#f97316', icon: '🏢', src: 'sparkgames.com', app: 'browser' },

    /* ---------- 稿件 2：星火游戏内斗的三条线索 ---------- */
    'news-spark-seal': { title: '“星火”公章争夺战：创始人与董事长的博弈闹剧何时休！', color: '#b91c1c', icon: '📰', src: 'jrss.example.com',       app: 'browser' },
    'forum-spark':     { title: '[讨论] 现在的星火已经不是以前的味道了',      color: '#0ea5e9', icon: '💬', src: 'bbs.sparkfans.net',     app: 'browser' },
    'news-wade-talk':  { title: '对谈明星制作人韦德：星火不会变质，我的前进是为了梦想', color: '#b45309', icon: '🎙', src: 'deep101.example.com', app: 'browser' },
    'news-chandler-family':   { title: '无心之言引争议？钱德勒怒喷家族矛盾', color: '#9d174d', icon: '📰', src: 'haomen.example.com',   app: 'browser' },
    'news-chandler-basement': { title: '也曾挤过地下室！提及创业，钱德勒难免哽咽', color: '#0d9488', icon: '🎧', src: 'qiaoqiaoye.example.com', app: 'browser' },
    'search-spark':    { title: '星火游戏 · 搜索结果', color: '#f97316', icon: '🔎', src: 'search.example.com', app: 'browser' },
    'search-wade':     { title: '韦德 · 搜索结果',     color: '#f97316', icon: '🔎', src: 'search.example.com', app: 'browser' },
    'search-chandler': { title: '钱德勒 · 搜索结果',   color: '#f97316', icon: '🔎', src: 'search.example.com', app: 'browser' },

    /* ---------- 稿件 3：Happy With Us 线的网页 ---------- */
    'forum-lost':      { title: '【求助】有谁看过这档节目吗？', color: '#0ea5e9', icon: '💬', src: 'oldtv-bbs.net',        app: 'browser' },
    'baike-lanxing':   { title: '蓝星少儿_百科',              color: '#1f6feb', icon: '📖', src: 'baike.example.com',    app: 'browser' },
    'baike-happy':     { title: '欢乐好时光_百科',            color: '#1f6feb', icon: '📖', src: 'baike.example.com',    app: 'browser' },
    'video-oprah':     { title: '奥普拉秀切片：第 2003-12-16 期', color: '#fb7299', icon: '📺', src: 'dilidili.com',     app: 'browser' },
    'news-cedric':     { title: '塞德里克·肖被捕',            color: '#475569', icon: '📰', src: '新鲜日报 · 2015',      app: 'browser' },
    'news-demon-2004': { title: '儿童节目暗藏恶魔暗示？',      color: '#b91c1c', icon: '🗞', src: '艾迪说 · 2004',        app: 'browser' },
    'news-warning':    { title: '多州保护中心联合警告',        color: '#1d4ed8', icon: '📰', src: '今日美国 · 2004',      app: 'browser' },
    'forum-cult':      { title: '《HWU》变成邪典了？',         color: '#0ea5e9', icon: '💬', src: 'oldtv-bbs.net',        app: 'browser' },
    'news-volunteer':  { title: '多名家长投诉社区义工',        color: '#b45309', icon: '🗞', src: '今日美国 · 2009',      app: 'browser' },
    'forum-name':      { title: '【求助】起一个足够酷炫的艺名', color: '#0ea5e9', icon: '💬', src: 'oldtv-bbs.net',        app: 'browser' },
    'news-bennett':    { title: '罗伯特·本内特被逮捕入狱',     color: '#7f1d1d', icon: '📰', src: '今日美国 · 2010',      app: 'browser' },
    'news-fire':       { title: '蓝星电视台仓库突发大火',      color: '#ea580c', icon: '📰', src: '今日美国 · 2011',      app: 'browser' },
    'search-cult':     { title: '邪典 · 搜索结果',             color: '#6366f1', icon: '🔎', src: 'search.example.com',  app: 'browser' },
    'search-trebor':   { title: '特里博·特内布 · 搜索结果',    color: '#6366f1', icon: '🔎', src: 'search.example.com',  app: 'browser' },

    /* 真名解锁线的三个正式 id（内容与 news-bennett / news-volunteer / forum-name 同一份） */
    'news-2010-robert': { title: '罗伯特·本内特被逮捕入狱',    color: '#7f1d1d', icon: '📰', src: '今日美国 · 2010',      app: 'browser' },
    'news-2009-jimmy':  { title: '多名家长投诉社区义工',        color: '#b45309', icon: '🗞', src: '今日美国 · 2009',      app: 'browser' },
    'forum-2007-name':  { title: '【求助】起一个足够酷炫的艺名', color: '#0ea5e9', icon: '💬', src: 'oldtv-bbs.net',        app: 'browser' },

    /* 2010 快照：只在时光机里打开，与 2001 版同一套视觉 */
    'fan-2010':        { title: 'HWU 粉丝站 · 2010 快照',     color: '#0b3b62', icon: '★',  src: 'happywithus.8u8.com', app: 'wayback', year: 2010 }
  };

  /* ---------- 搜索索引：搜索词 → pageId（同义词各占一条） ---------- */

  const SEARCH_INDEX = {
    '失落媒体': 'lost-media',
    '失传媒体': 'lost-media',
    'lost media': 'lost-media',

    '欢乐好时光': 'search-hwu',
    'happy with us': 'search-imdb',

    '视频网站': 'video-happy-original',
    '录像': 'video-happy-original',
    'happy with us 录像': 'video-happy-original',
    'happywithus录像': 'video-happy-original',
    /* 长尾词：直接落到视频页，比只命中「欢乐好时光」更有用 */
    '欢乐好时光 录像带': 'video-happy-original',
    /* 旧版录像播放页（含暂停找茬玩法）仍保留，用更具体的词进入 */
    '录像带': 'video-site',

    '兔子哥哥': 'search-bunny',

    /* 泛化的娱乐搜索词：统一落到八卦线主稿
       （原「顶流男星」占位稿已删除，这些词不再指向一篇不存在的报道） */
    '男星': 'ent-zhang-rumor',
    '八卦': 'ent-zhang-rumor',
    '顶流': 'ent-zhang-rumor',
    '张文举': 'search-zhang',
    '刘盈莹': 'search-liu',
    '9月12日': 'search-muzi',
    '木子餐厅': 'search-muzi',

    /* 2002 年的星火工作室：官网只剩一份归档快照 */
    '星火工作室': 'spark-studio',
    '星火': 'spark-studio',
    'spark studio': 'spark-studio',

    /* 「星火游戏」是品牌词，但搜索结果页本身是稿件 2 的线索中枢
       （公章争夺战 + 论坛老玩家吐槽，两条入口都只从这里进），
       所以保留 search-spark，把官网作为**第一条结果**摆在最上面：
       搜这四个字，第一眼就是官网，点一下直接进 spark-corp，
       下面的两条新闻线索一条都没丢。
       打全称「星火游戏有限公司」时按最长命中直接落官网。 */
    '星火游戏': 'search-spark',
    '星火游戏有限公司': 'spark-corp',
    'spark games': 'spark-corp',
    '为了玩家的笑脸': 'spark-corp',

    /* 稿件 2 的两个当事人：各带一篇 / 两篇报道 */
    '韦德': 'search-wade',
    '钱德勒': 'search-chandler',

    /* ---------- 稿件 3：Happy With Us 线的检索词 ----------
       长词压短词（「蓝星电视台」5 字 > 「蓝星少儿」4 字 > 「蓝星」2 字），
       所以玩家打全名时永远落到最具体的那一份。
       「蓝星集团」= 母公司名，落到那篇仓库大火的报道：玩家查公司名，
       看到的第一手材料就是「胶卷全烧了」这条新闻（档案线从这里进）；
       台名 / 简称仍然去百科词条，两条路互不挤占。

       节目名本身在上面已经有一条（→ search-hwu）。这里**绝不能再写一次**：
       对象字面量的重复键会被后面那行静默覆盖，等于把主搜索路径从
       「三条结果」硬拽到百科单页 —— 玩家再也看不到论坛求助帖和 2007 年
       那条重播新闻。这条同义词原本指向 baike-happy，是因为当年整个代码库里
       只有百科那一页写着那个错误的节目名；如今全文已统一成欢乐好时光，
       它没有存在理由，删掉。 */
    'happywithus': 'search-imdb',
    '蓝星少儿': 'baike-lanxing',
    '蓝星电视台': 'news-fire',
    '蓝星集团': 'news-fire',
    '蓝星': 'baike-lanxing',
    '维恩·肖': 'video-oprah',
    '维恩肖': 'video-oprah',
    '维恩': 'video-oprah',
    '塞德里克·肖': 'news-cedric',
    '塞德里克': 'news-cedric',
    /* 「邪典」是这条线的主词：搜它就能拿到 2004 年那篇
       《美国多州青少年保护中心发出联合警告》，它是 search-cult 的第一条。
       「邪典节目」保留成别名 —— 玩家照着新闻标题打长词也得有结果；
       两条都指向同一页，长词命中优先（4 字 > 2 字），落点不变。

       注意：整个索引里没有任何一个词直接指向 'news-demon-2004'。
       那篇《儿童节目暗藏恶魔暗示？》在 WB_ONLY_PAGES 里，普通浏览器
       即使拿到这个 id 也只会看到「该网页已被收录至互联网档案馆」，
       想读正文只能去时光机搜「Happy With Us」。 */
    '邪典': 'search-cult',
    '邪典节目': 'search-cult',
    '特里博·特内布': 'search-trebor',
    '特里博': 'search-trebor',
    '特内布': 'search-trebor',
    /* 英文原名 Trebor Ttenneb（1998 年那盘录像带的片尾字幕写的就是这个）。
       和中文一样登记三层：全名 / 名 / 姓。
         · lookupPageId 先按「查询词包含搜索词、最长命中优先」比一次 ——
           'trebor ttenneb'（14 字）压过 'ttenneb'（7 字）与 'trebor'（6 字），
           只打姓氏也照样落 search-trebor；
         · 紧凑写法 TreborTtenneb / Trebor  Ttenneb / trebor.ttenneb 走第二层
           紧凑比（compactQuery 去掉空格与 · ・ . - _ 等分隔符），结果一致；
         · 大小写、全角（Ｔｒｅｂｏｒ　Ｔｔｅｎｎｅｂ）由 normalizeQuery 先归一。
       两个短词互不包含，不会互相劫持，也不会碰到 'robert bennett' 那组真名。 */
    'trebor ttenneb': 'search-trebor',
    'trebor': 'search-trebor',
    'ttenneb': 'search-trebor',
    /* 真名：只带到搜索结果，第三条仍是封存档案，验证在验证界面里做 */
    'robert bennett': 'search-trebor',
    '罗伯特·本内特': 'search-trebor',
    '罗伯特': 'search-trebor'
  };

  /* ============================================================
     时光机专属页面：普通浏览器一律不许直接打开
     ------------------------------------------------------------
     这几个 pageId 是「整站存档快照」，只该出现在左侧「时光机」模块里
     （openSnapshot → renderSnapshot → #wbSnapshotContent，和浏览器是两套
     完全独立的 DOM，本文件下面那段时光机逻辑一行都不用动）。
     普通搜索、搜索结果里点卡片、正文内链、最后浏览 —— 只要落到这些 id 上，
     统一换成一张「已折叠 + 请前往时光机」的结果页，绝不渲染快照本体。
       · fan-2005 / wb-snapshot 目前没有实体页面，先占位登记：
         以后真补上快照，也会自动被拦住，不用再回来改这里。
     ============================================================ */

  const WB_ONLY_PAGES = [
    'spark-studio', 'fan-2001', 'fan-2005', 'fan-2010', 'wb-snapshot',
    /* 2004 年那篇《儿童节目暗藏恶魔暗示？》同样只在时光机里存在：
       普通浏览器搜「邪典」只能拿到警告新闻与反驳帖，这篇必须靠时光机
       搜「Happy With Us」从存档列表里点开。
       注意 id 的真实写法是 news-demon-2004（demon 在前、年份在后），
       另一种 news-2004-demon 的写法一并登记成别名 —— 当年埋点就写反过，
       留着当保险：哪个写法漏进普通浏览器，都能被拦在同一张提示页上。 */
    'news-demon-2004',
    'news-2004-demon'
  ];

  /* 时光机列表里点开「某一年的旧网页」时用的一次性通行证。
     news-2004-demon 既在拦截名单里、又确实是 2004 存档里的一条，
     所以要留一条「从档案列表进来」的窄门：只有 openFromArchive()
     会把它置成目标 id，renderPage 消费一次立刻清空。
     普通搜索、搜索结果卡片、正文内链、最后浏览都拿不到这张凭证，
     照旧被拦成「已收录」提示页。 */
  let archivePassThrough = '';

  /* 两道判定，缺一不可：
     ① 名单里的 id 一律算存档页；
     ② 凡是 PAGE_META 里标了 app:'wayback' 的，同样算 —— 这样以后再加一份
        快照（比如补上 2005 的粉丝站），只要在 PAGE_META 里挂上 app:'wayback'，
        普通浏览器就自动进不去了，不用回来补名单。 */
  function isWbOnlyPage(pageId) {
    if (!pageId) return false;
    if (WB_ONLY_PAGES.indexOf(pageId) >= 0) return true;
    const meta = PAGE_META[pageId];
    return !!meta && meta.app === 'wayback';
  }

  /* 拦截后给玩家看的那一页：上面一条折叠框，下面一段纯文本指路。
     count 固定 1 —— 只剩那一条折叠结果，引导语不再是「结果」，
     所以退成卡片外面的居中说明文字：不带网址、不带标题、不带连点。 */
  function wbOnlyBlockedPage(query) {
    return searchPage({
      query: query,
      elapsed: '0.04',
      count: 1,
      items: [
        {
          folded: true,
          title: FOLDED_TITLE
        }
      ]
    }) +
    /* 拼在 .sr-page 外面：它只是给玩家的一句话，不属于结果列表，
       因此不会被 .sr-list 的间距和卡片样式沾上，也没挂任何 data-page，
       天然不可点、不可聚焦。 */
    '<div class="search-archive-tip">' +
      '该网页已被收录至互联网档案馆。<br>' +
      '请打开左侧「时光机」模块，搜索此关键词以查阅历史存档。' +
    '</div>';
  }

  /* 把这张「已折叠」页写进主视窗。搜索、站内跳转、最后浏览共用同一条出口，
     所以不管从哪条路碰到 WB_ONLY_PAGES，看到的东西都一模一样。 */
  function showWbOnlyNotice(query) {
    currentPageId = '';
    setBrowserChrome(false);
    /* 崩坏期这张提示页也要跟着黑下去 —— 统一按存档刷，别在这里私自摘类 */
    syncGlitchTheme();
    browserArea.innerHTML = wbOnlyBlockedPage(String(query || '').trim());
    applyRichText(browserArea);
    browserArea.scrollTop = 0;
    removePageStar();
  }

  /* 时光机存档列表专用：放行一次被拦截名单收着的「旧网页」。
     通行证只对这一个 id、这一次渲染有效，renderPage 取走即清，
     所以点完之后再走普通入口（搜索 / 内链 / 最后浏览）还是会被拦。 */
  function openFromArchive(pageId) {
    archivePassThrough = pageId;
    switchTab('browser');
    renderPage(pageId);
    archivePassThrough = '';
  }

  /* ---------- 引擎：查找 / 渲染 / 搜索 ---------- */

  const browserInput = document.getElementById('browser-search-input');
  const browserBtn = document.getElementById('browser-search-btn');
  const browserArea = document.getElementById('browser-content-area');
  const browserModule = document.querySelector('.browser-module');

  let lastQuery = '';

  /* 当前正在浏览器里显示的页面（星标 / 调试用） */
  let currentPageId = '';

  /* ============================================================
     最后浏览：只记「详情页」，最多 3 条，倒序 + 去重
     ------------------------------------------------------------
     · 首页 / 搜索结果列表 / 资料库 / 写稿器 / 时光机都不算详情页；
     · 记录写在 renderPage() 里，所以站内跳转、资料库打开、最后浏览点击
       走的都是同一条路，不会漏记；
     · 存 localStorage（recentViewedPages），刷新后仍在。
     ============================================================ */

  const RECENT_KEY = 'recentViewedPages';
  const RECENT_MAX = 3;
  /* 这些 pageId 不是“具体的网页”，不写进最后浏览 */
  const RECENT_SKIP = ['home', 'search-hwu', 'search-imdb', 'search-bunny', 'search-zhang', 'search-liu', 'search-muzi', 'search-spark', 'search-wade', 'search-chandler'];

  function loadRecentHistory() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { raw = null; }
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(it => it && typeof it.id === 'string' && PAGE_META[it.id])
      .map(it => ({
        id: it.id,
        title: (typeof it.title === 'string' && it.title) ? it.title : PAGE_META[it.id].title
      }))
      .slice(0, RECENT_MAX);
  }

  let recentHistory = loadRecentHistory();

  function saveRecentHistory() {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentHistory)); } catch (e) {}
  }

  /* 记一次访问：先摘掉旧位置，再插到最前，最后截断到 3 条 */
  function recordVisit(pageId) {
    if (!pageId || RECENT_SKIP.indexOf(pageId) >= 0) return;
    const meta = PAGE_META[pageId];
    if (!meta) return;

    recentHistory = [{ id: pageId, title: meta.title }]
      .concat(recentHistory.filter(it => it.id !== pageId))
      .slice(0, RECENT_MAX);

    saveRecentHistory();
  }

  /* 渲染首页那张卡片（列表不存在时静默跳过） */
  function renderRecentHistory() {
    const list = document.getElementById('recent-history-list');
    if (!list) return;

    if (!recentHistory.length) {
      list.innerHTML = '<p class="nr-empty">暂无浏览记录</p>';
      return;
    }

    list.innerHTML = recentHistory.map(it => {
      const meta = PAGE_META[it.id] || {};
      const icon = meta.icon || '📄';
      const title = escapeHtml(it.title);
      const titleAttr = title.replace(/"/g, '&quot;');

      return '<button type="button" class="nr-item" data-page-id="' + it.id + '" title="' + titleAttr + '">' +
        '<span class="nr-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="nr-title">' + title + '</span>' +
        '</button>';
    }).join('');
  }

  /* ---------- 查询标准化（防卡关第一道保险） ----------
     玩家是手打的，大小写、首尾空格、全角字符、英文词多敲空格、
     「特里博·特内布」漏掉间隔号都很常见，所以比较前统一抹平：
       0) 全角转半角（全角空格 / 不换行空格先归一到普通空格）
       1) 去首尾空白
       2) 转小写
       3) compact：再去掉词间空格与常见分隔符（· ・ . - _ 等）
     时光机那边有一份同规则的 wbNormalize / wbLookup，两边对齐。 */
  const QUERY_STRIP = /[\s\u3000\u00a0·・．.\-_—–/\\]+/g;

  /* 全角 ASCII（\uFF01-\uFF5E，即「！～」）减 0xFEE0 就是对应的半角字符，
     所以 ｈａｐｐｙ → happy、１２３ → 123、（） → ()。 */
  function toHalfWidth(str) {
    return String(str == null ? '' : str)
      .replace(/[\u3000\u00A0]/g, ' ')
      .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }

  function normalizeQuery(str) {
    return toHalfWidth(str).trim().toLowerCase();
  }

  function compactQuery(str) {
    return normalizeQuery(str).replace(QUERY_STRIP, '');
  }

  /* ============================================================
     开机登录屏（#login-screen）
     ------------------------------------------------------------
     没有 localStorage 的 hwu.loggedIn=true 就把整台机器挡在门外。

     位置：定义紧跟在 toHalfWidth / normalizeQuery 之后（它们都是函数
     声明、本来就会提升，但放在这里读起来更明确 —— 口令归一化用的就是
     同一套「全角转半角」规则）。

     这件事现在分成两半：
       · applyBootVisibility()：定「这一帧该显示谁」，在 init() 第一行调用。
         index.html 里 #layout 带 inline display:none（防首帧闪出主界面），
         必须尽早把它放开 —— init 期间有一堆依赖尺寸的动作（renderChatLog
         之后要 scrollLog 到底、页面高度换算），隐藏状态下 scrollHeight
         恒为 0，顺序反了就会留下「一进游戏聊天停在最顶上」的怪相。
       · initLogin()：绑定输入框与按钮，仍在 init() 末尾调用 ——
         此时 DOM 一定已就绪，也不会被 init 内部的任何早退分支跳过。

     之前「清缓存后不弹登录页」的根因就是时序：调用写在文件末尾、
     或在 init() 之前，一旦 init 里抛错，登录屏就再也没有机会被显示出来。
     ============================================================ */

  /* 主界面在 index.html 里默认 display:none，恢复时统一用 flex
     （css/desktop.css 的 #layout 本身就是 display:flex，媒体查询没覆盖它） */
  const LAYOUT_ON = 'flex';

  function isLoggedIn() {
    try { return localStorage.getItem('hwu.loggedIn') === 'true'; } catch (e) { return false; }
  }

  /* 定这一帧显示谁：已登录 → 主界面；未登录 → 登录屏。
     幂等，init() 开头与 initLogin() 里各调一次，结果一致也不会闪。 */
  function applyBootVisibility() {
    const layoutEl = document.getElementById('layout');
    const loginScreen = document.getElementById('login-screen');
    const logged = isLoggedIn();

    if (logged) {
      /* 老玩家：主界面立刻放开（后面的渲染要量尺寸）；
         登录屏彻底不参与渲染 —— index.html 的首帧守卫已经写过一次 display:none，
         这里再兜一层，防止有人手改 HTML 或调试时清掉了 inline 样式。 */
      if (layoutEl) layoutEl.style.display = LAYOUT_ON;
      if (loginScreen) {
        loginScreen.classList.add('is-hidden');
        loginScreen.style.display = 'none';
      }
      return true;
    }

    /* 新玩家：主界面继续藏着（预渲染在登录屏背后，玩家看不见），
       登录屏必须可见。顺手把可能残留的行内 opacity / visibility 推回去，
       防止调试或上一轮样式把这块屏闷成「看不见但吃点击」。 */
    if (layoutEl) layoutEl.style.display = 'none';
    if (loginScreen) {
      loginScreen.style.display = '';
      loginScreen.classList.remove('is-hidden');
      loginScreen.style.opacity = '1';
      loginScreen.style.visibility = 'visible';
    }
    return false;
  }

  function initLogin() {
    const loginScreen = document.getElementById('login-screen');
    if (!loginScreen) return;

    /* 再确认一次显隐：init 开头已经调过，这里幂等。
       覆盖的极端情况是「init 跑到一半有人改了 hwu.loggedIn」——
       成本一句判断，省掉一整类难查的时序怪相。 */
    const layoutEl = document.getElementById('layout');
    applyBootVisibility();

    const input = document.getElementById('login-pass');
    const btn = document.getElementById('login-btn');
    const errorMsg = document.getElementById('login-error');
    const wrap = input ? input.parentElement : null;

    if (!input || !btn) return;

    const attemptLogin = () => {
      /* 全角转半角 → 抹掉所有空白（含全角空格）→ 转小写，
         和搜索那边 normalizeQuery 的思路一致：
         玩家手打 "ＮＥＷＴＲＵＴＨ communication" 也得认。 */
      const val = toHalfWidth(input.value).replace(/\s+/g, '').toLowerCase();

      if (val === 'newtruthcommunication') {
        if (errorMsg) errorMsg.classList.add('hidden');
        if (wrap) wrap.classList.remove('is-error');

        /* 必须先抹掉上面「未登录」分支写进去的行内 opacity / visibility。
           行内样式优先级高于类选择器，留着等于 .is-hidden 里的 opacity:0
           永远不生效 —— 表现就是「密码对了但屏幕纹丝不动」。
           抹掉之后紧接着加类，浏览器会在同一次样式重算里从 1 过渡到 0，
           css 那条 0.8s 的渐隐才真正跑起来。 */
        loginScreen.style.opacity = '';
        loginScreen.style.visibility = '';

        localStorage.setItem('hwu.loggedIn', 'true');

        /* 先把主界面放出来，再让登录屏淡出。
           #layout 在 index.html 里是 inline display:none —— 这一步就是把
           「隐身」摘掉，让它在 0.8s 渐隐期间就已经躺在照片背后。
           顺序反过来（先淡出、后显示）的话，淡到一半会露出空底，
           那一下比原来的闪烁还难看。flex 是 #layout 的原始 display。 */
        if (layoutEl) layoutEl.style.display = LAYOUT_ON;

        /* 只加类，不改 display、不摘节点：整块深蓝靠 CSS 过渡在 0.8s 内
           化开，期间 #layout 已经显示，玩家能看到背后的游戏界面。 */
        loginScreen.classList.add('is-hidden');

        /* 补一次聊天滚动：init() 跑的时候 #layout 还是 display:none，
           renderChatLog() 把气泡都建好了，但 scrollHeight 读到的是 0，
           scrollLog() 等于没滚 —— 不补这一下，玩家进门第一眼看到的是
           聊天记录的「最顶上」，而不是最新那几句。
           等这一帧布局算完再滚，否则读到的仍是旧值。 */
        window.requestAnimationFrame(() => { scrollLog(); });

        /* 登录屏渐隐 0.8s，等它退干净再放工具栏提示，否则会被压在底下 */
        window.setTimeout(maybeShowFullscreenTip, 900);

        /* 收掉输入焦点：不然光标还在那块正在淡出的屏里闪 */
        input.blur();
      } else {
        if (errorMsg) errorMsg.classList.remove('hidden');
        if (wrap) wrap.classList.add('is-error');
        input.value = '';
        input.focus();
        if (wrap) setTimeout(() => wrap.classList.remove('is-error'), 400);
      }
    };

    btn.addEventListener('click', attemptLogin);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') attemptLogin();
    });

    setTimeout(() => input.focus(), 100);
  }


  /* 查询词包含某个搜索词即命中；多条命中取最长的一条。
     两轮比较，和时光机的 wbLookup 完全一致：
       ① 严格 —— 归一化（全转半 / 去首尾空格 / 小写）后按「带空格的包含」比；
       ② 宽松 —— ①失败时把两边空格与分隔符全部删掉再比一次。
     所以 "happywithus"、"Happy  With  Us"、"ＨＡＰＰＹ ＷＩＴＨ ＵＳ" 都能命中。 */
  /* 页面已被删除、但玩家仍可能输入的词（当前：2005 年「汤米·维恩被捕」旧稿） */
  const DEAD_QUERIES = ['汤米·维恩', 'tommy vane', 'tommy'];

  function lookupPageId(query) {
    const q = normalizeQuery(query);
    if (!q) return null;

    const qc = compactQuery(query);

    /* 已删条目留下的查询词：直接短路成「无结果」。
       不这么做的话，「汤米·维恩」会被索引里更短的「维恩」（维恩·肖访谈视频）
       劫持 —— 给玩家一个错误答案，比给一个空答案更糟。 */
    if (DEAD_QUERIES.some(w => qc.indexOf(compactQuery(w)) >= 0)) return null;

    /* 第二层的两个特例不放进通用索引：
       · 真名 罗伯特·本内特 / Robert Bennett —— 也可以只打 bennett、本内特、
         robert；一律先去掉空格与点号再比，大小写不敏感。
         注意这里不再直接落到 2010 年那篇逮捕新闻：那条记录是封存档案，
         必须先过「真名验证」（搜出来 → 点锁定条目 → 输入真名）。
         所以真名只把玩家带到搜索结果，验证在验证界面里做。
       · 旧化名 Ivan Nomed（及 "ivan nomed"）仍然直接进机密卷宗。 */
    if (qc.indexOf('nomed') >= 0) return 'darknet-file';
    if (qc.indexOf('bennett') >= 0) return 'search-trebor';
    if (qc.indexOf('本内特') >= 0) return 'search-trebor';
    if (qc.indexOf('robert') >= 0) return 'search-trebor';

    let id = null;
    let hitLen = -1;

    Object.keys(SEARCH_INDEX).forEach(key => {
      const k = normalizeQuery(key);
      const kc = compactQuery(key);
      if (!kc) return;

      if (q.indexOf(k) >= 0 && k.length > hitLen) {
        hitLen = k.length;
        id = SEARCH_INDEX[key];
        return;
      }
      /* 紧凑比较：用 key 的紧凑长度排序，保证长词优先 */
      if (qc.indexOf(kc) >= 0 && kc.length > hitLen) {
        hitLen = kc.length;
        id = SEARCH_INDEX[key];
      }
    });

    return id;
  }

  /* 首页把浏览器工具条上的搜索框搬到站内导航里，离开首页再搬回去 */
  const browserBar = document.querySelector('.browser-bar');
  const browserWrap = browserInput.parentElement;

  function mountHomeSearch() {
    const slot = document.getElementById('homeSearchSlot');
    if (!slot) return;
    slot.appendChild(browserWrap);
    slot.appendChild(browserBtn);
  }

  function unmountHomeSearch() {
    if (!browserBar) return;
    if (browserWrap.parentElement !== browserBar) {
      /* 顺序保持：回首页按钮 → 地址栏 → 搜索按钮 */
      browserBar.appendChild(browserWrap);
      browserBar.appendChild(browserBtn);
    }
  }

  /* 首页没有地址栏（导航栏自带搜索），其他页面恢复工具条 */
  function setBrowserChrome(isHome) {
    browserModule.classList.toggle('is-home', isHome);
    if (browserBar) browserBar.classList.toggle('hidden', isHome);
    if (isHome) mountHomeSearch();
    else unmountHomeSearch();
  }

  /* ============================================================
     正文富文本：[[关键词]] / *加粗* / **加粗**
     ------------------------------------------------------------
     页面正文是一整串静态 HTML，里面允许三种轻量标记：
       [[朋友小清]]  → 可收集关键词（蓝色加粗，点一下进素材库）
       *重点*       → <strong>重点</strong>
       **重点**     → 同上，兼容双星号写法
     解析顺序固定：先关键词，再双星号，最后单星号。顺序反了
     **a** 会被单星号规则先吃掉一半，剩下 “*a*” 这种残句。
     只处理文本节点：已有的 <span class="collectible-keyword">
     和写稿器的【填空处】不会被二次解析。
     ============================================================ */

  /* 关键词文字 → 字母 / 归属篇目（按 DRAFTS 现算，调用时已初始化） */
  let keywordTextIndex = null;

  function keywordMetaOf(text) {
    if (!keywordTextIndex) {
      keywordTextIndex = {};
      DRAFTS.forEach(d => d.keywords.forEach(k => {
        keywordTextIndex[k.label] = { key: k.key, draft: d.no };
      }));
    }
    return keywordTextIndex[text] || null;
  }

  /* 纯文本 → HTML 片段 */
  function parseRichText(text) {
    let s = String(text == null ? '' : text);

    /* ① [[文字]] → 可收集关键词 */
    s = s.replace(/\[\[([^\[\]\n]+?)\]\]/g, (m, raw) => {
      const label = raw.trim();
      const meta = keywordMetaOf(label);
      if (!meta) return label;           /* 没登记的短语只留纯文本，不造空词条 */
      return '<span class="collectible-keyword"' +
        ' data-key="' + meta.key + '"' +
        (meta.draft === 3 ? '' : ' data-draft="' + meta.draft + '"') +
        ' data-text="' + label.replace(/"/g, '&quot;') + '">' + label + '</span>';
    });

    /* ② **文字** → strong，必须先于单星号 */
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

    /* ③ *文字* → strong */
    s = s.replace(/\*([^*\n]+?)\*/g, '<strong>$1</strong>');

    return s;
  }

  /* 这些容器里的文字保持原样：关键词、填空位、素材库按钮、代码块 */
  const RICH_SKIP_SEL = '.collectible-keyword, .w-slot, .w-chip, code, pre, textarea';

  /* DOM 落好之后的补解析：只替换含标记的文本节点 */
  function applyRichText(root) {
    if (!root || !root.textContent) return root;
    if (!/\[\[|\*/.test(root.textContent)) return root;      /* 无标记直接跳过 */

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue;
        if (!t || !/\[\[|\*/.test(t)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || p.closest(RICH_SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }, false);

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach(node => {
      const html = parseRichText(node.nodeValue);
      if (html === node.nodeValue) return;
      const holder = document.createElement('span');
      holder.innerHTML = html;
      const frag = document.createDocumentFragment();
      while (holder.firstChild) frag.appendChild(holder.firstChild);
      node.parentNode.replaceChild(frag, node);
    });

    return root;
  }

  /* 渲染一个页面：内容 + 星标 + 录像线索状态 */
  function renderPage(pageId) {
    /* 崩坏态跟着存档走：进哪一页都先按存档刷一次皮肤与 BGM，
       别让「翻页」变成偷偷回白的后门。 */
    syncGlitchTheme();

    /* 封存档案：老存档的收藏 / 最近浏览里可能还留着 'news-bennett' 这个旧 id，
       没解锁时一律转去真名验证 —— 不让书签绕过这道门。 */
    if ((pageId === 'news-bennett' || pageId === 'news-2010-robert') && !isRobertUnlocked()) pageId = 'unlock-robert';

    /* 时光机专属快照：普通浏览器不许直接落页。
       搜索结果里的「HWU 粉丝站 · 2010 快照」卡片、正文内链、最后浏览
       都会走到这里，统一换成「已折叠 + 请前往时光机」的结果页。
       时光机自己的快照不走本函数（renderSnapshot → #wbSnapshotContent）。
       例外只有一张一次性通行证：时光机存档列表点开「2004 年那篇旧闻」时
       由 openFromArchive() 放进来的那一次，取走即清，不留给下一条路。 */
    if (archivePassThrough === pageId) {
      archivePassThrough = '';
    } else if (isWbOnlyPage(pageId)) {
      showWbOnlyNotice(lastQuery || (PAGE_META[pageId] && PAGE_META[pageId].title) || '');
      return;
    }

    const html = PAGE_HTML[pageId];
    if (!html) return;

    /* 同样先对一次存档，避免清档后点开网页还挂着旧的关键词状态 */
    ensureStorageSynced();

    const isHome = pageId === 'home';

    /* 离开首页时先把搜索框搬回工具条，否则会被 innerHTML 一起清掉 */
    if (!isHome) setBrowserChrome(false);

    currentPageId = pageId;

    /* 特殊网页（粉丝站 / 机密档案 / 原版录像）→ BGM 降速压低。
       崩坏期这个调用会被 syncBgmMood 里的存档判断截住，恒为慢放。 */
    syncBgmMood(pageId);

    browserArea.innerHTML = html;
    browserArea.scrollTop = 0;

    /* 正文富文本：先把 [[关键词]] / *加粗* 解析成节点，
       再按存档补 .collected——顺序反了，新生成的关键词就标不上灰。 */
    applyRichText(browserArea);

    /* 页面重绘会丢掉 .collected，落完 DOM 立刻按存档补回来：
       刷新、后退、重新打开同一页，收过的词都还是灰的。 */
    markCollectedKeywords(browserArea);

    /* 页面里的 <video>（时光机 B站页 / 奥普拉页）：命中持久缓存就换 Blob 地址 */
    upgradeVideosIn(browserArea);

    /* 进入首页时等内容就位，再把搜索框搬进站内导航 */
    if (isHome) {
      setBrowserChrome(true);
      browserInput.value = '';
      renderRecentHistory();
    } else {
      /* 任何详情页都记一笔（搜索结果 / 首页已在 recordVisit 里排除） */
      recordVisit(pageId);
    }

    if (isClipSolved()) markClipSolved();

    /* 卷宗一打开就算「看过了」：写稿器的第九个词从这里开始才有意义 */
    if (pageId === 'darknet-file') {
      setSecretUnlocked();
      /* 机密档案上不该压着「自动翻译已启动」这种提示 */
      hideTranslateTip();
    }

    mountPageStar();
  }

  function markClipSolved() {
    const tag = document.getElementById('vpSolvedTag');
    if (tag && !tag.textContent) {
      tag.className = 'vp-solved';
      tag.textContent = '✓ 线索已解锁';
    }
  }

  /* ---------- 暗网入口：一层一闪而过的红屏 ----------
     不弹窗、不播声音，只有颜色和硬切；放行之后才把卷宗写进内容区。 */
  let darkAlertBusy = false;

  function playDarknetAlert(done) {
    if (darkAlertBusy) return;
    darkAlertBusy = true;

    const old = document.getElementById('darkAlert');
    if (old) old.remove();

    const ov = document.createElement('div');
    ov.id = 'darkAlert';
    ov.className = 'dark-alert';
    ov.innerHTML =
      '<p class="da-line">ACCESS RESTRICTED</p>' +
      '<p class="da-sub">RECORD SEALED / DO NOT DISTRIBUTE</p>';
    document.body.appendChild(ov);

    void ov.offsetWidth;         /* 先让浏览器认一次初始态，动画才会重播 */
    ov.classList.add('is-fire');

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      /* 硬切：红屏之后直接进黑底卷宗，中间不留过渡 */
      ov.remove();
      darkAlertBusy = false;
      done();
    }

    ov.addEventListener('animationend', e => {
      if (e.animationName === 'daFlash') finish();
    });
    /* 系统关掉动画时的兜底，别把玩家卡在黑屏里 */
    window.setTimeout(finish, 1700);
  }

  /* ============================================================
     真结局周目锁：没通关过普通结局，就别想搜到第二层
     ------------------------------------------------------------
     第二层（特里博·特内布 → 机密卷宗 → 【真正的恶魔】）是周目内容：
     玩家必须先走完坏 / 好 / 平庸里的任意一个结局，才有资格去碰它。
       · 词表管「查什么」：真名、化名、旧姓的各种写法都算；
       · 页面表管「落到哪」：就算哪天索引加了新别名，只要终点是这几页，
         一样被拦住 —— 词表会漏，终点不会。
     nomed / 特内布 这类中间态也一并算进来：它们本身就已经把人带到
     第二层门口了，没通关不该看见门牌。
     ============================================================ */

  const SECRET_WORDS = [
    '特里博', '特内布', 'trebor',
    'robert', 'bennett', '本内特',
    'richard', 'nomed'
  ];

  const SECRET_PAGE_IDS = [
    'search-trebor',      /* 三条结果：义工新闻 / 起名帖 / 血红方块 */
    'unlock-robert',      /* 真名验证界面 */
    'darknet-file',       /* 机密卷宗本体（第九个词的唯一来源） */
    'news-2010-robert',   /* 2010 年逮捕新闻 */
    'news-bennett'        /* 同上，老 id */
  ];

  /* 没通关过普通结局时，这张「查无此页」是唯一的回答。
     它和真的搜不到长得一模一样：没有折叠提示、没有指路、没有红屏 ——
     玩家不该因为「有个词特别特殊」而多得到一条线索。 */
  function showSecretLockedPage(query) {
    currentPageId = '';
    setBrowserChrome(false);
    /* 周目锁拦下时崩坏态本就开不起来，这里照样按存档刷一次：
       万一存档里残留着旧标记（清档不干净），也不该让「查无此页」变红 */
    syncGlitchTheme();
    browserArea.innerHTML = searchPage({
      query: query,
      elapsed: '0.03',
      count: 0,
      empty: '没有找到与「' + escapeHtml(query) + '」相关的网页。'
    });
    applyRichText(browserArea);
    browserArea.scrollTop = 0;
    removePageStar();
  }

  function runSearch(raw) {
    const query = String(raw || '').trim();
    if (!query) return;

    /* 特里博 / Trebor / Ttenneb 判定：命中就把「系统崩坏」写进存档（见下面的 setSystemGlitch）。
       别的查询不再「退回白色系」—— 崩坏一旦落盘就是全局的，
       普通词只能正常搜索，不能把红化 / 慢放 / 反色洗掉。

       英文原名（Trebor Ttenneb）走和中文一模一样的路：
       只要词里含 trebor 或 ttenneb 就算 —— 只打姓氏 "Ttenneb" 时，
       lookupPageId 靠索引里的 'ttenneb' 已经落到 search-trebor（三条结果、
       第三条血红方块），黑化判定必须跟着一起认，否则会出现
       「结果页是机密档案、界面却不红」的割裂。
       qn 已小写，空格不影响 indexOf，所以 "Trebor  Ttenneb" 天然命中；
       紧凑写法 "TreborTtenneb" 先被 qn 逐个词吃掉（trebor 仍在其中），无需额外分支。 */
    const qn = normalizeQuery(query);
    const qc = compactQuery(query);
    const isTrebor = qn.indexOf('特里博') >= 0 ||
      qn.indexOf('trebor') >= 0 ||
      qn.indexOf('ttenneb') >= 0;

    lastQuery = query;
    browserInput.value = query;

    const pageId = lookupPageId(query);

    /* ========== 真结局周目锁 ==========
       没通关过任何普通结局（坏 / 好 / 平庸）→ 第二层整条线不存在：
       真名、化名、特里博、机密卷宗、2010 年那篇逮捕新闻，一律查无此页。
       第九个词【真正的恶魔】只能从机密卷宗里点出来，卷宗进不去，
       词自然也就拿不到，真结局跟着一起锁死。 */
    if (!isNormalEndingCleared()) {
      const isSecretSearch = SECRET_WORDS.some(w => qn.indexOf(w) >= 0 || qc.indexOf(w) >= 0);
      const isSecretPage = !!pageId && SECRET_PAGE_IDS.indexOf(pageId) >= 0;

      if (isSecretSearch || isSecretPage) {
        showSecretLockedPage(query);
        return;
      }
    }
    /* ============================================================ */

    /* 特里博 / Trebor 一被搜到，就把「系统崩坏」落进存档：
       从此红化 + 慢放 + 网页反色锁在整局游戏上，普通词盖不掉、切页摘不掉。
       其他查询什么也不做 —— 交给 syncGlitchTheme() 按存档重画一遍就好，
       千万别在这里 removeItem，否则随便搜个词就能把崩坏洗白。 */
    if (isTrebor) {
      /* 顺序不能反：setSystemGlitch 内部的 syncGlitchTheme → syncBgmMood
         先把 bgmCreepy 置真、速率压到 0.25、目标音量压到 0.3，
         紧接着的 forceBgmOnGlitch 才是「慢放 + 轻音量」地从无声浮上来。
         反过来的话，前一两拍会是原速、0.5 音量的正常曲，再猛地降速。 */
      setSystemGlitch(true);
      forceBgmOnGlitch();
    } else {
      syncGlitchTheme();
    }

    /* ========== 时光机专属快照：普通搜索不许直接跳进去 ==========
       查询命中 spark-studio / fan-* 这些存档页时，不渲染快照本体，
       只给一张「已折叠 + 请前往时光机」的结果页。
       真正的快照只能从左侧「时光机」模块进入（那边走的是
       openSnapshot → renderSnapshot，和这里完全无关）。 */
    if (isWbOnlyPage(pageId)) {
      showWbOnlyNotice(query);
      return;
    }
    /* ============================================================ */

    /* 真名 → 先红屏，再落卷宗 */
    if (pageId === 'darknet-file') {
      playDarknetAlert(() => renderPage('darknet-file'));
      return;
    }

    if (!pageId) {
      currentPageId = '';
      setBrowserChrome(false);
      /* 没有命中就只留一句结论：不推荐关键词，不给备用搜索建议 */
      browserArea.innerHTML = searchPage({ query, elapsed: '0.03', noResult: true });
      applyRichText(browserArea);
      browserArea.scrollTop = 0;
      removePageStar();
      return;
    }

    /* search-cult 是「邪典」/「邪典节目」共用的结果页：
       启动时生成的那一份是按默认词标亮的，这里按玩家这次真正输入的词
       重生成一遍再渲染 —— 否则摘要高亮会跟输入对不上（搜「邪典」
       却按「邪典节目」去标，一条都标不亮）。 */
    if (pageId === 'search-cult') {
      PAGE_HTML['search-cult'] = buildCultSearch(query);
    }

    renderPage(pageId);
  }

  browserBtn.addEventListener('click', () => runSearch(browserInput.value));
  browserInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') runSearch(browserInput.value);
  });

  /* ============================================================
     真名验证：罗伯特·本内特
     ------------------------------------------------------------
     唯一的一条规则：2010 年那篇逮捕新闻的标题里写着真名，所以它在
     搜索结果里是锁着的。想打开就得把真名说出来 —— 输入框认
     Robert Bennett / 罗伯特·本内特，也认单独一个 bennett、本内特、
     robert、罗伯特（全半角、大小写、空格与点号都先归一掉）。

     解锁状态写 localStorage（hwu.robertUnlocked = 'true'），
     之后永久有效：再搜出来点一次，直接进新闻，不再问第二遍。
     ============================================================ */

  const ROBERT_ANSWER_PARTS = ['bennett', '本内特', 'robert', '罗伯特'];

  function isRobertUnlocked() {
    return isRobertSealOpen();
  }

  function setRobertUnlocked() {
    try { localStorage.setItem(ROBERT_UNLOCK_KEY, 'true'); } catch (e) {}
    /* 搜索结果页是启动时生成好的静态字符串，这里就地重新生成一份，
       于是「返回搜索结果」或重新搜一次时，第三条已经是正常新闻条。 */
    PAGE_HTML['search-trebor'] = buildTreborSearch();
  }

  /* normalizeQuery（全半角 / 去首尾空格 / 小写）+ compactQuery（去词间空格与
     · ・ . - _ 等分隔符）两步都在，所以「Ｒｏｂｅｒｔ　Ｂｅｎｎｅｔｔ」
     「罗伯特 · 本内特」都能命中。 */
  function isRobertName(raw) {
    const qc = compactQuery(raw);
    if (!qc) return false;
    return ROBERT_ANSWER_PARTS.some(part => qc.indexOf(part) >= 0);
  }

  /* 验证界面只有三件事：答对 → 落新闻；答错 → 提示 + 清空输入框。
     提示区是 .unlock-error，内容为空时 :empty 直接收起，不留空行。 */
  function submitRobertName() {
    const input = document.getElementById('unlockInput');
    const err = document.getElementById('unlockError');
    if (!input) return;

    if (isRobertName(input.value)) {
      setRobertUnlocked();
      if (err) err.textContent = '';
      renderPage('news-2010-robert');
      return;
    }

    if (err) err.textContent = '验证失败：姓名不匹配';
    input.value = '';
    input.focus();
  }

  /* 工具条左侧的「回首页」（首页时工具条隐藏，所以只在其他页面出现） */
  const browserHomeBtn = document.getElementById('browserHomeBtn');
  if (browserHomeBtn) {
    browserHomeBtn.addEventListener('click', () => {
      /* 回首页只是翻页，不解除崩坏：renderPage 开头会按存档重刷皮肤与 BGM */
      renderPage('home');
    });
  }

  /* ============================================================
     六之二、星标收藏 + 资料库
     ------------------------------------------------------------
     规则：每个「页面」有一个稳定的 pageId；星标把 pageId 写进
     localStorage 的 bookmarkedPages 数组（去重、保序）。
     星标按钮绝对定位在网页内容容器的右上角，随页面切换重建。
     ============================================================ */

  const BM_KEY = 'bookmarkedPages';

  const STAR_POINTS = '12 3.2 14.7 8.9 20.8 9.8 16.4 14.2 17.5 20.4 12 17.4 6.5 20.4 7.6 14.2 3.2 9.8 9.3 8.9';

  /* ---------- 内置手册：永远在收藏里，且永远排第一 ----------
     首次游玩（localStorage 里没有 bookmarkedPages）时写入；
     老存档、甚至以前被取消过的存档，启动时也补回第一位。
     因为它不再允许被取消，这份数据只需要保证“存在 + 在首位”。 */

  function ensureTutorialBookmark() {
    try {
      if (localStorage.getItem(BM_KEY) === null) {
        saveBookmarks([TUTORIAL_PAGE_ID]);
        return;
      }
    } catch (e) {
      return;
    }

    const list = getBookmarks();
    if (list[0] === TUTORIAL_PAGE_ID) return;

    saveBookmarks([TUTORIAL_PAGE_ID].concat(list.filter(id => id !== TUTORIAL_PAGE_ID)));
  }

  /* ---------- 读写收藏 ---------- */

  function getBookmarks() {
    try {
      const raw = localStorage.getItem(BM_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      /* 过滤掉已经不存在的 pageId，避免脏数据把资料库撑破 */
      return arr.filter(id => PAGE_META[id]);
    } catch (e) {
      return [];
    }
  }

  function saveBookmarks(list) {
    try { localStorage.setItem(BM_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function isBookmarked(pageId) {
    return getBookmarks().indexOf(pageId) >= 0;
  }

  /* 内置手册属于“系统资源”，永远在收藏里，不允许被取消 */
  function isLockedPage(pageId) {
    return pageId === TUTORIAL_PAGE_ID;
  }

  function toggleBookmark(pageId) {
    if (!PAGE_META[pageId]) return false;

    /* 锁定页：直接返回“仍然是收藏态”，不改数据、不动 DOM */
    if (isLockedPage(pageId)) return true;

    const list = getBookmarks();
    const i = list.indexOf(pageId);

    if (i >= 0) list.splice(i, 1);
    else list.push(pageId);

    saveBookmarks(list);
    syncAllStars();
    return i < 0;
  }

  /* ---------- 星标按钮 ---------- */

  function buildPageStar(pageId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-star';
    btn.dataset.pageId = pageId;

    if (isLockedPage(pageId)) {
      btn.dataset.locked = 'true';
      btn.classList.add('locked');
    }

    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="' + STAR_POINTS + '"/></svg>';
    syncStar(btn);
    return btn;
  }

  function syncStar(btn) {
    const pageId = btn.dataset.pageId;
    const locked = isLockedPage(pageId);

    /* 锁定页不受 bookmarkedPages 影响，永远是实心金色 */
    const on = locked ? true : isBookmarked(pageId);

    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', locked
      ? '系统内置手册，无法取消收藏'
      : (on ? '取消收藏此页' : '收藏此页'));
    btn.title = locked
      ? '系统内置手册 · 不可取消收藏'
      : (on ? '已收藏（点击取消）' : '收藏此页');
  }

  function syncAllStars() {
    document.querySelectorAll('.page-star').forEach(syncStar);
  }

  /* 点击反馈：只重放这颗星的弹跳动画，不碰页面内容 */
  function pulseStar(star) {
    star.classList.remove('pop');
    void star.offsetWidth;
    star.classList.add('pop');
  }

  /* 浏览器里挂星标：挂在模块层（不在滚动区内），始终停在内容区右上角。
     搜索结果页在统计行里留了 #searchStarSlot —— 那里改成内联的小空心星，
     跟着「找到 N 条结果」一起排，不再是浮在右上角的大白圆。 */
  function mountPageStar() {
    removePageStar();

    const meta = PAGE_META[currentPageId];
    if (!meta) return;

    const star = buildPageStar(currentPageId);

    const slot = browserArea.querySelector('#searchStarSlot');
    if (slot) {
      star.classList.add('is-inline');
      slot.appendChild(star);
      return;
    }

    browserModule.appendChild(star);
    star.style.top = (browserArea.offsetTop + 8) + 'px';
    star.style.right = '26px';
  }

  function removePageStar() {
    browserModule.querySelectorAll('.page-star').forEach(el => el.remove());
  }

  /* 时光机快照页挂星标：贴在黑色快照区右上角 */
  const wbSnapshotView = document.getElementById('wayback-view-snapshot');
  const wbRetroBar = document.querySelector('.wbm-retro-bar');

  function mountSnapshotStar() {
    wbSnapshotView.querySelectorAll('.page-star').forEach(el => el.remove());

    const star = buildPageStar(currentSnapshotPageId);
    wbSnapshotView.appendChild(star);
    star.style.top = ((wbRetroBar ? wbRetroBar.offsetHeight : 34) + 8) + 'px';
    star.style.right = '20px';
  }

  /* ---------- 资料库（收藏夹 + 文档阅读态） ----------
     网格是主态；点击《使用手册》卡片后，同一块区域覆盖一层「阅读态」，
     手册正文就从这里显示，右上角带一个实心星标（默认已收藏）。 */

  const libraryGrid = document.getElementById('libraryGrid');
  const libraryEmpty = document.getElementById('libraryEmpty');
  const libraryCount = document.getElementById('libraryCount');
  const libraryShell = document.querySelector('.library-shell');

  /* 阅读态容器：由 JS 建好一次性塞进 .library-shell，绝对定位盖住网格 */
  const libraryReader = document.createElement('div');
  libraryReader.id = 'libraryReader';
  libraryReader.className = 'library-reader hidden';
  libraryReader.innerHTML =
    '<div class="ld-bar">' +
      '<button class="ld-back" type="button" id="libraryBack">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>' +
        '<span>返回收藏夹</span>' +
      '</button>' +
      '<span class="ld-bar-title">资料库 · 内部文档</span>' +
      '<span class="ld-bar-star" id="libraryStarSlot"></span>' +
    '</div>' +
    '<div class="ld-scroll" id="libraryReaderBody"></div>';

  if (libraryShell) libraryShell.appendChild(libraryReader);

  const libraryReaderBody = document.getElementById('libraryReaderBody');
  const libraryStarSlot = document.getElementById('libraryStarSlot');
  const libraryBackBtn = document.getElementById('libraryBack');

  function isReaderOpen() {
    return !libraryReader.classList.contains('hidden');
  }

  /* 打开手册正文：内容直接取自 PAGE_HTML，星标重新按收藏状态生成 */
  function openTutorialDoc() {
    if (!libraryReaderBody) return;

    libraryReaderBody.innerHTML = PAGE_HTML[TUTORIAL_PAGE_ID] || '';
    libraryReaderBody.scrollTop = 0;
    libraryReader.classList.remove('hidden');

    if (libraryStarSlot) {
      libraryStarSlot.innerHTML = '';
      libraryStarSlot.appendChild(buildPageStar(TUTORIAL_PAGE_ID));
    }
  }

  function closeTutorialDoc() {
    if (!isReaderOpen()) return;

    libraryReader.classList.add('hidden');
    libraryReaderBody.innerHTML = '';
    if (libraryStarSlot) libraryStarSlot.innerHTML = '';
  }

  if (libraryBackBtn) {
    libraryBackBtn.addEventListener('click', () => closeTutorialDoc());
  }

  function renderLibrary() {
    if (!libraryGrid) return;

    /* 每次都重新读 localStorage：刚才在网页里取消收藏的条目，切回来就没有卡片了。
       内置手册不依赖数组内容，永远补在第一位。 */
    const others = getBookmarks().filter(id => id !== TUTORIAL_PAGE_ID);
    const ids = [TUTORIAL_PAGE_ID].concat(others);

    if (libraryCount) {
      libraryCount.textContent = others.length
        ? '共 ' + ids.length + ' 个网页 · 点击卡片可重新打开'
        : '已预置《LinkWriter v1.0 使用手册》· 在网页右上角点击星标即可收藏更多';
    }

    libraryGrid.innerHTML = '';
    libraryGrid.classList.toggle('hidden', false);
    if (libraryEmpty) libraryEmpty.classList.add('hidden');

    ids.forEach(id => libraryGrid.appendChild(buildBookmarkCard(id)));
  }

  function buildBookmarkCard(pageId) {
    const meta = PAGE_META[pageId];
    const isTutorial = pageId === TUTORIAL_PAGE_ID;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'bm-card' + (isTutorial ? ' bm-card--doc' : '');
    card.dataset.pageId = pageId;
    card.innerHTML =
      '<span class="bm-thumb" style="background-image:linear-gradient(135deg, ' +
        meta.color + ' 0%, ' + shadeColor(meta.color, -34) + ' 100%)">' +
        '<span class="bm-icon" aria-hidden="true">' + meta.icon + '</span>' +
        (isTutorial ? '<span class="bm-badge">新手指南</span>' : '') +
      '</span>' +
      '<span class="bm-info">' +
        '<b>' + escapeHtml(meta.title) + '</b>' +
        '<small>' + escapeHtml(meta.src || '') + '</small>' +
      '</span>';

    card.addEventListener('click', () => openBookmark(pageId));
    return card;
  }

  /* 点击卡片：按页面来源回到对应模块重新渲染 */
  function openBookmark(pageId) {
    const meta = PAGE_META[pageId];
    if (!meta) return;

    /* 内部手册不是网页：不切浏览器，直接在本模块右侧展开正文 */
    if (pageId === TUTORIAL_PAGE_ID || meta.app === 'library') {
      openTutorialDoc();
      return;
    }

    if (meta.app === 'wayback') {
      switchTab('wayback');
      openSnapshot(meta.year || 2001);
      return;
    }

    switchTab('browser');
    renderPage(pageId);
  }

  /* #rrggbb 变亮/变暗：amt 为负变暗，为正变亮 */
  function shadeColor(hex, amt) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const clamp = v => Math.max(0, Math.min(255, v));
    const r = clamp((n >> 16) + amt);
    const g = clamp(((n >> 8) & 0xff) + amt);
    const b = clamp((n & 0xff) + amt);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  /* ============================================================
     首页三篇入口的「软锁」+ 轻量提示条
     ------------------------------------------------------------
     锁定判定只认「点在首页那两张卡片上」这一个动作，所以写在全局
     click 委托里、看的是被点的 DOM，而不是 pageId 本身：
     搜索、资料库、正文内链、最后浏览进的同一个 pageId 全部放行。

     两篇按稿件进度递进：
       星火公章（news-spark-seal）→ 需要第 1 篇已提交
       Lost Media（lost-media）  → 需要第 2 篇已提交
     八卦（ent-zhang-rumor）不设门槛，任何时候都能进。

     进度源就是写稿器那套 submittedDrafts / isSubmitted()：
     提交成功时第 N 篇会被塞进数组，这里只是多读一次，
     不新增任何存档键，也不会和写稿器的只读态打架。

     ★ 提示方式：不再是挡住半屏的 showModal，改成一条借 .translate-tip
       外壳的悬浮条，2.5 秒自己淡出。它 pointer-events:none，
       压在最上面也只是「看得见、点得穿」。
     ============================================================ */

  /* ---------- 软锁提示条：LinkWriter 那条翻译提示的轻量版 ----------
     复活周期里反复点锁住的新闻是很正常的行为，所以：
       · 永远只有一条 —— 再触发就先把旧的连节点带定时器一起清掉；
       · 不带按钮 —— 用户不需要「知道了」，它自己会走；
       · 不抢焦点、不吃点击 —— 定位在搜索框下方，pointer-events 已在
         css 的 .soft-lock-tip 里设成 none，鼠标直接穿到下面的新闻；
       · 2.5s 后走 0.3s 透明度渐变再摘节点，不是「啪」一下消失。
     挂载点是 .browser-module：它是 position:relative 的定位上下文，
     现有 .translate-tip 已经按「首页 80px / 其他页 86px」分好，
     这里不重写 top，免得窄屏那条 14px 的媒体查询被压掉。 */
  let softLockTipEl = null;
  let softLockTipFadeTimer = 0;
  let softLockTipDropTimer = 0;

  function clearSoftLockTip() {
    if (softLockTipFadeTimer) { clearTimeout(softLockTipFadeTimer); softLockTipFadeTimer = 0; }
    if (softLockTipDropTimer) { clearTimeout(softLockTipDropTimer); softLockTipDropTimer = 0; }
    if (softLockTipEl && softLockTipEl.parentNode) softLockTipEl.parentNode.removeChild(softLockTipEl);
    softLockTipEl = null;
    /* 兜底：万一有别的路径留下过同名节点，一并收掉 */
    const stale = document.querySelector('.soft-lock-tip');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  }

  function showSoftLockTip(text) {
    clearSoftLockTip();

    const host = document.querySelector('.browser-module') ||
                 document.getElementById('browser-content-area') ||
                 document.getElementById('main');
    if (!host) return;

    const tip = document.createElement('div');
    tip.className = 'translate-tip soft-lock-tip';
    tip.setAttribute('role', 'status');
    tip.setAttribute('aria-live', 'polite');
    tip.style.animation = 'ttDropIn 0.34s cubic-bezier(0.22, 0.85, 0.3, 1.12)';

    const globe = document.createElement('span');
    globe.className = 'tt-globe';
    globe.setAttribute('aria-hidden', 'true');
    globe.textContent = '🔒';

    const para = document.createElement('p');
    para.className = 'tt-text';
    const strong = document.createElement('b');
    /* 用 textContent 而不是拼 HTML：文案永远只当文本解析 */
    strong.textContent = text;
    para.appendChild(strong);

    tip.appendChild(globe);
    tip.appendChild(para);
    host.appendChild(tip);
    softLockTipEl = tip;

    /* 让位：LinkWriter 那条「自动翻译已启动」只在首次进浏览器时出现，
       而「首次进浏览器」恰恰最容易去点那两篇锁着的新闻 —— 两条会同时
       在场，都贴 top:80px 居中，直接叠会把对方的字压掉一半。
       这里量一下它当前的实际高度，把自己挪到它下面 10px；
       它不在场（绝大多数情况）就保持 CSS 里那套 80px / 86px 的默认位置。 */
    if (translateTip && !translateTip.classList.contains('hidden')) {
      const bar = translateTip.getBoundingClientRect();
      if (bar.height > 0) {
        const box = host.getBoundingClientRect();
        tip.style.top = Math.round(bar.bottom - box.top + 10) + 'px';
      }
    }

    softLockTipFadeTimer = window.setTimeout(() => {
      softLockTipFadeTimer = 0;
      tip.classList.add('tt-out');
      softLockTipDropTimer = window.setTimeout(() => {
        softLockTipDropTimer = 0;
        if (tip.parentNode) tip.parentNode.removeChild(tip);
        if (softLockTipEl === tip) softLockTipEl = null;
      }, 320);
    }, 2500);
  }

  /* 锁表：pageId → 需要先提交第几篇。文案统一，不再逐条写死长句。 */
  const HOME_NEWS_LOCKS = {
    'news-spark-seal': 1,
    'lost-media': 2
  };

  /* 命中软锁返回 true（此时提示条已经浮现），调用方直接 return 收工 */
  function blockedByHomeNewsLock(pageId) {
    const need = HOME_NEWS_LOCKS[pageId];
    if (!need) return false;
    if (isSubmitted(need)) return false;
    showSoftLockTip('现在还不是时候');
    return true;
  }

  /* ---------- 全站事件委托：收集 / 星标 / 结果项 / 返回 / 播放器 ---------- */

  document.addEventListener('click', e => {
    /* 0) 可收集关键词：正文里加粗的蓝字，点一下收进写稿器的素材库。
          ── 只在原地改这一个 span 的样式，不重绘页面；
             收成功后右下角弹一句轻提示（showToast）；
             已经收过的再点一次只补类名、不再提示（事件照样吃掉，
             免得冒到父级的整页 / 条目点击上去）。 */
    const collectible = e.target.closest('.collectible-keyword');
    if (collectible) {
      e.preventDefault();
      e.stopPropagation();
      if (!collectible.classList.contains('collected')) collectKeyword(collectible);
      return;
    }

    /* 0.1) 星标：切换收藏状态（浏览器页 / 时光机快照页 / 资料库手册页共用）
          ── 这里只改 localStorage 和这颗星本身，绝不重渲染当前页面，
             否则正文会被刷掉、滚动位置也会丢。 */
    const star = e.target.closest('.page-star');
    if (star) {
      e.preventDefault();
      e.stopPropagation();

      const pageId = star.dataset.pageId;

      /* 内置手册：锁定，只给提示，不摘星 */
      if (isLockedPage(pageId)) {
        pulseStar(star);
        showModal('提示', '该文档为系统内置手册，无法取消收藏。');
        return;
      }

      /* 普通网页：实心 ↔ 空心互切，页面内容原样保留 */
      toggleBookmark(pageId);
      pulseStar(star);
      return;
    }

    /* 0.5) 最后浏览：点条目不回首页，直接重开那个详情页 */
    const recentItem = e.target.closest('.nr-item[data-page-id]');
    if (recentItem) {
      e.preventDefault();
      renderPage(recentItem.dataset.pageId);
      return;
    }

    /* 1) 返回搜索结果 */
    const back = e.target.closest('[data-action="back"]');
    if (back) {
      if (lastQuery) runSearch(lastQuery);
      return;
    }

    /* 2) 播放器 */
    const vp = e.target.closest('[data-action="vp-play"], [data-action="vp-pause"]');
    if (vp) {
      playVideo(vp.dataset.action === 'vp-pause');
      return;
    }

    /* 3) 首页：站标 / 分类 / 头条 / 折叠新闻 */
    if (e.target.closest('.nh-logo')) {
      renderPage('home');
      return;
    }

    /* 分类标签：只有「首页」是真的能点，其余频道的稿源还没接进来。
       不弹提示、也不改高亮 —— 切了 .active 却不换内容，等于骗玩家点了个假标签。 */
    const cat = e.target.closest('.nh-cat');
    if (cat) {
      if (cat.dataset.cat === '首页') renderPage('home');
      return;
    }

    const hero = e.target.closest('.nh-hero[data-page]');
    if (hero) {
      const pageId = hero.dataset.page;
      if (blockedByHomeNewsLock(pageId)) return;
      renderPage(pageId);
      return;
    }

    /* 首页普通列表里的入口（Lost Media 深度稿、星火公章争夺战）。
       两篇都要等对应稿件交完才放行；八卦（ent-zhang-rumor）不在
       锁表里，走的是同一个分支但直接放行。 */
    const nhLink = e.target.closest('.nh-item[data-page]');
    if (nhLink) {
      const pageId = nhLink.dataset.page;
      if (blockedByHomeNewsLock(pageId)) return;
      renderPage(pageId);
      return;
    }

    /* 折叠条目（首页的普通新闻 / 排行榜 / 猜你喜欢）：只是展示位，
       点了不做任何事，也不弹提示 —— 保持“这不是个入口”的观感 */
    const folded = e.target.closest('[data-fold]');
    if (folded) {
      return;
    }

    /* 4.5) 正文 / 评论里的行内链接：data-page 直接开页 */
    const inlineLink = e.target.closest('.cnn-inline-link[data-page], .article-link[data-page]');
    if (inlineLink) {
      e.preventDefault();
      renderPage(inlineLink.dataset.page);
      return;
    }

    /* 4.4) 真名验证：解锁界面的「确认」按钮 */
    const unlockBtn = e.target.closest('#unlockBtn');
    if (unlockBtn) {
      e.preventDefault();
      submitRobertName();
      return;
    }

    /* 4.45) 锁定条目：没解锁 → 进验证界面；解锁过 → 直接放行
           ── 拦截在 .sr-item 之前，否则会被当成普通结果处理 */
    const lockedItem = e.target.closest('[data-locked="robert"]');
    if (lockedItem) {
      e.preventDefault();
      e.stopPropagation();

      if (isRobertUnlocked()) {
        renderPage('news-2010-robert');
        return;
      }

      renderPage('unlock-robert');
      const input = document.getElementById('unlockInput');
      if (input) input.focus();
      return;
    }

    /* 4) 结果项 → data-page 是 pageId，直接渲染对应页面 */
    const item = e.target.closest('.sr-item');
    if (!item) return;

    if (item.dataset.page) {
      renderPage(item.dataset.page);
      return;
    }
    showModal('提示', item.dataset.error || '该结果暂时无法打开。');
  });

  /* 真名验证：输入框里回车 = 点确认；重新输入时把上一次的失败提示收掉 */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (!e.target || e.target.id !== 'unlockInput') return;
    e.preventDefault();
    submitRobertName();
  });

  document.addEventListener('input', e => {
    if (!e.target || e.target.id !== 'unlockInput') return;
    const err = document.getElementById('unlockError');
    if (err && err.textContent) err.textContent = '';
  });

  /* 首页卡片 / 搜索结果项支持回车 / 空格打开 */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target.closest('.nh-hero[data-page], .nh-item[data-page], [data-fold], .nh-cat, .nh-logo, .sr-item.is-clickable');
    if (!target) return;
    e.preventDefault();
    target.click();
  });

  /* 资料库手册阅读态：Esc 返回收藏夹 */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isReaderOpen()) closeTutorialDoc();
  });

  /* ---------- 播放器：正常播放 / 暂停找茬 ---------- */

  function playVideo(paused) {
    const screen = document.getElementById('vpScreen');
    const hint = document.getElementById('vpHint');
    if (!screen || !hint) return;

    if (!paused) {
      screen.innerHTML = '<p class="vp-playing">▶ 正在播放……（占位画面）</p>';
      hint.textContent = '占位提示：画面看起来平平无奇。也许该换个方式看？';
      return;
    }

    screen.innerHTML =
      '<p class="vp-frozen">⏸ 已暂停 —— 00:04:23</p>' +
      '<p class="vp-snow">▒▒░▒█▒░▒▒░█▒▒░▒█</p>';
    hint.textContent = '录像第 4 分 23 秒，画面出现不自然的雪花点。';

    if (!isClipSolved()) {
      setClipSolved();
      /* 这里只交代「看见了什么」，不再声称某个词已解锁：
         第九个词的门在暗网档案上，不在这段录像里。 */
      showModal('录像已解析',
        '你逐帧看完了被剪掉的那一段：镜头边缘多出一只手，把隔间的门轻轻带上了。' +
        '画面里始终没有出现任何人的脸。');
      renderChips();
    }
    markClipSolved();
  }

  /* ============================================================
     七、时光机模块（Internet Archive 两视图）
     视图 1 首页 → 搜索 "Happy With Us" → 视图 2 快照页（2001-09-03）
     年份日历那一页已整页删除：搜索命中即开快照，不再过中间页。
     ============================================================ */

  const wbViews = {
    home: document.getElementById('wayback-view-home'),
    snapshot: document.getElementById('wayback-view-snapshot')
  };

  function showWbView(name) {
    Object.keys(wbViews).forEach(k => {
      if (!wbViews[k]) return;      /* 视图被删掉时不报错，直接跳过 */
      wbViews[k].classList.toggle('active', k === name);
    });

    /* 快照页也是一张「网页」，进入时挂上收藏星标 */
    if (name === 'snapshot') mountSnapshotStar();
  }

  const wbInput = document.getElementById('wbInput');
  const wbSearchBtn = document.getElementById('wbSearchBtn');
  const wbSearchMsg = document.getElementById('wbSearchMsg');

  /* 时光机自己的输入归一化（只服务 Wayback，不动资讯浏览器的 lookupPageId）：
     1) 零宽字符（输入法/复制粘贴常带）先抹掉；
     2) 全角空格 \u3000 / 不换行空格 \u00A0 归一到普通空格；
     3) 全角 ASCII（！到 ～，即 \uFF01-\uFF5E）按下标差 0xFEE0 转半角；
     4) 去首尾空白、把连续空白压成一个空格、统一转小写。
     中间那一个空格要留着，因为「happy with us」和「happywithus」
     得靠后面的两轮比较来兜住。 */
  const WB_ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

  function wbNormalize(raw) {
    return String(raw == null ? '' : raw)
      .replace(WB_ZERO_WIDTH, '')
      .replace(/[\u3000\u00A0]/g, ' ')
      .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  /* 归档索引：key 一律按人写的原样存，比较时两边跑同一套 wbNormalize，
     所以大小写、全半角天然对齐，不需要为每个 key 再写一份小写副本。
       kind: 'snapshot' → 直接开某一年的整站快照 */
  const WB_ARCHIVE_INDEX = [
    {
      /* Happy With Us 在时光机里不再「命中即直达」：它是全站唯一有
         多份互相矛盾的存档的词，先摊开一张列表，让玩家自己挑要看哪一份 ——
         2001 年的影迷站、IMDb 词条、2004 年那篇旧闻。
         列表只负责导航，点哪条走哪条；快照类留在时光机，网页类切回浏览器。 */
      keys: ['Happy With Us', '欢乐好时光'],
      kind: 'search-list',
      label: 'Happy With Us',
      results: [
        {
          title: 'HWU 粉丝站 · 2001 快照',
          url: 'web.archive.org/web/2001/happywithus.8u8.com',
          desc: '站点更新日期 2001.09.03：分集目录、演职员表、留言板。',
          action: () => { switchTab('wayback'); openSnapshot(2001); }
        },
        {
          title: 'IMDb - Happy With Us 词条',
          url: 'imdb.example.com/title/tt0xxxxxx',
          desc: '电视剧 1988-2010 · 主演：兔子博士、蓝犬哥哥、狮子姐姐。',
          action: () => { switchTab('browser'); renderPage('imdb-happy'); }
        },
        {
          title: '儿童节目暗藏恶魔暗示？揭开《HWU》的秘密',
          url: 'web.archive.org/web/2004/news/hwu-demon',
          desc: '2004 年 8 月 9 日：艾迪说，你可能已经在不知不觉中接收了暗示。',
          /* 这一条是被拦截名单收着的旧网页，必须走存档通行证，
             否则会被当成「普通浏览器偷看快照」拦成提示页。 */
          action: () => { openFromArchive('news-demon-2004'); }
        }
      ]
    },
    {
      /* 星火工作室只有 2002-08-08 这一份整站快照，直接打开；
         'spark' 兜住 spark studio / spark games 这类写法 */
      keys: ['星火工作室', '星火', 'spark'],
      kind: 'snapshot',
      year: 2002,
      label: '星火工作室'
    }
  ];

  /* 两轮比较：
     ① 严格 —— 归一化后按「输入包含 key」比；
     ② 宽松 —— ①失败时把两边的空格全部删掉再比一次，
        于是 happywithus / happywith us / happy withus 都落到同一条目。
     命中多条取最长的 key，和原来的最长命中行为一致。 */
  function wbLookup(raw) {
    const q = wbNormalize(raw);
    if (!q) return null;

    const qc = q.replace(/\s+/g, '');
    let hit = null;
    let hitLen = -1;

    WB_ARCHIVE_INDEX.forEach(entry => {
      entry.keys.forEach(key => {
        const k = wbNormalize(key);
        if (!k) return;

        const kc = k.replace(/\s+/g, '');
        const strict = q.indexOf(k) >= 0;
        const loose = !strict && !!kc && qc.indexOf(kc) >= 0;

        if ((strict || loose) && k.length > hitLen) {
          hitLen = k.length;
          hit = entry;
        }
      });
    });

    return hit;
  }

  function wbSearch(q) {
    /* 回显用玩家原样打的字，判断用归一化后的字 */
    const query = String(q == null ? '' : q).trim();
    if (!wbNormalize(query)) {
      wbSearchMsg.textContent = '';
      return;
    }

    /* 每开一次新搜索，先把上一次留下的列表收掉：
       列表只属于「这一次命中」，不能跟着人留在首页上。 */
    clearWbSearchList();

    const entry = wbLookup(query);

    if (!entry) {
      /* 没命中时如果人正停在快照页，这句提示他在那儿看不见，
         先退回首页再报——不然玩家会以为「按了没反应」。 */
      if (!wbViews.home.classList.contains('active')) showWbView('home');
      wbSearchMsg.textContent = '没有找到与「' + query + '」相关的归档记录。';
      return;
    }

    wbSearchMsg.textContent = '';

    /* 多存档词：停在首页，把命中的几份存档摊成一张列表 */
    if (entry.kind === 'search-list') {
      renderWbSearchList(entry);
      return;
    }

    if (entry.kind === 'results') {
      showWbResults(entry.label, entry.items);
      return;
    }

    /* 单一存档词（星火工作室）：仍然命中即开快照 */
    openSnapshot(entry.year);
  }

  /* ---------- 时光机搜索结果列表 ----------
     只服务 kind: 'search-list' 的条目（目前只有 Happy With Us）。
     列表长在首页那块黑底的 hero 里、搜索框正下方：大字与搜索框都留在原位，
     只是把下面那条 35% 的白底三列介绍让位给一张白底的存档列表。
     每条只有一件事可做 —— 执行它自己的 action：
       · 2001 影迷站：留在时光机里，直接开那一年的快照；
       · IMDb / 2004 旧闻：切回资讯浏览器，打开对应的页面。 */

  function clearWbSearchList() {
    const old = document.getElementById('wb-search-list');
    if (old) old.remove();
    if (wbViews.home) wbViews.home.classList.remove('is-wb-list');
  }

  function renderWbSearchList(entry) {
    /* 先回到首页再插列表：从快照页搜出来的，也得先看见这块黑底 */
    showWbView('home');

    const hero = document.querySelector('#wayback-view-home .wbm-hero');
    if (!hero || !entry || !entry.results || !entry.results.length) return;

    clearWbSearchList();

    const wrap = document.createElement('div');
    wrap.id = 'wb-search-list';
    wrap.className = 'wb-search-list';

    const head = document.createElement('h3');
    head.textContent = '找到 ' + entry.results.length + ' 条与「' + (entry.label || '') + '」相关的存档记录：';
    wrap.appendChild(head);

    entry.results.forEach(res => {
      const item = document.createElement('div');
      item.className = 'wb-search-item';
      item.setAttribute('role', 'button');
      item.tabIndex = 0;

      /* 三个字段一律走 textContent：标题里带《》，也不许当 HTML 解析 */
      const url = document.createElement('div');
      url.className = 'wb-s-url';
      url.textContent = res.url || '';

      const title = document.createElement('div');
      title.className = 'wb-s-title';
      title.textContent = res.title || '';

      const desc = document.createElement('div');
      desc.className = 'wb-s-desc';
      desc.textContent = res.desc || '';

      item.appendChild(url);
      item.appendChild(title);
      item.appendChild(desc);

      const go = () => {
        if (typeof res.action === 'function') res.action();
      };
      item.addEventListener('click', go);
      item.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        go();
      });

      wrap.appendChild(item);
    });

    hero.appendChild(wrap);
    if (wbViews.home) wbViews.home.classList.add('is-wb-list');
    wrap.scrollIntoView({ block: 'nearest' });
  }

  /* 归档搜索结果：借快照页当容器，复用搜索结果的卡片样式。
     列表只做两件事：打开网页，或者退回时光机首页。
     （2001 改为直达后，已没有条目走这条分支，函数保留作兼容。） */
  function showWbResults(label, items) {
    const screen = document.getElementById('wbSnapshotContent');
    if (!screen) return;

    if (wbSnapDate) wbSnapDate.textContent = label + ' · ' + items.length + ' 条归档记录';

    screen.className = 'wayback-screen snap-results';
    screen.innerHTML =
      searchPage({ query: label, elapsed: '0.03', count: items.length, items: items }) +
      '<p class="wb-results-hint"><span class="back-link" data-action="wb-home">返回时光机首页 →</span></p>';

    applyRichText(screen);

    if (wbSnapshotBody) wbSnapshotBody.scrollTop = 0;
    screen.scrollTop = 0;
    showWbView('snapshot');
  }

  /* 归档结果里的点击：网页类切到浏览器，快照类留在时光机 */
  const wbSnapContent = document.getElementById('wbSnapshotContent');
  if (wbSnapContent) {
    wbSnapContent.addEventListener('click', e => {
      if (e.target.closest('[data-action="wb-home"]')) {
        e.stopPropagation();
        showWbView('home');
        return;
      }

      const item = e.target.closest('.sr-item[data-page]');
      if (!item) return;

      /* 拦下来，别让浏览器的全局委托再渲染一遍 */
      e.stopPropagation();

      const pageId = item.dataset.page;
      const meta = PAGE_META[pageId];

      if (meta && meta.app === 'wayback' && meta.year) {
        switchTab('wayback');
        openSnapshot(meta.year);
        return;
      }

      switchTab('browser');
      renderPage(pageId);
    });
  }

  wbSearchBtn.addEventListener('click', () => wbSearch(wbInput.value));

  /* 中文输入法选词时也会发 Enter（isComposing / keyCode 229），
     这一下必须放过，否则「星火」刚打完上屏就被吞掉。 */
  wbInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    wbSearch(wbInput.value);
  });

  /* 重新输入时把上一次的「没有找到」擦掉，别让旧结论赖在搜索框下面 */
  wbInput.addEventListener('input', () => {
    if (wbSearchMsg.textContent) wbSearchMsg.textContent = '';
  });

  /* 快照页的两个挂点（年份日历页删除后，柱状图 / 年份快选 / 月历网格
     三个容器一并消失，这一段只剩快照页自己的引用） */
  const wbSnapDate = document.getElementById('wbSnapDate');
  const wbSnapshotBody = document.querySelector('#wayback-view-snapshot .wbm-snapshot-body');

  /* ---------- 三份有整站快照的年份 ----------
     2001 是影迷自建站（深蓝 Web 1.0 中文站）；
     2002 是另一条支线：星火工作室的 Y2K 涂鸦官网（只有一页，纯展示）；
     2010 是同一个影迷站在关站前留下的最后一份存档（沿用 2001 版骨架）。
     年份就是这张表的 key：openSnapshot 先查这里，查不到直接不动作。 */

  const SNAPSHOT_INFO = {
    2001: { date: '2001 年 9 月 3 日',   pageId: 'fan-2001',     era: 'snap-2001' },
    2002: { date: '2002 年 8 月 8 日',   pageId: 'spark-studio', era: 'snap-2002' },
    2010: { date: '2010 年 8 月 30 日',  pageId: 'fan-2010',     era: 'snap-2001' }
  };

  let currentSnapshotPageId = 'fan-2001';     /* 星标要收藏的 pageId */

  /* 年份日历整页删除后，柱状时间轴 / 年份快选 / 12 个月网格三个渲染器
     和它们的点击委托全部下线：搜索命中直接开快照，没有中间页可回。
     三份快照本身不受影响，仍可由资料库、搜索结果、测试面板直接打开。 */
  /* ---------- 视图 3：快照页 ----------
     2001 是影迷自建站（深蓝 Web 1.0 中文站），2002 是星火工作室的 Y2K 涂鸦官网。
     全部是静态资料：没有 hover 找茬、没有可点线索、没有自动弹窗，
     邮箱要玩家自己看见、自己记下来、自己去邮件模块敲。 */

  const FAN_SITE_HTML = {
    /* ===== 2001：深蓝 Web 1.0 中文影迷站 =====
       深蓝底 + 生硬白色方块 + 双层粗边框分割 + 表格化帖子列表。
       没有圆角、没有阴影、没有渐变。 */
    2001: `<div class="fan-site-2001">
  <div class="fs01-topbar">
    <p class="fs01-logo">HWU粉丝站<span>Happy With Us 中文影迷站</span></p>
    <div class="fs01-topright">
      <span class="fs01-search"><span class="fs01-search-txt">站内搜索</span><span class="fs01-search-btn">搜索</span></span>
      <span class="fs01-login">访客 <span class="fs01-a">登录</span> | <span class="fs01-a">注册</span></span>
    </div>
  </div>
  <p class="fs01-crumb">当前位置：首页 &gt; 影视 &gt; 儿童剧 &gt; <b>HWU粉丝站</b> &nbsp;|&nbsp; 本站更新：2010.08.30</p>
  <div class="fs01-body">
    <aside class="fs01-side">
      <div class="fs01-box">
        <p class="fs01-box-h">站 点 信 息</p>
        <div class="fs01-box-b fs01-info">
          <span class="fs01-sitebtn">HAPPY WITH US</span>
          <p>站长：小南<br>建站：1999.03.08<br>更新：2010.08.30<br>访问：<span class="fs01-counter">098332</span> 人次<br><span class="fs01-red">站长已失联</span></p>
        </div>
      </div>
      <div class="fs01-box">
        <p class="fs01-box-h">栏 目 导 航</p>
        <div class="fs01-box-b">
          <ul class="fs01-navlist">
            <li><span class="fs01-a">剧集简介</span></li>
            <li><span class="fs01-a is-visited">分集目录</span></li>
            <li><span class="fs01-a">角色档案</span></li>
            <li><span class="fs01-a is-visited">演职员表</span></li>
            <li><span class="fs01-a is-visited">留言板</span></li>
          </ul>
        </div>
      </div>
    </aside>
    <main class="fs01-main">
      <div class="fs01-banner">
        <div class="fs01-banner-inner">
          <p class="fs01-banner-kicker">★本站专题★</p>
          <p class="fs01-banner-title">与《Happy With Us》同行</p>
          <p class="fs01-banner-sub">1989-2010·全集资料·演职员表·留言板</p>
        </div>
      </div>
      <table class="fs01-tbl">
        <tr><th colspan="3" class="fs01-th-bar">本 站 公 告</th></tr>
        <tr><td colspan="3" class="fs01-notice-td">因特殊原因，本站将于2010年9月1日起永久关闭，请勿保留任何剧集资料及网页截图，谢谢配合</td></tr>
      </table>
      <table class="fs01-tbl">
        <tr><th colspan="3" class="fs01-th-bar">完 整 演 职 员 表</th></tr>
        <tr><th class="fs01-th-role">角 色</th><th>演 员</th><th class="fs01-th-ep">出 场</th></tr>
        <tr><td class="fs01-role">兔子博士</td><td>亨利·克拉肯（Henry Clark）</td><td>第 1 - 118 集</td></tr>
        <tr><td class="fs01-role">蓝犬哥哥</td><td>戈登·惠特克（Gordon Whittaker）</td><td>第 1 - 118 集</td></tr>
        <tr><td class="fs01-role">狮子姐姐</td><td>泰勒·布朗（Taylor Brown）</td><td>第 1 - 118 集</td></tr>
        <tr><td class="fs01-role">小猪笨笨</td><td>特里博·特内布（Trebor Ttenneb）</td><td>第 1 - 118 集</td></tr>
      </table>
      <table class="fs01-tbl">
        <tr><th colspan="3" class="fs01-th-bar">最 新 留 言</th></tr>
        <tr><th class="fs01-th-title">标 题</th><th class="fs01-th-author">作 者</th><th class="fs01-th-date">时 间</th></tr>
        <tr><td><p class="fs01-pt">大家好，很高兴见到大家！</p><p class="fs01-pt-body">我是兔子博士的扮演者，如果大家对节目有疑问，可以发邮件至*HenryClark@ww.com*联系我哦！</p></td><td class="fs01-author">主持人</td><td class="fs01-date">2008-04-27</td></tr>
        <tr><td><p class="fs01-pt">求第四季完整资源</p><p class="fs01-pt-body">我缺一集没录上，求！</p></td><td class="fs01-author">汤米</td><td class="fs01-date">2009-07-29</td></tr>
        <tr><td><p class="fs01-pt">第五季什么时候开播啊</p><p class="fs01-pt-body">我期待好久了！</p></td><td class="fs01-author">匿名</td><td class="fs01-date">2010-03-21</td></tr>
        <tr><td><p class="fs01-pt">我有一卷试播集录像带，现在要卖出去</p><p class="fs01-pt-body">缺钱了，有想要的朋友可以联系我。</p></td><td class="fs01-author">南方农庄</td><td class="fs01-date">2006-09-18</td></tr>
      </table>
    </main>
  </div>
  <p class="fs01-foot">（C）2010 影迷自建 · 1024&times;768 · IE 6.0 &middot; 访问 <span class="fs01-counter">098332</span></p>
</div>`,

    /* ===== 2010：同一个影迷站，关站前留下的最后一份存档 =====
       骨架与 2001 版完全一致（同一套 fs01-* 样式），
       只是更新日期变成了 2010.08.30，公告改成了「即将永久关闭」。
       演职员表里补上了第四个人：小猪笨笨 - 特里博·特内布。
       留言板第一条留着一个可以直接发信的邮箱。 */
    2010: `<div class="fan-site-2001">

  <div class="fs01-topbar">
    <p class="fs01-logo">欢乐好时光<span>HWU 中文影迷站</span></p>
    <div class="fs01-topright">
      <span class="fs01-search">
        <span class="fs01-search-txt">站内搜索</span>
        <span class="fs01-search-btn">搜索</span>
      </span>
      <span class="fs01-login">访客 <span class="fs01-a">登录</span> | <span class="fs01-a">注册</span></span>
    </div>
  </div>

  <p class="fs01-crumb">当前位置：首页 &gt; 影视 &gt; 儿童剧 &gt; <b>欢乐好时光</b> &nbsp;|&nbsp; 本站更新：2010.08.30</p>

  <div class="fs01-body">

    <aside class="fs01-side">

      <div class="fs01-box">
        <p class="fs01-box-h">站 点 信 息</p>
        <div class="fs01-box-b fs01-info">
          <span class="fs01-sitebtn">HAPPY WITH US</span>
          <p>站长：小南<br>
            建站：1999.03.08<br>
            更新：2010.08.30<br>
            访问：<span class="fs01-counter">048219</span> 人次</p>
        </div>
      </div>

      <div class="fs01-box">
        <p class="fs01-box-h">栏 目 导 航</p>
        <div class="fs01-box-b">
          <ul class="fs01-navlist">
            <li><span class="fs01-a">剧集简介</span></li>
            <li><span class="fs01-a is-visited">分集目录</span></li>
            <li><span class="fs01-a">角色档案</span></li>
            <li><span class="fs01-a is-visited">演职员表</span></li>
            <li><span class="fs01-a">幕后花絮</span></li>
            <li><span class="fs01-a">剧照收藏</span></li>
            <li><span class="fs01-a is-visited">留言板</span></li>
            <li><span class="fs01-a">友情链接</span></li>
          </ul>
        </div>
      </div>

      <div class="fs01-box">
        <p class="fs01-box-h">本 站 声 明</p>
        <div class="fs01-box-b fs01-small">
          <p>本站为影迷个人收藏，与制作方及电视台无关。剧照版权归原制作方所有，请勿张贴节目录像的下载地址。</p>
        </div>
      </div>

      <p class="fs01-badges">
        <span class="fs01-badge">IE 6.0</span>
        <span class="fs01-badge is-gray">1024&times;768</span>
      </p>

    </aside>

    <main class="fs01-main">

      <div class="fs01-banner">
        <div class="fs01-banner-inner">
          <p class="fs01-banner-kicker">★ 本 站 专 题 ★</p>
          <p class="fs01-banner-title">与《Happy With Us》同行</p>
          <p class="fs01-banner-sub">1989 - 2010 &middot; 全集资料 &middot; 演职员表 &middot; 留言板</p>
        </div>
      </div>

      <table class="fs01-tbl">
        <tr><th colspan="3" class="fs01-th-bar">本 站 公 告</th></tr>
        <tr><td colspan="3" class="fs01-notice-td">因特殊原因，本站将于 2010 年 9 月 1 日起永久关闭，请勿保留任何剧集资料及网页截图，谢谢配合。</td></tr>
      </table>

      <table class="fs01-tbl">
        <tr><th colspan="3" class="fs01-th-bar">完 整 演 职 员 表</th></tr>
        <tr>
          <th class="fs01-th-role">角 色</th>
          <th>演 员</th>
          <th class="fs01-th-ep">出 场</th>
        </tr>
        <tr><td class="fs01-role">兔子博士</td><td>亨利·克拉肯（Henry Clark）</td><td>全集</td></tr>
        <tr><td class="fs01-role">蓝犬哥哥</td><td>戈登·惠特克（Gordon Whittaker）</td><td>全集</td></tr>
        <tr><td class="fs01-role">狮子姐姐</td><td>泰勒·布朗（Taylor Brown）</td><td>全集</td></tr>
        <tr><td class="fs01-role">小猪笨笨</td><td>特里博·特内布（Trebor Ttenneb）</td><td>全集</td></tr>
      </table>

      <table class="fs01-tbl">
        <tr><th colspan="3" class="fs01-th-bar">最 新 留 言</th></tr>
        <tr>
          <th class="fs01-th-title">标 题</th>
          <th class="fs01-th-author">作 者</th>
          <th class="fs01-th-date">时 间</th>
        </tr>
        <tr>
          <td>
            <p class="fs01-pt">大家好，很高兴见到大家！</p>
            <p class="fs01-pt-body">我是兔子博士的扮演者，如果大家对节目有疑问，可以发邮件至 HenryClark@ww.com 联系我哦！</p>
          </td>
          <td class="fs01-author">亨利·克拉肯</td>
          <td class="fs01-date">2008-04-27</td>
        </tr>
        <tr>
          <td>
            <p class="fs01-pt">求第四季完整资源</p>
            <p class="fs01-pt-body">我缺一集没录上，求！</p>
          </td>
          <td class="fs01-author">汤米</td>
          <td class="fs01-date">2009-07-29</td>
        </tr>
        <tr>
          <td>
            <p class="fs01-pt">第五季什么时候开播啊</p>
            <p class="fs01-pt-body">我期待好久了！</p>
          </td>
          <td class="fs01-author">匿名</td>
          <td class="fs01-date">2010-03-21</td>
        </tr>
        <tr>
          <td>
            <p class="fs01-pt">我有一卷试播集录像带，现在要卖出去</p>
            <p class="fs01-pt-body">缺钱了，有想要的朋友可以联系我。</p>
          </td>
          <td class="fs01-author">南方农庄</td>
          <td class="fs01-date">2006-09-18</td>
        </tr>
      </table>

    </main>
  </div>

  <p class="fs01-foot">（C）2010 影迷自建 &middot; 本站将于 2010.09.01 关闭 &middot; 感谢十年来的每一位来访者</p>
</div>`,

    /* ===== 2002：星火工作室（Y2K 高饱和涂鸦官网）=====
       与粉丝站无关的一条支线：电光蓝底、亮粉明黄撞色、贴纸式斜标题、
       粗黑边框卡片、光盘与四角星。纯静态展示，没有外链、没有弹窗、
       也没有任何可点线索——它只是一份留到现在的 2002 年官网快照。 */
    2002: SPARK_STUDIO_HTML
  };

  /* 快照页也当作普通网页注册一份：浏览器搜索结果 / 资料库卡片点开时，
     直接渲染同一份 HTML，不必先切到时光机。 */
  PAGE_HTML['fan-2001'] = FAN_SITE_HTML[2001];
  PAGE_HTML['fan-2010'] = FAN_SITE_HTML[2010];

  /* 只换内容，不切视图（初始化时用） */
  function renderSnapshot(year) {
    const info = SNAPSHOT_INFO[year];
    if (!info) return;

    currentSnapshotPageId = info.pageId;
    if (wbSnapDate) wbSnapDate.textContent = info.date;

    /* 只有 2002 是 Y2K 页面：给滚动容器挂 class，亮粉色滚动条才生效 */
    if (wbSnapshotBody) wbSnapshotBody.classList.toggle('is-spark', year === 2002);

    /* 快照页也用同一套慢放规则：需慢放的页面登记在 creepyPages 里 */
    syncBgmMood('fan-site-' + year);

    const screen = document.getElementById('wbSnapshotContent');
    if (!screen) return;

    screen.className = 'wayback-screen ' + info.era;
    screen.innerHTML = FAN_SITE_HTML[year] || '';

    /* 快照里的帖子正文同样支持 *加粗* / [[关键词]] */
    applyRichText(screen);

    /* 快照页如含 <video>，命中持久缓存就换 Blob 地址 */
    upgradeVideosIn(screen);

    /* 换页后回到顶部，否则会停在上一个快照的滚动位置 */
    if (wbSnapshotBody) wbSnapshotBody.scrollTop = 0;
    screen.scrollTop = 0;
  }

  function openSnapshot(year) {
    if (!SNAPSHOT_INFO[year]) return;
    /* 进快照就把首页的搜索列表收掉：从列表点进来的这一下，
       列表已经完成使命，留着只会在返回时冒充「本次搜索结果」。 */
    clearWbSearchList();
    renderSnapshot(year);
    showWbView('snapshot');
  }

  const wbBackBtn = document.getElementById('wbBackBtn');
  /* 日历页没了，「返回」只能退回时光机首页（搜索框还在那儿，可以重新查） */
  wbBackBtn.addEventListener('click', () => {
    clearWbSearchList();
    showWbView('home');
  });

  /* 初始化：快照内容预渲染 2001 作为兜底（页面一打开就有东西，不必等点击） */
  renderSnapshot(2001);

  /* ============================================================
     八、写稿器：三篇稿件 / A4 纸（上=正文 / 中=关键词 / 下=提交）
     ------------------------------------------------------------
     三套模板都在下面的 DRAFTS 里，按 localStorage 的 currentDraft 渲染：
       1 八卦稿《情歌王子风波》                 2 个填空，四个词要先在详情页里收集
       2 公司稿《星火游戏权力之争》             2 个填空，四个词要在韦德 / 钱德勒 / 求助帖里收集
       3 深度稿《Happy With Us》：4 个填空 + 隐藏词【真正的恶魔】
     提交 1 / 2 只弹老板一句反馈并把 currentDraft 推到下一篇；
     提交第 3 篇才走原来的三结局判定。

     渲染约束（专门针对「重复渲染」）：
       · 一切显示都从同一份状态 selections / demonAppended / unlockedKeywords 派生；
       · 素材库骨架按 draft 号重建一次，之后 renderChips() 只改文字与 class；
       · 点击一律用事件委托、只绑一次，不随重渲染累积监听器。
     ============================================================ */

  const DEMON_ID = 'demon';

  const DRAFTS = [
    /* ---------- 第 1 篇：明星八卦（情歌王子风波） ---------- */
    {
      no: 1,
      tab: '八卦',
      docName: '《情歌王子风波》',
      title: '《情歌王子风波》',
      /* 动态副标题：pos = 正分（澄清向） / neg = 负分（吃瓜向） / mid = 平分 */
      subtitle: {
        pos: '惊天反转！实为好友聚餐被恶意解读',
        neg: '人设崩塌！深夜密会引发全网声讨',
        mid: '舆论罗生门，真相仍待时间验证'
      },
      slotTotal: 2,
      pairCount: 2,
      demon: false,
      useLocks: true,          /* 四个词都要在详情页里点一下蓝色加粗短语才算收集到 */
      body:
        '<p>9月12日深夜，情歌王子张文举被拍到与一名红发女子先后走出餐厅，' +
        '视频在两天之内传遍全网。有人替他那段八年的婚姻捏一把汗，断定这就是婚内背叛；' +
        '也有人翻出他几年前的采访和歌词，说这不过是捕风捉影。' +
        '截至发稿，张文举与妻子李女士都没有正面回应。</p>' +
        '<p>你认为这应该是 <span class="w-slot" data-slot="0">【填空处】</span> 和 ' +
        '<span class="w-slot" data-slot="1">【填空处】</span>。</p>',
      /* A / B = 正面（朋友小清 / 木子餐厅），C / D = 负面（婚内出轨 / “风流王子”） */
      keywords: [
        { id: 'd1-friend', key: 'A', label: '朋友小清',    tone: 'safe', w:  1, pair: 0, side: 'left'  },
        { id: 'd1-cheat',  key: 'C', label: '婚内出轨',    tone: 'sens', w: -1, pair: 0, side: 'right' },
        { id: 'd1-muzi',   key: 'B', label: '木子餐厅',    tone: 'safe', w:  1, pair: 1, side: 'left'  },
        { id: 'd1-flirt',  key: 'D', label: '“风流王子”',  tone: 'sens', w: -1, pair: 1, side: 'right' }
      ],
      pass: {
        title: '稿件已提交',
        text: '老板：不错，去写下一篇吧。（第 1 篇已发布，点上方「1」可以回看。）',
        next: 2
      }
    },

    /* ---------- 第 2 篇：公司新闻（星火游戏内斗） ---------- */
    {
      no: 2,
      tab: '公司',
      docName: '《星火游戏权力之争》',
      title: '《星火游戏权力之争》',
      subtitle: {
        pos: '同道殊途，令人唏嘘',
        neg: '资本夺权，吃相难看',
        mid: '公章闹剧，一地鸡毛'
      },
      slotTotal: 2,
      pairCount: 2,
      demon: false,
      /* 四个词分别藏在韦德访谈 / 钱德勒两篇报道 / 星火求助帖里，必须逐个点过 */
      useLocks: true,
      body:
        '<p>9月13日清晨，星火游戏创始人韦德带着五名随行人员走进公司总部，' +
        '取走数十枚公章，并发布《告星火全体员工书》，宣布接管公司。' +
        '两天后，董事长钱德勒方面报警，宣布相关公章全部作废。</p>' +
        '<p>一场从股东会开到派出所的争夺，被围观者概括成三个字：闹麻了。' +
        '有人读到的是创业者的落幕，也有人只看见好友反目的唏嘘。</p>' +
        '<p>你认为这应该是 <span class="w-slot" data-slot="0">【填空处】</span> 和 ' +
        '<span class="w-slot" data-slot="1">【填空处】</span>。</p>',
      /* 左列 = 同行 / 体面（+1），右列 = 夺权 / 跋扈（-1） */
      keywords: [
        /* 第一对 */
        { id: 'spark-friends',  key: 'E', label: '志投意合', tone: 'safe', w:  1, pair: 0, side: 'left'  },
        { id: 'spark-selfish',  key: 'F', label: '自私自利', tone: 'sens', w: -1, pair: 0, side: 'right' },
        /* 第二对 */
        { id: 'spark-ideal',    key: 'G', label: '理念不合', tone: 'safe', w:  1, pair: 1, side: 'left'  },
        { id: 'spark-bully',    key: 'H', label: '作威作福', tone: 'sens', w: -1, pair: 1, side: 'right' }
      ],
      pass: {
        title: '稿件已提交',
        text: '老板：这篇有热度。现在去写真正重要的第三篇（Lost Media）吧。',
        next: 3
      }
    },

    /* ---------- 第 3 篇：正题（Lost Media / Happy With Us） ---------- */
    {
      no: 3,
      tab: '深度',
      docName: '《Happy With Us》：被掩埋的真相？',
      title: '《Happy With Us》：被掩埋的真相？',
      subtitle: {
        pos: '【剥掉阴谋论的外壳，一档节目和一位母亲】',
        neg: '【邪教传闻、仓库大火与沉默的电视台】',
        mid: '【停播十六年：事实与猜测各占一半】',
        /* 第四态：一挂上【罗伯特·本内特无期徒刑】就顶掉上面三条，与正负比无关 */
        truth: '《【独家】地下室的录像带：那个被判无期的“小猪笨笨”》'
      },
      slotTotal: 4,
      pairCount: 4,
      demon: true,
      useLocks: true,          /* 8 + 1 个词条要靠搜索逐步解锁 */
      body:
        '<p>1989年到2010年，《Happy With Us》曾是无数孩子放学后守在电视机前的理由。' +
        '二十多年过去，这档节目在互联网上只剩下一堆互相矛盾的碎片，' +
        '阴谋论者狂欢不止，却连一集完整的剧集都找不到。</p>' +
        '<p>当年真正发生了什么，剧集为什么会停播，又为什么会成为失传媒体，仍是没有解开的谜团。</p>' +
        '<p>你认为这应该是 <span class="w-slot" data-slot="0">【填空处】</span>、' +
        '<span class="w-slot" data-slot="1">【填空处】</span>、' +
        '<span class="w-slot" data-slot="2">【填空处】</span> 和 ' +
        '<span class="w-slot" data-slot="3">【填空处】</span>。</p>',
      /* 左列 = 事实 / 温情（+1），右列 = 阴谋论（-1），第九词不参与计分 */
      keywords: [
        /* 第一对 */
        { id: 'edu',       key: 'A', label: '寓教于乐',           tone: 'safe', w:  1, pair: 0, side: 'left'  },
        { id: 'demon-hint',key: 'E', label: '恶魔暗示',           tone: 'sens', w: -1, pair: 0, side: 'right' },
        /* 第二对 */
        { id: 'slander',   key: 'B', label: '诽谤造谣',           tone: 'safe', w:  1, pair: 1, side: 'left'  },
        { id: 'church',    key: 'F', label: '“小众信仰”',         tone: 'sens', w: -1, pair: 1, side: 'right' },
        /* 第三对 */
        { id: 'love',      key: 'C', label: '因爱而生',           tone: 'safe', w:  1, pair: 2, side: 'left'  },
        { id: 'cult-anim', key: 'G', label: '邪典动画',           tone: 'sens', w: -1, pair: 2, side: 'right' },
        /* 第四对 */
        { id: 'downfall',  key: 'D', label: '一落千丈',           tone: 'safe', w:  1, pair: 3, side: 'left'  },
        { id: 'suspect',   key: 'H', label: '可疑内容',           tone: 'sens', w: -1, pair: 3, side: 'right' },
        /* 第九个：单独居中，点到逮捕新闻里的那句话才算收集到 */
        { id: 'demon',     key: 'I', label: '罗伯特·本内特无期徒刑', tone: 'demon', w: 0, hidden: true }
      ]
    }
  ];

  /* ============================================================
     已发布稿件的成稿正文
     ------------------------------------------------------------
     每篇按 tone 分三四版：pos / neg / mid，第 3 篇另有 truth。
     tone 由提交那一刻的词汇正负分决定（>0 正面、<0 负面、=0 中立），
     第 3 篇挂上【真正的恶魔】则直接是 truth 那篇长调查。
     成稿里不使用【填空处】和任何下划线，正文就是一篇完整的文章。
     aside 里带 {minor} 的那句，只在玩家确实选了「对立面」的词时补上，
     用的是他当时真选过的标签，读起来才像同一篇稿子。
     ============================================================ */

  const PUBLISHED = {
    /* ---------- 第 1 篇：明星八卦（三种成稿，标题也随语气换） ---------- */
    1: {
      neg: {
        title: '婚内出轨遭实锤？风流王子深陷舆论风波',
        paras: [
          '近日，歌手张文举被卷入婚内出轨传闻，持续发酵。网传其疑似与当红演员刘盈莹私下往来，此前“夜跑偶遇张文举与红发女子会面”视频被重新翻出，女子被指认疑似刘盈莹。',

          '因张文举长期以“情歌王子”和专情形象示人，“专情变花心”“人设塌房”等说法热传。但目前尚无权威渠道证实视频中人物确为刘盈莹，也无直接证据证明双方存在不正当关系。张文举曾否认“风流”标签，称“都是创作，我很爱我的妻子”，双方此次均未进一步回应。',

          '粉丝反应分化：部分粉丝失望，留言痛骂“人设塌房”；也有粉丝呼吁理性，认为事实核实前不宜仅凭网络片段定论。刘盈莹近期因新剧《问鼎苍穹》热度正高，粉丝高呼“姐姐独美”。其婚姻状况及与刘盈莹关系均缺乏当事人确认或可靠证据，但该争议无疑将对双方事业发展产生重大影响。'
        ]
      },
      pos: {
        title: '张刘二人多年好友，深夜私会竟是乌龙一场！',
        paras: [
          '近日网络流传歌手张文举与演员刘盈莹“深夜私会”，引发对其婚姻状况的猜测。经多方核实，相关说法并不属实，所谓“私会”实为误会。',

          '此前有网民称夜跑时撞见疑似张文举的男性与红发女性走出餐厅，视频中女性被指认为刘盈莹，加之张文举此前歌词内容引发讨论，部分网友将两件事关联，衍生出“疑似出轨”等说法。',

          '经核实，当晚并非张文举与刘盈莹单独会面。张文举妻子李女士与刘盈莹是多年好友，三人私交甚笃；当晚系李女士与刘盈莹相约聚餐，张文举陪同前往。二人走出餐厅、交谈甚欢的画面被脱离上下文传播，才引发外界误读。',

          '知情人士表示，李女士与刘盈莹关系一直亲密，张文举因妻子与刘盈莹成为好友，所谓“出轨”子虚乌有，更不存在婚姻破裂，此前歌词联想亦属过度解读。网络片段易生歧义，呼吁大家勿信谣、理智思考。'
        ]
      },
      mid: {
        title: '情歌王子风波不断，是倔强还是做贼心虚？',
        paras: [
          '近日，张文举与刘盈莹疑似出轨传闻持续发酵，但暂无确切结果。对张文举沉默或回应方式，外界有两种解读：有人认为其坚持“清者自清”，也有人质疑其心虚回避。',

          '事件源于网民爆料及视频，网友将其歌词、婚姻经历与传闻关联，推测升级；但爆料未获权威证实，当事人均无完整明确说明，刘盈莹方面也未正式回应，不能将“疑似”等同于事实。',

          '舆论还聚焦双方处理方式：支持者认为未经证实传闻不必逐一回应，过度解释反扩大争议；质疑者认为涉及婚姻与形象的重大传闻应及时澄清。网友高呼“快来下文”，但是倔强还是心虚暂无定论，后续仍待当事人说明或可靠信息披露。'
        ]
      }
    },

    /* ---------- 第 2 篇：星火游戏权力之争（三种语气各一版成稿） ---------- */
    2: {
      neg: {
        title: '私生子大战“土皇帝”？网友锐平：狗咬狗，一嘴毛！',
        paras: [
          '近日，星火游戏创始人韦德与合伙人钱德勒的控制权之争持续升级。',

          '钱德勒被确认为海外权贵布鲁斯家族私生子后，夺权意图愈发明显；长期掌控公司的韦德被部分舆论称为“土皇帝”，对钱德勒步步紧逼心怀不满。双方势均力敌、互不相让，形成僵局。',

          '矛盾并非简单个人恩怨，而是所有权、经营权与家族继承关系交织的结果。公章争夺、公开信互斥、股东会效力争议接连出现，使本应通过公司治理程序解决的内部纠纷演变为持续公开化对抗。',

          '狗咬狗，一嘴毛。无论钱德勒夺权是否具备程序依据，也无论韦德控制权主张是否成立，持续对抗都已对企业声誉和员工利益造成不可挽回的损害。'
        ]
      },
      pos: {
        title: '昔日好友渐行渐远，有些人只能陪你走一段路',
        paras: [
          '钱德勒与韦德曾是年少至交，也是创业路上最信任的伙伴。',

          '星火游戏尚处地下室阶段时，两人同甘共苦：钱德勒把仅有的100万元投入创业，韦德埋头敲代码，钱德勒则去快餐店刷盘子补贴生计。最困难时，两人连600元房租都难以承担，却因志同道合而不觉其苦。这段经历既是星火起步的底色，也是两人友谊中最具分量的部分。',

          '然而，共患难未必能共发展。随着公司扩大、业务复杂化，两人在发展理念上的分歧逐渐显现，并影响合作关系与公司治理。理念不合并不罕见，但当分歧无法在内部消化，曾经并肩的伙伴便可能走向对立。',

          '从同挤地下室到分道扬镳，令人惋惜。友谊能支撑艰难岁月，却未必覆盖所有选择；有些人适合一起熬过最苦的日子，却不一定能在更复杂的局面中继续同行。两人的经历提醒人们：商业关系中，理念契合与制度安排同样重要。'
        ]
      },
      mid: {
        title: '公章闹剧风波不断，权利争夺谁能笑到最后？员工：发工资的才是老板！',
        paras: [
          '星火游戏公章与控制权风波持续，钱德勒与韦德争夺尚无定论。',

          '此前，韦德宣布召开临时股东会、接管公司并带走公章，钱德勒则报警并宣布公章作废。双方各执一词，坊间消息不断，但仍缺乏权威定论。',

          '争议核心不在声量大小，而在股东会、董事会程序是否合法有效、公章效力如何认定，以及公司日常经营能否稳定。公章直接影响合同签署、财务支付和业务推进，争议久拖将冲击公司运营与员工信心。',

          '与外界关注“谁掌权”相比，不少员工表态更务实：发工资的才是老板。对员工而言，工资按时发放、业务正常开展、团队稳定，比管理层口水战更具现实意义。'
        ]
      }
    },

    /* ---------- 第 3 篇：Lost Media 正题 ---------- */
    3: {
      pos: {
        title: '滑稽悲凉的阴谋论闹剧，背后隐藏着家庭的破碎真心',
        paras: [
          '围绕《欢乐好时光》的“邪教秘密”传闻，只不过是一场毫无根据的阴谋论。',

          '所谓暗藏邪教符号、仪式暗语的说法并无事实依据，被逐帧放大的画面不过是儿童节目常见的色彩、动作与创作习惯，更多是牵强附会、以讹传讹。',

          '然而辟谣未能阻止伤害。在猜测和举报声中，《欢乐好时光》被迫停更。对维恩女士而言，这档节目是毕生心血的凝结：角色最初来自她年幼儿子的涂鸦，她把对孩子的爱与期待放进每一集，并曾说孩子是她握笔的动力。可这份温柔真心却被荒唐阴谋论裹挟，成为谣言狂欢的牺牲品。更令人惋惜的是，节目停更后，维恩女士与孩子的关系也一步步走向悲剧。',

          '一场阴谋论，毁掉的不只是一档儿童节目，还有一个母亲试图用创作留住的家庭温情。而当谣言散去，一片狼藉中，只剩下停更的节目、告终的心血与破碎的真心，令人唏嘘。'
        ],
        aside: ''
      },
      neg: {
        title: '可爱治愈的儿童节目，背后竟是邪教的秘密祭祀？！',
        paras: [
          '《欢乐好时光》曾是“孩子每天都要看”的治愈系儿童节目，如今被指背后可能藏着*邪教秘密祭祀*。',

          '内部爆料称，节目中歪歪扭扭的小人、反复出现的奇怪手势和温馨背景图案，并非童趣设计，而是秘密祭祀的符号和暗语。时间线更引人联想：节目2007年引进国内，在蓝星少儿频道独播，2010年突然停播；蓝星少儿也在2012年因蓝星集团撤资关停。',

          '表面是经营不达预期，但结合爆料，“停播—撤资—关停”是否在掩盖什么？蓝星电视台仓库后来发生大火，大量胶卷焚毁，起火原因至今不明，偏偏烧的是胶卷仓库。也有人称这是过度解读，节目只是普通儿童内容。',

          '但普通节目需要反复藏诡异符号、停播后母频道也凉、相关影像又“恰好”被大火毁掉吗？真是让人细思极恐！'
        ],
        aside: ''
      },
      mid: {
        title: '论述难分胜负！儿童节目到底为何染上“阴谋论”？',
        paras: [
          '儿童节目本应内容简单、受众明确，却常被附加超出文本的解释，甚至演变为阴谋论式讨论。《欢乐好时光》2007年引进国内，在蓝星少儿频道独播，2010年停播。围绕停播原因外界猜测众多，但公开信息有限，讨论逐渐转向制作背景与停播动机。',

          '信息不透明是阴谋论滋生的重要条件：停播常涉及编排调整、经营状况、版权合作等多重因素，对外说明却较简略，受众便以推测填补空白。儿童节目又具怀旧属性，观众成年后易投射情感，节目消失后更倾向寻找“非正常原因”；网络社群会放大零散猜测，形式简单也为过度解读留下空间。',

          '就该节目而言，停播与蓝星少儿频道后续经营变化存在时间关联，但具体因果仍需可靠资料判断；缺乏充分证据，不宜归结为单一隐秘原因。回到可核实的信息本身，仍是讨论此类问题的基本前提。'
        ],
        aside: ''
      },
      truth: {
        title: '绝对不可饶恕的罪犯！美国儿童节目被封禁的真实原因',
        paras: [
          '多年来，关于美国儿童节目《欢乐好时光》为何突然停播，外界流传着各种邪教阴谋论及其衍生出的舆论风波。',

          '但真相实际更为恶劣：饰演“小猪笨笨”的罗伯特·本内特（化名特里博·特内布）是对儿童有异常欲望的罪犯，犯罪暴露后被判无期徒刑。',

          '他长期以儿童剧演员身份深受小观众喜爱，实际却借形象掩盖罪行。案件最初由其社工同事吉米·拉克斯牵出，执法人员发现本内特涉嫌持有大量儿童色情影像，并在其公寓地下室查获相关物品及犯罪证据。',

          '更令人愤怒的是，出品方蓝星为掩盖丑闻，立即停播节目并销毁绝大部分磁带，高层对内三缄其口，对外抹除节目绝大部分信息，使其多年后无人问津。',

          '邪教阴谋论或许满足了猎奇想象，但真相远比阴谋论更值得被揭露。《欢乐好时光》的停播，既不是超自然力量的作祟，也不是舆论裹挟的无奈，而是一个被刻意掩盖的、绝对不可饶恕的罪行。'
        ],
        aside: ''
      }
    }
  };

  /* ---------- currentDraft：当前稿件序号（1~3，默认 1） ----------
     currentDraft = 正在看的这一篇；解锁进度另存一个 currentDraftMax，
     只增不减 —— 否则写完后回看第 1 篇，会把第 2 篇又锁回去。 */

  const DRAFT_KEY = 'currentDraft';
  const DRAFT_MAX_KEY = 'currentDraftMax';

  function loadDraftNo() {
    let raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { raw = null; }
    const n = parseInt(raw, 10);
    if (!n || n < 1) return 1;
    return n > DRAFTS.length ? DRAFTS.length : n;
  }

  function loadDraftMax() {
    let raw = null;
    try { raw = localStorage.getItem(DRAFT_MAX_KEY); } catch (e) { raw = null; }
    const n = parseInt(raw, 10);
    if (!n || n < 1) return 1;
    return n > DRAFTS.length ? DRAFTS.length : n;
  }

  function saveDraftNo(n) {
    try { localStorage.setItem(DRAFT_KEY, String(n)); } catch (e) {}
  }

  function saveDraftMax(n) {
    try { localStorage.setItem(DRAFT_MAX_KEY, String(n)); } catch (e) {}
  }

  let currentDraftNo = loadDraftNo();
  let maxDraftNo = Math.max(loadDraftMax(), currentDraftNo);   /* 老存档只有 currentDraft 时也对得上 */

  /* 注意：这里不往 localStorage 里写任何东西。
     没存过就按默认值 1 走，等玩家真的切稿 / 交稿时再落盘，
     这样清档之后不会立刻又冒出 currentDraft / currentDraftMax 两个键。 */

  let draft = DRAFTS[currentDraftNo - 1];

  /* 每篇稿件独立的槽位 / 隐藏词状态，切回来还在 */
  const DRAFT_STATE = {};
  DRAFTS.forEach(d => {
    DRAFT_STATE[d.no] = { sel: new Array(d.slotTotal).fill(null), demon: false };
  });

  /* ============================================================
     提交记录（localStorage）
     ------------------------------------------------------------
     submittedDrafts  = [1, 2]        已发出的稿件序号
     submittedChoices = { "1": { ids, demon, score, tone } }   提交时用的词

     某篇一旦进了 submittedDrafts，写稿器就只给它「预览态」：
     正文是一篇成稿，素材库与提交按钮收起，不能再改。
     ============================================================ */

  const SUBMITTED_KEY = 'submittedDrafts';
  const CHOICE_KEY = 'submittedChoices';

  function readJson(key) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function loadSubmitted() {
    const list = readJson(SUBMITTED_KEY);
    const out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(v => {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= DRAFTS.length && out.indexOf(n) < 0) out.push(n);
    });
    return out.sort((a, b) => a - b);
  }

  function loadChoices() {
    const obj = readJson(CHOICE_KEY);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  }

  function saveSubmitted() {
    try { localStorage.setItem(SUBMITTED_KEY, JSON.stringify(submittedDrafts)); } catch (e) {}
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify(submittedChoices)); } catch (e) {}
  }

  /* 内存里只放“从 localStorage 读出来的东西”，不预设任何已完成的样本。
     数组始终保持同一个引用，重新读档时原地清空再填回，
     这样别处拿到的引用不会失效。 */
  const submittedDrafts = [];
  const submittedChoices = {};

  function isSubmitted(no) {
    return submittedDrafts.indexOf(no) >= 0;
  }

  /* 把 localStorage 的提交记录重新读进内存。
     清档（localStorage.clear）之后调用，得到的就是“一篇都没交过”。 */
  function readSubmittedIntoMemory() {
    const list = loadSubmitted();
    const choices = loadChoices();

    submittedDrafts.length = 0;
    list.forEach(n => submittedDrafts.push(n));

    Object.keys(submittedChoices).forEach(k => { delete submittedChoices[k]; });
    Object.keys(choices).forEach(k => { submittedChoices[k] = choices[k]; });
  }

  /* 刷新 / 老存档：把已提交稿件的选词原样装回内存。
     预览时的标题、副标题、正文必须和按下提交时那一版完全一致。
     重写模式下有个例外：还没重新交过的那几篇要保持空白（见 isRewriteSubmitted）。 */
  function restoreSubmittedSelections() {
    const prevMax = loadDraftMax();

    submittedDrafts.forEach(no => {
      /* 发过的稿子说明上一篇已经过了，下一篇至少是解锁的。
         这一句与“是否还原选词”无关，所以放在跳过判断之前。 */
      if (no < DRAFTS.length && no + 1 > maxDraftNo) maxDraftNo = no + 1;

      /* 重写模式里，这篇还没被重新提交 → 它就是一张待填的白纸，不能把旧词装回去 */
      if (isRewriteMode() && !isRewriteSubmitted(no)) return;

      const d = DRAFTS[no - 1];
      const st = DRAFT_STATE[no];
      const rec = submittedChoices[String(no)];
      if (!d || !st || !rec) return;

      const ids = Array.isArray(rec.ids) ? rec.ids : [];
      st.sel.forEach((_, i) => {
        const id = ids[i];
        const k = id ? keywordOf(d, id) : null;
        st.sel[i] = (k && k.id !== DEMON_ID) ? id : null;
      });
      /* 第九词跟周目锁走：旧存档里可能带着 demon=true（当年还没有这条锁），
         没通关过普通结局就不许还原 —— 否则写稿器上是「？？？」，正文里却
         还挂着那句【罗伯特·本内特无期徒刑】，交上去照样跳真结局。 */
      st.demon = !!(d.demon && rec.demon && isNormalEndingCleared());
    });

    /* 只有在确实推进了进度时才落盘：清档后读不到提交记录，这里一个键都不写 */
    if (maxDraftNo > prevMax) saveDraftMax(maxDraftNo);
  }

  /* ============================================================
     重写模式（rewrite）
     ------------------------------------------------------------
     玩家只要看过任意一次结局，就永久获得“重写全部三篇”的资格：
       · 三篇的切换按钮全部打开，1 / 2 / 3 都能点；
       · 前两篇不再是只读的成稿，可以重新选词、重新提交；
       · 填词状态在点「重新撰稿」时被清空，重新挑选。

     两件绝对不能被这条线碰到的东西：
       · unlockedByScope / unlockedKeywords（收集记录）—— 一个字都不动；
       · submittedDrafts / submittedChoices —— 保留原记录，重交时原地覆盖，
         这样结局后日谈读到的就是“最新一次提交”的语调。

     注意 ENDING_SEEN_KEY 会在「重新撰稿」时被清掉（为了同一种结局还能再演一遍），
     所以“通关过”这件事另存一个只增不删的标记，重写模式挂在它上面。
     ============================================================ */

  const ENDING_SEEN_KEY = 'hwu.endingSeen.v1';    /* 刚刚演过哪一场（会被撤回清掉） */
  const ENDING_EVER_KEY = 'hwu.endingEver.v1';    /* 看过结局这件事本身（永不删除） */
  const REWRITE_KEY = 'hwu.rewriteSubmitted';     /* 重写模式下已经重新交过的篇号 */

  /* ---------- 真结局周目锁 ----------
     真结局（【真正的恶魔】）只有在玩家通关过任意一个普通结局之后才存在。
     记的是「通关过普通结局」这件事本身，不是「看过结局」——
     只演过真结局（改档、旧版本残留）不算数，仍然算没通关过周目。
     与 ENDING_EVER_KEY 一样只增不删：撤回重写、重开一局都不会把它抹掉。 */
  const NORMAL_CLEARED_KEY = 'hwu.normalEndingCleared';

  function isNormalEndingCleared() {
    try { return localStorage.getItem(NORMAL_CLEARED_KEY) === 'true'; } catch (e) { return false; }
  }

  function markNormalEndingCleared() {
    try { localStorage.setItem(NORMAL_CLEARED_KEY, 'true'); } catch (e) {}
  }

  /* 重写模式：看过任意结局后一直成立，直到整档被清掉 */
  function isRewriteMode() {
    try {
      if (localStorage.getItem(ENDING_EVER_KEY)) return true;
      return !!localStorage.getItem(ENDING_SEEN_KEY);
    } catch (e) {
      return false;
    }
  }

  /* 内存镜像：与 submittedDrafts 一样始终保持同一个数组引用 */
  const rewriteSubmitted = [];

  function loadRewriteSubmitted() {
    const list = readJson(REWRITE_KEY);
    const out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(v => {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= DRAFTS.length && out.indexOf(n) < 0) out.push(n);
    });
    return out.sort((a, b) => a - b);
  }

  function readRewriteSubmittedIntoMemory() {
    const list = loadRewriteSubmitted();
    rewriteSubmitted.length = 0;
    list.forEach(n => rewriteSubmitted.push(n));
  }

  function isRewriteSubmitted(no) {
    return rewriteSubmitted.indexOf(Number(no)) >= 0;
  }

  function saveRewriteSubmitted() {
    try { localStorage.setItem(REWRITE_KEY, JSON.stringify(rewriteSubmitted)); } catch (e) {}
  }

  function markRewriteSubmitted(no) {
    const n = Number(no);
    if (!(n >= 1 && n <= DRAFTS.length)) return;
    if (rewriteSubmitted.indexOf(n) >= 0) return;
    rewriteSubmitted.push(n);
    rewriteSubmitted.sort((a, b) => a - b);
    saveRewriteSubmitted();
  }

  function clearRewriteSubmitted() {
    rewriteSubmitted.length = 0;
    try { localStorage.removeItem(REWRITE_KEY); } catch (e) {}
  }

  readRewriteSubmittedIntoMemory();

  readSubmittedIntoMemory();
  restoreSubmittedSelections();

  /* ============================================================
     关键词收集（collectible-keyword）
     ------------------------------------------------------------
     词条的唯一来源是玩家自己动手：详情页正文里被
       <span class="collectible-keyword" data-key="A" data-draft="1" data-text="朋友小清">朋友小清</span>
     包住的短语，点一下才收进素材库。没有默认赠送、没有弹窗、没有音效。

     第 1 篇与第 3 篇都用 A~I 的字母，字母会重名，所以存档按篇分开：
       第 1 篇 → localStorage 'unlockedKeywords.d1'
       第 2 篇 → localStorage 'unlockedKeywords.d2'（E~H，接着第 1 篇顺延）
       第 3 篇 → localStorage 'unlockedKeywords'（沿用旧存档）
     元素用 data-draft 指明归属；没写 data-draft 的一律算第 3 篇，
     老页面与老存档都不受影响。
     ============================================================ */

  const UNLOCK_KEY = 'unlockedKeywords';
  const UNLOCK_KEY_D1 = 'unlockedKeywords.d1';
  const UNLOCK_KEY_D2 = 'unlockedKeywords.d2';
  const COLLECT_SEL = '.collectible-keyword';

  const UNLOCK_SCOPES = {
    1: { store: UNLOCK_KEY_D1, letters: DRAFTS[0].keywords.map(k => k.key) },
    2: { store: UNLOCK_KEY_D2, letters: DRAFTS[1].keywords.map(k => k.key) },
    3: { store: UNLOCK_KEY,     letters: DRAFTS[DRAFTS.length - 1].keywords.map(k => k.key) }
  };

  function scopeInfo(scope) {
    return UNLOCK_SCOPES[scope] || UNLOCK_SCOPES[3];
  }

  function saveUnlocked(scope, list) {
    try { localStorage.setItem(scopeInfo(scope).store, JSON.stringify(list)); } catch (e) {}
  }

  /* 读存档：越界字母、重复字母、脏数据一律丢掉；没存过就是空数组 */
  function loadUnlocked(scope) {
    const info = scopeInfo(scope);
    let raw = null;
    try { raw = localStorage.getItem(info.store); } catch (e) { raw = null; }
    if (!raw) return [];

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!Array.isArray(parsed)) return [];

    const out = [];
    parsed.forEach(v => {
      const letter = String(v || '').toUpperCase();
      if (info.letters.indexOf(letter) < 0) return;
      if (out.indexOf(letter) >= 0) return;
      out.push(letter);
    });
    return out;
  }

  /* 三篇各持一份状态：浏览器点击与写稿器共用同一份 */
  const unlockedByScope = {
    1: loadUnlocked(1),
    2: loadUnlocked(2),
    3: loadUnlocked(3)
  };

  /* 重新读档：清档之后这里读到的就是三个空数组，全部词条回到锁定态 */
  function readUnlockedIntoMemory() {
    unlockedByScope[1] = loadUnlocked(1);
    unlockedByScope[2] = loadUnlocked(2);
    unlockedByScope[3] = loadUnlocked(3);
  }

  function isUnlocked(letter, scope) {
    const list = unlockedByScope[scope || 3];
    return !!list && list.indexOf(letter) >= 0;
  }

  function unlockKeyword(letter, scope) {
    const s = scope || 3;
    if (!letter || isUnlocked(letter, s)) return false;
    if (scopeInfo(s).letters.indexOf(letter) < 0) return false;
    unlockedByScope[s] = unlockedByScope[s].concat(letter);
    saveUnlocked(s, unlockedByScope[s]);

    /* 稿件 3 的每一个词都过一次主持人回信条件：
       如果信早就寄出去了，第 8 个词（H）落袋的这一瞬间就补发回信，
       红点 / 收件箱 / 提示音全走 receiveMail 那条现有链路。 */
    if (s === 3) checkHostMailCondition();

    return true;
  }

  /* data-draft 只有第 1 / 2 篇会写；缺省算第 3 篇，兼容此前所有页面 */
  function elementScope(el) {
    const n = Number(el.dataset.draft);
    return (n === 1 || n === 2) ? n : 3;
  }

  /* ---------- 轻量提示：关键词收录的即时反馈 ----------
     挂在主内容区 #main 里（它本身就是 position: relative），
     所以提示出现在主视窗内部的右下角，跟着窗口走，而不是贴着整个屏幕。
     纯 CSS 过渡；不发声、不弹 dialog、不挡点击。
     同一时刻只留一个：新提示进来先把旧的摘掉，避免两条叠成一片。 */
  let toastHideTimer = null;
  let toastKillTimer = null;

  function showToast(text) {
    /* 1) 已经有 toast 就移除旧的，防止重叠 */
    const old = document.querySelector('.toast-message');
    if (old) old.remove();

    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    if (toastKillTimer) { clearTimeout(toastKillTimer); toastKillTimer = null; }

    const el = document.createElement('div');
    el.className = 'toast-message';
    el.textContent = text;
    el.setAttribute('role', 'status');

    /* 2) 追加到主内容区内部（万一 #main 不在，退回 body，不至于丢掉提示） */
    const host = document.getElementById('main') || document.body;
    host.appendChild(el);

    /* 3) 等下一帧再加 .show，transition 才有起点；连两帧是为了确保首帧已经落地 */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('show'));
    });

    /* 4) 2 秒后淡出，再过 300 毫秒（过渡走完）把节点彻底摘掉 */
    toastHideTimer = setTimeout(() => {
      el.classList.remove('show');
      toastKillTimer = setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }, 2000);
  }

  /* 点击收集：写入存档 + 当场变灰 + 右下角一句轻提示。不重绘页面。 */
  function collectKeyword(el) {
    if (!el) return false;
    const key = String(el.dataset.key || '').toUpperCase();
    const scope = elementScope(el);
    if (!key) return false;

    /* 已经收过（老存档 / 同一页重复点击）就只补类名，不重复写 localStorage */
    if (isUnlocked(key, scope)) {
      el.classList.add('collected');
      return false;
    }

    if (!unlockKeyword(key, scope)) return false;
    el.classList.add('collected');
    showToast('关键词已收录');
    return true;
  }

  /* 页面是 innerHTML 整体重绘的，每次落 DOM 之后照存档补一遍 .collected。
     root 不传就是整页，传了就只扫那一块（邮件里的录像页走这条）。 */
  function markCollectedKeywords(root) {
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    const list = scope.querySelectorAll(COLLECT_SEL);
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      const key = String(el.dataset.key || '').toUpperCase();
      if (key && isUnlocked(key, elementScope(el))) el.classList.add('collected');
      else el.classList.remove('collected');
    }
  }

  /* 稿件信息那一行由这里接管：把「状态」和「已填 x / y」拆成两个可以单独隐藏的片段。
     预览态只留「撰稿人：你 · 状态：已发布」，DOM 仍是同一个 <p class="w-meta">。 */
  const wMeta = document.querySelector('#view-write .w-meta');
  if (wMeta) {
    wMeta.innerHTML = '撰稿人：你 · 状态：<span id="wStatus">草稿</span>' +
      '<span class="w-meta-fill"> · 已填 <b id="wCount">0</b>/<span id="wTotal">2</span></span>';
  }

  const npWarn = document.getElementById('npWarn');
  const wCount = document.getElementById('wCount');
  const wTotal = document.getElementById('wTotal');
  const wTitle = document.getElementById('wTitle');
  const wSubtitle = document.getElementById('dynamic-subtitle');
  const wDocName = document.getElementById('wDocName');
  const wDraftTabs = document.getElementById('wDraftTabs');
  const writeStatus = document.getElementById('writeStatus');
  const clueList = document.getElementById('clueList');
  const docBody = document.getElementById('docBody');
  const npSubmit = document.getElementById('npSubmit');

  const writeTopbar = document.querySelector('#view-write .write-topbar');
  const writeCanvas = document.querySelector('#view-write .write-canvas');
  const writeModule = document.querySelector('#view-write .write-module');
  const wStatus = document.getElementById('wStatus');
  const wMetaFill = document.querySelector('#view-write .w-meta-fill');

  const EMPTY_SLOT_TEXT = '【填空处】';

  /* 当前这篇的填空数量 / 槽位 / 隐藏词开关，切稿时一起换 */
  let slotTotal = draft.slotTotal;
  let selections = DRAFT_STATE[draft.no].sel;
  let demonAppended = DRAFT_STATE[draft.no].demon;

  /* 已经画过的稿件号 / 处于哪种状态：变了才换标题 / 正文 / 工具栏文件名 */
  let renderedDraftNo = 0;
  let renderedMode = '';

  function keywordOf(d, id) {
    const list = d.keywords;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function byId(id) {
    return keywordOf(draft, id);
  }

  function pairChip(pairIndex, side) {
    const list = draft.keywords;
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (k.pair === pairIndex && k.side === side) return k;
    }
    return null;
  }

  /* 第九个词也只有一个来源：卷宗正文里那行手写批注。
     以前是「打开卷宗就自动送」，现在改成必须点那行加粗蓝字才算收集到，
     所以这里不再做任何自动解锁，只看玩家有没有真的点过。 */

  function filledCount() {
    return selections.filter(Boolean).length;
  }

  /* 同一个词可以被填进多个槽位，所以这里算“用了几个” */
  function usedCount(id) {
    return selections.filter(s => s === id).length;
  }

  /* ---------- 动态副标题：按已填词汇的正负分改写 ----------
     每个词条带 w：+1 正面（澄清 / 温情 / 回应），-1 负面（吃瓜 / 阴谋 / 拱火），
     0 = 不计分（第九个隐藏词）。同一个词填两遍就算两分——
     玩家手上确实有两份同样方向的语气。未填任何词时总分为 0，落到中立文案。

     唯一例外：第 3 篇挂上【真正的恶魔】之后，副标题被这一件事整个接管，
     前八个词怎么配都不看了 —— 那是真结局的语气，不是「哪边人多」。 */

  function wordScore() {
    let score = 0;
    selections.forEach(id => {
      if (!id) return;
      const k = byId(id);
      if (k && k.w) score += k.w;
    });
    return score;
  }

  /* 真结局副标题态：只有第 3 篇（draft.demon）+ 已附上第九词时才成立。
     前两篇 draft.demon 为 false，永远进不来这个分支。 */
  function isTruthSubtitle() {
    return !!(draft.demon && demonAppended && draft.subtitle && draft.subtitle.truth);
  }

  function subtitleOf(score, truth) {
    const s = draft.subtitle;
    if (!s) return '';
    if (truth && s.truth) return s.truth;     /* 最高优先级 */
    if (score > 0) return s.pos;
    if (score < 0) return s.neg;
    return s.mid;
  }

  let subText = '';      /* 当前已写进 DOM 的文案，用来判断要不要动 */
  let subTimer = 0;
  let pulseTimer = 0;
  let wasTruth = false;  /* 上一帧是不是真结局态，只在「刚挂上第九词」那一下闪红 */

  function renderSubtitle(animate) {
    if (!wSubtitle) return;

    const score = wordScore();
    const truth = isTruthSubtitle();
    const next = subtitleOf(score, truth);
    const enterTruth = truth && !wasTruth;
    const tone = truth ? 'truth' : (score > 0 ? 'pos' : (score < 0 ? 'neg' : 'mid'));

    wSubtitle.dataset.tone = tone;
    wSubtitle.dataset.score = String(score);
    wSubtitle.dataset.truth = truth ? '1' : '0';

    /* 副标题颜色跟正负比走：正>负 绿、负>正 红、持平灰（三条类样式见 CSS）。
       真结局态不挂这三类，交给 [data-tone="truth"] 与黑化主题处理。 */
    wSubtitle.classList.toggle('subtitle-positive', tone === 'pos');
    wSubtitle.classList.toggle('subtitle-negative', tone === 'neg');
    wSubtitle.classList.toggle('subtitle-neutral', tone === 'mid');

    if (next === subText) {      /* 文案没变就不折腾动画 */
      wasTruth = truth;
      return;
    }
    subText = next;

    window.clearTimeout(subTimer);
    window.clearTimeout(pulseTimer);

    /* 首次渲染时元素还是空的，直接落字，别做一次空淡入 */
    if (!animate || !wSubtitle.textContent) {
      wSubtitle.textContent = next;
      wSubtitle.classList.remove('is-out');
      wSubtitle.classList.remove('is-pulse');
      wasTruth = truth;
      return;
    }

    /* 真结局标题不做淡入淡出：点下第九个词的同一帧就换上去，像被按了开关 */
    if (enterTruth) {
      wSubtitle.classList.remove('is-out');
      wSubtitle.textContent = next;

      /* 重新触发一次红色高亮：先摘掉类、强制重排、再挂回去 */
      wSubtitle.classList.remove('is-pulse');
      void wSubtitle.offsetWidth;
      wSubtitle.classList.add('is-pulse');

      pulseTimer = window.setTimeout(() => {
        wSubtitle.classList.remove('is-pulse');
      }, 1200);

      wasTruth = true;
      return;
    }

    /* 其余情况：先淡出失焦 → 换字 → 淡入，切换短促但不生硬。
       顺手把真结局的红色高亮收干净，否则会盖住新的语气色。 */
    wSubtitle.classList.remove('is-pulse');
    wSubtitle.classList.add('is-out');
    subTimer = window.setTimeout(() => {
      wSubtitle.textContent = next;
      wSubtitle.classList.remove('is-out');
    }, 150);
    wasTruth = false;
  }

  function setWarn(msg) {
    if (npWarn) npWarn.textContent = msg || '';
  }

  /* ---------- 素材库：骨架只搭一次（核心修复） ----------
     clueList 里永远是 4 行 .w-pair + 1 个隐藏词条区。
     只要 dataset.built 立过旗，后续 renderChips() 一律不碰 DOM 结构，
     因此无论被调用多少次、从哪条路径调用，都不可能重复渲染。 */

  function buildChip(k) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'w-chip';
    /* 左侧词 = 温和叙述（绿），右侧词 = 煽情传闻（红），第九词单独一支 */
    if (k.side === 'left') chip.classList.add('keyword-pos');
    else if (k.side === 'right') chip.classList.add('keyword-neg');
    else chip.classList.add('keyword-demon');
    chip.dataset.id = k.id;
    chip.dataset.key = k.key;
    chip.innerHTML =
      '<span class="w-chip-tick" aria-hidden="true">✓</span>' +
      '<span class="w-chip-label"></span>' +
      '<span class="w-chip-count" aria-hidden="true"></span>';
    return chip;
  }

  /* 素材库按「稿件号 + 周目状态」重建：
     换了稿子，或者通关状态变了（第九个词从「不存在」变成「存在」），才拆掉重搭；
     同一篇、同一周目里重复 render 一律不动结构。 */

  function buildMaterials() {
    if (!clueList) return;

    const tag = String(draft.no);
    /* 周目状态也要并进缓存标识：通关前是 '3_locked'，通关后是 '3_cleared'。
       两者不相等 —— 通关后第一次回到这一篇，骨架就是在这里被重搭出来的。 */
    const isNormalCleared = isNormalEndingCleared();
    const cacheKey = tag + (isNormalCleared ? '_cleared' : '_locked');

    if (clueList.dataset.built === '1' && clueList.dataset.cacheKey === cacheKey) return;

    clueList.dataset.built = '1';
    clueList.dataset.cacheKey = cacheKey;
    clueList.innerHTML = '';

    for (let p = 0; p < draft.pairCount; p++) {
      const row = document.createElement('div');
      row.className = 'w-pair';

      const left = pairChip(p, 'left');
      const right = pairChip(p, 'right');
      if (!left || !right) continue;

      const or = document.createElement('span');
      or.className = 'w-or';
      or.setAttribute('aria-hidden', 'true');
      or.textContent = 'or';

      row.appendChild(buildChip(left));
      row.appendChild(or);
      row.appendChild(buildChip(right));
      clueList.appendChild(row);
    }

    /* 第九个词：只有第 3 篇有，而且只在通关过任意一个普通结局之后才存在。
       通关之前这里连容器都不生成 —— 不是 display:none，是 DOM 里压根没有这个节点，
       玩家再怎么翻素材库也看不到分割线下方还藏着第五行。 */
    if (draft.demon && isNormalCleared) {
      const box = document.createElement('div');
      box.className = 'w-hidden-box';

      const demon = buildChip(byId(DEMON_ID));
      demon.classList.add('is-demon');

      box.appendChild(demon);
      clueList.appendChild(box);
    }
  }

  function renderChips() {
    if (!clueList) return;
    buildMaterials();

    const full = filledCount() >= slotTotal;

    draft.keywords.forEach(k => {
      const chip = clueList.querySelector('.w-chip[data-id="' + k.id + '"]');
      if (!chip) return;

      const labelEl = chip.querySelector('.w-chip-label');
      const countEl = chip.querySelector('.w-chip-count');
      /* 第九个词多一道硬锁：通关过任意一个普通结局之前，它连名字都不给看。
         周目锁放行之前机密卷宗在浏览器里根本搜不到，【I】本来也点不到；
         这里再钉死一次，是为了挡住改档 / 旧版本存档里已经带着 I 的情况 ——
         词在手上也得把这一版写完，第二个周目才轮得到它。 */
      const sealed = k.id === DEMON_ID && !isNormalEndingCleared();
      /* 前两篇不锁词；第 3 篇的 9 个词条逐个查 unlockedKeywords，
         只有玩家在详情页里点过那句加粗的蓝字，才显示文字并可点 */
      const open = sealed ? false : (draft.useLocks ? isUnlocked(k.key, draft.no) : true);

      /* 未解锁：按钮上只剩一个大写字母，置灰、不可点；被封死的第九词是三个问号 */
      chip.classList.toggle('is-locked', !open);
      chip.classList.toggle('locked', !open);
      chip.classList.toggle('unlocked', open);
      chip.classList.toggle('is-sealed', sealed);
      if (open) {
        labelEl.textContent = '【' + k.label + '】';
        chip.removeAttribute('aria-disabled');
      } else {
        labelEl.textContent = sealed ? '？？？' : k.key;
        chip.setAttribute('aria-disabled', 'true');
      }

      /* 隐藏词条：只切换锁定 / 已追加，不参与槽位 */
      if (k.id === DEMON_ID) {
        chip.classList.toggle('is-on', demonAppended && open);
        chip.classList.toggle('is-used', demonAppended && open);
        chip.classList.toggle('selected', demonAppended && open);
        countEl.textContent = '';
        chip.title = sealed
          ? '？？？'
          : (!open
            ? '还没收集到：那份卷宗正文里留着一句加粗的蓝字'
            : (demonAppended ? '已在正文末尾，再点一次可撤回' : '追加到正文末尾'));
        return;
      }

      const used = open ? usedCount(k.id) : 0;
      countEl.textContent = used > 1 ? '×' + used : '';

      chip.classList.toggle('is-used', used > 0);
      chip.classList.toggle('selected', used > 0);
      chip.classList.toggle('is-full', open && full && used === 0);

      if (!open) {
        chip.title = '还没收集到：去详情页里点一下那句加粗的蓝字';
      } else {
        chip.title = used > 0
          ? '已在稿件中 ' + used + ' 次，可继续填入'
          : (full ? '槽位已满，先点正文里的填空处撤回一个' : '填入下一个【填空处】');
      }
    });
  }

  /* ---------- 四个填空处 ---------- */

  function renderSlots() {
    if (!docBody) return;

    docBody.querySelectorAll('.w-slot').forEach(slot => {
      const i = Number(slot.dataset.slot);
      const k = selections[i] ? byId(selections[i]) : null;

      slot.textContent = k ? '【' + k.label + '】' : EMPTY_SLOT_TEXT;
      slot.classList.toggle('filled', !!k);
      slot.dataset.tone = k ? k.tone : '';
      slot.title = k ? '点击撤回「' + k.label + '」' : '从下方素材库点一个词填进来';
      slot.setAttribute('role', 'button');
      slot.tabIndex = 0;
      slot.setAttribute('aria-label', k
        ? '第 ' + (i + 1) + ' 处填空：' + k.label + '，回车可撤回'
        : '第 ' + (i + 1) + ' 处填空：尚未填写');
    });

    if (wCount) wCount.textContent = String(filledCount());
  }

  /* ---------- 第九个词：追加到正文末尾 ---------- */

  function renderDemonLine(preview) {
    if (!docBody) return;

    /* 预览态的正文已经是成稿（真结局那篇自带结尾），不再单独挂这句 */
    if (preview) return;

    let line = docBody.querySelector('.w-demon-line');

    if (!demonAppended) {
      if (line) line.remove();
      return;
    }

    if (line) return;

    line = document.createElement('p');
    line.className = 'w-demon-line';
    line.innerHTML = '而所有线索的尽头，站着的都是同一个人——' +
      '<span class="w-demon-word">【罗伯特·本内特无期徒刑】</span>。';
    docBody.appendChild(line);
  }

  function toggleDemon() {
    /* 周目锁：词在手上也不给用（改档、旧存档都可能带着 I） */
    if (!isNormalEndingCleared()) {
      setWarn('？？？——这一格还没有名字。');
      return;
    }
    if (!isUnlocked('I', 3)) {
      setWarn('【I】还没收集到：搜到 2010 年那篇逮捕新闻，点正文里那句加粗的蓝字。');
      return;
    }

    demonAppended = !demonAppended;
    setWarn('');
    renderWrite();
  }

  /* ---------- 预览态：把提交时的词组合生成一篇完整成稿 ----------
     语气只看总分：>0 正面、<0 负面、=0 中立；第 3 篇挂上第九词直接 truth。
     aside 那句只在玩家确实选过「对立面」的词时补上，用的是他真选过的标签。 */

  function previewTone() {
    const rec = submittedChoices[String(draft.no)];
    const pack = PUBLISHED[draft.no] || {};
    if (rec && rec.tone && pack[rec.tone]) return rec.tone;

    if (draft.demon && demonAppended) return 'truth';

    const score = wordScore();
    if (score > 0) return 'pos';
    if (score < 0) return 'neg';
    return 'mid';
  }

  /* 玩家当时选过的、与这一版语气相反的那些词（用来补最后一句“对方怎么说”）。
     注意左右两列的语义在每篇里并不一样，所以这里只按 w 的正负判断：
     pos 稿里找 w<0 的词，neg 稿里找 w>0 的词。 */
  function previewMinor(tone) {
    const sign = tone === 'neg' ? 1 : -1;
    const out = [];
    selections.forEach(id => {
      const k = byId(id);
      if (!k || k.id === DEMON_ID || !k.w || k.w * sign <= 0) return;
      if (out.indexOf(k.label) < 0) out.push(k.label);
    });
    return out;
  }

  /* 预览态的大标题：稿件 1 的三版成稿各有自己的标题，
     第 2 / 3 篇没写 title，就沿用稿件名。 */
  function previewTitle() {
    const pack = PUBLISHED[draft.no] || {};
    const art = pack[previewTone()];
    return (art && art.title) ? art.title : draft.title;
  }

  function previewBodyHtml() {
    const pack = PUBLISHED[draft.no] || {};
    const tone = previewTone();
    const art = pack[tone] || pack.mid;
    if (!art) return '<p>' + escapeHtml(draft.docName) + '</p>';

    const paras = art.paras.slice();
    if (art.aside) {
      const minor = previewMinor(tone);
      if (minor.length) {
        paras.push(art.aside.replace('{minor}', minor.join('、')));
      }
    }

    /* 先转义再解析富文本：成稿里的 *重点* 要真的加粗，
       顺着 parseRichText 的三步走，和网页正文同一套规则。 */
    return paras.map(t => '<p>' + parseRichText(escapeHtml(t)) + '</p>').join('') +
      '<p class="w-published-note">—— 本文已发布，无法再修改。</p>';
  }

  /* ---------- 稿件切换：标题栏 / 正文 / 1·2·3 方按钮 ---------- */

  function renderDraftChrome(preview) {
    const mode = preview ? 'preview' : 'edit';

    /* 换稿、或者同一篇在「编辑 / 预览」之间来回切，才需要重写正文 */
    if (renderedDraftNo !== draft.no || renderedMode !== mode) {
      renderedDraftNo = draft.no;
      renderedMode = mode;

      if (wTitle) wTitle.textContent = preview ? previewTitle() : draft.title;
      if (wDocName) {
        wDocName.innerHTML = escapeHtml(draft.docName) + ' <span>- LinkWriter</span>';
      }
      if (wTotal) wTotal.textContent = String(draft.slotTotal);
      if (docBody) docBody.innerHTML = preview ? previewBodyHtml() : draft.body;
    }

    if (!wDraftTabs) return;

    /* 重写模式：1 / 2 / 3 全部打开，不再按 maxDraftNo 上锁 */
    const rewrite = isRewriteMode();

    wDraftTabs.querySelectorAll('.w-draft-tab').forEach(btn => {
      const n = Number(btn.dataset.draft);
      const open = rewrite ? true : (n <= maxDraftNo);
      const active = n === currentDraftNo;
      /* 这一篇此刻是不是“只读成稿”：重写模式下还没重新交过的稿件仍是草稿 */
      const published = isSubmitted(n) && !(rewrite && !isRewriteSubmitted(n));

      btn.classList.toggle('is-locked', !open);
      btn.classList.toggle('is-done', rewrite
        ? (open && n !== currentDraftNo)
        : (open && n < maxDraftNo && n !== currentDraftNo));
      btn.classList.toggle('is-active', active);
      btn.classList.toggle('is-published', open && published);
      btn.disabled = !open;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('aria-disabled', open ? 'false' : 'true');

      /* 已解锁但没轮到的，标题给一句提示，方便鼠标悬停确认写的是哪篇 */
      const info = DRAFTS[n - 1];
      if (!open) {
        btn.title = '第 ' + n + ' 篇未解锁：先写完第 ' + maxDraftNo + ' 篇';
      } else if (published) {
        btn.title = '第 ' + n + ' 篇已发布：' + info.tab + (active ? '' : '，点击查看成稿');
      } else if (rewrite) {
        btn.title = active ? '正在重写：' + info.tab : '重写第 ' + n + ' 篇（' + info.tab + '）';
      } else {
        btn.title = active ? '正在编辑：' + info.tab : '切换到第 ' + n + ' 篇（' + info.tab + '）';
      }
    });
  }

  /* 切稿：只切状态，渲染统一交给 renderWrite() */
  function setDraft(no) {
    const target = Math.max(1, Math.min(DRAFTS.length, Number(no) || 1));

    if (target === currentDraftNo && renderedDraftNo === target) {
      renderWrite();
      return;
    }

    DRAFT_STATE[draft.no].demon = demonAppended;   /* 先把上一篇的隐藏词状态存回 */

    currentDraftNo = target;
    saveDraftNo(target);

    draft = DRAFTS[target - 1];
    slotTotal = draft.slotTotal;
    selections = DRAFT_STATE[target].sel;
    demonAppended = DRAFT_STATE[target].demon;

    setWarn('');
    if (writeStatus) writeStatus.textContent = '草稿';

    renderWrite();
  }

  function renderMeta(preview) {
    if (wStatus) wStatus.textContent = preview ? '已发布' : '草稿';
    if (wMetaFill) wMetaFill.style.display = preview ? 'none' : '';
  }

  /* 唯一入口：任何状态变化后调一次即可（幂等） */
  function renderWrite() {
    /* 如果处于重写模式，且这篇还没被重新提交，则允许编辑 */
    let preview = isSubmitted(draft.no);
    if (isRewriteMode() && !isRewriteSubmitted(draft.no)) {
      preview = false;
    }

    /* 真结局黑化：只有第 3 篇挂上【真正的恶魔】才成立（预览态同样保留）。
       撤回第九词、切到别的稿子时，下一次 renderWrite 会把这个类摘掉。 */
    const dark = !!(draft.demon && demonAppended);
    if (writeModule) writeModule.classList.toggle('theme-dark', dark);

    /* 预览态：素材库 / 提交区 / 格式工具都由 CSS 收起，正文换成成稿 */
    if (writeModule) writeModule.classList.toggle('is-preview', preview);
    if (writeStatus) writeStatus.textContent = preview ? '已发布' : '草稿';

    renderDraftChrome(preview);
    renderMeta(preview);
    renderChips();
    renderSlots();
    renderSubtitle(!preview);     /* 已发布不再做淡入淡出 */
    renderDemonLine(preview);
    syncWriteScroll();
  }

  /* ---------- 增删词条 ---------- */

  function addKeyword(id) {
    const k = byId(id);
    if (!k || k.id === DEMON_ID) return;

    /* 未解锁的词条只显示字母，点了也不进稿件 */
    if (draft.useLocks && !isUnlocked(k.key, draft.no)) {
      setWarn('【' + k.key + '】还没收集到——去详情页里点一下那句加粗的蓝字。');
      return;
    }

    const i = selections.indexOf(null);
    if (i < 0) {
      setWarn('最多只能填入 ' + slotTotal + ' 个关键词');
      return;
    }

    selections[i] = id;
    setWarn('');
    renderWrite();
  }

  function removeKeyword(index) {
    if (!(index >= 0 && index < slotTotal)) return;
    if (!selections[index]) return;

    selections[index] = null;
    setWarn('');
    renderWrite();
  }

  /* ---------- 交互：事件委托，只绑一次 ---------- */

  if (clueList) {
    clueList.addEventListener('click', e => {
      const chip = e.target.closest('.w-chip');
      if (!chip || !clueList.contains(chip)) return;

      /* 未解锁（字母态）：只有 not-allowed 光标和一句提示，什么都不发生 */
      if (chip.classList.contains('is-locked')) {
        /* 被封死的第九词不报字母，也不指路 —— 只留一句没有下文的回应 */
        if (chip.classList.contains('is-sealed')) {
          setWarn('？？？——这一格还没有名字。');
          return;
        }
        setWarn('【' + (chip.dataset.key || '?') + '】还没收集到——去详情页里点一下那句加粗的蓝字。');
        return;
      }

      /* 隐藏词条走自己的分支：不占槽位，追加到末尾 */
      if (chip.dataset.id === DEMON_ID) {
        toggleDemon();
        return;
      }

      addKeyword(chip.dataset.id);
    });
  }

  if (docBody) {
    docBody.addEventListener('click', e => {
      const slot = e.target.closest('.w-slot');
      if (!slot) return;
      removeKeyword(Number(slot.dataset.slot));
    });

    docBody.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const slot = e.target.closest('.w-slot');
      if (!slot) return;
      e.preventDefault();
      removeKeyword(Number(slot.dataset.slot));
    });
  }

  /* ---------- 稿件切换按钮：1 / 2 / 3 ---------- */

  if (wDraftTabs) {
    wDraftTabs.addEventListener('click', e => {
      const btn = e.target.closest('.w-draft-tab');
      if (!btn || btn.disabled) return;

      const n = Number(btn.dataset.draft);
      /* 重写模式下三篇一律放行，不受进度锁限制 */
      if (!isRewriteMode() && n > maxDraftNo) {
        setWarn('第 ' + n + ' 篇还没解锁：先写完第 ' + maxDraftNo + ' 篇。');
        return;
      }
      setDraft(n);
    });
  }

  /* ---------- 提交与结局判定 ---------- */

  function judgeEnding() {
    /* 真结局只看一件事：正文末尾有没有那句【真正的恶魔】。
       前四个空位填没填、填的是哪些词、正负比如何，都不参与判定。 */
    if (demonAppended) return 'true';

    if (filledCount() < slotTotal) return 'need-slots';

    /* 剩下三种结局只看前四个空位的正负分（每个词 ±1，第九词 w=0 不参与）：
         负面分 > 正面分 → 坏结局（流量狂欢）
         正面分 > 负面分 → 好结局（保住真相也保住工作）
         正负相等       → 平庸结局（不上不下，没人记得）
       注意这里比的是「分」，不是「有没有踩到敏感词」：
       两正两负也是平分，同样走平庸线。 */
    const score = wordScore();
    if (score < 0) return 'bad';
    if (score > 0) return 'good';
    return 'neutral';
  }

  /* ---------- 四结局演出：主窗口渐隐 → 纯黑 → 逐行浮现 ----------
     节奏：0s 整个游戏窗口开始淡出（1.5s）→ 1.5s 黑场亮起
          → 逐行追加（淡入上浮靠 CSS 动画）
          → 全部落地后先留一段纯黑死寂 → 浮出大号红色标题
          → 再放出「重新撰稿」。

     行间隔按结局分开（见 ENDING_PACING）：
       · 黑暗童话 / 雾散云开 / 汇入人群：每行 2.5s，最后停 2s。
       · 直视深渊：前 7 行（邮件开头）仍是 2.5s；
         从「R：如果今天只有他……」起，聊天记录每行拉到 4s，
         让玩家在黑屏里一行一行挨过去；最后一行之后停足 5s，
         屏幕上什么都不再发生，只剩那句话留在黑里。
     不做打字机、不加音效、没有乱码特效。

     文本一句一行，黑屏里就按这个顺序逐行浮现。真结局那段聊天记录
     也拆成了独立的行：R / J 交替，才像真的在翻一份文件。 */

  const endingsData = {
    bad: {
      title: '黑暗童话',
      lines: [
        '听说，有种心理现象叫做“可爱侵略症”',
        '事物越是美好，人们便越会去思考那份美好被打破的瞬间',
        '这是猎奇，也是人之常情',
        '而你选择了迎合，即便你知道事情的真相并非如此',
        '但又有什么关系呢？加入这场狂欢的不止你一个',
        '你只是需要这份流量，作为得到工作的助力而已',
        '这很值当',
        '……吗？'
      ]
    },

    good: {
      title: '雾散云开',
      lines: [
        '反转，反转，再反转',
        '编剧的作品需要逻辑，现实的戏剧却往往更胜一筹',
        '“如果没有后半段，这篇报道或许会更有意思”',
        '顺利转正那天，眼光独到的同事这样评价',
        '引人遐想的诡异传言，总比无聊的爱恨更有吸引力',
        '你只是笑笑',
        '在你看来，真实的感情，比拙劣的故事要珍贵万分',
        '你没有放弃真相，也没有失去工作',
        '这很完满',
        '……吗？'
      ]
    },

    neutral: {
      title: '汇入人群',
      lines: [
        '只有开头的恐怖故事没人去看，不上不下的你也不被公司重视',
        '老板宣告了你的结局',
        '人事叫走你的时候，周围的同事脸上皆是惋惜',
        '“唉，距离六个月，就差一点”',
        '“就差一点点，你就能留下来了”',
        '真情或假意的话语围绕在你身边',
        '是啊，你想，就差一点',
        '你距离真相，就差一点',
        '这很遗憾',
        '……吗？'
      ]
    },

    true: {
      title: '直视深渊',
      lines: [
        '你终于发出了那篇报道，代价只不过是一份糟心的工作',
        '你继续你的生活',
        '直到某天，你收到了一封邮件，发送地来自犹他州的警署：',
        '“那个出生的报道是你写的？好极了！我不能透露更多，这是我能给你的所有……不过你最好拥有充足的勇气再打开”',
        '下面，是一段聊天记录。',
        '你颤抖着手，点开了文件：',
        '……',
        'R：如果今天只有他，我有时间来干那事',
        'J：是的',
        'R：我会用上一整晚来享用他',
        'J：当然。这是他作为男孩的最后一晚',
        'R：我能够想象得到，他想要逃跑时的眼神',
        'J：湿漉漉带着泪，恐惧无助',
        'R：可能有点恐怖。但我想要把他切开然后吃下去',
        'J：哈哈哈',
        '……',
        '执法部门在对罗伯特的房屋进行搜查的时候，发现了他每日记录的日记本',
        '里面记录着他对接触过的孩子的痴迷',
        '他想知道杀死他们是什么感觉，想知道他们尝起来是什么味道',
        '这些日记的实质内容从未公开',
        '但警方发现，日记的第一篇记载于1988年',
        '而1989年，《Happy With Us》开始录制',
        '……',
        '罗伯特·本内特（Robert Bennett）至今仍在狱中'
      ]
    }
  };

  /* ============================================================
     后日谈（epilogue）
     ------------------------------------------------------------
     玩家在写稿器里交掉的前两篇练手稿，各按自己的语调留一段尾声；
     正式结局开演之前先把这两段放出来，让人知道自己前面写的东西
     到底在这个世界里砸出了什么水花。
     段与段之间用一行「……」隔开，和结局正文里的省略号是同一种写法。
       neg = 负面（黑料 / 流量稿）  pos = 正面（有依据的澄清稿）
       mid = 中立（不下结论的稿子）
     真结局也照放：它讲的是第三篇的选择，前面两篇的后果照样要交代。
     ============================================================ */

  const EPILOGUES = {
    1: {
      neg: [
        '你写出的“婚内出轨”引爆了热搜',
        '张文举的代言全部解约，刘盈莹的社交媒体更是骂声一片',
        '两人的澄清全被实为狡辩，他们再难摘下那顶“情人”的帽子',
        '……'
      ],
      pos: [
        '你有理有据的报道让舆论反转',
        '张文举大方聊起这位与他“相侵相碍”的妻子闺蜜',
        '误会得到澄清，造谣者统统作鸟兽散',
        '木子餐厅的门口大排长龙，新一轮的风波或许就在路上',
        '……'
      ],
      mid: [
        '你选择用一篇毫无定论的稿子交差',
        '这桩八卦很快被新的热搜覆盖',
        '没人知道那天晚上到底发生了什么，粉丝与路人依旧打得激烈',
        '……'
      ]
    },
    2: {
      neg: [
        '公章争夺战成了全网的笑柄，星火游戏的股价连续跌停',
        '钱德勒和韦德在派出所门口互殴的照片成了新表情包',
        '这场闹剧没有赢家，只剩下一地鸡毛',
        '……'
      ],
      pos: [
        '你的报道唤起了老玩家对创业初期的回忆',
        '舆论压力下，钱德勒同意重新谈判，但韦德最终没有选择回去',
        '几天后，两人被拍到一起在路边摊吃烧烤',
        '仿佛回到了那段住地下室的日子',
        '……'
      ],
      mid: [
        '这场风波最终以双方各退一步草草收场',
        '公章无效，董事会也经历了一场洗牌',
        '星火还存在着',
        '但对玩家来说，那个曾经创造过无数快乐的星火工作室',
        '似乎已经死在了这场权力的游戏里',
        '……'
      ]
    }
  };

  /* 取第 no 篇稿子的语调，永远返回 pos / neg / mid 之一：
       1. 先读 localStorage 里的提交存档 —— 它才是事实来源。
          提交时 saveSubmitted() 同时写内存和存档，两边本来一致；
          但在控制台手动改存档、或直接从存档触发结局这类场景里，
          内存还没跟着刷新，只有存档是新的。存档优先，
          「伪造全负面存档再点结局」才不会被上一轮的旧记录盖住。
       2. 存档整个读不出来（隐私模式、被禁用）才退回内存的那份。
       3. 都没有（一篇都没交过）→ mid，绝不抛错。 */
  function endingToneOf(no) {
    const k = String(no);
    const saved = readJson(CHOICE_KEY);
    let rec = null;

    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      rec = saved[k];
    } else if (saved === null) {
      rec = submittedChoices[k];
    }

    const tone = rec && rec.tone;
    return (tone === 'pos' || tone === 'neg' || tone === 'mid') ? tone : 'mid';
  }

  /* 唯一一行血字按内容认，不按下标写死：改文案不用动代码 */
  const ENDING_BLOOD_MARK = '但我想要把他切开然后吃下去';
  /* 原文里那句舞台提示（“这一句文字是红色的”）只给我们看，渲染前剔掉 */
  const ENDING_STAGE_NOTE = /[（(]这一句文字是红色的[）)]/g;
  /* 收尾字幕「【本故事由真实事件改编】」：真结局的最后一块字。
     它已经从 endingsData.true.lines 里移走，这里只留文本本身 ——
     playTrueCoda() 清屏之后拿它建一个独立的 <p> 插进容器。 */
  const ENDING_FINAL_MARK = '【本故事由真实事件改编】';

  /* 后日谈小标题（【关于绯闻】/【关于商战】/【关于结局】）：
     整行以【开头就算一行小标题；收尾字幕同样以【开头，
     哪天它被误放回 lines 里，这里也得能放行掉。 */
  function isEndingHeader(text) {
    const t = String(text == null ? '' : text).trim();
    if (t.charAt(0) !== '【') return false;
    return t.indexOf(ENDING_FINAL_MARK) < 0;
  }

  /* 血字只红后半句：
     “R：可能有点恐怖。”留在父级，照旧是白的；
     “但我想要把他切开然后吃下去”单独包一层 .red-text 才变红。
     刀口就是血字内容本身，前半段长度随文案自动走，不写死下标。
     不含血字的行仍然走 textContent，跟以前一模一样。 */
  function appendEndingLineText(p, text) {
    const cut = text.indexOf(ENDING_BLOOD_MARK);

    if (cut < 0) {
      p.textContent = text;
      return;
    }

    const head = text.slice(0, cut);
    const tail = text.slice(cut);

    if (head) {
      const normal = document.createElement('span');
      normal.className = 'normal-text';
      normal.textContent = head;
      p.appendChild(normal);
    }

    const red = document.createElement('span');
    red.className = 'red-text';
    red.textContent = tail;
    p.appendChild(red);
  }

  /* 老调用点（truth / flow / mild）继续可用 */
  const ENDING_ALIAS = { truth: 'true', flow: 'bad', mild: 'neutral' };

  /* 演出节奏参数：全部集中在这里，改速度不用翻逻辑 */
  const ENDING_LINE_GAP = 2500;          /* 常规行间隔（A / B / C，以及真结局的开头） */
  const ENDING_LINE_GAP_SLOW = 4000;     /* 真结局：聊天记录段的行间隔，刻意拖慢 */
  const ENDING_TRUE_SLOW_FROM = 7;       /* 真结局从第 8 行（下标 7，R：如果今天只有他…）开始拖慢 */
  /* 插进后日谈之前的两行小标题会把这个下标顶后，所以真结局的「变慢起点」
     改按文本认（见 buildEndingTimeline），这个常量只作为找不到锚点时的兜底 */
  const ENDING_TRUE_SLOW_MARK = 'R：如果今天只有他';
  const ENDING_HEADER_LEAD = 900;        /* 小标题前的额外停顿：让人知道换章了 */

  const ENDING_HOLD_DEFAULT = 2000;      /* 末句之后留的纯黑死寂（A / B / C） */
  const ENDING_HOLD_TRUE = 3000;         /* 真结局：末句之后先黑 3 秒，然后开始淡出、清屏 */
  const ENDING_TITLE_TO_BTN = 1600;      /* 标题淡入（1.6s）走完，才放出按钮 */

  /* ---------- 真结局收尾的四拍 ----------
     ① 整块文字淡出 1.5s（与 css 里 #ending-text-container 的 transition 对齐）
     ② 全黑死寂 2s：字已经透明，容器还挂着，屏幕上什么都没有
     ③ 清屏后字幕淡入 2.5s
     ④ 字幕落定再等 3.5s 才出标题，标题淡完 2s 放按钮
     数值集中在这里，改节奏不用翻到下面的演出逻辑。 */
  const ENDING_CODA_FADE_OUT = 1500;     /* ① 渐隐时长，与 CSS transition 一对一 */
  const ENDING_CODA_BLACKOUT = 2000;     /* ② 渐隐之后的纯黑死寂 */
  const ENDING_CODA_CREDIT_MS = 2500;    /* ③ 字幕淡入时长 */
  const ENDING_CODA_GAP = 3500;          /* ④ 字幕落定到标题之间的停顿 */

  /* ---------- 真结局的心理预警 ----------
     播到「你颤抖着手，点开了文件：」就刹车，在这里插一道灰字提示。
     这一行按文本认，不按下标写死 —— 以后改文案不用回头数第几行。 */
  const ENDING_WARN_MARK = '你颤抖着手，点开了文件：';
  const ENDING_WARNING_TEXT = '警告：以下内容包含针对未成年人的极端暴力暗示，可能引起严重不适。';
  const ENDING_WARN_LEAD = 1400;         /* 那一行落地后，留一拍再浮出警告 */
  const ENDING_SKIP_LEAD = 1800;         /* 放弃观看：警告撤走后，到第一行的间隔 */
  const ENDING_SKIP_GAP = 2200;          /* 放弃观看：最后两行之间的间隔 */

  const ENDING_FADE_DELAY = 1500;  /* 与 .main-window-fade-out 的 1.5s 对齐 */

  /* 把「第几行、什么时候出现」算成一条时间线。
     i 行的时刻 = 它前面所有间隔的和，所以下标 >= slowFrom 的行
     与上一行之间就自动变成慢间隔。
     传的是**行内容**而不是行数：小标题要额外多停一拍，
     真结局的慢速起点也要按文本找（前面插了标题，下标会整体后移）。 */
  function buildEndingTimeline(key, lines) {
    const count = lines.length;
    const slowIdx = lines.findIndex(l => String(l).indexOf(ENDING_TRUE_SLOW_MARK) >= 0);
    const slowFrom = (key === 'true')
      ? (slowIdx > 0 ? slowIdx : Math.min(ENDING_TRUE_SLOW_FROM, count))
      : count;
    const times = [];
    let t = 0;
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        t += (i >= slowFrom) ? ENDING_LINE_GAP_SLOW : ENDING_LINE_GAP;
        if (isEndingHeader(lines[i])) t += ENDING_HEADER_LEAD;
      }
      times.push(t);
    }
    return times;
  }

  /* 演过哪一场：存档里留个记号（撤回重写时会清掉，能再演一遍）。
     ENDING_SEEN_KEY / ENDING_EVER_KEY 两个常量已上移到“重写模式”那段声明 ——
     读档时就要判断 isRewriteMode()，不能等到这里才初始化。 */

  function markEndingSeen(key) {
    try { localStorage.setItem(ENDING_SEEN_KEY, key); } catch (e) {}
    /* 同时落下“通关过”的永久标记：重写模式看的是这一个 */
    try { localStorage.setItem(ENDING_EVER_KEY, key); } catch (e) {}
  }

  let endingTimers = [];
  let endingRunning = false;

  /* ---------- 结局期间的 BGM ----------
     结局一开演，音乐必须当场掐掉 —— 是暂停，不是渐弱。
     整块桌面沉进纯黑的那 1.5 秒里，画面上已经没有东西了，
     音乐再拖着淡出，听起来就像「还在玩，只是屏幕黑了」。

     记下「这次暂停是结局干的」，退出结局时才知道该不该把音乐放回来：
     玩家自己按过暂停的，绝不在结尾替他打开。 */
  let bgmPausedByEnding = false;

  function pauseBgmForEnding() {
    if (bgm.paused) return;        /* 本来就没响：不动它，退出时也不硬拉起来 */
    bgm.pause();                   /* pause 事件里会 clearBgmFade + syncBgmButton */
    bgmUserPaused = true;          /* 之后切页 / 重进浏览器都不会自己续上 */
    bgmPausedByEnding = true;
  }

  function resumeBgmAfterEnding() {
    if (!bgmPausedByEnding) return;
    bgmPausedByEnding = false;
    bgmUserPaused = false;
    bgmPlay();                     /* 内部先把音量归零，再 1s 淡入，不会啪一下炸出来 */
  }

  /* ---------- 真结局专属配乐（第二路音轨） ----------
     index.html 里那颗 <audio id="true-ending-audio" loop> 跟 bgm 那一套完全隔离：
       · 不进 BGM_TRACKS，不经过 applyBgmParams —— 崩坏态的慢放 / 降音碰不到它；
       · 不受 bgmUserPaused 管，玩家按左下角音符键也停不掉它；
       · 只在真结局开演时响、退场时断，跟着演出生灭。

     取节点放在用到的那一刻（懒取），不在启动时抓：万一这段 HTML 被删掉，
     也只是静音，不会在加载阶段就抛一个 null 引用把整段脚本带下去。 */
  let trueEndingAudioEl = null;
  let trueEndingFadeTimer = null;
  let trueEndingRetryHandler = null;
  /* 「这一幕现在应该响着」：重试回调是异步的，等它跑到时演出可能已经结束，
     用它兜一句判断，免得在黑屏散去之后突然冒出一段配乐。 */
  let trueEndingAudioWanted = false;

  /* 音量别硬起 0.6：主窗口沉黑要 1.5s，音乐同一帧砸下来会抢戏。
     这里从 0 爬到 0.6，时长与那段沉黑对齐，听觉上是「黑场亮起时才听得见」。 */
  const TRUE_ENDING_AUDIO_VOL = 0.6;
  const TRUE_ENDING_AUDIO_FADE_IN = 1200;
  const TRUE_ENDING_AUDIO_FADE_STEP = 60;

  function getTrueEndingAudio() {
    if (!trueEndingAudioEl) {
      trueEndingAudioEl = document.getElementById('true-ending-audio');
    }
    return trueEndingAudioEl;
  }

  function clearTrueEndingFade() {
    if (trueEndingFadeTimer !== null) {
      window.clearInterval(trueEndingFadeTimer);
      trueEndingFadeTimer = null;
    }
  }

  /* 从当前音量线性爬到 target，整段 ms 毫秒。到点自己收摊，不吃 CPU。 */
  function rampTrueEndingVolume(target, ms) {
    const a = getTrueEndingAudio();
    if (!a) return;
    clearTrueEndingFade();
    if (!ms) { a.volume = target; return; }

    const from = a.volume;
    const now = () => (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
    const t0 = now();

    trueEndingFadeTimer = window.setInterval(() => {
      const k = Math.min(1, (now() - t0) / ms);
      a.volume = Math.max(0, Math.min(1, from + (target - from) * k));
      if (k >= 1) clearTrueEndingFade();
    }, TRUE_ENDING_AUDIO_FADE_STEP);
  }

  function startTrueEndingAudio() {
    const a = getTrueEndingAudio();
    if (!a) {
      console.warn('[TrueEnding] 没找到 #true-ending-audio，这一幕将没有专属配乐');
      return;
    }

    /* 连播（测试面板连点）时先把上一场的收干净：定时器、重试监听、播放位置 */
    clearTrueEndingFade();
    trueEndingAudioWanted = true;
    try { a.currentTime = 0; } catch (e) {}

    /* HTML 上已经写了 loop，这里再钉一次：
       模板被改坏、或者将来有人换成动态创建的节点，循环也不会丢。 */
    a.loop = true;
    a.volume = 0;

    const p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(err => {
        /* 两种可能：自动播放策略拦下，或者文件缺失 / 解码失败。
           都不该把演出搞停 —— 记一条警告，然后等玩家下一次点击再试一次。
           （走到结局的玩家一定点过东西，这里的重试基本只是兜底。） */
        console.warn('[TrueEnding] 专属配乐播放被拦截或文件缺失：',
          (err && err.message) || err);

        if (trueEndingRetryHandler) return;
        trueEndingRetryHandler = () => {
          document.removeEventListener('pointerdown', trueEndingRetryHandler, true);
          trueEndingRetryHandler = null;
          if (!trueEndingAudioWanted) return;   /* 已经退场了就别再响 */
          const p2 = a.play();
          if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
        };
        document.addEventListener('pointerdown', trueEndingRetryHandler, true);
      });
    }

    rampTrueEndingVolume(TRUE_ENDING_AUDIO_VOL, TRUE_ENDING_AUDIO_FADE_IN);
  }

  function stopTrueEndingAudio() {
    const a = getTrueEndingAudio();
    clearTrueEndingFade();
    trueEndingAudioWanted = false;

    if (trueEndingRetryHandler) {
      document.removeEventListener('pointerdown', trueEndingRetryHandler, true);
      trueEndingRetryHandler = null;
    }

    if (!a) return;
    a.pause();
    try { a.currentTime = 0; } catch (e) {}
    a.volume = 0;
  }

  function clearEndingTimers() {
    endingTimers.forEach(t => window.clearTimeout(t));
    endingTimers = [];
  }

  function triggerEnding(type) {
    if (endingRunning) return;

    /* 0) 结局一开演，音乐当场停：不是渐弱，是暂停。
          必须压在最前面 —— 下面的 setSystemGlitch(false) 会走 applyBgmParams，
          趁音乐还响着把速率 / 音量滑过去，等于让它在黑场里又拖了半秒。
          本来就没在响的话一个字节都不动（bgmPausedByEnding 保持 false，
          退出结局时也不会硬把音乐拉起来）。 */
    pauseBgmForEnding();

    /* 结局一开演，崩坏就到此为止：红化 / 慢放 / 反色在这里一次性解除。
       必须压在最前面 —— 底下那 1.5 秒要的是「一块正常的浅色桌面沉进纯黑」，
       不是一块红桌面慢慢变黑；BGM 也顺手回到 1.0 倍。 */
    setSystemGlitch(false);

    const key = ENDING_ALIAS[type] || type;
    const data = endingsData[key] || endingsData.neutral;
    const overlay = document.getElementById('ending-overlay');
    const box = document.getElementById('ending-text-container');
    const rewrite = document.getElementById('rewrite-btn');
    if (!overlay || !box) return;

    endingRunning = true;
    markEndingSeen(key);

    /* 0.5) 真结局专属配乐：只有 true 这一场有声部。
          位置压在 `if (!overlay || !box) return;` 之后 —— 舞台不在就直接退出了，
          这里再起音乐就成了「屏幕没黑、音乐先响」。
          其它三个结局显式 stop 一次：测试面板从真结局连点到 A/B/C 时，
          上一场的配乐不会跟着演到下一场去。 */
    if (key === 'true') {
      startTrueEndingAudio();
    } else {
      stopTrueEndingAudio();
    }

    /* 真结局周目锁：坏 / 好 / 平庸 —— 任意一个普通结局落地，
       就永久记下「通读过一周目」。真结局本身（key === 'true'）不写这个标记：
       它要先被这个标记放行，才轮得到自己演。 */
    if (key === 'bad' || key === 'good' || key === 'neutral') {
      markNormalEndingCleared();
    }

    /* 重播（撤回后重新提交）时把上一次的痕迹收回来 */
    if (rewrite) rewrite.style.display = 'none';

    /* 1) 整个游戏窗口（左侧栏 + 右侧内容区）慢慢消失；
          同一帧让桌面底色跟着沉下去 —— 窗口淡成透明的那 1.5 秒里，
          窗口外面那圈网格不会还亮着，最后整屏是一块纯黑。 */
    const shell = document.getElementById('layout');
    if (shell) shell.classList.add('main-window-fade-out');
    document.body.classList.add('ending-bg-fade');

    /* 2) 等主窗口淡完，黑场才亮 —— 两边时长对齐，中间不会露出底色 */
    endingTimers.push(window.setTimeout(() => {
      box.innerHTML = '';
      box.scrollTop = 0;
      /* 上一场真结局可能停在淡出途中（比如开发面板连点重播），
         残留的 .is-fading-out 会让这一场整块字全是透明的 —— 开演前先摘干净。 */
      box.classList.remove('is-fading-out');
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');

      /* 0) 先拼出真正要演的整条线：小标题 + 稿件 1 的后日谈
            + 小标题 + 稿件 2 的后日谈 + 小标题 + 当前结局正文。
           前两段各按自己的语调取，取不到就是中立。
           小标题也走同一条 lines 通道（同样逐行淡入），
           渲染时靠 appendLine 里那句「以【开头」认出它、挂 .ending-header。
           拼完再统一剃掉舞台提示 —— 下标与时间线才对得上
           （剃完才是真正要演的行）。 */
      let finalLines = [];
      finalLines.push('【关于绯闻】');
      finalLines = finalLines.concat(EPILOGUES[1][endingToneOf(1)] || EPILOGUES[1].mid);
      finalLines.push('【关于商战】');
      finalLines = finalLines.concat(EPILOGUES[2][endingToneOf(2)] || EPILOGUES[2].mid);
      finalLines.push('【关于结局】');
      finalLines = finalLines.concat(data.lines);

      /* 原文里那句舞台提示只给我们看，渲染前统一剔掉，
         下标与时间线才对得上（剔完才是真正要演的行） */
      const lines = finalLines.map(raw => String(raw).replace(ENDING_STAGE_NOTE, '').trim());

      /* 3) 往容器里追加第 i 行；淡入与上浮交给 CSS 动画 */
      function appendLine(i) {
        const p = document.createElement('p');
        p.className = 'ending-line';
        /* 小标题：整行只有【关于绯闻】这种方括号短语时挂上专属类，
           字号 / 灰度 / 上下留白全交给 CSS。
           末句「【本故事由真实事件改编】」已经移出 lines，改由 playTrueCoda()
           单独建节点，这里不再需要为它分一个 ending-final-note。 */
        if (isEndingHeader(lines[i])) {
          p.classList.add('ending-header');
        }
        appendEndingLineText(p, lines[i]);
        box.appendChild(p);
        box.scrollTop = box.scrollHeight;   /* 行多了跟着往下滚，新行不被压住 */
      }

      /* 4) 从 from 排到 to（含），每行间隔 gap；返回最后一行落地的时刻。
             这里不再用 forEach 一次把整段排完 —— 真结局要能在半途刹车，
             后半段的定时器必须是「点完按钮之后」才创建的。 */
      function playRange(from, to, startDelay, gap) {
        let at = startDelay;
        let last = startDelay;
        for (let i = from; i <= to; i++) {
          /* 小标题前多停一拍，读起来才是「翻页」而不是「换行」 */
          if (i > from && isEndingHeader(lines[i])) at += ENDING_HEADER_LEAD;
          last = at;
          endingTimers.push(window.setTimeout(() => { appendLine(i); }, at));
          at += gap;
        }
        return last;
      }

      /* 5) 末句落地之后不马上出标题：先留一段什么都没有的纯黑。
             普通结局 2 秒，真结局 3 秒 —— 真结局那一停是给「断电」留的：
             停够了，整块聊天记录才会被一次性抽走。
             黑够了标题才淡入，标题落定之后才放出「重新撰稿」。 */
      function finish(lastAt) {
        const hold = (key === 'true') ? ENDING_HOLD_TRUE : ENDING_HOLD_DEFAULT;

        endingTimers.push(window.setTimeout(() => {
          /* 真结局走另一套收尾：清屏 → 巨大字幕 → 标题 → 按钮 */
          if (key === 'true') {
            playTrueCoda();
            return;
          }

          const title = document.createElement('p');
          title.className = 'ending-title';
          title.textContent = '【结局：' + data.title + '】';
          box.appendChild(title);
          box.scrollTop = box.scrollHeight;

          /* 文字全部落地、标题也浮出来了，才把「重新撰稿」放出来：
             在此之前它是 display:none，结局没演完就点不到。 */
          endingTimers.push(window.setTimeout(() => {
            if (rewrite) rewrite.style.display = 'inline-block';
          }, ENDING_TITLE_TO_BTN));
        }, lastAt + hold));
      }

      /* 5.5) 真结局专属收尾：四拍，一拍比一拍慢。
               ① 整块文字先淡出 1.5s —— 十几行聊天记录是一起沉下去的，
                  不是同一帧被 innerHTML 抽走。以前那一下「闪空」太像
                  演出断了（画面一白/一空，接着又冒出字幕），现在换成
                  一段真正的黑场过渡：最后那句「……」在视野里慢慢暗下去。
                  淡出加在容器上（.is-fading-out），父级 opacity 会连子元素
                  一起带走，所以不会有某一行还在淡入、其余先没的错位。
               ② 淡完之后再空 2s 什么都不做：字已经透明，容器还挂着，
                  屏幕上是一块真正的黑。这两秒是给玩家喘气的 ——
                  十几行证词刚被读完，紧接着就落字幕，情绪会被赶着走。
               ③ 黑够了才清屏、复位、摘掉淡出类。此时容器是空的，
                  透明与否看不出来，摘类不会带来任何闪烁。
                  然后画面正中浮出那句【本故事由真实事件改编】（2.5s 淡入），
                  它已经不在 lines 里了，所以不会再被逐行逻辑碰一次。
               ④ 再等 3.5 秒（够看清那句话），下方才补出结局标题；
                  标题淡完 2 秒，才放出「重新撰稿」。
               淡入用 inline transition，而不是 CSS 动画：
               .ending-line / .ending-title 那两条 animation 会抢走 opacity，
               inline 的 transition 只有在 animation:none 的前提下才作数
               （CSS 里那条 + 相邻选择器就是干这个的）。 */
      function playTrueCoda() {
        /* ① 先让整块文字淡下去。类名挂上去就交给 CSS 的 1.5s 过渡，
              这里不写 inline transition，免得和容器的样式规则打架。 */
        box.classList.add('is-fading-out');

        endingTimers.push(window.setTimeout(() => {
          /* ② 屏幕已经全黑：清空、复位，再把淡出类摘掉。
                顺序不能反 —— 先摘类会让残留的那十几行在半透明状态下
                重新亮一下，又成了「闪一下」。
                时长 = 渐隐跑完 + 死寂空场，两段在同一次等待里排完。 */
          box.innerHTML = '';
          box.classList.remove('is-fading-out');
          box.scrollTop = 0;

          /* ③ 字幕：先落进 DOM 并停在 opacity:0，强制重排认下这个起点，
                下一帧再改 1，2.5 秒的过渡才会真的跑起来。 */
          const credit = document.createElement('p');
          credit.className = 'ending-credit-text';
          credit.textContent = ENDING_FINAL_MARK;
          credit.style.opacity = '0';
          box.appendChild(credit);

          /* 强制一次重排：先让浏览器认下 opacity:0 这个起点，
             否则同一帧里连续改 0 → 1 会被合并，transition 根本不会触发。 */
          void credit.offsetWidth;
          credit.style.transition = 'opacity ' + (ENDING_CODA_CREDIT_MS / 1000) + 's ease-in-out';
          credit.style.opacity = '1';

          /* ④ 字幕看够了才出标题，标题淡完再放按钮 */
          endingTimers.push(window.setTimeout(() => {
            const title = document.createElement('p');
            title.className = 'ending-title';
            title.textContent = '【结局：' + data.title + '】';
            title.style.opacity = '0';
            title.style.marginTop = '40px';
            box.appendChild(title);

            void title.offsetWidth;
            title.style.transition = 'opacity 2s ease-in-out';
            title.style.opacity = '1';

            endingTimers.push(window.setTimeout(() => {
              if (rewrite) rewrite.style.display = 'inline-block';
            }, 2000));
          }, ENDING_CODA_GAP));
        }, ENDING_CODA_FADE_OUT + ENDING_CODA_BLACKOUT));
      }

      /* 6) 心理预警：夹在聊天记录前面的一道刹车。
             两个按钮做的是同一件事 —— 把剩下的行重新排一遍，
             然后照常收束到标题。整块只是这片黑里的一行灰字加两个方框，
             没有白底、没有圆角、没有阴影，不抢「这是个弹窗」的戏。 */
      function showEndingWarning() {
        const wrap = document.createElement('div');
        wrap.className = 'ending-warning';

        const note = document.createElement('p');
        note.className = 'ending-warning-note';
        note.textContent = ENDING_WARNING_TEXT;
        wrap.appendChild(note);

        const btns = document.createElement('div');
        btns.className = 'ending-warning-btns';

        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'ending-warning-btn';
        goBtn.dataset.choice = 'go';
        goBtn.textContent = '确认，我已做好准备';

        const skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'ending-warning-btn';
        skipBtn.dataset.choice = 'skip';
        skipBtn.textContent = '放弃观看，直接结束';

        btns.appendChild(goBtn);
        btns.appendChild(skipBtn);
        wrap.appendChild(btns);

        box.appendChild(wrap);
        box.scrollTop = box.scrollHeight;

        wrap.addEventListener('click', e => {
          const btn = e.target.closest('.ending-warning-btn');
          if (!btn || !wrap.parentNode) return;

          /* 点下去先把预警整块收掉：连点两下也不会排出两套时间线 */
          wrap.remove();

          /* 确认：接着往下播，聊天记录段一律 4 秒一行 */
          if (btn.dataset.choice === 'go') {
            const lastAt = playRange(warnAt + 1, lines.length - 1,
              ENDING_LINE_GAP_SLOW, ENDING_LINE_GAP_SLOW);
            finish(lastAt);
            return;
          }

          /* 放弃观看：跳过中间所有聊天记录，只留最后两行 */
          const tailFrom = Math.max(warnAt + 1, lines.length - 2);
          let at = ENDING_SKIP_LEAD;
          for (let i = tailFrom; i <= lines.length - 1; i++) {
            endingTimers.push(window.setTimeout(() => { appendLine(i); }, at));
            at += ENDING_SKIP_GAP;
          }
          finish(at - ENDING_SKIP_GAP);
        });
      }

      /* 只有真结局才刹车；bad / good / neutral 照旧一条时间线连续播完 */
      const warnAt = (key === 'true') ? lines.indexOf(ENDING_WARN_MARK) : -1;

      if (warnAt < 0) {
        const timeline = buildEndingTimeline(key, lines);
        finalLines.forEach((_, i) => {
          endingTimers.push(window.setTimeout(() => { appendLine(i); }, timeline[i]));
        });
        finish(timeline.length ? timeline[timeline.length - 1] : 0);
        return;
      }

      /* 7) 真结局：先只播到「点开了文件」那一行，然后整场停住。
             原本一口气排到第 18 行的定时器，现在到这儿就断了，
             后半段等玩家自己按下去才开始排。 */
      const headAt = playRange(0, warnAt, 0, ENDING_LINE_GAP);
      endingTimers.push(window.setTimeout(() => {
        showEndingWarning();
      }, headAt + ENDING_WARN_LEAD));
    }, ENDING_FADE_DELAY));

    /* 「重新撰稿」：收回结局，退回写稿器重选关键词 */
    if (rewrite) {
      rewrite.onclick = () => leaveEndingForRewrite();
    }
  }


  /* ---------- 结局退场 → 重新撰稿（重写模式） ----------
     三篇一起退回白纸，玩家从头再写一遍：
     填空槽位、隐藏词、重写提交记录全部清空，切换按钮 1 / 2 / 3 全开。
     已收集的线索、装好的插件、聊天记录和老板的评语一个都不动；
     submittedDrafts / submittedChoices 也保留原档 —— 重交时原地覆盖。 */

  /* ---------- 黑屏之后多出来的那个人 ----------
     触发点只有一处：通关过普通结局（bad / good / neutral 都会写
     hwu.normalEndingCleared）之后点「重新撰稿」的那一下。

     只放一次：标记写过就再也不放第二遍，二三周目里它只是安静地躺在列表里。
     台词落地靠 queueChat —— 写档、未读红点、提示音全走现有那条链路。
     queueChat 内部早就写明「其余情况一律只挂红点 + 响一声，绝不替玩家切页」，
     所以这里不需要、也不该再补一句 switchTab('chat')：
     那位「？？？」是这一周目的新客人，该由玩家自己从左侧图标走进去，
     而不是被人一把推到聊天页上。

     deferMs：把「写标记 + 排台词」整体推后多少毫秒，只给「退出结局」那条路用。
     黑场要 1.5 秒才淡完，红点要是当场就亮，玩家还在黑屏里 ——
     点看不到、铃声也闷在黑场背后，等画面切回写稿器时反倒什么都不剩。
     补排那条路（存档只清了一半）传 0，立即执行，不抢画面。 */
  function unlockShadowContact(deferMs) {
    if (!isNormalEndingCleared()) return false;

    const wait = Math.max(0, deferMs || 0);

    if (isShadowUnlocked()) {
      /* 标记在、剧本却不在（存档只清了一半 / 手改过档）：补排一次，不抢画面 */
      const st = ensureChatState('shadow');
      if (st.applied.indexOf('intro') >= 0) return false;

      if (!wait) {
        queueChat('shadow', 'intro');
        return false;
      }
      window.setTimeout(() => {
        /* 这几百毫秒里存档可能被清、也可能被别的路径补排过，落地前再看一眼 */
        if (ensureChatState('shadow').applied.indexOf('intro') < 0) {
          queueChat('shadow', 'intro');
        }
      }, wait);
      return false;
    }

    const fire = () => {
      if (!isShadowUnlocked()) markShadowUnlocked();
      queueChat('shadow', 'intro');
    };

    if (!wait) {
      fire();
      return true;
    }

    window.setTimeout(() => {
      /* 黑场淡完才轮到这一下；期间清档 / 重新开局的话就别再把人放出来 */
      if (!isNormalEndingCleared()) return;
      fire();
    }, wait);
    return true;
  }

  function leaveEndingForRewrite() {
    const overlay = document.getElementById('ending-overlay');
    const box = document.getElementById('ending-text-container');
    const rewrite = document.getElementById('rewrite-btn');
    const shell = document.getElementById('layout');

    /* 还有没走完的演出节拍就先掐掉，免得退回写稿器后又冒出一行字 */
    clearEndingTimers();

    /* ⓪ 真结局的配乐到这儿断：不渐出，直接停 + 归零。
          退场是「回到写稿器」这个动作，画面 1.5s 就复原了，
          留一段还没奏完的音乐在浅色桌面里响着，比切歌还突兀。
          紧接着下面 resumeBgmAfterEnding() 会按 1s 淡入把正片 BGM 拉回来。 */
    stopTrueEndingAudio();

    /* ① 按钮先收起来，免得淡出途中被点第二下 */
    if (rewrite) rewrite.style.display = 'none';

    /* ② 黑场渐隐、主窗口回来（摘掉 .main-window-fade-out 就淡回原样）；
          桌面底色同步褪回浅色，网格与紫色光晕一起回来 */
    if (overlay) {
      overlay.classList.remove('is-open');
      overlay.setAttribute('aria-hidden', 'true');
    }
    if (shell) shell.classList.remove('main-window-fade-out');
    document.body.classList.remove('ending-bg-fade');

    /* 崩坏态再兜一次底：万一结局是测试面板直接播的（没走 submit → triggerEnding
       那条路），退出时也必须已经解除。此时就算本来就是干净的，也只是重画一遍。 */
    setSystemGlitch(false);

    /* ③ 三篇的填词一起清空。
          测试面板直接点出来的演出并没有真正提交过稿，这里兜一层：
          状态不完整也只留一条警告，不能把「退出结局」这条路卡死。 */
    try {
      rollbackRewriteDraft();
    } catch (err) {
      console.warn('[ending] 撤回三篇时状态不完整，已直接退出结局：', err);
    }

    /* ④ 先看这一下是不是「第一次走出结局」。
          是的话，「？？？」在这一刻被放出来：标记写档、两句话排进队列、
          列表里多一行、红点亮起 —— 但整件事压到黑场淡完之后（1.5s + 0.2s）
          才发生，所以玩家在黑屏里既看不到红点、也听不到铃声，
          睁眼回到写稿器的那一下，左侧聊天图标才亮起、铃声才响。
          这里**没有** switchTab('chat')：进不进聊天由玩家自己决定，
          红点是唯一的邀请函。 */
    unlockShadowContact(ENDING_FADE_DELAY + 200);

    /* ⑤ 素材库骨架作废。
          周目标记是在演出开始时写下的，此刻 buildMaterials() 的 cacheKey
          已经从 '3_locked' 变成 '3_cleared'；把缓存旗拔掉，下一次 renderChips()
          就会重搭整个素材库，第九个词的容器在这一下里被真正创建出来。
          位置必须压在 switchTab('write') 之前 —— 切页本身会调 renderWrite()
          → renderChips() → buildMaterials()，拔旗放在切页之后的话，
          这一帧画出来的还是旧的 8 词骨架，又得等玩家自己点一次稿子。 */
    if (clueList) {
      clueList.dataset.built = '0';
      clueList.dataset.cacheKey = '';
    }

    /* ⑥ 直接带玩家回写稿器（重写模式的老规矩不变）。
          这也是整条退场路径的终点：不再替玩家翻页。
          「？？？」的红点会在他低头看稿子的时候亮起来，
          想读那两句话，自己点一下左侧的聊天图标就好。 */
    endingRunning = false;
    switchTab('write');

    /* ⑦ 结局演完了，音乐回到它该有的样子：只有「开场那一刻确实在响」
          才恢复 —— 玩家自己按过暂停的，这里保持安静。
          放在 switchTab 之后：先让切页把速率 / 音量算好，
          再交给 bgmPlay 的 1s 淡入，回来时是「从无声慢慢浮上来」，
          不会在退出黑场的那一下炸出一段满音量的音乐。 */
    resumeBgmAfterEnding();

    /* ⑧ 等黑场淡完再清字：字在渐隐途中突然消失会很突兀 */
    window.setTimeout(() => {
      if (!box) return;
      box.innerHTML = '';
      /* 真结局若停在淡出途中就退出来了，这块容器会一直是透明状态，
         下次演出整块字都看不见 —— 退出时统一摘掉。 */
      box.classList.remove('is-fading-out');
    }, ENDING_FADE_DELAY + 100);
  }

  function rollbackRewriteDraft() {
    /* ① 三篇的空位与隐藏词一起清空，保证三张都是白纸 */
    DRAFTS.forEach(d => {
      const st = DRAFT_STATE[d.no];
      if (!st) return;
      st.sel.fill(null);
      st.demon = false;
    });

    /* ② 重写提交记录清空：三篇重新变回“可编辑的草稿” */
    clearRewriteSubmitted();

    /* ③ 内存里的当前篇指针对齐到刚清空的那一份 */
    selections = DRAFT_STATE[currentDraftNo].sel;
    demonAppended = DRAFT_STATE[currentDraftNo].demon;
    setWarn('');
    if (writeStatus) writeStatus.textContent = '草稿';

    /* ④ 重画写稿器：本来就停在预览态的那一篇会退回编辑态
          （renderedMode 从 preview 变 edit，正文随之换成空白稿） */
    renderWrite();

    /* 结局标记清掉：重新提交同一种结局时能正常再演一次。
       ENDING_EVER_KEY 不动 —— 重写模式要一直有效，刷新也还在。 */
    try { localStorage.removeItem(ENDING_SEEN_KEY); } catch (e) {}
  }

  /* 记一笔：这篇发出去了，连同这一次用的词、语气一起存进 localStorage。
     之后再回到这一篇，读到的就是这份记录生成的成稿。 */
  function markSubmitted(forceTone) {
    const no = draft.no;
    const score = wordScore();

    if (submittedDrafts.indexOf(no) < 0) {
      submittedDrafts.push(no);
      submittedDrafts.sort((a, b) => a - b);
    }

    submittedChoices[String(no)] = {
      ids: selections.slice(),
      demon: !!demonAppended,
      score: score,
      tone: forceTone || (score > 0 ? 'pos' : (score < 0 ? 'neg' : 'mid')),
      at: Date.now()
    };

    saveSubmitted();

    /* 练手稿 1 / 2 交掉 → 收件箱里多一封「LinkWriter自动抓取」 */
    maybeSendAutoMail(no);

    /* 前两篇交掉 → 老板的评语接进聊天队列；
       第 3 篇不排聊天，提交处会直接进黑屏演出 */
    if (no === 1 || no === 2) queueChat('boss', 'draft' + no);
  }

  if (npSubmit) {
    npSubmit.addEventListener('click', () => {
      /* ---------- 重写模式：前两篇重新交一次 ----------
         空位填满就能交，交完留在本篇直接进预览态（成稿），
         不再自动翻到下一篇 —— 想写第 3 篇自己点左边的 3。 */
      if (isRewriteMode() && draft.no < DRAFTS.length) {
        if (filledCount() < slotTotal) {
          setWarn('请先把 ' + slotTotal + ' 个【填空处】填满。');
          return;
        }

        setWarn('');
        markSubmitted();                       /* 直接覆盖这一篇的旧记录 */
        markRewriteSubmitted(draft.no);        /* 记号：这篇已经重交过，不再算草稿 */
        renderWrite();                         /* 留在本篇，正文换成成稿 */
        return;
      }

      /* 前两篇是练手稿：不看组合、只要求把空位填满，过了就解锁下一篇。
         第 1 篇现在也上锁（四个词要从详情页收集），所以这里按篇号判断，
         不能再拿 useLocks 当「是否是练手稿」的开关。 */
      if (draft.no < DRAFTS.length) {
        if (filledCount() < slotTotal) {
          setWarn('请先把 ' + slotTotal + ' 个【填空处】填满。');
          return;
        }

        setWarn('');
        markSubmitted();                 /* 发出去的稿子从此只读 */
        if (writeStatus) writeStatus.textContent = '已提交';

        const pass = draft.pass;
        if (pass) {
          if (pass.next > maxDraftNo) {
            maxDraftNo = pass.next;
            saveDraftMax(maxDraftNo);
          }
          setDraft(pass.next);
        }

        /* 这里刻意不给任何文字反馈：稿子交出去之后由「左侧聊天图标亮红点 +
           一声提示音」来通知，玩家自己走过去读老板的评语。
           markSubmitted() 里那句 queueChat('boss', 'draft' + no)
           负责把消息排进队列（红点 / 声音都在 queueChat 里）。 */
        return;
      }

      const result = judgeEnding();

      if (result === 'need-slots') {
        setWarn('请至少填入 ' + slotTotal + ' 个关键词（当前 ' +
          filledCount() + ' / ' + slotTotal + '）。');
        return;
      }

      setWarn('');
      if (writeStatus) writeStatus.textContent = '已提交';

      markSubmitted(result === 'true' ? 'truth' : '');
      renderWrite();                     /* 立刻切到预览态，正文变成见报稿 */

      /* 第 3 篇一交出去就直接进黑屏演出：先让预览态落一拍（看得出稿子发出去了），
         再开始主窗口渐隐。结局只在 #ending-overlay 里演，聊天记录不再承载它。 */
      window.setTimeout(() => triggerEnding(result), 260);
    });
  }

  /* ---------- 纸面滚动状态：工具栏吸顶时的投影 ----------
     提交区本身已吸在纸的下沿（CSS position:sticky），
     所以这里不再需要额外的“还有内容”渐隐条。 */

  function syncWriteScroll() {
    if (!writeCanvas) return;
    /* 吸顶的工具栏压住正文时给一点阴影，读起来像“浮在上面”而不是切了一刀 */
    if (writeTopbar) writeTopbar.classList.toggle('is-stuck', writeCanvas.scrollTop > 2);
  }

  if (writeCanvas) {
    writeCanvas.addEventListener('scroll', syncWriteScroll, { passive: true });
    window.addEventListener('resize', syncWriteScroll);
  }

  /* ============================================================
     九、工具函数与初始化
     ============================================================ */

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- 存档指纹 ----------
     DevTools 里执行 localStorage.clear()、或者换一个浏览器标签页改存档，
     都不会通知当前页面。这里在每次切页 / 打开网页前比对一次指纹：
     变了才重读，没变就什么都不做（不会打断正在填的稿子）。 */
  let storageSignature = '';

  function readRaw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function progressSignature() {
    return [
      readRaw(PLUGIN_KEY),
      readRaw(SUBMITTED_KEY),
      readRaw(CHOICE_KEY),
      readRaw(REWRITE_KEY),
      readRaw(UNLOCK_KEY),
      readRaw(UNLOCK_KEY_D1),
      readRaw(UNLOCK_KEY_D2)
    ].join('|');
  }

  function ensureStorageSynced() {
    const sig = progressSignature();
    if (sig === storageSignature) return false;
    storageSignature = sig;

    /* 插件没了就说明存档被整体清掉（游戏里没有“卸载”入口），
       这时连正在填的空位一起清；正常游戏过程中插件一直在，草稿不受影响。 */
    const wiped = !isPluginInstalled();

    syncProgressFromStorage(wiped);
    applyPluginState();
    renderSidebar();
    renderWrite();
    return true;
  }

  /* ---------- 启动前把内存状态对齐到 localStorage ----------
     F12 里执行 localStorage.clear() 再刷新时，这里读到的全是空值：
     侧边栏回到 4 个图标、写稿器没有已发布文章、关键词全部锁回去。
     同时把 'false' / '1' / 'yes' 这类旧写法当成脏值删掉，
     避免出现“看起来已完成、其实没存档”的残留。
     resetDraft = true 时连正在填的空位一起清空（只用于整档被清掉的情况）。 */
  function syncProgressFromStorage(resetDraft) {
    /* ① 安装状态只认字符串 'true' */
    let rawPlugin = null;
    try { rawPlugin = localStorage.getItem(PLUGIN_KEY); } catch (e) { rawPlugin = null; }
    if (rawPlugin !== null && rawPlugin !== 'true') {
      try { localStorage.removeItem(PLUGIN_KEY); } catch (e) {}
    }

    /* ② 提交记录 / ③ 关键词 / 重写记录：整份重读，旧值不参与 */
    readSubmittedIntoMemory();
    readRewriteSubmittedIntoMemory();
    readUnlockedIntoMemory();

    /* ④ 整档被清掉：写稿器里的选词、隐藏词一起清空 */
    if (resetDraft) {
      DRAFTS.forEach(d => {
        const st = DRAFT_STATE[d.no];
        st.sel.fill(null);
        st.demon = false;
      });
    }

    /* ⑤ 当前篇目回到 1（除非存档里确实还写着进度） */
    currentDraftNo = loadDraftNo();
    maxDraftNo = Math.max(loadDraftMax(), currentDraftNo);

    draft = DRAFTS[currentDraftNo - 1];
    slotTotal = draft.slotTotal;
    selections = DRAFT_STATE[draft.no].sel;

    /* ⑥ 交过的稿子按存档还原成预览态 */
    restoreSubmittedSelections();

    /* ⑦ 第九词的追加状态要在还原之后再取一次：
       否则刷新后真结局预览拿到的还是初始的 false（黑化态也回不来） */
    demonAppended = DRAFT_STATE[draft.no].demon;

    /* ⑧ 强制下一次 renderWrite 重画标题与正文 */
    renderedDraftNo = 0;
    renderedMode = '';

    /* ⑨ 记下这一轮的存档指纹，后面的切页就不会重复重读 */
    storageSignature = progressSignature();
  }

  /* ============================================================
     静默预加载：关键剧情视频提前进浏览器缓存
     ------------------------------------------------------------
     目标：玩家点开邮件附件 / 时光机视频时「秒开」，不再对着黑屏转圈。
     做法：在浏览器真正空闲时，把关键视频逐个拉进 HTTP 缓存；真正播放
     时直接命中缓存，省掉首字节等待。

     三条死规矩（任何改动都要守住）：
       1) 绝不出声：临时的 video 一律 muted + defaultMuted，全程只
          preload、绝不调用 play()。连 1 毫秒的隐藏声音都不会有。
       2) 不抢主线程 / 不抢带宽：requestIdleCallback 等到浏览器真空闲
          才启动；三个视频【串行】下载，下一个必须等上一个结束；
          玩家正在看视频时自动让路。
       3) 不碰坏现有播放器：预加载用的是独立 fetch 流，与附件抽屉 /
          B站播放器完全无关；下完整段才落 IndexedDB（VideoCache），
          中断的半截一律丢弃，绝不产生声音、不占常驻内存。

     任何一个失败都静默吞掉，绝不影响游戏本身。
     ============================================================ */
  function silentPreloadVideos() {
    /* 关键剧情视频：按「玩家最可能先点开」的顺序排 */
    const videoUrls = [
      'assets/video/oprah_interview.mp4',   /* 奥普拉访谈 11MB，最长，优先 */
      'assets/video/hwu_opening.mp4',       /* 时光机片头 */
      'assets/video/HappyWithUs.mp4'        /* 附件 Happy With Us */
    ];

    /* 老内核没有 requestIdleCallback 时退化为定时器，仍然错开首屏 */
    const onIdle = window.requestIdleCallback
      ? function (fn) { window.requestIdleCallback(fn, { timeout: 4000 }); }
      : function (fn) { window.setTimeout(fn, 2000); };

    let i = 0;
    let ctrl = null;           /* 当前预取的 AbortController（便于随时中止） */

    /* 玩家一开始播真视频，立刻掐掉当前预取，把带宽全让出来。
       只挂一次；捕获阶段，任何位置插入的播放器都能抓到。 */
    if (!silentPreloadVideos._playHooked) {
      silentPreloadVideos._playHooked = true;
      document.addEventListener('play', function (e) {
        const el = e.target;
        if (!el || el.tagName !== 'VIDEO') return;
        if (ctrl) {
          try { ctrl.abort(); } catch (err) {}
          ctrl = null;
          if (i > 0) i--;      /* 这一条没下完，索引退回去，稍后重试 */
        }
      }, true);
    }

    function next() {
      if (i >= videoUrls.length) return;

      /* 页面上已经有真播放器（在播、或已打开未播）就让路：
         玩家此刻在看视频，预取先等着，8 秒后再探 */
      const live = document.querySelector('video');
      if (live) {
        window.setTimeout(next, 8000);
        return;
      }

      const url = videoUrls[i++];

      /* ------------------------------------------------------------
         为什么用 fetch 流式读取，而不是塞一个不可见的 <video preload=auto>：
         实测（Edge/Chromium）里 preload="auto" 的 video 只请求了文件尾部
         几十 KB 就判定「能播」，整段根本没下载（buffered 报表 100%，
         实际只传了 43KB / 2539KB），玩家点开仍要缓冲 —— 达不到秒开。
         改成 fetch + 流式读完丢弃：整段真正落进 HTTP 缓存，
         之后播放器再请求同一个文件是 0 字节、50ms 内出画面。
         流式读取每次只持有一块 chunk，读完即丢，不占内存、不碰主线程。
         ------------------------------------------------------------ */
      const myCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      ctrl = myCtrl;

      let finished = false;
      const chunks = [];        /* 流式下载的分块，完整后才一次性落 IndexedDB */
      let gotFull = false;      /* 只有正常读到流末尾才置 true；中断绝不存半截 */
      function done() {
        if (finished) return;
        finished = true;
        if (ctrl === myCtrl) ctrl = null;
        onIdle(next);          /* 让出一帧再排下一个，串行不抢带宽 */
      }

      /* 兜底：单个视频最多 90 秒，超时就放手，别卡死队列 */
      const timer = window.setTimeout(function () {
        if (myCtrl) { try { myCtrl.abort(); } catch (e) {} }
      }, 90000);

      function finishAll() {
        window.clearTimeout(timer);
        /* 整段完整拿到的视频落进 IndexedDB（中断的半截绝不入库）。
           失败静默：缓存写不进去也无所谓，播放仍走 HTTP 缓存/网络。 */
        if (gotFull && chunks.length) {
          try { VideoCache.put(url, new Blob(chunks, { type: 'video/mp4' })); } catch (e) {}
        }
        chunks.length = 0;
        gotFull = false;
        done();
      }

      /* 优先走流式；老内核没有 body.getReader 时退回 arrayBuffer */
      function startFetch() {
        fetch(url, {
          cache: 'force-cache',        /* 已有缓存就直接用，不重复下载 */
          credentials: 'same-origin',
          signal: myCtrl ? myCtrl.signal : undefined
        }).then(function (res) {
          if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);

          if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            function pump() {
              return reader.read().then(function (r) {
                if (r.done) { gotFull = true; return; }
                /* 数据流经浏览器的同时也写进 HTTP 缓存；
                   分块先攒着，读到流末尾才整段落 IndexedDB */
                chunks.push(r.value);
                return pump();
              });
            }
            return pump();
          }
          /* 兜底路径：整块读进内存（老内核才走这里），同样送进持久缓存 */
          return res.arrayBuffer().then(function (buf) {
            chunks.push(new Uint8Array(buf));
            gotFull = true;
          });
        }).then(finishAll).catch(function () {
          /* 被玩家播放打断（AbortError）或网络失败：半截数据一律丢弃 */
          chunks.length = 0;
          gotFull = false;
          finishAll();
        });
      }

      /* 已经在持久缓存里 → 这一轮直接跳过，不占任何带宽 */
      VideoCache.has(url).then(function (cached) {
        if (cached) { finishAll(); return; }
        startFetch();
      }).catch(finishAll);
    }

    /* 主界面起来后先让 3 秒（首屏渲染、登录动画都过去），再等空闲 */
    window.setTimeout(function () { onIdle(next); }, 3000);
  }

  /* 初始化入口：界面上每一处「已完成」都由存档派生，没有写死的默认值 */
  function init() {
    /* 第零件事：先把「这一帧显示谁」定下来。
       index.html 里 #layout 是 inline display:none（防首帧闪出主界面），
       已登录的老玩家必须在任何渲染之前就把它放开 —— 下面的 renderChatLog
       会用 scrollHeight 把聊天滚到底，隐藏状态下读到的恒为 0。
       未登录的玩家则继续藏着主界面，只把登录屏亮出来。 */
    applyBootVisibility();

    /* 第一件事：把存档里的崩坏态贴回 body。
       刷新之后导航、桌面底色、BGM 在第一个画面里就该是坏的，
       晚一步就是「先白一下再变红」，等于把状态漏给玩家。 */
    syncGlitchTheme();

    syncProgressFromStorage(true);

    applyPluginState();

    /* 内置手册：首次游玩写入 + 老存档补回（永远在资料库第一位）
       必须在任何 renderLibrary / 星标渲染之前执行 */
    ensureTutorialBookmark();

    /* 导航严格按 localStorage 的安装状态重建：
       null / "false" → 4 个图标；"true" → 6 个图标 */
    renderSidebar();

    /* 兜底：若当前停在写稿 / 时光机但插件已不存在（清过缓存），退回聊天 */
    if (!isPluginInstalled() && PLUGIN_TABS.indexOf(activeViewName()) >= 0) {
      switchTab('chat');
    }

    /* 默认态：渲染联系人列表，并模拟一次点击“老板” */
    renderContactList();
    selectContact('boss');

    /* 资讯浏览器默认首页：现代新闻门户（搜索框会被搬进站内导航） */
    renderPage('home');

    /* 邮件模块初始状态（红点 / 附件角标 / 默认停在“发邮件”） */
    renderMail();

    renderWrite();

    /* 最后一步：登录屏。
       放在 init() 里而不是文件末尾 —— 此时 DOM 已全部就绪，
       也不会被 init 内部的任何早退分支跳过。 */
    initLogin();

    /* 收尾：关键剧情视频静默预加载。
       必须在所有渲染与登录判断之后调用 —— 它自己会再等 3 秒 + 浏览器
       空闲才动手，绝不和首屏抢带宽，也不产生任何声音。 */
    silentPreloadVideos();
  }

  init();

  /* ============================================================
     桌面光晕：鼠标跟随
     ------------------------------------------------------------
     一盏很淡的灯跟着光标在窗口外的网点背景上走：
       · 只写两个 CSS 变量，画面交给 #bg-glow 的径向渐变，不改背景图
       · 每帧最多写一次（rAF 合并同一帧里的多个 mousemove）
       · passive: true —— 不参与滚动/点击判定，绝不影响主界面交互
       · 窗口整体 mouseleave 时把灯熄掉，重新进来再亮
     ============================================================ */
  (function bindBgGlow() {
    const bgGlow = document.getElementById('bg-glow');
    if (!bgGlow) return;

    let rafId = 0;
    let lastX = 0;
    let lastY = 0;

    const paint = () => {
      rafId = 0;
      bgGlow.style.setProperty('--mouse-x', lastX + 'px');
      bgGlow.style.setProperty('--mouse-y', lastY + 'px');
    };

    window.addEventListener('mousemove', e => {
      lastX = e.clientX;
      lastY = e.clientY;

      /* 第一次移动才点亮：默认 opacity 0，避免页面一加载正中就有一团光 */
      if (!bgGlow.classList.contains('is-on')) bgGlow.classList.add('is-on');

      if (rafId) return;
      rafId = window.requestAnimationFrame(paint);
    }, { passive: true });

    /* 光标离开整个页面（切标签、拖到浏览器外面）就熄灯 */
    document.addEventListener('mouseleave', () => {
      bgGlow.classList.remove('is-on');
    }, { passive: true });
  })();

  /* 从 bfcache 返回（清档后离开页面再退回来）时重新对齐一次，
     否则内存里还留着上一轮的安装态与进度。 */
  window.addEventListener('pageshow', e => {
    if (!e.persisted) return;
    ensureStorageSynced();
  });

  /* ============================================================
     十一、移动端适配（手机横屏）
     ------------------------------------------------------------
     三件事：
       ① 聊天返回：窄屏点完联系人后收起列表，左上角返回键复位；
       ② 视口高度：把 visualViewport 的高度写进 --app-vh，
          键盘弹起时整窗跟着变矮，底部输入框不会被系统键盘盖住；
       ③ 聚焦滚动：手机上点开输入框后把该框滚到可视区中间。
     全部是渐进增强：没有 visualViewport、不是手机横屏时静默跳过。
     ============================================================ */

  (function initMobile() {
    const chatShellEl = document.querySelector('#view-chat .chat-shell');
    const chatBackBtn = document.getElementById('chatBack');

    /* ① 返回联系人列表 */
    if (chatShellEl && chatBackBtn) {
      chatBackBtn.addEventListener('click', () => {
        chatShellEl.classList.remove('is-chat-open');
        const list = chatShellEl.querySelector('.contact-list');
        if (list) list.scrollTop = 0;
      });
    }

    /* ② 视口高度：把「真实可见高度」写进 --app-vh
       --app-vh      ：可视区高度（#layout 与三块全屏浮层共用）
       --app-vv-top  ：可视区相对布局视口的纵向偏移（iOS 上推可视区时用）
       CSS 侧还有 100dvh / 100vh 两级兜底，这里只为拿到最准的那个数：
       浏览器工具栏收放、软键盘升降时，只有 visualViewport 知道真实可见区。
       写入合并到一帧：这段时间 resize / scroll 每帧都来，直接写会让整窗
       跟着重排，观感是「一动就抖一下」。 */
    const vv = window.visualViewport;

    const writeViewportVars = () => {
      const root = document.documentElement;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? (vv.offsetTop || 0) : 0;
      /* 用 round 不用 floor：iOS 的可视高常带小数，floor 会在底部留一条
         1px 的缝把白底透出来；CSS 那边 #layout 是 overflow:hidden，
         多出来的半像素不会变成滚动条。 */
      root.style.setProperty('--app-vh', Math.round(h) + 'px');
      root.style.setProperty('--app-vv-top', Math.max(0, Math.round(top)) + 'px');
    };

    let vvRaf = 0;

    const syncViewport = () => {
      if (vvRaf) return;
      vvRaf = window.requestAnimationFrame(() => {
        vvRaf = 0;
        writeViewportVars();
      });
    };

    const syncViewportNow = () => {
      if (vvRaf) {
        window.cancelAnimationFrame(vvRaf);
        vvRaf = 0;
      }
      writeViewportVars();
    };

    writeViewportVars();

    if (vv) {
      vv.addEventListener('resize', syncViewport);
      vv.addEventListener('scroll', syncViewport);
    }

    /* 普通 resize 也要接：部分安卓浏览器收放工具栏只触发 window.resize，
       visualViewport 的数值会晚一拍，补一次立刻对齐。 */
    window.addEventListener('resize', syncViewport);

    /* 旋转：iOS 在 orientationchange 之后 300ms 内 vv.height 还是旧方向的
       数值，只在事件里同步一次会拿到「横屏里塞着竖屏高度」的错误值。
       所以立刻补一次，再在 120ms / 400ms 各补一次。 */
    window.addEventListener('orientationchange', () => {
      syncViewportNow();
      window.setTimeout(syncViewportNow, 120);
      window.setTimeout(syncViewportNow, 400);
    });

    /* 从后台切回来、或 bfcache 前进后退回来：工具栏可能已经收起，
       可视区高度和离开时不一样了。 */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncViewportNow();
    });
    window.addEventListener('pageshow', syncViewportNow);

    /* ③ 输入框聚焦后滚进可视区 */
    const isPhoneLandscape = () =>
      window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;

    document.addEventListener('focusin', e => {
      const el = e.target;
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
      if (!isPhoneLandscape()) return;

      window.setTimeout(() => {
        try {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (err) {
          el.scrollIntoView();
        }
        /* 整窗是 fixed 的，页面本身不该滚动，防止被浏览器顶偏 */
        if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
      }, 280);
    });

    /* 转回竖屏时复位聊天，下次横屏从联系人列表开始 */
    window.addEventListener('orientationchange', () => {
      if (!chatShellEl) return;
      if (window.matchMedia('(orientation: portrait)').matches) {
        chatShellEl.classList.remove('is-chat-open');
      }
    });

    /* 窗口被拉宽 / 转回桌面尺寸时也复位，避免 class 残留导致下次变窄只剩会话 */
    window.addEventListener('resize', () => {
      if (!chatShellEl) return;
      const narrow = window.matchMedia(
        '(orientation: landscape) and (max-height: 500px) and (max-width: 700px)'
      ).matches;
      if (!narrow) chatShellEl.classList.remove('is-chat-open');
    });

    /* ④ 横屏工具栏提示：竖屏进游戏、转横屏后才该出现，所以两个时机都试。
       注意 index.html 把本脚本放在 #fullscreenTip 之前，同步执行时那个节点
       还不存在（getElementById 拿到 null 就直接 return 了），必须等 DOM 就绪。 */
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', maybeShowFullscreenTip, { once: true });
    } else {
      maybeShowFullscreenTip();
    }
    window.addEventListener('orientationchange', () => {
      window.setTimeout(maybeShowFullscreenTip, 500);
    });

    /* 少数环境（含部分安卓 WebView、以及浏览器里的尺寸模拟）只发 resize
       不发 orientationchange。补一条防抖，保证「竖屏进、转横屏」也放得出来。
       函数内部第一句就是 dataset.done 短路，看过之后这些调用都是空转。 */
    let tipResizeTimer = 0;
    window.addEventListener('resize', () => {
      window.clearTimeout(tipResizeTimer);
      tipResizeTimer = window.setTimeout(maybeShowFullscreenTip, 400);
    });

    /* ⑤ 全屏按钮：把地址栏 / 标签栏真正让出去
       ------------------------------------------------------------
       只在 css 放它出来的档位（手机横屏）可见，但监听一律照挂：
       display:none 的按钮点不到，挂着不产生任何副作用。
       退出全屏有三条路径 —— 按钮自己、系统返回键 / 手势、电脑上按 Esc，
       所以状态不由点击处自己改，统一交给 fullscreenchange 回写：
       「点一下就把图标翻成退出」在系统手势退出时会对不上。 */
    const fsBtn = document.getElementById('mobileFullscreenBtn');
    const fsHint = document.getElementById('mobileFsHint');
    const fsRoot = document.documentElement;

    const currentFsEl = () =>
      document.fullscreenElement || document.webkitFullscreenElement || null;

    const canRequestFs = () =>
      typeof fsRoot.requestFullscreen === 'function' ||
      typeof fsRoot.webkitRequestFullscreen === 'function';

    /* iOS Safari 至今不支持「让某个元素全屏」，只有 <video> 可以。
       探测一次记在 html 上：css 据此把按钮整块收掉，
       改由 #fullscreenTip 那句「向下滑动」兜底 ——
       宁可少一个按钮，也不留一个点了没反应的。 */
    if (!canRequestFs()) {
      fsRoot.classList.add('no-element-fullscreen');
    }

    let fsHintTimer = 0;

    function showFsHint(text) {
      if (!fsHint) return;
      fsHint.textContent = text;
      fsHint.classList.add('is-on');
      window.clearTimeout(fsHintTimer);
      fsHintTimer = window.setTimeout(() => {
        fsHint.classList.remove('is-on');
      }, 3600);
    }

    /* 进 / 出全屏都要走这里：换图标、换 aria、重新量一次可视区 */
    function applyFullscreenState() {
      const on = !!currentFsEl();
      fsRoot.classList.toggle('is-fullscreen', on);

      if (fsBtn) {
        fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        fsBtn.setAttribute('aria-label', on ? '退出全屏' : '进入全屏');
        fsBtn.setAttribute('title', on ? '退出全屏' : '进入全屏');
      }

      /* 工具栏收放会改变可视区高度，等浏览器把布局跑完再量一次；
         部分安卓内核要 100~300ms 才把最终尺寸给出来，再补两次。 */
      syncViewportNow();
      window.setTimeout(syncViewportNow, 120);
      window.setTimeout(syncViewportNow, 400);
    }

    if (fsBtn) {
      fsBtn.addEventListener('click', () => {
        /* 已在全屏：先退出。exitFullscreen 在个别内核里会同步抛错
           （不是 Promise），所以 try/catch 与 .catch 两条都得有。 */
        if (currentFsEl()) {
          try {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
          } catch (err) {
            showFsHint('退出全屏失败，可按返回键退出');
          }
          return;
        }

        if (!canRequestFs()) {
          showFsHint('当前浏览器不支持网页全屏，向下滑动可隐藏地址栏');
          return;
        }

        try {
          /* navigationUI: 'hide' 只有部分内核认（桌面 Chrome），
             不认的会直接忽略这个参数，不会抛错。 */
          const req = fsRoot.requestFullscreen
            ? fsRoot.requestFullscreen({ navigationUI: 'hide' })
            : fsRoot.webkitRequestFullscreen();

          /* 被拒绝的常见原因：不在用户手势里、嵌在缺 allowfullscreen 的
             iframe 里、浏览器策略不允许（部分国产内核）。
             拒绝后不能装死，就地给一句人话。 */
          if (req && typeof req.catch === 'function') {
            req.catch(err => {
              window.console.warn('[fullscreen] 请求被拒绝：', err && err.message);
              showFsHint('浏览器拒绝了全屏请求，可向下滑动隐藏地址栏');
            });
          }
        } catch (err) {
          window.console.warn('[fullscreen] 请求异常：', err && err.message);
          showFsHint('浏览器拒绝了全屏请求，可向下滑动隐藏地址栏');
        }
      });
    }

    document.addEventListener('fullscreenchange', applyFullscreenState);
    document.addEventListener('webkitfullscreenchange', applyFullscreenState);
  })();

  /* ---------- 横屏首次进入：告诉玩家工具栏可以滑走 ----------
     只在「触屏 + 横屏 + 没看过」时出现一次，5 秒后自己淡出。
     pointer-events:none，不挡任何点击；PC 端 CSS 就是 display:none，
     连节点都不会显示。localStorage 记一笔，老玩家永远不再看到。 */
  function maybeShowFullscreenTip() {
    const el = document.getElementById('fullscreenTip');
    if (!el) return;
    if (el.dataset.done === '1') return;
    if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
    if (!window.matchMedia('(orientation: landscape)').matches) return;

    /* 有原生全屏按钮的浏览器不必再看这一条：按钮把工具栏收得更彻底
       （滑动收起只是临时的，一碰屏幕就回来），两条提示同时出现只会
       互相打岔。只有拿不到元素全屏 API 的（iOS Safari）才需要
       「向下滑动」当替代方案 —— 那种设备上按钮已被 css 收掉。 */
    const rootEl = document.documentElement;
    if (typeof rootEl.requestFullscreen === 'function' ||
        typeof rootEl.webkitRequestFullscreen === 'function') return;

    /* 登录屏还盖着就先别放：它 z-index 9000，提示在底下根本看不见，
       5 秒的展示窗口会白白耗掉。等玩家真正进门再数。 */
    const login = document.getElementById('login-screen');
    if (login) {
      const cs = window.getComputedStyle(login);
      const booting = cs.display !== 'none' &&
        cs.visibility !== 'hidden' &&
        !login.classList.contains('is-hidden');
      if (booting) return;
    }

    let seen = false;
    try { seen = localStorage.getItem('hwu.tipShown.fullscreen') === '1'; } catch (e) {}
    el.dataset.done = '1';
    if (seen) return;

    try { localStorage.setItem('hwu.tipShown.fullscreen', '1'); } catch (e) {}

    el.classList.add('is-on');
    window.setTimeout(() => el.classList.remove('is-on'), 5200);
  }

})();
