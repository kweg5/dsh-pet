// dsh-pet — 全局宠物窗口 preload 桥（CommonJS）。
// 必须用 .cjs 后缀：package.json "type":"module" 会让 .js 被当 ES Module → require('electron') 失败 → preload 不加载。
// contextIsolation:true 下必须用 contextBridge.exposeInMainWorld 暴露到主世界，
// 直接 window.xxx = 只会写进隔离上下文，页面访问不到。
const { ipcRenderer, contextBridge } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  onState(cb) { ipcRenderer.on('dsh-pet:state', (e, state) => cb(state)) },
  onSkin(cb) { ipcRenderer.on('dsh-pet:skin', (e, payload) => cb(payload)) },
  click() { ipcRenderer.send('dsh-pet:click') },
  action(payload) { ipcRenderer.send('dsh-pet:action', payload) },
  requestSkin(name) { ipcRenderer.send('dsh-pet:skin-request', name) },
  dragging(on, x, y) { ipcRenderer.send('dsh-pet:dragging', { on, x, y }) },
  draggingMove(x, y) { ipcRenderer.send('dsh-pet:draggingMove', { x, y }) },
})
