// 사이트별 "관찰" 어댑터. 사이트마다 글/댓글이 있는 위치가 달라서 여기만 바꾸면 됩니다.
// 각 어댑터:
//   match(location)   → 이 사이트에서 쓸지
//   items(root)       → 판정할 요소 목록
//   text(el)          → 본문 텍스트
//   postedAt(el)      → ISO 게시 시각 (없으면 null)
//   context(el)       → 원글 제목 등 (댓글 뜻을 이해하는 데 도움)

window.BDK_SITES = [
  {
    name: "demo",
    match: (loc) => ["localhost", "127.0.0.1"].includes(loc.hostname),
    items: (root) => root.querySelectorAll("[data-bdk-comment]"),
    text: (el) => (el.querySelector(".text")?.textContent || "").trim(),
    postedAt: (el) => el.querySelector("time[datetime]")?.getAttribute("datetime") || null,
    context: (el) => el.closest(".post")?.querySelector("[data-bdk-title]")?.textContent?.trim() || "",
  },
  {
    // TODO(사용자): 실제 더쿠 화면 구조를 개발자 도구로 확인해서 선택자를 채우세요.
    // 아래는 자리만 잡아 둔 값이라 그대로는 동작하지 않을 수 있어요.
    name: "theqoo",
    match: (loc) => loc.hostname.endsWith("theqoo.net"),
    items: (root) => root.querySelectorAll(".fdb_lst_ul > li"),
    text: (el) => (el.querySelector(".xe_content")?.textContent || "").trim(),
    postedAt: (_el) => null, // TODO: 댓글 시각 요소를 찾아 ISO로 바꾸기
    context: (_el) => document.querySelector("h1, .title")?.textContent?.trim() || "",
  },
];
