// 시연 페이지 화면 그리기 (확장용 index.html과 웹 체험판 try.html이 같이 씀)
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const fmtDate = (iso) => { const d = new Date(iso); return `${d.getFullYear()}. ${d.getMonth()+1}. ${d.getDate()}.`; };
  function ago(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    const units = [[31536000,"년"],[2592000,"개월"],[604800,"주"],[86400,"일"],[3600,"시간"],[60,"분"]];
    for (const [sec, u] of units) if (s >= sec) return `${Math.floor(s / sec)}${u} 전`;
    return "방금 전";
  }
  const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

  function render(id) {
    const v = DEMO_VIDEOS.find((x) => x.id === id) || DEMO_VIDEOS[0];
    const titleEl = document.getElementById("title");
    titleEl.textContent = v.title;
    // 확장이 "지금 보는 영상"을 판단할 때 읽는 값 (실제 유튜브에선 주소와 YouTube API로 얻음)
    titleEl.dataset.vid = v.id;
    titleEl.dataset.published = v.uploaded;
    document.getElementById("chan").textContent = v.channel;
    const desc = document.getElementById("desc");
    desc.textContent = `조회수 예시 · ${fmtDate(v.uploaded)} 업로드${v.description ? `\n${v.description}` : ""}`;
    desc.style.whiteSpace = "pre-line";
    // 확장이 "단서"로 읽는 영상 설명 (실제 유튜브에선 YouTube API로 받음)
    if (v.description) desc.dataset.description = v.description;
    else delete desc.dataset.description;
    document.getElementById("count").textContent = `댓글 ${v.comments.length}개`;
    // 확장이 읽는 구조: [data-bdk-comment] 안의 .text(본문), [data-published](정확한 작성 시각), .main(배지 위치)
    document.getElementById("comments").innerHTML = v.comments.map((c) => `
      <div class="comment" data-bdk-comment data-id="${c.id}"${c.replies ? ` data-replies="${esc(JSON.stringify(c.replies))}"` : ""}>
        <div class="av" style="--h:${hue(c.nick)}">${esc(c.nick.slice(1, 2))}</div>
        <div class="main">
          <div class="head"><span class="nick">${esc(c.nick)}</span><a class="time" href="#" data-published="${c.published}">${ago(c.published)}</a></div>
          <div class="text">${esc(c.text)}</div>
          <div class="actions"><span>👍 ${c.likes}</span><span>👎</span><span>${c.replies ? `답글 ${c.replies.length}개` : "답글"}</span></div>
        </div>
      </div>`).join("");
    document.getElementById("list").innerHTML = DEMO_VIDEOS.map((x) => `
      <div class="vid ${x.id === v.id ? "on" : ""}" data-v="${x.id}" data-bdk-video data-vid="${x.id}" data-published="${x.uploaded}">
        <div class="thumb">${esc(x.title.replace(/^\[.*?\]\s*/, ""))}</div>
        <div><div class="t">${esc(x.title)}</div><div class="m">${esc(x.channel)} · ${ago(x.uploaded)}</div></div>
      </div>`).join("");
    history.replaceState(null, "", `#${v.id}`);
  }

  document.getElementById("list").addEventListener("click", (e) => {
    const v = e.target.closest("[data-v]");
    // 쉿스포가 제목을 가린 영상은 "보기"를 누르기 전엔 열리지 않게 (실제 유튜브에선 링크 클릭이 막힘)
    if (v && v.matches(".bdk-hide:not(.bdk-revealed), .bdk-blur:not(.bdk-revealed)")) return;
    if (v) { render(v.dataset.v); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  render(location.hash.slice(1));
