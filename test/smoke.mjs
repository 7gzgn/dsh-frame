// 自测：拿最近那个真实会话跑一遍，看 analyze 的数字合不合理
import { analyze, pickSession } from '../lib/index.js'

const file = pickSession()
console.log('会话:', file)

const d = analyze(file, 0.054)
const f = (n) => Number(n).toLocaleString('en-US')
console.log('请求', f(d.requests), '轮', f(d.turns))
console.log('system', f(d.systemChars), '工具表', f(d.toolChars), '/', d.toolCount, '个')
console.log('最后输入', f(d.lastInputChars), '字符 =', f(d.lastInputTokens), 'token')
console.log('累计', f(d.sumTokens), 'token，估算', d.estCost.toFixed(3), '元')
console.log('压力', (d.pressure * 100).toFixed(1) + '%  离压缩', (d.triggerAt / Math.max(d.lastInputTokens, 1)).toFixed(1), '倍')

// 断言：结构合理的会话不该出现 0 或负数
const bad = []
if (!(d.requests > 0)) bad.push('请求数为 0')
if (!(d.systemChars > 100)) bad.push('system prompt 异常小：' + d.systemChars)
if (!(d.toolCount > 0)) bad.push('工具数为 0')
if (!(d.lastInputTokens > 0)) bad.push('最后输入为 0')
if (d.sumTokens < d.lastInputTokens) bad.push('累计小于最后一次，说明累加错了')
if (d.pricePerMillion !== 0.054) bad.push('单价没传进去')
console.log(bad.length ? '❌ ' + bad.join(' / ') : '✅ 全部断言通过')
process.exit(bad.length ? 1 : 0)
