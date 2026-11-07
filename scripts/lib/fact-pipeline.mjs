/**
 * [SHARED] 근거 기반 글 생성 파이프라인 — 리서치 / 출처 검증 / 팩트체크
 *
 * [왜 필요한가]
 * 자동 글은 검색 없이 모델 기억만으로 쓰여, 수동 검수 때마다 수치·자격 기준·명령 옵션·
 * 이벤트 ID 의미 오류와 지어낸 출력, 무관한 참고 링크가 나왔다 (2026-10-19~21).
 * → 리서치(검색 그라운딩) 브리프로 집필하고, 발행 전 검색 기반 팩트체크로 교정한다.
 *
 * 2026-10 실측: 이 키의 검색 그라운딩은 gemini-2.5-flash 만 허용된다 (3.x 는 429).
 * 사양: docs/SPEC_FACT_GROUNDED_PIPELINE.md
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/fact-pipeline.mjs (동일 사본)
 */

import fs from 'node:fs';
import path from 'node:path';
import { callGemini } from './llm.mjs';

// 2.5-flash 가 503(과부하)일 때 2.5-flash-lite 로 넘어간다 (둘 다 무료 키 그라운딩 가능, 2026-10-21 확인)
export const GROUNDED_MODELS = ['gemini-2.5-flash']; // flash-lite 는 검색은 하지만 출처(groundingChunks)를 돌려주지 않아 리서치 게이트를 통과할 수 없다
export const WRITER_MODELS = ['gemini-2.5-flash'];
export const REPORT_MARKER = '===FACTCHECK_REPORT===';

const UA = 'Mozilla/5.0 (compatible; BlogQualityChecker/1.0)';

async function fetchStatus(url, { redirect = 'follow', timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': UA }, redirect, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, location: res.headers.get('location'), finalUrl: res.url };
  } catch (err) {
    return { status: 0, error: err?.cause?.code || err?.name || 'error' };
  }
}

/**
 * 검색 그라운딩 호출. 모델이 검색을 건너뛰면(webSearchQueries 0개) 기억만으로 답한 것이므로
 * 검색 지시를 강화해 한 번 더 호출하고, 그래도 0회면 품질 게이트 실패로 던진다.
 * (2026-10-21 시험: 리서치·팩트체크 각 1회씩 '검색 0회' 응답 발생)
 */
async function callGroundedRequired(params, stage) {
  for (let i = 0; i < 2; i++) {
    const userPrompt = i === 0
      ? params.userPrompt
      : `${params.userPrompt}\n\n[필수] 답하기 전에 반드시 google_search 도구로 핵심 주장마다 검색하세요. 검색 없이 기억으로 답하면 무효입니다.`;
    const res = await callGemini({ ...params, userPrompt, models: GROUNDED_MODELS, googleSearch: true, backoffBaseMs: 8000 });
    if (res.grounding.queries.length > 0) return res;
    params.log?.(`⚠️ [${stage}] 모델이 검색을 수행하지 않았습니다 (시도 ${i + 1}/2)`);
  }
  const err = new Error(`[${stage} 실패] 검색 그라운딩이 수행되지 않아 사실 확인 불가`);
  err.qualityGate = true;
  throw err;
}

