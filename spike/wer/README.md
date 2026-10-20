# WER 评测

## 用法

```bash
node wer.mjs <hyp.json> <ref.vtt> [--skip-credits N]
```

- `hyp.json`：`whisper-cli -oj -of <prefix>` 生成的输出
- `ref.vtt`：参考字幕（人工或自动）
- `--skip-credits N`：跳过开头 N 个词（用于剔除译者/审校者署名）
- 设 `SHOW_ERRORS=1` 打印逐条错误

## 归一化规则

评测前两边都做统一处理，避免把书写差异算成识别错误：

| 规则 | 说明 |
| --- | --- |
| 小写 + 去标点 | 标准做法 |
| 剔除 `[Music]`/`[applause]`/`[laughter]` | 舞台提示不是语音 |
| 剔除 `uh`/`um`/`ah`/`huh`/`er` | 口头填充词，参考字幕通常不记 |
| 数字转英文单词 | `4` → `four`，避免 `4` vs `four` 误判 |
| 口语缩合展开 | `gonna`→`going to`、`'cause`→`because`、`dammit`→`damn it` |
| VTT 滚动去重 | 自动字幕是滚动窗口，整行重复需去重 |

## 实测结果

素材：TED 演讲（人工英文字幕），355.5 秒，832 词。

| 处理 | WER | 准确率 |
| --- | --- | --- |
| 含片头署名 | 4.37% | 95.63% |
| 跳过片头 10 词 | **3.56%** | **96.44%** |

PRD 要求 ≤ 8%，**已达标且有 2 倍余量**。

## 局限

- 参考字幕是人工翻译组做的，与语音不完全逐字对应（会省略重复词、语气词）。
- 未做多说话人、重口音、噪声环境的评测。
- 自动字幕当参考时（如斯坦福那条 1.99%），因参考本身是 ASR 生成，数字偏乐观，不可作为质量证明。

## 重新生成 hyp.json

```bash
cd vendor/whisper-cuda/Release
./whisper-cli.exe -m "../../models/ggml-large-v3-turbo-q5_0.bin" \
  -f "path/to/audio.wav" -l en -t 8 -oj -of "out"
# 生成 out.json
```
