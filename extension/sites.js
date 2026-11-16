// 사이트별 "관찰" 어댑터. 사이트마다 글/댓글이 있는 위치가 달라서 여기만 바꾸면 됩니다.
//
// 필수
//   match(location)   → 이 사이트에서 쓸지
//   items(root)       → 판정할 요소 목록
//   text(el)          → 본문 텍스트
//   postedAt(el)      → { iso, exact } 게시 시각. exact=false면 대략값 (없으면 null)
//   context(el)       → 원글·영상 제목 등 (댓글 뜻을 이해하는 데 도움)
// 선택
//   idOf(el)          → 사이트의 고유 번호 (화면이 다시 그려져도 같은 글로 인식)
//   blurTarget(el)    → 흐리게 할 부분 (없으면 요소 전체)
//   badgeHost(el)     → 배지를 넣을 곳 (없으면 요소 맨 앞)
//   resolveTimes(ids) → async, 정확한 시각 { id: iso } (exact=false인 것만 요청됨)

// "10개월 전", "3시간 전(수정됨)", "2 weeks ago" → 대략적인 ISO 시각
window.BDK_parseRelative = function (label, now = new Date()) {
  if (!label) return null;
  const s = label.replace(/\(.*?\)/g, "").trim();
  const ko = s.match(/(\d+)\s*(초|분|시간|일|주|개월|달|년)\s*전/);
  const en = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
  const n = Number((ko || en)?.[1]);
  const unit = ko?.[2] || en?.[2]?.toLowerCase();
  if (!n || !unit) return null;
  const MIN = 60e3, H = 60 * MIN, D = 24 * H;
  const ms = {
    초: 1e3, second: 1e3, 분: MIN, minute: MIN, 시간: H, hour: H,
    일: D, day: D, 주: 7 * D, week: 7 * D,
    개월: 30 * D, 달: 30 * D, month: 30 * D, 년: 365 * D, year: 365 * D,
  }[unit];
  return new Date(now.getTime() - n * ms).toISOString();
};

window.BDK_SITES = [
  {
    // 시연 페이지 (mock-server가 띄우는 /demo/)
    name: "demo",
    match: (loc) => ["localhost", "127.0.0.1"].includes(loc.hostname),
    items: (root) => root.querySelectorAll("[data-bdk-comment]"),
    idOf: (el) => el.dataset.id || null,
    text: (el) => (el.querySelector(".text")?.textContent || "").trim(),
    // 시연 페이지는 실제 유튜브처럼 "10개월 전"을 보여주지만, API로 받은 셈 치고 정확한 시각을 data에 넣어 둠
    postedAt: (el) => {
      const iso = el.querySelector("[data-published]")?.dataset.published;
      return iso ? { iso, exact: true } : null;
    },
    context: (_el) => document.querySelector("[data-bdk-title]")?.textContent?.trim() || "",
    blurTarget: (el) => el.querySelector(".text"),
    badgeHost: (el) => el.querySelector(".main"),
  },
  {
    // 실제 유튜브 영상 댓글
    // 유튜브는 화면 구조를 자주 바꿔서, 안 잡히면 개발자 도구(F12)로 아래 선택자를 확인하세요.
    name: "youtube",
    match: (loc) => loc.hostname === "www.youtube.com" || loc.hostname === "m.youtube.com",
    items: (root) => root.querySelectorAll("#comments ytd-comment-view-model, #comments ytd-comment-renderer"),
    idOf: (el) => commentIdOf(el),
    text: (el) => (el.querySelector("#content-text")?.textContent || "").trim(),
    postedAt: (el) => {
      const label = el.querySelector("#published-time-text")?.textContent?.trim();
      const iso = window.BDK_parseRelative(label);
      return iso ? { iso, exact: false } : null; // 대략값 → resolveTimes로 정확한 값 요청
    },
    context: (_el) =>
      document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1")?.textContent?.trim() || "",
    blurTarget: (el) => el.querySelector("#expander") || el.querySelector("#content-text"),
    badgeHost: (el) => el.querySelector("#main") || null,
    resolveTimes: (ids) =>
      new Promise((resolve) => {
        const real = ids.filter((id) => !id.startsWith("bdk-"));
        if (!real.length) return resolve({});
        chrome.runtime.sendMessage({ type: "ytCommentTimes", ids: real }, (res) =>
          resolve(res?.ok ? res.times : {})
        );
      }),
  },
];

// 댓글 시간 링크 주소(…&lc=댓글번호)에서 고유 번호를 꺼냄
function commentIdOf(el) {
  const a = el.querySelector("#published-time-text a, a[href*='lc=']");
  const href = a?.getAttribute("href") || "";
  const m = href.match(/[?&]lc=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
