// 사용법: FONTCONFIG_FILE=<fonts.conf> node scripts/image-gen/run.mjs [부분문자열 필터] [--svg]
// public/assets/posts/<키>.webp (2x) 와 .svg(원본)를 덮어쓴다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg, renderWebp } from './lib.mjs';
import { SPECS } from './specs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const outDir = process.env.OUT_DIR ?? path.join(ROOT, 'public/assets/posts');

for (const [key, spec] of Object.entries(SPECS)) {
  if (filter && !key.includes(filter)) continue;
  const svg = buildSvg(spec, 'green');
  const webp = await renderWebp(svg);
  const base = path.join(outDir, key);
  await fs.mkdir(path.dirname(base), { recursive: true });
  await fs.writeFile(`${base}.svg`, svg);
  await fs.writeFile(`${base}.webp`, webp);
  console.log(key, `${(webp.length / 1024).toFixed(0)}KB`);
}
