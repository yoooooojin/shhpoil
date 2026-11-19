const DEFAULTS = {
  enabled: true,
  mode: "zoro",
  show: "흑백요리사2",
  watchedEpisode: 3,
  sensitivity: 0.5,
  keywords: "흑백요리사,최강록,우승,탈락",
  serverUrl: "http://localhost:8787",
  ytApiKey: "",
  typeOffsets: {},
  overrides: {},
  compare: false,
  guardVideo: true,
  batchSize: 20,
  timeoutSec: 10,
  logOn: false,
  logText: false,
  logScenario: "",
};

const $ = (id) => document.getElementById(id);

// 작품 목록: 엔진(GET /shows)에 등록된 작품을 작품 칸 자동완성에 넣음
function renderShows(shows) {
  const names = Object.keys(shows || {});
  if (!names.length) return;
  const list = document.getElementById("shows");
  list.replaceChildren(...names.map((n) => Object.assign(document.createElement("option"), { value: n })));
}
chrome.storage.local.get({ shows: {} }, (s) => renderShows(s.shows));
chrome.runtime.sendMessage({ type: "shows" }, (res) => res?.ok && renderShows(res.shows));
const save = (obj) => chrome.storage.local.set(obj);
$("ver").textContent = `v${chrome.runtime.getManifest().version}`;

// ---------------------------------------------------------------- 그리기
function renderMode(mode) {
  document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("kwBox").style.display = mode === "keyword" ? "block" : "none";
}

// 민감도 3단계: 가장 가까운 버튼에 불
function renderPreset(v) {
  const btns = [...document.querySelectorAll(".presets button")];
  const near = btns.reduce((a, b) => (Math.abs(b.dataset.s - v) < Math.abs(a.dataset.s - v) ? b : a));
  btns.forEach((b) => b.classList.toggle("on", b === near));
}

function renderOffsets(offsets, overrides) {
  const entries = Object.entries(offsets || {}).filter(([, v]) => v);
  const parts = entries.map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${Math.round(v * 100)}%p`);
  const n = Object.keys(overrides || {}).length;
  if (n) parts.push(`직접 판정한 글 ${n}개`);
  $("offsets").textContent = parts.length ? parts.join(" · ") : "아직 없음";
}

async function checkHealth(url) {
  $("health").textContent = "연결 확인 중...";
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`);
    const data = await res.json();
    $("health").textContent = `연결됨 (${data.engine || "엔진"})`;
  } catch {
    $("health").textContent = "연결 안 됨 — 서버가 켜져 있는지 확인하세요";
  }
}

chrome.storage.local.get(DEFAULTS, (s) => {
  $("enabled").checked = s.enabled;
  $("show").value = s.show;
  $("watchedEpisode").value = s.watchedEpisode;
  $("sensitivity").value = s.sensitivity;
  $("keywords").value = s.keywords;
  $("serverUrl").value = s.serverUrl;
  $("ytApiKey").value = s.ytApiKey;
  $("compare").checked = s.compare;
  $("guardVideo").checked = s.guardVideo;
  $("logOn").checked = s.logOn;
  $("logText").checked = s.logText;
  $("logScenario").value = s.logScenario || "";
  if (s.logOn) $("logBox").open = true;
  $("batchSize").value = s.batchSize;
  $("timeoutSec").value = s.timeoutSec;
  renderMode(s.mode);
  renderPreset(s.sensitivity);
  renderOffsets(s.typeOffsets, s.overrides);
  checkHealth(s.serverUrl);
});

// ---------------------------------------------------------------- 기본
$("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
$("show").addEventListener("change", (e) => save({ show: e.target.value.trim() }));

const setEp = (n) => {
  n = Math.max(0, Math.min(99, Number(n) || 0));
  $("watchedEpisode").value = n;
  save({ watchedEpisode: n });
};
$("watchedEpisode").addEventListener("change", (e) => setEp(e.target.value));
$("epMinus").addEventListener("click", () => setEp(Number($("watchedEpisode").value) - 1));
$("epPlus").addEventListener("click", () => setEp(Number($("watchedEpisode").value) + 1));

document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => {
    const v = Number(b.dataset.s);
    $("sensitivity").value = v;
    renderPreset(v);
    save({ sensitivity: v });
  })
);
$("guardVideo").addEventListener("change", (e) => save({ guardVideo: e.target.checked }));
$("compare").addEventListener("change", (e) => save({ compare: e.target.checked }));
$("openOnboarding").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }));

