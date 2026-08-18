// 智慧教育平台自动连播 background（MV3 service worker）
// 职责：向页面主世界注入 pause 守卫，拦截平台在失焦/隐藏时的 video.pause() 调用

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab) return;
  if (msg.type === 'guard-on' || msg.type === 'guard-off') {
    const on = msg.type === 'guard-on';
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: (enabled) => {
        if (!window.__sapGuardInstalled) {
          window.__sapGuardInstalled = true;
          const origPause = HTMLMediaElement.prototype.pause;
          HTMLMediaElement.prototype.pause = function (...args) {
            // 保活期间：忽略所有暂停调用（平台防挂机逻辑失效）
            if (window.__sapGuardOn && !this.ended) return;
            return origPause.apply(this, args);
          };
        }
        window.__sapGuardOn = enabled;
      },
      args: [on],
    }).catch(() => { /* 页面可能已关闭 */ });
    sendResponse({ ok: true });
  }
  return true;
});
