/**
 * 配置与历史的持久化。原生走 Rust 写的 state.json，浏览器退化成 localStorage。
 */

import { DEFAULT_CONFIG } from './tutu.js'

export const HISTORY_LIMIT = 100

function defaultState() {
  return { config: { ...DEFAULT_CONFIG }, history: [] }
}

export async function loadState(transport) {
  let raw = ''
  try {
    raw = await transport.readState()
  } catch (error) {
    console.error('读取配置失败', error)
    return defaultState()
  }

  if (!raw) return defaultState()

  try {
    const parsed = JSON.parse(raw)
    return {
      // 逐字段兜默认值：配置结构升级后老文件也不会把某个字段变成 undefined。
      config: { ...DEFAULT_CONFIG, ...(parsed?.config ?? {}) },
      history: Array.isArray(parsed?.history) ? parsed.history.slice(0, HISTORY_LIMIT) : []
    }
  } catch (error) {
    console.error('配置解析失败，按默认值处理', error)
    return defaultState()
  }
}

export async function saveState(transport, state) {
  await transport.writeState(
    JSON.stringify({
      config: state.config,
      history: state.history.slice(0, HISTORY_LIMIT)
    })
  )
}

/** 新的排前面；同一张图重复上传（直链相同）只保留最新一条。 */
export function pushHistory(state, entry) {
  const rest = state.history.filter((item) => item.url !== entry.url)
  state.history = [entry, ...rest].slice(0, HISTORY_LIMIT)
}
