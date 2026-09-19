/**
 * 블로그 전역 설정 (Blog Site Configuration) - 생활 경제 & 복지 혜택 전문
 */

export const siteConfig = {
  // 1. 사이트 기본 메타 정보
  title: '스마트 라이프 & 머니',
  subtitle: 'Smart Life & Money Archive',
  description: '놓치면 손해보는 정부 지원금, 숨은 환급금, 생활 절세 및 스마트 소비 실전 가이드',
  url: 'https://blogs.geniezst.workers.dev',
  author: 'geniezst',
  lang: 'ko',

  // 2. 프로필 카드 정보 (사이드바에 노출)
  profile: {
    name: '스마트 머니',
    bio: '놓치기 쉬운 정부 지원금, 숨은 환급금, 생활 절세 및 필수 금융 혜택을 알기 쉽게 정리합니다.',
    avatarText: 'M',
    avatarImage: '/assets/images/avatar-shirone.webp',
    github: 'https://github.com/geniezst',
    email: '',
  },

  // 3. 상단 내비게이션 바 메뉴
  nav: [
    { href: '/', label: '홈' },
    { href: '/blog', label: '글 목록' },
    { href: '/about', label: '소개' },
  ],

  // 4. 포스트 목록 설정
  postsPerPage: 10,
};

export type SiteConfig = typeof siteConfig;
