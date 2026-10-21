// fact-pipeline 순수 함수 단위 테스트 (네트워크·LLM 호출 없음)
import { tidyHeadings, enforceAllowedLinks, normalizeUrl } from '../lib/fact-pipeline.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); }
};

ok('소제목 번호 제거', tidyHeadings('## 1. 개요\n### 2.1 세부') === '## 개요\n### 세부');
ok('번호 아닌 숫자로 시작하는 소제목 유지', tidyHeadings('## 2026 근로장려금 일정\n## 3 가지 함정\n## 3.3% 원천징수\n## 2) 신청') === '## 2026 근로장려금 일정\n## 3 가지 함정\n## 3.3% 원천징수\n## 신청');
ok('코드 블록 안 헤딩은 유지', tidyHeadings('```\n## 3. keep\n```') === '```\n## 3. keep\n```');
ok('URL 정규화: 끝 슬래시·쿼리 무시', normalizeUrl('https://Docs.Docker.com/x/?a=1') === normalizeUrl('https://docs.docker.com/x'));

const r = enforceAllowedLinks(
  '[a](https://x.com/p) [b](/blog/ok) [c](/blog/nope) ![i](https://y.com/i.png) [d](https://docs.docker.com/x/) [e](https://geniezst.com/blog/z)\n```\n[k](https://code.example)\n```',
  [{ url: 'https://docs.docker.com/x' }],
  new Set(['geniezst.com']),
  new Set(['ok'])
);
ok('허용 외 외부 링크 해제', r.markdown.startsWith('a ') && r.removed.includes('https://x.com/p'));
ok('존재하지 않는 내부 글 링크 해제', !r.markdown.includes('/blog/nope') && r.removed.includes('/blog/nope'));
ok('존재하는 내부 글 링크 유지', r.markdown.includes('[b](/blog/ok)'));
ok('이미지 링크 유지', r.markdown.includes('![i](https://y.com/i.png)'));
ok('허용 목록 링크 유지(끝 슬래시 차이 무시)', r.markdown.includes('[d](https://docs.docker.com/x/)'));
ok('사이트 자체 도메인 링크 유지', r.markdown.includes('[e](https://geniezst.com/blog/z)'));
ok('코드 블록 안 링크 유지', r.markdown.includes('[k](https://code.example)'));

const adj = enforceAllowedLinks('[a](https://ok.go.kr)[b](https://x.com)', [{ url: 'https://ok.go.kr' }], new Set());
ok('붙어 있는 링크도 각각 검사', adj.markdown === '[a](https://ok.go.kr)b' && adj.removed.length === 1);

const adj2 = enforceAllowedLinks('[a](https://x.com/1)[b](https://x.com/2)\n[c](/blog/nope)[d](/blog/nope2)', [], new Set(), new Set());
ok('붙어 있는 링크도 모두 해제 (외부·내부)', adj2.markdown === 'ab\ncd' && adj2.removed.length === 4);
console.log(`===== 결과: ${pass} 통과 / ${fail} 실패 =====`);
if (fail) process.exit(1);
