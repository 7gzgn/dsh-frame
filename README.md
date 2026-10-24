# dsh-frame

看清一场对话到底吃了多少。给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 加一个工具 `frame`，
一次调用就报出这一场的请求次数、上下文体积、累计 token、估算花费，以及离自动压缩还有多远。

**它不调模型、不联网、不往 system prompt 写一个字。** 全部数字来自本地会话日志。

## 它回答什么

| 问题 | 怎么来的 |
|---|---|
| 这一场模型请求了多少次？ | 数会话日志里的 `step/start`（不是 `request/header`——那个只在表头变化时写） |
| system prompt 与工具表各占多少？ | 取最新一条 `system/message` 的字符数；工具表按 `request/header` 里的 schema 序列化长度 |
| 最后一步吃进去多少？ | system + 工具表 + 累积历史，逐 step 累加 |
| 累计多少 token、多少钱？ | 每次请求的输入字符 ÷ 2 估算 token；乘一个可配的单价（默认 0.054 元/百万） |
| 离压缩还有多远？ | 上下文压力 = 当前 token / `contextWindow`，压缩在 80% 触发、压完保留 16% |

## 用法

装好之后直接调：

```
frame                          # 最近改动的那个会话
frame session=<日志路径>        # 指定会话
frame pricePerMillion=0.5      # 换一个单价口径
```

输出长这样：

```
📐 这一场的开销
  · 模型请求 330 次 / 45 轮
  · system prompt 9,096 字符
  · 工具表 98,950 字符 / 121 个工具
  · 最后一次请求输入 755,428 字符（约 377,714 token）
  · 累计输入约 76,413,754 token → 估算 4.126 元（按 0.054 元/百万）
  · 上下文压力 36.0%（窗口 1,048,576 token，压缩在 80% 触发、压后留 16%）
  · 离压缩还差 2.2 倍
```

## 安装

```powershell
# 1. 链接进 profile
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-frame" -Target <本仓库路径>
# 2. profile 的 package.json 里 dependencies 加 "dsh-frame": "link:<本仓库路径>"
# 3. 同文件 dsh.profile.bundles 数组里加 "dsh-frame"
# 4. 重启宿主
```

## 数字口径与已知局限

- **默认挑哪个会话**：取「最近改动、且 `delegationDepth` 为 0 的主会话」。subagent / fork 出来的子会话会被跳过——否则刚跑完一个子 agent，"最近"就会指到它身上。要指定会话就传 `session=<路径>`。
- **token 是估的**：字符数 ÷ 2，中英混排的粗估，不是分词器的真值。要看真值得等 provider 回 usage。
- **单价是默认值**：0.054 元/百万 input token 是 2026-10 在 DeepSeek flash 上反推出来的量级（含缓存命中折扣），换模型/换价自己传 `pricePerMillion`。
- **会话日志是多帧 zstd**：`zstdDecompressSync` 只解第一帧（只有 187 字节），本插件按 magic `28 B5 2F FD` 切帧逐段解压。
- **工具表那栏取的是最后一条 `request/header`**：这个事件只在配置或工具集变化时写，所以它能反映"装/卸插件之后"的真实数量；但如果本次会话从头到尾没变过工具集，那条记录会是很早的。

## 开发

```bash
node test/smoke.mjs     # 拿最近一个真实会话跑一遍，验证数字与结构
DSH_FRAME_DEBUG=1       # 打开探针日志（apply 进入 / register 结果）
```

MIT
