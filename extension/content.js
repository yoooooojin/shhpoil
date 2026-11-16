// 쉿스포(Shhpoil) - 사용자님 파트: 관찰 · 행동 · 사용자 반응 학습 에이전트
//
//  [관찰] 화면의 글을 모으고, 화면에 보이는 것부터 판정 요청 (스크롤로 새 글이 오면 추가)
//  [판단] 판단 엔진(지금은 가짜 서버, 현장에선 Zoro)에 묻기
//  [행동] 확률 + 본 회차 + 사용자 기준으로 가리기 / 흐리게 / 다시 묻기 / 그대로
//  [학습] "스포 아님 / 스포였음" 반응으로 글 종류별 기준을 조정

(() => {
  // 매니페스트 자동 실행 + background의 보조 실행이 겹쳐도 한 번만 동작
  if (window.__shhpoilLoaded) return;
  window.__shhpoilLoaded = true;

  const VERSION = chrome.runtime.getManifest().version;
  const site = (window.BDK_SITES || []).find((s) => s.match(location));
  console.log(`[쉿스포] v${VERSION} 실행됨 · 사이트: ${site?.name || "해당 없음"}`);
  if (!site) return;

  const DEFAULTS = {
    enabled: true,
    mode: "zoro", // "zoro" | "keyword"
    show: "흑백요리사2",
    watchedEpisode: 3,
    sensitivity: 0.5, // 0: 확실한 스포만 ~ 1: 조금이라도 의심되면
    keywords: "흑백요리사,최강록,우승,탈락",
    typeOffsets: {}, // 학습 결과: 글 종류별 기준 보정값
    overrides: {}, // 사용자가 직접 판정한 댓글: { 댓글id: "show" | "hide" } (새로고침해도 유지)
  };
  // 저장만 바뀌고 화면 전체를 다시 판단할 필요는 없는 설정
  const LEARNING_KEYS = ["typeOffsets", "overrides"];

  let settings = { ...DEFAULTS };
  const state = new Map(); // id → { el, text, postedAt, result, status }
  const queue = new Set();
  let flushTimer = null;
  let seq = 0;
  const stats = { judged: 0, hidden: 0, blurred: 0, reasoned: 0, lastMs: 0 };

  // ---------------------------------------------------------------- 관찰
  function idOf(el) {
    // 사이트가 고유 번호를 주면 그걸 씀 (유튜브: 댓글 번호) → 화면이 다시 그려져도 같은 글로 인식
    const siteId = site.idOf?.(el);
    if (siteId) return (el.dataset.bdkId = siteId);
    if (!el.dataset.bdkId) el.dataset.bdkId = el.dataset.id || `bdk-${++seq}`;
    return el.dataset.bdkId;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = idOf(e.target);
        const s = state.get(id);
        if (s && s.status === "new") enqueue(id);
      }
    },
    { rootMargin: "200px 0px" }, // 화면 바로 아래 것까지 미리
  );

  function scan(root = document) {
    for (const el of site.items(root)) {
      const id = idOf(el);
      const known = state.get(id);
      if (known) {
        // 같은 글인데 화면 요소가 새로 그려진 경우 (유튜브, 시연 페이지 탭 전환): 결과를 다시 입힘
        if (known.el !== el) {
          known.el = el;
          markItem(el);
          if (["hide", "blur", "show", "error"].includes(known.status))
            setStatus(id, known.status);
          else if (settings.enabled) el.classList.add("bdk-pending");
          io.observe(el);
        }
        continue;
      }
      const text = site.text(el);
      if (!text) continue;
      const t = site.postedAt(el); // { iso, exact } 또는 null
      state.set(id, {
        el,
        text,
        postedAt: t?.iso || null,
        timeExact: !!t?.exact,
        context: site.context(el),
        result: null,
        status: "new",
      });
      markItem(el);
      if (settings.enabled) el.classList.add("bdk-pending");
      io.observe(el);
    }
  }

  // 흐리게 할 부분을 표시 (사이트가 지정하면 본문만, 아니면 요소 전체)
  function markItem(el) {
    el.classList.add("bdk-item");
    const target = site.blurTarget?.(el);
    if (target) {
      el.classList.add("bdk-has-target");
      target.classList.add("bdk-target");
    }
  }

  function badgeOf(el, id) {
    return el.querySelector(`.bdk-badge[data-for="${CSS.escape(id)}"]`);
  }

  new MutationObserver((muts) => {
    if (muts.some((m) => m.addedNodes.length)) scan();
  }).observe(document.body, { childList: true, subtree: true });

  function enqueue(id) {
    queue.add(id);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 120); // 짧게 모아서 한 번에
  }

  // ---------------------------------------------------------------- 판단 요청
  function judge(ids, reason) {
    const comments = ids.map((id) => {
      const s = state.get(id);
      return { id, text: s.text, posted_at: s.postedAt, context: s.context };
    });
    const payload = {
      show: settings.show,
      watched_episode: settings.watchedEpisode,
      comments,
    };
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "judge", payload, reason }, (res) =>
        resolve(res),
      ),
    );
  }

  async function flush() {
    if (!settings.enabled) return;
    const ids = [...queue].slice(0, 20);
    ids.forEach((id) => queue.delete(id));
    if (!ids.length) return;

    if (settings.mode === "keyword") {
      ids.forEach((id) => applyKeyword(id));
    } else {
      ids.forEach((id) => (state.get(id).status = "judging"));
      await resolveTimes(ids);
      const res = await judge(ids, false);
      if (!res?.ok) {
        // 실패하면 열어 둠 (화면을 막아버리지 않기)
        ids.forEach((id) => setStatus(id, "error"));
        console.warn("[쉿스포] 판단 엔진 연결 실패:", res?.error);
      } else {
        stats.lastMs = res.ms;
        for (const r of res.data.results) {
          const s = state.get(r.id);
          if (!s) continue;
          s.result = r;
          stats.judged++;
          decide(r.id);
        }
      }
    }
    if (queue.size) flush();
  }

  // 정확한 작성 시각이 없는 글은 사이트별 방법으로 채움 (유튜브: YouTube Data API)
  async function resolveTimes(ids) {
    if (!site.resolveTimes) return;
    const need = ids.filter((id) => !state.get(id).timeExact);
    if (!need.length) return;
    try {
      const times = await site.resolveTimes(need); // { id: iso }
      for (const [id, iso] of Object.entries(times || {})) {
        const s = state.get(id);
        if (s && iso) {
          s.postedAt = iso;
          s.timeExact = true;
        }
      }
    } catch (e) {
      console.warn("[쉿스포] 작성 시각 조회 실패, 대략적인 시각으로 진행:", e);
    }
  }

  // ---------------------------------------------------------------- 행동 결정
  function baseThreshold() {
    // 민감도 0 → 0.85 (확실한 것만), 1 → 0.30 (조금만 의심돼도)
    return 0.85 - 0.55 * settings.sensitivity;
  }

  function isAhead(r) {
    // 이 글이 "내가 본 회차 뒤"의 내용을 말하는가?
    const w = settings.watchedEpisode;
    if (r.matched_event && r.matched_event.p >= 0.5)
      return r.matched_event.episode > w;
    if (r.written_after_episode == null) return true; // 시점을 모르면 보수적으로
    return r.written_after_episode > w;
  }

  function decide(id) {
    const s = state.get(id);
    // 사용자가 직접 "스포 아님 / 스포였음"을 누른 댓글은 그 결정을 그대로 따름
    const override = settings.overrides?.[id];
    if (override) return setStatus(id, override);
    const r = s.result;
    const offset = settings.typeOffsets[r.type] || 0;
    const T = Math.min(0.95, Math.max(0.05, baseThreshold() + offset));
    const p = isAhead(r) ? r.p_spoiler : r.p_spoiler * 0.1; // 이미 본 내용이면 사실상 무해

    s.why = buildWhy(r, p, T) + (s.timeExact ? "" : " · 작성 시각 추정");

    if (Math.abs(p - T) < 0.1 && !r.reasoned && isAhead(r)) {
      // 애매함 → 일단 흐려 두고 추론 모드로 다시 묻기
      setStatus(id, "blur");
      reask(id);
      return;
    }
    if (p >= T + 0.15) setStatus(id, "hide");
    else if (p >= T) setStatus(id, "blur");
    else setStatus(id, "show");
  }

  async function reask(id) {
    const res = await judge([id], true);
    if (!res?.ok) return;
    const r = res.data.results[0];
    if (!r) return;
    stats.reasoned++;
    state.get(id).result = r;
    decide(id);
  }

  function applyKeyword(id) {
    const s = state.get(id);
    const words = settings.keywords
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    const hit = words.find((w) => s.text.includes(w));
    s.result = null;
    s.why = hit ? `키워드 "${hit}" 포함` : "키워드 없음";
    setStatus(id, hit ? "hide" : "show");
  }

  function buildWhy(r, p, T) {
    const parts = [`${r.type}`, `스포 확률 ${Math.round(r.p_spoiler * 100)}%`];
    if (r.matched_event)
      parts.push(`${r.matched_event.episode}화 사건 "${r.matched_event.text}"`);
    else if (r.written_after_episode != null)
      parts.push(`${r.written_after_episode}화 공개 후 작성`);
    parts.push(`기준 ${Math.round(T * 100)}%`);
    if (r.reasoned) parts.push("추론 모드");
    return parts.join(" · ");
  }

  // ---------------------------------------------------------------- 화면
  function setStatus(id, status) {
    const s = state.get(id);
    s.status = status;
    const el = s.el;
    el.classList.remove(
      "bdk-pending",
      "bdk-hide",
      "bdk-blur",
      "bdk-show",
      "bdk-revealed",
    );
    badgeOf(el, id)?.remove();
    if (status === "error" || status === "show") {
      if (status === "show") el.classList.add("bdk-show");
      addBadge(el, id, status);
      refreshCounts();
      return;
    }
    el.classList.add(status === "hide" ? "bdk-hide" : "bdk-blur");
    if (s.revealed) el.classList.add("bdk-revealed"); // "보기"로 열어 둔 건 다시 판단돼도 열린 채로
    addBadge(el, id, status);
    refreshCounts();
  }

  function addBadge(el, id, status) {
    const s = state.get(id);
    const b = document.createElement("div");
    b.className = "bdk-badge";
    b.dataset.for = id;
    // 유튜브는 Trusted Types 보안 정책 때문에 innerHTML을 막아서, 요소를 하나씩 만들어 붙임
    const label = { hide: "스포 가림", blur: "스포 의심" }[status];
    if (label) b.append(h("span", { class: `bdk-label bdk-${status}` }, label));
    if (status === "hide" || status === "blur") {
      b.append(
        h("button", { "data-act": "reveal" }, "보기"),
        h("button", { "data-act": "notspoiler" }, "스포 아님"),
      );
    }
    if (status === "show")
      b.append(
        h(
          "button",
          { "data-act": "wasspoiler", class: "bdk-quiet" },
          "스포였음",
        ),
      );
    b.append(h("span", { class: "bdk-why", title: s.why || "" }, "ⓘ"));
    b.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      onFeedback(id, act);
    });
    (site.badgeHost?.(el) || el).prepend(b);
  }

  // ---------------------------------------------------------------- 학습
  async function onFeedback(id, act) {
    const s = state.get(id);
    if (act === "reveal") {
      s.revealed = true;
      s.el.classList.add("bdk-revealed");
      return;
    }
    // 사용자의 직접 결정은 이 댓글에 고정하고 저장 (회차 변경·새로고침에도 유지)
    const decision = act === "notspoiler" ? "show" : "hide";
    settings.overrides = { ...(settings.overrides || {}), [id]: decision };
    s.revealed = false;
    setStatus(id, decision);

    const type = s.result?.type;
    if (type) {
      const cur = settings.typeOffsets[type] || 0;
      // 잘못 가렸다 → 이 종류는 기준을 올림 / 놓쳤다 → 기준을 내림
      const next = act === "notspoiler" ? cur + 0.05 : cur - 0.05;
      settings.typeOffsets = {
        ...settings.typeOffsets,
        [type]: Math.max(-0.3, Math.min(0.3, Math.round(next * 100) / 100)),
      };
      toast(
        `"${type}" 기준을 ${act === "notspoiler" ? "느슨하게" : "엄격하게"} 조정했어요 (${settings.typeOffsets[type] > 0 ? "+" : ""}${Math.round(settings.typeOffsets[type] * 100)}%p)`,
      );
    } else {
      toast(decision === "show" ? "이 댓글은 계속 보여줄게요" : "이 댓글은 계속 가릴게요");
    }
    try {
      await chrome.storage.local.set({
        typeOffsets: settings.typeOffsets,
        overrides: settings.overrides,
      });
    } catch (e) {
      // 확장을 새로고침한 뒤 페이지를 새로고침하지 않으면 여기서 실패함
      toast("확장이 새로고침됐어요. 이 페이지도 새로고침해 주세요.");
      console.warn("[쉿스포] 학습 저장 실패:", e);
    }
    // 같은 종류의 다른 글들도 새 기준으로 다시 결정
    if (type)
      for (const [otherId, o] of state)
        if (otherId !== id && o.result?.type === type) decide(otherId);
  }

  // ---------------------------------------------------------------- 상태 표시
  const hud = document.createElement("div");
  hud.className = "bdk-hud";
  document.documentElement.appendChild(hud);

  function refreshCounts() {
    let hidden = 0,
      blurred = 0;
    for (const s of state.values()) {
      if (s.status === "hide") hidden++;
      else if (s.status === "blur") blurred++;
    }
    hud.replaceChildren(h("b", {}, "🤫 쉿스포"), ` v${VERSION}`);
    if (!settings.enabled) return hud.append(" 꺼짐");
    hud.append(
      ` ${settings.mode === "keyword" ? "키워드 모드" : "판정 모드"} · ${settings.watchedEpisode}화까지 봄`,
      h("br"),
      `가림 ${hidden} · 의심 ${blurred} · 추론 ${stats.reasoned}${stats.lastMs ? ` · 응답 ${stats.lastMs}ms` : ""}`,
    );
  }

  // 작은 요소 생성 도우미 (innerHTML 대신)
  function h(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }

  let toastTimer;
  function toast(msg) {
    hud.dataset.toast = msg;
    hud.classList.add("bdk-toasting");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hud.classList.remove("bdk-toasting"), 2500);
  }

  // ---------------------------------------------------------------- 설정 변경 → 전체 다시 판단
  function rejudgeAll() {
    stats.reasoned = 0;
    queue.clear();
    for (const [id, s] of state) {
      s.result = null;
      s.status = "new";
      s.el.classList.remove("bdk-hide", "bdk-blur", "bdk-show", "bdk-revealed");
      badgeOf(s.el, id)?.remove();
      if (settings.enabled) {
        s.el.classList.add("bdk-pending");
        enqueue(id);
      } else {
        s.el.classList.remove("bdk-pending");
      }
    }
    refreshCounts();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue ?? DEFAULTS[k];
    const onlyLearning = Object.keys(changes).every((k) => LEARNING_KEYS.includes(k));
    // 팝업의 "학습 초기화" → 직접 누른 결정이 비워짐
    const learningReset =
      changes.overrides && !Object.keys(changes.overrides.newValue || {}).length;
    if (learningReset) for (const s of state.values()) s.revealed = false;
    if (!onlyLearning || learningReset) rejudgeAll();
  });

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    scan();
    refreshCounts();
  });
})();
