// 본문 삽입 이미지(차트·표·순서도) 생성기.
// 데이터(JSON 형태 spec) → SVG 문자열 → sharp(librsvg) → 2x WebP.
// 폰트는 Pretendard 가 fontconfig 에 등록돼 있어야 한다 (FONTCONFIG_FILE 참고: README.md).
import sharp from 'sharp';

export const W = 1200;
const PAD = 72;
const FONT = "Pretendard, 'Noto Sans CJK KR', NanumGothic, sans-serif";
const MONO = "'JetBrains Mono', 'D2Coding', 'Pretendard', monospace";

export const THEMES = {
  green: {
    bgTop: '#f4faf7', bgBottom: '#e8f3ee', card: '#ffffff', ink: '#0f2a22', sub: '#52675f', mute: '#8a9b94',
    line: '#dbe8e1', accent: '#059669', accentDark: '#065f46', accentSoft: '#d1fae5', accentTint: '#ecfdf5',
    accentLight: '#6ee7b7', warn: '#d97706', warnSoft: '#fef3c7', brand: '포켓머니',
  },
  blue: {
    bgTop: '#f5f8ff', bgBottom: '#e9f0fb', card: '#ffffff', ink: '#0f172a', sub: '#53627a', mute: '#8795ab',
    line: '#dbe4f2', accent: '#2563eb', accentDark: '#1e40af', accentSoft: '#dbeafe', accentTint: '#eff6ff',
    accentLight: '#93c5fd', warn: '#ea580c', warnSoft: '#ffedd5', brand: 'geniezst.com',
  },
};

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 글자 폭 추정 (em 단위). 한글·전각은 ≈0.97, 숫자 ≈0.58, 영문 소문자 ≈0.54 …
export function tw(text, size, weight = 500) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c >= 0x1100) w += 0.97;
    else if (ch === ' ') w += 0.27;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else if (/[a-z]/.test(ch)) w += 0.55;
    else if (/[.,:;'|!]/.test(ch)) w += 0.3;
    else if (/[()\[\]]/.test(ch)) w += 0.36;
    else w += 0.62;
  }
  return w * size * (weight >= 700 ? 1.04 : 1);
}

