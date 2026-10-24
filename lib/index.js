/**
 * dsh-frame —— 把「我这一场到底吃了多少」摊开看。
 *
 * 只读会话日志（多帧 zstd 的 session.v4.jsonl.zstd），不调模型，不改任何提示词。
 * 刻意**不往 system prompt 写一个字**：这个插件存在的理由是让提示词变小，不是再塞一段。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'frame'
export const inject = ['tools']

/** 动态取 defineTool：宿主里有就用真的，单测/无宿主场景退化成恒等。 */
let defineTool = (def) => def
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {
  /* 没有 dsh-tools 也能跑 */
}

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 解多帧 zstd：zstdDecompressSync 只解第一帧，必须按 magic 切段。 */
function unpack(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    try {
      out += zlib.zstdDecompressSync(buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)).toString()
    } catch {
      /* 单帧坏了不连坐 */
    }
  }
  return out
}

/** 读会话日志开头那条 session 记录（只读前 64KB，避开整文件）。 */
function sessionHead(file) {
  let buf
  try {
    const fd = fs.openSync(file, 'r')
    buf = Buffer.alloc(65536)
    fs.readSync(fd, buf, 0, 65536, 0)
    fs.closeSync(fd)
  } catch {
    return null
  }
  const starts = []
  for (let i = 0; i + 3 < buf.length && starts.length < 2; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  if (!starts.length) return null
  const slice = starts.length > 1 ? buf.subarray(starts[0], starts[1]) : buf.subarray(starts[0])
  try {
    return JSON.parse(zlib.zstdDecompressSync(slice).toString().split('\n')[0])
  } catch {
    return null
  }
}

/** 找会话文件：给了路径就用，否则取最近改动、且不是 subagent 子会话的那个。 */
function pickSession(given) {
  if (typeof given === 'string' && given.trim() && given !== 'latest') {
    if (!fs.existsSync(given)) throw new Error(`会话文件不存在：${given}`)
    return given
  }
  const root = path.join(dshHome(), 'sessions')
  if (!fs.existsSync(root)) throw new Error(`会话目录不存在：${root}`)
  const cands = []
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsp = path.join(root, ws.name)
    for (const s of fs.readdirSync(wsp, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const f = path.join(wsp, s.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const st = fs.statSync(f)
      if (st.size > 1000) cands.push({ f, m: st.mtimeMs })
    }
  }
  // 按最近改动排；subagent/fork 出来的子会话 delegationDepth > 0，跳过它们，
  // 否则"最近这个"很可能是某个刚跑完的子 agent，而不是你正在聊的那场。
  cands.sort((a, b) => b.m - a.m)
  for (const c of cands) {
    const head = sessionHead(c.f)
    if (!head || (head.delegationDepth ?? 0) === 0) return c.f
  }
  if (!cands.length) throw new Error('没找到有内容的会话日志')
  return cands[0].f
}

const blockChars = (content) => {
  if (!content) return 0
  if (typeof content === 'string') return content.length
  let n = 0
  for (const b of content) {
    if (b?.type === 'text') n += (b.text ?? '').length
    else if (b?.type === 'reasoning') n += (b.text ?? '').length
  }
  return n
}

/** 一趟扫完会话：请求数、输入曲线、system 与工具表体积、压缩压力。 */
function analyze(file, pricePerMillion) {
  const lines = unpack(file).split('\n').filter(Boolean)
  let sys = 0
  let toolCount = 0
  let toolChars = 0
  let history = 0
  let turn = 0
  let requests = 0
  let sumTokens = 0
  let lastTotal = 0
  let ctxWindow = 1048576
  let createdAt = null
  for (const line of lines) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const t = o.type
    if (t === 'session') createdAt = o.createdAt ?? null
    else if (t === 'system/message') sys = blockChars(o.data?.message?.content)
    else if (t === 'request/header') {
      // 取最后一条：工具集会变（装/卸插件），第一条往往已经过时
      const tools = o.data?.header?.tools ?? []
      toolCount = tools.length
      toolChars = JSON.stringify(tools).length
    } else if (t === 'request/context') ctxWindow = o.data?.contextWindow ?? ctxWindow
    else if (t === 'user/message') history += blockChars(o.data?.content ?? o.data?.message?.content) // user 的 content 在 data.content，不在 data.message.content
    else if (t === 'assistant/message' || t === 'tool/result') history += blockChars(o.data?.message?.content)
    else if (t === 'tool/call') history += JSON.stringify(o.data?.arguments ?? '').length
    if (t === 'step/start') {
      requests++
      lastTotal = sys + toolChars + history
      sumTokens += Math.round(lastTotal / 2)
    }
    if (t === 'turn/start') turn++
  }
  const pressure = lastTotal / 2 / ctxWindow
  return {
    file,
    createdAt,
    requests,
    turns: turn,
    systemChars: sys,
    toolCount,
    toolChars,
    lastInputChars: lastTotal,
    lastInputTokens: Math.round(lastTotal / 2),
    sumTokens,
    contextWindow: ctxWindow,
    pressure,
    triggerAt: Math.round(ctxWindow * 0.8),
    retainAt: Math.round(ctxWindow * 0.16),
    estCost: (sumTokens / 1e6) * pricePerMillion,
    pricePerMillion,
  }
}

const fmt = (n) => Number(n).toLocaleString('en-US')

/** 给测试用的出口：不做任何注册，纯算。 */
export { analyze, pickSession, unpack }

export function apply(ctx, config) {
  const cfg = config ?? {}
  const probe = (msg) => {
    // 只有显式设了 DSH_FRAME_DEBUG=1 才写探针，生产环境不落文件
    if (process.env.DSH_FRAME_DEBUG !== '1') return
    try {
      fs.appendFileSync(path.join(os.tmpdir(), 'dsh-frame-probe.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8')
    } catch {
      /* 探针失败不影响插件 */
    }
  }
  probe(`apply 进入 enabled=${cfg.enabled} tools类型=${typeof ctx?.tools} register类型=${typeof ctx?.tools?.register} defineTool=${typeof defineTool}`)
  if (cfg.enabled === false) return
  const price = Number.isFinite(cfg.pricePerMillion) ? cfg.pricePerMillion : 0.054
  const disposers = []

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    try {
      // 不套 defineTool：插件里裸包名 import 解析不到 dsh-tools（会静默退化成恒等，
      // 于是原始 DSL 直接进 register 被 JsonSchemaError 拒掉）。
      // 这里直接给 register 它校验时要的标准形态。
      disposers.push(ctx.tools.register({
      name: 'frame',
      description: [
        '看清这一场对话的开销：多少次模型请求、每次吃进去多少、system prompt 与工具表各占多少字符、累计多少 token、估算花了多少钱、离上下文压缩还有多远。',
        '**只读**：直接解析会话日志，不调模型、不联网、不往 system prompt 写任何东西。',
        '不给 session 就取最近改动的那个会话。',''
      ].join('\n'),
      timeoutMs: 20000,
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: '会话日志路径（默认：最近改动的那个）' },
          pricePerMillion: { type: 'number', description: '按多少钱/百万 input token 估算（默认 0.054）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            data: {},
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          if (!value || value.ok !== true || !value.data) {
            return [{ type: 'text', text: `frame 失败：${String(value?.error ?? '未知错误')}` }]
          }
          const d = value.data
          const lines = [
            '📐 这一场的开销',
            `  · 文件：${d.file}`,
            `  · 模型请求 ${fmt(d.requests)} 次 / ${fmt(d.turns)} 轮`,
            `  · system prompt ${fmt(d.systemChars)} 字符`,
            `  · 工具表 ${fmt(d.toolChars)} 字符 / ${fmt(d.toolCount)} 个工具`,
            `  · 最后一次请求输入 ${fmt(d.lastInputChars)} 字符（约 ${fmt(d.lastInputTokens)} token）`,
            `  · 累计输入约 ${fmt(d.sumTokens)} token → 估算 ${d.estCost.toFixed(3)} 元（按 ${d.pricePerMillion} 元/百万）`,
            `  · 上下文压力 ${(d.pressure * 100).toFixed(1)}%（窗口 ${fmt(d.contextWindow)} token，压缩在 80% 触发、压后留 16%）`,
          ]
          if (d.pressure > 0 && d.pressure < 0.8) {
            lines.push(`  · 离压缩还差 ${(d.triggerAt / Math.max(d.lastInputTokens, 1)).toFixed(1)} 倍`)
          } else if (d.pressure >= 0.8) {
            lines.push('  · ⚠️ 已过 80% 触发线，下一次可能被压缩')
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        try {
          const file = pickSession(args?.session ?? cfg.session)
          const p = Number.isFinite(args?.pricePerMillion) ? args.pricePerMillion : price
          const data = analyze(file, p)
          return { ok: true, data }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }))
      probe(`register 成功，disposers=${disposers.length}`)
    } catch (err) {
      probe(`register 抛错：${err && (err.stack || err.message || err)}`)
    }
  } else {
    probe(`跳过注册：tools=${typeof ctx?.tools} register=${typeof ctx?.tools?.register}`)
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-frame: teardown')
  }
}
