# 翻译管线

两条实现，对应两种渠道。**产品方案用 LLM 版**，MyMemory 版仅作无密钥时的链路验证。

## LLM 版（推荐）

```bash
export LLM_API_KEY="sk-..."
node translate-llm.mjs ted_out.json out --batch 20 --context 2
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--batch N` | 20 | 每批条数 |
| `--context N` | 2 | 前后各带几条语境（只读，不翻译） |
| `--model NAME` | deepseek-v4.1-flash | 模型名 |
| `--base URL` | https://api.llmgo.net/v1 | OpenAI 兼容接口 |
| `--glossary FILE` | 无 | 术语表 JSON，如 `{"TED":"TED","prompt":"提示词"}` |

### 设计要点

1. **严格 ID 对齐**：输出必须是 `[{"id":N,"zh":"..."}]`，校验缺失/多余；缺失项单条重试。
2. **上下文只读**：前文后文用于理解，提示词明确禁止翻译。
3. **超长压缩**：提示词要求 ≤20 汉字，超长时压缩冗余。
4. **失败隔离**：单批失败不影响其他批次，空译单独统计。
5. **重试退避**：1s/2s/3s，最多 3 次。

## MyMemory 版（链路验证用）

```bash
node translate.mjs ted_out.json out --engine mymemory
```

免费翻译记忆库，无需密钥。**质量不足以作为产品方案**，原因见下方对比。

---

## 实测对比（同一素材，104 段）

| 指标 | MyMemory | deepseek-v4.1-flash |
| --- | --- | --- |
| 耗时 | 56.3s（逐段串行） | **25.6s**（20 条/批，6 批） |
| 请求数 | 104 | 6 |
| 空译 | 0 | 0 |
| 上下文 | 无 | 前后各 2 条 |
| 术语表 | 不支持 | 支持 |

### 译文质量对比

| 原文 | MyMemory | deepseek-v4.1-flash |
| --- | --- | --- |
| That's nothing. | 没关系。 | **那什么都没有。** |
| I have nothing, nada, zip, zilch, zippo. | 我什么都没有， nada ， zip ， zilch ， zippo。 | **我一无所有，空空如也，什么都没有。** |
| nothing even remotely researched at all. | 甚至没有任何远程研究。 | **甚至没做过半点研究。** |
| Which is what I have for you all. | 为你们所有人准备好。 | **这正是我要给大家的东西。** |

MyMemory 的根本问题是**逐句独立检索、无上下文**：`remotely` 被译成“远程”，连续同义词不意译。LLM 版能理解整句语义并保留语气递进。

### LLM 版质量检查

| 项 | 结果 |
| --- | --- |
| 空译 | 0 / 104 |
| 疑似未译 | 0 / 104 |
| 超 20 汉字 | 3 / 104（1 条为人名署名） |
| 数字保真 | 仅 1 处格式差异（`5,601` → `5601`） |
| 数字处理正确例 | `70.5`、`352`、`2.6 million` → `260万` 均保留 |

---

## 接口信息（llmgo）

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.llmgo.net/v1` |
| 鉴权 | `Authorization: Bearer <key>` |
| 协议 | OpenAI Chat Completions 兼容 |
| 可用模型 | `deepseek-v4.1-flash`、`deepseek-v4-pro` |

响应中 `message.reasoning_content` 会带思维链，`message.content` 才是译文。脚本只取 `content`。

---

## 复现

```bash
cd samples
export HTTPS_PROXY=http://127.0.0.1:30671
export LLM_API_KEY="<your-key>"

# 先转写（见 samples/README.md）
node ../spike/translate/translate-llm.mjs ted_out.json ted-llm

# 输出
#   ted-llm.zh-en.srt   双语
#   ted-llm.zh.srt      纯中文
#   ted-llm.json        结构化
```
