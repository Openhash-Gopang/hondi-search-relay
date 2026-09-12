/**
 * 혼디 검색 (Hondi Search) 백엔드 릴레이 - Cloudflare Worker 라우트
 *
 * worker.js 라우터 등록:
 *   import { handleHondiSearch } from './src/routes/hondi-search-worker.js';
 *   ...
 *   if (pathname === '/hondi-search' && request.method === 'POST')
 *     return handleHondiSearch(request, env, corsHeaders, { _err });
 *
 * 필요 바인딩(wrangler.toml):
 *   [[kv_namespaces]]
 *   binding = "HONDI_SEARCH_HISTORY"
 *   (id는 `wrangler kv namespace create HONDI_SEARCH_HISTORY`로 발급 후 실사 반영 —
 *    추측 ID를 넣지 않는다. 다른 바인딩들과 동일 원칙, wrangler.toml 상단 주석 참고.)
 *
 * DEEPSEEK_API_KEY는 이미 다른 기능들이 쓰고 있는 기존 시크릿을 그대로 재사용한다
 * (worker.js 여러 곳에서 env.DEEPSEEK_API_KEY 참조 확인됨 — 별도 시크릿 추가 불필요).
 * 모델 호출은 src/gopang/core/deepseek-client.js의 공용 deepseekChat()을 통해서만 한다
 * (개별 fetch 하드코딩 금지 — 이 모듈 헤더 주석에 명시된 원칙).
 */

import { deepseekChat } from './deepseek-client.js';

const HONDI_SEARCH_SP = `당신은 혼디(hondi.net)의 사이트 내 검색 도우미 "혼디 검색"입니다.

역할:
- 사용자의 자연어 질의를 분석하여, 아래 제공되는 사이트 페이지 매니페스트 중
  사용자의 의도에 가장 부합하는 목적지를 찾습니다.
- 단순 키워드 매칭이 아니라 의도 파악에 기반합니다.

동작 규칙:
1. 질의가 모호하면(예: 여러 페이지가 후보이거나, 목적이 불분명하면)
   명확화 질문을 1회 던집니다. 명확화는 최대 2라운드까지만 허용합니다.
1-1. "OO 검색"처럼 서비스/기능 이름 뒤에 막연히 "검색"만 붙은 질의는 그 자체로
   (a) 그 서비스 페이지로 이동하려는 의도인지, (b) 그 서비스 안에서 본인 데이터를
   찾으려는 의도인지 구분이 안 됩니다. 이런 경우는 규칙 4(K-Search 위임)보다
   먼저 규칙 1(명확화)을 적용해 반드시 한 번 되물으십시오.
   예: "메일 검색" → "메일을 보내거나 받으실 건가요? 아니면 혼디의 메일
   시스템을 알고 싶으세요?"
   반면 찾으려는 대상이 구체적으로 명시된 질의(사람, 기간, 내용 등 검색
   조건이 포함된 경우 — 예: "지난주에 김민수한테 받은 메일 찾아줘", "내가
   저장한 계약서 찾아줘")는 모호하지 않으므로 되묻지 않고 곧바로 규칙 4를
   적용합니다.
2. 명확화 후에도 여전히 모호하면 최상위 후보 3개를 candidates로 제시합니다.
3. 목적지가 명확해지면 navigate로 응답합니다. 이때 절대 URL을 스스로 조합하거나
   추측하지 마십시오 — 반드시 매니페스트 항목의 "path" 값을 정확히 그대로
   "manifest_path"에 담아 반환하십시오. 실제 이동할 URL(pc_url)은 이 워커가
   매니페스트에서 직접 조회해 채웁니다. 당신은 URL 문자열 자체를 만들지 않습니다.
3-1. 이 엔드포인트(/hondi-search)는 desktop.html 상단 검색 전용이며, 호출자는
   항상 PC입니다. 그러므로 "manifest_path"는 매니페스트에 있는 값을 그대로
   복사한 것이어야 하며, webapp.html처럼 모바일 전용 화면을 가리키는 값을
   당신이 직접 지어내서는 안 됩니다 — 애초에 그런 값은 매니페스트에 없습니다.
3-2. 아래 매니페스트에는 사용자가 선택한 검색 범위(scope)에 해당하는
   항목만 담겨 있습니다 — 이미 필터링이 끝난 상태입니다. 매니페스트에
   없는 페이지는 그 범위에 존재하지 않는 것이므로, 없는 페이지를
   있다고 지어내거나 다른 범위의 페이지를 억지로 끌어와 답하지 마십시오
   (예: 매니페스트에 진짜 없는 페이지인데 이름이 비슷하다는 이유만으로
   navigate하는 것 — 2026-09-13 "혼디 숫자 코드" 오매칭 사고가 이 유형).
   그런 경우 정직하게 "이 범위에서는 해당 페이지를 찾지 못했습니다"라고
   clarify로 답하십시오.
4. 당신은 사용자 데이터(메일함, 문서 등)에 접근하지 않습니다.
   데이터 자체를 찾는 요청은 K-Search 영역이므로,
   "OO을 찾으시는 건 K-Search가 담당합니다"라고 안내하고 K-Search로 위임합니다.
5. 응답은 반드시 아래 JSON 스키마만 출력합니다. 그 외 텍스트를 포함하지 않습니다.
   설명이나 마크다운 코드펜스 없이 순수 JSON 객체 하나만 출력하십시오.
{{SCOPE_NOTE}}
응답 스키마:
{
  "type": "clarify" | "navigate" | "candidates" | "delegate_ksearch",
  "message": "사용자에게 보여줄 한국어 문장",
  "manifest_path": "type=navigate일 때만, 매니페스트 항목의 path 값 그대로",
  "candidates": [{"label": "...", "manifest_path": "..."}]  // type=candidates일 때만
}

[사이트 매니페스트]
{{SITE_MANIFEST_JSON}}

[대화 히스토리]
{{CONVERSATION_HISTORY}}`;