// ---------------------------------------------------------------- 고급
$("sensitivity").addEventListener("change", (e) => {
  renderPreset(Number(e.target.value));
  save({ sensitivity: Number(e.target.value) });
});
document.querySelectorAll(".modes button").forEach((b) =>
  b.addEventListener("click", () => {
    renderMode(b.dataset.mode);
    save({ mode: b.dataset.mode });
  })
);
$("keywords").addEventListener("change", (e) => save({ keywords: e.target.value }));
$("serverUrl").addEventListener("change", (e) => {
  save({ serverUrl: e.target.value.trim() });
  checkHealth(e.target.value.trim());
});
$("batchSize").addEventListener("change", (e) => save({ batchSize: Math.max(1, Number(e.target.value) || 20) }));
$("timeoutSec").addEventListener("change", (e) => save({ timeoutSec: Math.max(1, Number(e.target.value) || 10) }));
$("ytApiKey").addEventListener("change", (e) => save({ ytApiKey: e.target.value.trim() }));
// 시연 초기화: 서버 기억장의 신고 사건만 지움 (POST /memory/forget) + 이 브라우저 학습 초기화. 실수 방지로 두 번 눌러야 실행
let resetArmed = null;
$("demoReset").addEventListener("click", () => {
  const msg = $("demoResetMsg");
  if (!resetArmed) {
    msg.textContent = "한 번 더 누르면 초기화해요";
    resetArmed = setTimeout(() => ((resetArmed = null), (msg.textContent = "")), 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  msg.textContent = "초기화 중…";
  chrome.storage.local.get({ show: DEFAULTS.show }, ({ show }) =>
    chrome.runtime.sendMessage({ type: "forget", show }, (res) => {
      save({ typeOffsets: {}, overrides: {}, netflixDismissed: {} });
      msg.textContent = res?.ok
        ? `서버 기억장 신고 사건 ${res.data?.removed ?? 0}개 지움 · 학습 초기화 완료`
        : `학습은 초기화했지만 서버 기억장은 못 지웠어요 (${res?.error || "응답 없음"})`;
    })
  );
});

$("resetLearning").addEventListener("click", () => {
  save({ typeOffsets: {}, overrides: {} });
  renderOffsets({}, {});
});

// ---------------------------------------------------------------- 잘못 판단한 글 모음
const FB_COLS = [
  "at", "user", "shown_as", "watched_episode", "show", "kind", "id", "text", "context", "posted_at",
  "zoro_type", "p_spoiler", "written_after_episode", "matched_event", "matched_episode", "reasoned", "page",
];
function renderFb(log) {
  const n = (log || []).length;
  const notSp = (log || []).filter((r) => r.user === "스포 아님").length;
  $("fbCount").textContent = n ? `${n}개 (스포 아님 ${notSp} · 스포였음 ${n - notSp})` : "아직 없음";
}
chrome.storage.local.get({ feedbackLog: [] }, (s) => renderFb(s.feedbackLog));
$("fbDownload").addEventListener("click", () =>
  chrome.storage.local.get({ feedbackLog: [] }, ({ feedbackLog }) => {
    if (!feedbackLog.length) return;
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [FB_COLS.join(","), ...feedbackLog.map((r) => FB_COLS.map((c) => cell(r[c])).join(","))].join("\r\n");
    // 엑셀에서 한글 안 깨지게 BOM
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `shhpoil_feedback_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  })
);
$("fbClear").addEventListener("click", () => {
  save({ feedbackLog: [] });
  renderFb([]);
});

// ---------------------------------------------------------------- 에이전트 실행 로그 (제출용 시나리오 로그)
const STAGES = ["시작", "관찰", "판단", "라우팅", "행동", "학습", "오류", "복구"];
function pendingNote(s) {
  // 단서 요청 = 다시 판정 + 실패 + 취소 + (기록을 멈출 때 아직 줄 서 있던 것)
  const left = s.clueAsked - s.clueJudged - s.clueFailed - s.clueCancelled;
  return (s.clueCancelled ? ` · 취소 ${s.clueCancelled}` : "") + (left > 0 ? ` · 기록 끝날 때 아직 대기 ${left}` : "");
}
// 끊긴 구간 세기: 탭마다(페이지를 새로 열면 다시) 끊김을 감지하므로, 끊긴 탭이 하나라도 있는 동안을 한 구간으로 봄
function outagePeriods(log) {
  const downTabs = new Set();
  let periods = 0, closed = 0;
  for (const e of log) {
    if (e.stage === "오류" && e.event.startsWith("엔진 끊김")) {
      if (!downTabs.size) periods++;
      downTabs.add(e.tab);
    } else if (e.stage === "복구") {
      const had = downTabs.size;
      downTabs.delete(e.tab);
      if (had && !downTabs.size) closed++;
    }
  }
  return { outagePeriods: periods, outageClosed: closed, outageTabs: new Set(log.filter((e) => e.stage === "오류" && e.event.startsWith("엔진 끊김")).map((e) => e.tab)).size };
}
function logSummary(log) {
  const by = (st) => log.filter((e) => e.stage === st);
  const judged = by("판단").filter((e) => e.event.startsWith("Zoro-1"));
  const first = judged.filter((e) => e.event.startsWith("Zoro-1 판정"));
  const again = judged.filter((e) => !e.event.startsWith("Zoro-1 판정"));
  const avg = (xs) => {
    const ms = xs.map((e) => e.ms).filter((x) => x != null);
    return ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
  };
  const errs = by("오류");
  const acts = by("행동");
  const count = (w) => acts.filter((e) => e.event === w || e.event.endsWith(`→ ${w}`)).length;
  return {
    lines: log.length,
    judgeCalls: judged.length,
    firstCalls: first.length,
    judgedItems: first.reduce((n, e) => n + (e.count || 0), 0),
    avgMs: avg(first),
    avgAgainMs: avg(again),
    reasoned: by("판단").filter((e) => e.event.startsWith("Zoro-1 다시 판정 받음")).length,
    thought: by("판단").filter((e) => e.reasoned === true).length,
    skipped: by("판단").filter((e) => e.reasoned === false).length,
    routed: by("라우팅").filter((e) => !e.need && !e.event.includes("취소")).length,
    clueAsked: by("라우팅").filter((e) => e.need).length,
    clueJudged: by("판단").filter((e) => e.used_clues).length,
    cancelled: by("라우팅").filter((e) => e.event.includes("취소")).length,
    clueCancelled: by("라우팅").filter((e) => e.event.includes("취소") && e.kind === "clue").length,
    clueFailed: errs.filter((e) => e.event.startsWith("단서 보고")).length,
    reaskFailed: errs.filter((e) => e.event.startsWith("추론 모드")).length,
    outages: errs.filter((e) => e.event.startsWith("엔진 끊김")).length,
    ...outagePeriods(log),
    hidden: count("가림"),
    blurred: acts.filter((e) => e.event.startsWith("흐리게")).length,
    shown: count("그대로 보임"),
    guard: acts.filter((e) => e.event.includes("일시정지")).length,
    preview: acts.filter((e) => e.event.includes("미리보기")).length,
    learned: by("학습").length,
    errors: errs.length,
    recovered: by("복구").length,
  };
}
function renderLog(log = []) {
  if (!log.length) return ($("logCount").textContent = "아직 없음");
  const s = logSummary(log);
  const name = log.find((e) => e.scenario)?.scenario;
  $("logCount").textContent = `${name ? `기록 중: "${name}" · ` : "⚠ 새로 시작을 안 눌렀어요 · "}${s.lines}줄 · 판정 ${s.judgeCalls}번 · 가림 ${s.hidden} · 흐림 ${s.blurred} · 학습 ${s.learned}${s.errors ? ` · 오류 ${s.errors}` : ""}`;
}
chrome.storage.local.get({ agentLog: [] }, (s) => renderLog(s.agentLog));
$("logOn").addEventListener("change", (e) => {
  save({ logOn: e.target.checked });
  if (e.target.checked) $("logBox").open = true;
});
$("logText").addEventListener("change", (e) => save({ logText: e.target.checked }));
// 글자를 칠 때마다 저장 (팝업은 바깥을 누르면 바로 닫혀서, change만 쓰면 이름이 저장 안 될 수 있음)
$("logScenario").addEventListener("input", (e) => save({ logScenario: e.target.value.trim() }));
$("logStart").addEventListener("click", () =>
  chrome.storage.local.get(DEFAULTS, (st) => {
    const name = $("logScenario").value.trim() || st.logScenario || "시나리오";
    const start = {
      t: new Date().toISOString(),
      stage: "시작",
      event: `시나리오 "${name}" 시작`,
      scenario: name,
      settings: {
        show: st.show, watched: st.watchedEpisode, sensitivity: st.sensitivity, mode: st.mode,
        engine: st.serverUrl, batchSize: st.batchSize, timeoutSec: st.timeoutSec,
        typeOffsets: st.typeOffsets, overrides: Object.keys(st.overrides || {}).length, logText: st.logText,
      },
      version: chrome.runtime.getManifest().version,
    };
    save({ logOn: true, logScenario: name, agentLog: [start] });
    $("logOn").checked = true;
    renderLog([start]);
  })
);

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileBase = (log) => {
  const name = (log.find((e) => e.scenario)?.scenario || "log").replace(/[\\/:*?"<>|\s]+/g, "_");
  return `shhpoil_log_${name}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
};
$("logJson").addEventListener("click", () =>
  chrome.storage.local.get({ agentLog: [] }, ({ agentLog }) => {
    if (!agentLog.length) return;
    const out = { scenario: agentLog.find((e) => e.scenario)?.scenario || null, summary: logSummary(agentLog), entries: agentLog };
    download(fileBase(agentLog) + ".json", JSON.stringify(out, null, 2), "application/json");
  })
);
$("logMd").addEventListener("click", () =>
  chrome.storage.local.get({ agentLog: [] }, ({ agentLog }) => {
    if (!agentLog.length) return;
    download(fileBase(agentLog) + ".md", toMarkdown(agentLog), "text/markdown;charset=utf-8");
  })
);

// 사람이 읽는 로그: 요약 + 시간순 표 (판정 결과는 글마다 한 줄)
function toMarkdown(log) {
  const start = log.find((e) => e.stage === "시작");
  const st = start?.settings || {};
  const s = logSummary(log);
  const two = (n, w = 2) => String(n).padStart(w, "0");
  const time = (iso) => {
    const d = new Date(iso);
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${two(d.getMilliseconds(), 3)}`;
  };
  const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const detail = (e) => {
    const bits = [];
    if (e.id) bits.push(`\`${e.id}\``);
    if (e.type) bits.push(e.type);
    if (e.p != null) bits.push(`확률 ${e.p}%` + (e.p_used != null && e.p_used !== e.p ? ` (반영 ${e.p_used}%)` : ""));
    if (e.before_p != null) bits.push(`처음 ${e.before_p}%`);
    if (e.threshold != null) bits.push(`기준 ${e.threshold}%`);
    if (e.episode != null) bits.push(`${e.episode}화 내용`);
    if (e.watched != null && e.stage !== "관찰") bits.push(`본 회차 ${e.watched}화`);
    if (e.why) bits.push(e.why);
    if (e.keyword) bits.push(`키워드 "${e.keyword}"`);
    const names = (l) => (l || []).map((k) => ({ parent: "원댓글", replies: "답글", description: "영상 설명", timestamp: "타임스탬프" }[k] || k)).join("·");
    if (e.need && e.stage === "관찰") bits.push(`요청 ${names(e.need)}`);
    if (e.got) bits.push(e.got.length ? `모음 ${names(e.got)}` : "모은 것 없음");
    if (e.missing?.length) bits.push(`못 구함 ${names(e.missing)}`);
    if (e.used_clues) bits.push(`쓴 단서 ${names(e.used_clues)}`);
    if (e.count != null) bits.push(`${e.count}개`);
    if (e.comments != null) bits.push(`댓글 ${e.comments} · 영상 ${e.videos}`);
    if (e.ms != null) bits.push(`${e.ms}ms`);
    if (e.reasoned === true) bits.push(`Zoro 추론함${e.reasoning_ms != null ? ` (${e.reasoning_ms}ms)` : ""}`);
    else if (e.reasoned === false) bits.push("Zoro 확신 → 추론 건너뜀");
    if (e.offset_before != null) bits.push(`보정 ${e.offset_before}%p → ${e.offset_after}%p`);
    if (e.fixed) bits.push(`${e.fixed.ep}화 기준으로 "${e.fixed.decision === "show" ? "보임" : "가림"}" 고정`);
    if (e.event_episode != null && e.stage === "학습") bits.push(`${e.event_episode}화 사건${e.event_text ? ` "${e.event_text}"` : ""}`);
    if (e.result) bits.push(e.result);
    if (e.changed) bits.push(Object.entries(e.changed).map(([k, v]) => (typeof v === "object" ? `${k} ${JSON.stringify(v.from)}→${JSON.stringify(v.to)}` : `${k} ${v}`)).join(", "));
    if (e.error) bits.push(`오류: ${e.error}`);
    if (e.text || e.title) bits.push(`“${e.text || e.title}”`);
    return bits.join(" · ");
  };
  const rows = [];
  for (const e of log) {
    if (e.stage === "시작") continue;
    rows.push(`| ${time(e.t)} | ${e.stage} | ${esc(e.event)} | ${esc(detail(e))} |`);
    // Zoro-1 판정은 글마다 하위 줄로 펼침
    if (e.results)
      for (const r of e.results)
        rows.push(`|  |  | ↳ \`${esc(r.id)}\` | ${esc([r.type, `확률 ${r.p}%`, r.event_episode != null ? `${r.event_episode}화 사건 (${r.event_p}%)${r.event_text ? ` "${r.event_text}"` : ""}` : "사건 없음", r.written_after != null ? `${r.written_after}화 공개 후 작성` : "작성 시점 모름"].join(" · "))} |`);
  }
  return [
    `# 쉿스포 에이전트 실행 로그: ${start?.scenario || "시나리오"}`,
    "",
    `- 기록: ${log[0] ? new Date(log[0].t).toLocaleString("ko-KR") : ""} ~ ${new Date(log[log.length - 1].t).toLocaleString("ko-KR")}`,
    `- 설정: ${st.show ?? ""} · ${st.watched ?? "?"}화까지 봄 · 꼼꼼함 ${st.sensitivity ?? "?"} · 판정 방식 ${st.mode === "keyword" ? "키워드" : "Zoro-1"} · 한 번에 ${st.batchSize ?? "?"}개 · 대기 ${st.timeoutSec ?? "?"}초`,
    `- 확장 버전: ${start?.version || chrome.runtime.getManifest().version}${st.logText ? "" : " · 글 원문은 기록하지 않음 (ID만)"}`,
    "",
    "## 요약",
    "",
    "| 항목 | 값 |",
    "| --- | --- |",
    `| Zoro-1 판정 요청 | ${s.judgeCalls}번 (처음 판정 ${s.firstCalls}번 · 글 ${s.judgedItems}개 · 다시 판정 ${s.judgeCalls - s.firstCalls}번) |`,
    `| 응답 시간 평균 | 처음 판정 ${s.avgMs ?? "-"}ms (한 번에 여러 개) · 다시 판정 ${s.avgAgainMs ?? "-"}ms (글 1개, 추론 포함) |`,
    `| 라우팅: Zoro가 단서 요청 → 모아서 다시 판정 | ${s.clueAsked}개 → 다시 판정 ${s.clueJudged} · 실패 ${s.clueFailed}${pendingNote(s)} |`,
    `| 라우팅: 애매해서 추론 모드로 다시 물음 | ${s.routed}개 → 응답 ${s.reasoned} · 실패 ${s.reaskFailed} |`,
    `| 라우팅: 화면 전체 다시 판정으로 취소한 다시 묻기 | ${s.cancelled}개 (본 회차·꼼꼼함을 바꾸면 이전 질문은 버리고 새로 판정) |`,
    `| 다시 판정에서 Zoro가 추론함 · 확신해서 건너뜀 | ${s.thought} · ${s.skipped} |`,
    `| 행동: 가림 · 흐림 · 그대로 | ${s.hidden} · ${s.blurred} · ${s.shown} |`,
    `| 행동: 영상 경고 · 미리보기 막음 | ${s.guard} · ${s.preview} |`,
    `| 학습: 사용자 반응 · 기억장 | ${s.learned} |`,
    `| 엔진 끊김 → 자동 복구 | 끊긴 구간 ${s.outagePeriods}번 → 복구 ${s.outageClosed}번 (탭 ${s.outageTabs}개에서 감지 ${s.outages}번 · 복구 기록 ${s.recovered}번 · 끊긴 동안 요청 실패 포함 오류 ${s.errors}줄) |`,
    "",
    "## 흐름",
    "",
    "| 시각 | 단계 | 한 일 | 내용 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- 팝업이 열려 있는 동안 바뀐 값 바로 반영
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.feedbackLog) renderFb(changes.feedbackLog.newValue);
  if (changes.agentLog) renderLog(changes.agentLog.newValue || []);
  if (changes.watchedEpisode) $("watchedEpisode").value = changes.watchedEpisode.newValue;
  if (changes.typeOffsets || changes.overrides)
    chrome.storage.local.get(DEFAULTS, (s) => renderOffsets(s.typeOffsets, s.overrides));
});