/** 비교용 URL 정규화 (쿼리·해시·끝 슬래시 제거, 호스트 소문자) */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.toLowerCase()}${decodeURI(u.pathname).replace(/\/+$/, '')}`;
  } catch {
    return String(url).trim();
  }
}

/**
 * 그라운딩 출처(리다이렉트 URI)를 실제 URL 로 풀고, 도메인 정책으로 거른 뒤 접속을 확인한다.
 * @param {Array<{title: string, uri: string}>} chunks
 * @param {{ official: RegExp[], blocked: RegExp[], allowNeutral: boolean }} policy
 * @returns {Promise<Array<{ title: string, url: string, official: boolean }>>}
 */
export async function resolveSources(chunks, policy) {
  const seen = new Set();
  const resolved = await Promise.all(
    chunks.map(async (c) => {
      let url = c.uri;
      if (/grounding-api-redirect/.test(url)) {
        const r = await fetchStatus(url, { redirect: 'manual' });
        if (!r.location) return null;
        url = r.location;
      }
      return { title: c.title, url };
    })
  );
  const candidates = [];
  for (const s of resolved) {
    if (!s) continue;
    let host;
    try {
      const u = new URL(s.url);
      u.searchParams.delete('hl');
      s.url = u.toString();
      host = u.hostname.toLowerCase();
    } catch {
      continue;
    }
    const key = normalizeUrl(s.url);
    if (seen.has(key)) continue;
    seen.add(key);
    if (policy.blocked.some((re) => re.test(host))) continue;
    const official = policy.official.some((re) => re.test(host));
    if (!official && !policy.allowNeutral) continue;
    candidates.push({ ...s, official });
  }
  const checked = await Promise.all(
    candidates.map(async (s) => ({ ...s, status: (await fetchStatus(s.url)).status }))
  );
  return checked
    .filter((s) => s.status >= 200 && s.status < 300)
    .sort((a, b) => Number(b.official) - Number(a.official))
    .map(({ title, url, official }) => ({ title, url, official }));
}

/**
 * 1단계 리서치: 주제 선정 + 출처가 붙은 사실 브리프 (검색 그라운딩)
 * @returns {Promise<{ topic: string, brief: string, sources: Array<{title: string, url: string, official: boolean}>, queries: string[] }>}
 */
export async function researchTopic({ env, log, site, category, topicGuide, excludedList, avoidTopics = [], dateStr }) {
  const systemPrompt = `당신은 ${site.name}의 리서처입니다. Google 검색으로 확인한 사실만 기록합니다. 기억에 의존한 수치·기준·명령·버전은 쓰지 않습니다. 오늘 날짜는 ${dateStr} 입니다.`;
  const userPrompt = `[카테고리] ${category}
[사이트 성격] ${site.audience}
[주제 선정 가이드]
${topicGuide}

[이미 발행된 주제 — 같은 주제·사실상 같은 글 금지]
${excludedList || '(없음)'}
${avoidTopics.length ? `[이번 실행에서 이미 탈락한 주제 — 다시 고르지 말 것] ${avoidTopics.join(', ')}` : ''}

[할 일]
1. 위 카테고리에서 독자가 실제로 검색할 만한 구체적인 주제 1개를 고르세요. 공식 자료로 사실을 확인할 수 있는 주제여야 합니다.
2. 그 주제를 Google 검색으로 조사하세요. ${site.sourceRule}
3. 아래 형식 그대로만 출력하세요. 다른 말은 쓰지 마세요.

