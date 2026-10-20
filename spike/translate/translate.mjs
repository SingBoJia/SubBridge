#!/usr/bin/env node
// 英译中翻译管线：读 whisper JSON，逐段翻译，输出双语 SRT。
//
// 用法: node translate.mjs <in.json> <out-prefix> [--engine mymemory|mock]
//
// 产出：
//   <out-prefix>.zh-en.srt   双语字幕
//   <out-prefix>.zh.srt      纯中文字幕
//   <out-prefix>.json        结构化结果（含每段译文与耗时）

import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPrefix, ...rest] = process.argv.slice(2);
if (!inPath || !outPrefix) {
  console.error('usage: node translate.mjs <in.json> <out-prefix> [--engine mymemory|mock]');
  process.exit(2);
}
const engine = rest.includes('--engine')
  ? rest[rest.indexOf('--engine') + 1]
  : 'mymemory';

// ---------- 读取 whisper 输出 ----------
const data = JSON.parse(readFileSync(inPath, 'utf8'));
const segs = Object.keys(data.transcription)
  .sort((a, b) => Number(a) - Number(b))
  .map(k => ({
    idx: Number(k),
    start: data.transcription[k].offsets.from,
    end: data.transcription[k].offsets.to,
    en: data.transcription[k].text.trim(),
  }))
  .filter(s => s.en && !/^\[.*\]$/.test(s.en));   // 丢掉纯 [Music] 之类

console.log(`读取 ${segs.length} 段`);

// ---------- 翻译引擎 ----------
async function translateMymemory(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.responseStatus !== 200) throw new Error(j.responseDetails || 'api error');
  return j.responseData.translatedText;
}

function translateMock(text) {
  return `【待译】${text}`;
}

const translate = engine === 'mock' ? translateMock : translateMymemory;

// ---------- 逐段翻译（带重试） ----------
async function translateWithRetry(text, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await translate(text);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- 时间格式化 ----------
function srtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

// ---------- 主流程 ----------
const startedAt = Date.now();
const results = [];
let failed = 0;

for (let i = 0; i < segs.length; i++) {
  const s = segs[i];
  const t0 = Date.now();
  let zh = '';
  try {
    zh = await translateWithRetry(s.en);
  } catch (e) {
    zh = '';
    failed++;
    console.error(`  [${i}] 失败: ${e.message}`);
  }
  results.push({ ...s, zh, ms: Date.now() - t0 });

  const pct = ((i + 1) / segs.length * 100).toFixed(0);
  if ((i + 1) % 10 === 0 || i === segs.length - 1) {
    console.log(`  ${pct}% (${i + 1}/${segs.length})`);
  }

  // 免费接口限速，礼貌间隔
  if (engine === 'mymemory') await new Promise(r => setTimeout(r, 350));
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n完成：${results.length} 段，失败 ${failed}，耗时 ${elapsed}s`);

// ---------- 输出 SRT ----------
function buildSrt(items, bilingual) {
  const lines = [];
  items.forEach((s, i) => {
    if (!s.zh && bilingual) return;
    lines.push(String(i + 1));
    lines.push(`${srtTime(s.start)} --> ${srtTime(s.end)}`);
    if (bilingual) {
      lines.push(s.en);
      lines.push(s.zh || '');
    } else {
      lines.push(s.zh || s.en);
    }
    lines.push('');
  });
  return lines.join('\r\n');
}

writeFileSync(`${outPrefix}.zh-en.srt`, '\uFEFF' + buildSrt(results, true), 'utf8');
writeFileSync(`${outPrefix}.zh.srt`, '\uFEFF' + buildSrt(results, false), 'utf8');
writeFileSync(`${outPrefix}.json`, JSON.stringify(results, null, 2), 'utf8');

console.log(`已写出：`);
console.log(`  ${outPrefix}.zh-en.srt  (双语)`);
console.log(`  ${outPrefix}.zh.srt     (纯中文)`);
console.log(`  ${outPrefix}.json       (结构化)`);
