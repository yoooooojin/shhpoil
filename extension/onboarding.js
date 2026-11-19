// 첫 설치 안내: 작품 → 본 회차 → 민감도 → 끝
const $ = (id) => document.getElementById(id);
const steps = [...document.querySelectorAll(".step")];
const dots = [...document.querySelectorAll(".dots i")];
const pick = { show: "흑백요리사2", ep: 3, sensitivity: 0.7 };
let at = 0;

// 이미 설정이 있으면 그 값으로 시작 ("처음 안내 다시 보기")
chrome.storage.local.get({ show: pick.show, watchedEpisode: pick.ep, sensitivity: pick.sensitivity }, (s) => {
  Object.assign(pick, { show: s.show, ep: s.watchedEpisode, sensitivity: s.sensitivity });
  $("ep").value = pick.ep;
  document.querySelectorAll(".show").forEach((b) => b.classList.toggle("on", b.dataset.show === pick.show));
  if (![...document.querySelectorAll(".show")].some((b) => b.dataset.show === pick.show)) $("customShow").value = pick.show;
  const btns = [...document.querySelectorAll(".presets button")];
  const near = btns.reduce((a, b) => (Math.abs(b.dataset.s - pick.sensitivity) < Math.abs(a.dataset.s - pick.sensitivity) ? b : a));
  btns.forEach((b) => b.classList.toggle("on", b === near));
  pick.sensitivity = Number(near.dataset.s);
});

function go(n) {
  at = Math.max(0, Math.min(steps.length - 1, n));
  steps.forEach((s, i) => s.classList.toggle("on", i === at));
  dots.forEach((d, i) => d.classList.toggle("on", i <= Math.min(at, dots.length - 1)));
  $("back").style.visibility = at === 0 || at === steps.length - 1 ? "hidden" : "visible";
  $("next").style.display = at === steps.length - 1 ? "none" : "";
  $("next").textContent = at === steps.length - 2 ? "시작하기" : "다음";
}

document.querySelectorAll(".show").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".show").forEach((x) => x.classList.toggle("on", x === b));
    $("customShow").value = "";
    pick.show = b.dataset.show;
  })
);
$("customShow").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  document.querySelectorAll(".show").forEach((x) => x.classList.toggle("on", !v && x.dataset.show === "흑백요리사2"));
  pick.show = v || "흑백요리사2";
});

const setEp = (n) => ($("ep").value = pick.ep = Math.max(0, Math.min(99, Number(n) || 0)));
$("ep").addEventListener("change", (e) => setEp(e.target.value));
$("epMinus").addEventListener("click", () => setEp(pick.ep - 1));
$("epPlus").addEventListener("click", () => setEp(pick.ep + 1));

document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".presets button").forEach((x) => x.classList.toggle("on", x === b));
    pick.sensitivity = Number(b.dataset.s);
  })
);

$("back").addEventListener("click", () => go(at - 1));
$("next").addEventListener("click", () => {
  if (at === steps.length - 2) {
    chrome.storage.local.set({ show: pick.show, watchedEpisode: pick.ep, sensitivity: pick.sensitivity, enabled: true, onboarded: true });
    const level = { 0.4: "확실한 것만", 0.5: "보통", 0.7: "꼼꼼히" }[pick.sensitivity] || "꼼꼼히";
    $("summary").textContent = `${pick.show} · ${pick.ep}화까지 봄 · ${level}`;
    $("goYoutube").href = `https://www.youtube.com/results?search_query=${encodeURIComponent(pick.show)}`;
  }
  go(at + 1);
});
go(0);
