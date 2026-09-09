// hondi-search-relay — 혼디 검색(/hondi-search) 전용 Worker.
//
// hondi-proxy(Openhash-Gopang/hondi, worker.js)와 완전히 별개의 Worker다.
// 2026-09-09 세션에서 실증 확정된 사실(D안 검증, test-route-probe 실험) —
// Cloudflare Error 1042는 "그 zone(hondi.net)에 Route를 가진 바로 그
// Worker"의 workers.dev 직접 호출만 막는다. hondi-proxy는 이 zone에
// Route가 없으므로(2026-09-09 제거됨), 나머지 50개 파일이 참조하는
// hondi-proxy.tensor-city.workers.dev 호출은 이 Worker와 무관하게 계속
// 정상 동작한다.
//
// 이 Worker는 딱 한 가지 요청(POST /hondi-search)만 처리한다. 로직은
// hondi-search-worker.js(원본 그대로, 수정 없음)에 있고, 여기서는 CORS와
// 라우팅만 감싼다 — worker.js의 getCorsOrigin/buildCorsHeaders/_err와
// 동일한 계약을 유지해, 클라이언트(desktop.html)는 어느 Worker가 응답하는지
// 신경 쓸 필요가 없다.
//
// 필요 배포 준비물(README 참고):
//   1. wrangler.toml의 HONDI_SEARCH_HISTORY KV id — hondi-proxy와 동일한
//      네임스페이스를 그대로 재사용(이미 채워져 있음, 별도 발급 불필요).
//   2. wrangler secret put DEEPSEEK_API_KEY — hondi-proxy가 쓰는 것과
//      동일한 키 값을 이 Worker에도 별도로 등록해야 한다(시크릿은 Worker간
//      공유되지 않음).

import { handleHondiSearch } from './hondi-search-worker.js';

// worker.js:56의 ALLOWED_ORIGINS와 100% 동일하게 유지할 것 — 필요하면
// 그쪽이 갱신될 때 여기도 같이 갱신한다. 이 Worker는 사실상 hondi.net
// Route로만 호출되므로 실제로는 'https://hondi.net' 하나만 매칭되지만,
// 원본과 동일한 계약을 유지하기 위해 전체 목록을 그대로 가져온다.
const ALLOWED_ORIGINS = [
  'https://hondi.net',
  'https://www.hondi.net',
  'https://klaw.hondi.net',
  'https://market.hondi.net',
  'https://tax.hondi.net',
  'https://gdc.hondi.net',
  'https://health.hondi.net',
  'https://school.hondi.net',
  'https://public.hondi.net',
  'https://security.hondi.net',
  'https://democracy.hondi.net',
  'https://police.hondi.net',
  'https://insurance.hondi.net',
  'https://911.hondi.net',
  'https://stock.hondi.net',
  'https://traffic.hondi.net',
  'https://logistics.hondi.net',
];

function getCorsOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) return origin;
  if (origin === '') return '';
  return null;
}

function buildCorsHeaders(corsOrigin, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extra,
  };
}

// worker.js:2697의 _err와 동일 계약 — handleHondiSearch가 이 함수를
// _err(status, code, detail, corsHeaders) 형태로 호출한다.
function _err(status, code, detail, corsHeaders) {
  return new Response(
    JSON.stringify({ ok: false, error: code, message: detail, detail }),
    { status, headers: corsHeaders }
  );
}

export default {
  async fetch(request, env) {
    const corsOrigin = getCorsOrigin(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin ?? 'null',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (corsOrigin === null) {
      return new Response(
        JSON.stringify({ error: 'Forbidden', origin: request.headers.get('Origin') }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const corsHeaders = buildCorsHeaders(corsOrigin);
    const url = new URL(request.url);

    if (url.pathname === '/hondi-search' && request.method === 'POST') {
      return handleHondiSearch(request, env, corsHeaders, { _err });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: corsHeaders,
    });
  },
};
