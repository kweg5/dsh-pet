/**
 * dsh-pet — DSH 桌面宠物（Host 半）。
 *
 * 职责：
 *  1. 监听 DSH 事件（agent 活动 / 工具执行 / 权限请求 / 出错 / 回合结束 / 工作流），
 *     驱动宠物状态机，通过 /pet/api/state 供浏览器端轮询；
 *  2. /pet/api 路由：状态读取、开关/皮肤/缩放配置（持久化到 ~/.dsh/super-injector/pet-config.json）；
 *  3. /pet/skin/<name>.webp 路由：从 ~/.dsh/super-injector/pet-skins/ 提供自定义皮肤图片。
 *
 * 所有资源注册挂 ctx.effect / ctx.on，热重载与卸载自动清理。
 */
import type { Context } from 'cordis'
import z from 'schemastery'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'

type AppContext = Context & {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  timeout(callback: () => void, delay: number): () => void
}

export const name = 'dsh-pet'
export const inject = ['webServer', 'timer']

export interface Config {
  pollMs: number
  bubbleMs: number
}

export const Config = z.object({
  pollMs: z.number().min(200).max(5000).default(500),
  bubbleMs: z.number().min(500).max(20000).default(3500),
})

/** ── 工具名 → 动画 / 气泡文案 ─────────────────────────────── */
const TOOL_ANIM: Record<string, string> = {
  read: 'review', grep: 'review', glob: 'review',
  web_fetch: 'review', web_search: 'review',
  write: 'writing', edit: 'writing',
  bash: 'running', pwsh: 'running',
  subagent: 'running', workflow: 'running',
}
const TOOL_MSG: Record<string, string> = {
  read: '读取文件中…', grep: '搜索内容中…', glob: '查找文件中…',
  web_fetch: '访问网页中…', web_search: '搜索网络中…',
  write: '写入文件中…', edit: '编辑文件中…',
  bash: '执行命令中…', pwsh: '执行命令中…',
  subagent: '子代理工作中…', workflow: '执行工作流…',
}

/** ── 配置持久化（~/.dsh/super-injector/pet-config.json） ─────── */
function configPath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'super-injector', 'pet-config.json')
}
function skinsDir(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'super-injector', 'pet-skins')
}
interface PersistedConfig {
  enabled: boolean
  skin: string
  scale: number
}
function loadConfig(): PersistedConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<PersistedConfig>
    return {
      enabled: raw.enabled !== false,
      skin: typeof raw.skin === 'string' && raw.skin ? raw.skin : 'default',
      scale: typeof raw.scale === 'number' && raw.scale > 0 ? raw.scale : 1,
    }
  } catch {
    return { enabled: true, skin: 'default', scale: 1 }
  }
}
function saveConfig(cfg: PersistedConfig): void {
  try {
    mkdirSync(join(configPath(), '..'), { recursive: true })
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
  } catch { /* 保存失败静默 */ }
}

