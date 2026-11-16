// 바깥과 통신하는 부분.
//  - judge: 판단 엔진(가짜 서버 → 현장에선 팀원분의 Zoro 서버)
//  - ytCommentTimes: YouTube Data API로 댓글의 정확한 작성 시각 조회
//  - 유튜브 보조 실행: 매니페스트 자동 실행이 안 붙는 환경을 위해 직접 스크립트를 넣음
// 콘텐츠 스크립트가 직접 fetch하면 사이트의 CORS 정책에 막힐 수 있어서 여기서 대신 보냅니다.

console.log(`[쉿스포] 백그라운드 v${chrome.runtime.getManifest().version} 시작`);

const DEFAULTS = { serverUrl: "http://localhost:8787", ytApiKey: "" };
const ytTimeCache = new Map(); // 댓글 번호 → ISO (한 번 물어본 건 다시 안 물어봄)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = { judge: handleJudge, ytCommentTimes: handleYtTimes }[msg.type];
  if (!handler) return false;
  handler(msg)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // 비동기 응답
});

async function handleJudge(msg) {
  const { serverUrl } = await chrome.storage.local.get(DEFAULTS);
  const url = `${serverUrl.replace(/\/$/, "")}/judge${msg.reason ? "?reason=true" : ""}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { data: await res.json(), ms: Date.now() - t0 };
}

// comments.list는 댓글 번호를 한 번에 최대 50개까지 받고, 요청 1번에 할당량 1을 씀
async function handleYtTimes(msg) {
  const { ytApiKey } = await chrome.storage.local.get(DEFAULTS);
  const times = {};
  const missing = [];
  for (const id of msg.ids) {
    if (ytTimeCache.has(id)) times[id] = ytTimeCache.get(id);
    else missing.push(id);
  }
  if (!ytApiKey || !missing.length) return { times };

  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const url =
      "https://www.googleapis.com/youtube/v3/comments?part=snippet&textFormat=plainText" +
      `&id=${encodeURIComponent(chunk.join(","))}&key=${encodeURIComponent(ytApiKey)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
    const data = await res.json();
    for (const item of data.items || []) {
      const iso = item.snippet?.publishedAt;
      if (iso) {
        ytTimeCache.set(item.id, iso);
        times[item.id] = iso;
      }
    }
  }
  return { times };
}

// ---------------------------------------------------------------- 유튜브 보조 실행
// 일부 환경에서 매니페스트의 content_scripts가 유튜브에 붙지 않아서, 페이지가 열리면 직접 넣어 줌.
// 이미 붙어 있으면 content.js 맨 앞의 중복 방지 코드가 알아서 무시함.
const INJECT_URL = /^https:\/\/(www|m)\.youtube\.com\//;

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !INJECT_URL.test(tab.url || "")) return;
  console.log("[쉿스포] 유튜브 탭 감지:", tabId, tab.url);
  inject(tabId);
});

async function inject(tabId) {
  try {
    const [{ result: loaded } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__shhpoilLoaded,
    });
    if (loaded) return console.log("[쉿스포] 이미 실행 중:", tabId);
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["sites.js", "content.js"] });
    console.log("[쉿스포] 유튜브 탭에 직접 실행했어요:", tabId);
  } catch (e) {
    // 여기 찍히는 이유가 "유튜브에서 안 붙는" 진짜 원인 (예: 정책으로 차단)
    console.warn("[쉿스포] 유튜브 탭 실행 실패:", e?.message || e);
  }
}
