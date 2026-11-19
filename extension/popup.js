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
};

const $ = (id) => document.getElementById(id);
$("ver").textContent = `v${chrome.runtime.getManifest().version}`;
const save = (obj) => chrome.storage.local.set(obj);

function renderMode(mode) {
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("kwBox").style.display = mode === "keyword" ? "block" : "none";
}

function renderOffsets(offsets, overrides) {
  const entries = Object.entries(offsets || {}).filter(([, v]) => v);
  const parts = entries.map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${Math.round(v * 100)}%p`);
  const n = Object.keys(overrides || {}).length;
  if (n) parts.push(`직접 판정한 댓글 ${n}개`);
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
  renderMode(s.mode);
  renderOffsets(s.typeOffsets, s.overrides);
  checkHealth(s.serverUrl);
});

$("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
$("show").addEventListener("change", (e) => save({ show: e.target.value.trim() }));
$("watchedEpisode").addEventListener("change", (e) => save({ watchedEpisode: Number(e.target.value) || 0 }));
$("sensitivity").addEventListener("change", (e) => save({ sensitivity: Number(e.target.value) }));
$("keywords").addEventListener("change", (e) => save({ keywords: e.target.value }));
$("serverUrl").addEventListener("change", (e) => {
  save({ serverUrl: e.target.value.trim() });
  checkHealth(e.target.value.trim());
});
$("compare").addEventListener("change", (e) => save({ compare: e.target.checked }));
$("ytApiKey").addEventListener("change", (e) => save({ ytApiKey: e.target.value.trim() }));
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    renderMode(b.dataset.mode);
    save({ mode: b.dataset.mode });
  })
);
$("resetLearning").addEventListener("click", () => {
  save({ typeOffsets: {}, overrides: {} });
  renderOffsets({}, {});
});

// 팝업이 열려 있는 동안 학습 기록이 바뀌면 바로 표시
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.typeOffsets || changes.overrides)) return;
  chrome.storage.local.get(DEFAULTS, (s) => renderOffsets(s.typeOffsets, s.overrides));
});
