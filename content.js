(() => {
  'use strict';
  // 智慧教育平台自动连播 content script v2.2（基于真实 DOM：resource-item 视频行 + icon_checkbox 状态）
  if (window.__sapLoaded) return;
  window.__sapLoaded = true;

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const CFG = {
    endDelayMs: 600,
    maxPlayAttempts: 6,
    playRetryMs: 1200,
    cooldownMs: 2500,
    clickVerifyMs: 1800,
    expandWaitMs: 400,
    expandRounds: 6,
  };

  let enabled = true;
  let folded = false;
  let items = [];
  let curIndex = -1;
  let lastSrc = '';
  let lastSwitchAt = 0;
  let boundVideo = null;
  let logs = [];

  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };
  const clsOf = (e) => (typeof e.className === 'string' ? e.className : (e.getAttribute ? e.getAttribute('class') : '') || '').trim();
  const txtOf = (e, n = 24) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, n);

  function log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logs.push(`[${t}] ${msg}`);
    if (logs.length > 120) logs.shift();
    const el = $('#sap-log');
    if (el) { el.textContent = logs.join('\n'); el.scrollTop = el.scrollHeight; }
    console.log('[自动连播]', msg);
  }

  const getVideo = () => $('video.vjs-tech, video');

  const isVisible = (e) => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 10 && r.height > 5;
  };

  // ============ 视频行与状态（真实 DOM） ============
  function findVideoRows() {
    return $$('.resource-item.resource-item-train').filter(isVisible);
  }

  // 状态：已学完(icon_checkbox_fill) / 未开始(icon_checkbox_linear) / 播放中(icon_processing)
  function rowState(row) {
    const i = row.querySelector('.status-icon i, [class*="icon_checkbox"], [class*="icon_processing"]');
    const cls = i ? clsOf(i) : '';
    if (cls.includes('icon_checkbox_fill')) return 'done';
    if (cls.includes('icon_processing')) return 'current';
    return 'wait';
  }

  const stateMark = (s) => (s === 'current' ? '▶' : s === 'done' ? '✓' : '○');

  // ============ 展开所有折叠章节（递归层级） ============
  async function expandAllPanels() {
    for (let round = 0; round < CFG.expandRounds; round++) {
      const headers = $$('.fish-collapse-header[aria-expanded="false"]');
      if (!headers.length) {
        if (round > 0) log('✅ 所有章节已展开');
        return;
      }
      let clickedAny = false;
      for (const h of headers) {
        if (!isVisible(h)) continue;  // 父层还没展开，下轮再处理
        clickedAny = true;
        await clickEl(h, '展开');
        await sleep(CFG.expandWaitMs);
      }
      if (!clickedAny) {
        // 有折叠但都不可见——理论上不该发生（父展开后子会可见），保险再等一轮
        await sleep(300);
      }
    }
    const left = $$('.fish-collapse-header[aria-expanded="false"]').length;
    if (left > 0) log(`⚠ 仍有 ${left} 个章节未展开`);
  }

  // ============ 模拟真实点击 ============
  async function clickEl(el, label) {
    log('🖱 点击' + (label ? '[' + label + '] ' : '') + el.tagName + '.' + clsOf(el).slice(0, 30) + '[' + txtOf(el, 16) + ']');

    el.addEventListener('click', (e) => e.preventDefault(), true);

    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
    await sleep(300);

    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + Math.min(r.height / 2, 28));
    let target = null;
    try { target = document.elementFromPoint(x, y); } catch (e) { /* ignore */ }
    if (!target || !el.contains(target)) target = el;
    log('🖱 实际命中: ' + target.tagName + '.' + clsOf(target).slice(0, 30) + '[' + txtOf(target, 12) + ']');

    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    try {
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      }
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.dispatchEvent(new MouseEvent('click', opts));
      return true;
    } catch (e) {
      log('⚠ 点击异常: ' + e.message);
      return false;
    }
  }

  // ============ 后台保活（标签页隐藏时视频被暂停则自动恢复） ============
  let keepAliveTimer = null;
  let lastKeepAliveLog = 0;
  let keepLastTime = -1;
  let keepLastTimeAt = 0;

  // AudioContext 静音保活：让浏览器认为标签页在播音频，避免冻结/节流
  let audioCtx = null;
  function startAudioKeepAlive() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) {
        audioCtx = new AC();
        const buf = audioCtx.createBuffer(1, 1, 22050);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = audioCtx.createGain();
        gain.gain.value = 0;  // 完全静音
        src.connect(gain);
        gain.connect(audioCtx.destination);
        src.start();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* ignore */ }
  }

  // 通知 background 开启/关闭主世界 pause 守卫
  function notifyGuard(on) {
    try {
      chrome.runtime.sendMessage({ type: on ? 'guard-on' : 'guard-off' });
    } catch (e) { /* background 未加载时忽略 */ }
  }

  function startKeepAlive() {
    if (keepAliveTimer) return;
    log('👀 后台保活启动（拦截平台暂停）');
    notifyGuard(true);
    startAudioKeepAlive();
    keepAliveTimer = setInterval(() => {
      const v = getVideo();
      if (!v || !v.isConnected) return;
      if (v.ended) return;
      if (v.readyState < 2) return;
      const nowMs = now();
      if (v.paused) {
        // 被暂停 → 恢复
        v.play().catch(() => { /* 忽略 */ });
        if (nowMs - lastKeepAliveLog > 10000) {
          lastKeepAliveLog = nowMs;
          log('♻ 后台自动恢复播放');
        }
      } else if (v.currentTime === keepLastTime && nowMs - keepLastTimeAt > 3000) {
        // paused=false 但时间停滞（后台节流）→ 唤醒
        v.play().catch(() => { /* 忽略 */ });
        if (nowMs - lastKeepAliveLog > 10000) {
          lastKeepAliveLog = nowMs;
          log('♻ 后台时间停滞，唤醒播放');
        }
      }
      keepLastTime = v.currentTime;
      keepLastTimeAt = nowMs;
    }, 500);
  }
  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      notifyGuard(false);
      log('👀 后台保活停止');
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) startKeepAlive();
    else stopKeepAlive();
  });
  // 平台监听 window blur 暂停视频（点其他窗口/最小化时标签页可能仍 visible）
  window.addEventListener('blur', () => {
    const v = getVideo();
    if (v && !v.paused && !v.ended) {
      log('👀 窗口失焦，启动后台保活');
      startKeepAlive();
    }
  });
  window.addEventListener('focus', () => {
    stopKeepAlive();
  });

  // ============ 弹窗自动处理 ============
  const MODAL_BTN_TARGETS = ['确定', '知道了', '继续', '确认', '好的', 'OK', '我知道了', '下一步', '关闭', '开始学习'];
  let lastModalTime = 0;

  function checkModal() {
    const v = getVideo();
    if (!v || v.paused === false) return;  // 视频播放中不处理
    if (now() - lastModalTime < 5000) return;  // 5 秒冷却，防反复点

    // 1) 标准弹窗容器
    let dialogs = $$('[role="dialog"], .fish-modal, .ant-modal, [class*="modal-content"], [class*="modal-wrap"], [class*="dialog"], [class*="popup"], [class*="confirm"], [class*="notice"]')
      .filter(isModalLike);
    // 2) 固定定位覆盖层（z-index 高且遮挡播放器的浮层）
    if (!dialogs.length) {
      dialogs = $$('div').filter((d) => {
        if (!isModalLike(d)) return false;
        const cs = getComputedStyle(d);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        const z = parseInt(cs.zIndex, 10);
        if (!isFinite(z) || z < 100) return false;
        const vv = getVideo();
        if (!vv) return false;
        const vr = vv.getBoundingClientRect();
        const dr = d.getBoundingClientRect();
        // 覆盖层必须覆盖播放器大部分区域
        const overlap = Math.max(0, Math.min(vr.right, dr.right) - Math.max(vr.left, dr.left)) *
                        Math.max(0, Math.min(vr.bottom, dr.bottom) - Math.max(vr.top, dr.top));
        if (overlap < vr.width * vr.height * 0.5) return false;
        return true;
      }).slice(0, 3);
    }

    for (const d of dialogs) {
      const btns = $$('button, [role="button"], [class*="btn"]', d).filter(isVisible);
      // 优先白名单文本按钮
      for (const b of btns) {
        const bt = (b.textContent || '').trim();
        if (!bt || bt.length > 14) continue;
        if (MODAL_BTN_TARGETS.some((t) => bt.includes(t))) {
          lastModalTime = now();
          log(`🪟 检测到弹窗[${(d.textContent || '').trim().slice(0, 26)}] → 点击[${bt}]`);
          clickEl(b, '弹窗按钮');
          return;
        }
      }
      // 其次右上角关闭按钮
      const close = d.querySelector('[class*="close"], [aria-label*="关闭"], [aria-label*="Close"]');
      if (close && isVisible(close)) {
        lastModalTime = now();
        log(`🪟 弹窗[${(d.textContent || '').trim().slice(0, 26)}] 无匹配按钮 → 点击关闭 X`);
        clickEl(close, '弹窗关闭');
        return;
      }
      // 诊断：输出弹窗结构
      log('📋 弹窗结构（未自动处理）: ' + d.outerHTML.slice(0, 400).replace(/\s+/g, ' '));
    }
  }

  function isModalLike(d) {
    if (!isVisible(d)) return false;
    if (d.id === 'sap-panel' || d.closest('#sap-panel')) return false;      // 自己的面板
    if (d.closest('.video-js, .vjs-modal-dialog, .vjs-')) return false;      // 播放器 UI
    const r = d.getBoundingClientRect();
    if (r.width < 120 || r.height < 60) return false;
    const txt = (d.textContent || '').trim();
    return txt.length >= 3;
  }

  // ============ 连播主逻辑 ============
  async function clickNextItem() {
    // 1. 确保目录展开
    await expandAllPanels();
    await sleep(600);

    // 2. 视频行
    items = findVideoRows();
    if (items.length < 2) {
      log('⚠ 视频行定位失败（' + items.length + ' 个）');
      return false;
    }
    log(`📋 视频条目共 ${items.length} 个:`);
    const showHead = items.slice(0, 10);
    const showTail = items.slice(-3);
    showHead.forEach((k, i) => log(`  [${i + 1}]${stateMark(rowState(k))} ${txtOf(k, 36)}`));
    if (items.length > 13) {
      log(`  …（共 ${items.length - 13} 条省略）`);
      showTail.forEach((k, i) => log(`  [${items.length - 3 + i}]${stateMark(rowState(k))} ${txtOf(k, 36)}`));
    }

    // 3. 当前索引：播放中 > 最后一个已学完
    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (rowState(items[i]) === 'current') { idx = i; break; }
    }
    if (idx < 0) {
      for (let i = 0; i < items.length; i++) {
        if (rowState(items[i]) === 'done') idx = i;
      }
    }
    log(`📍 当前条目索引: ${idx} ${idx >= 0 ? txtOf(items[idx], 24) : ''}`);

    const oldSrc = (getVideo() && getVideo().src) || '';

    // 4. 点击下一个未完成条目
    let attempt = 0;
    for (let i = idx + 1; i < items.length && attempt < 6; i++) {
      if (rowState(items[i]) === 'done') continue;
      attempt++;
      curIndex = i;
      lastSwitchAt = now();
      log(`▶ 点击下一个 [尝试${attempt}]：${i + 1}/${items.length} ${txtOf(items[i], 36)}`);
      const ok = await clickEl(items[i], '视频');
      if (!ok) break;

      await sleep(CFG.clickVerifyMs);
      const v = getVideo();
      const newSrc = (v && v.src) || '';
      if (newSrc && newSrc !== oldSrc) {
        log('✅ 视频源已切换，连播成功');
        return true;
      }
      log('↪ 点击后视频未切换，尝试下一个候选');
    }
    log('🏁 无更多可播放视频');
    return false;
  }

  function ensurePlaying(v) {
    let attempts = 0;
    const tryPlay = () => {
      attempts++;
      if (!v.isConnected) return;
      if (v.paused === false) { return; }
      v.play().then(() => {
        log('▶ 自动播放成功');
      }).catch((e) => {
        if (attempts < CFG.maxPlayAttempts) {
          setTimeout(tryPlay, CFG.playRetryMs);
        } else {
          log('⚠ 自动播放被浏览器拦截，请手动点一次播放');
        }
      });
    };
    setTimeout(tryPlay, 600);
  }

  function onEnded() {
    if (!enabled) return;
    if (now() - lastSwitchAt < CFG.cooldownMs) return;
    log('⏹ 当前视频播放完毕');
    setTimeout(() => { clickNextItem(); }, CFG.endDelayMs);
  }

  function bindVideo(v) {
    if (boundVideo === v) return;
    if (boundVideo) boundVideo.removeEventListener('ended', onEnded);
    boundVideo = v;
    v.addEventListener('ended', onEnded);
    log('👂 已监听视频结束事件');
  }

  function currentTitle() {
    if (curIndex >= 0 && curIndex < items.length) return txtOf(items[curIndex], 30);
    return '';
  }

  let lastStatusText = '';
  function tick() {
    const v = getVideo();
    if (v) {
      bindVideo(v);
      const src = v.src || '';
      if (src && src !== lastSrc) {
        lastSrc = src;
        log('🎬 视频源切换: ' + src.slice(0, 120));
        ensurePlaying(v);
      }
      const st = $('#sap-status');
      if (st) {
        const txt = `${enabled ? '🟢 连播中' : '⏸ 已暂停'}｜${currentTitle() || '…'} ${fmt(v.currentTime)}/${fmt(v.duration)}`;
        if (txt !== lastStatusText) { st.textContent = txt; lastStatusText = txt; }
      }
    } else {
      const st = $('#sap-status');
      if (st && st.textContent !== '⏳ 未检测到视频') st.textContent = '⏳ 未检测到视频';
    }
  }

  // ============ UI ============
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
#sap-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;background:rgba(28,30,42,.94);color:#e8e8f0;font:12px/1.55 "Microsoft YaHei",system-ui,sans-serif;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.45);overflow:hidden;user-select:none;backdrop-filter:blur(4px)}
#sap-panel *{box-sizing:border-box}
#sap-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(64,84,190,.9);cursor:grab}
#sap-head:active{cursor:grabbing}
#sap-title{flex:1;font-weight:600;font-size:13px;white-space:nowrap}
#sap-toggle,#sap-fold{border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
#sap-toggle:hover,#sap-fold:hover{background:rgba(255,255,255,.28)}
#sap-toggle.off{background:rgba(200,70,70,.85)}
#sap-body{padding:8px 10px}
#sap-status{color:#9fe3a8;margin-bottom:6px;word-break:break-all}
#sap-log{height:180px;overflow-y:auto;background:rgba(0,0,0,.35);border-radius:6px;padding:6px 8px;color:#c9cdd9;white-space:pre-wrap;word-break:break-all;font-family:Consolas,"Courier New",monospace;font-size:11px}
#sap-hint{color:#8a90a6;margin-top:6px;font-size:11px}
#sap-panel.folded #sap-body,#sap-panel.folded #sap-hint{display:none}
`;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'sap-panel';
    panel.innerHTML = `