TOPIC: <한국어 주제 한 줄>
SLUG_HINT: <english-kebab-case>
ANGLE: <독자가 처한 상황과 검색 의도 1~2문장>
FACTS:
- <구체적 사실 한 문장: 수치·조건·명령/옵션·버전·일정> (출처: <기관 또는 문서명>, 기준: <날짜·연도·버전>)
(12~25개. 검색으로 확인한 것만. 확인 못 한 것은 쓰지 말 것)
PITFALLS:
- <흔히 잘못 알려진 내용 → 정확한 내용> (출처: ...)
OUT_OF_SCOPE:
- <조사했지만 확인하지 못해 글에서 단정하면 안 되는 내용>`;

  const res = await callGroundedRequired({
    systemPrompt,
    userPrompt,
    env,
    thinkingBudget: 2048,
    maxOutputTokens: 12288,
    temperature: 0.4,
    log,
  }, '리서치');
  const topic = (res.text.match(/^TOPIC:\s*(.+)$/m) || [])[1]?.trim();
  const factCount = (res.text.split(/^FACTS:/m)[1] || '').split(/^PITFALLS:/m)[0].match(/^- /gm)?.length || 0;
  if (!topic || factCount < 6) {
    const err = new Error(`[리서치 실패] 브리프 형식 미달 (TOPIC ${topic ? 'O' : 'X'}, FACTS ${factCount}개)`);
    err.qualityGate = true;
    throw err;
  }
  const sources = await resolveSources(res.grounding.chunks, site.sourcePolicy);
  log(`🔎 [리서치] 주제: ${topic} | 사실 ${factCount}개 | 검색 ${res.grounding.queries.length}회 | 검증된 출처 ${sources.length}개 (공식 ${sources.filter((s) => s.official).length})`);
  return { topic, brief: res.text.trim(), sources, queries: res.grounding.queries };
}

/**
 * 참고 링크 허용 목록 = 리서치 출처(검증 완료) + 부족 시 사이트 안전 링크(접속 확인 후)
 */
export async function buildAllowedRefs(sources, fallbackRefs, minRefs) {
  const allowed = sources.slice(0, 8);
  if (allowed.filter((s) => s.official).length < minRefs) {
    const extra = await Promise.all(
      fallbackRefs.map(async (r) => ({ ...r, official: true, ok: (await fetchStatus(r.url)).status === 200 }))
    );
    for (const r of extra) {
      if (r.ok && !allowed.some((a) => normalizeUrl(a.url) === normalizeUrl(r.url))) allowed.push({ title: r.title, url: r.url, official: true });
    }
  }
  return allowed;
}

export function formatAllowedRefs(allowed) {
  return allowed.map((s) => `- ${s.title} | ${s.url}`).join('\n');
}

/**
 * 허용 목록·내부 도메인 밖의 외부 링크, 그리고 존재하지 않는 내부 글(/blog/<slug>) 링크는
 * 링크를 풀어 텍스트만 남긴다 (코드 블록 제외).
 * @param {Set<string>} [validSlugs] 실제 발행 글 slug 목록. 주어지면 내부 링크도 검사한다.
 * @returns {{ markdown: string, removed: string[] }}
 */
export function enforceAllowedLinks(markdown, allowed, internalHosts, validSlugs = null) {
  const allow = new Set(allowed.map((a) => normalizeUrl(a.url)));
  const removed = [];
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  const out = parts.map((part) => {
    if (part.startsWith('```')) return part;
    if (validSlugs) {
      part = part.replace(/(?<!!)\[([^\]]+)\]\(\s*\/blog\/([a-z0-9-]+)\/?\s*\)/g, (m, text, slug) => {
        if (validSlugs.has(slug)) return m;
        removed.push(`/blog/${slug}`);
        return text;
      });
    }
    return part.replace(/(?<!!)\[([^\]]+)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (m, text, url) => {
      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch { return m; }
      if (internalHosts.has(host) || allow.has(normalizeUrl(url))) return m;
      removed.push(url);
      return text;
    });
  });
  return { markdown: out.join(''), removed };
}

/**
 * 소제목 번호('## 1. ', '## 1) ', '### 2.1 ')를 떼어 낸다 (코드 블록 제외). 프롬프트 금지 규칙을 모델이 자주 어긴다.
 * 구분 기호 없는 숫자('## 2026 연말정산', '## 3 가지')는 제목 일부이므로 남긴다 (QA 2026-10-21).
 */
