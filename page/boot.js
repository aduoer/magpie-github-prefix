// 带路页：把 magpie 这个框架导航到插件宿主起的本地服务上。
//
// 为什么不直接在这里画界面：magpie 的插件页 CSP 是 connect-src 'none'，
// 页里发不出任何请求（fetch/XHR/WebSocket 全被拦），也用不了存储 ——
// 它唯一能做的联网动作是把自身导航到别处，那个 origin 接管这个框架。
// 所以真正的界面在 index.mjs 里（http://127.0.0.1:3487/）。
//
// 两件事要同时成立，否则 magpie 会把这个页面判成「没有响应」：
//   1) 10 秒内要有一次 hello 回到 magpie —— 否则看门狗用「此页面已停止工作」盖掉框架；
//   2) 导航要在 hello 之后 —— 先导航走，hello 的通道跟着文档一起没了，照样被判死。
// 于是这里先等 hello（自带超时），拿到结果再走；bridge 不在时自己发一次 hello 兜底。

(() => {
  const PORT = 3487;
  // 看门狗给 10 秒，这里留 2 秒余量：无论如何这一秒数之后都走。
  const HARD_MS = 8000;
  const HELLO_MS = 6000;

  const said = document.getElementById("said");
  const say = (t) => { if (said) said.textContent = t; };

  let gone = false;
  const go = (theme) => {
    if (gone) return;
    gone = true;
    const q = theme ? "?theme=" + encodeURIComponent(theme) : "";
    location.replace("http://127.0.0.1:" + PORT + "/" + q + (q ? "&" : "?") + "_=" + Date.now());
  };

  // 没有 bridge（magpie 很老、或者 bridge.js 没加载上）时，按同样的消息格式自己问一句。
  const helloByHand = () => new Promise((resolve) => {
    const id = "boot-" + Math.random().toString(36).slice(2);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      removeEventListener("message", onMsg);
      resolve(v);
    };
    const onMsg = (e) => {
      const d = e.data;
      if (d && d.magpie && d.id === id) finish(d.result || {});
    };
    addEventListener("message", onMsg);
    try {
      parent.postMessage({ magpie: 1, id, method: "hello", params: {} }, "*");
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), HELLO_MS);
  });

  say("正在打开…");
  setTimeout(() => go(""), HARD_MS);

  (async () => {
    let info = null;
    try {
      if (window.magpie && window.magpie.ready) {
        // bridge 自己会发 hello，这里只是等它的结果（超时就不等了）。
        info = await Promise.race([
          Promise.resolve(window.magpie.ready).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), HELLO_MS)),
        ]);
      } else {
        info = await helloByHand();
      }
    } catch {
      /* 没有桥也没关系，界面自己按系统深浅色走 */
    }
    const theme = info && typeof info.dark === "boolean" ? (info.dark ? "dark" : "light") : "";
    go(theme);
  })();
})();
