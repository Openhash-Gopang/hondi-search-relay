// ============================================================
// src/gopang/core/deepseek-client.js
// ============================================================
// 2026-07-14 신설 — "DeepSeek 레거시 별칭 폐기" 대응 중 발견된 문제(6개+
// 파일이 각자 api.deepseek.com을 직접 fetch하며 모델명을 개별 하드코딩)를
// 근본적으로 해소하기 위한 단일 진입점.
//
// 이 모듈이 있기 전:
//   ai_assistant.js, location.js, review.js, profile.js,
//   ai_setup_worker.js, ai-chat-handler.js 각각이 자체 fetch +
//   자체 하드코딩 모델명으로 api.deepseek.com을 호출 → 벤더가 별칭을
//   바꿀 때마다(이번처럼) 6곳 이상을 일일이 찾아 고쳐야 했다.
//
// 이 모듈이 생긴 후:
//   위 파일들은 이 모듈의 deepseekChat()만 호출한다. 모델명 매핑은
//   MODEL_ALIAS 한 곳에서만 관리하므로, 다음 벤더 별칭 변경 때는
//   이 파일 하나만 고치면 된다.
//
// 주의: 이 모듈은 반드시 Worker(서버) 실행 컨텍스트에서만 import한다.
// env.DEEPSEEK_API_KEY는 Cloudflare Worker 시크릿이며 브라우저에는
// 전달되지 않는다 — 프런트엔드(webapp.html/call-ai.js)는 이미
// /deepseek, /llm/relay 같은 worker.js 프록시 엔드포인트를 거치도록
// 되어 있으므로 이 모듈을 직접 import하지 않는다.
//
// worker.js 자체의 callDeepSeek()(메인 챗 경로 — 과금·쿼터·캐시·
// UNIVERSAL 주입까지 포함하는 훨씬 무거운 함수)는 이 모듈과 별개로
// 유지한다. 다만 방어선으로 MODEL_ALIAS를 함께 import해서, 클라이언트가
// (알 수 없는 경로로) 레거시 별칭을 그대로 보내오는 경우에도 안전망 역할을
//하도록 한다.
// ============================================================

export const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

// 레거시 별칭(2026-07-24 폐기 예정) → 정식 V4 모델 ID.
// 향후 벤더가 또 별칭을 바꾸면 이 표만 갱신하면 전체 코드베이스에 반영된다.
export const MODEL_ALIAS = {
  'deepseek-chat':     'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v3':       'deepseek-v4-flash',
};

export function resolveDeepseekModel(model) {
  return MODEL_ALIAS[model] || model || 'deepseek-v4-flash';
}

// 2026-0X-XX 신설 — DeepSeek 공식 문서 확인 결과 deepseek-v4-flash/-pro를
// model 파라미터로 직접 호출하면 thinking(사고) 모드가 기본값 enabled,
// effort는 기본 high다("The thinking toggle defaults to enabled" — 공식
// Thinking Mode 가이드). 레거시 별칭 시절 "혼디 Flash"="deepseek-chat"은
// 명시적으로 비사고 모드였는데(위 파일 헤더 원 설계 의도), 별칭을 정식
// ID로 바꾸면서 이 파라미터를 명시하지 않아 그동안 조용히 사고 모드로
// 돌고 있었을 가능성이 높다(응답당 2~5배 느려지고 출력 토큰도 그만큼
// 늘어남 — reasoning_content가 과금 대상 output에 포함됨). resolvedModel이
// deepseek-v4-flash면 명시적으로 비활성화, deepseek-v4-pro는 원래도
// 사고 모드가 의도(구 별칭 deepseek-reasoner)였으므로 그대로 활성 유지.
function _defaultThinkingFor(resolvedModel) {
  return { type: resolvedModel === 'deepseek-v4-flash' ? 'disabled' : 'enabled' };
}

/**
 * 단일화된 DeepSeek 호출 헬퍼 (non-streaming).
 * @param {object} p
 * @param {object} [p.env]        - Worker env (DEEPSEEK_API_KEY 시크릿 포함)
 * @param {string} [p.apiKey]     - 명시적으로 넘기면 이 키를 우선 사용
 *                                  (테넌트/업체가 자기 키를 등록한 경우 등)
 * @param {string} [p.model]      - 논리 모델명 또는 레거시 별칭. resolveDeepseekModel로 정규화됨
 * @param {Array}  p.messages     - OpenAI 호환 messages 배열
 * @param {number} [p.max_tokens]
 * @param {number} [p.temperature]
 * @param {number} [p.timeoutMs]
 * @returns {Promise<object>} DeepSeek API 원본 JSON 응답
 */
export async function deepseekChat({
  env, apiKey, model, messages, max_tokens = 512, temperature, timeoutMs = 15000, thinking,
}) {
  const key = apiKey || env?.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY_MISSING');
  if (!Array.isArray(messages) || !messages.length) throw new Error('DEEPSEEK_MESSAGES_REQUIRED');

  const resolvedModel = resolveDeepseekModel(model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens,
        ...(temperature != null ? { temperature } : {}),
        thinking: thinking || _defaultThinkingFor(resolvedModel),
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      let errMsg; try { errMsg = JSON.parse(errText)?.error?.message; } catch {}
      throw new Error(errMsg || `DEEPSEEK_HTTP_${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('DEEPSEEK_TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 자주 쓰는 패턴(응답 텍스트만 필요) 편의 함수.
 * 실패 시 예외를 던지지 않고 fallbackText를 반환한다(번역류 호출에 적합).
 */
export async function deepseekChatText({
  env, apiKey, model, messages, max_tokens, temperature, timeoutMs, fallbackText = '',
}) {
  try {
    const data = await deepseekChat({ env, apiKey, model, messages, max_tokens, temperature, timeoutMs });
    return data.choices?.[0]?.message?.content?.trim() || fallbackText;
  } catch {
    return fallbackText;
  }
}
