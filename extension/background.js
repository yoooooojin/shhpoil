// 바깥과 통신하는 부분.
//  - judge: 판단 엔진(가짜 서버 → 현장에선 팀원분의 Zoro 서버)
//  - ytCommentTimes: YouTube Data API로 댓글의 정확한 작성 시각 조회
//  - 유튜브 보조 실행: 매니페스트 자동 실행이 안 붙는 환경을 위해 직접 스크립트를 넣음
// 콘텐츠 스크립트가 직접 fetch하면 사이트의 CORS 정책에 막힐 수 있어서 여기서 대신 보냅니다.

console.log(`[쉿스포] 백그라운드 v${chrome.runtime.getManifest().version} 시작`);

const DEFAULTS = { serverUrl: "http://localhost:8787", ytApiKey: "" };
const ytTimeCache = new Map(); // 댓글 번호 → ISO (한 번 물어본 건 다시 안 물어봄)

// ---------------------------------------------------------------- 툴바 아이콘 숫자 · 첫 설치 안내
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
});

// 탭마다 "이 페이지에서 가린 글 수"를 아이콘 위에 숫자로
function setBadge(tabId, count) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#E8590C" });
}

// 에이전트 실행 로그 (팝업에서 시나리오별로 내려받음). 여러 탭에서 와도 순서대로 붙이게 줄 세움
let logChain = Promise.resolve();
function addLog(entries, tab) {
  logChain = logChain.then(async () => {
    const { agentLog = [], logOn } = await chrome.storage.local.get(["agentLog", "logOn"]);
    if (!logOn || !entries?.length) return;
    for (const e of entries) e.tab = tab;
    await chrome.storage.local.set({ agentLog: agentLog.concat(entries).slice(-5000) });
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "badge") setBadge(sender.tab?.id, msg.count);
  else if (msg.type === "log") addLog(msg.entries, sender.tab?.id);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = { judge: handleJudge, ytCommentTimes: handleYtTimes, health: handleHealth, ytVideoTimes: handleYtVideoTimes, report: handleReport, ytClues: handleYtClues }[msg.type];
  if (!handler) return false;
  handler(msg)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // 비동기 응답
});

// 판단 엔진이 이 시간 안에 답하지 않으면 실패로 처리 (현장에서 Zoro 속도를 보고 조정)
// 기본값. 팝업의 "응답 대기 시간"으로 바꿀 수 있음 (추론 모드·신고는 그 2배)
const JUDGE_TIMEOUT_MS = 10_000; // 일반 판정
const REASON_TIMEOUT_MS = 20_000; // 추론 모드: 댓글 1개
async function timeouts() {
  const { timeoutSec } = await chrome.storage.local.get({ timeoutSec: JUDGE_TIMEOUT_MS / 1000 });
  const judge = Math.max(1, Number(timeoutSec) || 10) * 1000;
  return { judge, reason: judge * 2 };
}

async function handleJudge(msg) {
  const { serverUrl } = await chrome.storage.local.get(DEFAULTS);
  const url = `${serverUrl.replace(/\/$/, "")}/judge${msg.reason ? "?reason=true" : ""}`;
  const t = await timeouts();
  const limit = msg.reason ? t.reason : t.judge;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload),
      signal: AbortSignal.timeout(limit),
    });
  } catch (e) {
    if (e.name === "TimeoutError") throw new Error(`판단 엔진 응답 시간 초과 (${limit / 1000}초)`);
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { data: await res.json(), ms: Date.now() - t0 };
}

// 판단 엔진이 살아 있는지 (끊겼을 때 복구 확인용)
async function handleHealth() {
  const { serverUrl } = await chrome.storage.local.get(DEFAULTS);
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return {};
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

// videos.list: 영상 번호 최대 50개씩, 요청 1번에 할당량 1. 추천 영상 제목이 몇 화 공개 후 올라왔는지 계산용
const ytVideoCache = new Map();
async function handleYtVideoTimes(msg) {
  const { ytApiKey } = await chrome.storage.local.get(DEFAULTS);
  const times = {};
  const missing = msg.ids.filter((id) => {
    if (ytVideoCache.has(id)) times[id] = ytVideoCache.get(id);
    return !ytVideoCache.has(id);
  });
  if (!ytApiKey || !missing.length) return { times };
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const url =
      "https://www.googleapis.com/youtube/v3/videos?part=snippet" +
      `&id=${encodeURIComponent(chunk.join(","))}&key=${encodeURIComponent(ytApiKey)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
    for (const item of (await res.json()).items || []) {
      const iso = item.snippet?.publishedAt;
      if (iso) ytVideoCache.set(item.id, (times[item.id] = iso));
    }
  }
  return { times };
}

// 애매한 글의 단서: 영상 제목·설명(videos.list, 할당량 1), 댓글의 답글 5개(comments.list, 할당량 1)
const ytSnippetCache = new Map();
async function handleYtClues(msg) {
  const { ytApiKey } = await chrome.storage.local.get(DEFAULTS);
  if (!ytApiKey) throw new Error("YouTube API 키 없음");
  const key = encodeURIComponent(ytApiKey);
  const out = {};
  if (msg.vid) {
    let sn = ytSnippetCache.get(msg.vid);
    if (!sn) {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(msg.vid)}&key=${key}`);
      if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
      const item = (await res.json()).items?.[0]?.snippet;
      sn = { title: item?.title || "", description: item?.description || "" };
      ytSnippetCache.set(msg.vid, sn);
    }
    Object.assign(out, sn);
  }
  if (msg.commentId) {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/comments?part=snippet&textFormat=plainText&maxResults=5&parentId=${encodeURIComponent(msg.commentId)}&key=${key}`
    );
    if (res.ok) out.replies = ((await res.json()).items || []).map((i) => i.snippet?.textDisplay).filter(Boolean);
  }
  return out;
}

// 스포 신고 → 판단 엔진이 사건을 뽑아 기억장에 추가 (POST /report)
async function handleReport(msg) {
  const { serverUrl } = await chrome.storage.local.get(DEFAULTS);
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload),
    signal: AbortSignal.timeout((await timeouts()).reason),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { data: await res.json() };
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
