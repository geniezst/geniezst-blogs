/**
 * D1 날짜 문자열을 ISO 8601 (+09:00, KST) 로 변환한다.
 * D1 의 CURRENT_TIMESTAMP 는 시간대 없는 UTC 문자열("YYYY-MM-DD HH:MM:SS")이므로 UTC 로 해석한다.
 * 이미 'Z' 나 오프셋이 붙어 있으면 그대로 해석한다. 해석할 수 없으면 undefined.
 */
export function toKstIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const raw = String(value).trim();
  let normalized = raw.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T00:00:00';
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) normalized += 'Z';
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return undefined;
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.toISOString().slice(0, 19)}+09:00`;
}
