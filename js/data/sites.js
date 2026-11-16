/* ============ 站点内容（占位文案版） ============ */
/* 说明：所有正文均为占位短稿，正式文案后续替换；页面结构/词条/链接已固定。 */
/* 交互约定：<a data-go="key"> 站内跳转；.collect-btn[data-kw] 采集词条；State.markSeen 记录访问 */

/* ---------- 采集按钮辅助 ---------- */
function kwBtn(id) {
  const got = State.hasKw(id);
  return '<button class="collect-btn ' + (got ? 'done' : '') + '" data-kw="' + id + '">' +
         (got ? '已存' : '存为证据') + '</button>';
}
function kwInline(id) {
  const got = State.hasKw(id);
  return '<span class="kw-inline ' + (got ? 'collected' : '') + '" data-kw="' + id + '">' +
         KW[id].label + '</span>' + kwBtn(id);
}
function link(key, text) {
  const v = State.s.seen.includes(key) ? ' class="visited"' : '';
  return '<a data-go="' + key + '"' + v + '>' + text + '</a>';
}

/* ---------- 搜索 ---------- */
window.__searchGo = function () {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  Browser.go('__search:' + q);
};

const SEARCH_MAP = [
  { match: ['欢乐好时光', 'happy with us'], results: [
    { t: '【求档】Happy With Us 台庆特别版', u: 'oldtv-bbs.net/thread-1', go: 'forum/t1', s: '占位摘要：08 年的老帖，楼主在找一盘没送审的带子。' },
    { t: '一档儿童节目为何在深夜被紧急撤下', u: 'echoarchive.org/a1', go: 'news/a1', s: '占位摘要：1995 年的通稿，通篇都是"分歧"。' },
    { t: '晨星工坊：一个母亲的十年', u: 'echoarchive.org/a2', go: 'news/a2', s: '占位摘要：2004 年的温情专访。' }
  ]},
  { match: ['lost media'], results: [
    { t: '【求档】SVB 台庆特别版（1994）', u: 'oldtv-bbs.net/thread-1', go: 'forum/t1', s: '占位摘要：被标记为"未解决"。' },
    { t: '什么是 Lost Media？', u: 'echoarchive.org/what', go: 'news/index', s: '占位摘要：失传媒体入门。' }
  ]},
  { match: ['玛格丽特', 'margaret'], results: [
    { t: '网络声讨中的"邪教母亲"', u: 'echoarchive.org/a4', go: 'news/a4', s: '占位摘要：2011 年的流量稿。' },
    { t: '晨星工坊：一个母亲的十年', u: 'echoarchive.org/a2', go: 'news/a2', s: '占位摘要：她只说过一句话。' }
  ]},
  { match: ['糖果人', '发糖'], results: [
    { t: '有没有人记得道格发糖那段', u: 'oldtv-bbs.net/thread-1', go: 'forum/t1', s: '占位摘要：7 楼有人说他记错了。' }
  ]},
  { match: ['svt-memo', '备忘录'], results: [
    { t: '【泄】SVT-MEMO-1995-117 全文', u: 'oldtv-bbs.net/thread-1', go: 'forum/t1', s: '占位摘要：附件失效，但正文引用了全文。' }
  ]},
  { match: ['ivan kessler', 'kessler', '凯斯勒'], results: [
    { t: '【归档】海岬市地方法院 2005 年判决汇总', u: 'echoarchive.org/archive-2005', go: 'news/a2005', s: '占位摘要：案号 HC-2005-0314。' }
  ]},
  { match: ['ivan nomed', 'nomed'], results: [] }
];

