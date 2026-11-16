// 판단 엔진(가짜 서버 → 나중엔 팀원분의 Zoro 서버)과 통신하는 부분.
// 콘텐츠 스크립트가 직접 fetch하면 사이트의 CORS 정책에 막힐 수 있어서 여기서 대신 보냅니다.

const DEFAULTS = { serverUrl: "http://localhost:8787" };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "judge") return false;
  (async () => {
    try {
      const { serverUrl } = await chrome.storage.local.get(DEFAULTS);
      const url = `${serverUrl.replace(/\/$/, "")}/judge${msg.reason ? "?reason=true" : ""}`;
      const t0 = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      sendResponse({ ok: true, data, ms: Date.now() - t0 });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // 비동기 응답
});
