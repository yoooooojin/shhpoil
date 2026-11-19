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
    guardVideo: true, // 지금 보는 영상 자체가 스포면 재생 전에 경고
    batchSize: 20, // 판단 엔진에 한 번에 보내는 글 수 (엔진이 느리면 줄이기)
    compare: false, // 키워드 방식이었다면 어땠을지 같이 표시 (비교 보기)
    logOn: false, // 실행 로그 기록 (팝업에서 켬)
    logText: false, // 실행 로그에 글 원문까지 남길지
    overrides: {}, // 사용자가 직접 판정한 댓글: { 댓글id: { decision: "show" | "hide", ep: 누른 때의 본 회차 } }
  };
  // 저장만 바뀌고 화면 전체를 다시 판단할 필요는 없는 설정
  const LEARNING_KEYS = ["typeOffsets", "overrides"];
  // 다시 판단할 필요 없이 화면 표시만 바뀌는 설정
  const DISPLAY_KEYS = ["compare", "batchSize", "timeoutSec", "feedbackLog", "stats", "hudPos", "onboarded", "logOn", "logText", "agentLog", "logScenario"];

  let settings = { ...DEFAULTS };
  const state = new Map(); // id → { el, text, postedAt, result, status }
  const queue = new Set();
  let flushTimer = null;
  let seq = 0;
  const stats = { judged: 0, hidden: 0, blurred: 0, reasoned: 0, lastMs: 0 };

  // ---------------------------------------------------------------- 실행 로그 (관찰 → 판단 → 라우팅 → 행동 → 학습 흐름을 시간순으로 남김)
  // 팝업에서 "실행 로그 기록"을 켰을 때만 남김. 글 원문은 "원문 포함"을 켰을 때만 (GitHub에 올릴 로그엔 빼기)
  let logBuf = [];
  let logTimer = null;
  function trace(stage, event, data = {}) {
    if (!settings.logOn) return;
    const e = { t: new Date().toISOString(), stage, event, ...data };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    logBuf.push(e);
    logTimer ||= setTimeout(() => {
      const entries = logBuf;
      logBuf = [];
      logTimer = null;
      chrome.runtime.sendMessage({ type: "log", entries })?.catch?.(() => {});
    }, 500);
  }
  const raw = (t) => (settings.logText ? t : undefined);
  const pct = (x) => (x == null ? null : Math.round(x * 100));

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

  // 흐린 댓글 본문을 직접 눌러도 열림 (영상 카드는 "보기" 버튼으로만)
  document.addEventListener(
    "click",
    (e) => {
      const item = e.target.closest?.(".bdk-item.bdk-hide:not(.bdk-revealed):not(.bdk-video), .bdk-item.bdk-blur:not(.bdk-revealed):not(.bdk-video)");
      if (!item || e.target.closest(".bdk-badge")) return;
      const target = item.classList.contains("bdk-has-target") ? item.querySelector(".bdk-target") : item;
      if (!target?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      onFeedback(item.dataset.bdkId, "reveal");
    },
    true,
  );

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
  // reason: 추론 모드, clues: { id: {parent, replies, description, timestamp} } (애매한 글 다시 물을 때)
  function judge(ids, reason, clues = {}) {
    const comments = ids.map((id) => {
      const s = state.get(id);
      const c = { id, text: s.text, posted_at: s.postedAt, context: s.context };
      if (clues[id]) c.clues = clues[id];
      else if (!reason) {
        // 이 글에서 더 모을 수 있는 단서 → 엔진(Zoro)이 이 안에서만 골라 요청
        const av = s.site.available?.(s.el, s.text, hasYtKey) || [];
        if (av.length) c.available_clues = av;
      }
      return c;
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

    const videos = ids.filter((id) => state.get(id).kind === "video").length;
    trace("관찰", "화면에 들어온 글 모음", {
      count: ids.length,
      comments: ids.length - videos,
      videos,
      watched: settings.watchedEpisode,
      mode: settings.mode,
      items: ids.map((id) => ({ id, kind: state.get(id).kind, posted_at: state.get(id).postedAt, exact_time: state.get(id).timeExact, text: raw(state.get(id).text) })),
    });
    if (settings.mode === "keyword") {
      ids.forEach((id) => applyKeyword(id));
    } else {
      ids.forEach((id) => (state.get(id).status = "judging"));
      await resolveTimes(ids);
      const res = await judge(ids, false);
      if (!res?.ok) {
        // 판단 엔진이 죽거나 느리면: 키워드 방식으로 대신 가리고, 엔진이 살아나면 다시 판단
        console.warn("[쉿스포] 판단 엔진 연결 실패 → 키워드 모드로 대체:", res?.error);
        trace("오류", "판단 엔진 응답 실패", { count: ids.length, error: String(res?.error || "응답 없음") });
        engineDown(true);
        ids.forEach((id) => applyKeyword(id, true));
      } else {
        engineDown(false);
        stats.lastMs = res.ms;
        trace("판단", "Zoro-1 판정 받음", {
          count: res.data.results.length,
          ms: res.ms,
          engine: res.data.engine || res.data.model,
          results: res.data.results.map((r) => ({
            id: r.id,
            type: r.type,
            p: pct(r.p_spoiler),
            event_episode: r.matched_event?.episode ?? null,
            event_p: pct(r.matched_event?.p),
            event_text: raw(r.matched_event?.text),
            written_after: r.written_after_episode,
          })),
        });
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

  // ---------------------------------------------------------------- 애매하면 단서 더 모으기
  // Zoro가 첫 판정에서 need_context(최대 2개)를 붙이면, 에이전트가 그 단서를 직접 모아서 추론 모드로 다시 물음
  const CLUE_NAMES = { parent: "원댓글", replies: "답글", description: "영상 설명", timestamp: "타임스탬프" };
  const clueLabel = (list) => (list || []).map((k) => CLUE_NAMES[k] || k).join("·");
  // 받침 따라 을/를
  const eulReul = (w) => {
    const c = (w || "").charCodeAt(w.length - 1) - 0xac00;
    return c >= 0 && c <= 11171 && c % 28 ? "을" : "를";
  };
  let hasYtKey = false;
  chrome.storage.local.get({ ytApiKey: "" }, (s) => (hasYtKey = !!s.ytApiKey));
  let clueBusy = 0;
  const clueWait = [];
  async function withClueSlot(fn) {
    // 추론 모드는 글 하나에 10~15초라 동시에 2개까지만
    if (clueBusy >= 2) await new Promise((r) => clueWait.push(r));
    clueBusy++;
    try {
      return await fn();
    } finally {
      clueBusy--;
      clueWait.shift()?.();
    }
  }
  async function gatherAndAsk(id, need) {
    const s = state.get(id);
    s.reasked = true;
    const round = s.round;
    await withClueSlot(async () => {
      if (s.round !== round) return;
      let clues = {};
      try {
        clues = (await Promise.race([s.site.clues(s.el, need, id, s.text), new Promise((r) => setTimeout(() => r({}), 6000))])) || {};
      } catch (e) {
        console.warn("[쉿스포] 단서 모으기 실패:", e);
      }
      if (s.round !== round) return;
      const got = Object.keys(clues);
      trace("관찰", got.length ? `단서 모음: ${clueLabel(got)}` : "요청한 단서를 못 구함 → 단서 없이 추론 모드로", {
        id, need, got, missing: need.filter((k) => !got.includes(k)),
        clues: settings.logText ? clues : undefined,
      });
      const res = await judge([id], true, got.length ? { [id]: clues } : {});
      if (s.round !== round) return;
      s.gathering = false;
      const r = res?.ok && res.data.results.find((x) => x.id === id);
      if (!r) {
        trace("오류", "단서 보고 다시 판정 실패 → 첫 판정으로 결정", { id, error: String(res?.error || "응답 없음") });
        return decide(id);
      }
      r.reasoned = true;
      s.usedClues = r.used_clues?.length ? r.used_clues : got;
      trace("판단", `Zoro-1이 ${clueLabel(s.usedClues) || "단서"}${eulReul(clueLabel(s.usedClues) || "단서")} 더 보고 다시 판정`, {
        id, ms: res.ms, used_clues: s.usedClues, type: r.type, p: pct(r.p_spoiler), before_p: pct(s.result?.p_spoiler),
        event_episode: r.matched_event?.episode ?? null, event_text: raw(r.matched_event?.text),
      });
      stats.reasoned++;
      s.result = r;
      remember(id, r);
      decide(id);
    });
  }

  // ---------------------------------------------------------------- 오류 대응: 엔진 끊김 → 키워드 대체 → 자동 복귀
  let down = false;
  let healthTimer = null;
  function engineDown(isDown) {
    if (down === isDown) return;
    down = isDown;
    clearInterval(healthTimer);
    if (isDown) {
      trace("오류", "엔진 끊김 → 키워드 방식으로 대체, 5초마다 엔진 확인");
      toast("판단 엔진 연결 끊김 → 키워드 모드로 대체 중");
      // 5초마다 엔진이 살아났는지 확인
      healthTimer = setInterval(() => {
        chrome.runtime.sendMessage({ type: "health" }, (res) => {
          if (chrome.runtime.lastError || !res?.ok || !down) return;
          engineDown(false);
          toast("판단 엔진 복구 → 다시 판정 모드로");
          // 키워드로 대신 처리했던 댓글만 다시 판단
          let n = 0;
          for (const [id, s] of state)
            if (s.fallback) {
              s.fallback = false;
              enqueue(id);
              n++;
            }
          trace("복구", "엔진 다시 응답 → 키워드로 대신했던 글 다시 판정", { count: n });
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
    if (override) {
      trace("행동", "사용자가 직접 정한 결정 유지", { id, status: override, decided_at_episode: settings.overrides[id]?.ep });
      return setStatus(id, override);
    }
    const r = s.result;
    const offset = settings.typeOffsets[r.type] || 0;
    const T = Math.min(0.95, Math.max(0.05, baseThreshold() + offset));
    const p = isAhead(r) ? r.p_spoiler : r.p_spoiler * 0.1; // 이미 본 내용이면 사실상 무해

    const approx = s.timeExact ? "" : " · 작성 시각 추정";
    const looked = s.usedClues?.length ? ` · 🔍 ${clueLabel(s.usedClues)}${eulReul(clueLabel(s.usedClues))} 더 보고 다시 판단` : "";
    s.whyFull = buildWhy(r, T, false) + approx + looked;
    s.whySafe = buildWhy(r, T, true) + approx + looked; // 가린 댓글은 사건 내용을 숨김 (이유 표시가 스포가 되지 않게)
    s.short = shortWhy(r);
    if (s.usedClues?.length && s.short) s.short = `🔍 ${s.short}`;

    // 다시 묻기는 댓글당 한 번만 (서버가 reasoned를 안 넣어 줘도 무한 반복하지 않게)
    const ahead = isAhead(r);
    const base = { id, kind: s.kind, type: r.type, p: pct(r.p_spoiler), p_used: pct(p), threshold: pct(T), episode: episodeOf(r), watched: settings.watchedEpisode, ahead, reasoned: !!r.reasoned };
    // Zoro가 "이걸 더 보면 알겠다"고 고른 단서가 있으면: 일단 흐리고, 단서를 모아서 다시 묻기
    const need = (Array.isArray(r.need_context) ? r.need_context : []).filter((k) => CLUE_NAMES[k]).slice(0, 2);
    if (need.length && !r.reasoned && !s.reasked && ahead && s.site.clues) {
      trace("라우팅", `Zoro가 단서 요청: ${clueLabel(need)} → 일단 흐리고 모아서 다시 묻기`, { ...base, need });
      s.gathering = true;
      setStatus(id, "blur");
      gatherAndAsk(id, need);
      return;
    }
    if (Math.abs(p - T) < 0.1 && !r.reasoned && !s.reasked && ahead) {
      // 애매함 → 일단 흐려 두고 추론 모드로 다시 묻기
      trace("라우팅", "기준과 10%p 안쪽이라 애매함 → 일단 흐리고 추론 모드로 다시 묻기", base);
      setStatus(id, "blur");
      reask(id);
      return;
    }
    const status = p >= T + 0.15 ? "hide" : p >= T ? "blur" : "show";
    const label = { hide: "가림", blur: "흐리게 (스포 의심)", show: "그대로 보임" }[status];
    trace("행동", label, { ...base, why: ahead ? (status === "show" ? "기준보다 낮음" : "본 회차 뒤 내용") : "이미 본 회차 내용 (확률 ×0.1)" });
    setStatus(id, status);
  }

  async function reask(id) {
    const s = state.get(id);
    s.reasked = true;
    const round = s.round; // 기다리는 동안 설정이 바뀌어 다시 판단이 시작됐으면 이 응답은 버림
    const res = await judge([id], true);
    if (s.round !== round) return;
    const r = res?.ok && res.data.results.find((x) => x.id === id);
    if (!r) {
      trace("오류", "추론 모드 응답 실패 → 첫 판정으로 결정", { id });
      return decide(id); // 실패하면 첫 판단 결과로 결정 (흐린 채로 멈추지 않게)
    }
    trace("판단", "Zoro-1 추론 모드 판정 받음", { id, ms: res.ms, type: r.type, p: pct(r.p_spoiler), before_p: pct(s.result?.p_spoiler), event_episode: r.matched_event?.episode ?? null, event_text: raw(r.matched_event?.text) });
    stats.reasoned++;
    s.result = r;
    remember(id, r);
    decide(id);
  }

  // 키워드 방식(비교 기준): 팝업의 차단 키워드 중 하나라도 들어 있으면 가림
  function keywordHit(text, excludeShow = false) {
    return settings.keywords
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean)
      .filter((w) => !excludeShow || !settings.show.includes(w))
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
    trace("행동", `${fallback ? "키워드 대체" : "키워드 모드"} → ${hit ? "가림" : "그대로 보임"}`, { id, kind: s.kind, keyword: hit || null });
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
    if (!isAhead(r)) return ep ? `이미 본 ${ep}화 내용이라 그대로 뒀어요` : "";
    return [ep != null ? `${ep}화 내용` : "", `${r.type} ${Math.round(r.p_spoiler * 100)}%`, r.reasoned ? "다시 생각함" : ""]
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
    const hidden = status === "hide" || status === "blur";
    const b = h("div", { class: `bdk-badge bdk-b-${status}${s.revealed ? " bdk-b-open" : ""}${s.moreOpen ? " bdk-b-more-open" : ""}` });
    b.dataset.for = id;
    // 유튜브는 Trusted Types 보안 정책 때문에 innerHTML을 막아서, 요소를 하나씩 만들어 붙임
    const video = s.kind === "video";
    if (hidden) {
      // 흐림 자체가 "가렸다"는 신호라 설명 문구 없이: 🤫 + 몇 화 내용인지만 (자세한 건 "왜?")
      const head = h("div", { class: "bdk-head" });
      head.append(h("span", { class: "bdk-icon", title: status === "hide" ? "스포라서 가렸어요" : "스포일 수 있어서 흐려 뒀어요" }, "🤫"));
      const ep = s.gathering ? `🔍 ${clueLabel(s.result?.need_context?.slice(0, 2))} 더 보는 중…` : (s.short || "").split(" · ")[0];
      if (ep && (!s.revealed || s.gathering)) head.append(h("span", { class: "bdk-reason" }, ep));
      b.append(head);
    } else {
      // 터치 화면용: 보이는 글엔 흐린 🤫 버튼만, 눌러야 버튼이 열림 (휴대폰엔 마우스 올리기가 없어서)
      if (status === "show") b.append(h("button", { class: "bdk-more", "data-act": "more", "aria-label": "쉿스포 메뉴" }, "🤫"));
      if (s.short) b.append(h("span", { class: "bdk-reason" }, s.short));
    }
    const acts = h("div", { class: "bdk-acts" });
    if (hidden) {
      acts.append(
        s.revealed ? h("button", { "data-act": "rehide" }, "다시 가리기") : h("button", { "data-act": "reveal", class: "bdk-primary" }, "보기"),
        h("button", { "data-act": "notspoiler" }, "스포 아님"),
      );
    } else if (status === "show") {
      acts.append(h("button", { "data-act": "wasspoiler" }, "스포였어요"));
    }
    const open = status === "show" || status === "error" || s.revealed;
    const why = (open ? s.whyFull : s.whySafe) || "";
    if (why) acts.append(h("button", { "data-act": "why" }, s.whyOpen ? "이유 닫기" : "왜?"));
    const cmp = compareTag(s);
    if (cmp) acts.append(h("span", { class: `bdk-cmp bdk-cmp-${cmp}` }, cmp === "miss" ? "키워드였다면 놓침" : "키워드였다면 괜히 가림"));
    b.append(acts);
    // "왜?"를 누르면 판단 이유를 펼침 (가린 글은 사건 내용 없이)
    if (s.whyOpen && why) b.append(h("div", { class: "bdk-detail" }, why));
    b.addEventListener("click", (e) => {
      const act = e.target?.closest?.("[data-act]")?.dataset?.act;
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
    if (act === "more") {
      s.moreOpen = !s.moreOpen;
      setStatus(id, s.status);
      return;
    }
    if (act === "why") {
      s.whyOpen = !s.whyOpen;
      setStatus(id, s.status);
      return;
    }
    if (act === "reveal" || act === "rehide") {
      trace("행동", act === "reveal" ? "사용자가 가린 글을 열어 봄" : "사용자가 다시 가림", { id, kind: s.kind });
      s.revealed = act === "reveal";
      setStatus(id, s.status); // 열림/닫힘 상태로 다시 그림 (열리면 이유에 사건 내용도 표시)
      return;
    }
    // 사용자의 직접 결정은 이 댓글에 고정하고 저장 (회차 변경·새로고침에도 유지)
    const decision = act === "notspoiler" ? "show" : "hide";
    logFeedback(s, act); // 판단 엔진 개선용 기록 (팝업에서 CSV로 내려받기)
    // 아직 안 본 회차 내용을 "스포 아님"이라고 했다면 → 그 회차까지 본 건 아닐까? 먼저 물어봄
    if (act === "notspoiler" && s.result && isAhead(s.result))
      suggestEpisode(episodeOf(s.result), `${episodeOf(s.result)}화 내용을 "스포 아님"으로 하셨네요`);
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
      trace("학습", `사용자: ${act === "notspoiler" ? "스포 아님" : "스포였어요"} → "${type}" 기준 ${act === "notspoiler" ? "느슨하게" : "엄격하게"}`, {
        id, kind: s.kind, was: s.status, type, offset_before: pct(cur), offset_after: pct(settings.typeOffsets[type]),
        fixed: { decision, ep: settings.watchedEpisode }, text: raw(s.text),
      });
      toast(
        `"${type}" 기준을 ${act === "notspoiler" ? "느슨하게" : "엄격하게"} 조정했어요 (${settings.typeOffsets[type] > 0 ? "+" : ""}${Math.round(settings.typeOffsets[type] * 100)}%p)`,
      );
    } else {
      trace("학습", `사용자: ${act === "notspoiler" ? "스포 아님" : "스포였어요"} → 이 글에 결정 고정`, { id, kind: s.kind, fixed: { decision, ep: settings.watchedEpisode } });
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
    if (type) {
      const others = [...state].filter(([otherId, o]) => otherId !== id && o.result?.type === type);
      if (others.length) trace("학습", `같은 종류("${type}") 글 ${others.length}개를 새 기준으로 다시 결정`, { count: others.length });
      for (const [otherId] of others) decide(otherId);
    }
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
      memOpen = hudOpen = true; // 새 사건이 들어오면 상태창과 패널을 펼쳐서 보여줌
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

  // ---------------------------------------------------------------- 지금 보는 영상 경고
  // 3화까지 봤는데 "최종회 결승 리뷰"를 열면, 영상 자체가 스포 → 플레이어를 덮고 일시정지한 뒤 계속 볼지 물어봄
  const guard = { vid: null, urlVid: null, overlay: null, title: null, dismissed: new Set() };
  const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);

  function urlVideoId() {
    if (isYouTube) {
      const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (m) return m[1];
      return location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
    }
    return document.querySelector("[data-bdk-title]")?.dataset.vid || null; // 시연 페이지
  }

  function currentVideo() {
    const vid = urlVideoId();
    if (!vid) return null;
    if (isYouTube) {
      const shorts = location.pathname.startsWith("/shorts/");
      // 막 열었을 땐 탭 제목이 그냥 "YouTube"라서, " - YouTube"가 붙은 진짜 제목일 때만 씀
      const tabTitle = / - YouTube\s*$/.test(document.title)
        ? document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube\s*$/, "").trim()
        : "";
      const titleEl = shorts ? null : document.querySelector("ytd-watch-metadata h1");
      return {
        vid,
        title: (titleEl?.textContent || tabTitle).trim(),
        titleEl,
        player: shorts
          ? document.querySelector("ytd-reel-video-renderer[is-active] #player-container, ytd-reel-video-renderer[is-active], #shorts-player")
          : document.querySelector("#movie_player, ytd-player"),
        posted: window.BDK_parseRelative(document.querySelector("ytd-watch-metadata #info, #info-container")?.textContent || ""),
        channel: (document.querySelector("ytd-watch-metadata #channel-name, #owner #channel-name")?.textContent || "").trim(),
      };
    }
    const h1 = document.querySelector("[data-bdk-title]");
    return { vid, title: h1.textContent.trim(), titleEl: h1, player: document.querySelector(".player"), posted: h1.dataset.published, exact: true, channel: "" };
  }

  // 유튜브는 페이지를 새로 불러오지 않고 영상만 바꿔서, 주소의 영상 번호가 바뀌는지 지켜봄
  setInterval(() => {
    const v = urlVideoId();
    if (v === guard.urlVid) return;
    guard.urlVid = v;
    checkCurrentVideo(true);
  }, 700);

  async function checkCurrentVideo(force = false) {
    if (!settings.enabled || !settings.guardVideo) return hideGuard();
    const prevTitle = guard.title;
    let cur = currentVideo();
    if (!cur) {
      guard.vid = null;
      return hideGuard();
    }
    if (!force && cur.vid === guard.vid) return;
    hideGuard();
    guard.status = "지금 영상 확인 중…";
    refreshCounts();
    if (guard.passed && !guard.dismissed.has(`${cur.vid}@${settings.watchedEpisode}`)) guard.passed = null;
    guard.vid = cur.vid;
    // 페이지를 막 열었거나 영상이 바뀐 직후엔 제목이 없거나 이전 영상 것이라, 바뀔 때까지 기다림 (최대 10초)
    for (let i = 0; i < 50 && cur && (!cur.title || cur.title === prevTitle) && cur.vid !== guard.titleVid; i++) {
      await new Promise((r) => setTimeout(r, 200));
      cur = currentVideo();
    }
    if (!cur || cur.vid !== guard.vid || !cur.title) {
      guard.status = "지금 영상 제목을 못 읽었어요";
      return refreshCounts();
    }
    guard.title = cur.title;
    guard.titleVid = cur.vid;
    if (guard.dismissed.has(`${cur.vid}@${settings.watchedEpisode}`)) {
      guard.status = null;
      return refreshCounts();
    }

    let posted = cur.posted;
    if (!cur.exact) {
      const yt = sites.find((s) => s.name === "youtube-videos");
      const times = (await yt?.resolveTimes?.([`v:${cur.vid}`]).catch(() => null)) || {};
      posted = times[`v:${cur.vid}`] || posted;
    }

    let verdict = null;
    const kw = (fallback) => {
      const hit = keywordHit(cur.title, fallback);
      return hit ? { ep: null, why: `${fallback ? "판단 엔진 연결 끊김 → 키워드로 대체 · " : ""}키워드 "${hit}" 포함` } : null;
    };
    if (settings.mode === "keyword") {
      verdict = kw(false);
      guard.status = `지금 영상: 키워드 모드 → ${verdict ? "경고" : "문제 없음"}`;
    }
    else {
      const res = await new Promise((resolve) =>
        chrome.runtime.sendMessage(
          {
            type: "judge",
            payload: {
              show: settings.show,
              watched_episode: settings.watchedEpisode,
              comments: [{ id: `cur:${cur.vid}`, text: cur.title, posted_at: posted || null, context: `[지금 보는 영상 제목] ${cur.channel}` }],
            },
          },
          resolve,
        ),
      );
      const r = res?.ok && res.data.results?.[0];
      if (!r) {
        verdict = kw(true);
        guard.status = `지금 영상: 판단 엔진 응답 없음 → 키워드로 ${verdict ? "스포" : "문제 없음"}`;
      } else {
        const T = Math.min(0.95, Math.max(0.05, baseThreshold() + (settings.typeOffsets[r.type] || 0)));
        const ep = episodeOf(r);
        if (isAhead(r) && r.p_spoiler >= T) verdict = { ep, why: buildWhy(r, T, true) };
        guard.status = `지금 영상: ${r.type} ${Math.round(r.p_spoiler * 100)}% (기준 ${Math.round(T * 100)}%)${ep != null ? ` · ${ep}화` : ""} → ${verdict ? "경고" : isAhead(r) ? "기준 아래라 그대로" : "이미 본 내용"}`;
      }
      console.log("[쉿스포]", guard.status, "| 제목:", cur.title, "| 업로드:", posted);
    }
    trace(verdict ? "행동" : "판단", verdict ? "지금 보는 영상이 안 본 회차 → 일시정지하고 경고" : "지금 보는 영상 확인 → 그대로 재생", {
      id: `cur:${cur.vid}`, kind: "current-video", result: guard.status, title: raw(cur.title),
    });
    if (guard.vid !== cur.vid) return; // 기다리는 사이 다른 영상으로 넘어감
    refreshCounts();
    if (verdict) showGuard(cur, verdict);
  }

  function pauseAll() {
    document.querySelectorAll("video").forEach((v) => v.pause());
  }
  // 경고가 떠 있는 동안 자동 재생되면 바로 멈춤
  document.addEventListener("play", (e) => guard.overlay && e.target.pause?.(), true);

  // ---------------------------------------------------------------- 미리보기 재생 막기
  // 유튜브는 카드에 마우스를 올려 두면 카드 바깥의 #video-preview 상자에 따로 플레이어를 띄워 재생함
  // → 재생되려는 순간 그 상자의 영상 링크를 보고, 쉿스포가 가린 영상이면 멈추고 상자를 숨김
  const PREVIEW = "#video-preview, ytd-video-preview";
  function previewBlocked(video) {
    const host = video.closest?.("#video-preview") || video.closest?.("ytd-video-preview");
    if (!host) return false;
    const href = host.querySelector("a[href*='watch?v='], a[href*='/shorts/']")?.getAttribute("href") || "";
    const m = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
    const s = m && state.get(`v:${m[1]}`);
    const blocked = !!s && settings.enabled && (s.status === "hide" || s.status === "blur") && !s.revealed;
    host.classList.toggle("bdk-preview-blocked", blocked);
    if (blocked && host.dataset.bdkLogged !== m[1]) {
      host.dataset.bdkLogged = m[1];
      trace("행동", "가린 영상의 미리보기 재생 막음", { id: `v:${m[1]}` });
    } else if (!blocked) delete host.dataset.bdkLogged;
    return blocked;
  }
  for (const type of ["play", "playing", "timeupdate"])
    document.addEventListener(
      type,
      (e) => {
        const v = e.target;
        if (v?.tagName !== "VIDEO" || !v.closest?.(PREVIEW)) return;
        if (previewBlocked(v)) {
          v.muted = true;
          v.pause();
        }
      },
      true,
    );

  function showGuard(cur, verdict) {
    hideGuard();
    pauseAll();
    const box = h("div", { class: "bdk-guard" });
    const card = h("div", { class: "bdk-guard-card" });
    card.append(
      h("div", { class: "bdk-guard-title" }, "🤫 잠깐, 이 영상은 스포일 수 있어요"),
      h(
        "div",
        { class: "bdk-guard-sub" },
        `${verdict.ep ? `${verdict.ep}화 내용을 다루는 것 같아요` : "아직 안 본 내용이 담겨 있을 수 있어요"} · 지금 ${settings.watchedEpisode}화까지 봄`,
      ),
      h("div", { class: "bdk-guard-why" }, verdict.why),
    );
    const btns = h("div", { class: "bdk-guard-btns" });
    btns.append(h("button", { "data-act": "back" }, "뒤로 가기"), h("button", { "data-act": "watch", class: "bdk-guard-go" }, "그래도 볼래요"));
    card.append(btns);
    box.append(card);
    box.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      trace("행동", act === "back" ? "사용자: 영상 경고에서 뒤로 가기" : "사용자: 영상 경고에서 그래도 볼래요", { id: `cur:${cur.vid}` });
      if (act === "back") history.back();
      else {
        guard.dismissed.add(`${cur.vid}@${settings.watchedEpisode}`);
        guard.passed = cur.vid; // 상태창에 "다시 가리기" 표시
        hideGuard();
        refreshCounts();
      }
    });
    const host = cur.player && cur.player.isConnected ? cur.player : null;
    if (host) {
      host.classList.add("bdk-guard-host");
      host.append(box);
    } else {
      box.classList.add("bdk-guard-fixed");
      document.documentElement.append(box);
    }
    cur.titleEl?.classList.add("bdk-guard-blur");
    guard.overlay = box;
    guard.titleEl = cur.titleEl;
    toast("지금 보는 영상이 스포일 수 있어서 멈춰 뒀어요");
  }

  function hideGuard() {
    guard.overlay?.remove();
    guard.overlay = null;
    guard.titleEl?.classList.remove("bdk-guard-blur");
    guard.titleEl = null;
  }

  // ---------------------------------------------------------------- 새 회차 공개 알림 (방영 중인 작품)
  // 최근 2주 안에 새 회차가 공개됐는데 아직 그 전 회차로 설정돼 있으면 "보셨나요?"라고 먼저 물어봄
  const SCHEDULES = {
    흑백요리사2: [
      ["2025-12-16T17:00:00+09:00", 3],
      ["2025-12-23T17:00:00+09:00", 7],
      ["2025-12-30T17:00:00+09:00", 10],
      ["2026-01-06T17:00:00+09:00", 12],
      ["2026-01-13T17:00:00+09:00", 13],
    ],
  };
  function checkNewEpisode() {
    const drops = SCHEDULES[settings.show] || [];
    const now = Date.now();
    const recent = drops.filter(([t]) => now >= Date.parse(t) && now - Date.parse(t) < 14 * 864e5).pop();
    if (recent && recent[1] > settings.watchedEpisode) {
      const d = new Date(recent[0]);
      suggestEpisode(recent[1], `${d.getMonth() + 1}/${d.getDate()}에 ${recent[1]}화까지 공개됐어요`);
    }
  }

  // ---------------------------------------------------------------- 피드백 기록 (잘못 판단한 글 모으기)
  // 사용자가 "스포 아님 / 스포였음"을 누른 글과 그때 Zoro의 판단을 남김 → 팝업에서 CSV로 받아 판단 엔진 개선에 씀
  async function logFeedback(s, act) {
    const r = s.result || {};
    const rec = {
      at: new Date().toISOString(),
      user: act === "notspoiler" ? "스포 아님" : "스포였음",
      shown_as: { hide: "가림", blur: "의심", show: "보임" }[s.status] || s.status,
      watched_episode: settings.watchedEpisode,
      show: settings.show,
      kind: s.kind === "video" ? "영상 제목" : "댓글",
      id: s.el?.dataset?.bdkId || "",
      text: s.text,
      context: s.context || "",
      posted_at: s.postedAt || "",
      zoro_type: r.type || (s.fallback ? "(키워드 대체)" : ""),
      p_spoiler: r.p_spoiler ?? "",
      written_after_episode: r.written_after_episode ?? "",
      matched_event: r.matched_event?.text || "",
      matched_episode: r.matched_event?.episode ?? "",
      reasoned: r.reasoned ? "Y" : "",
      page: location.href,
    };
    try {
      const { feedbackLog = [] } = await chrome.storage.local.get("feedbackLog");
      feedbackLog.push(rec);
      await chrome.storage.local.set({ feedbackLog: feedbackLog.slice(-1000) });
    } catch (e) {
      console.warn("[쉿스포] 피드백 기록 실패:", e);
    }
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
        trace("오류", "스포 신고 실패 (글은 계속 가림)", { id, error: String(res?.error || "응답 없음") });
        return;
      }
      const mu = res.data?.memory_update;
      trace("학습", mu?.added ? "스포 기억장에 새 사건 추가 → 화면 전체 다시 판정" : mu?.event ? "이미 기억장에 있는 사건" : "신고 접수 (새 사건 없음)", {
        id, added: !!mu?.added, event_id: mu?.event?.id, event_episode: mu?.event?.episode ?? null, event_text: raw(mu?.event?.text),
      });
      if (!mu?.event) return toast("신고 고마워요. 이 글은 계속 가릴게요");
      rememberEvent(mu.event, id, !!mu.added);
      if (!mu.added) return toast(`이미 기억장에 있는 ${mu.event.episode}화 사건이에요`);
      toast(`🧠 기억장에 ${mu.event.episode}화 사건 추가 → 비슷한 글을 다시 살펴볼게요`);
      rejudgeAll(); // 새 사건으로 화면의 모든 글을 다시 판단 (돌려 말한 글까지)
    });
  }

  // ---------------------------------------------------------------- 상태 표시
  // 평소엔 작은 알약(🤫 3)으로 접혀 있다가 누르면 펼쳐짐. 끌어서 옮길 수 있고 위치는 기억함
  const hud = document.createElement("div");
  hud.className = "bdk-hud";
  document.documentElement.appendChild(hud);
  let hudOpen = false;
  let nudge = null; // 에이전트가 먼저 묻는 말 { ep, why }
  const nudgeSkipped = new Set();

  hud.addEventListener("click", (e) => {
    if (drag.moved) return; // 끌어서 옮긴 건 클릭으로 안 침
    const act = e.target?.closest?.("[data-act]")?.dataset?.act;
    if (act === "mem") memOpen = !memOpen;
    else if (act === "open") hudOpen = true;
    else if (act === "close") hudOpen = false;
    else if (act === "plus1") setWatched(settings.watchedEpisode + 1, "+1화");
    else if (act === "reguard") {
      for (const k of [...guard.dismissed]) if (k.startsWith(`${guard.passed}@`)) guard.dismissed.delete(k);
      guard.passed = null;
      checkCurrentVideo(true);
    }
    else if (act === "nudge-yes" && nudge) setWatched(nudge.ep, "제안 수락");
    else if (act === "nudge-no" && nudge) {
      nudgeSkipped.add(nudge.ep);
      nudge = null;
    } else return;
    e.stopPropagation();
    refreshCounts();
  });

  function setWatched(ep, why) {
    ep = Math.max(0, Math.min(99, ep));
    if (nudge && ep >= nudge.ep) nudge = null;
    chrome.storage.local.set({ watchedEpisode: ep });
    toast(`${ep}화까지 본 걸로 바꿨어요 (${why})`);
  }

  // 끌어서 옮기기
  const drag = { on: false, moved: false, sx: 0, sy: 0, x: 0, y: 0 };
  hud.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button:not(.bdk-pill)")) return;
    const r = hud.getBoundingClientRect();
    Object.assign(drag, { on: true, moved: false, sx: e.clientX, sy: e.clientY, x: r.left, y: r.top });
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag.on) return;
    const dx = e.clientX - drag.sx,
      dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    placeHud(drag.x + dx, drag.y + dy);
  });
  window.addEventListener("pointerup", () => {
    if (!drag.on) return;
    drag.on = false;
    if (drag.moved) {
      const r = hud.getBoundingClientRect();
      chrome.storage.local.set({ hudPos: { x: r.left, y: r.top } });
      setTimeout(() => (drag.moved = false), 0); // 바로 뒤 click은 무시
    }
  });
  function placeHud(x, y) {
    const w = hud.offsetWidth,
      hh = hud.offsetHeight;
    hud.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, x))}px`;
    hud.style.top = `${Math.max(4, Math.min(innerHeight - hh - 4, y))}px`;
    hud.style.right = hud.style.bottom = "auto";
  }
  chrome.storage.local.get("hudPos", ({ hudPos }) => hudPos && requestAnimationFrame(() => placeHud(hudPos.x, hudPos.y)));

  // 에이전트가 먼저 묻기: "N화까지 보셨나요?"
  function suggestEpisode(ep, why) {
    if (!ep || ep <= settings.watchedEpisode || nudgeSkipped.has(ep)) return;
    nudge = { ep, why };
    hudOpen = true;
    refreshCounts();
  }

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
    chrome.runtime.sendMessage({ type: "badge", count: settings.enabled ? hidden + blurred : 0 }).catch?.(() => {});
    hud.classList.toggle("bdk-hud-open", hudOpen);
    hud.classList.toggle("bdk-hud-warn", down && settings.mode !== "keyword");

    if (!hudOpen) {
      // 접힌 상태: 🤫 + 가린 개수 (+ 경고)
      hud.replaceChildren(
        h(
          "button",
          { class: "bdk-pill", "data-act": "open", title: "쉿스포 펼치기" },
          !settings.enabled ? "🤫 꺼짐" : `🤫 ${hidden + blurred}${down && settings.mode !== "keyword" ? " ⚠" : ""}${nudge ? " · ?" : ""}`,
        ),
      );
      return;
    }

    const head = h("div", { class: "bdk-hud-head" });
    head.append(
      h("b", {}, "🤫 쉿스포"),
      h("span", { class: "bdk-hud-ep" }, settings.enabled ? `${settings.watchedEpisode}화까지 봄` : "꺼짐"),
      h("button", { "data-act": "plus1", title: "한 화 더 봤어요" }, "＋1화"),
      h("button", { "data-act": "close", title: "접기" }, "—"),
    );
    hud.replaceChildren(head);
    if (!settings.enabled) return;

    if (nudge) {
      const box = h("div", { class: "bdk-nudge" });
      box.append(
        h("div", {}, `${nudge.why}. 혹시 ${nudge.ep}화까지 보셨나요?`),
        h("button", { "data-act": "nudge-yes" }, `${nudge.ep}화로 바꾸기`),
        h("button", { "data-act": "nudge-no" }, "아니요"),
      );
      hud.append(box);
    }

    if (settings.guardVideo && guard.status && urlVideoId()) hud.append(h("div", { class: "bdk-hud-line bdk-hud-sub" }, `🎬 ${guard.status}`));
    if (guard.passed && guard.passed === urlVideoId() && !guard.overlay) {
      const line = h("div", { class: "bdk-hud-line" }, "지금 영상은 스포 경고를 넘기고 보는 중 ");
      line.append(h("button", { "data-act": "reguard" }, "다시 가리기"));
      hud.append(line);
    }
    hud.append(
      h(
        "div",
        { class: "bdk-hud-line" },
        `${settings.mode === "keyword" ? "키워드 모드" : "판정 모드"} · 가림 ${hidden} · 의심 ${blurred} · 추론 ${stats.reasoned}${stats.lastMs ? ` · ${stats.lastMs}ms` : ""}`,
      ),
    );
    if (settings.compare && settings.mode !== "keyword") {
      let miss = 0,
        over = 0;
      for (const s of state.values()) {
        const t = compareTag(s);
        if (t === "miss") miss++;
        else if (t === "over") over++;
      }
      hud.append(h("div", { class: "bdk-cmpline" }, `⚖ 키워드 대비 · 스포 ${miss}개 더 잡음 · 수다 ${over}개 덜 가림`));
    }
    if (settings.mode !== "keyword") {
      const mv = h("div");
      mv.append(...memoryView());
      hud.append(mv);
    }
    if (down && settings.mode !== "keyword")
      hud.append(h("div", { class: "bdk-warn" }, "⚠ 판단 엔진 연결 끊김 → 키워드로 대체 중"));
    hud.append(h("div", { class: "bdk-hud-ver" }, `v${VERSION} · ${settings.logOn ? "● 실행 로그 기록 중" : "끌어서 옮길 수 있어요"}`));
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
      s.gathering = false;
      s.usedClues = null;
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
    if (changes.ytApiKey) hasYtKey = !!changes.ytApiKey.newValue;
    const onlyLearning = Object.keys(changes).every((k) => LEARNING_KEYS.includes(k) || DISPLAY_KEYS.includes(k));
    if (changes.compare)
      for (const [id, s] of state) if (["hide", "blur", "show"].includes(s.status)) setStatus(id, s.status);
    // 팝업의 "학습 초기화" → 직접 누른 결정이 비워짐
    const learningReset =
      changes.overrides && !Object.keys(changes.overrides.newValue || {}).length;
    // "보기"는 한 번 엿본 것 → 회차나 작품이 바뀌면 다시 닫고 새 기준으로 판단
    // ("스포 아님 / 스포였음"으로 직접 판정한 건 누른 회차 기준으로 따로 유지됨)
    if (learningReset || changes.watchedEpisode || changes.show)
      for (const s of state.values()) s.revealed = false;
    if (!onlyLearning || learningReset) {
      const changed = Object.fromEntries(
        Object.entries(changes)
          .filter(([k]) => !DISPLAY_KEYS.includes(k) && k !== "ytApiKey")
          .map(([k, v]) => [k, { from: v.oldValue, to: v.newValue }]),
      );
      if (changes.overrides) changed.overrides = "초기화";
      trace("관찰", "설정 바뀜 → 화면의 글 전체 다시 판정", { changed, count: state.size });
      rejudgeAll();
    }
    if (changes.watchedEpisode && nudge && settings.watchedEpisode >= nudge.ep) nudge = null;
    if (changes.watchedEpisode || changes.show || changes.enabled || changes.logOn) refreshCounts();
    if (changes.watchedEpisode || changes.show || changes.mode || changes.sensitivity || changes.enabled || changes.guardVideo)
      checkCurrentVideo(true);
  });

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    scan();
    refreshCounts();
    guard.urlVid = urlVideoId();
    checkCurrentVideo(true);
    checkNewEpisode();
  });
})();
