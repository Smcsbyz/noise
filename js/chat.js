/* ============================================================
   chat.js —— 聊天提示音模块
     ------------------------------------------------------------
     只做一件事：管好那颗「新消息」音效。

     为什么单独拆一个文件：
     聊天流程本身（剧本、推进、存档）住在 desktop.js 的同一个闭包里，
     搬出来会切断它与 chatStore / switchTab 的联系；但提示音天然是
     独立的、可替换的，放在这里以后换音效只动一个文件。

     对外只暴露两个方法（挂在 window.HWUMsgSound）：
       play()   —— 响一声（每句 NPC 消息落地时调）
       unlock() —— 在真实点击里静默播一次，解开浏览器的自动播放限制

     文件缺失、解码失败、被浏览器拦截：一律吞掉，只留一条 warn，
     绝不让音频问题打断游戏。
     ============================================================ */

(function () {
  'use strict';

  var SRC = 'assets/audio/message.mp3';
  var VOLUME = 0.5;

  /* 全局唯一的提示音对象：全程复用，避免每响一次 new 一个 Audio */
  var msgAudio = new Audio(SRC);
  msgAudio.preload = 'auto';
  msgAudio.volume = VOLUME;

  var warned = false;
  var unlocked = false;
  var lastPlayAt = 0;

  function warn(reason) {
    if (warned) return;
    warned = true;
    console.warn('[MSG] ' + reason + '：' + SRC + '（不影响游戏，继续玩即可）');
  }

  msgAudio.addEventListener('error', function () {
    warn('提示音文件缺失或无法解码');
  });

  /* 响一声。两条消息挨得很近时允许打断重播——聊天本来是一句一响。 */
  function play() {
    try {
      var now = Date.now();
      if (now - lastPlayAt < 60) return;   /* 同一帧内被调两次，只响一次 */
      lastPlayAt = now;

      msgAudio.currentTime = 0;
      var p = msgAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          var name = err && err.name ? err.name : '';
          if (name === 'NotAllowedError') return;   /* 等下次点击解锁 */
          warn('播放失败');
        });
      }
    } catch (e) {
      warn('播放异常');
    }
  }

  /* 解锁：必须在真实点击（安装链接 / 发送按钮 / 音符按钮）里调。
     做法是把音量压到 0 播一下再立刻停住——浏览器认这一下「用户触发」，
     之后 play() 才不会被拦。整个过程听不见任何声音。 */
  function unlock() {
    if (unlocked) return;

    try {
      var oldVolume = msgAudio.volume;
      msgAudio.volume = 0;
      msgAudio.currentTime = 0;

      var p = msgAudio.play();
      if (!p || typeof p.then !== 'function') {
        msgAudio.volume = oldVolume;
        return;
      }

      p.then(function () {
        msgAudio.pause();
        msgAudio.currentTime = 0;
        msgAudio.volume = oldVolume;
        unlocked = true;
      }).catch(function () {
        msgAudio.volume = oldVolume;   /* 失败不抛错，下次点击再试 */
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  window.msgAudio = msgAudio;
  window.HWUMsgSound = {
    play: play,
    unlock: unlock,
    el: msgAudio
  };
})();