// maxW 안에 들어가도록 줄바꿈 (공백 우선, 없으면 글자 단위)
export function wrap(text, size, maxW, weight = 500) {
  const lines = [];
  let cur = '';
  for (const word of String(text).split(' ')) {
    const tryLine = cur ? `${cur} ${word}` : word;
    if (tw(tryLine, size, weight) <= maxW) { cur = tryLine; continue; }
    if (cur) lines.push(cur);
    if (tw(word, size, weight) <= maxW) { cur = word; continue; }
    cur = '';
    for (const ch of word) {
      if (tw(cur + ch, size, weight) > maxW) { lines.push(cur); cur = ch; } else cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function text(x, y, s, { size = 24, weight = 500, fill = '#000', anchor = 'start', font = FONT, ls } = {}) {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls ? ` letter-spacing="${ls}"` : ''}>${esc(s)}</text>`;
}
const rr = (x, y, w, h, r, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}" ${extra}/>`;

function pill(x, y, label, { fill, color, size = 20, h = 36, anchor = 'start' }) {
  const w = Math.ceil(tw(label, size, 700)) + 28;
  const px = anchor === 'end' ? x - w : x;
  return { w, svg: rr(px, y, w, h, h / 2, fill) + text(px + w / 2, y + h / 2 + size * 0.36, label, { size, weight: 700, fill: color, anchor: 'middle' }) };
}

// ── 공통 프레임 ─────────────────────────────────────────────
function frame(t, { title, subtitle, source, date }, bodyH, body) {
  // 한 줄에 들어가도록 46px → 최소 38px 까지 줄이고, 그래도 넘치면 줄바꿈
  let tsize = 46;
  while (tsize > 38 && tw(title, tsize, 800) > W - PAD * 2 - 10) tsize -= 2;
  const titleLines = wrap(title, tsize, W - PAD * 2 - 10, 800);
  let y = 64;
  let head = '';
  // 브랜드 점 + 이름
  head += `<circle cx="${PAD + 7}" cy="${y + 2}" r="7" fill="${t.accent}"/>` + text(PAD + 24, y + 9, t.brand, { size: 20, weight: 700, fill: t.accent, ls: 0.5 });
  y += 62;
  for (const ln of titleLines) { head += text(PAD, y, ln, { size: tsize, weight: 800, fill: t.ink, ls: -1 }); y += 58; }
  y -= 14;
  if (subtitle) {
    for (const ln of wrap(subtitle, 25, W - PAD * 2, 500)) { head += text(PAD, y + 8, ln, { size: 25, weight: 500, fill: t.sub }); y += 34; }
  }
  const headH = subtitle ? y + 44 : y + 8;
  const hasFoot = !!(source || date);
  const footH = hasFoot ? 84 : 44;
  const H = Math.ceil(headH + bodyH + footH);
  const foot = !hasFoot ? '' : `<line x1="${PAD}" y1="${H - footH + 8}" x2="${W - PAD}" y2="${H - footH + 8}" stroke="${t.line}" stroke-width="2"/>` +
    text(PAD, H - 30, source ? `출처  ${source}` : '', { size: 20, weight: 500, fill: t.mute }) +
    text(W - PAD, H - 30, `기준일 ${date}`, { size: 20, weight: 600, fill: t.mute, anchor: 'end' });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bgTop}"/><stop offset="1" stop-color="${t.bgBottom}"/></linearGradient>
<linearGradient id="acc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.accentDark}"/></linearGradient>
<linearGradient id="accH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.accentLight}"/><stop offset="1" stop-color="${t.accent}"/></linearGradient>
<linearGradient id="accHD" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.accentDark}"/></linearGradient>
<linearGradient id="accV" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accentLight}"/><stop offset="1" stop-color="${t.accent}"/></linearGradient>
<linearGradient id="accVD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.accentDark}"/></linearGradient>
<linearGradient id="wrn" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f59e0b"/><stop offset="1" stop-color="${t.warn}"/></linearGradient>
<filter id="sh" x="-5%" y="-10%" width="110%" height="130%"><feGaussianBlur in="SourceAlpha" stdDeviation="9"/><feOffset dy="6"/><feComponentTransfer><feFuncA type="linear" slope="0.10"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="8" fill="url(#acc)"/>
${head}
<g transform="translate(0 ${headH})">${body}</g>
${foot}
</svg>`;
  return svg;
}

const CW = W - PAD * 2; // 콘텐츠 폭

// ── 1) 순서 카드 (steps) ────────────────────────────────────
function stepsBody(t, { items }) {
  const GAP = 18, NUM = 60, PADX = 26;
  let y = 0, out = '';
  const rows = items.map((it) => {
    const tagW = it.tag ? Math.ceil(tw(it.tag, 20, 700)) + 28 : 0;
    const textW = CW - PADX * 2 - NUM - 24 - (tagW ? tagW + 24 : 0);
    const dl = it.desc ? wrap(it.desc, 22, textW, 500) : [];
    const h = Math.max(104, 30 + 36 + dl.length * 31 + 22);
    return { it, dl, h, tagW };
  });
  rows.forEach((r, i) => {
    const { it, dl, h } = r;
    const hl = it.hl;
    out += `<g filter="url(#sh)">${rr(PAD, y, CW, h, 24, t.card, hl ? `stroke="${t.warn}" stroke-width="3"` : '')}</g>`;
    const cx = PAD + PADX + NUM / 2, cy = y + h / 2;
    out += `<circle cx="${cx}" cy="${cy}" r="${NUM / 2}" fill="url(#${hl ? 'wrn' : 'acc'})"/>` + text(cx, cy + 12, it.n ?? i + 1, { size: 32, weight: 800, fill: '#fff', anchor: 'middle' });
    const tx = PAD + PADX + NUM + 24;
    const titleY = dl.length ? y + 30 + 28 : y + h / 2 + 11;
    const ty = y + (h - (36 + dl.length * 31)) / 2;
    out += text(tx, ty + 30, it.title, { size: 30, weight: 700, fill: t.ink, ls: -0.5 });
    dl.forEach((ln, k) => { out += text(tx, ty + 30 + 14 + 29 + k * 31 - 6, ln, { size: 22, weight: 500, fill: t.sub }); });
    if (r.tagW) out += pill(PAD + CW - PADX, y + h / 2 - 18, it.tag, { fill: hl ? t.warnSoft : t.accentSoft, color: hl ? '#92400e' : t.accentDark, anchor: 'end' }).svg;
    y += h + GAP;
  });
  return { svg: out, h: y - GAP };
}

// ── 2) 표 (table) ───────────────────────────────────────────
function tableBody(t, { cols, rows, widths, hlCol, mono }) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cw = widths.map((w) => (w / total) * CW);
  const X = []; cw.reduce((acc, w, i) => { X[i] = acc; return acc + w; }, 0);
  const FS = 24, PADX = 24, LH = 32;
  const headH = 70;
  const rowInfo = rows.map((r) => {
    const cells = r.map((c, i) => wrap(c, FS, cw[i] - PADX * 2, i === 0 || i === hlCol ? 700 : 500));
    const h = Math.max(78, Math.max(...cells.map((l) => l.length)) * LH + 40);
    return { cells, h };
  });
  const H = headH + rowInfo.reduce((a, r) => a + r.h, 0);
  let out = `<g filter="url(#sh)">${rr(PAD, 0, CW, H, 26, t.card)}</g>`;
  out += `<clipPath id="tc"><rect x="${PAD}" y="0" width="${CW}" height="${H}" rx="26" ry="26"/></clipPath><g clip-path="url(#tc)">`;
  out += `<rect x="${PAD}" y="0" width="${CW}" height="${headH}" fill="url(#accHD)"/>`;
  cols.forEach((c, i) => { out += text(PAD + X[i] + PADX, headH / 2 + 8, c, { size: 23, weight: 700, fill: '#fff' }); });
  let y = headH;
  rowInfo.forEach((r, ri) => {
    if (ri % 2 === 1) out += `<rect x="${PAD}" y="${y}" width="${CW}" height="${r.h}" fill="${t.accentTint}"/>`;
    if (hlCol != null) out += `<rect x="${PAD + X[hlCol]}" y="${y}" width="${cw[hlCol]}" height="${r.h}" fill="${t.accent}" opacity="0.06"/>`;
    const blockH = r.cells.reduce((m, l) => Math.max(m, l.length), 0) * LH;
    r.cells.forEach((lines, i) => {
      const startY = y + (r.h - lines.length * LH) / 2 + 24;
      lines.forEach((ln, k) => {
        out += text(PAD + X[i] + PADX, startY + k * LH, ln, { size: FS, weight: i === 0 ? 700 : i === hlCol ? 700 : 500, fill: i === 0 ? t.ink : i === hlCol ? t.accentDark : '#2c3e37', font: mono ? FONT : FONT });
      });
    });
    if (ri < rowInfo.length - 1) out += `<line x1="${PAD}" y1="${y + r.h}" x2="${PAD + CW}" y2="${y + r.h}" stroke="${t.line}" stroke-width="1.5"/>`;
    y += r.h;
  });
  out += '</g>';
  return { svg: out, h: H };
}

// ── 3) 가로 막대 (barsH) ────────────────────────────────────
function barsHBody(t, { items, max }) {
  const M = max ?? Math.max(...items.map((i) => i.num));
  const LABEL_W = Math.min(330, Math.max(...items.map((i) => tw(i.label, 25, 600))) + 8);
  const VAL_W = Math.max(...items.map((i) => tw(i.value, 27, 800))) + 16;
  const trackX = PAD + LABEL_W + 28, trackW = CW - LABEL_W - VAL_W - 56;
  const ROW = 84;
  let out = `<g filter="url(#sh)">${rr(PAD, 0, CW, items.length * ROW + 44, 26, t.card)}</g>`;
  items.forEach((it, i) => {
    const cy = 22 + i * ROW + ROW / 2;
    const bw = Math.max(18, (it.num / M) * trackW);
    out += text(PAD + 32, cy + 9, it.label, { size: 25, weight: 600, fill: t.ink });
    out += rr(trackX, cy - 17, trackW, 34, 17, t.accentTint);
    out += rr(trackX, cy - 17, bw, 34, 17, `url(#${it.hl ? 'accHD' : 'accH'})`);
    out += text(PAD + CW - 32, cy + 10, it.value, { size: 27, weight: 800, fill: it.hl ? t.accentDark : t.ink, anchor: 'end' });
  });
  return { svg: out, h: items.length * ROW + 44 };
}

