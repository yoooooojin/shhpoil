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
//   available(el, text, hasKey) → 이 글에서 더 모을 수 있는 단서 ["parent", "replies", "description", "timestamp"]
//   clues(el, want, id, text)   → async, Zoro가 요청한 단서 { parent, replies[], description, timestamp }

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

// ---------------------------------------------------------------- 단서 모으기 도우미
// 글 속 "12:20", "1:02:03" 같은 영상 시각
window.BDK_timestamp = (text) => (text || "").match(/(?<![\d:])(\d{1,2}:)?\d{1,2}:\d{2}(?![\d:])/)?.[0] || null;
const toSec = (ts) => ts.split(":").reduce((a, b) => a * 60 + Number(b), 0);
// 영상 설명의 챕터("05:10 팀 구성")에서 그 시각이 들어가는 챕터 제목
window.BDK_chapterAt = (desc, ts) => {
  if (!desc || !ts) return null;
  const at = toSec(ts);
  let best = null;
  for (const line of desc.split("\n")) {
    const m = line.trim().match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—:]?\s*(.+)$/);
    if (m && toSec(m[1]) <= at && (!best || toSec(m[1]) >= best.sec)) best = { sec: toSec(m[1]), title: m[2].trim() };
  }
  return best?.title || null;
};
const bgAsk = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (res) => resolve(res)));
// 유튜브 답글이면 원댓글 전문
function ytParentText(el) {
  if (!el.closest("ytd-comment-replies-renderer")) return null;
  const thread = el.closest("ytd-comment-thread-renderer");
  const parent = [...(thread?.querySelectorAll("ytd-comment-view-model, ytd-comment-renderer") || [])].find(
    (c) => !c.closest("ytd-comment-replies-renderer")
  );
  return parent?.querySelector("#content-text")?.textContent?.trim() || null;
}
function ytCurrentVid() {
  const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
  if (m) return m[1];
  return location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
}
// 영상 설명·답글은 YouTube API로 (팝업에 키가 있을 때만)
async function ytClues(want, { vid, commentId, text }) {
  const out = {};
  const needVideo = want.includes("description") || want.includes("timestamp");
  const res = await bgAsk({ type: "ytClues", vid: needVideo ? vid : null, commentId: want.includes("replies") ? commentId : null });
  if (!res?.ok) return out;
  if (want.includes("replies") && res.replies?.length) out.replies = res.replies;
  if (want.includes("description") && res.description) out.description = res.description;
  const ts = window.BDK_timestamp(text);
  if (want.includes("timestamp") && ts && (res.description || res.title)) {
    const ch = window.BDK_chapterAt(res.description, ts);
    out.timestamp = ch ? `${ts} 챕터: ${ch}` : `${ts} · 영상 "${res.title}" (챕터 정보 없음)`;
  }
  return out;
}