export function tidyHeadings(markdown) {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith('```') ? part : part.replace(/^(#{2,4})\s+(?:\d{1,2}(?:\.\d{1,2})+\.?|\d{1,2}[.)])\s+/gm, '$1 ')))
    .join('');
}

/**
 * 3단계 팩트체크: 초안의 사실 주장을 검색으로 확인해 교정본과 보고서를 돌려준다.
 * 실패(호출 오류·형식 불량·과도한 삭제·reject)는 발행 차단(qualityGate)으로 던진다.
 * @returns {Promise<{ markdown: string, report: { verdict: string, corrections: any[], removed: any[] } }>}
 */
export async function factCheckArticle({ env, log, site, markdown: rawMarkdown, brief, allowed, dateStr }) {
  // 표 칸 맞춤용 공백·하이픈 폭주는 입력 토큰과 응답 길이를 불필요하게 키운다
  const markdown = compactTablePadding(rawMarkdown);
  const systemPrompt = `당신은 ${site.name}의 엄격한 팩트체커이자 교열자입니다. 오늘 날짜는 ${dateStr} 입니다. Google 검색으로 확인한 내용만 사실로 인정합니다.`;
  const userPrompt = `아래 [초안]을 검수해 교정본을 만드세요.

[검수 규칙]
1. 수치·금액·비율·날짜·자격 기준·법령·기관·제도명·명령어·옵션·경로·레지스트리 키·이벤트 ID·오류 코드·버전 등 모든 사실 주장을 Google 검색으로 확인하세요.
2. 틀린 내용은 정확한 내용으로 고치세요. 확인할 수 없는 구체적 주장은 확인된 범위로 일반화하거나 삭제하세요. 추측으로 채우지 마세요.
3. 폐지·통합·명칭 변경된 제도나 지원 종료된 버전·기능을 현재 유효한 것처럼 쓴 부분은 고치세요.
   '검토 중', '개정안', '발표안' 으로 쓴 내용은 오늘 날짜 기준으로 이미 시행됐는지(시행령 개정 포함), 시행일과 적용 대상이 무엇인지 확인해 고치세요. 반대로 아직 시행 전인 안을 확정된 것처럼 쓴 부분도 고치세요.
4. 실제 실행 결과처럼 꾸민 출력/로그 블록은, 공식 문서에 형식이 있으면 값 자리를 <placeholder> 로 바꾸고, 근거가 없으면 블록을 삭제하세요.
5. 명령어는 해당 OS·도구에서 실제로 존재하는 문법인지 확인하세요 (존재하지 않는 플래그·권한 문자열 금지).
6. 외부 링크는 [허용 참고 링크]에 있는 URL 만 남기세요. 그 외 외부 링크는 링크를 풀고 텍스트만 남기세요. 내부 링크(/blog/...)는 그대로 두세요.
7. Frontmatter, H2/H3 구조, 표, ':::' 디렉티브, HTML 차트 블록은 건드리지 마세요. 고친 부분 외의 문장은 바꾸지 마세요. 상투적 문구는 추가하지 마세요.
${site.factCheckExtra || ''}

[리서치 브리프 — 참고용. 브리프도 틀릴 수 있으니 검색으로 확인]
${brief}

[허용 참고 링크]
${formatAllowedRefs(allowed)}

[출력 형식 — 반드시 지킬 것]
교정된 글 전체를 다시 쓰지 마세요. 고칠 곳만 아래 JSON 하나로 출력하세요 (JSON 외 다른 글자 금지).
{"verdict":"pass|fixed|reject","corrections":[{"before":"...","after":"...","reason":"...","source":"..."}],"removed":[{"text":"...","reason":"..."}]}
- before 와 removed.text 는 [초안]에 있는 문장 일부를 한 글자도 바꾸지 말고 그대로 복사하세요. 한 줄 안의 100자 안팎, 초안에서 한 번만 나오는 조각으로 고르세요.
- after 는 before 를 대체할 문장입니다. 링크를 풀 때는 before 에 마크다운 링크 전체를, after 에 텍스트만 쓰세요.
- removed.text 는 삭제할 문장(또는 줄) 일부입니다. 그 조각이 들어 있는 문장 전체가 삭제됩니다.
- corrections 에는 실제로 문장을 바꾼 항목만 넣으세요 (확인만 하고 그대로 둔 문장은 넣지 마세요).
- verdict 는 고칠 것이 없으면 pass(배열은 비움), 고쳤으면 fixed, 글의 주제·전제 자체가 사실과 달라 교정으로 살릴 수 없으면 reject.

[초안]
${markdown}`;

  let res;
  try {
    res = await callGroundedRequired({
      systemPrompt,
      userPrompt,
      env,
      thinkingBudget: 4096,
      maxOutputTokens: 12288,
      temperature: 0.2,
      timeoutMs: 300000,
      log,
    }, '팩트체크');
  } catch (err) {
    const e = new Error(err.message.startsWith('[팩트체크') ? err.message : `[팩트체크 실패] ${err.message}`);
    e.qualityGate = true;
    throw e;
  }

  const fail = (msg) => {
    const e = new Error(`[팩트체크 게이트 실패] ${msg}`);
    e.qualityGate = true;
    return e;
  };
  const jsonText = (res.text.match(/\{[\s\S]*\}/) || [])[0];
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch {
    throw fail('보고서 JSON 파싱 실패');
  }
  if (!['pass', 'fixed', 'reject'].includes(report.verdict)) throw fail(`알 수 없는 verdict: ${report.verdict}`);
  // 모델이 '확인만 한' 문장을 교정으로 보고하는 경우가 있어 실제로 바뀐 항목만 남긴다
  report.corrections = dropUnchangedCorrections(report.corrections);
  if (report.verdict === 'reject') throw fail(`주제 전제 오류로 reject — ${JSON.stringify(report.corrections || []).slice(0, 200)}`);

  // 교정 목록을 원문에 직접 적용한다 (전체 글을 다시 받지 않으므로 호출당 출력이 작다)
  const applied = applyFactCheckPatches(markdown, report);
  const corrected = applied.markdown;
  if (applied.unapplied > 0) log(`⚠️ [팩트체크] 원문에서 찾지 못한 교정 ${applied.unapplied}건은 적용하지 못했습니다.`);
  if (applied.total > 0 && applied.applied === 0) throw fail('교정 항목을 원문에 하나도 적용하지 못함');
  const n = Array.isArray(report.corrections) ? report.corrections.length : 0;
  const r = Array.isArray(report.removed) ? report.removed.length : 0;
  log(`🧪 [팩트체크] verdict=${report.verdict} | 교정 ${n}건 | 삭제 ${r}건 | 검색 ${res.grounding.queries.length}회`);
  return { markdown: corrected, report: { ...report, queries: res.grounding.queries } };
}

/** 표 칸 맞춤용 공백 연속과 구분선 하이픈 연속을 줄인다 (코드 블록은 건드리지 않음) */
export function compactTablePadding(md) {
  let inCode = false;
  return String(md || '').split('\n').map((line) => {
    if (line.trim().startsWith('```')) { inCode = !inCode; return line; }
    if (inCode || !/^\s*\|.*\|\s*$/.test(line)) return line;
    return line.replace(/:-{4,}/g, ':---').replace(/-{4,}:/g, '---:').replace(/-{4,}/g, '---').replace(/[ \t]{2,}/g, ' ');
  }).join('\n');
}

/**
 * 팩트체크 보고서의 corrections(before→after)와 removed(text) 를 마크다운에 적용한다.
 * before 가 원문에 없거나 둘 이상 나오면 적용하지 않고 unapplied 로 센다.
 */
export function applyFactCheckPatches(markdown, report) {
  let out = markdown;
  let total = 0, applied = 0, unapplied = 0;
  const once = (needle) => needle && out.indexOf(needle) !== -1 && out.indexOf(needle) === out.lastIndexOf(needle);
  for (const c of Array.isArray(report.corrections) ? report.corrections : []) {
    if (!c || typeof c !== 'object' || String(c.before ?? '').trim() === String(c.after ?? '').trim()) continue;
    total++;
    const before = String(c.before ?? '');
    if (once(before)) { out = out.replace(before, () => String(c.after ?? '')); applied++; } else unapplied++;
  }
  for (const rm of Array.isArray(report.removed) ? report.removed : []) {
    const text = String(rm?.text ?? '');
    if (!text) continue;
    total++;
    if (!once(text)) { unapplied++; continue; }
    const at = out.indexOf(text);
    const start = out.lastIndexOf('\n', at) + 1;
    let end = out.indexOf('\n', at + text.length);
    if (end === -1) end = out.length;
    const line = out.slice(start, end);
    // 문장 단위 삭제: 줄에 다른 문장이 있으면 해당 문장 조각만 지운다
    const cut = line.length > text.length + 80 ? line.replace(text, '') : '';
    out = out.slice(0, start) + cut + out.slice(end);
    applied++;
  }
  return { markdown: out, total, applied, unapplied };
}

/**
 * before 와 after 가 (trim 기준) 같은 '확인만 한' corrections 항목을 걸러 낸다.
 * 배열이 아니면 그대로 돌려주고, 객체가 아닌 항목(null·문자열 등)은 판단할 수 없어 그대로 둔다.
 */
export function dropUnchangedCorrections(corrections) {
  if (!Array.isArray(corrections)) return corrections;
  return corrections.filter((c) => !c || typeof c !== 'object' || String(c.before ?? '').trim() !== String(c.after ?? '').trim());
}

/** 팩트체크 보고서를 data/factcheck/ 에 남긴다 (감사 추적용, 발행 경로와 무관) */
export function saveFactCheckReport(blogRoot, name, payload) {
  try {
    const dir = path.join(blogRoot, 'data', 'factcheck');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}
