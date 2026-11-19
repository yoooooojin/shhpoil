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
  // 한 페이지에서 여러 어댑터를 같이 씀 (예: 유튜브 댓글 + 추천 영상 제목)
  const sites = (window.BDK_SITES || []).filter((s) => s.match(location));
  console.log(`[쉿스포] v${VERSION} 실행됨 · 사이트: ${sites.map((s) => s.name).join(", ") || "해당 없음"}`);
  if (!sites.length) return;
  const siteOfEl = new WeakMap(); // 화면 요소 → 그 요소를 찾은 어댑터

  const DEFAULTS = {
    enabled: true,
    mode: "zoro", // "zoro" | "keyword"
    show: "흑백요리사2",
    watchedEpisode: 3,
    sensitivity: 0.5, // 0: 확실한 스포만 ~ 1: 조금이라도 의심되면
    keywords: "흑백요리사,최강록,우승,탈락",
    typeOffsets: {}, // 학습 결과: 글 종류별 기준 보정값
    batchSize: 20, // 판단 엔진에 한 번에 보내는 글 수 (엔진이 느리면 줄이기)
    compare: false, // 키워드 방식이었다면 어땠을지 같이 표시 (비교 보기)
    overrides: {}, // 사용자가 직접 판정한 댓글: { 댓글id: { decision: "show" | "hide", ep: 누른 때의 본 회차 } }
  };
  // 저장만 바뀌고 화면 전체를 다시 판단할 필요는 없는 설정
  const LEARNING_KEYS = ["typeOffsets", "overrides"];
  // 다시 판단할 필요 없이 화면 표시만 바뀌는 설정
  const DISPLAY_KEYS = ["compare", "batchSize", "timeoutSec"];

  let settings = { ...DEFAULTS };
  const state = new Map(); // id → { el, text, postedAt, result, status }
  const queue = new Set();
  let flushTimer = null;
  let seq = 0;
  const stats = { judged: 0, hidden: 0, blurred: 0, reasoned: 0, lastMs: 0 };

  // ---------------------------------------------------------------- 관찰
  function idOf(el) {
    // 사이트가 고유 번호를 주면 그걸 씀 (유튜브: 댓글 번호) → 화면이 다시 그려져도 같은 글로 인식
    const siteId = siteOfEl.get(el)?.idOf?.(el);
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
    for (const site of sites)
      for (const el of site.items(root)) {
        siteOfEl.set(el, site);
        scanOne(el, site);
      }
  }

  function scanOne(el, site) {
    {
      const id = idOf(el);
      const known = state.get(id);
      if (known) {
        // 같은 글인데 화면 요소가 새로 그려진 경우 (유튜브, 시연 페이지 탭 전환): 결과를 다시 입힘
        if (known.el !== el) {
          known.el = el;
          markItem(el, site);
          if (["hide", "blur", "show", "error"].includes(known.status))
            setStatus(id, known.status);
          else if (settings.enabled) el.classList.add("bdk-pending");
          io.observe(el);
        }
        return;
      }
      const text = site.text(el);
      if (!text) return;
      const t = site.postedAt(el); // { iso, exact } 또는 null
      state.set(id, {
        el,
        site,
        kind: site.kind || "comment",
        text,
        postedAt: t?.iso || null,
        timeExact: !!t?.exact,
        context: site.context(el),
        result: null,
        status: "new",
      });
      markItem(el, site);
      if (settings.enabled) el.classList.add("bdk-pending");
      io.observe(el);
    }
  }

  // 흐리게 할 부분을 표시 (사이트가 지정하면 본문만, 아니면 요소 전체)
  function markItem(el, site) {
    el.classList.add("bdk-item");
    if (site.kind === "video") el.classList.add("bdk-video");
    const target = site.blurTarget?.(el);
    if (target) {
      el.classList.add("bdk-has-target");
      target.classList.add("bdk-target");
    }
  }

  function badgeOf(el, id) {
    return el.querySelector(`.bdk-badge[data-for="${CSS.escape(id)}"]`);
  }

  // 유튜브는 화면이 아주 자주 바뀌어서, 바뀔 때마다 훑으면 페이지가 멈춤
  // → 바뀐 게 몰려와도 0.4초에 한 번만 훑고, 쉿스포가 직접 붙인 배지·상태창 변화는 무시
  let scanTimer = null;
  const ours = (n) => n.nodeType !== 1 || n.classList.contains("bdk-badge") || n.classList.contains("bdk-hud");
  new MutationObserver((muts) => {
    if (scanTimer) return;
    if (!muts.some((m) => [...m.addedNodes].some((n) => !ours(n)))) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
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
    const ids = [...queue].slice(0, Math.max(1, Number(settings.batchSize) || 20));
    ids.forEach((id) => queue.delete(id));
    if (!ids.length) return;

    if (settings.mode === "keyword") {
      ids.forEach((id) => applyKeyword(id));
    } else {
      ids.forEach((id) => (state.get(id).status = "judging"));
      await resolveTimes(ids);
      const res = await judge(ids, false);
      if (!res?.ok) {
        // 판단 엔진이 죽거나 느리면: 키워드 방식으로 대신 가리고, 엔진이 살아나면 다시 판단
        console.warn("[쉿스포] 판단 엔진 연결 실패 → 키워드 모드로 대체:", res?.error);
        ids.forEach((id) => applyKeyword(id, true));
        engineDown(true);
      } else {
        engineDown(false);
        stats.lastMs = res.ms;
        for (const r of res.data.results) {
          const s = state.get(r.id);
          if (!s) continue;
          s.result = r;
          remember(r.id, r);
          stats.judged++;
          decide(r.id);
        }
      }
    }
    if (queue.size) flush();
  }

  // 정확한 작성 시각이 없는 글은 사이트별 방법으로 채움 (유튜브: YouTube Data API)
  async function resolveTimes(ids) {
    for (const site of sites) {
      if (!site.resolveTimes) continue;
      const need = ids.filter((id) => state.get(id).site === site && !state.get(id).timeExact);
      if (need.length) await resolveTimesFor(site, need);
    }
  }

  async function resolveTimesFor(site, need) {
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

  // ---------------------------------------------------------------- 오류 대응: 엔진 끊김 → 키워드 대체 → 자동 복귀
  let down = false;
  let healthTimer = null;
  function engineDown(isDown) {
    if (down === isDown) return;
    down = isDown;
    clearInterval(healthTimer);
    if (isDown) {
      toast("판단 엔진 연결 끊김 → 키워드 모드로 대체 중");
      // 5초마다 엔진이 살아났는지 확인
      healthTimer = setInterval(() => {
        chrome.runtime.sendMessage({ type: "health" }, (res) => {
          if (chrome.runtime.lastError || !res?.ok || !down) return;
          engineDown(false);
          toast("판단 엔진 복구 → 다시 판정 모드로");
          // 키워드로 대신 처리했던 댓글만 다시 판단
          for (const [id, s] of state)
            if (s.fallback) {
              s.fallback = false;
              enqueue(id);
            }
        });
      }, 5000);
    }
    refreshCounts();
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

  // 사용자가 직접 판정한 결정이 지금 본 회차에서도 유효한가
  //  - "스포 아님"(N화까지 보고 누름): N화 이상 봤을 때만 유효. 그보다 앞으로 돌리면 다시 판단
  //  - "스포였음"(N화까지 보고 누름): N화 이하일 때만 유효. 더 보고 나면 다시 판단
  function activeOverride(id) {
    const o = settings.overrides?.[id];
    if (!o) return null;
    if (typeof o === "string") return o; // 예전 형식 (회차 정보 없음)
    const w = settings.watchedEpisode;
    if (o.decision === "show") return w >= o.ep ? "show" : null;
    return w <= o.ep ? "hide" : null;
  }

  function decide(id) {
    const s = state.get(id);
    // 사용자가 직접 "스포 아님 / 스포였음"을 누른 댓글은 그 결정을 그대로 따름
    const override = activeOverride(id);
    if (override) return setStatus(id, override);
    const r = s.result;
    const offset = settings.typeOffsets[r.type] || 0;
    const T = Math.min(0.95, Math.max(0.05, baseThreshold() + offset));
    const p = isAhead(r) ? r.p_spoiler : r.p_spoiler * 0.1; // 이미 본 내용이면 사실상 무해

    const approx = s.timeExact ? "" : " · 작성 시각 추정";
    s.whyFull = buildWhy(r, T, false) + approx;
    s.whySafe = buildWhy(r, T, true) + approx; // 가린 댓글은 사건 내용을 숨김 (이유 표시가 스포가 되지 않게)
    s.short = shortWhy(r);

    // 다시 묻기는 댓글당 한 번만 (서버가 reasoned를 안 넣어 줘도 무한 반복하지 않게)
    if (Math.abs(p - T) < 0.1 && !r.reasoned && !s.reasked && isAhead(r)) {
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
    const s = state.get(id);
    s.reasked = true;
    const round = s.round; // 기다리는 동안 설정이 바뀌어 다시 판단이 시작됐으면 이 응답은 버림
    const res = await judge([id], true);
    if (s.round !== round) return;
    const r = res?.ok && res.data.results.find((x) => x.id === id);
    if (!r) return decide(id); // 실패하면 첫 판단 결과로 결정 (흐린 채로 멈추지 않게)
    stats.reasoned++;
    s.result = r;
    remember(id, r);
    decide(id);
  }

  // 키워드 방식(비교 기준): 팝업의 차단 키워드 중 하나라도 들어 있으면 가림
  function keywordHit(text) {
    return settings.keywords
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean)
      .find((w) => text.includes(w));
  }

  // 비교 보기: 쉿스포 판단과 키워드 방식이 갈린 글에만 꼬리표
  function compareTag(s) {
    if (!settings.compare || settings.mode === "keyword" || s.fallback || !s.result) return null;
    if (settings.overrides?.[s.el?.dataset?.bdkId]) return null;
    const ours = s.status === "hide" || s.status === "blur";
    const kw = !!keywordHit(s.text);
    if (ours && !kw) return "miss"; // 쉿스포는 잡았는데 키워드는 놓침
    if (!ours && kw && s.status === "show") return "over"; // 키워드였으면 괜히 가렸을 글
    return null;
  }

  function applyKeyword(id, fallback = false) {
    const s = state.get(id);
    s.fallback = fallback;
    const override = activeOverride(id);
    if (override) return setStatus(id, override);
    const words = settings.keywords
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean)
      // 엔진이 죽었을 때 대신 쓸 땐 작품 이름 같은 단어는 빼고 씀 (안 그러면 전부 가려짐)
      // 키워드 모드(비교 시연)에선 그대로 둬서 "키워드 방식은 다 막는다"를 보여줌
      .filter((w) => !fallback || !settings.show.includes(w));
    const hit = words.find((w) => s.text.includes(w));
    s.result = null;
    s.whyFull = s.whySafe =
      (fallback ? "판단 엔진 연결 끊김 → 키워드로 대체 · " : "") + (hit ? `키워드 "${hit}" 포함` : "키워드 없음");
    s.short = hit ? `${fallback ? "키워드 대체 · " : ""}키워드 "${hit}"` : "";
    setStatus(id, hit ? "hide" : "show");
  }

  // 이 댓글이 몇 화 내용을 말하는지 (사건이 확실하면 사건 회차, 아니면 작성 시점)
  function episodeOf(r) {
    if (r.matched_event && r.matched_event.p >= 0.5) return r.matched_event.episode;
    return r.written_after_episode;
  }

  // 배지에 바로 보이는 짧은 이유
  function shortWhy(r) {
    const ep = episodeOf(r);
    if (!isAhead(r)) return ep ? `이미 본 ${ep}화 내용` : "";
    return [r.type, `${Math.round(r.p_spoiler * 100)}%`, ep != null ? `${ep}화 내용` : "", r.reasoned ? "추론" : ""]
      .filter(Boolean)
      .join(" · ");
  }

  function buildWhy(r, T, hideEvent) {
    const parts = [`${r.type}`, `스포 확률 ${Math.round(r.p_spoiler * 100)}%`];
    if (r.matched_event)
      parts.push(
        hideEvent
          ? `${r.matched_event.episode}화 사건 (내용은 가림)`
          : `${r.matched_event.episode}화 사건 "${r.matched_event.text}"`,
      );
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
    const label = (s.kind === "video" ? { hide: "제목 스포 가림", blur: "제목 스포 의심" } : { hide: "스포 가림", blur: "스포 의심" })[status];
    if (label) b.append(h("span", { class: `bdk-label bdk-${status}` }, label));
    // 짧은 이유: 가린 글엔 항상, 보이는 글엔 "이미 본 N화 내용"일 때만 (나머지는 ⓘ에)
    if (s.short && (label || s.short.startsWith("이미 본")))
      b.append(h("span", { class: "bdk-reason" }, s.short));
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
    const open = status === "show" || status === "error" || s.revealed;
    b.append(h("span", { class: "bdk-why", title: (open ? s.whyFull : s.whySafe) || "" }, "ⓘ"));
    const cmp = compareTag(s);
    if (cmp)
      b.append(
        h(
          "span",
          { class: `bdk-cmp bdk-cmp-${cmp}` },
          cmp === "miss" ? "키워드였다면 놓침" : "키워드였다면 괜히 가림",
        ),
      );
    b.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      onFeedback(id, act);
    });
    (s.site.badgeHost?.(el) || el).prepend(b);
  }

  // ---------------------------------------------------------------- 학습
  async function onFeedback(id, act) {
    const s = state.get(id);
    if (act === "reveal") {
      s.revealed = true;
      setStatus(id, s.status); // 열린 상태로 다시 그림 (이유에 사건 내용도 표시)
      return;
    }
    // 사용자의 직접 결정은 이 댓글에 고정하고 저장 (회차 변경·새로고침에도 유지)
    const decision = act === "notspoiler" ? "show" : "hide";
    settings.overrides = {
      ...(settings.overrides || {}),
      [id]: { decision, ep: settings.watchedEpisode },
    };
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
    // "스포였음" → 판단 엔진에 신고해서 이 사건을 기억장에 추가 (다른 영상의 비슷한 글까지 잡게)
    if (act === "wasspoiler" && settings.mode !== "keyword") report(id);

    // 같은 종류의 다른 글들도 새 기준으로 다시 결정
    if (type)
      for (const [otherId, o] of state)
        if (otherId !== id && o.result?.type === type) decide(otherId);
  }

  // ---------------------------------------------------------------- 스포 기억장 패널
  // 판단 엔진이 짚어 준 사건을 회차별로 모아 보여줌. 아직 안 본 회차의 사건은 내용을 잠가 둠
  const memory = new Map(); // 사건 → { episode, ids }
  let memOpen = false;
  function remember(id, r) {
    const m = r.matched_event;
    if (m && m.text && m.p >= 0.5) rememberEvent(m, id);
    // 판단하다가 엔진이 기억장에 새 사건을 추가했으면 바로 보여줌
    if (r.memory_update?.added && r.memory_update.event) rememberEvent(r.memory_update.event, id, true);
  }

  function rememberEvent(ev, id, fresh = false) {
    let e = memory.get(ev.text);
    if (!e) memory.set(ev.text, (e = { episode: ev.episode, ids: new Set() }));
    if (id) e.ids.add(id);
    if (fresh) {
      e.freshUntil = Date.now() + 20_000;
      memOpen = true; // 새 사건이 들어오면 패널을 펼쳐서 보여줌
      setTimeout(refreshCounts, 20_500);
    }
  }

  function memoryView() {
    const items = [...memory.entries()].sort((a, b) => a[1].episode - b[1].episode);
    const locked = items.filter(([, e]) => e.episode > settings.watchedEpisode).length;
    const head = h(
      "button",
      { class: "bdk-mem", "data-act": "mem" },
      `🧠 스포 기억장 ${items.length}건${locked ? ` (🔒 ${locked})` : ""} ${memOpen ? "▴" : "▾"}`,
    );
    if (!memOpen) return [head];
    const list = h("ul", { class: "bdk-memlist" });
    if (!items.length) list.append(h("li", { class: "bdk-locked" }, "아직 찾은 사건이 없어요"));
    for (const [text, e] of items) {
      const isLocked = e.episode > settings.watchedEpisode;
      list.append(
        h(
          "li",
          { class: e.freshUntil > Date.now() ? "bdk-fresh" : isLocked ? "bdk-locked" : "" },
          `${e.freshUntil > Date.now() ? "🆕 " : ""}${e.episode}화 · ${isLocked ? "🔒 아직 안 본 사건" : text} (글 ${e.ids.size})`,
        ),
      );
    }
    return [head, list];
  }

  // ---------------------------------------------------------------- 커뮤니티 학습: 스포 신고 → 기억장
  function report(id) {
    const s = state.get(id);
    const payload = {
      show: settings.show,
      watched_episode: settings.watchedEpisode,
      comment: { id, text: s.text, posted_at: s.postedAt, context: s.context },
    };
    chrome.runtime.sendMessage({ type: "report", payload }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        console.warn("[쉿스포] 스포 신고 실패 (판단 엔진에 /report가 없을 수 있음):", res?.error);
        return;
      }
      const mu = res.data?.memory_update;
      if (!mu?.event) return toast("신고 고마워요. 이 글은 계속 가릴게요");
      rememberEvent(mu.event, id, !!mu.added);
      if (!mu.added) return toast(`이미 기억장에 있는 ${mu.event.episode}화 사건이에요`);
      toast(`🧠 기억장에 ${mu.event.episode}화 사건 추가 → 비슷한 글을 다시 살펴볼게요`);
      rejudgeAll(); // 새 사건으로 화면의 모든 글을 다시 판단 (돌려 말한 글까지)
    });
  }

  // ---------------------------------------------------------------- 상태 표시
  const hud = document.createElement("div");
  hud.className = "bdk-hud";
  document.documentElement.appendChild(hud);
  hud.addEventListener("click", (e) => {
    if (e.target?.dataset?.act !== "mem") return;
    memOpen = !memOpen;
    refreshCounts();
  });

  // 상태창은 여러 번 바뀌어도 화면 그릴 때 한 번만 다시 그림
  let hudFrame = 0;
  function refreshCounts() {
    if (hudFrame) return;
    hudFrame = requestAnimationFrame(() => {
      hudFrame = 0;
      drawHud();
    });
  }

  function drawHud() {
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
    if (settings.compare && settings.mode !== "keyword") {
      let miss = 0,
        over = 0;
      for (const s of state.values()) {
        const t = compareTag(s);
        if (t === "miss") miss++;
        else if (t === "over") over++;
      }
      hud.append(h("br"), h("span", { class: "bdk-cmpline" }, `⚖ 키워드 대비 · 스포 ${miss}개 더 잡음 · 수다 ${over}개 덜 가림`));
    }
    if (settings.mode !== "keyword") hud.append(h("br"), ...memoryView());
    if (down && settings.mode !== "keyword")
      hud.append(h("br"), h("span", { class: "bdk-warn" }, "⚠ 판단 엔진 연결 끊김 → 키워드로 대체 중"));
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
      s.reasked = false;
      s.round = (s.round || 0) + 1;
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
    const onlyLearning = Object.keys(changes).every((k) => LEARNING_KEYS.includes(k) || DISPLAY_KEYS.includes(k));
    if (changes.compare)
      for (const [id, s] of state) if (["hide", "blur", "show"].includes(s.status)) setStatus(id, s.status);
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