window.BDK_SITES = [
  {
    // 시연 페이지 (mock-server가 띄우는 /demo/)
    name: "demo",
    // 확장으로 여는 로컬 시연 페이지, 또는 웹 체험판(<html data-shhpoil-demo>)
    match: (loc) => ["localhost", "127.0.0.1"].includes(loc.hostname) || document.documentElement.hasAttribute("data-shhpoil-demo"),
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
    // 시연 페이지는 YouTube API 대신 화면에 있는 영상 설명·답글을 단서로 씀
    available: (el, text) => {
      const a = [];
      if (el.dataset.replies) a.push("replies");
      if (document.querySelector("[data-description]")?.dataset.description) {
        a.push("description");
        if (window.BDK_timestamp(text)) a.push("timestamp");
      }
      return a;
    },
    clues: async (el, want, _id, text) => {
      const out = {};
      const desc = document.querySelector("[data-description]")?.dataset.description || "";
      if (want.includes("replies") && el.dataset.replies) out.replies = JSON.parse(el.dataset.replies);
      if (want.includes("description") && desc) out.description = desc;
      const ts = window.BDK_timestamp(text);
      if (want.includes("timestamp") && ts) {
        const ch = window.BDK_chapterAt(desc, ts);
        if (ch) out.timestamp = `${ts} 챕터: ${ch}`;
      }
      await new Promise((r) => setTimeout(r, 400)); // 모으는 장면이 보이게 잠깐
      return out;
    },
  },
  {
    // 실제 유튜브 영상 댓글
    // 유튜브는 화면 구조를 자주 바꿔서, 안 잡히면 개발자 도구(F12)로 아래 선택자를 확인하세요.
    name: "youtube",
    match: (loc) => loc.hostname === "www.youtube.com" || loc.hostname === "m.youtube.com",
    // 일반 영상은 #comments, 쇼츠는 오른쪽 댓글 패널의 <ytd-comments> 안에 있음
    items: (root) =>
      root.querySelectorAll(
        "#comments ytd-comment-view-model, #comments ytd-comment-renderer, ytd-comments ytd-comment-view-model, ytd-comments ytd-comment-renderer"
      ),
    idOf: (el) => commentIdOf(el),
    text: (el) => (el.querySelector("#content-text")?.textContent || "").trim(),
    postedAt: (el) => {
      const label = el.querySelector("#published-time-text")?.textContent?.trim();
      const iso = window.BDK_parseRelative(label);
      return iso ? { iso, exact: false } : null; // 대략값 → resolveTimes로 정확한 값 요청
    },
    // 영상 제목 + (답글이면) 원댓글. 판단 엔진에는 "제목\n원댓글: …" 형태의 글자로 전달됨
    context: (el) => {
      // 쇼츠는 제목 요소가 따로 없어서 탭 제목으로 대신함
      const title =
        document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1")?.textContent?.trim() ||
        document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
      const text = ytParentText(el)?.slice(0, 300);
      return text ? `${title}\n원댓글: ${text}` : title;
    },
    available: (el, text, hasKey) => {
      const a = [];
      const reply = !!el.closest("ytd-comment-replies-renderer");
      if (reply) a.push("parent");
      if (hasKey) {
        if (!reply && commentIdOf(el)) a.push("replies");
        if (ytCurrentVid()) {
          a.push("description");
          if (window.BDK_timestamp(text)) a.push("timestamp");
        }
      }
      return a;
    },
    clues: async (el, want, id, text) => {
      const out = {};
      if (want.includes("parent")) {
        const p = ytParentText(el);
        if (p) out.parent = p;
      }
      const api = want.filter((w) => w !== "parent");
      if (api.length) Object.assign(out, await ytClues(api, { vid: ytCurrentVid(), commentId: id.startsWith("bdk-") ? null : id, text }));
      return out;
    },
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
  {
    // 시연 페이지의 "다음 동영상" 목록 (제목 스포 가리기)
    name: "demo-videos",
    kind: "video",
    match: (loc) => ["localhost", "127.0.0.1"].includes(loc.hostname) || document.documentElement.hasAttribute("data-shhpoil-demo"),
    items: (root) => root.querySelectorAll("[data-bdk-video]"),
    idOf: (el) => (el.dataset.vid ? `v:${el.dataset.vid}` : null),
    text: (el) => (el.querySelector(".t")?.textContent || "").trim(),
    postedAt: (el) => (el.dataset.published ? { iso: el.dataset.published, exact: true } : null),
    context: (el) => `[추천 영상 제목] ${el.querySelector(".m")?.textContent?.split("·")[0]?.trim() || ""}`,
    blurTarget: null,
    badgeHost: (el) => el,
  },
  {
    // 실제 유튜브: 영상 옆 추천 목록, 홈, 검색 결과의 영상 카드 (제목·썸네일 스포 가리기)
    // 유튜브는 카드 구조를 자주 바꿔서 옛 구조(ytd-*-renderer)와 새 구조(yt-lockup-view-model)를 같이 찾음
    name: "youtube-videos",
    kind: "video",
    match: (loc) => loc.hostname === "www.youtube.com" || loc.hostname === "m.youtube.com",
    items: (root) =>
      [...root.querySelectorAll(VIDEO_CARD)].filter(
        (el) => !el.parentElement?.closest(VIDEO_CARD) && !el.closest("#comments, ytd-comments") && videoIdOf(el)
      ),
    idOf: (el) => {
      const v = videoIdOf(el);
      return v ? `v:${v}` : null;
    },
    text: (el) =>
      (
        el.querySelector("#video-title")?.textContent ||
        el.querySelector("h3")?.textContent ||
        el.querySelector("a[title]")?.getAttribute("title") ||
        ""
      ).trim(),
    // 카드의 "10개월 전" 표시로 대략값 → resolveTimes로 정확한 업로드 시각
    postedAt: (el) => {
      const iso = window.BDK_parseRelative(el.textContent);
      return iso ? { iso, exact: false } : null;
    },
    context: (el) =>
      `[추천 영상 제목] ${(el.querySelector("#channel-name, ytd-channel-name")?.textContent || "").trim()}`,
    blurTarget: null, // 썸네일·제목·채널 전체를 흐림
    badgeHost: (el) => el,
    available: (_el, _text, hasKey) => (hasKey ? ["description"] : []),
    clues: (_el, want, id, text) => ytClues(want.filter((w) => w === "description"), { vid: id.slice(2), text }),
    resolveTimes: (ids) =>
      new Promise((resolve) => {
        const vids = ids.map((id) => id.slice(2));
        chrome.runtime.sendMessage({ type: "ytVideoTimes", ids: vids }, (res) => {
          const out = {};
          for (const [v, iso] of Object.entries(res?.ok ? res.times : {})) out[`v:${v}`] = iso;
          resolve(out);
        });
      }),
  },
  {
    // X(트위터): 검색·타임라인·게시글 화면의 글 (사진·영상만 있고 글자가 없는 글은 아직 판단하지 않음)
    name: "x",
    cls: "bdk-x",
    match: (loc) => ["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"].includes(loc.hostname),
    items: (root) => root.querySelectorAll('article[data-testid="tweet"]'),
    idOf: (el) => {
      const m = xStatusHref(el).match(/\/status\/(\d+)/);
      return m ? `x:${m[1]}` : null;
    },
    text: (el) => (el.querySelector('[data-testid="tweetText"]')?.innerText || "").trim(),
    // X는 글마다 정확한 작성 시각(<time datetime>)이 있어서 API 키 없이 회차 비교가 됨
    postedAt: (el) => {
      const iso = el.querySelector("time")?.getAttribute("datetime");
      return iso ? { iso, exact: true } : null;
    },
    context: (el) => {
      const parent = xParentText(el)?.slice(0, 300);
      return parent ? `[X 게시글의 답글]\n원글: ${parent}` : "[X 게시글]";
    },
    blurTarget: (el) => el.querySelector('[data-testid="tweetText"]'),
    badgeHost: (el) => el.querySelector('[data-testid="tweetText"]')?.parentElement || null,
    available: (el) => (xParentText(el) ? ["parent"] : []),
    clues: async (el, want) => {
      const p = want.includes("parent") ? xParentText(el) : null;
      return p ? { parent: p } : {};
    },
  },
];

// X 글의 고유 주소(/사용자/status/번호): 작성 시각 링크에 들어 있음
function xStatusHref(el) {
  return el.querySelector("a[href*='/status/'] time")?.closest("a")?.getAttribute("href") || "";
}
// 게시글 화면(/status/번호)에서 답글이면 맨 위 원글 본문
function xParentText(el) {
  const m = location.pathname.match(/\/status\/(\d+)/);
  if (!m || xStatusHref(el).includes(`/status/${m[1]}`)) return null;
  const main = [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) => xStatusHref(a).includes(`/status/${m[1]}`));
  return main?.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || null;
}

// 쇼츠 카드: 홈·검색의 쇼츠 줄 (ytm-shorts-lockup-view-model-v2 안에 옛 이름이 한 겹 더 있음 → 바깥 것만 씀)
const VIDEO_CARD =
  "ytd-compact-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, " +
  "ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model, ytd-reel-item-renderer";

// 카드 안 영상 링크(/watch?v=… 또는 /shorts/…)에서 영상 번호를 꺼냄
function videoIdOf(el) {
  const href = el.querySelector("a[href*='watch?v='], a[href*='/shorts/']")?.getAttribute("href") || "";
  const m = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
  return m ? m[1] : null;
}

// 댓글 시간 링크 주소(…&lc=댓글번호)에서 고유 번호를 꺼냄
function commentIdOf(el) {
  const a = el.querySelector("#published-time-text a, a[href*='lc=']");
  const href = a?.getAttribute("href") || "";
  const m = href.match(/[?&]lc=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
