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
  stats: {},
};

const $ = (id) => document.getElementById(id);
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

function renderStats(stats) {
  const today = new Date().toLocaleDateString("sv");
  $("statToday").textContent = stats?.date === today ? stats.blocked : 0;
  $("statTotal").textContent = stats?.total ? `지금까지 ${stats.total}개` : "";
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
  $("batchSize").value = s.batchSize;
  $("timeoutSec").value = s.timeoutSec;
  renderMode(s.mode);
  renderPreset(s.sensitivity);
  renderOffsets(s.typeOffsets, s.overrides);
  renderStats(s.stats);
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

// ---------------------------------------------------------------- 팝업이 열려 있는 동안 바뀐 값 바로 반영
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.feedbackLog) renderFb(changes.feedbackLog.newValue);
  if (changes.stats) renderStats(changes.stats.newValue);
  if (changes.watchedEpisode) $("watchedEpisode").value = changes.watchedEpisode.newValue;
  if (changes.typeOffsets || changes.overrides)
    chrome.storage.local.get(DEFAULTS, (s) => renderOffsets(s.typeOffsets, s.overrides));
});
