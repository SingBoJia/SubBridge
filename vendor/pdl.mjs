#!/usr/bin/env node
// 并行分段下载器：绕过单连接限速。
// 用法: node pdl.mjs <url> <output> [connections] [chunkMB]
import { createWriteStream, existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const [url, out, connArg = '8', chunkArg = '4'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node pdl.mjs <url> <output> [connections] [chunkMB]');
  process.exit(2);
}
const CONNECTIONS = Number(connArg);
const CHUNK = Number(chunkArg) * 1024 * 1024;

async function head(u) {
  const r = await fetch(u, { method: 'HEAD', redirect: 'follow' });
  if (!r.ok) throw new Error(`HEAD ${r.status}`);
  const len = Number(r.headers.get('content-length'));
  const ranges = (r.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
  return { len, ranges, finalUrl: r.url };
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function main() {
  const meta = await head(url);
  log(`size=${(meta.len / 1048576).toFixed(1)}MB ranges=${meta.ranges} final=${meta.finalUrl.slice(0, 80)}`);

  const partPath = out + '.part';
  const metaPath = out + '.meta.json';

  let state;
  if (existsSync(metaPath)) {
    const { readFileSync } = await import('node:fs');
    state = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (state.total !== meta.len) {
      log('size changed, restart');
      state = null;
    } else {
      log(`resume: ${state.chunks.filter(c => c.done).length}/${state.chunks.length} chunks done`);
    }
  }
  if (!state) {
    const chunks = [];
    for (let start = 0; start < meta.len; start += CHUNK) {
      chunks.push({ start, end: Math.min(start + CHUNK - 1, meta.len - 1), done: false });
    }
    state = { total: meta.len, chunks };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(metaPath, JSON.stringify(state));
    if (existsSync(partPath)) unlinkSync(partPath);
  }

  const fh = await open(partPath, existsSync(partPath) ? 'r+' : 'w+');
  if (!existsSync(partPath) || statSync(partPath).size !== meta.len) {
    await fh.truncate(meta.len);
  }

  let cursor = 0;
  let active = 0;
  let doneBytes = state.chunks.filter(c => c.done).reduce((s, c) => s + (c.end - c.start + 1), 0);
  const startedAt = Date.now();

  const persist = async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(metaPath, JSON.stringify(state));
  };

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= state.chunks.length) return;
      const c = state.chunks[i];
      if (c.done) continue;
      let attempt = 0;
      while (attempt < 8) {
        try {
          const r = await fetch(meta.finalUrl, {
            headers: { Range: `bytes=${c.start}-${c.end}` },
            redirect: 'follow',
          });
          if (r.status !== 206) throw new Error(`status ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          const expect = c.end - c.start + 1;
          if (buf.length !== expect) throw new Error(`short ${buf.length}/${expect}`);
          await fh.write(buf, 0, buf.length, c.start);
          c.done = true;
          doneBytes += buf.length;
          await persist();
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = doneBytes / elapsed / 1048576;
          const pct = (doneBytes / state.total * 100).toFixed(1);
          const eta = ((state.total - doneBytes) / (doneBytes / elapsed)) || 0;
          log(`${pct}% ${doneBytes / 1048576 | 0}/${state.total / 1048576 | 0}MB ${rate.toFixed(2)}MB/s eta ${(eta / 60).toFixed(1)}min`);
          break;
        } catch (e) {
          attempt++;
          log(`chunk ${i} retry ${attempt}: ${e.message}`);
          await sleep(500 * attempt);
        }
      }
      if (!c.done) throw new Error(`chunk ${i} failed permanently`);
    }
  }

  const workers = Array.from({ length: CONNECTIONS }, worker);
  await Promise.all(workers);
  await fh.close();

  const { writeFileSync } = await import('node:fs');
  writeFileSync(metaPath, JSON.stringify(state));
  renameSync(partPath, out);
  unlinkSync(metaPath);
  log(`done: ${out} ${(statSync(out).size / 1048576).toFixed(1)}MB`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
