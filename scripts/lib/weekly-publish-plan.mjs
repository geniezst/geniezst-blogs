/**
 * 주간 발행 요일 계획 (blog · blogs 공용)
 *
 * ⚠️ 이 파일은 projects/blog/scripts/lib/ 와 projects/blogs/scripts/lib/ 에 "동일한 사본"으로 존재한다.
 *    한쪽만 고치면 두 사이트의 발행 요일이 겹칠 수 있으므로 반드시 두 사본을 같이 수정한다.
 *    사양서: projects/blogs/docs/SPEC_WEEKLY_PUBLISH_PLAN.md
 *
 * 규칙 (2026-11-10):
 *  - ISO 주(월~일)마다 blog 2~3회, blogs 2~3회 발행 요일을 랜덤 배정한다.
 *  - 두 사이트의 발행 요일은 절대 겹치지 않는다 (같은 셔플 결과를 앞/뒤로 나눠 가짐).
 *  - 주차 ID 를 시드로 한 결정적 의사난수라서 두 데몬이 상태 파일을 공유하지 않아도
 *    같은 계획을 계산하고, 데몬을 재시작해도 계획이 바뀌지 않는다.
 */
import crypto from 'node:crypto';

export const PLAN_SALT = 'geniezst-weekly-publish-plan-v1';
export const PLAN_SITES = ['blog', 'blogs'];
export const DAY_NAMES_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

/** 'YYYY-MM-DD' → 0(일)~6(토) */
export function dayOfWeekOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** 'YYYY-MM-DD' → ISO 8601 주차 ID (예: 2026-W46). 서버 타임존과 무관하게 UTC 로만 계산한다. */
export function isoWeekId(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const weekNo = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** 주차 ID → { week, blog: [요일...], blogs: [요일...] } (요일은 0=일 ~ 6=토, 오름차순) */
export function getWeeklyPublishPlan(weekId) {
  const h = crypto.createHash('sha256').update(`${PLAN_SALT}:${weekId}`).digest();
  const days = [0, 1, 2, 3, 4, 5, 6];
  for (let i = days.length - 1; i > 0; i--) {
    const j = h.readUInt32BE((6 - i) * 4) % (i + 1);
    [days[i], days[j]] = [days[j], days[i]];
  }
  const blogCount = 2 + (h[28] & 1);
  const blogsCount = 2 + (h[29] & 1);
  const sort = (a) => [...a].sort((x, y) => x - y);
  return {
    week: weekId,
    blog: sort(days.slice(0, blogCount)),
    blogs: sort(days.slice(blogCount, blogCount + blogsCount)),
  };
}

/** 사이트·날짜 기준 이번 주 발행 계획 */
export function getSitePublishPlan(site, dateStr) {
  if (!PLAN_SITES.includes(site)) throw new Error(`알 수 없는 사이트: ${site}`);
  const plan = getWeeklyPublishPlan(isoWeekId(dateStr));
  const days = plan[site];
  const dayOfWeek = dayOfWeekOf(dateStr);
  return {
    week: plan.week,
    publish_days: days,
    publish_day_names: days.map((d) => DAY_NAMES_KO[d]),
    other_site_days: plan[PLAN_SITES.find((s) => s !== site)],
    is_publish_day: days.includes(dayOfWeek),
    day_name: DAY_NAMES_KO[dayOfWeek],
  };
}