// ── 4) 세로 막대 (barsV) ────────────────────────────────────
function barsVBody(t, { items, max, sub }) {
  const M = max ?? Math.max(...items.map((i) => i.num));
  const H = 470, top = 56, base = H - 76;
  const n = items.length, slot = (CW - 64) / n, bw = Math.min(110, slot * 0.58);
  let out = `<g filter="url(#sh)">${rr(PAD, 0, CW, H, 26, t.card)}</g>`;
  for (let g = 0; g <= 3; g++) { const gy = base - ((base - top - 36) * g) / 3; out += `<line x1="${PAD + 32}" y1="${gy}" x2="${PAD + CW - 32}" y2="${gy}" stroke="${t.line}" stroke-width="${g === 0 ? 2 : 1.5}" ${g ? 'stroke-dasharray="4 8"' : ''}/>`; }
  items.forEach((it, i) => {
    const cx = PAD + 32 + slot * i + slot / 2;
    const bh = Math.max(14, (it.num / M) * (base - top - 36));
    out += `<path d="M${cx - bw / 2},${base} V${base - bh + 14} a14,14 0 0 1 14,-14 h${bw - 28} a14,14 0 0 1 14,14 V${base} Z" fill="url(#${it.hl ? 'accVD' : 'accV'})"/>`;
    out += text(cx, base - bh - 16, it.value, { size: 27, weight: 800, fill: it.hl ? t.accentDark : t.ink, anchor: 'middle' });
    out += text(cx, base + 42, it.label, { size: 24, weight: 600, fill: it.hl ? t.accentDark : t.sub, anchor: 'middle' });
    if (it.sub) out += text(cx, base + 68, it.sub, { size: 19, weight: 500, fill: t.mute, anchor: 'middle' });
  });
  return { svg: out, h: H };
}

