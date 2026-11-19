// 넷플릭스 "관찰": 사용자가 어떤 회차를 거의 다 봤는지 알아채고, 쉿스포의 "본 회차"를 올릴지 먼저 물어봄.
// 넷플릭스 재생 화면 구조 (2026-11 확인)
//   주소 /watch/<번호>, 탭 제목은 "넷플릭스"뿐
//   [data-uia='video-title'] 안에 <h4>작품명</h4><span>3화</span><span>회차 제목</span>  (재생 막대가 보일 때만 있음)
//   시즌 정보는 화면에 없음 → 시즌을 추측하지 않고 바꾸기 전에 사용자에게 확인
(() => {
  if (window.__shhpoilNetflix) return;
  window.__shhpoilNetflix = true;

  const DONE = 0.9; // 이만큼 보면 "다 봤다"고 봄
  const seen = new Map(); // /watch/번호 → { title, ep }  (재생 막대가 사라져도 기억)
  const asked = new Set(); // 이번에 이미 물어본 회차
  let box = null;

  const settings = { show: "흑백요리사2", watchedEpisode: 0, enabled: true, netflixDismissed: {} };
  chrome.storage.local.get(settings, (s) => Object.assign(settings, s));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    for (const [k, v] of Object.entries(c)) if (k in settings) settings[k] = v.newValue ?? settings[k];
  });

  // "흑백요리사2", "흑백요리사 시즌2" → "흑백요리사" (넷플릭스 작품명과 맞춰 보기용)
  const base = (name) => (name || "").replace(/\s*(시즌|season)?\s*\d+\s*$/i, "").replace(/\s+/g, "").toLowerCase();
  const sameShow = (title) => {
    const b = base(settings.show);
    return b.length >= 2 && title.replace(/\s+/g, "").toLowerCase().includes(b);
  };

  function readTitle() {
    const t = document.querySelector("[data-uia='video-title']");
    if (!t) return null;
    const title = t.querySelector("h4")?.textContent?.trim() || "";
    let ep = null;
    for (const s of t.querySelectorAll("span")) {
      const m = s.textContent.trim().match(/^(\d+)\s*화$|^E(\d+)$|^Episode\s*(\d+)$/i);
      if (m) {
        ep = Number(m[1] || m[2] || m[3]);
        break;
      }
    }
    return title && ep ? { title, ep } : null;
  }

  function log(stage, event, data = {}) {
    chrome.runtime.sendMessage({ type: "log", entries: [{ t: new Date().toISOString(), stage, event, site: "netflix", ...data }] })?.catch?.(() => {});
  }

  function tick() {
    const m = location.pathname.match(/^\/watch\/(\d+)/);
    if (!m || !settings.enabled) return;
    const id = m[1];
    const info = readTitle();
    if (info) seen.set(id, info);
    const cur = seen.get(id);
    const v = document.querySelector("video");
    if (!cur || !v || !v.duration || !isFinite(v.duration)) return;
    if (v.currentTime / v.duration < DONE) return;
    const key = `${id}:${cur.ep}`;
    if (asked.has(key) || settings.netflixDismissed?.[id]) return;
    if (!sameShow(cur.title) || cur.ep <= settings.watchedEpisode) return;
    asked.add(key);
    log("관찰", `넷플릭스에서 "${cur.title}" ${cur.ep}화를 ${Math.round((v.currentTime / v.duration) * 100)}% 시청`, { netflix_id: id, episode: cur.ep, watched: settings.watchedEpisode });
    ask(id, cur);
  }

  // 화면 오른쪽 위에 작은 질문 상자 (전체 화면이어도 보이게 전체 화면 요소 안에 붙임)
  function ask(id, cur) {
    box?.remove();
    const el = (tag, style, text) => {
      const e = document.createElement(tag);
      if (style) e.style.cssText = style;
      if (text) e.textContent = text;
      return e;
    };
    box = el(
      "div",
      "position:fixed;top:24px;right:24px;z-index:2147483647;max-width:340px;background:#fff;color:#0f0f0f;border-radius:14px;" +
        "padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:14px/1.5 'Noto Sans KR',system-ui,sans-serif"
    );
    const head = el("div", "display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:4px");
    const icon = el("img", "width:22px;height:22px");
    icon.src = chrome.runtime.getURL("icons/icon48.png");
    head.append(icon, el("span", "", "쉿스포"));
    const msg = el("div", "", `${cur.ep}화를 다 보셨네요! 쉿스포의 "${settings.show}" 본 회차를 ${settings.watchedEpisode}화 → ${cur.ep}화로 바꿀까요?`);
    const sub = el("div", "color:#606060;font-size:12px;margin-top:2px", "바꾸면 유튜브에서 지금까지 가려 둔 글 중 1~" + cur.ep + "화 얘기가 풀려요. 다른 시즌이면 '아니요'를 눌러 주세요.");
    const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:10px");
    const btn = (text, primary) =>
      el(
        "button",
        `border:0;border-radius:99px;padding:7px 14px;font:inherit;font-weight:600;cursor:pointer;${primary ? "background:#0f0f0f;color:#fff" : "background:#f2f2f2;color:#0f0f0f"}`,
        text
      );
    const no = btn("아니요");
    const yes = btn(`${cur.ep}화로 바꾸기`, true);
    no.onclick = () => {
      chrome.storage.local.set({ netflixDismissed: { ...(settings.netflixDismissed || {}), [id]: true } });
      log("학습", "사용자: 넷플릭스 회차 변경 제안 거절 (이 회차는 다시 묻지 않음)", { netflix_id: id, episode: cur.ep });
      close();
    };
    yes.onclick = () => {
      const from = settings.watchedEpisode;
      chrome.storage.local.set({ watchedEpisode: cur.ep });
      log("행동", `넷플릭스 시청 기록으로 본 회차 변경 ${from}화 → ${cur.ep}화`, { netflix_id: id, from, to: cur.ep });
      msg.textContent = `${cur.ep}화까지 본 걸로 바꿨어요. 이제 ${cur.ep}화 얘기는 유튜브에서 그대로 보여요.`;
      sub.remove();
      row.remove();
      setTimeout(close, 3500);
    };
    row.append(no, yes);
    box.append(head, msg, sub, row);
    (document.fullscreenElement || document.body).append(box);
  }
  function close() {
    box?.remove();
    box = null;
  }
  // 전체 화면으로 바뀌면 상자를 그 안으로 옮김
  document.addEventListener("fullscreenchange", () => box && (document.fullscreenElement || document.body).append(box));

  setInterval(tick, 2000);
  console.log("[쉿스포] 넷플릭스 시청 회차 확인 중");
})();
