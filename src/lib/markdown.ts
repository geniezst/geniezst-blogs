import { Marked } from 'marked';
import hljs from 'highlight.js';

// 언어 표시명 매핑
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  js: 'JAVASCRIPT',
  javascript: 'JAVASCRIPT',
  ts: 'TYPESCRIPT',
  typescript: 'TYPESCRIPT',
  py: 'PYTHON',
  python: 'PYTHON',
  bash: 'BASH',
  sh: 'SHELL',
  shell: 'SHELL',
  zsh: 'ZSH',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  sql: 'SQL',
  dockerfile: 'DOCKERFILE',
  docker: 'DOCKER',
  md: 'MARKDOWN',
  markdown: 'MARKDOWN',
  rust: 'RUST',
  go: 'GO',
  golang: 'GO',
  java: 'JAVA',
  kotlin: 'KOTLIN',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  cs: 'C#',
  php: 'PHP',
  ruby: 'RUBY',
  rb: 'RUBY',
  swift: 'SWIFT',
  xml: 'XML',
  text: 'TEXT',
  plaintext: 'TEXT',
};

/**
 * marked 인스턴스 생성 및 커스텀 렌더러 설정
 */
const marked = new Marked({
  gfm: true,
  breaks: false,
});

marked.use({
  // 4칸 띄어쓰기 인덴트 코드 블록 비활성화 (HTML 마크업이 실수로 코드 블록으로 변환되는 것 방지)
  tokenizer: {
    code() {
      return undefined;
    },
  },
  renderer: {
    // 1. 프리미엄 macOS 스타일 코드 블록 + 복사 버튼
    code({ text, lang }) {
      const normalizedLang = (lang || '').trim().toLowerCase().split(/\s+/)[0];
      const validLang = normalizedLang && hljs.getLanguage(normalizedLang) ? normalizedLang : 'plaintext';
      const displayLang = LANGUAGE_DISPLAY_NAMES[normalizedLang] || (normalizedLang ? normalizedLang.toUpperCase() : 'CODE');

      let highlightedCode: string;
      try {
        if (validLang === 'plaintext') {
          highlightedCode = hljs.highlightAuto(text).value;
        } else {
          highlightedCode = hljs.highlight(text, { language: validLang }).value;
        }
      } catch (err) {
        highlightedCode = hljs.highlightAuto(text).value;
      }

      return `
<div class="code-block-container w-full max-w-full min-w-0 my-6 rounded-2xl overflow-hidden border border-neutral-700/60 bg-[#161822] shadow-xl text-neutral-200">
  <div class="code-header flex items-center justify-between px-4 py-2.5 bg-[#1f2232] border-b border-neutral-700/40 select-none">
    <div class="flex items-center gap-2.5">
      <div class="flex items-center gap-1.5" aria-hidden="true">
        <span class="w-3 h-3 rounded-full bg-[#ff5f56] inline-block shadow-sm"></span>
        <span class="w-3 h-3 rounded-full bg-[#ffbd2e] inline-block shadow-sm"></span>
        <span class="w-3 h-3 rounded-full bg-[#27c93f] inline-block shadow-sm"></span>
      </div>
      <span class="ml-2 text-xs font-mono font-semibold tracking-wider text-neutral-400 uppercase">
        ${displayLang}
      </span>
    </div>
    <button
      type="button"
      class="copy-code-btn inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-medium text-neutral-300 hover:text-white bg-neutral-800/90 hover:bg-neutral-700 transition-all cursor-pointer border border-neutral-600/40 active:scale-95"
      aria-label="코드 복사"
    >
      <svg class="copy-icon w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <svg class="check-icon w-3.5 h-3.5 hidden text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span class="copy-label">복사</span>
    </button>
  </div>
  <div class="code-content w-full max-w-full overflow-hidden relative">
    <pre class="w-full max-w-full overflow-x-auto p-4 sm:p-5 text-sm font-mono leading-relaxed m-0 bg-transparent scrollbar-thin"><code class="hljs ${validLang}">${highlightedCode}</code></pre>
  </div>
</div>`.trim();
    },

    // 2. 반응형 테이블 래퍼 (marked v15 토큰 호환)
    table(token) {
      let headerHtml = '';
      let cellHtml = '';
      for (let j = 0; j < token.header.length; j++) {
        cellHtml += this.tablecell(token.header[j]);
      }
      headerHtml += this.tablerow({ text: cellHtml });

      let bodyHtml = '';
      for (let j = 0; j < token.rows.length; j++) {
        const row = token.rows[j];
        cellHtml = '';
        for (let k = 0; k < row.length; k++) {
          cellHtml += this.tablecell(row[k]);
        }
        bodyHtml += this.tablerow({ text: cellHtml });
      }
      if (bodyHtml) {
        bodyHtml = `<tbody class="divide-y divide-neutral-200 dark:divide-neutral-800 text-neutral-700 dark:text-neutral-300">${bodyHtml}</tbody>`;
      }

      return `
<div class="article-table-wrapper w-full max-w-full min-w-0 block overflow-x-auto my-6 rounded-xl border border-neutral-200 dark:border-neutral-800 shadow-sm">
  <table class="w-full text-left border-collapse text-sm">
    <thead class="bg-neutral-100 dark:bg-neutral-800/70 border-b border-neutral-200 dark:border-neutral-700 font-semibold text-neutral-900 dark:text-neutral-100">
      ${headerHtml}
    </thead>
    ${bodyHtml}
  </table>
</div>`.trim();
    },

    // 3. 외부 링크 보안 및 새창 열기
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const isExternal = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//');
      const titleAttr = title ? ` title="${title}"` : '';
      const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${titleAttr}${targetAttr} class="article-link">${text}</a>`;
    },

    // 4. 이미지 최적화 및 스타일링
    image({ href, title, text }) {
      const titleAttr = title ? ` title="${title}"` : '';
      const altAttr = text ? ` alt="${text}"` : ' alt="image"';
      return `
<figure class="my-6 w-full max-w-full overflow-hidden">
  <img src="${href}"${altAttr}${titleAttr} loading="lazy" class="rounded-2xl shadow-md max-w-full h-auto mx-auto border border-neutral-200/60 dark:border-neutral-800" />
  ${title ? `<figcaption class="text-center text-xs text-neutral-500 mt-2">${title}</figcaption>` : ''}
</figure>`.trim();
    },
  },
});

/**
 * 마크다운 본문을 안전하고 아름다운 HTML로 렌더링
 */
export async function renderMarkdown(markdown: string): Promise<string> {
  if (!markdown) return '';
  return await marked.parse(markdown);
}