// scope='dev'일 때만 시스템 프롬프트에 덧붙는 보조 규칙. 개발자 문서
// 매니페스트 항목엔 title에 날짜가 박혀 있고 date 필드로도 파싱돼 있으므로,
// "최근 것"류 상대 시간 질의를 date 내림차순으로 해석하도록 안내한다.
// scope='user'일 때는 빈 문자열로 치환돼 핵심 로직에 아무 영향이 없다.
const DEV_SCOPE_NOTE = `
6. (개발자 문서 범위 전용) "최근 것", "이번 주" 같은 상대적 시간 표현이
   질의에 있으면, 매니페스트 각 항목의 "date" 필드(있는 경우) 기준
   내림차순으로 우선순위를 매겨 답하십시오. date가 없는 항목은 오래된
   참조 매뉴얼로 간주해 "최근" 질의의 후보에서 낮은 우선순위로 둡니다.
`;

const VALID_SCOPES = new Set(['user', 'dev']);
function normalizeScope(scope) {
  return VALID_SCOPES.has(scope) ? scope : 'user'; // 기본값 — Phase 0 결정: "전체" 옵션 없음, 미지정 시 사용자용
}

const HISTORY_TTL_SECONDS = 60 * 10; // 10분 미사용 시 세션 만료
const MANIFEST_CACHE_TTL_SECONDS = 60 * 60; // 매니페스트 캐시 1시간
const MANIFEST_KV_KEY = 'site-manifest';
const HONDI_SEARCH_MODEL = 'deepseek-v4-flash';

// KV/원본 모두 실패했을 때를 대비한 최소 폴백 매니페스트.
// 실제 페이지가 추가/변경되면 public/site-manifest.json(정본)을 갱신하는 것이 원칙이며,
// 이 배열은 원본 로드가 실패했을 때만 쓰이는 비상용 스냅샷이다.
const FALLBACK_MANIFEST = [
  {
    path: '/services/kmail',
    title: 'K-Mail',
    description: '자연어 명령으로 메일을 보내고 받는 혼디 사용자 메일 기능',
    keywords: ['메일', '이메일', 'K-Mail', '발신', '수신', '메일 보내기'],
    pc_url: 'https://mail.hondi.net',
    audience: 'user',
  },
  {
    path: '/docs/kmail-intro',
    title: 'K-Mail 소개',
    description: 'K-Mail 시스템 자체의 개념과 사용법을 설명하는 문서',
    keywords: ['메일 시스템', 'K-Mail이란', '메일 기능 소개', '혼디 메일 시스템'],
    pc_url: 'https://mail.hondi.net',
    audience: 'user',
  },
  {
    path: '/services/klaw',
    title: 'K-Law',
    description: '법률 상담 및 판례 시뮬레이션 AI 서비스',
    keywords: ['법률', 'K-Law', '판례', '법률 상담', '소송'],
    pc_url: 'https://klaw.hondi.net',
    audience: 'user',
  },
  {
    path: '/services/kjob',
    title: 'K-Job',
    description: '구인·구직 및 업무 오케스트레이션 서비스',
    keywords: ['구직', '구인', '일자리', 'K-Job', '채용'],
    pc_url: 'https://job.hondi.net',
    audience: 'user',
  },
];