// ── 5) 타임라인 (timeline) ─────────────────────────────────
function timelineBody(t, { items }) {
  const n = items.length, gap = 20, cw = (CW - gap * (n - 1)) / n;
  const lineY = 40;
  let out = `<line x1="${PAD + cw / 2}" y1="${lineY}" x2="${PAD + CW - cw / 2}" y2="${lineY}" stroke="${t.accentSoft}" stroke-width="6" stroke-linecap="round"/>`;
  const infos = items.map((it) => {
    const lines = [...wrap(it.sub ?? '', 21, cw - 40, 500)];
    return { it, lines };
  });
  const cardH = 130 + Math.max(...infos.map((i) => i.lines.length)) * 30 + 60;
  infos.forEach(({ it, lines }, i) => {
    const x = PAD + i * (cw + gap), cx = x + cw / 2;
    const hl = it.hl;
    out += `<circle cx="${cx}" cy="${lineY}" r="15" fill="${t.card}" stroke="${hl ? t.warn : t.accent}" stroke-width="6"/>`;
    out += text(cx, lineY - 34, it.when, { size: 24, weight: 800, fill: hl ? t.warn : t.accentDark, anchor: 'middle' });
    const cy0 = 92;
    out += `<g filter="url(#sh)">${rr(x, cy0, cw, cardH - 30, 22, t.card, hl ? `stroke="${t.warn}" stroke-width="3"` : '')}</g>`;
    out += text(cx, cy0 + 50, it.name, { size: 27, weight: 800, fill: t.ink, anchor: 'middle', ls: -0.5 });
    lines.forEach((ln, k) => { out += text(cx, cy0 + 90 + k * 30, ln, { size: 21, weight: 500, fill: t.sub, anchor: 'middle' }); });
    if (it.tag) { const p = pill(0, 0, it.tag, { fill: '#000', color: '#000', size: 20 }); out += pill(cx - p.w / 2, cy0 + cardH - 30 - 62, it.tag, { fill: hl ? t.warnSoft : t.accentSoft, color: hl ? '#92400e' : t.accentDark, size: 20 }).svg; }
  });
  return { svg: out, h: 92 + cardH - 30 };
}

const BODIES = { steps: stepsBody, table: tableBody, barsH: barsHBody, barsV: barsVBody, timeline: timelineBody };

export function buildSvg(spec, theme = 'green') {
  const t = THEMES[theme];
  const body = (spec.custom ?? BODIES[spec.type])(t, spec, { W, PAD, CW, text, wrap, tw, rr, pill, esc, FONT, MONO });
  return frame(t, spec, body.h, body.svg);
}

export async function renderWebp(svg, { scale = 2, quality = 90 } = {}) {
  return sharp(Buffer.from(svg), { density: 72 * scale }).webp({ quality, effort: 5, smartSubsample: true }).toBuffer();
}
