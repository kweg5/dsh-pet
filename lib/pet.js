/**
 * dsh-pet — DSH 桌面宠物（Host，手写 ESM 产物）。
 *
 * 与 src/index.ts 语义一致（TS 参考实现），运行环境为完整 Node：
 *  - 监听 DSH 事件（agent 活动 / 工具执行 / 权限请求 / 出错 / 回合结束 / 工作流），
 *    驱动宠物状态机，通过 /pet/api/state 供浏览器端轮询；
 *  - /pet/api 路由：状态读取、开关/皮肤/缩放配置（持久化 ~/.dsh/super-injector/pet-config.json）；
 *  - /pet/skin/<name>.webp 路由：从 ~/.dsh/super-injector/pet-skins/ 提供自定义皮肤。
 *
 * 所有资源注册挂 ctx.effect / ctx.on，热重载与卸载自动清理。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pet'
export const inject = ['webServer', 'timer']

/** ── 工具名 → 动画 / 气泡文案 ─────────────────────────────── */
const TOOL_ANIM = {
  read: 'review', grep: 'review', glob: 'review',
  web_fetch: 'review', web_search: 'review',
  write: 'writing', edit: 'writing',
  bash: 'running', pwsh: 'running',
  subagent: 'running', workflow: 'running',
  ask_user_question: 'waiting', // 提问用户 = 等待用户回应
}
const TOOL_MSG = {
  read: '读取文件中…', grep: '搜索内容中…', glob: '查找文件中…',
  web_fetch: '访问网页中…', web_search: '搜索网络中…',
  write: '写入文件中…', edit: '编辑文件中…',
  bash: '执行命令中…', pwsh: '执行命令中…',
  subagent: '子代理工作中…', workflow: '执行工作流…',
  ask_user_question: '需要你选择，请到 DSH 界面点选 ⏳',
}

/** ── 配置持久化 ─────────────────────────────────────── */
function configPath() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'super-injector', 'pet-config.json')
}
function skinsDir() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'super-injector', 'pet-skins')
}
const SCALE_MIN = 0.2 // 最小缩放
const SCALE_MAX = 2.0 // 最大缩放（自由档位，用户自行挑选）
const SCALE_DEFAULT = 0.5 // 默认适中
const SCALE_OPTIONS = [0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5, 2.0] // 菜单档位

// 内置形象表：default = 欧门小猫（内嵌精灵图），claude = Claude 像素宠物（assets/claude.webp）
const SKIN_DEFS = [
  { id: 'default', label: '欧门小猫', file: null },
  { id: 'claude', label: 'Claude 形象', file: '../assets/claude.webp' },
]
function builtinSkinFile(id) {
  const d = SKIN_DEFS.find((s) => s.id === id)
  if (!d || !d.file) return null
  try { return fileURLToPath(new URL(d.file, import.meta.url)) } catch { return null }
}

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    return {
      enabled: raw.enabled !== false,
      skin: typeof raw.skin === 'string' && raw.skin ? raw.skin : 'default',
      scale: typeof raw.scale === 'number' && raw.scale > 0 ? clampScale(raw.scale) : SCALE_DEFAULT,
    }
  } catch {
    return { enabled: true, skin: 'default', scale: SCALE_DEFAULT }
  }
}
function clampScale(v) {
  if (typeof v !== 'number' || !isFinite(v)) return SCALE_DEFAULT
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v))
}
function saveConfig(cfg) {
  try {
    mkdirSync(join(configPath(), '..'), { recursive: true })
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
  } catch { /* 保存失败静默 */ }
}

