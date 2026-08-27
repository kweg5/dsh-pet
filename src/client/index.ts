/**
 * dsh-pet — DSH 桌面宠物（Client 半）。
 *
 * UI：shell.overlay 帧级浮动层（宠物本体）+ settings.general.item（开关行）。
 * 交互：
 *  - 左键按住左右拖动 → run_l / run_r 行走动画；松开回 idle
 *  - 单击（几乎无位移）→ 切回 DSH 界面（window.focus() + host 挥手）
 *  - 右键 → 菜单（显示/隐藏、切换皮肤、缩放、刷新皮肤列表）
 *  - 状态来自 host /pet/api/state 轮询（idle/running/review/writing/waiting/failed/wave）
 *  - 权限请求时显示 ❗ 气泡并保持显示，直到决策完成
 *
 * 构建：npm run build:client（tsdown → lib/client.js）。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { SPRITE_B64 } from './spritesheet'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

/** 精灵图 8 列 × 9 行，行号映射（与原版 claude-pet 一致） */
const ANIM_ROW: Record<string, number> = {
  idle: 0, run_r: 1, run_l: 2, wave: 3, jump: 4, failed: 5, waiting: 6, running: 7, review: 8, writing: 7,
}
const FRAMES = 8
const ROWS = 9
const FPS = 8
const POLL_MS = 500
const BUBBLE_MS = 3500

const CSS = `
.dsh-pet-root{position:fixed;z-index:2147483000;cursor:grab;user-select:none;-webkit-user-select:none;pointer-events:auto;touch-action:none;}
.dsh-pet-root.dsh-pet-grabbing{cursor:grabbing;}
.dsh-pet-sprite{background-repeat:no-repeat;image-rendering:pixelated;}
.dsh-pet-bubble{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:rgba(255,255,255,0.96);color:#333;border:1px solid #d0d0d0;border-radius:8px;padding:4px 10px;font-size:12px;line-height:1.4;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 10px rgba(0,0,0,0.18);margin:0;display:none;pointer-events:auto;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}
.dsh-pet-bubble::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:rgba(255,255,255,0.96);}
.dsh-pet-menu{position:fixed;z-index:2147483001;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.22);padding:4px;min-width:150px;display:none;font-size:12px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}
.dsh-pet-menu-item{padding:5px 10px;cursor:pointer;border-radius:4px;white-space:nowrap;color:#333;}
.dsh-pet-menu-item:hover{background:#f0f4ff;}
.dsh-pet-menu-item.dsh-pet-menu-check{display:flex;align-items:center;gap:6px;}
.dsh-pet-menu-sep{height:1px;background:#eee;margin:3px 4px;}
.dsh-pet-menu-title{padding:4px 10px;font-weight:600;color:#666;}
.dsh-pet-settings-row{display:flex;align-items:center;gap:10px;padding:4px 0;}
.dsh-pet-settings-row input{width:15px;height:15px;cursor:pointer;}
`

export function apply(ctx: ClientContext): void {
  ctx.effect(() => insertStyles(), 'dsh-pet: styles')

  // 宠物本体：shell.overlay（帧级浮动层，浮于所有列之上）
  ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-pet',
      order: 9999,
      label: () => '🐾 DSH 宠物',
      component: () => createPet(),
    }),
  ), 'dsh-pet: overlay')

  // 设置页开关：settings.general.item
  ctx.effect(() => ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register({
      name: 'settings.general.item',
      id: 'dsh-pet-toggle',
      order: 200,
      label: () => '桌面宠物',
      component: () => createToggle(),
    }),
  ), 'dsh-pet: settings toggle')
}

function insertStyles(): void {
  const style = document.createElement('style')
  style.id = 'dsh-pet-styles'
  style.textContent = CSS
  document.head.appendChild(style)
}

