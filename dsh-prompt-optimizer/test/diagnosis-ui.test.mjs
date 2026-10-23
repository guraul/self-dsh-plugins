/**
 * 诊断卡「点击展开」回归测试。
 *
 * 背景:上一版是 hover 浮卡 —— `pointer-events:none` + `maxHeight:320`,既不能滚
 * 也不能选中复制,鼠标一动卡片还可能消失。改版后:按钮右上角 6px 圆点(只在有
 * 诊断、非 loading、且诊断属于当前会话时出现),点击展开固定卡片,三种方式收起
 * (Esc / 点外部 / 再点圆点),切会话自动收起。
 *
 * 这里没有 react-dom(仓库刻意不引),但 React 的函数组件只依赖 hook 调度器,
 * 所以用 `__SECRET_INTERNALS...ReactCurrentDispatcher` 起一个最小无头渲染器:
 * 真实调用 OptimizeButton 组件函数、真实跑 useState/useRef/useEffect,再遍历
 * 返回的元素树断言 DOM 结构与事件行为。测试入口由 esbuild 现场打成 ESM
 * (输出到 node_modules/.cache,不进 lib/、不进 git)。
 *
 * 运行:`pnpm test`(esbuild 是 devDependency)。
 */
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React from 'react'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(root, 'node_modules', '.cache', 'dsh-po-test')
const outfile = path.join(outDir, 'ui.mjs')

await mkdir(outDir, { recursive: true })
await build({
  stdin: {
    contents: [
      "export { createOptimizeButton } from './src/client/OptimizeButton.tsx'",
      "export { DiagnosisCard } from './src/client/DiagnosisCard.tsx'",
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'diagnosis-ui-entry.ts',
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  jsx: 'automatic',
  packages: 'external',
  logLevel: 'silent',
})

const { createOptimizeButton, DiagnosisCard } = await import(pathToFileURL(outfile).href)
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

/** 假 document:只实现组件用到的 addEventListener / removeEventListener。 */
function createFakeDocument() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
    },
    count(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

const doc = createFakeDocument()
globalThis.document = doc

/**
 * 最小无头渲染器:按 hook 调用顺序保存槽位,setState 标脏后同步重渲染,
 * effect 在每次渲染提交后执行(依赖不变则跳过;重跑前先跑上次的 cleanup)。
 */
function mount(Component, initialProps) {
  const slots = []
  const cleanups = new Map()
  let index = 0
  let dirty = false
  let pendingEffects = []
  let props = initialProps
  let tree = null

  const dispatcher = {
    useState(initial) {
      const i = index++
      const slot = (slots[i] ??= { value: typeof initial === 'function' ? initial() : initial })
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const i = index++
      return (slots[i] ??= { current: initial })
    },
    useEffect(fn, deps) {
      const i = index++
      const prev = slots[i]
      const same =
        prev && prev.deps && deps && prev.deps.length === deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))
      if (same) return
      slots[i] = { deps: deps ? [...deps] : null }
      pendingEffects.push({ i, fn })
    },
    useMemo(fn) {
      const i = index++
      const slot = (slots[i] ??= { value: fn() })
      return slot.value
    },
    useCallback(fn) {
      return fn
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      // 测试里不做订阅:controller 变化后由 render() 显式驱动。
      return getSnapshot()
    },
  }

  const commit = () => {
    const effects = pendingEffects
    pendingEffects = []
    for (const { i, fn } of effects) {
      const prevCleanup = cleanups.get(i)
      if (prevCleanup) {
        cleanups.delete(i)
        prevCleanup()
      }
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.set(i, cleanup)
    }
  }

  const render = (nextProps = props) => {
    props = nextProps
    let guard = 0
    do {
      dirty = false
      index = 0
      pendingEffects = []
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try {
        tree = Component(props)
      } finally {
        internals.ReactCurrentDispatcher.current = previous
      }
      commit()
    } while (dirty && ++guard < 50)
    if (guard >= 50) throw new Error('渲染未收敛(状态更新疑似死循环)')
    return tree
  }

  const unmount = () => {
    for (const [i, cleanup] of [...cleanups.entries()]) {
      cleanups.delete(i)
      cleanup()
    }
    props = null
  }

  return { render, unmount, get tree() { return tree } }
}