// manifest_path(모델이 고른 매니페스트 항목의 path)를 실제 PC용 절대 URL로
// 바꾼다. 모델이 URL 문자열 자체를 만들지 않게 하고, 이 워커가 매니페스트에
// 있는 pc_url을 그대로 쓰게 강제하는 게 이 함수의 목적 — path가 매니페스트에
// 없으면(모델의 환각) null을 반환하고, 호출부가 clarify로 안전하게 되돌린다.
function resolveManifestUrl(manifestPath, manifest) {
  if (!manifestPath) return null;
  const entry = (manifest || []).find((m) => m.path === manifestPath);
  return entry && entry.pc_url ? entry.pc_url : null;
}

async function fetchManifestFromOrigin(env) {
  const url = env.SITE_MANIFEST_URL || 'https://hondi.net/site-manifest.json' /* 리포 루트에 위치 - public/ 아님, GitHub Pages가 루트를 그대로 미러링하므로 */;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`site-manifest fetch failed: ${res.status}`);
  }
  return res.json();
}

// 2026-09-09 신설 — 전문가 페르소나(552개) 로컬 매칭.
// 이 인덱스를 deepseek에 매번 통째로 넘기면 요청당 수만 토큰이 들어가므로,
// site-manifest.json에는 넣지 않고 Worker에서 문자열 매칭만으로 먼저
// 처리한다. "내과 의사"처럼 트리거 문구와 정확히 안 겹쳐도 라벨
// 부분일치로 잡히도록 한다. 정확히 한 명만 매칭되면 deepseek 호출 없이
// 바로 navigate, 둘 이상 매칭(모호)되면 매칭 안 된 것으로 보고 기존
// deepseek 경로(명확화 등)로 넘긴다.
const PERSONA_INDEX_KV_KEY = 'expert-persona-index';
const PERSONA_INDEX_CACHE_TTL_SECONDS = 60 * 60; // 1시간

async function fetchPersonaIndexFromOrigin(env) {
  const url = env.PERSONA_INDEX_URL || 'https://hondi.net/data/expert-persona-index.json';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`expert-persona-index fetch failed: ${res.status}`);
  }
  return res.json();
}

async function loadPersonaIndex(env) {
  const cached = await env.HONDI_SEARCH_HISTORY.get(PERSONA_INDEX_KV_KEY, 'json');
  if (cached) return cached;

  let index;
  try {
    index = await fetchPersonaIndexFromOrigin(env);
  } catch (err) {
    console.error('[hondi-search] expert-persona-index 로드 실패, 페르소나 매칭 스킵:', err);
    index = {}; // 실패해도 검색 자체는 계속 동작해야 하므로 빈 인덱스로 저하
  }

  await env.HONDI_SEARCH_HISTORY.put(PERSONA_INDEX_KV_KEY, JSON.stringify(index), {
    expirationTtl: PERSONA_INDEX_CACHE_TTL_SECONDS,
  });

  return index;
}

function matchPersonaByQuery(message, personaIndex) {
  const q = (message || '').trim();
  if (!q) return null;

  const matches = [];
  for (const [pid, p] of Object.entries(personaIndex)) {
    const candidates = [
      ...(p.triggers || []),
      p.label,
      `${p.label} ${p.parentLabel}`,
      `${p.parentLabel} ${p.label}`,
    ].filter(Boolean);

    const hit = candidates.some((c) => q.includes(c) || c.includes(q));
    if (hit) matches.push({ id: pid, ...p });
  }

  // 하나만 매칭되면 확정. 둘 이상이면 모호하므로 deepseek 경로로 넘긴다.
  return matches.length === 1 ? matches[0] : null;
}

async function loadManifest(env) {
  const cached = await env.HONDI_SEARCH_HISTORY.get(MANIFEST_KV_KEY, 'json');
  if (cached) return cached;

  let manifest;
  try {
    manifest = await fetchManifestFromOrigin(env);
  } catch (err) {
    console.error('[hondi-search] site-manifest 원본 로드 실패, 폴백 사용:', err);
    manifest = FALLBACK_MANIFEST;
  }

  await env.HONDI_SEARCH_HISTORY.put(MANIFEST_KV_KEY, JSON.stringify(manifest), {
    expirationTtl: MANIFEST_CACHE_TTL_SECONDS,
  });

  return manifest;
}