export function apply(ctx: AppContext, config: Config): void {
  const cfg = loadConfig()

  // ── 宠物状态（对外只暴露叶子字段） ──
  const pet = {
    enabled: cfg.enabled,
    skin: cfg.skin,
    scale: cfg.scale,
    state: 'idle' as string,
    message: '' as string,
    ts: 0,
    pending: 0, // 进行中的工具/审批计数
  }

  let idleTimer: (() => void) | null = null
  function setState(state: string, message: string, bumpPending: boolean): void {
    if (bumpPending) pet.pending += 1
    pet.state = state
    pet.message = message
    pet.ts = Date.now()
  }
  /** wave / failed 等需要停留的临时状态，延迟后自动回到 idle。 */
  function scheduleIdle(ms: number): void {
    idleTimer?.()
    idleTimer = ctx.timeout(() => {
      idleTimer = null
      pet.pending = 0
      setState('idle', '', false)
    }, ms)
  }

  // ── 事件监听（ctx.on 随 fiber 自动清理） ──
  // agent 状态：idle ⇄ running
  ctx.on('agent/status', (payload: any) => {
    const status = payload?.status
    if (status === 'running') {
      setState('running', '工作中…', false)
    } else if (status === 'idle') {
      if (pet.pending <= 0) setState('idle', '', false)
    }
  })

  // 工具即将执行（waterfall，必须委托 next()）
  ctx.on('tools/pre-execute', (exec: any, next: () => unknown) => {
    try {
      const name_ = toolNameOf(exec)
      const anim = TOOL_ANIM[name_] ?? 'running'
      const msg = TOOL_MSG[name_] ?? '处理中…'
      setState(anim === 'writing' ? 'writing' : anim, msg, true)
    } catch { /* 解析失败不阻塞工具执行 */ }
    return next()
  })

  // 工具执行完毕（emit）
  ctx.on('tools/result', (exec: any, result: any) => {
    pet.pending = Math.max(0, pet.pending - 1)
    const ok = !result?.error && result?.ok !== false
    if (!ok) {
      setState('failed', '这一步出错了…', false)
      scheduleIdle(4000)
    } else if (pet.pending <= 0) {
      setState('idle', '', false)
    }
  })

  // 权限请求（waterfall：记录 waiting 提醒 → await next() 拿决策结果）
  ctx.on('approval/request', (req: any, next: () => Promise<any>) => {
    pet.pending += 1
    setState('waiting', approvalText(req), false)
    const chain = Promise.resolve(next())
    chain.then((outcome: any) => {
      // 决策完成：拒绝 → 解除 waiting；批准 → 等待后续工具事件覆盖
      pet.pending = Math.max(0, pet.pending - 1)
      const granted = outcome?.granted === true || outcome?.approved === true || outcome?.allow === true
      const denied = outcome?.granted === false || outcome?.approved === false || outcome?.deny === true || outcome?.denied === true
      if (denied || (!granted && pet.state === 'waiting')) {
        setState('idle', '', false)
      }
    }).catch(() => {})
    return chain
  })

  // agent 出错
  ctx.on('agent/error', () => {
    setState('failed', '遇到错误…', false)
    scheduleIdle(5000)
  })

  // 回合结束（serial 事件，无 next）
  ctx.on('agent/turn-stopping', () => {
    setState('wave', '这一轮完成！', false)
    scheduleIdle(3200)
  })

  // 工作流 与 子代理
  ctx.on('workflow/start', () => setState('running', '执行工作流…', false))
  ctx.on('workflow/end', () => {
    setState('wave', '任务完成！', false)
    scheduleIdle(3200)
  })
  ctx.on('subagent/start', () => setState('running', '子代理工作中…', false))
  ctx.on('subagent/end', () => setState('idle', '', false))

  // ── HTTP API ──
  const api: Record<string, (payload: any) => any> = {
    /** 当前状态快照（浏览器端每 pollMs 轮询） */
    state: () => ({
      state: pet.state,
      message: pet.message,
      ts: pet.ts,
      enabled: pet.enabled,
      skin: pet.skin,
      scale: pet.scale,
      skins: listSkins(),
    }),
    /** 开关 / 皮肤 / 缩放 */
    set: (payload: any) => {
      if (typeof payload?.enabled === 'boolean') pet.enabled = payload.enabled
      if (typeof payload?.skin === 'string') pet.skin = payload.skin
      if (typeof payload?.scale === 'number' && payload.scale > 0) pet.scale = payload.scale
      saveConfig({ enabled: pet.enabled, skin: pet.skin, scale: pet.scale })
      return { enabled: pet.enabled, skin: pet.skin, scale: pet.scale }
    },
    /** 单击宠物：挥手致意 + 回 DSH */
    click: () => {
      setState('wave', '回到 DSH 界面！', false)
      scheduleIdle(2200)
      return { ok: true }
    },
    /** 皮肤列表（供右键菜单刷新） */
    skins: () => ({ skins: listSkins() }),
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/pet/api',
    handler: async (req, res) => {
      if (!trusted(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/pet/api/') ? pathname.slice('/pet/api/'.length) : ''
      if (!method || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (!handler) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
          return
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-pet: /pet/api routes')

  // ── 皮肤静态路由：GET /pet/skin/<name>.webp ──
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/pet/skin',
    handler: async (req, res) => {
      if (!trusted(req) || req.method !== 'GET') {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const file = pathname.replace(/^\/pet\/skin\//, '')
      if (!file || file.includes('/') || file.includes('..') || !file.toLowerCase().endsWith('.webp')) {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      try {
        const data = readFileSync(join(skinsDir(), file))
        res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'no-cache' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    },
  }), 'dsh-pet: /pet/skin routes')

  ctx.logger?.info?.('[dsh-pet] 宠物 host 就绪（enabled=' + pet.enabled + ' skin=' + pet.skin + '）')
}

/** ── 工具执行对象 → 工具名（防御式读取，兼容字段差异） ── */
function toolNameOf(exec: any): string {
  const t = exec?.tool
  if (typeof t === 'string') return t
  if (t && typeof t === 'object' && typeof t.name === 'string') return t.name
  const name_ = exec?.name ?? exec?.toolName ?? exec?.title
  return typeof name_ === 'string' ? name_ : ''
}

/** ── 审批请求 → 提醒气泡文案（防御式读取） ── */
function approvalText(req: any): string {
  const tool = req?.tool?.name ?? req?.toolName ?? req?.tool
  const toolStr = typeof tool === 'string' ? tool : tool && typeof tool === 'object' ? String(tool.name ?? '') : ''
  const reason = req?.reason ?? req?.message
  const reasonStr = typeof reason === 'string' && reason ? reason : ''
  if (toolStr && reasonStr) return '需要你批准：' + toolStr + '（' + reasonStr + '）'
  if (toolStr) return '需要你批准：' + toolStr
  return '需要你的确认…'
}

/** ── 皮肤列表：pet-skins 目录下的 webp 文件名 ── */
function listSkins(): string[] {
  try {
    if (!existsSync(skinsDir())) return []
    return readdirSync(skinsDir())
      .filter((f) => f.toLowerCase().endsWith('.webp'))
      .sort()
  } catch {
    return []
  }
}

/** ── 浏览器信任检查（简化 fence：本机回环 + 非跨站） ── */
function trusted(req: IncomingMessage): boolean {
  const host = req.headers?.host ?? ''
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const site = req.headers?.['sec-fetch-site']
  if (site && site === 'cross-site') return false
  return true
}

const MAX_BODY_BYTES = 1 << 20
async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new HttpError(400, 'bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad-request', 'request body is not valid JSON')
  }
}
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}
function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 500, {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  })
}
class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