/** 展开元素树(function 子组件都是无 hooks 的纯展示组件,可直接调用)。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  if (typeof node.type === 'function') collect(node.type(node.props), out)
  else if (node.props && node.props.children !== undefined) collect(node.props.children, out)
  return out
}

const byClass = (tree, name) =>
  collect(tree).find((el) => typeof el.props?.className === 'string' && el.props.className.split(' ').includes(name))
const byRole = (tree, role) => collect(tree).find((el) => el.props?.role === role)

/** 模拟 React 点击:记录 stopPropagation 是否被调用。 */
function click(el) {
  assert.equal(typeof el.props?.onClick, 'function', '目标元素应挂 onClick')
  let stopped = false
  el.props.onClick({ stopPropagation: () => { stopped = true }, preventDefault() {}, target: el })
  return stopped
}

/** controller 替身:只实现按钮真正用到的面,状态可直接改。 */
function createController(patch) {
  let state = {
    open: false,
    status: 'idle',
    error: null,
    result: null,
    live: null,
    last: null,
    applied: null,
    lastAnalysis: null,
    ...patch,
  }
  const listeners = new Set()
  const set = (next) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const controller = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
    set,
    async optimize() {},
    retry() {},
    settle() {
      set({ status: 'idle', live: null })
    },
    markApplied(applied) {
      set({ applied })
    },
    clearApplied() {
      set({ applied: null })
    },
    close() {
      set({ last: null, lastAnalysis: null })
    },
    cancel() {},
  }
  return controller
}

const DIAGNOSIS = '目标清晰度 | 目标模糊 | 明确产出物\n输出规格 | 缺少格式要求 | 指定 Markdown'
const baseProps = { input: { draft: '帮我看看这段代码' }, sessionId: 's1', inputActions: { setDraft() {} } }

function mountButton(statePatch, props = baseProps) {
  const controller = createController(statePatch)
  const Component = createOptimizeButton(controller)
  const view = mount(Component, props)
  view.render()
  return { view, controller, doc }
}