/** ── 宠物组件 ─────────────────────────────────────── */
function createPet(): { render(): HTMLElement } {
  return {
    render() {
      const root = document.createElement('div')
      root.className = 'dsh-pet-root'
      root.dataset.dshPet = ''
      const sprite = document.createElement('div')
      sprite.className = 'dsh-pet-sprite'
      const bubble = document.createElement('div')
      bubble.className = 'dsh-pet-bubble'
      const menu = document.createElement('div')
      menu.className = 'dsh-pet-menu'
      root.append(bubble, sprite, menu)

      // ── 状态（只保留叶子字段） ──
      const host = { state: 'idle', message: '', ts: 0, enabled: true, skin: 'default', scale: 1, skins: [] as string[] }
      const view = { anim: 'idle', frame: 0, dragAnim: null as string | null, dragging: false, moved: false }
      let imgW = 0
      let imgH = 0
      let loaded = false
      let lastTs = -1
      let lastSkin = ''
      let lastScale = -1
      let objUrl: string | null = null
      let bubbleTimer: number | null = null
      let pollTimer = 0
      let animTimer = 0
      let alive = true

      // 初始位置：视口右下角
      const pos = { x: Math.max(8, window.innerWidth - 140), y: Math.max(8, window.innerHeight - 200) }

      // ── 精灵图加载（内置） ──
      const img = new Image()
      img.onload = () => {
        imgW = img.naturalWidth
        imgH = img.naturalHeight
        loaded = true
        applyScale()
        applyPos()
      }
      img.src = 'data:image/webp;base64,' + SPRITE_B64

      // ── 皮肤 ──
      function applySkin(): void {
        lastSkin = host.skin
        if (host.skin === 'default') {
          if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null }
          sprite.style.backgroundImage = 'url("data:image/webp;base64,' + SPRITE_B64 + '")'
          return
        }
        fetch('/pet/skin/' + encodeURIComponent(host.skin))
          .then((r) => { if (!r.ok) throw new Error('skin ' + r.status); return r.blob() })
          .then((blob) => {
            if (objUrl) URL.revokeObjectURL(objUrl)
            objUrl = URL.createObjectURL(blob)
            const skinImg = new Image()
            skinImg.onload = () => {
              imgW = skinImg.naturalWidth
              imgH = skinImg.naturalHeight
              loaded = true
              sprite.style.backgroundImage = 'url("' + objUrl + '")'
              applyScale()
              applyPos()
            }
            skinImg.src = objUrl
          })
          .catch(() => { /* 皮肤加载失败：保持当前形象 */ })
      }

      function applyScale(): void {
        if (!loaded) return
        lastScale = host.scale
        const fw = Math.round((imgW / FRAMES) * host.scale)
        const fh = Math.round((imgH / ROWS) * host.scale)
        sprite.style.width = fw + 'px'
        sprite.style.height = fh + 'px'
        root.style.width = fw + 'px'
        root.style.height = fh + 'px'
      }

      function applyPos(): void {
        root.style.left = pos.x + 'px'
        root.style.top = pos.y + 'px'
      }

      function clamp(v: number, lo: number, hi: number): number {
        return Math.max(lo, Math.min(hi, v))
      }

      // ── 动画循环 ──
      function effectiveAnim(): string {
        if (view.dragAnim) return view.dragAnim
        return view.anim
      }

      function step(): void {
        if (!alive || !root.isConnected) { stopAll(); return }
        if (!loaded || !host.enabled) return
        const anim = effectiveAnim()
        const row = ANIM_ROW[anim] ?? 0
        const fw = imgW / FRAMES
        const fh = imgH / ROWS
        sprite.style.backgroundSize = imgW + 'px ' + imgH + 'px'
        sprite.style.backgroundPosition = (-(view.frame * fw)).toFixed(1) + 'px ' + (-(row * fh)).toFixed(1) + 'px'
        view.frame = (view.frame + 1) % FRAMES
        // wave/jump 播完一轮 → 视觉回 idle（host 状态不变，由轮询覆盖）
        if (view.frame === 0 && (anim === 'wave' || anim === 'jump')) {
          view.anim = 'idle'
        }
      }

      // ── 气泡 ──
      function showBubble(text: string, state: string): void {
        if (!text) {
          bubble.style.display = 'none'
          bubble.textContent = ''
          return
        }
        bubble.textContent = text
        bubble.style.display = 'block'
        if (bubbleTimer !== null) window.clearTimeout(bubbleTimer)
        bubbleTimer = null
        if (state !== 'waiting') {
          bubbleTimer = window.setTimeout(() => { bubble.style.display = 'none' }, BUBBLE_MS)
        }
      }

      // ── 轮询 host 状态 ──
      function poll(): void {
        if (!alive || !root.isConnected) { stopAll(); return }
        fetch('/pet/api/state', { method: 'POST', body: '{}' })
          .then((r) => r.json())
          .then((j) => {
            if (!j?.ok || !alive) return
            const v = j.value
            host.enabled = !!v.enabled
            host.skin = typeof v.skin === 'string' ? v.skin : 'default'
            host.scale = typeof v.scale === 'number' && v.scale > 0 ? v.scale : 1
            host.skins = Array.isArray(v.skins) ? v.skins : []
            if (typeof v.ts === 'number' && v.ts !== lastTs) {
              lastTs = v.ts
              view.anim = typeof v.state === 'string' ? v.state : 'idle'
              view.frame = 0
              showBubble(typeof v.message === 'string' ? v.message : '', view.anim)
            }
            root.style.display = host.enabled ? '' : 'none'
            if (host.skin !== lastSkin) applySkin()
            if (host.scale !== lastScale) applyScale()
            if (!root.style.left) applyPos()
          })
          .catch(() => { /* 轮询失败静默（宿主未就绪） */ })
      }

      // ── 拖动 / 单击 ──
      let startX = 0, startY = 0, origX = 0, origY = 0

      function onDown(e: MouseEvent): void {
        if (e.button !== 0) return
        if (menu.style.display === 'block') { hideMenu(); return }
        view.dragging = true
        view.moved = false
        view.dragAnim = null
        startX = e.clientX
        startY = e.clientY
        origX = pos.x
        origY = pos.y
        root.classList.add('dsh-pet-grabbing')
        e.preventDefault()
      }

      function onMove(e: MouseEvent): void {
        if (!view.dragging) return
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        if (Math.abs(dx) + Math.abs(dy) > 5) view.moved = true
        pos.x = clamp(origX + dx, -4, Math.max(0, window.innerWidth - 8))
        pos.y = clamp(origY + dy, -4, Math.max(0, window.innerHeight - 8))
        applyPos()
        // 水平位移 → 左右走；否则保持 idle
        if (view.moved && Math.abs(dx) > 4) {
          view.dragAnim = dx > 0 ? 'run_r' : 'run_l'
        } else if (view.moved) {
          view.dragAnim = 'idle'
        }
      }

      function onUp(): void {
        if (!view.dragging) return
        view.dragging = false
        root.classList.remove('dsh-pet-grabbing')
        if (view.moved) {
          view.dragAnim = null
          view.anim = 'idle'
          view.frame = 0
        } else {
          // 单击：切回 DSH 界面 + 挥手
          try { window.focus() } catch { /* 忽略 */ }
          fetch('/pet/api/click', { method: 'POST', body: '{}' }).catch(() => {})
        }
      }

      function onContext(e: MouseEvent): void {
        e.preventDefault()
        renderMenu()
        menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px'
        menu.style.top = Math.min(e.clientY, window.innerHeight - 300) + 'px'
        menu.style.display = 'block'
      }

      // ── 右键菜单 ──
      function hideMenu(): void {
        menu.style.display = 'none'
      }

      function renderMenu(): void {
        menu.innerHTML = ''
        const title = document.createElement('div')
        title.className = 'dsh-pet-menu-title'
        title.textContent = '🐾 DSH 宠物'
        menu.append(title)

        const toggle = document.createElement('div')
        toggle.className = 'dsh-pet-menu-item dsh-pet-menu-check'
        toggle.textContent = host.enabled ? '☑ 显示宠物' : '☐ 显示宠物'
        toggle.addEventListener('click', () => {
          fetch('/pet/api/set', { method: 'POST', body: JSON.stringify({ enabled: !host.enabled }) })
            .then(() => { hideMenu() }).catch(() => {})
        })
        menu.append(toggle)

        const sep1 = document.createElement('div')
        sep1.className = 'dsh-pet-menu-sep'
        menu.append(sep1)

        const skinTitle = document.createElement('div')
        skinTitle.className = 'dsh-pet-menu-title'
        skinTitle.textContent = '形象'
        menu.append(skinTitle)
        const skins = ['default'].concat(host.skins)
        for (const skin of skins) {
          const item = document.createElement('div')
          item.className = 'dsh-pet-menu-item dsh-pet-menu-check'
          item.textContent = (host.skin === skin ? '✓ ' : '  ') + (skin === 'default' ? '默认' : skin.replace(/\.webp$/i, ''))
          item.addEventListener('click', () => {
            fetch('/pet/api/set', { method: 'POST', body: JSON.stringify({ skin }) })
              .then(() => { hideMenu() }).catch(() => {})
          })
          menu.append(item)
        }

        const sep2 = document.createElement('div')
        sep2.className = 'dsh-pet-menu-sep'
        menu.append(sep2)

        const zoomIn = document.createElement('div')
        zoomIn.className = 'dsh-pet-menu-item'
        zoomIn.textContent = '🔍 放大'
        zoomIn.addEventListener('click', () => {
          fetch('/pet/api/set', { method: 'POST', body: JSON.stringify({ scale: +(host.scale + 0.2).toFixed(2) }) })
            .then(() => { hideMenu() }).catch(() => {})
        })
        menu.append(zoomIn)
        const zoomOut = document.createElement('div')
        zoomOut.className = 'dsh-pet-menu-item'
        zoomOut.textContent = '🔎 缩小'
        zoomOut.addEventListener('click', () => {
          fetch('/pet/api/set', { method: 'POST', body: JSON.stringify({ scale: +(Math.max(0.4, host.scale - 0.2)).toFixed(2) }) })
            .then(() => { hideMenu() }).catch(() => {})
        })
        menu.append(zoomOut)
        const refresh = document.createElement('div')
        refresh.className = 'dsh-pet-menu-item'
        refresh.textContent = '🔄 刷新皮肤列表'
        refresh.addEventListener('click', () => {
          fetch('/pet/api/state', { method: 'POST', body: '{}' }).then((r) => r.json())
            .then((j) => { if (j?.ok) host.skins = j.value.skins ?? [] }).catch(() => {})
          hideMenu()
        })
        menu.append(refresh)

        const sep3 = document.createElement('div')
        sep3.className = 'dsh-pet-menu-sep'
        menu.append(sep3)
        const tip = document.createElement('div')
        tip.className = 'dsh-pet-menu-item'
        tip.textContent = '左拖：左右走 · 单击：回 DSH · 右键：菜单'
        tip.style.color = '#888'
        menu.append(tip)
      }

      function onDocClick(e: MouseEvent): void {
        if (menu.style.display === 'block' && !menu.contains(e.target as Node)) hideMenu()
      }

      // ── 定时器（isConnected / alive 守卫，避免泄漏） ──
      function stopAll(): void {
        if (!alive) return
        alive = false
        window.clearInterval(pollTimer)
        window.clearInterval(animTimer)
        if (bubbleTimer !== null) window.clearTimeout(bubbleTimer)
        if (objUrl) URL.revokeObjectURL(objUrl)
      }

      root.addEventListener('mousedown', onDown)
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      root.addEventListener('contextmenu', onContext)
      document.addEventListener('click', onDocClick)

      pollTimer = window.setInterval(poll, POLL_MS)
      animTimer = window.setInterval(step, Math.round(1000 / FPS))
      poll()
      applyPos()

      return root
    },
  }
}

/** ── 设置页开关行 ─────────────────────────────────── */
function createToggle(): { render(): HTMLElement } {
  return {
    render() {
      const row = document.createElement('div')
      row.className = 'dsh-pet-settings-row'
      const label = document.createElement('label')
      label.textContent = '🐾 桌面宠物'
      const input = document.createElement('input')
      input.type = 'checkbox'
      row.append(label, input)

      fetch('/pet/api/state', { method: 'POST', body: '{}' })
        .then((r) => r.json())
        .then((j) => { if (j?.ok) input.checked = !!j.value.enabled })
        .catch(() => {})
      input.addEventListener('change', () => {
        fetch('/pet/api/set', { method: 'POST', body: JSON.stringify({ enabled: input.checked }) })
          .catch(() => { input.checked = !input.checked })
      })
      return row
    },
  }
}
