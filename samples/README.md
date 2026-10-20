# 测试素材

本目录存放实测用的源视频/音频，**不提交到 git**（视频文件体积大且涉及第三方版权）。

## 当前内容

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `8S0FDjFBj8o.webm` | 4.4 MB | TED 演讲源视频（YouTube，5m55s） |
| `8S0FDjFBj8o.en.vtt` | 8.3 KB | 人工英文字幕（参考基准） |
| `ted.wav` | 10.8 MB | 提取的 16 kHz 单声道音频 |
| `ted_out.json` | 22 KB | whisper 转写输出（104 段） |

WER 评测用的固定版本已提交在 `spike/wer/`。

## 重新获取

需要代理（本机 `127.0.0.1:30671`）：

```bash
cd samples
export HTTPS_PROXY=http://127.0.0.1:30671

# 下载视频与字幕
../vendor/yt-dlp.exe -f "bestaudio/best" \
  --write-subs --write-auto-subs --sub-langs "en" --sub-format vtt \
  -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=8S0FDjFBj8o"

# 提取 16 kHz 单声道音频
../vendor/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe \
  -i 8S0FDjFBj8o.webm -vn -ac 1 -ar 16000 -c:a pcm_s16le ted.wav
```

## 跑一遍

```bash
# 转写
cd ../vendor/whisper-cuda/Release
./whisper-cli.exe -m "../../models/ggml-large-v3-turbo-q5_0.bin" \
  -f "../../../samples/ted.wav" -l en -t 8 \
  -oj -of "../../../samples/ted_out"

# 评测
cd ../../../samples
node ../spike/wer/wer.mjs ted_out.json 8S0FDjFBj8o.en.vtt --skip-credits 10
```

预期输出：

```
ref words : 814
hyp words : 813
SUB=12  DEL=9  INS=8
WER       : 3.56%
accuracy  : 96.44%
```

## 另一条素材

斯坦福毕业演讲（15m04s，自动字幕）：

```bash
../vendor/yt-dlp.exe -f "bestaudio/best" \
  --write-subs --write-auto-subs --sub-langs "en" --sub-format vtt \
  -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=UF8uR6Z6KLc"
```

注意：这条的参考字幕是 YouTube 自动生成的，与 Whisper 同源，算出的 1.99% 偏乐观，不能作为质量证明。

## 版权

素材仅用于本地技术验证，不随项目分发。