export function apply(ctx, config) {
  const cfg = loadConfig()

  // ── 宠物状态 ──
  const pet = {
    enabled: cfg.enabled,
    skin: cfg.skin,
    scale: cfg.scale,
    state: 'idle',
    message: '',
    ts: 0,
    pending: 0, // 进行中的工具/审批计数
  }

  let idleTimer = null
  function setState(state, message, bumpPending) {
    if (bumpPending) pet.pending += 1
    pet.state = state
    pet.message = message
    pet.ts = Date.now()
    pushState()
  }
  /** wave / failed 等需要停留的临时状态，延迟后自动回到 idle。 */
  function scheduleIdle(ms) {
    if (idleTimer) idleTimer()
    idleTimer = ctx.timeout(() => {
      idleTimer = null
      pet.pending = 0
      setState('idle', '', false)
    }, ms)
  }

  // ── 全局置顶宠物窗口（Electron 透明 BrowserWindow） ──
  let electronMod = null
  let petWin = null
  let dragState = { on: false, startX: 0, startY: 0, base: [0, 0] }

  function stateSnapshot() {
    return {
      state: pet.state,
      message: pet.message,
      ts: pet.ts,
      enabled: pet.enabled,
      skin: pet.skin,
      scale: pet.scale,
      skins: SKIN_DEFS.map((s) => s.id),
    }
  }

  function pushState() {
    if (petWin && !petWin.isDestroyed()) {
      try { petWin.webContents.send('dsh-pet:state', stateSnapshot()) } catch { /* 忽略 */ }
    }
  }

  function syncWindow() {
    if (!petWin || petWin.isDestroyed()) return
    try {
      if (pet.enabled) petWin.show()
      else petWin.hide()
      pushState()
    } catch { /* 忽略 */ }
  }

  function positionBottomRight(win) {
    try {
      const wa = electronMod.screen.getPrimaryDisplay().workArea
      const b = win.getBounds()
      win.setPosition(wa.x + wa.width - b.width - 16, wa.y + wa.height - b.height - 16)
    } catch { /* 忽略 */ }
  }

  function sendSkin(name) {
    if (!petWin || petWin.isDestroyed()) return
    const file = typeof name === 'string' && name ? name : ''
    if (!file) { petWin.webContents.send('dsh-pet:skin', { name: file, b64: '' }); return }
    // 内置形象（如 claude）优先读插件 assets；其他仍走 pet-skins 目录
    let src = builtinSkinFile(file)
    if (!src) {
      if (file.includes('/') || file.includes('..') || !file.toLowerCase().endsWith('.webp')) {
        petWin.webContents.send('dsh-pet:skin', { name: file, b64: '' })
        return
      }
      src = join(skinsDir(), file)
    }
    try {
      const b64 = readFileSync(src).toString('base64')
      petWin.webContents.send('dsh-pet:skin', { name: file, b64 })
    } catch {
      petWin.webContents.send('dsh-pet:skin', { name: file, b64: '' })
    }
  }

  function focusMainWindow() {
    try {
      const all = electronMod.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      const main = all.find((w) => w !== petWin) || all[0]
      if (main) {
        if (main.isMinimized()) main.restore()
        main.show()
        main.focus()
      }
    } catch { /* 忽略 */ }
  }

  // ── 原生右键菜单（系统菜单，不受宠物窗口尺寸限制、点外部自动关闭） ──
  function showMenu(screenX, screenY) {
    if (!electronMod || !petWin || petWin.isDestroyed()) return
    const { Menu } = electronMod
    const tpl = []
    tpl.push({ label: '🐾 DSH 宠物', enabled: false })
    tpl.push({ type: 'separator' })

    // 尺寸档位
    const scaleSub = SCALE_OPTIONS.map((s) => ({
      label: '尺寸 ' + Math.round(s * 100) + '%',
      type: 'radio',
      checked: Math.abs(pet.scale - s) < 0.001,
      click: () => api.set({ scale: s }),
    }))
    tpl.push({ label: '尺寸', submenu: scaleSub })

    // 形象（内置皮肤表：欧门小猫 + Claude 形象；不再扫描 pet-skins 目录）
    const skinSub = SKIN_DEFS.map((s) => ({
      label: (pet.skin === s.id ? '✓ ' : '  ') + s.label,
      type: 'radio',
      checked: pet.skin === s.id,
      click: () => api.set({ skin: s.id }),
    }))
    tpl.push({ label: '形象', submenu: skinSub })

    tpl.push({ type: 'separator' })
    tpl.push({ label: '🔄 刷新皮肤列表', click: () => pushState() })
    tpl.push({ label: (pet.enabled ? '🕐 隐藏宠物' : '🕐 显示宠物'), click: () => api.set({ enabled: !pet.enabled }) })
    tpl.push({ type: 'separator' })
    tpl.push({ label: '左拖：左右走 · 双击：回 DSH', enabled: false })

    try {
      Menu.buildFromTemplate(tpl).popup({ window: petWin, x: Math.round(screenX), y: Math.round(screenY) })
    } catch { /* 忽略 */ }
  }

  // ── 窗口→Host 的 IPC（ipcMain 官方通道，随 fiber 清理） ──
  const IPC_CHANNELS = ['dsh-pet:click', 'dsh-pet:action', 'dsh-pet:dragging', 'dsh-pet:draggingMove', 'dsh-pet:skin-request']
  let ipcListeners = null
  function registerIpc() {
    if (ipcListeners || !electronMod) return
    ipcListeners = {}
    for (const ch of IPC_CHANNELS) {
      ipcListeners[ch] = (event, payload) => handleIpc(ch, payload)
      electronMod.ipcMain.on(ch, ipcListeners[ch])
    }
  }
  function unregisterIpc() {
    if (!ipcListeners || !electronMod) return
    for (const ch of IPC_CHANNELS) electronMod.ipcMain.removeListener(ch, ipcListeners[ch])
    ipcListeners = null
  }

  function handleIpc(channel, payload) {
    try {
      if (channel === 'dsh-pet:click') {
        api.click()
        focusMainWindow()
      } else if (channel === 'dsh-pet:action') {
        const p = payload || {}
        if (p.type === 'set-size') {
          if (petWin && !petWin.isDestroyed() && typeof p.width === 'number' && typeof p.height === 'number') {
            petWin.setSize(Math.max(20, Math.round(p.width)), Math.max(20, Math.round(p.height)))
          }
        } else if (p.type === 'skin' || p.type === 'scale' || p.type === 'enabled') {
          api.set({ [p.type]: p.value })
        } else if (p.type === 'refresh-skins') {
          pushState()
        } else if (p.type === 'interactive') {
          // 鼠标悬停/离开宠物区域 → 关闭/开启点击穿透
          if (petWin && !petWin.isDestroyed()) {
            petWin.setIgnoreMouseEvents(!p.value, { forward: true })
          }
        } else if (p.type === 'menu') {
          // 弹出原生右键菜单（用屏幕坐标）
          showMenu(p.x, p.y)
        }
      } else if (channel === 'dsh-pet:dragging') {
        const p = payload || {}
        if (p.on) {
          dragState.on = true
          dragState.startX = typeof p.x === 'number' ? p.x : 0
          dragState.startY = typeof p.y === 'number' ? p.y : 0
          if (petWin && !petWin.isDestroyed()) dragState.base = petWin.getPosition()
        } else {
          dragState.on = false
        }
      } else if (channel === 'dsh-pet:draggingMove') {
        if (dragState.on && petWin && !petWin.isDestroyed()) {
          const p = payload || {}
          const nx = dragState.base[0] + ((typeof p.x === 'number' ? p.x : 0) - dragState.startX)
          const ny = dragState.base[1] + ((typeof p.y === 'number' ? p.y : 0) - dragState.startY)
          // 直接 setPosition：渲染侧已用 rAF 把 IPC 合并到 ~60fps，这里不需要再节流
          // （主进程 setTimeout 在 DSH 繁忙时会延迟几十 ms，反而导致拖不动）
          petWin.setPosition(Math.round(nx), Math.round(ny))
        }
      } else if (channel === 'dsh-pet:skin-request') {
        sendSkin(payload)
      }
    } catch { /* 忽略 IPC 错误 */ }
  }

  async function ensureWindow() {
    if (petWin && !petWin.isDestroyed()) return petWin
    if (!electronMod) electronMod = await import('electron')
    registerIpc()
    const win = new electronMod.BrowserWindow({
      width: 140,
      height: 190,
      x: 60,
      y: 60,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        // pet-preload.cjs 位于插件根目录，pet.js 在 lib/ 下 → ../pet-preload.cjs
        // 必须 .cjs：package.json "type":"module" 会让 .js 被当 ESM → require('electron') 失败 → preload 不加载
        preload: fileURLToPath(new URL('../pet-preload.cjs', import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    // 置顶级别用 'screen-saver'（Windows 最高档，压住浏览器/视频等普通置顶盖不住的窗口）
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // 失焦（用户点其他窗口）时重新置顶，防止被压到下面；不抢焦点
    win.on('blur', () => {
      try {
        if (petWin === win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
      } catch { /* 忽略 */ }
    })
    // 默认点击穿透（透明窗口不挡下方应用）；forward 让窗口仍能收到 mousemove 检测悬停
    win.setIgnoreMouseEvents(true, { forward: true })
    win.on('closed', () => { if (petWin === win) petWin = null })
    await win.loadFile(fileURLToPath(new URL('./pet-window.html', import.meta.url)))
    petWin = win
    positionBottomRight(win)
    if (pet.enabled) win.show()
    pushState()
    return win
  }

  // 窗口生命周期随插件 fiber 清理
  ctx.effect(() => {
    ensureWindow().catch(() => {})
    return () => {
      unregisterIpc()
      if (petWin && !petWin.isDestroyed()) {
        try { petWin.destroy() } catch { /* 忽略 */ }
      }
      petWin = null
    }
  }, 'dsh-pet: global pet window')

  // ── 事件监听（ctx.on 随 fiber 自动清理） ──
  // agent 状态：idle ⇄ running（工作时气泡常驻 "deep diving..."）
  let agentRunning = false
  ctx.on('agent/status', (payload) => {
    const status = payload && payload.status
    if (status === 'running') {
      agentRunning = true
      setState('running', 'deep diving...', false)
    } else if (status === 'idle') {
      agentRunning = false
      // 只在没有待处理工具时才真正回 idle（防止处理中误回待机）；
      // 若还有 pending，保持当前状态，等 tools/result 收尾
      if (pet.pending <= 0) {
        pet.pending = 0
        setState('idle', '', false)
      }
    }
  })

  // 工具即将执行（waterfall，必须委托 next()）
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const tool = toolNameOf(exec)
      const anim = TOOL_ANIM[tool] || 'running'
      const msg = TOOL_MSG[tool] || '处理中…'
      setState(anim === 'writing' ? 'writing' : anim, msg, true)
    } catch { /* 解析失败不阻塞工具执行 */ }
    return next()
  })

  // 工具执行完毕（emit）
  ctx.on('tools/result', (exec, result) => {
    pet.pending = Math.max(0, pet.pending - 1)
    const ok = !(result && result.error) && result.ok !== false
    if (!ok) {
      setState('failed', '这一步出错了…', false)
      scheduleIdle(4000)
    } else if (pet.pending <= 0) {
      // agent 仍在工作时回到 "deep diving..."（保持提示），否则回 idle
      if (agentRunning) {
        setState('running', 'deep diving...', false)
      } else {
        setState('idle', '', false)
      }
    }
  })

  // 权限请求（waterfall：记录 waiting 提醒 → 委托 next()，决策完成后解除）
  ctx.on('approval/request', (req, next) => {
    pet.pending += 1
    setState('waiting', approvalText(req), false)
    let chain
    try {
      chain = Promise.resolve(next())
    } catch (e) {
      chain = Promise.resolve()
    }
    chain.then((outcome) => {
      pet.pending = Math.max(0, pet.pending - 1)
      const granted = outcome && (outcome.granted === true || outcome.approved === true || outcome.allow === true)
      const denied = outcome && (outcome.granted === false || outcome.approved === false || outcome.deny === true || outcome.denied === true)
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
  const api = {
    /** 当前状态快照（浏览器端每 pollMs 轮询） */
    state: () => stateSnapshot(),
    /** 开关 / 皮肤 / 缩放 */
    set: (payload) => {
      if (payload && typeof payload.enabled === 'boolean') pet.enabled = payload.enabled
      if (payload && typeof payload.skin === 'string') pet.skin = payload.skin
      if (payload && typeof payload.scale === 'number' && payload.scale > 0) pet.scale = clampScale(payload.scale)
      saveConfig({ enabled: pet.enabled, skin: pet.skin, scale: pet.scale })
      syncWindow()
      return { enabled: pet.enabled, skin: pet.skin, scale: pet.scale }
    },
    /** 单击宠物：挥手致意 + 回 DSH */
    click: () => {
      setState('wave', '回到 DSH 界面！', false)
      scheduleIdle(2200)
      return { ok: true }
    },
    /** 皮肤列表（内置形象表） */
    skins: () => ({ skins: SKIN_DEFS.map((s) => s.id) }),
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
      const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/pet/api/') ? pathname.slice('/pet/api/'.length) : ''
      if (!method || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (!handler) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method "' + method + '"' } })
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
      const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
      const raw = pathname.replace(/^\/pet\/skin\//, '')
      let file = raw
      try { file = decodeURIComponent(raw) } catch { /* 保留原始 */ }
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

  if (ctx.logger && ctx.logger.info) {
    ctx.logger.info('[dsh-pet] 宠物 host 就绪（enabled=' + pet.enabled + ' skin=' + pet.skin + '）')
  }
}

/** ── 工具执行对象 → 工具名（防御式读取） ── */
function toolNameOf(exec) {
  if (!exec) return ''
  const t = exec.tool
  if (typeof t === 'string') return t
  if (t && typeof t === 'object' && typeof t.name === 'string') return t.name
  const n = exec.name || exec.toolName || exec.title
  return typeof n === 'string' ? n : ''
}

/** ── 审批请求 → 提醒气泡文案（防御式读取） ── */
function approvalText(req) {
  if (!req) return '需要你的确认…'
  const tool = req.tool && req.tool.name ? req.tool.name : (req.toolName || req.tool)
  const toolStr = typeof tool === 'string' ? tool : ''
  const reason = req.reason || req.message
  const reasonStr = typeof reason === 'string' && reason ? reason : ''
  if (toolStr && reasonStr) return '需要你批准：' + toolStr + '（' + reasonStr + '）'
  if (toolStr) return '需要你批准：' + toolStr
  return '需要你的确认…'
}

/** ── 浏览器信任检查（简化 fence） ── */
function trusted(req) {
  const host = (req.headers && req.headers.host) || ''
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const site = req.headers && req.headers['sec-fetch-site']
  if (site && site === 'cross-site') return false
  return true
}

const MAX_BODY_BYTES = 1 << 20
async function readJsonBody(req) {
  const chunks = []
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
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}
function writeError(res, error) {
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
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}