const SITES = {
  /* ================= 收藏夹（浏览器主页） ================= */
  'home': {
    title: '收藏夹', url: 'about:links', skin: 'y1998',
    render: () => '<div class="site y1998">' +
      '<h3>我的收藏 ▼</h3><hr>' +
      '<p>🔍 ' + link('search', '搜索引擎') + '</p>' +
      '<p>📰 ' + link('news/index', '回声档案 Echo Archive') + '</p>' +
      '<p>💬 ' + link('forum/index', '老电视机 BBS') + '</p>' +
      '<p>📺 ' + link('video/watch', '旧视频存档（YouTube 镜像）') + '</p>' +
      '<p class="footer">占位：小满说，资料全是二手的，写的时候记得用"网传"。</p></div>'
  },

  /* ================= 搜索引擎 ================= */
  'search': {
    title: '搜索', url: 'http://search.local/', skin: 'y1998',
    render: () => '<div class="site y1998"><div class="search-home">' +
      '<div class="logo">搜一搜</div>' +
      '<input id="searchInput" class="input95" placeholder="输入关键词…" onkeydown="if(event.key===\'Enter\')__searchGo()">' +
      ' <button class="btn95" onclick="__searchGo()">搜索</button>' +
      '<p class="footer" style="margin-top:40px">建议使用 Netscape 4.0 以上版本浏览本站</p>' +
      '</div></div>'
  },

  /* ================= 新闻站 ================= */
  'news/index': {
    title: '回声档案 Echo Archive', url: 'http://echoarchive.org/', skin: 'y1998',
    render: () => '<div class="site y1998"><div class="news-portal">' +
      '<div class="side"><b>分类</b><hr>' +
      '<a>● 时政</a><a>● 经济</a>' + link('news/cat', '● 文化·旧案') + '<a>● 体育</a></div>' +
      '<div class="main"><b>文化·旧案</b><hr>' +
      '<p>' + link('news/a1', '一档儿童节目为何在深夜被紧急撤下') + '（1995）</p>' +
      '<p>' + link('news/a2', '晨星工坊：一个母亲的十年') + '（2004）</p>' +
      '<p>' + link('news/a3', '儿童节目旧案重启调查') + '（2005）</p>' +
      '<p>' + link('news/a4', '网络声讨中的"邪教母亲"') + '（2011）</p>' +
      '<p>' + link('news/a2005', '【归档】2005 年判决汇总') + '</p></div>' +
      '<div class="hot"><b>热门排行</b><hr><p>1. 网络声讨中的"邪教母亲"</p><p>2. 旧案重启调查</p><p>3. 紧急撤下</p></div>' +
      '</div><p class="footer">© Echo Archive · 本页最后更新：2019-06-02</p></div>'
  },
  'news/cat': {
    title: '文化·旧案 - 回声档案', url: 'http://echoarchive.org/cat-culture', skin: 'y1998',
    render: () => SITES['news/index'].render()
  },

  'news/a1': {
    title: '紧急撤下 - 回声档案', url: 'http://echoarchive.org/a1', skin: 'y1998',
    render: () => '<div class="site y1998 article"><h2>一档儿童节目为何在深夜被紧急撤下</h2>' +
      '<div class="meta">回声档案 · 1995-12-24 · 占位通稿</div>' +
      '<p>【占位】12 月 23 日晚，南谷电视台在未发布任何预告的情况下，停播了播出八年的儿童节目《Happy With Us》。</p>' +
      '<p>【占位】台方发言人称，停播"因制作方与台方存在分歧"，拒绝透露更多细节。<span class="kw-inline" data-kw="K01">节目曾三次获得地区儿童节目奖</span>' + kwBtn('K01') + '。</p>' +
      '<p>【占位】记者尝试联系晨星工坊，截至发稿未获回应。</p></div>'
  },

  'news/a2': {
    title: '一个母亲的十年 - 回声档案', url: 'http://echoarchive.org/a2', skin: 'y1998',
    render: () => '<div class="site y1998 article"><h2>晨星工坊：一个母亲的十年</h2>' +
      '<div class="meta">回声档案 · 2004-06-11 · 占位专访</div>' +
      '<p>【占位】玛格丽特·维尔创立晨星工坊的初衷，是给生病的小女儿做一档"不会吓人的节目"。</p>' +
      '<p>【占位】<span class="kw-inline" data-kw="K02">三套皮套都是她亲手缝的</span>' + kwBtn('K02') + '。她说："买来的皮套眼睛是死的，我缝的会跟着里面的人动。"</p>' +
      '<p>【占位】节目播了 212 集，缝坏了 3 台缝纫机。<span class="kw-inline" data-kw="K01">孩子们只记得会唱歌的小鸡</span>' + kwBtn('K01') + '。</p></div>'
  },

  'news/a3': {
    title: '旧案重启调查 - 回声档案', url: 'http://echoarchive.org/a3', skin: 'y1998',
    render: () => '<div class="site y1998 article"><h2>儿童节目旧案重启调查</h2>' +
      '<div class="meta">回声档案 · 2005-03-16 · 占位消息稿</div>' +
      '<p>【占位】海岬市地方法院近日对一起旧案宣判，一名前儿童节目工作人员被判刑。</p>' +
      '<p>【占位】报道未提及当事人姓名。法院表示，<b>"因涉及未成年人，本院不公开审理详情。"</b></p>' +
      '<p>【占位】（记者注：本案与《Happy With Us》停播的关系，尚无官方说法。）</p>' +
      '<p class="footer">相关：' + link('news/a2005', '2005 年判决汇总') + '</p></div>'
  },

  'news/a4': {
    title: '邪教母亲 - 回声档案', url: 'http://echoarchive.org/a4', skin: 'y1998',
    render: () => '<div class="site y1998 article"><h2>网络声讨中的"邪教母亲"</h2>' +
      '<div class="meta">回声档案 · 2011-09-02 · 占位流量稿</div>' +
      '<p>【占位】一档播客重提旧案后，全网将目光对准了《Happy With Us》制片人玛格丽特·维尔。</p>' +
      '<p>【占位】"符号""流血的皮套""消失的一集"——每一个关键词都在发酵。（本篇没有任何实证，只有情绪。——编辑注）</p>' +
      '<p>【占位】她的公开声明只有一句话：' +
      '<span class="kw-inline" data-kw="K03">"我做节目，是因为我是个母亲。"</span>' + kwBtn('K03') + '</p></div>'
  },

  'news/a2005': {
    title: '2005 年判决汇总 - 回声档案', url: 'http://echoarchive.org/archive-2005', skin: 'y1998',
    render: () => '<div class="site y1998 article"><h2>【归档】海岬市地方法院 2005 年判决汇总</h2>' +
      '<div class="meta">回声档案 · 归档页 · 占位档案</div>' +
      '<p>【占位】案号 HC-2005-0314。当事人：伊万·凯斯勒（Ivan Kessler），男，时年 41 岁，' +
      '<span class="kw-inline" data-kw="K14">多项罪名成立，判处十二年</span>' + kwBtn('K14') + '。</p>' +
      '<p>【占位】卷宗显示，当事人 1994 年 11 月前曾在南谷电视台承担现场工作。因涉及未成年人，本院不公开审理详情。</p>' +
      '<p>【占位】2017 年刑满释放后去向不明。</p>' +
      '<p><button class="btn95" data-cite9="Ivan Kessler">引用此条 → 填入稿件第九格</button></p>' +
      '<p class="footer">（占位：判决书语言。全文不出现任何罪行细节。）</p></div>'
  },

  /* ================= 论坛 ================= */
  'forum/index': {
    title: '老电视机 BBS', url: 'http://oldtv-bbs.net/', skin: 'y1998',
    render: () => '<div class="site y1998 forum"><h3>≡ 老电视机 BBS ≡</h3>' +
      '<p>找回你的童年。注册于 2003。</p><hr>' +
      '<p><b>≡ 寻档求助</b></p>' +
      '<p>' + link('forum/t1', '【求档】Happy With Us 台庆特别版') + '（回复 21 · 2008）</p>' +
      '<p><b>≡ 都市传说</b></p>' +
      '<p>' + link('forum/t3', '【精】Happy With Us 邪教传说大全') + '（回复 154 · 2005）</p>' +
      '<p><b>≡ 吵架区</b></p>' +
      '<p>' + link('forum/t2', '那个"邪教母亲"到底是不是真的') + '（回复 312 · 2011）</p>' +
      '<p>' + link('forum/t4', '你还记得哪一集？') + '（回复 89 · 2004）</p>' +
      '<p class="footer">本站已停止新用户注册 · 占位</p></div>'
  },

  'forum/t1': {
    title: '【求档】台庆特别版', url: 'http://oldtv-bbs.net/thread-1', skin: 'y1998',
    render: () => '<div class="site y1998 forum"><div class="thread-head"><b>【求档】Happy With Us 台庆特别版</b>' +
      '<br><span class="f-meta">楼主 tape_hunter_91 · 2008-11-02 03:14:00 · 本帖最后由 阿茶 于 2008-11-02 03:14 编辑</span></div>' +

      '<div class="floor"><div class="f-meta">1楼 <b>tape_hunter_91</b></div>' +
      '占位：找了三年。台庆特别版（1994）从来没流出过。' +
      '我在 YouTube 传了一版网传的引进删改版：<br>' + link('video/watch', '▶ 观看：Happy With Us 网传版（译制删改）') + '</div>' +

      '<div class="floor"><div class="f-meta">7楼 <b>阿茶</b></div>' +
      '占位：小时候最喜欢道格发糖那段。蓝色的大家伙，蹲下来的时候皮套膝盖会响。' +
      '<span class="kw-inline" data-kw="K09">后来重看，那些镜头全都没有了</span>' + kwBtn('K09') + '。可能是我记错了。</div>' +

      '<div class="floor"><div class="f-meta">12楼 <b>VHS_1987</b></div>' +
      '占位：楼上不是记错。我有 94 年台庆的带子。<span class="kw-inline" data-kw="K08">夜里放的时候杂音很大</span>' + kwBtn('K08') + '。</div>' +

      '<div class="floor edited-late"><div class="f-meta">19楼 <b>匿名</b> · 此帖于 2013 补充 <span class="edit-time">03:14</span></div>' +
      '占位：找到一份 1995 年的内部备忘录（附件已失效，仅存文本）。' +
      '<span class="kw-inline" data-kw="K12">SVT-MEMO-1995-117：合同终止，母带运离，签署封口协议</span>' + kwBtn('K12') + '。<br>' +
      '（占位：备忘录全文——"鉴于现场调查结果，库房事件按技术性损毁处理，所有在场人员签署封口协议。"）</div>' +

      '<p class="footer">此帖已被管理员锁定 · 占位</p></div>'
  },

  'forum/t2': {
    title: '"邪教母亲"是不是真的', url: 'http://oldtv-bbs.net/thread-2', skin: 'y1998',
    render: () => '<div class="site y1998 forum"><div class="thread-head"><b>那个"邪教母亲"到底是不是真的</b>' +
      '<br><span class="f-meta">楼主 不吃香菜 · 2011-09-03</span></div>' +
      '<div class="floor"><div class="f-meta">1楼 <b>不吃香菜</b></div>占位：我就说！当年看的时候就不对劲！</div>' +
      '<div class="floor"><div class="f-meta">88楼 <b>南岸小学96届</b></div>' +
      '占位：你们骂的是一个真实存在的人。' +
      '<span class="kw-inline" data-kw="K03">她的声明只有一句话："我做节目，是因为我是个母亲。"</span>' + kwBtn('K03') + '</div>' +
      '<div class="floor"><div class="f-meta">300楼 <b>路人</b></div>占位：吵了 300 楼，没有一个人提出证据。</div>' +
      '<p class="footer">本帖最后由 管理员 于 2011-09-20 锁定 · 占位</p></div>'
  },

  'forum/t3': {
    title: '邪教传说大全', url: 'http://oldtv-bbs.net/thread-3', skin: 'y1998',
    render: () => '<div class="site y1998 forum"><div class="thread-head"><b>【精】Happy With Us 邪教传说大全</b>' +
      '<br><span class="f-meta">楼主 录像带收藏家 · 2005-04-01</span></div>' +
      '<div class="floor"><div class="f-meta">3楼 <b>录像带收藏家</b></div>' +
      '占位：传说一——某集的皮套接缝处渗出了红色液体。' +
      '<span class="kw-inline" data-kw="K06">皮套在流血</span>' + kwBtn('K06') + '</div>' +
      '<div class="floor"><div class="f-meta">9楼 <b>VHS_1987</b></div>' +
      '占位：传说二——布景上的倒三角与圆圈。' +
      '<span class="kw-inline" data-kw="K05">有人说是邪教符号</span>' + kwBtn('K05') + '</div>' +
      '<div class="floor"><div class="f-meta">21楼 <b>阿茶</b></div>' +
      '占位：传说三——' +
      '<span class="kw-inline" data-kw="K07">第 112 集只播过一次，再也没有人找到</span>' + kwBtn('K07') + '</div>' +
      '<p class="footer">占位：本帖全部内容均为未证实传言。</p></div>'
  },

  'forum/t4': {
    title: '你还记得哪一集', url: 'http://oldtv-bbs.net/thread-4', skin: 'y1998',
    render: () => '<div class="site y1998 forum"><div class="thread-head"><b>你还记得哪一集？</b>' +
      '<br><span class="f-meta">楼主 米米粉 · 2004-02-11</span></div>' +
      '<div class="floor"><div class="f-meta">1楼 <b>米米粉</b></div>' +
      '占位：' +
      '<span class="kw-inline" data-kw="K04">小鸡唱歌跑调那集，全班都在学</span>' + kwBtn('K04') + '</div>' +
      '<div class="floor"><div class="f-meta">4楼 <b>南岸小学96届</b></div>占位：最喜欢道格发糖那段。（占位）</div></div>'
  },

  'forum/postd': {
    title: '发帖 - 老电视机 BBS', url: 'http://oldtv-bbs.net/post', skin: 'y1998',
    render: () => '<div class="site y1998 forum"><div class="thread-head"><b>发表新帖</b>' +
      '<br><span class="f-meta">身份：你的ID（占位）</span></div>' +
      '<div class="floor"><b>《他叫伊万·凯斯勒》</b>' +
      '<p>1994 年 11 月，一名灯光助理提交了举报。</p>' +
      '<p>1995 年 5 月，电视台把一箱母带运走，说泡水了。</p>' +
      '<p>1995 年 12 月 23 日，节目停播，没有解释。</p>' +
      '<p>2005 年 3 月 14 日，海岬市地方法院，案号 HC-2005-0314，伊万·凯斯勒，十二年。</p>' +
      '<p>2011 年，全网指认了一个母亲。</p>' +
      '<p>（占位：正文与 GDD 9.5 一致，正式版补全。）</p></div>' +
      '<p style="text-align:center"><button class="btn95" id="postD" style="font-weight:bold">发 布</button></p>' +
      '<p id="postCounter" style="text-align:center;color:#555"></p></div>'
  },

  /* ================= SVT 官网（时光机） ================= */
  'svt/1998': {
    title: '演职员表 1998', url: 'http://happywithus.svt.veyland.tv/crew.html', skin: 'y1998',
    year: 1998,
    render: () => '<div class="site y1998"><h3>Happy With Us! · 演职员表</h3>' +
      '<table><tr><td>制片人</td><td>Margaret Vale</td></tr>' +
      '<tr><td>导演</td><td>（占位）</td></tr>' +
      '<tr><td>主持人</td><td>Tom Harlow</td></tr>' +
      '<tr><td>玩偶演员</td><td>（占位）3 人</td></tr></table>' +
      '<p><span class="kw-inline" data-kw="K10">本表缺少"道格"皮套演员一栏</span>' + kwBtn('K10') + '</p>' +
      '<p class="counter">本页访问次数 000437</p>' +
      '<p class="footer">Best viewed in 800×600 · 占位</p></div>'
  },
  'svt/2003': {
    title: '演职员表 2003', url: 'http://happywithus.svt.veyland.tv/crew.html', skin: 'y2003',
    year: 2003,
    render: () => '<div class="site y2003"><p class="stopped">本站已停止更新，仅作存档</p>' +
      '<h3>Happy With Us! · 演职员表</h3>' +
      '<table><tr><td>制片人</td><td>Margaret Vale</td></tr>' +
      '<tr><td>玩偶演员</td><td>（占位）3 人</td></tr></table>' +
      '<p class="counter">本页访问次数 000441</p>' +
      '<p class="footer">占位：页面和五年前一模一样。</p></div>'
  },
  'svt/2008': {
    title: '演职员表 2008', url: 'http://happywithus.svt.veyland.tv/crew.html', skin: 'y2008',
    year: 2008,
    render: () => '<div class="site y2008"><h3><span class="glitch">H̷A̷P̷P̷Y̷ ̷W̷I̷T̷H̷ ̷U̷S̷</span></h3>' +
      '<marquee>他们把一切都处理干净了 他也在这里 不要看第七集</marquee>' +
      '<p><span class="broken-img">image not found</span><span class="broken-img">image not found</span></p>' +
      '<p>制片人：<span class="censored">██████</span></p>' +
      '<p>玩偶演员：<span class="censored">████</span> ' +
      '<span class="redact">I. N___</span></p>' +
      '<p>占位：页面被抢注者改成了这样。没人知道是谁干的。</p>' +
      '<p><span class="kw-inline" data-kw="K08">附件：deep_night_tape.avi（已损坏）</span>' + kwBtn('K08') + '</p>' +
      '<p class="footer">你是第 1 位访客 · 占位</p></div>'
  },
  'svt/2015': {
    title: '演职员表 2015', url: 'http://happywithus.svt.veyland.tv/crew.html', skin: 'y2015',
    year: 2015,
    render: () => '<div class="site y2015">' +
      '<div class="ad">[广告] 海岬市旅游 · 占位</div>' +
      '<div class="card"><h3>Happy With Us! · 演职员表（社区维护版）</h3>' +
      '<p>制片人：Margaret Vale</p>' +
      '<p>玩偶演员（小鸡 Pip / 小老鼠 Mimi）：（占位）</p>' +
      '<p>玩偶演员（道格 Doug）：<span class="highlight-name">Ivan Nomed</span></p>' +
      '<p style="font-size:12px;color:#777">edit by tape_hunter_91 · 来源：1994 台庆母带 00:33:10</p></div>' +
      '<div class="deleted-note">本条内容因缺乏可靠来源已被移除（2015-04-15）</div>' +
      '<p style="font-size:12px;color:#888">（占位：一个名字只活了四天。）</p></div>'
  },
  'svt/404': {
    title: '404', url: 'http://happywithus.svt.veyland.tv/crew.html', skin: 'y404',
    year: 2019,
    render: () => '<div class="site y404"><h2>404 Not Found</h2>' +
      '<p>该页面没有可用快照。</p><p style="color:#aaa">（占位：2019 年，网站关闭，快照停止抓取。）</p></div>'
  },

  /* ================= 视频入口 ================= */
  'video/watch': {
    title: '网传版录像', url: 'http://video-mirror.local/watch', skin: 'y1998',
    render: () => '<div class="site y1998"><div class="video-stub">' +
      '<div class="title">Happy With Us 网传版（译制删改 · 65集源）</div>' +
      '<div class="screen">▶ 占位画面（正式版为 SVG 帧动画）</div>' +
      '<p style="font-size:12px;color:#888">（占位：这是被删改过的版本。若你手里有原版带子，请打开对比器。）</p></div>' +
      '<p style="text-align:center;margin-top:10px"><button class="btn95" data-open="compare">打开录像对比器</button></p></div>'
  }
};

State.on('change', () => { /* 占位：状态变化后由各窗口自行刷新 */ });
