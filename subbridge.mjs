#!/usr/bin/env node
// SubBridge 一键管线：本地视频 → 双语字幕
//
// 用法:
//   node subbridge.mjs <video> [选项]
//
// 选项:
//   -o, --out DIR       输出目录（默认 ./out）
//   --lang LANG         源语言（默认 en）
//   --model NAME        翻译模型（默认 deepseek-v4.1-flash）
//   --base URL          翻译接口（默认 https://api.llmgo.net/v1）
//   --batch N           每批翻译条数（默认 20）
//   --glossary FILE     术语表 JSON
//   --no-translate      只转写，不翻译
//   --keep-audio        保留中间音频
//
// 环境变量:
//   LLM_API_KEY         翻译密钥（不翻译时可省略）
//   HTTPS_PROXY         代理（YouTube 等来源需要）

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;

// ---------- 参数 ----------
const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('-')) {
  console.error(`SubBridge — 本地视频转双语字幕

用法: node subbridge.mjs <video> [选项]

选项:
  -o, --out DIR      输出目录（默认 ./out）
  --lang LANG        源语言（默认 en）
  --model NAME       翻译模型（默认 deepseek-v4.1-flash）
  --base URL         翻译接口
  --batch N          每批翻译条数（默认 20）
  --glossary FILE    术语表 JSON
  --no-translate     只转写
  --keep-audio       保留中间音频

环境变量:
  LLM_API_KEY        翻译密钥
  HTTPS_PROXY        代理`);
  process.exit(2);
}

const video = resolve(argv[0]);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = resolve(opt('--out', opt('-o', './out')));
const LANG = opt('--lang', 'en');
const MODEL = opt('--model', 'deepseek-v4.1-flash');
const BASE = opt('--base', 'https://api.llmgo.net/v1');
const BATCH = Number(opt('--batch', '20'));
const GLOSSARY = opt('--glossary', '');
const NO_TRANSLATE = argv.includes('--no-translate');
const KEEP_AUDIO = argv.includes('--keep-audio');
const API_KEY = process.env.LLM_API_KEY;

// ---------- 工具路径 ----------
const FFMPEG = join(ROOT, 'vendor/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe');
const FFPROBE = join(ROOT, 'vendor/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe');
const WHISPER_DIR = join(ROOT, 'vendor/whisper-cuda/Release');
const WHISPER = join(WHISPER_DIR, 'whisper-cli.exe');
const MODEL_DIR = join(ROOT, 'vendor/models');
const ASR_MODEL = join(MODEL_DIR, 'ggml-large-v3-turbo-q5_0.bin');
const VAD_MODEL = join(MODEL_DIR, 'ggml-silero-v6.2.0.bin');

