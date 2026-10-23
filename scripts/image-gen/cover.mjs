// 대표 이미지(cover.webp, og.jpg) 생성기. 데이터: cover_specs.json
// 사용법: FONTCONFIG_FILE=<fonts.conf> node scripts/image-gen/cover.mjs [필터]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { THEMES, tw, wrap, esc } from './lib.mjs';

const W = 1200, H = 630, PAD = 68;
const FONT = "Pretendard, 'Noto Sans CJK KR', sans-serif";
const T = (x, y, s, { size, weight = 600, fill, anchor = 'start', op, ls } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${op ? ` fill-opacity="${op}"` : ''}${ls ? ` letter-spacing="${ls}"` : ''}>${esc(s)}</text>`;

export function buildCover(spec, t, siteUrl) {
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.accentDark}"/><stop offset="1" stop-color="${t.accent}"/></linearGradient>
<filter id="sh" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="12"/><feOffset dy="8"/><feComponentTransfer><feFuncA type="linear" slope="0.22"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<circle cx="1110" cy="40" r="270" fill="#fff" fill-opacity="0.07"/><circle cx="1010" cy="-10" r="150" fill="#fff" fill-opacity="0.06"/><circle cx="60" cy="640" r="230" fill="#fff" fill-opacity="0.05"/>`;
  // 카테고리 칩
  const cw = Math.ceil(tw(spec.category, 24, 700)) + 44;
  out += `<rect x="${PAD}" y="58" width="${cw}" height="48" rx="24" fill="#fff"/>` + T(PAD + cw / 2, 91, spec.category, { size: 24, weight: 700, fill: t.accentDark, anchor: 'middle' });
  // 제목
  let size = 62, lines = wrap(spec.title, size, W - PAD * 2 - 60, 800);
  if (lines.length > 2) { size = 54; lines = wrap(spec.title, size, W - PAD * 2 - 60, 800); }
  lines.forEach((ln, i) => { out += T(PAD, 190 + i * (size * 1.28), ln, { size, weight: 800, fill: '#fff', ls: -1.5 }); });
  // 핵심 카드 3개
  const gap = 22, cardW = (W - PAD * 2 - gap * 2) / 3, cy = 372, ch = 168;
  spec.cards.forEach((c, i) => {
    const x = PAD + i * (cardW + gap);
    let vs = 46; while (vs > 30 && tw(c.value, vs, 800) > cardW - 52) vs -= 2;
    out += `<g filter="url(#sh)"><rect x="${x}" y="${cy}" width="${cardW}" height="${ch}" rx="26" fill="#fff"/></g>`;
    out += T(x + 28, cy + 46, c.label, { size: 22, weight: 600, fill: t.sub });
    out += T(x + 28, cy + 104, c.value, { size: vs, weight: 800, fill: t.accentDark, ls: -1 });
    out += T(x + 28, cy + 142, c.sub, { size: 20, weight: 500, fill: t.mute });
  });
  out += T(PAD, 596, `기준일 ${spec.date}`, { size: 22, weight: 600, fill: '#fff', op: 0.82 });
  out += T(W - PAD, 596, `${t.brand} ${siteUrl}`, { size: 22, weight: 700, fill: '#fff', anchor: 'end', op: 0.9 });
  return out + '</svg>';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const specs = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cover_specs.json'), 'utf8'));
  const outDir = process.env.OUT_DIR ?? path.join(ROOT, 'public/assets/posts');
  for (const [key, spec] of Object.entries(specs)) {
    if (filter && !key.includes(filter)) continue;
    const svg = buildCover(spec, THEMES.green, 'pockemoney.com');
    const dir = path.join(outDir, key); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'cover.svg'), svg);
    await sharp(Buffer.from(svg), { density: 144 }).webp({ quality: 90, effort: 5 }).toFile(path.join(dir, 'cover.webp'));
    await sharp(Buffer.from(svg), { density: 72 }).jpeg({ quality: 90, mozjpeg: true }).toFile(path.join(dir, 'og.jpg'));
    console.log(key);
  }
}
