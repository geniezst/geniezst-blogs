#!/usr/bin/env node
/**
 * [SHARED] 마크다운 출력 폭주(반복 문자) 방어
 *
 * [왜 필요한가 · 2026-11-17 실측]
 * Gemini 2.5 Flash 가 마크다운 표의 칸 폭을 맞추려다 같은 문자를 수십만 자 연속 출력하며
 * 출력 토큰(maxOutputTokens 24,576)을 전부 태우고 글을 끝내지 못했다.
 *   - 표 구분선에서 '-' 166,848자 연속 (truncated-2026-11-17-evening-0.md)
 *   - 표 머리글에서 공백 438,712자 연속 (truncated-2026-11-17-evening-1.md)
 *   - 11/05, 11/08, 11/17 두 건 — 보관된 잘림 덤프 4건 전부 동일 패턴
 *
 * [기존 방어의 구멍]
 * 기존 `sanitizeProseSpaces` / `compactTablePadding` 은 "줄이 | 로 끝나는 경우"에만
 * 하이픈·공백을 줄였다. 폭주가 줄 끝(마지막 |)까지 도달하지 않으면 한 글자도 줄이지
 * 못했고, 실제로 166,848자가 그대로 남았다. 또한 이 함수들은 생성이 끝난 뒤에 돌기
 * 때문에 토큰을 태우는 폭주 자체는 막지 못한다(그건 llm.mjs 의 스트리밍 가드 담당).
 *
 * [원칙]
 *   - 코드 블록(```) 안은 건드리지 않는다 (실행 예시·출력 보존).
 *   - 정상 마크다운에서 같은 문자가 20자 이상 연속할 일은 없다.
 *   - 표 구분선의 정렬 콜론(:---, ---:, :---:)은 렌더링 차이가 없으므로 |---| 로 통일한다.
 *     모델이 "정렬을 해야 한다"는 동기를 없애 폭주 발생 자체를 줄이는 것이 목적이다.
 *
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/markdown-guard.mjs
 */

export const RUNAWAY_RUN_THRESHOLD = 20;

/** 같은 문자 20자 이상 연속을 축약한다 (공백은 1자, 나머지는 3자) */
export function clampRunawayRuns(line) {
  if (!line) return line;
  return line
    .replace(/([ \t])\1{19,}/g, '$1')
    .replace(/([^\s])\1{19,}/g, (match, ch) => (ch === '-' ? '---' : ch.repeat(3)));
}

/**
 * 표 구분선(| :--- | ---: | :---: |)을 |---|---| 로 정규화한다.
 * 구분선이 아닌 줄(내용 행)은 그대로 둔다.
 */
export function normalizeTableSeparator(line) {
  const trimmed = String(line ?? '').trim();
  if (!/^\|[\s:|-]+\|$/.test(trimmed) || !trimmed.includes('-')) return line;
  const cells = trimmed.slice(1, -1).split('|');
  if (!cells.length || !cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c))) return line;
  return `|${cells.map(() => '---').join('|')}|`;
}

/** 한 줄 정리: 표 구분선 정규화 + 반복 문자 축약 */
export function sanitizeMarkdownLine(line) {
  return clampRunawayRuns(normalizeTableSeparator(line));
}

/** 코드 블록을 제외한 마크다운 전체에 적용 */
export function sanitizeMarkdownBody(md) {
  let inCode = false;
  return String(md ?? '')
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inCode = !inCode;
        return line;
      }
      return inCode ? line : sanitizeMarkdownLine(line);
    })
    .join('\n');
}

/** 폭주가 남아 있는지 검사한다 (품질 게이트용). 없으면 null */
export function findRunawayRun(md, threshold = RUNAWAY_RUN_THRESHOLD) {
  const re = new RegExp(`([^\\s])\\1{${Math.max(1, threshold) - 1},}`);
  const m = re.exec(String(md ?? ''));
  return m ? { char: m[1], length: m[0].length, index: m.index } : null;
}

export default sanitizeMarkdownBody;
