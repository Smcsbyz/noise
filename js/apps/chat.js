/* ============ 聊天窗口 ============ */

const Chat = (() => {
  const WID = 'chat';
  let curContact = 'lu';
  const log = { lu: [], man: [], tom: [] };     // {who:'me'|cid, text}
  const unread = { lu: 0, man: 0, tom: 0 };

  function push(cid, text, isMe) {
    log[cid].push({ who: isMe ? 'me' : cid, text });
    if (!isMe && !(WM.isOpen(WID) && curContact === cid)) unread[cid]++;
    refreshBadge();
    if (WM.isOpen(WID)) WM.refresh(WID);
  }

  function visibleContacts() {
    return CHAT_CONTACTS.filter(c => !c.needFlag || State.flag(c.needFlag));
  }

  function refreshBadge() {
    const btn = document.querySelector('.task-btn');
    /* 任务栏按钮上的红点在 wm.js 中不好按 id 找，这里简单处理聊天窗口按钮 */
    const total = unread.lu + unread.man + unread.tom;
    document.querySelectorAll('#taskButtons .task-btn').forEach(b => {
      if (b.textContent.indexOf('聊天') >= 0) {
        let dot = b.querySelector('.unread');
        if (total > 0) {
          if (!dot) { dot = document.createElement('span'); dot.className = 'unread'; b.appendChild(dot); }
          dot.textContent = total;
        } else if (dot) dot.remove();
      }
    });
  }

  function tomChips() {
    const stage = State.flag('hostStage');
    const node = DLG_TOM[stage];
    if (!node) return [];
    return (node.chips || []).map(c => c.label);
  }

  function contactReply(cid, label) {
    if (cid === 'tom') { tomFlow(label); return; }
    const src = cid === 'lu' ? DLG_LU : DLG_MAN;
    const r = src.replies.find(x => x.label === label);
    if (r) r.lines.forEach(l => push(cid, l));
  }

  /* 汤姆状态机 */
  function tomFlow(label) {
    const stage = State.flag('hostStage');
    const node = DLG_TOM[stage] || DLG_TOM[0];
    const chip = (node.chips || []).find(c => c.label === label);
    if (!chip) return;

    if (stage === 0) {
      push('tom', chip.reply);
      State.flag('hostStage', chip.to);
      return;
    }
    if (chip.to === 'bad') {
      push('tom', chip.reply);
      setTimeout(() => push('tom', DLG_TOM_EXTRA.badReopen), 6000);
      return;
    }
    push('tom', chip.reply);

    if (stage === 3) {           /* 提供报酬 → 谈版本 */
      setTimeout(() => push('tom', chip.after), 900);
      State.flag('hostStage', 4);
    } else if (stage === 4 && chip.to === 5) {   /* 正确答案 → 母带 */
      State.flag('hostStage', 5);
      setTimeout(() => {
        push('tom', DLG_TOM_EXTRA.tape);
        push('tom', DLG_TOM_EXTRA.tapeNote);
        State.flag('tapeObtained', true);
        Toast.show('新线索', '录像对比器已解锁（桌面图标）');
      }, 900);
    } else if (stage === 5 && chip.to === 6) {   /* 问皮套演员 */
      State.flag('hostStage', 6);
      State.addKw('K13');
    } else if (stage === 6 && chip.to === 7) {   /* 真名 */
      State.flag('hostStage', 7);
      setTimeout(() => push('tom', DLG_TOM_EXTRA.kessler), 900);
    }
  }

  APPS.chat = {
    title: '聊天', icon: '💬', w: 520, h: 480,
    render(body) {
      const contacts = visibleContacts();
      if (!contacts.find(c => c.id === curContact)) curContact = contacts[0].id;

      body.innerHTML = '<div class="chat-wrap">' +
        '<div class="chat-list">' +
        contacts.map(c =>
          '<div class="contact ' + (c.id === curContact ? 'cur' : '') + '" data-c="' + c.id + '">' +
          '<span class="dot ' + (c.online ? '' : 'off') + '"></span>' + c.avatar + ' ' + c.name + '</div>').join('') +
        '</div>' +
        '<div class="chat-main">' +
        '<div class="chat-msgs">' +
        log[curContact].map(m =>
          '<div class="chat-msg ' + (m.who === 'me' ? 'me' : '') + '">' +
          '<div class="who">' + (m.who === 'me' ? '我' : (CHAT_CONTACTS.find(c => c.id === m.who) || {}).name) + '</div>' +
          '<div class="txt">' + m.text.replace(/\n/g, '<br>') + '</div></div>').join('') +
        '</div>' +
        '<div class="chat-replies">' + currentChips() + '</div>' +
        '<div class="chat-note">' + currentNote() + '</div>' +
        '</div></div>';

      body.querySelectorAll('.contact').forEach(c => {
        c.onclick = () => {
          curContact = c.getAttribute('data-c');
          unread[curContact] = 0; refreshBadge();
          WM.refresh(WID);
        };
      });
      body.querySelectorAll('.chat-replies .btn95').forEach(b => {
        b.onclick = () => {
          const label = b.getAttribute('data-r');
          if (label === '__greet') return;   /* 由全局监听器处理开场 */
          push(curContact, label, true);
          contactReply(curContact, label);
          WM.refresh(WID);
        };
      });
      const box = body.querySelector('.chat-msgs');
      box && (box.scrollTop = box.scrollHeight);
    },
    onShow() { unread[curContact] = 0; refreshBadge(); }
  };

  function currentChips() {
    if (curContact === 'lu') {
      if (!log.lu.some(m => m.who === 'me')) return '<button class="btn95" data-r="__greet">（点击开始对话）</button>';
      return DLG_LU.replies.map(r => '<button class="btn95" data-r="' + r.label + '">' + r.label + '</button>').join('');
    }
    if (curContact === 'man') {
      if (!log.man.some(m => m.who === 'me')) return '<button class="btn95" data-r="__greet">（点击开始对话）</button>';
      return DLG_MAN.replies.map(r => '<button class="btn95" data-r="' + r.label + '">' + r.label + '</button>').join('');
    }
    /* tom */
    const chips = tomChips();
    if (!chips.length) return '<span class="chat-note">（占位：他暂时没有要说的了。）</span>';
    return chips.map(c => '<button class="btn95" data-r="' + c + '">' + c + '</button>').join('');
  }

  function currentNote() {
    if (curContact !== 'tom') return '';
    const stage = State.flag('hostStage');
    return (DLG_TOM[stage] && DLG_TOM[stage].note) || '';
  }

  /* __greet 特殊处理 */
  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('[data-r="__greet"]');
    if (b) {
      push(curContact, '……', true);
      contactReply(curContact, '__greet');
      if (curContact === 'lu') push('lu', DLG_LU.greeting);
      if (curContact === 'man') push('man', DLG_MAN.greeting);
      WM.refresh(WID);
    }
  });

  return { push };
})();