// ---- d1 圆点只在「有诊断 + 非 loading + 属当前会话」时出现 ----
{
  const shown = mountButton({
    last: { text: 't', sessionId: 's1' },
    lastAnalysis: DIAGNOSIS,
  })
  const dot = byClass(shown.view.tree, 'dsh-po-dot')
  assert.ok(dot, '有诊断且属于当前会话时应显示圆点')
  assert.equal(dot.type, 'button')
  assert.equal(dot.props.style.width, 6)
  assert.equal(dot.props.style.height, 6)
  assert.equal(dot.props.style.borderRadius, 999)
  assert.equal(dot.props.style.top, 1)
  assert.equal(dot.props.style.right, 1)
  assert.match(String(dot.props.style.background), /#4f7cf7/)
  assert.equal(dot.props['aria-label'], '查看诊断')
  assert.equal(byRole(shown.view.tree, 'dialog'), undefined, '未点击时不应展开卡片')
  shown.view.unmount()

  const noDiagnosis = mountButton({ last: { text: 't', sessionId: 's1' }, lastAnalysis: null })
  assert.equal(byClass(noDiagnosis.view.tree, 'dsh-po-dot'), undefined, '无诊断不显示圆点')
  noDiagnosis.view.unmount()

  const otherSession = mountButton({ last: { text: 't', sessionId: 's2' }, lastAnalysis: DIAGNOSIS })
  assert.equal(byClass(otherSession.view.tree, 'dsh-po-dot'), undefined, '诊断属于别的会话时不显示圆点')
  otherSession.view.unmount()

  const loading = mountButton({ status: 'loading', last: { text: 't', sessionId: 's1' }, lastAnalysis: DIAGNOSIS })
  assert.equal(byClass(loading.view.tree, 'dsh-po-dot'), undefined, 'loading 期间不显示圆点')
  loading.view.unmount()

  console.log('✓ d1 圆点出现条件(有诊断 / 非 loading / 当前会话)')
}

// ---- d2 点击圆点展开卡片;卡片可滚可复制;圆点不冒泡 ----
{
  const { view } = mountButton({ last: { text: 't', sessionId: 's1' }, lastAnalysis: DIAGNOSIS })
  const dot = byClass(view.tree, 'dsh-po-dot')
  assert.equal(click(dot), true, '点击圆点必须 stopPropagation(否则会触发主按钮 onClick)')
  view.render()

  const dialog = byRole(view.tree, 'dialog')
  assert.ok(dialog, '点击圆点后应出现 role="dialog" 的诊断卡')
  assert.equal(dialog.props.style.pointerEvents, 'auto', '卡片必须可交互(能滚动、能选中复制)')
  assert.equal(dialog.props.style.maxHeight, 400)
  assert.equal(dialog.props.style.overflowY, 'auto')
  assert.equal(dialog.props.style.whiteSpace, 'pre-wrap')
  assert.equal(dialog.props.style.bottom, 'calc(100% + 8px)')
  assert.equal(dialog.props.style.right, 0)
  assert.equal(dialog.props.style.zIndex, 2147483000)
  assert.equal(dialog.props['aria-label'], '诊断分析')
  assert.equal(byClass(view.tree, 'dsh-po-dot').props['aria-label'], '收起诊断', '展开后圆点提示改为「收起诊断」')
  assert.equal(doc.count('keydown'), 1, '展开后应挂上 document keydown 监听')
  assert.equal(doc.count('click'), 1, '展开后应挂上 document click 监听')
  view.unmount()
  assert.equal(doc.count('click'), 0, '卸载后必须移除 document 监听')
  assert.equal(doc.count('keydown'), 0)

  console.log('✓ d2 点击圆点展开卡片(role=dialog / pointer-events:auto / maxHeight 400)')
}

// ---- d3 Escape 收起 ----
{
  const { view } = mountButton({ last: { text: 't', sessionId: 's1' }, lastAnalysis: DIAGNOSIS })
  click(byClass(view.tree, 'dsh-po-dot'))
  view.render()
  assert.ok(byRole(view.tree, 'dialog'))

  doc.dispatch('keydown', { key: 'Escape' })
  view.render()
  assert.equal(byRole(view.tree, 'dialog'), undefined, 'Escape 应收起卡片')
  assert.equal(doc.count('keydown'), 0, '收起后监听应清理')
  view.unmount()

  console.log('✓ d3 Escape 收起')
}

// ---- d4 再点圆点收起(toggle);点卡片内部不收起;点外部收起 ----
{
  const { view } = mountButton({ last: { text: 't', sessionId: 's1' }, lastAnalysis: DIAGNOSIS })
  click(byClass(view.tree, 'dsh-po-dot'))
  view.render()
  assert.ok(byRole(view.tree, 'dialog'))

  // 卡片内的点击(含滚动条)不算「点外部」
  doc.dispatch('click', { target: { closest: (sel) => (String(sel).includes('.dsh-po-diagnosis') ? '.dsh-po-diagnosis' : null) } })
  view.render()
  assert.ok(byRole(view.tree, 'dialog'), '点击卡片内部不应收起')

  click(byClass(view.tree, 'dsh-po-dot'))
  view.render()
  assert.equal(byRole(view.tree, 'dialog'), undefined, '再次点击圆点应收起')

  // 点外部收起
  click(byClass(view.tree, 'dsh-po-dot'))
  view.render()
  assert.ok(byRole(view.tree, 'dialog'))
  doc.dispatch('click', { target: { closest: () => null } })
  view.render()
  assert.equal(byRole(view.tree, 'dialog'), undefined, '点击按钮/卡片以外区域应收起')

  // 主按钮自身不算外部
  click(byClass(view.tree, 'dsh-po-dot'))
  view.render()
  doc.dispatch('click', { target: { closest: (sel) => (String(sel).includes('.dsh-po-btn') ? '.dsh-po-btn' : null) } })
  view.render()
  assert.ok(byRole(view.tree, 'dialog'), '点击主按钮不应收起')
  view.unmount()

  console.log('✓ d4 圆点 toggle / 点卡片内部不收起 / 点外部收起')
}

// ---- d5 切会话自动收起 ----
{
  const { view, controller } = mountButton({ last: { text: 't', sessionId: 's1' }, lastAnalysis: DIAGNOSIS })
  click(byClass(view.tree, 'dsh-po-dot'))
  view.render()
  assert.ok(byRole(view.tree, 'dialog'))

  // 宿主切会话:sessionId 换掉(诊断归属仍是 s1,圆点随之消失)
  view.render({ ...baseProps, sessionId: 's2' })
  assert.equal(byRole(view.tree, 'dialog'), undefined, '切会话后卡片必须自动收起')
  assert.equal(byClass(view.tree, 'dsh-po-dot'), undefined, '旧会话的诊断圆点不应跟到新会话')
  assert.equal(doc.count('click'), 0, '收起后 document 监听应清理')
  view.unmount()
  void controller

  console.log('✓ d5 切会话自动收起')
}

// ---- d6 新一轮优化(loading)时收起卡片,结束后不会自动弹回 ----
{
  const { view, controller } = mountButton({ last: { text: 't', sessionId: 's1' }, lastAnalysis: DIAGNOSIS })
  click(byClass(view.tree, 'dsh-po-dot'))
  view.render()
  assert.ok(byRole(view.tree, 'dialog'))

  controller.set({ status: 'loading' })
  view.render()
  assert.equal(byRole(view.tree, 'dialog'), undefined, '开始新一轮优化时应收起旧卡片')
  assert.equal(byClass(view.tree, 'dsh-po-dot'), undefined, 'loading 期间圆点同样不显示')

  controller.set({ status: 'idle' })
  view.render()
  assert.ok(byClass(view.tree, 'dsh-po-dot'), '结束后圆点回来')
  assert.equal(byRole(view.tree, 'dialog'), undefined, '旧卡片不得自动弹回')
  view.unmount()

  console.log('✓ d6 loading 收起卡片,结束后不自动弹回')
}

// ---- d7 hover 逻辑已移除;title 始终保留 ----
{
  const { view } = mountButton({ last: { text: 't', sessionId: 's1' }, lastAnalysis: DIAGNOSIS })
  const elements = collect(view.tree)
  const withHover = elements.filter((el) => el.props?.onMouseEnter || el.props?.onMouseLeave || el.props?.onFocus || el.props?.onBlur)
  assert.equal(withHover.length, 0, '不应再有 hover / focus 触发展开的事件处理器')
  const button = byClass(view.tree, 'dsh-po-btn')
  assert.equal(button.props.title, button.props['aria-label'], 'title 始终显示(不再按 hover 清空)')
  assert.ok(button.props.title.length > 0)
  view.unmount()

  console.log('✓ d7 hover / focus 展开逻辑已移除,title 始终保留')
}

// ---- d8 DiagnosisCard 纯展示层属性(直接调用组件函数,不需要渲染器) ----
{
  const card = DiagnosisCard({ text: DIAGNOSIS, title: '诊断分析' })
  assert.equal(card.type, 'div')
  assert.equal(card.props.role, 'dialog')
  assert.equal(card.props['aria-label'], '诊断分析')
  assert.equal(card.props.style.pointerEvents, 'auto')
  assert.equal(card.props.style.maxHeight, 400)
  assert.equal(card.props.style.overflowY, 'auto')
  assert.equal(card.props.style.whiteSpace, 'pre-wrap')
  assert.equal(card.props.style.wordBreak, 'break-word')
  assert.equal(card.props.style.position, 'absolute')
  assert.equal(card.props.style.zIndex, 2147483000)
  assert.equal(card.props.tabIndex, 0, '卡片可聚焦(键盘能滚动内容)')
  // 小标题 + 诊断正文都要在
  const flat = JSON.stringify(card.props.children)
  assert.ok(flat.includes('诊断分析'), '卡片内应有小标题')
  assert.ok(flat.includes('目标清晰度'), '卡片内应有诊断正文')

  console.log('✓ d8 DiagnosisCard 可滚可复制(pointer-events:auto / maxHeight 400 / role=dialog)')
}

await rm(outDir, { recursive: true, force: true })

console.log('\ndiagnosis-ui: all passed')