// ---------- 日志 ----------
const t0 = Date.now();
const step = (n, total, msg) => {
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${el}s] [${n}/${total}] ${msg}`);
};
const fail = (msg) => { console.error(`\n错误: ${msg}`); process.exit(1); };

// ---------- 前置检查 ----------
function preflight() {
  const need = [
    [video, '输入视频'],
    [FFMPEG, 'ffmpeg'],
    [FFPROBE, 'ffprobe'],
    [WHISPER, 'whisper-cli'],
    [ASR_MODEL, 'ASR 模型'],
  ];
  for (const [p, name] of need) {
    if (!existsSync(p)) fail(`找不到${name}: ${p}`);
  }
  if (!NO_TRANSLATE && !API_KEY) fail('需要设置 LLM_API_KEY 环境变量（或加 --no-translate）');
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
}

// ---------- 子进程 ----------
function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? res(out) : rej(new Error(`${basename(cmd)} 退出码 ${code}\n${err.slice(-800)}`)));
    p.on('error', rej);
  });
}

// ---------- 主流程 ----------
async function main() {
  preflight();
  const TOTAL = NO_TRANSLATE ? 4 : 6;
  const stem = basename(video, extname(video));
  const audioPath = join(OUT, `${stem}.16k.wav`);

  console.log(`\nSubBridge`);
  console.log(`  输入: ${video}`);
  console.log(`  输出: ${OUT}`);
  console.log(`  语言: ${LANG}${NO_TRANSLATE ? '（仅转写）' : ` → 简体中文（${MODEL}）`}\n`);

  // 1. 探测
  step(1, TOTAL, '探测媒体信息');
  const probeRaw = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video,
  ]);
  const probe = JSON.parse(probeRaw);
  const vStream = probe.streams.find(s => s.codec_type === 'video');
  const aStream = probe.streams.find(s => s.codec_type === 'audio');
  if (!aStream) fail('该文件没有音轨');
  const dur = Number(probe.format.duration);
  console.log(`      时长 ${dur.toFixed(1)}s | ${vStream ? vStream.width + 'x' + vStream.height : '无视频'} | 音频 ${aStream.codec_name} ${aStream.sample_rate}Hz ${aStream.channels}ch`);

  // 2. 提取音频
  step(2, TOTAL, '提取音频（16kHz 单声道）');
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', video, '-vn', '-map', '0:a:0',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath,
  ]);
  console.log(`      ${(statSync(audioPath).size / 1048576).toFixed(1)} MB`);

  // 3. ASR
  step(3, TOTAL, '语音识别（Whisper turbo + VAD）');
  const asrPrefix = join(OUT, `${stem}.asr`);
  const asrStart = Date.now();
  await run(WHISPER, [
    '-m', ASR_MODEL,
    '-f', audioPath,
    '-l', LANG,
    '-t', String(Math.min(16, (await import('node:os')).cpus().length)),
    '--vad', '-vm', VAD_MODEL,
    '-oj', '-of', asrPrefix,
  ], { cwd: WHISPER_DIR });
  const asrMs = Date.now() - asrStart;

  const asrJson = JSON.parse(readFileSync(`${asrPrefix}.json`, 'utf8'));
  const segs = Object.keys(asrJson.transcription)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => ({
      id: Number(k),
      start: asrJson.transcription[k].offsets.from,
      end: asrJson.transcription[k].offsets.to,
      en: asrJson.transcription[k].text.trim(),
    }))
    .filter(s => s.en && !/^\[.*\]$/.test(s.en));
  console.log(`      ${segs.length} 段 | 耗时 ${(asrMs / 1000).toFixed(2)}s（${(dur / (asrMs / 1000)).toFixed(1)}x 实时）`);

  if (!segs.length) fail('没有识别到语音内容');

  // 4. 翻译
  let merged = segs.map(s => ({ ...s, zh: '' }));
  if (!NO_TRANSLATE) {
    step(4, TOTAL, `翻译（${MODEL}，每批 ${BATCH} 条）`);
    merged = await translateAll(segs);
  }

  // 5. 质检
  step(NO_TRANSLATE ? 4 : 5, TOTAL, '质检');
  const qc = runQC(merged, NO_TRANSLATE);
  console.log(`      空译 ${qc.empty} | 超长 ${qc.tooLong} | 重叠 ${qc.overlap} | 数字不符 ${qc.numMismatch}`);

  // 6. 导出
  step(NO_TRANSLATE ? 4 : 6, TOTAL, '导出字幕');
  const files = exportSubtitles(merged, join(OUT, stem), NO_TRANSLATE);

  if (!KEEP_AUDIO) {
    try { unlinkSync(audioPath); } catch { /* ignore */ }
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n完成，总耗时 ${total}s（${(dur / Number(total)).toFixed(1)}x 实时）`);
  console.log(`\n产物:`);
  files.forEach(f => console.log(`  ${f}`));
  console.log('');
}

