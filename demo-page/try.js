// 웹 체험판 위쪽 설정 막대 (크롬 확장의 팝업 역할)
(() => {
  const $ = (id) => document.getElementById(id);
  const store = chrome.storage.local;
  const START = { watchedEpisode: 3, sensitivity: 0.5, mode: "zoro", compare: true, guardVideo: true };

  // 레포 주소: GitHub Pages(아이디.github.io/레포/)에서 열리면 그 레포로 연결
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/);
  const repo = location.pathname.split("/")[1];
  if (m && repo) $("repoLink").href = `https://github.com/${m[1]}/${repo}#readme`;

  // 처음 열면 체험용 기본값
  store.get(null, (s) => {
    const missing = Object.fromEntries(Object.entries(START).filter(([k]) => !(k in s)));
    if (Object.keys(missing).length) store.set(missing);
    render({ ...START, ...s });
  });

  function render(s) {
    $("ep").textContent = `${s.watchedEpisode}화`;
    const btns = [...document.querySelectorAll("#presets button")];
    const near = btns.reduce((a, b) => (Math.abs(b.dataset.s - s.sensitivity) < Math.abs(a.dataset.s - s.sensitivity) ? b : a));
    btns.forEach((b) => b.classList.toggle("on", b === near));
    document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === s.mode));
    $("compare").checked = !!s.compare;
    $("guardVideo").checked = s.guardVideo !== false;
  }

  const cur = { watchedEpisode: 3 };
  store.get({ watchedEpisode: 3 }, (s) => (cur.watchedEpisode = s.watchedEpisode));
  const setEp = (n) => store.set({ watchedEpisode: Math.max(0, Math.min(13, n)) });
  $("epMinus").addEventListener("click", () => setEp(cur.watchedEpisode - 1));
  $("epPlus").addEventListener("click", () => setEp(cur.watchedEpisode + 1));
  document.querySelectorAll("#presets button").forEach((b) => b.addEventListener("click", () => store.set({ sensitivity: Number(b.dataset.s) })));
  document.querySelectorAll("#modes button").forEach((b) => b.addEventListener("click", () => store.set({ mode: b.dataset.mode })));
  $("compare").addEventListener("change", (e) => store.set({ compare: e.target.checked }));
  $("guardVideo").addEventListener("change", (e) => store.set({ guardVideo: e.target.checked }));
  $("reset").addEventListener("click", () => {
    window.SHHPOIL_TRIAL.reset();
    location.hash = "v1";
    location.reload();
  });
  $("guideClose").addEventListener("click", () => ($("guide").style.display = "none"));

  // 상태창의 ＋1화, 에이전트 제안 수락 등으로 바뀐 값도 막대에 반영
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.watchedEpisode) cur.watchedEpisode = changes.watchedEpisode.newValue;
    store.get(START, render);
  });
})();
