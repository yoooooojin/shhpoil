const DEFAULTS = {
  enabled: true,
  mode: "zoro",
  show: "흑백요리사2",
  watchedEpisode: 3,
  sensitivity: 0.5,
  keywords: "흑백요리사,최강록,우승,탈락",
  serverUrl: "http://localhost:8787",
  typeOffsets: {},
};

const $ = (id) => document.getElementById(id);
const save = (obj) => chrome.storage.local.set(obj);

function renderMode(mode) {
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("kwBox").style.display = mode === "keyword" ? "block" : "none";
}

function renderOffsets(offsets) {
  const entries = Object.entries(offsets || {}).filter(([, v]) => v);
  $("offsets").textContent = entries.length
    ? entries.map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${Math.round(v * 100)}%p`).join(" · ")
    : "아직 없음";
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
  renderMode(s.mode);
  renderOffsets(s.typeOffsets);
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
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    renderMode(b.dataset.mode);
    save({ mode: b.dataset.mode });
  })
);
$("resetLearning").addEventListener("click", () => {
  save({ typeOffsets: {} });
  renderOffsets({});
});
