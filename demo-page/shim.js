// 웹 체험판: 크롬 확장 없이 확장 코드(extension/content.js)를 그대로 돌리기 위한 대역
//  - chrome.storage.local → 브라우저 localStorage (이 기기에만 저장)
//  - chrome.runtime.sendMessage → 판단 요청을 체험판 엔진(engine.js)이나, 주소가 있으면 진짜 판단 엔진 서버로 보냄
(() => {
  const KEY = "shhpoil-trial-v1";
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    store = {};
  }
  const listeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      /* 저장이 막힌 브라우저(사생활 보호 모드 등)에선 이 탭에서만 유지 */
    }
  };

  function get(keys, cb) {
    let out = {};
    if (keys == null) out = { ...store };
    else if (typeof keys === "string") {
      if (keys in store) out[keys] = store[keys];
    } else if (Array.isArray(keys)) keys.forEach((k) => k in store && (out[k] = store[k]));
    else for (const [k, v] of Object.entries(keys)) out[k] = k in store ? store[k] : v;
    out = clone(out);
    if (cb) return void setTimeout(() => cb(out), 0);
    return Promise.resolve(out);
  }
  function set(obj, cb) {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) {
      changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
      store[k] = clone(v);
    }
    persist();
    setTimeout(() => {
      listeners.forEach((f) => f(changes, "local"));
      cb?.();
    }, 0);
    return Promise.resolve();
  }
  function reset() {
    const changes = {};
    for (const k of Object.keys(store)) changes[k] = { oldValue: store[k], newValue: undefined };
    store = {};
    persist();
  }

  // 판단 요청: 서버 주소가 있으면 진짜 엔진(Zoro)으로, 없거나 실패하면 체험판 엔진으로
  async function call(path, body, reason) {
    const url = (store.serverUrl || "").trim().replace(/\/$/, "");
    if (url) {
      try {
        const res = await fetch(`${url}${path}${reason ? "?reason=true" : ""}`, {
          method: body ? "POST" : "GET",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout((Number(store.timeoutSec) || 10) * 1000 * (reason ? 2 : 1)),
        });
        if (res.ok) return await res.json();
      } catch {
        /* 아래 체험판 엔진으로 */
      }
    }
    await new Promise((r) => setTimeout(r, reason ? 350 : 120)); // 판단하는 시간 흉내
    const E = window.SHHPOIL_ENGINE;
    if (path === "/judge") return E.judge(body, reason);
    if (path === "/report") return E.report(body);
    return E.health();
  }

  async function handle(msg) {
    const t0 = Date.now();
    switch (msg.type) {
      case "judge":
        return { ok: true, data: await call("/judge", msg.payload, msg.reason), ms: Date.now() - t0 };
      case "report":
        return { ok: true, data: await call("/report", msg.payload) };
      case "health":
        return { ok: true, ...(await call("/health")) };
      case "ytCommentTimes":
      case "ytVideoTimes":
        return { ok: true, times: {} };
      case "blocked": {
        const today = new Date().toLocaleDateString("sv");
        const s = store.stats?.date === today ? store.stats : { date: today, blocked: 0 };
        set({ stats: { ...s, blocked: s.blocked + (msg.count || 1), total: (store.stats?.total || 0) + (msg.count || 1) } });
        return { ok: true };
      }
      default:
        return { ok: true }; // badge 등 툴바 표시는 체험판에 없음
    }
  }

  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: "체험판" }),
      getURL: (p) => p,
      sendMessage(msg, cb) {
        const p = handle(msg).catch((e) => ({ ok: false, error: String(e) }));
        if (cb) p.then(cb);
        return p;
      },
    },
    storage: {
      local: { get, set },
      onChanged: { addListener: (f) => listeners.push(f) },
    },
  };
  window.SHHPOIL_TRIAL = { reset };
})();
