/* ============ 启动序列（约 12 秒，点击/按键可跳过） ============ */

const Boot = (() => {
  const lines = [
    'VBIOS v1.02  Memory Test: 16384K OK',
    'Detecting IDE drives ... OK',
    'Mouse initialized ... OK',
    'Loading VEYLAND SYSTEMS 98 ...'
  ];

  let skipped = false;

  function run(onDone) {
    const el = document.getElementById('bootText');
    let i = 0;
    const skip = () => { skipped = true; finish(); };

    function next() {
      if (skipped) return;
      if (i < lines.length) {
        el.textContent += lines[i] + '\n';
        i++;
        setTimeout(next, 700);
      } else {
        /* 蓝底系统画面 */
        const blue = document.createElement('div');
        blue.className = 'blue-stage';
        blue.innerHTML = '<div style="font-size:26px;font-weight:bold">Veyland Systems 98</div>' +
          '<div>© 1998 Veyland Systems Inc. 保留所有权利。</div>';
        document.getElementById('boot').appendChild(blue);
        setTimeout(() => { if (!skipped) dial(); }, 2600);
      }
    }

    function dial() {
      const dialEl = document.createElement('div');
      dialEl.className = 'dial-stage';
      dialEl.textContent = '正在拨号连接 …… 56.6 kbps 已连接 ✓';
      document.getElementById('boot').appendChild(dialEl);
      setTimeout(() => { if (!skipped) finish(); }, 2600);
    }

    function finish() {
      document.removeEventListener('click', skip);
      document.removeEventListener('keydown', skip);
      document.getElementById('boot').classList.add('hidden');
      document.getElementById('desktop').classList.remove('hidden');
      onDone && onDone();
    }

    document.addEventListener('click', skip);
    document.addEventListener('keydown', skip);
    next();
  }

  return { run };
})();
