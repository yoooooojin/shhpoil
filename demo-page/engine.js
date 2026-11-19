// 웹 체험판용 판단 엔진 (브라우저 안에서 돌아감)
// 실제 서비스는 Zoro-1이 판정하지만, 체험판은 설치·서버 없이 열리도록 같은 API 모양을 흉내 냄.
//  - 글 성격·확률: 단어 규칙 (mock-server/server.py와 같은 규칙)
//  - 시점: 방영 일정표로 "몇 화 공개 뒤에 쓴 글인지" 계산
//  - 사건: 스포 기억장(memory.js)에서 출연자 이름·별명 + 결과 단어로 사건과 회차를 찾음
//  - 신고: "스포였어요"를 누르면 그 글의 핵심 단어로 새 사건을 기억장에 추가
window.SHHPOIL_ENGINE = (() => {
  const DROPS = [
    ["2025-12-16T17:00:00+09:00", 3],
    ["2025-12-23T17:00:00+09:00", 7],
    ["2025-12-30T17:00:00+09:00", 10],
    ["2026-01-06T17:00:00+09:00", 12],
    ["2026-01-13T17:00:00+09:00", 13],
  ];
  const RESULT = ["우승", "탈락", "떨어", "결승", "생존", "이겼", "패배", "만장일치", "올라가", "진출", "직행", "1등", "준우승", "TOP7", "탑7"];
  const LEAK = ["지인", "촬영장", "스태프", "관계자", "유출", "찌라시"];
  const RUMOR = ["우승설", "루머", "카더라", "할듯", "할 듯", "같음", "예상", "진짜임?", "맞음?"];
  const OFF = ["몇 시", "몇시", "공개 시간", "자막", "화질"];
  const reported = []; // 신고로 쌓인 사건

  const has = (t, ws) => ws.some((w) => t.includes(w));
  function classify(t) {
    if (has(t, OFF) && !has(t, RESULT)) return ["무관", 0.05];
    if (has(t, LEAK)) return ["유출 주장", 0.8];
    if (has(t, RUMOR)) return ["루머·추측", 0.45];
    if (has(t, RESULT)) return ["결과 공개", 0.85];
    return ["감상·출연자 이야기", 0.12];
  }
  // 같은 글엔 늘 같은 흔들림 (진짜 모델처럼 확률이 딱 떨어지지 않게)
  function jitter(t) {
    let x = 7;
    for (const c of t) x = (x * 31 + c.charCodeAt(0)) % 100003;
    return ((x % 1000) / 1000 - 0.5) * 0.16;
  }
  function writtenAfter(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (isNaN(t)) return null;
    let ep = 0;
    for (const [d, e] of DROPS) if (t >= Date.parse(d)) ep = e;
    return ep;
  }
  function matchEvent(t) {
    let best = null;
    const all = [...(window.SHHPOIL_MEMORY || []), ...reported];
    for (const ev of all) {
      const names = [...(ev.people || []), ...(ev.aliases || []), ...(ev.keys || [])];
      const who = names.filter((n) => n && t.includes(n)).length;
      if (!who) continue;
      const what = RESULT.filter((w) => ev.text.includes(w) && t.includes(w)).length;
      const score = who + what * 1.5 + (ev.reported ? 1 : 0);
      if (score < 2 && !ev.reported) continue; // 이름만 나온 건 사건으로 안 봄
      const p = Math.min(0.95, 0.4 + 0.18 * score);
      if (!best || score > best.score || (score === best.score && ev.episode > best.episode))
        best = { text: ev.text, episode: ev.episode, p: Math.round(p * 100) / 100, score, reported: !!ev.reported };
    }
    return best;
  }

  function judge(payload, reason) {
    return {
      results: (payload.comments || []).map((c) => {
        const t = c.text || "";
        let [type, p] = classify(t);
        p += jitter(t);
        const ev = matchEvent(t);
        if (ev?.reported) [type, p] = ["결과 공개", Math.max(p, 0.82)];
        else if (ev && type === "감상·출연자 이야기" && ev.score >= 2.5) [type, p] = ["결과 공개", 0.7 + jitter(t)];
        if (reason) p += p >= 0.5 ? 0.15 : -0.15;
        const after = writtenAfter(c.posted_at);
        // 유출·루머는 "아직 공개 안 된 결과"에 대한 말 → 사건을 못 찾아도 다음 회차 이후 내용으로 봄
        let me = ev && type !== "감상·출연자 이야기" && type !== "무관" ? { text: ev.text, episode: ev.episode, p: ev.p } : null;
        if (!me && (type === "유출 주장" || type === "루머·추측") && after != null && after < 13)
          me = { text: "아직 공개 안 된 결과에 대한 주장", episode: after + 1, p: 0.6 };
        p = Math.round(Math.max(0.01, Math.min(0.99, p)) * 100) / 100;
        return {
          id: c.id,
          p_spoiler: p,
          type,
          written_after_episode: after,
          matched_event: me,
          reasoned: !!reason,
          memory_update: null,
        };
      }),
      engine: "체험판 간이 판정",
    };
  }

  // 신고된 글에서 사건을 대표할 단어 하나 (가장 긴 명사 비슷한 단어)
  const PARTICLES = ["에서", "으로", "이랑", "은", "는", "이", "가", "을", "를", "도", "에", "로", "랑", "의", "만"];
  const ENDINGS = ["다", "고", "서", "요", "네", "음", "지", "데", "까", "는", "던", "게", "면", "니", "어", "야"];
  function keyWord(t) {
    const words = [];
    for (let w of t.split(/\s+/)) {
      w = w.replace(/[^\p{L}\p{N}]/gu, "");
      const p = PARTICLES.find((x) => w.endsWith(x) && w.length > x.length + 1);
      if (p) w = w.slice(0, -p.length);
      if (w.length >= 2 && !ENDINGS.some((e) => w.endsWith(e)) && !w.startsWith("ㅋ")) words.push(w);
    }
    return words.sort((a, b) => b.length - a.length)[0] || null;
  }
  function report(payload) {
    const c = payload.comment || {};
    const key = keyWord(c.text || "");
    if (!key) return { memory_update: { added: false, event: null } };
    const old = reported.find((e) => e.keys.includes(key));
    if (old) return { memory_update: { added: false, event: { id: old.id, text: old.text, episode: old.episode } } };
    const ep = writtenAfter(c.posted_at) || (payload.watched_episode || 0) + 1;
    const ev = { id: `r${reported.length + 1}`, text: `${key} 관련 장면 (신고)`, episode: ep, keys: [key], reported: true };
    reported.push(ev);
    return { memory_update: { added: true, event: { id: ev.id, text: ev.text, episode: ep } } };
  }

  return { judge, report, health: () => ({ ok: true, engine: "체험판 간이 판정" }) };
})();
