#!/usr/bin/env node
/**
 * 生成 lib/client.js 与 lib/pet-window.html：把内嵌精灵图 base64 填入模板。
 * 用法：node scripts/make-client.js
 * （手写产物形态——本插件不依赖 tsc/tsdown/DSH_CHECKOUT 构建链）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const b64Path = join(ROOT, 'assets', 'spritesheet.b64.txt')
const b64 = readFileSync(b64Path, 'utf8').trim()

// 1) client.js（模板已内嵌精灵图引用方式？否——宠物已迁到窗口页，client 仅含开关，无 b64）
const tplPath = join(ROOT, 'lib', 'client.template.js')
const outPath = join(ROOT, 'lib', 'client.js')
const tpl = readFileSync(tplPath, 'utf8')
writeFileSync(outPath, tpl.replace('__SPRITE_B64__', b64), 'utf8')
console.log('client.js generated:', outPath)

// 2) pet-window.html（全局宠物窗口页面）
const winTplPath = join(ROOT, 'lib', 'pet-window.template.html')
const winOutPath = join(ROOT, 'lib', 'pet-window.html')
if (existsSync(winTplPath)) {
  const winTpl = readFileSync(winTplPath, 'utf8')
  if (!winTpl.includes('__SPRITE_B64__')) {
    console.error('ERROR: pet-window.template.html 缺少 __SPRITE_B64__ 占位符')
    process.exit(1)
  }
  writeFileSync(winOutPath, winTpl.replace('__SPRITE_B64__', b64), 'utf8')
  console.log('pet-window.html generated:', winOutPath)
}
