# SubBridge ASR Spike（Rust）

这是 [TRD-rust.md](../TRD-rust.md) 中所有 ASR 相关结论的可复现依据。2026-10-20 在本机实测通过。

## 环境要求

| 项 | 版本 |
| --- | --- |
| Rust | stable-x86_64-pc-windows-msvc（本机 1.99.0） |
| MSVC | Visual Studio 2019/2022/2026，含 C++ 桌面开发 |
| CMake | 3.20+ |
| 磁盘 | 约 1 GB（模型 + target） |

`cargo` 不在 PATH 时：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

## 快速开始

```bash
cd spike/asr-smoke

# 1. 准备模型（约 74 MB）
mkdir -p models
curl -L "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin" \
     -o models/ggml-tiny.en.bin

# 2. 准备样例音频（11 秒，16 kHz 单声道）
curl -L "https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav" \
     -o jfk.wav

# 3. 构建
cargo build --release

# 4. 转写（带 token 时间戳）
./target/release/asr-smoke models/ggml-tiny.en.bin jfk.wav
```

## 三个可执行目标

### `asr-smoke` — 转写 + token 时间戳

```bash
./target/release/asr-smoke <model.bin> <audio.wav>
```

输出示例（实测）：

```
wav: 16000 Hz, 1 ch, 11.00s
inference: 3.49s
[       0ms ->     8000ms] ntok=16 nsp=0.029 And so my fellow Americans ask not what your country can do for you
   tok[1] id=843  p=0.659 t0=32  t1=40  " And"
   tok[2] id=523  p=0.972 t0=40  t1=52  " so"
   tok[4] id=5891 p=0.999 t0=94  t1=175 " fellow"
[    8000ms ->    11000ms] ntok=10 nsp=0.029 ask what you can do for your country.
```

关键事实：

- `start_timestamp()` / `end_timestamp()` 返回**厘秒**，×10 得毫秒。
- `token_data().t0/t1` 同样是厘秒。
- `no_speech_probability()` 可用于幻觉过滤。
- 特殊 token（如 `[_BEG_]`）需要按 `token_id` 过滤。

### `vad` — Silero VAD 语音段检测

```bash
# 模型 0.84 MB
curl -L "https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin" \
     -o models/ggml-silero-v6.2.0.bin

./target/release/vad models/ggml-silero-v6.2.0.bin jfk.wav
```

输出示例（实测）：

```
segments: 4
  320ms -> 2270ms
  3270ms -> 4410ms
  5380ms -> 7680ms
  8160ms -> 11010ms
```

### `bench` — 多线程吞吐基准

```bash
./target/release/bench <model.bin> <audio.wav> [threads]
```

实测（60 秒音频，base.en，Ryzen 9 7950X）：

```
threads=4  audio=60s infer=24.13s speed=2.5x segments=6
threads=8  audio=60s infer=13.20s speed=4.5x segments=6
threads=16 audio=60s infer=8.96s  speed=6.7x segments=6
```

> 不设置 `set_n_threads` 时默认值偏低，必须显式设置。

## 代码要点

```rust
// 正确：whisper-rs 0.16 的签名
for i in 0..state.full_n_segments() {          // 返回 c_int，不是 Result
    let Some(seg) = state.get_segment(i) else { continue };  // 返回 Option
    for j in 0..seg.n_tokens() {
        let Some(tok) = seg.get_token(j) else { continue };
        let d = tok.token_data();
        let start_ms = d.t0 * 10;   // 厘秒 → 毫秒
    }
}
```

早期资料常见的 `full_n_segments()?` / `get_segment(i)?` 写法在 0.16 会编译失败。

## 未覆盖的部分

| 项 | 状态 |
| --- | --- |
| CUDA 后端 | 未构建（本机无 CUDA Toolkit） |
| Vulkan 后端 | 未构建（本机无 Vulkan SDK） |
| DTW 词级对齐 | API 已确认，未做精度实测 |
| `large-v3` | 未下载（3.10 GB） |
| 长音频分块 | 未实现 |

GPU 验证步骤见 [TRD-rust.md](../TRD-rust.md) 第 6.1 节与第 18 节。

## 清理

```bash
cargo clean          # 清构建产物（约 500 MB）
rm -rf models        # 清模型
```

## 真实素材验证（2026-10-20）

用 GPU 版 whisper.cpp + turbo-q5 跑真实视频音频：

| 素材 | 时长 | 无 VAD | 有 VAD | 实时倍率 |
| --- | --- | --- | --- | --- |
| 中文短剧对话 | 94.5s | 3.00s | **2.33s** | **40.6x** |