// 캐시/원본은 전체 매니페스트(모든 audience) 하나만 유지한다 — scope별로
// 별도 캐시를 두면 그 자체가 또 다른 동기화 대상이 되므로(이 레포가
// 반복해서 겪은 "사본 두 곳" 패턴), 필터링은 항상 요청 시점에 메모리에서
// 수행한다. audience 필드가 없는 예전 형식 항목(수동 이관 중 누락 등)은
// 안전하게 'user'로 간주해 사용자 검색에서 제외되지 않게 한다.
function filterManifestByScope(manifest, scope) {
  return (manifest || []).filter((m) => (m.audience || 'user') === scope);
}

async function loadHistory(env, conversationId) {
  if (!conversationId) return [];
  const raw = await env.HONDI_SEARCH_HISTORY.get(`conv:${conversationId}`, 'json');
  return raw || [];
}

async function saveHistory(env, conversationId, history) {
  if (!conversationId) return;
  await env.HONDI_SEARCH_HISTORY.put(
    `conv:${conversationId}`,
    JSON.stringify(history),
    { expirationTtl: HISTORY_TTL_SECONDS }
  );
}

// 첨부파일 정보(있다면)를 사용자 질의 텍스트에 덧붙인다.
// 텍스트 계열 파일은 내용 일부까지, 그 외(이미지 등)는 파일명/타입만 —
// deepseekChat이 텍스트 메시지만 지원하므로 이미지 자체를 분석하지는 않는다.
const MAX_ATTACHMENT_CONTENT_CHARS = 4000;

function buildUserContentWithAttachment(message, attachment) {
  if (!attachment || typeof attachment !== 'object' || !attachment.name) {
    return message;
  }
  let note = `\n\n[사용자가 파일을 첨부함: ${attachment.name} (${attachment.mimeType || '알 수 없음'})]`;
  if (typeof attachment.content === 'string' && attachment.content.length > 0) {
    const snippet = attachment.content.slice(0, MAX_ATTACHMENT_CONTENT_CHARS);
    note += `\n--- 첨부 파일 내용(일부) ---\n${snippet}\n---`;
  }
  return `${message}${note}`;
}

function buildMessages(sp, manifest, history, message, scope) {
  const systemPrompt = sp
    .replace('{{SCOPE_NOTE}}', scope === 'dev' ? DEV_SCOPE_NOTE : '')
    .replace('{{SITE_MANIFEST_JSON}}', JSON.stringify(manifest))
    .replace('{{CONVERSATION_HISTORY}}', JSON.stringify(history));

  return [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message },
  ];
}

// deepseek가 지시를 어기고 ```json 코드펜스를 씌워 보내는 경우까지 방어.
function safeParseJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      type: 'clarify',
      message: '죄송합니다, 다시 한번 말씀해주시겠어요?',
    };
  }
}

