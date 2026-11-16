/* ============ 录像对比器窗口 ============ */

const Compare = (() => {
  const WID = 'compare';
  const CLIPS = [
    { tc: '00:33:10', box: { l: 196, t: 66, w: 96, h: 76 },  desc: '"道格发糖"整段消失' },
    { tc: '01:12:47', box: { l: 86,  t: 118, w: 120, h: 70 }, desc: '"道格抱抱"环节被剪掉' },
    { tc: '02:05:03', box: { l: 8,   t: 158, w: 70, h: 34 },  desc: '音频被倒放处理' }
  ];
  let playing = false, t = 0, timer = null;

  /* SVG 布景（占位图形；正式版替换为精细 SVG 帧动画） */
  function scene(censored) {
    const doug = censored ? '' :
      '<g><rect x="205" y="86" rx="14" width="52" height="60" fill="#4169E1"/>' +
      '<circle cx="231" cy="76" r="20" fill="#4169E1"/>' +
      '<ellipse cx="218" cy="62" rx="7" ry="13" fill="#2F4FBE"/>' +
      '<ellipse cx="244" cy="62" rx="7" ry="13" fill="#2F4FBE"/>' +
      '<circle cx="224" cy="72" r="2.5" fill="#000"/><circle cx="238" cy="72" r="2.5" fill="#000"/>' +
      '<ellipse cx="231" cy="82" rx="6" ry="4" fill="#C8A165"/>' +
      '<rect x="212" y="98" width="38" height="26" fill="#F5DEB3" opacity=".85"/></g>' +
      '<rect x="196" y="120" width="76" height="26" fill="#B8860B"/>' +
      '<rect x="200" y="112" width="68" height="10" fill="#DEB887"/>';
    const kids = censored ? 3 : 4;
    let kidStr = '';
    for (let i = 0; i < kids; i++) {
      const x = 96 + i * 30;
      kidStr += '<circle cx="' + x + '" cy="146" r="9" fill="#F1C27D"/>' +
                '<rect x="' + (x - 10) + '" y="155" width="20" height="30" rx="6" fill="' + ['#C33','#3A7','#36C','#C73'][i] + '"/>';
    }
    return '<svg viewBox="0 0 300 200" width="294" height="194">' +
      '<rect width="300" height="150" fill="#7BA05B"/>' +
      '<rect y="150" width="300" height="50" fill="#A0784A"/>' +
      '<circle cx="60" cy="70" r="26" fill="#F1C27D"/>' +
      '<rect x="44" y="96" width="32" height="52" rx="8" fill="#DAA520"/>' +
      '<circle cx="20" cy="120" r="14" fill="#F5D547"/><rect x="8" y="134" width="24" height="40" rx="8" fill="#F5D547"/>' +
      '<circle cx="46" cy="126" r="11" fill="#999"/><rect x="36" y="137" width="20" height="36" rx="7" fill="#999"/>' +
      doug + kidStr +
      (censored ? '' : '<text x="216" y="112" font-size="9" fill="#5a3c14">发糖中…</text>') +
      '</svg>';
  }

  APPS.compare = {
    title: '录像对比器', icon: '🎬', w: 700, h: 430,
    render(body) {
      if (!State.flag('tapeObtained')) {
        body.innerHTML = '<div class="fake-dialog" style="padding:20px;text-align:center">' +
          '<p><b>需要母带版录像。</b></p><p>（占位：网传版是删改过的，没有对比的意义。）</p>' +
          '<p style="color:#888">提示：想办法让汤姆·哈洛开口。</p></div>';
        return;
      }
      const found = State.s.flags.clipsFound;
      const allFound = found.every(Boolean);

      const hotspots = CLIPS.map((c, i) =>
        '<div class="hotspot ' + (found[i] ? 'found' : '') + '" data-clip="' + i + '" style="left:' + c.box.l + 'px;top:' + c.box.t + 'px;width:' + c.box.w + 'px;height:' + c.box.h + 'px"></div>'
      ).join('');

      body.innerHTML = '<div id="cmpWrap">' +
        '<div style="margin-bottom:6px"><button class="btn95" id="cmpPlay">' + (playing ? '⏸ 暂停' : '▶ 播放') + '</button>' +
        ' <span style="font-size:12px;color:#555">点击画面标记差异（已标记 ' + found.filter(Boolean).length + '/3）</span></div>' +
        '<div id="cmpScreens">' +
        '<div class="cmpScreen"><span class="scr-label">网传版（译制删改）</span><span class="tc" id="tcA">00:00:00</span>' +
        '<div class="noise"></div>' + scene(true) + '</div>' +
        '<div class="cmpScreen"><span class="scr-label">母带版（1994 台庆）</span><span class="tc" id="tcB">00:00:00</span>' +
        '<div class="noise"></div>' + scene(false) + hotspots + '</div>' +
        '</div>' +
        '<div id="cmpLog" style="margin-top:8px;font-size:12px;color:#555">' +
        CLIPS.map((c, i) => found[i] ? '◉ ' + c.tc + ' — ' + c.desc : '').filter(Boolean).join('<br>') +
        '</div>' +
        (allFound ? '<p style="margin-top:8px;color:#060;font-weight:bold">占位：三处不一致。有人在母带里藏了一个人。</p>' : '') +
        '</div>';

      body.querySelectorAll('.hotspot').forEach(h => {
        h.onclick = () => {
          const i = Number(h.getAttribute('data-clip'));
          if (State.s.flags.clipsFound[i]) return;
          const f = State.s.flags.clipsFound.slice();
          f[i] = true;
          State.s.flags.clipsFound = f; State.save();
          if (f.every(Boolean)) State.addKw('K11');
          WM.refresh(WID);
        };
      });

      const play = body.querySelector('#cmpPlay');
      play.onclick = () => {
        playing = !playing;
        clearInterval(timer);
        if (playing) {
          timer = setInterval(() => {
            t += 1;
            const s = String(Math.floor(t / 3600)).padStart(2, '0');
            const m = String(Math.floor(t / 60) % 60).padStart(2, '0');
            const ss = String(t % 60).padStart(2, '0');
            const str = '00:' + m + ':' + ss;
            const a = body.querySelector('#tcA'), b = body.querySelector('#tcB');
            if (a) a.textContent = str;
            if (b) b.textContent = str;
          }, 1000);
        }
        WM.refresh(WID);
      };
    }
  };
})();