VAD 输出（正确跳过开头 4.5 秒静音）：

```
[00:00:04.550 --> 00:00:09.360]  喂,生日快乐,你猜猜,他现在在哪儿?
[00:00:10.150 --> 00:00:14.880]  你人真好,你是唯一一个,记得今天是我生日的人。
[00:00:15.510 --> 00:00:17.290]  装什么可怜,谁在乎你啊?
```

复现命令：

```bash
cd vendor/whisper-cuda/Release
./whisper-cli.exe -m "../../models/ggml-large-v3-turbo-q5_0.bin" \
  -f "path/to/audio.wav" -l zh -t 8 \
  --vad -vm "../../../.research/models/ggml-silero-v6.2.0.bin"
```

### 幻觉对照（必须启用 VAD）

纯 BGM / 静音素材不启用 VAD 时，turbo 模型会持续输出重复幻觉：

```
# 7 分钟 BGM 视频，-l en，无 VAD
[00:00:00.000 --> 00:00:29.980]   Thank you.
[00:00:30.000 --> 00:00:59.980]   Thank you.
... （共 11 次）

# 另一段，-l auto，无 VAD
[00:00:00.000 --> 00:00:02.000]   *cute*
[00:00:30.000 --> 00:00:32.000]   *cute*
... （共 15 次）
```

启用 VAD 后这些段被完全跳过，且总耗时下降。

## Vulkan 后端（已构建验证）

构建产物：`E:/sbt/release/asr-smoke.exe`（56.9 MB，静态链接 ggml-vulkan）。

```bash
# 构建（必须在 vcvars64 + Ninja 环境下，详见 vendor/README.md）
cargo build --release --features vulkan
```

实测（RTX 3060，turbo-q5，94.5s 中文真实语音）：

| 运行次数 | 耗时 | 实时倍率 |
| --- | --- | --- |
| 第 1 次（编译着色器） | 15.65s | 6.0x |
| 第 2 次 | 2.35s | **40.2x** |
| 第 3 次 | 2.37s | 39.9x |

CUDA 对照（同一音频）：2.33s（40.6x）。

**结论**：Vulkan 稳态性能与 CUDA 持平，但首次有 6.7 倍冷启动惩罚，必须预热。

输出正确性（与 CUDA 一致）：

```
[       0ms ->     9000ms] ntok=19 nsp=0.000 喂 生日快乐 你猜猜他现在在哪儿
   tok[2] id=35142 p=0.597 t0=1   t1=476 "喂"
   tok[4] id=8244  p=0.998 t0=476 t1=485 "生"
   tok[5] id=6890  p=1.000 t0=513 t1=536 "日"
```

## 英文真实素材评测（YouTube）

用 yt-dlp 下载带字幕的英文视频，ffmpeg 提取 16 kHz 音频，GPU 转写后与字幕比对。

| 素材 | 时长 | 耗时 | 实时倍率 | WER（规范化） |
| --- | --- | --- | --- | --- |
| TED 演讲（人工字幕） | 355.5s | 8.75s | **40.6x** | **3.56%** |
| 斯坦福毕业演讲（自动字幕） | 904.2s | 19.35s | **46.7x** | 1.99%* |

\* 参考字幕本身由 ASR 生成，与 Whisper 同源，数字偏乐观，不能作为质量证明。

WER 评测脚本与完整方法见 [wer/README.md](wer/README.md)。

### 获取素材（需代理）

```bash
export HTTPS_PROXY=http://127.0.0.1:30671
./vendor/yt-dlp.exe -f "bestaudio/best" --write-subs --sub-langs "en" \
  --sub-format vtt -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=8S0FDjFBj8o"

# yt-dlp 找不到 ffmpeg，手动转码
./vendor/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe \
  -i 8S0FDjFBj8o.webm -vn -ac 1 -ar 16000 -c:a pcm_s16le ted.wav
```

### DTW 词边界

```bash
./whisper-cli.exe -m model.bin -f ted.wav -l en -t 8 \
  -ojf -of out -dtw large.v3.turbo -nfa
```

- 必须 `-nfa`（关 flash attention），否则 DTW 被静默禁用
- 必须 `-ojf`（JSON full），否则看不到 `t_dtw` 字段
- DTW token 覆盖：**1134 / 1134 = 100%**
- DTW 开销：+46%（8.75s → 12.77s）
- `t_dtw` 是 token **起点**，词时长需用相邻起点差计算
