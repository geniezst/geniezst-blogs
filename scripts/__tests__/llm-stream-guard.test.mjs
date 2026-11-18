/**
 * llm.mjs 스트리밍 폭주 가드 테스트 (fetch 를 모킹하므로 네트워크·API 키 불필요)
 *
 * 2026-11-17: 비스트리밍에서는 641,551자 폭주가 끝난 뒤에야 잘림을 알았다.
 * 스트리밍으로 바꾸면서 "같은 문자 400자 연속" 시점에 연결을 끊고 재시도로 넘어가는지 검증한다.
 */
import { callGemini } from '../lib/llm.mjs';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✅', label, extra);
  } else {
    fail++;
    console.log('  ❌', label, extra);
  }
};

const realFetch = globalThis.fetch;
const encoder = new TextEncoder();

function sseResponse(chunks) {
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
        else controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

const event = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const textEvent = (text, extra = {}) =>
  event({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

const env = { GEMINI_API_KEY: 'test-key', GEMINI_API_URL: 'https://mock.local/v1beta' };
const base = { env, models: ['gemini-2.5-flash'], transientRetry: 0, log: () => {}, timeoutMs: 5000 };

console.log('\n[llm-stream-guard] 스트리밍 폭주 차단');

// 1) 정상 스트리밍
globalThis.fetch = async () =>
  sseResponse([
    textEvent('안녕하세요. '),
    textEvent('표는 |---| 로 씁니다.'),
    event({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 12 } }),
  ]);
try {
  const r = await callGemini({ ...base, userPrompt: '테스트' });
  ok('정상 스트리밍 응답 결합', r.text === '안녕하세요. 표는 |---| 로 씁니다.', JSON.stringify(r.text));
  ok('finishReason 노출', r.usage?.candidatesTokenCount === 12);
} catch (err) {
  ok('정상 스트리밍 응답 결합', false, err.message);
}

// 2) 하이픈 폭주 → 400자 시점에 즉시 중단
globalThis.fetch = async () =>
  sseResponse([
    textEvent('## 표\n| 항목 | 기준 |\n| :'),
    textEvent('-'.repeat(500)),
    textEvent('이 줄은 도달하면 안 됩니다.'),
  ]);
try {
  await callGemini({ ...base, userPrompt: '테스트' });
  ok('하이픈 폭주 즉시 중단', false, '예외가 발생하지 않음');
} catch (err) {
  ok('하이픈 폭주 즉시 중단', err.truncated === true && err.runaway === true, err.message.slice(0, 80));
  ok(
    '중단 이후 청크는 읽지 않음',
    !(err.partialText || '').includes('도달하면') && (err.partialText || '').length < 2000,
    `(${(err.partialText || '').length}자)`
  );
}

// 3) 공백 폭주 → 동일하게 중단
globalThis.fetch = async () => sseResponse([textEvent('| 항목' + ' '.repeat(500) + '| 기준 |')]);
try {
  await callGemini({ ...base, userPrompt: '테스트' });
  ok('공백 폭주 즉시 중단', false, '예외가 발생하지 않음');
} catch (err) {
  ok('공백 폭주 즉시 중단', err.runaway === true, err.message.slice(0, 60));
}

// 4) MAX_TOKENS 는 기존대로 잘림으로 표면화 + 원인 진단
globalThis.fetch = async () =>
  sseResponse([
    textEvent('-'.repeat(300)),
    event({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { candidatesTokenCount: 900 } }),
  ]);
try {
  await callGemini({ ...base, userPrompt: '테스트' });
  ok('MAX_TOKENS 감지', false, '예외가 발생하지 않음');
} catch (err) {
  ok('MAX_TOKENS 감지', err.truncated === true);
  ok('표 정렬 폭주 원인을 메시지에 명시', /표 구분선은 \|---\|/.test(err.message), err.message.slice(0, 100));
}

// 5) 그라운딩 메타데이터 병합 (검색어/출처가 중간 청크에 흩어져 와도 유지)
globalThis.fetch = async () =>
  sseResponse([
    textEvent('{"verdict":"pass"}', { groundingMetadata: { webSearchQueries: ['국민연금 임의가입'] } }),
    textEvent('', { groundingMetadata: { groundingChunks: [{ web: { title: '국민연금공단', uri: 'https://nps.or.kr' } }] }, finishReason: 'STOP' }),
  ]);
try {
  const r = await callGemini({ ...base, userPrompt: '테스트', googleSearch: true });
  ok('검색어 병합', r.grounding.queries[0] === '국민연금 임의가입');
  ok('출처 병합', r.grounding.chunks[0]?.uri === 'https://nps.or.kr');
} catch (err) {
  ok('검색어·출처 병합', false, err.message);
}

// 6) stream:false 경로도 기존대로 동작
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: '비스트리밍 응답' }] }, finishReason: 'STOP' }],
      usageMetadata: { candidatesTokenCount: 5 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
try {
  const r = await callGemini({ ...base, userPrompt: '테스트', stream: false });
  ok('비스트리밍 경로 유지', r.text === '비스트리밍 응답');
} catch (err) {
  ok('비스트리밍 경로 유지', false, err.message);
}

globalThis.fetch = realFetch;

console.log(`\n===== llm-stream-guard 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail ? 1 : 0);
