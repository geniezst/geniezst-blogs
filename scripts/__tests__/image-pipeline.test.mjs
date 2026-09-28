import { sniffImageFormat, buildHdCandidates, looksLikeThumbnail, normalizeImage, fetchVerifiedImage, readDimensions } from '../lib/image-pipeline.mjs';
import sharp from 'sharp';

let pass=0, fail=0;
const ok=(n,c,extra='')=>{ c?(pass++,console.log('  ✅',n,extra)):(fail++,console.log('  ❌',n,extra)); };

console.log('\n[1] 매직바이트 스니핑');
const jpg = await sharp({create:{width:800,height:600,channels:3,background:{r:200,g:30,b:30}}}).jpeg().toBuffer();
const png = await sharp({create:{width:640,height:480,channels:4,background:{r:0,g:100,b:200,alpha:1}}}).png().toBuffer();
const webp= await sharp({create:{width:400,height:300,channels:3,background:{r:9,g:9,b:9}}}).webp().toBuffer();
const gif = Buffer.concat([Buffer.from('GIF89a'),Buffer.alloc(10)]);
ok('JPEG', sniffImageFormat(jpg)?.type==='jpeg' && sniffImageFormat(jpg)?.mime==='image/jpeg');
ok('PNG (URL에 확장자 없어도 jpg로 오인하지 않음)', sniffImageFormat(png)?.type==='png' && sniffImageFormat(png)?.ext==='png');
ok('WebP', sniffImageFormat(webp)?.type==='webp');
ok('GIF', sniffImageFormat(gif)?.type==='gif');
ok('HTML 페이지 -> null (기존漏洞 차단)', sniffImageFormat(Buffer.from('<!DOCTYPE html><html><body>404</body></html>'))===null);
ok('JSON 오류 -> null', sniffImageFormat(Buffer.from('{"code":"invalid_api_key"}'))===null);
ok('빈 버퍼 -> null', sniffImageFormat(Buffer.alloc(0))===null);

console.log('\n[2] 기존 결함 재현: 확장자 없는 PNG를 .jpg로 저장하던 버그');
const hada = await fetchVerifiedImage('https://social.news.hada.io/topic/34291?v=1770000000',{referer:'https://www.hada.io/'});
ok('실제 HADA PNG 바이트 판정', hada.format?.type==='png', `-> ${hada.format?.type}/${hada.dims?.width}x${hada.dims?.height} ${hada.error||''}`);

console.log('\n[3] HD 후보 생성 (기존 정규식 미커버 패턴)');
const c1 = buildHdCandidates('https://www.jtoday.co.kr/photo_orgPhoto_2026/_l.jpg');
ok('_l.jpg -> 원본 후보 생성', c1.some(u=>!/_l\.jpg/.test(u)), `(${c1.length}개)`);
ok('_v150.jpg -> 원본 후보 생성', buildHdCandidates('https://n.com/a_v150.jpg').some(u=>!/_v150/.test(u)));
ok('_l.jpg 은 썸네일로 감지', looksLikeThumbnail('https://n.com/abc_l.jpg'));
ok('_v150.jpg 은 썸네일로 감지', looksLikeThumbnail('https://n.com/a_v150.jpg'));
ok('네이버 /w500/ 은 썸네일로 감지', looksLikeThumbnail('https://s-photo-c.wcs.naver.com/w500/AAA/BBB/photo.jpg'));
ok('네이버 /c250/ 은 썸네일로 감지', looksLikeThumbnail('https://s-photo-c.wcs.naver.com/c250/AAA/BBB/photo.jpg'));
ok('네이버 /w500/ -> /original/ 후보 생성', buildHdCandidates('https://s-photo-c.wcs.naver.com/w500/AAA/BBB/photo.jpg').some(u=>/\/original\//.test(u)));
ok('newsis l_49_2026... 은 썸네일 오탐 없음', !looksLikeThumbnail('https://cphoto.newscdn.com/c3/x/l_49_20260128005604.jpg'));
ok('?w=300 은 썸네일로 감지', looksLikeThumbnail('https://n.com/a.jpg?w=300'));
ok('?w=1600 은 썸네일 아님', !looksLikeThumbnail('https://n.com/a.jpg?w=1600'));
ok('원본 조회는 썸네일 아님', !looksLikeThumbnail('https://n.com/photo_orgPhoto_2026/20260101/abc.jpg'));
const c2 = buildHdCandidates('https://n.com/img/resize/500x300/a.jpg');
ok('/resize/500x300 -> 원본 제거 후보 포함', c2.some(u=>!/500x300/.test(u)), `(${c2.length}개)`);
ok('중복 URL 없음', new Set(c1).size===c1.length);
ok('잘못된 URL 은 빈 배열', buildHdCandidates('not-a-url').length===0);

console.log('\n[4] 정규화 (sharp 1200px + WebP)');
const big = await sharp({create:{width:2000,height:1200,channels:3,background:{r:1,g:2,b:3}}}).jpeg().toBuffer();
const n1 = await normalizeImage(big);
ok('2000px -> 1600px 상한 축소', n1.width===1600 && n1.ext==='webp', `-> ${n1.width}x${n1.height}`);
const mid = await sharp({create:{width:900,height:600,channels:3,background:{r:1,g:2,b:3}}}).jpeg().toBuffer();
const n2 = await normalizeImage(mid);
ok('900px -> 1200px 기준(업스케일 아님 900 유지)', n2.width===900, `-> ${n2.width}x${n2.height}`);
const small = await sharp({create:{width:500,height:400,channels:3,background:{r:1,g:2,b:3}}}).jpeg().toBuffer();
const n3 = await normalizeImage(small);
ok('500px(<640) 는 기각 — FR-1.5', !!n3.error, `-> ${n3.error}`);
ok('WebP 매직바이트 확인', sniffImageFormat(n1.buffer)?.type==='webp');
ok('출력 JPEG 아님', n1.buffer[0]===0x52&&n1.buffer[1]===0x49, 'RIFF');

console.log('\n[5] live 검증: 기존 결함 3종');
const fake = await fetchVerifiedImage('https://geniezst.com/definitely-missing-404.jpg');
ok('404 거부', !!fake.error, `-> ${fake.error}`);
const html = await fetchVerifiedImage('https://pockemoney.com/nonexistent-page-xyz');
ok('HTML 페이지 거부 (Referer 없이)', !!html.error, `-> ${html.error}`);

console.log(`\n===== 결과: ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail?1:0);