// ---------- 翻译 ----------
async function translateAll(segs) {
  const glossary = GLOSSARY && existsSync(GLOSSARY)
    ? JSON.parse(readFileSync(GLOSSARY, 'utf8'))
    : {};
  const glossText = Object.keys(glossary).length
    ? Object.entries(glossary).map(([k, v]) => `  ${k} → ${v}`).join('\n')
    : '（无）';

  const result = new Map();
  const totalBatches = Math.ceil(segs.length / BATCH);

  for (let start = 0; start < segs.length; start += BATCH) {
    const items = segs.slice(start, start + BATCH);
    const ids = items.map(s => s.id);
    const before = segs.slice(Math.max(0, start - 2), start);
    const after = segs.slice(start + items.length, start + items.length + 2);

    const prompt = `你是专业影视字幕译者。把下面的英文字幕翻译成简体中文。

【必须遵守】
1. 只输出 JSON 数组：[{"id": <输入id>, "zh": "<译文>"}]
2. id 必须与输入完全一致，不得增加、删除、合并、重排
3. 每条译文不超过 20 个汉字；超长时压缩冗余，不丢关键信息
4. 口语化、简洁，符合字幕阅读习惯；不加解释、不加引号
5. 数字、单位、时间、URL、代码、人名保持原样
6. 必须使用术语表译法
7. 前后语境仅用于理解，不要翻译语境条目
8. 不要输出 Markdown 代码块或任何前言

【术语表】
${glossText}

【前文语境（只读）】
${before.map(s => '  ' + s.en).join('\n') || '（无）'}

【后文语境（只读）】
${after.map(s => '  ' + s.en).join('\n') || '（无）'}

【待翻译】
${items.map(s => `${s.id}\t${s.en}`).join('\n')}`;

    const batchNo = Math.floor(start / BATCH) + 1;
    process.stdout.write(`      批次 ${batchNo}/${totalBatches} ... `);

    try {
      const content = await callLLM(prompt);
      const { got, missing } = parseLLM(content, ids);

      if (missing.length) {
        process.stdout.write(`缺 ${missing.length} 条，重试 ... `);
        for (const id of missing) {
          const it = items.find(x => x.id === id);
          try {
            const c = await callLLM(singlePrompt(it, glossText));
            const one = parseLLM(c, [id]);
            if (one.got.has(id)) got.set(id, one.got.get(id));
          } catch { /* 留空 */ }
        }
      }

      for (const it of items) result.set(it.id, got.get(it.id) || '');
      console.log('ok');
    } catch (e) {
      console.log(`失败: ${e.message}`);
      for (const it of items) result.set(it.id, '');
    }
  }

  return segs.map(s => ({ ...s, zh: result.get(s.id) || '' }));
}

function singlePrompt(item, glossText) {
  return `把下面这句英文字幕翻译成简体中文，只输出 JSON 数组 [{"id":${item.id},"zh":"译文"}]，不要任何其他内容。
术语表：${glossText}
原文：${item.en}`;
}

async function callLLM(prompt, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.3,
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
      const j = await r.json();
      const c = j.choices?.[0]?.message?.content;
      if (!c) throw new Error('空响应');
      return c;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function parseLLM(content, wantIds) {
  let s = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b < 0) throw new Error('响应无 JSON 数组');
  const arr = JSON.parse(s.slice(a, b + 1));
  const got = new Map();
  for (const it of arr) {
    if (typeof it.id === 'number' && typeof it.zh === 'string') got.set(it.id, it.zh.trim());
  }
  return { got, missing: wantIds.filter(id => !got.has(id)) };
}

// ---------- 质检 ----------
function runQC(items, skipTrans) {
  let empty = 0, tooLong = 0, overlap = 0, numMismatch = 0;
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    if (!skipTrans && !s.zh.trim()) empty++;
    if (s.zh.length > 20) tooLong++;
    if (i > 0 && s.start < items[i - 1].end) overlap++;
    if (!skipTrans && s.zh) {
      const en = (s.en.match(/\d+(?:\.\d+)?/g) || []).join(',');
      const zh = (s.zh.match(/\d+(?:\.\d+)?/g) || []).join(',');
      if (en && en !== zh) numMismatch++;
    }
  }
  return { empty, tooLong, overlap, numMismatch };
}

// ---------- 导出 ----------
function srtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

function exportSubtitles(items, prefix, skipTrans) {
  const files = [];
  const write = (path, content) => {
    writeFileSync(path, '\uFEFF' + content, 'utf8');
    files.push(path);
  };

  // block: 序号 + 时间轴 + 正文行
  const build = (pick) => items.map((s, i) => {
    const body = pick(s);
    const lines = [String(i + 1), `${srtTime(s.start)} --> ${srtTime(s.end)}`, ...body];
    return lines.join('\r\n');
  }).join('\r\n\r\n') + '\r\n';

  write(`${prefix}.en.srt`, build(s => [s.en]));
  if (!skipTrans) {
    write(`${prefix}.zh.srt`, build(s => [s.zh || s.en]));
    write(`${prefix}.zh-en.srt`, build(s => [s.en, s.zh || '']));
  }

  writeFileSync(`${prefix}.json`, JSON.stringify(items, null, 2), 'utf8');
  files.push(`${prefix}.json`);

  return files;
}

main().catch(e => { console.error(`\n失败: ${e.message}`); process.exit(1); });