export async function handleHondiSearch(request, env, corsHeaders, { _err }) {
  if (request.method !== 'POST') {
    return _err(405, 'METHOD_NOT_ALLOWED', 'POST만 허용됩니다', corsHeaders);
  }

  const body = await request.json().catch(() => null);
  if (!body) return _err(400, 'INVALID_JSON', 'JSON body 필수', corsHeaders);

  const { conversation_id, message, attachment, scope: rawScope } = body;
  if (!message || typeof message !== 'string') {
    return _err(400, 'message_required', 'message 필드가 필요합니다', corsHeaders);
  }
  const scope = normalizeScope(rawScope);

  // 전문가 페르소나 로컬 매칭 - 첨부파일이 없는 순수 텍스트 질의에만 적용.
  // 매칭되면 deepseek 호출 없이 바로 navigate (더 빠르고, id 추측으로 인한
  // 잘못된 링크 위험도 없음).
  //
  // 2026-09-09 수정 - 목적지를 persona.chatUrl(expert-chat.html, 실제
  // 대화창)에서 SP 문서 편집기(sp-editor.html)로 변경. 이 /hondi-search
  // 경로는 desktop.html 상단 검색 전용이므로, 여기서 매칭됐다는 것 자체가
  // "desktop.html 검색으로 찾아온 것"이라는 뜻이다. 원래 의도는 전문가
  // 페르소나 목록의 "SP 프롬프트 원문 보기" 아이콘과 동일하게, 페르소나
  // 설명 + 실제 대화로 이어지는 링크가 있는 sp-editor.html로 먼저 보내는
  // 것 — 대화창으로 바로 꽂는 건 K-서비스/webapp.html이 자체 경로
  // (gwp-registry.js/expert-registry.js)로 이미 처리하고 있고, 여긴 손대면
  // 안 된다. sp-editor.html의 URL 패턴은 expert-personas.html의
  // expertSpEditUrl()과 동일하게 맞춘다.
  if (!attachment) {
    const personaIndex = await loadPersonaIndex(env);
    const persona = matchPersonaByQuery(message, personaIndex);
    if (persona) {
      if (conversation_id) {
        await env.HONDI_SEARCH_HISTORY.delete(`conv:${conversation_id}`);
      }
      // spPath가 비어있는 항목은(현재는 552개 전부 채워져 있음을 확인했으나
      // 방어적으로) 기존 대화창 URL로 폴백한다.
      const url = persona.spPath
        ? '/pages/sp-editor.html?repo=Openhash-Gopang/hondi&path=' + encodeURIComponent(persona.spPath)
        : persona.chatUrl;
      return new Response(
        JSON.stringify({
          type: 'navigate',
          url,
          message: `${persona.parentLabel} 중 ${persona.label} 페르소나의 SP 문서로 안내해 드릴게요.`,
        }),
        { status: 200, headers: corsHeaders }
      );
    }
  }

  const [manifest, history] = await Promise.all([
    loadManifest(env),
    loadHistory(env, conversation_id),
  ]);
  // scope 필터링은 항상 요청 시점에 메모리에서 수행 — 캐시는 전체
  // 매니페스트 하나만 유지한다(위 filterManifestByScope 주석 참조).
  // ※ UI(Phase 4)가 스코프 토글을 바꿀 때는 새 conversation_id를
  //   발급해야 한다 — 같은 대화 히스토리 안에서 scope가 바뀌면 이전
  //   turn이 다른 범위의 매니페스트를 전제로 한 대화라 모델이 혼동할
  //   수 있다(이 워커는 그 경우를 별도로 방어하지 않는다).
  const scopedManifest = filterManifestByScope(manifest, scope);

  const userContent = buildUserContentWithAttachment(message, attachment);
  const messages = buildMessages(HONDI_SEARCH_SP, scopedManifest, history, userContent, scope);

  let parsed;
  try {
    const deepseekData = await deepseekChat({
      env,
      model: HONDI_SEARCH_MODEL,
      messages,
      max_tokens: 500,
    });
    const rawText = deepseekData?.choices?.[0]?.message?.content ?? '{}';
    parsed = safeParseJson(rawText);

    // 2026-09-10 수정 — 모델이 만든 url 문자열을 신뢰하지 않는다. navigate/
    // candidates는 manifest_path만 받고, 실제 이동 URL은 여기서 매니페스트의
    // pc_url을 직접 조회해 채운다. path가 매니페스트에 없으면(환각) PC 검색
    // 전용 엔드포인트가 존재하지도 않는 곳으로, 혹은 webapp.html 같은 모바일
    // 화면으로 사용자를 보내는 대신 안전하게 명확화 질문으로 되돌린다.
    if (parsed.type === 'navigate') {
      const resolvedUrl = resolveManifestUrl(parsed.manifest_path, scopedManifest);
      if (!resolvedUrl) {
        parsed = {
          type: 'clarify',
          message: '정확히 어떤 페이지를 찾으시는지 다시 한번 말씀해주시겠어요?',
        };
      } else {
        parsed.url = resolvedUrl;
      }
    } else if (parsed.type === 'candidates') {
      parsed.candidates = (parsed.candidates || [])
        .map((c) => ({ label: c.label, url: resolveManifestUrl(c.manifest_path, scopedManifest) }))
        .filter((c) => c.url);
    }
  } catch (e) {
    console.error('[hondi-search] deepseek 호출 실패:', e);
    return new Response(
      JSON.stringify({
        type: 'clarify',
        message: '검색 엔진 연결에 문제가 있습니다. 잠시 후 다시 시도해주세요.',
      }),
      { status: 200, headers: corsHeaders }
    );
  }

  const newHistory = [
    ...history,
    { role: 'user', content: message },
    { role: 'assistant', content: parsed.message || '' },
  ];

  if (parsed.type !== 'navigate') {
    await saveHistory(env, conversation_id, newHistory);
  } else if (conversation_id) {
    // navigate로 종료되면 세션 정리
    await env.HONDI_SEARCH_HISTORY.delete(`conv:${conversation_id}`);
  }

  return new Response(JSON.stringify(parsed), { status: 200, headers: corsHeaders });
}
