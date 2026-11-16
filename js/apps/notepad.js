/* ============ 记事本窗口（决策与结局） ============ */

const Notepad = (() => {
  const WID = 'notepad';

  function titleFor(code) {
    const words = State.chosenWords();
    const neg = words.filter(w => w.p === '-').length;
    const pos = words.filter(w => w.p === '+').length;
    if (!State.flag('draft1Submitted')) return '《欢乐好时光：被诅咒的童年》（占位标题）';
    if (neg === 4) return '《一档儿童节目，一个邪教，和三十年的沉默》';
    if (pos === 4) return '《她只是想让女儿不怕黑》';
    return '《欢乐好时光：一半是童年，一半是传说》';
  }

  APPS.notepad = {
    title: '记事本 · 稿件', icon: '📝', w: 640, h: 520,
    render(body) {
      const S = State.s;
      const count = S.keywords.length;
      const locked = count < 8;
      const d1 = !S.flags.draft1Submitted;

      const slots = S.draft.words.map((w, i) => {
        const label = w ? '【' + KW[w].label + '】' : '（空）';
        return '<span class="slot ' + (w ? 'filled' : '') + '" data-slot="' + i + '" title="点击移除">' + label + '</span>';
      }).join('');

      const tray = S.keywords.map(id =>
        '<span class="kw-chip ' + (S.draft.words.includes(id) ? 'used' : '') + '" data-fill="' + id + '">【' + KW[id].label + '】</span>'
      ).join('') || '<span style="color:#888">还没有收集到任何词条。</span>';

      const preview = State.chosenWords().length
        ? '标题：' + titleFor() + '<br>关键词：' + State.chosenWords().map(w => '【' + w.label + '】').join('') +
          '<br>（占位：正文由词条自动生成。）'
        : '（占位：填入 4 个词条后自动生成稿件。）';

      body.innerHTML =
        '<div class="np-head"><input class="title95" readonly value="' + titleFor() + '"></div>' +
        (locked
          ? '<p class="warn" style="color:#C00">占位：证据不足。收集到 8 条词条后才能开始写稿（当前 ' + count + '/8）。</p>'
          : '') +
        '<div class="np-slots"><b>关键词（4 格）：</b><br>' + slots + '</div>' +
        '<div class="np-ninth"><b>第九格</b> <span class="hint">（此处可手动输入一个词）</span><br>' +
        '<input id="np9" class="input95" style="width:260px" value="' + (S.draft.ninth || '') + '" placeholder="占位：被掩埋的那条新闻……">' +
        (State.hasKw('K14') ? ' <button class="btn95" id="npCite" style="min-width:0">引用此条</button>' : '') +
        '</div>' +
        '<div class="np-preview">' + preview + '</div>' +
        '<div class="np-tray"><div class="tray-title">词库（' + count + '）</div>' + tray + '</div>' +
        '<div class="np-actions">' +
        '<button class="btn95" id="npSubmit" ' + (locked ? 'disabled' : '') + '>' + (d1 ? '提交初稿' : '发 布') + '</button>' +
        '<span class="warn" id="npWarn"></span></div>';

      body.querySelectorAll('[data-slot]').forEach(s => {
        s.onclick = () => State.clearSlot(Number(s.getAttribute('data-slot')));
      });
      body.querySelectorAll('[data-fill]').forEach(c => {
        if (c.classList.contains('used')) return;
        c.onclick = () => {
          const i = S.draft.words.indexOf(null);
          if (i < 0) { document.getElementById('npWarn').textContent = '只能选 4 个词。'; return; }
          State.setSlot(i, c.getAttribute('data-fill'));
        };
      });
      const n9 = body.querySelector('#np9');
      n9 && (n9.onchange = () => State.setNinth(n9.value));
      const cite = body.querySelector('#npCite');
      cite && (cite.onclick = () => { State.setNinth('Ivan Kessler'); WM.refresh(WID); });

      body.querySelector('#npSubmit').onclick = () => Main.publish();
    }
  };
})();