<div id="sap-head">
  <span id="sap-title">🎬 自动连播</span>
  <button id="sap-toggle" type="button">开</button>
  <button id="sap-fold" type="button">—</button>
</div>
<div id="sap-body">
  <div id="sap-status">⏳ 初始化…</div>
  <div id="sap-log"></div>
</div>
<div id="sap-hint">播放中视频结束后自动切换下一个；视频正常速度播放。</div>`;
    document.documentElement.appendChild(panel);

    let dragging = false, dx = 0, dy = 0;
    const head = $('#sap-head', panel);
    head.addEventListener('mousedown', (e) => {
      dragging = true; dx = e.clientX - panel.getBoundingClientRect().left; dy = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.top = (e.clientY - dy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    $('#sap-toggle', panel).addEventListener('click', (e) => {
      enabled = !enabled;
      e.target.textContent = enabled ? '开' : '关';
      e.target.classList.toggle('off', !enabled);
      log(enabled ? '🟢 连播已开启' : '⏸ 连播已暂停');
    });
    $('#sap-fold', panel).addEventListener('click', (e) => {
      folded = !folded;
      panel.classList.toggle('folded', folded);
      e.target.textContent = folded ? '+' : '—';
    });
  }

  // ============ 启动 ============
  buildUI();
  log('插件已加载（v2.4 后台保活+弹窗处理版）…');
  setInterval(tick, 800);
  setInterval(checkModal, 1500);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastSrc = '';
      curIndex = -1;
      items = [];
      log('📄 页面路由变化，重置状态');
    }
  }, 1000);
})();
