import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

export function createReactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
  }
}

export function loadClientBundle() {
  let registration
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  new Function('window', SOURCE)(window)
  if (registration === undefined) throw new Error('client bundle 没有调用 window.__ModuleLoader__.load')
  const react = createReactStub()
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`浏览器半边不该 require：${specifier}`)
  })
  return { id: registration.id, exports, react }
}

export function translator() {
  return (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)
}

export function fakeClientContext({ translate = translator() } = {}) {
  const calls = { effects: [], dictionaries: [], tabs: [], slotInjections: [], slots: [], opened: [] }
  const ctx = {
    effect(factory, label) {
      calls.effects.push(label)
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      bind(namespace) {
        calls.bound = namespace
        return translate
      },
      register(namespace, dicts) {
        calls.dictionaries.push({ namespace, dicts })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        calls.tabs.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab(kind) {
        calls.opened.push(kind)
      },
    },
    slots: {
      inject(name, factory) {
        calls.slotInjections.push(name)
        return factory()
      },
      register(definition, component) {
        calls.slots.push({ definition, component })
        return () => {}
      },
    },
  }
  return { ctx, calls }
}
