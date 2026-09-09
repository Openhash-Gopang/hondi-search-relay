# hondi-search-relay 배포 절차

`hondi-proxy`(worker.js)와 완전히 별개인 전용 Worker다. 배경/근거는
`wrangler.toml` 상단 주석 참고.

## 0. 위치 주의

**반드시 `C:\Users\<사용자>\...` 프로필 트리 바깥에서 배포할 것.**
예: `C:\temp\hondi-search-relay`. 프로필 안에서 실행하면 `wrangler`가
`Application Data` junction에 걸려 매번 권한 에러로 실패한다(이 PC에서
실증 확인됨).

## 1. 시크릿 등록 (최초 1회, 필수)

`DEEPSEEK_API_KEY`는 Worker 간에 공유되지 않는다 — hondi-proxy에 이미
등록된 것과 **같은 값**을 이 Worker에도 별도로 등록해야 한다:

```powershell
cd C:\temp\hondi-search-relay
wrangler secret put DEEPSEEK_API_KEY
# 프롬프트가 뜨면 hondi-proxy와 동일한 키 값을 붙여넣는다
```

(시크릿 값은 CLI/대시보드 어디서도 다시 조회할 수 없다 — 기존에 보관해둔
값을 쓰거나, 새로 발급해서 hondi-proxy 쪽도 같이 갱신해야 한다.)

## 2. 배포

```powershell
wrangler deploy
```

성공하면 `hondi.net/hondi-search` Route가 이 Worker로 연결된다.

## 3. 검증

```powershell
# 기능 확인 — 실제 페르소나 질의
curl.exe -i "https://hondi.net/hondi-search" -X POST -H "Content-Type: application/json" -d '{\"conversation_id\":\"test-1\",\"message\":\"내과 의사\"}'
# → type: navigate, sp-editor.html 링크가 담긴 JSON이 와야 정상

# 사이트 전역 재확인 — 1042 재발 여부
curl.exe -i "https://hondi-proxy.tensor-city.workers.dev/deepseek" -H "Origin: https://hondi.net"
# → 1042 없이 정상 4xx/JSON 응답이어야 함 (test-route-probe 실험에서 이미
#   1042 없음을 확인했지만, 실제 이 Worker로 한 번 더 재확인하는 것)
```

두 검증 모두 통과하면 완료. 문제 있으면 `wrangler tail`로 실시간 로그
확인.

## 4. hondi 저장소(main)는 그대로 둘 것

`Openhash-Gopang/hondi`의 `wrangler.toml`에는 이미 `hondi.net/hondi-search`
Route가 주석 처리되어 있다(2026-09-09, 커밋 `d5c1b061`) — 그 상태 그대로
두면 된다. 그 Route를 다시 켜면 원래 사고가 재발한다. `src/routes/
hondi-search-worker.js`(hondi 저장소 쪽 원본)는 참고용으로 남겨두거나,
혼란 방지를 위해 이 Worker로 완전히 이관됐다는 주석을 추가해도 좋다 —
실제 서빙에는 더 이상 관여하지 않는다.
