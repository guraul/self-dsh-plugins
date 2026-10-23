/**
 * 设置页「记忆」——memx 薄壳包的 Web 客户端页面。
 *
 * 四项：
 *   1. 提炼模型（下拉，首项「跟随当前会话」，其余按 provider 分组）
 *   2. 自动提炼（开关）
 *   3. 提炼间隔（分钟，1–1440）
 *   4. 只读说明（注入语义 + 当前选择）
 *
 * 读写全部走 `ctx.configForms.get('memx')`：`form.mutate([{ op:'set', path, value }])`
 * 即"改完就落盘"，没有保存按钮。宿主拒绝写（含并发冲突）时 `mutate` 返回 false 并
 * 自行重读最新值；页面只在顶部提示，不保留脏草稿。
 *
 * ⚠️ form 不在 `apply` 时捕获，而是每次渲染经 `formFor()` 现取：宿主下发设置项的
 * 时机与本插件激活顺序无关，apply 那一刻可能还没有这张 form。缺失时**不崩**，
 * 渲染状态块并按 `FORM_RETRY_INTERVAL_MS` 轮询，超过 `FORM_RETRY_TIMEOUT_MS` 提示刷新。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** 宿主配置条目 id（`cordis.patch.yml` → `- insert: - id: memx`）。 */
export const SETTINGS_ENTRY_ID = 'memx'

/** 与宿主 Config 对应的分节（entry id = `memx`）。 */
export interface MemxSettingsValue {
  provider?: string
  model?: string
  autoRefine?: boolean
  throttleMinutes?: number
}

/** 模型目录分组（只声明页面消费的字段，避免追着上游类型跑）。 */
export interface MemxModelGroup {
  id: string
  name: string
  models: readonly { id: string; name: string }[]
}

/** `ctx.remote.session.modelCatalog()` 的返回面（页面只读 groups）。 */
export interface MemxModelCatalog {
  groups?: readonly MemxModelGroup[]
}

/** 提炼间隔的合法区间（与 Host 侧 `throttleMinutes` 的 schema 一致）。 */
const THROTTLE_MIN = 1
const THROTTLE_MAX = 1440
const THROTTLE_COMMIT_DELAY_MS = 500

/** form 缺失时的重试节奏：平时 300ms 一次，约 20s 后放弃并提示刷新。 */
const FORM_RETRY_INTERVAL_MS = 300
const FORM_RETRY_TIMEOUT_MS = 20_000

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const message = (error as { message?: unknown } | undefined)?.message
  return typeof message === 'string' && message ? message : String(error)
}

function isConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'SETTINGS_CONFLICT' || errorMessage(error).includes('SETTINGS_CONFLICT')
}

/** 只注入一次的页面样式（类名带前缀，避免与官方设置页抢样式）。 */
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const ID = 'dsh-plugin-memx-settings-styles'
  if (document.getElementById(ID)) return
  const style = document.createElement('style')
  style.id = ID
  style.textContent = [
    '.memx-st-page{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;}',
    '.memx-st-head{display:flex;flex-direction:column;gap:4px;}',
    '.memx-st-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}',
    '.memx-st-sub{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280);}',
    '.memx-st-diag{margin:0;font-size:11px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-word;}',
    '.memx-st-card{display:flex;flex-direction:column;gap:18px;padding:16px 18px;border-radius:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.24));background:var(--dsw-alias-fill-primary,transparent);}',
    '.memx-st-row{display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr);gap:6px 20px;align-items:start;}',
    '.memx-st-label{font-size:13px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary,inherit);}',
    '.memx-st-label small{display:block;font-weight:400;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280);}',
    '.memx-st-field{display:flex;flex-direction:column;gap:6px;min-width:0;}',
    '.memx-st-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.memx-st-select,.memx-st-input{box-sizing:border-box;min-height:28px;padding:4px 8px;border-radius:8px;font-size:13px;color:inherit;background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.06));border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));}',
    '.memx-st-select{min-width:0;max-width:100%;flex:1 1 260px;}',
    '.memx-st-input{width:110px;}',
    '.memx-st-select:focus-visible,.memx-st-input:focus-visible,.memx-st-check:focus-visible{outline:2px solid var(--dsw-alias-state-focus-ring,#4f7cf7);outline-offset:1px;}',
    '.memx-st-check{width:16px;height:16px;margin:6px 8px 0 0;accent-color:var(--dsw-alias-state-focus-ring,#4f7cf7);}',
    '.memx-st-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280);}',
    '.memx-st-error{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error,#d93025);}',
    '.memx-st-notice{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.6;}',
    '.memx-st-notice[data-kind="error"]{color:var(--dsw-alias-state-error,#d93025);background:color-mix(in srgb,var(--dsw-alias-state-error,#d93025) 10%,transparent);}',
    '.memx-st-notice[data-kind="info"]{color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.08));}',
    '.memx-st-dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:12px;line-height:1.6;}',
    '.memx-st-dl dt{color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;}',
    '.memx-st-dl dd{margin:0;color:var(--dsw-alias-label-primary,inherit);word-break:break-word;}',
    '.memx-st-disabled{opacity:.6;}',
  ].join('')
  document.head.appendChild(style)
}

export interface MemorySettingsOptions {
  /**
   * 现取 `ctx.configForms.get('memx')`。允许返回 undefined：宿主还没下发设置项时
   * 就是空的（旧实现只在 apply 时取一次，取空后整页白屏）。
   */
  formFor: () => ConfigForm<MemxSettingsValue> | undefined
  /** `ctx.remote.session.modelCatalog()`。 */
  loadCatalog: () => Promise<MemxModelCatalog>
}

/** 异常/非 ready 才显示的一行诊断（entry / status / writable / revision）。 */
function Diagnostic({ snapshot }: { snapshot?: ConfigFormSnapshot<MemxSettingsValue> }) {
  const status = snapshot?.status ?? 'missing'
  if (status === 'ready') return null
  const writable = snapshot === undefined ? 'unknown' : String(snapshot.writable)
  const revision = snapshot?.revision === undefined ? '—' : String(snapshot.revision)
  return (
    <p className="memx-st-diag" data-status={status}>
      {`entry=${SETTINGS_ENTRY_ID} · status=${status} · writable=${writable} · revision=${revision}`}
    </p>
  )
}

/** 设置页外壳：等待 form（可缺失）与顶部标题。 */
function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <div className="memx-st-page">
      <div className="memx-st-head">
        <h2 className="memx-st-title">记忆</h2>
        <p className="memx-st-sub">
          memx 长期记忆：注入、自动提炼与提炼模型。改动即时保存，没有保存按钮。
        </p>
      </div>
      {children}
    </div>
  )
}

/** 造一个设置页组件（闭包持有取值函数，避免注册参数把内部结构漏给槽位契约）。 */
export function createMemorySettings(options: MemorySettingsOptions) {
  const { formFor, loadCatalog } = options

  return function MemxMemorySettings(_props: { close?: () => void }) {
    ensureStyles()

    // 每次渲染现取：宿主下发 form 的时机与本插件激活顺序无关。
    const form = formFor()
    // 缺失时的轮询：只靠 interval 触发重渲染，下一轮 formFor() 自然重新取值。
    const [waitedFrom] = useState(() => Date.now())
    const [, setProbe] = useState(0)
    const waiting = form === undefined
    const timedOut = waiting && Date.now() - waitedFrom >= FORM_RETRY_TIMEOUT_MS

    useEffect(() => {
      if (!waiting) return
      const timer = window.setInterval(() => setProbe((count) => count + 1), FORM_RETRY_INTERVAL_MS)
      return () => window.clearInterval(timer)
    }, [waiting])

    if (form === undefined) {
      return (
        <SettingsPage>
          <Diagnostic />
          <div className="memx-st-notice" data-kind={timedOut ? 'error' : 'info'} role="status">
            {timedOut
              ? `配置项仍未就绪，请刷新页面（entry id: ${SETTINGS_ENTRY_ID}）。`
              : `配置项尚未就绪：正在等待宿主下发设置项（entry id: ${SETTINGS_ENTRY_ID}）…`}
          </div>
        </SettingsPage>
      )
    }

    return <MemorySettingsForm form={form} loadCatalog={loadCatalog} />
  }
}

interface MemorySettingsFormProps {
  form: ConfigForm<MemxSettingsValue>
  loadCatalog: () => Promise<MemxModelCatalog>
}

/** form 就绪后的实体页面。单独成组件：form 从无到有时钩子数量不变。 */
function MemorySettingsForm({ form, loadCatalog }: MemorySettingsFormProps) {
  const snapshot = useSyncExternalStore(
    (callback) => form.subscribe(callback),
    () => form.getSnapshot(),
  )
  const value = snapshot.value ?? {}
  const writable = snapshot.writable !== false
  const status = snapshot.status

  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [catalog, setCatalog] = useState<{
    state: 'loading' | 'ready' | 'error'
    groups: readonly MemxModelGroup[]
    error?: string
  }>({ state: 'loading', groups: [] })

  const alive = useRef(true)
  const reloadCatalog = useCallback(() => {
    setCatalog((current) => ({ state: 'loading', groups: current.groups }))
    let request: Promise<MemxModelCatalog>
    try {
      // 同步抛错（ctx.remote.session 还没就绪等）也要留在页面里，别让异常从 effect 逃逸。
      request = Promise.resolve(loadCatalog())
    } catch (err) {
      if (alive.current) setCatalog({ state: 'error', groups: [], error: errorMessage(err) })
      return
    }
    void request
      .then((result) => {
        if (!alive.current) return
        setCatalog({ state: 'ready', groups: result?.groups ?? [] })
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        setCatalog({ state: 'error', groups: [], error: errorMessage(err) })
      })
  }, [loadCatalog])

  useEffect(() => {
    alive.current = true
    reloadCatalog()
    return () => {
      alive.current = false
    }
  }, [reloadCatalog])

  /** 所有写入的唯一出口：失败/冲突 → 顶部提示（form 自己会重读最新值）。 */
  const save = useCallback(
    async (ops: readonly SettingsPathOpView[]) => {
      if (!writable) return
      try {
        const accepted = await form.mutate(ops)
        setNotice(
          accepted
            ? null
            : {
                kind: 'error',
                text: '保存失败：宿主没有接受这次修改（可能已被其它页面改动）。已重新读取最新值，请再试一次。',
              },
        )
      } catch (err) {
        setNotice({
          kind: 'error',
          text: isConflict(err)
            ? '保存冲突：设置已在别处被修改。已重新读取最新值，请再试一次。'
            : `保存失败：${errorMessage(err)}`,
        })
      }
    },
    [form, writable],
  )

  // —— 提炼模型 ——
  const selected = value.provider && value.model ? `${value.provider}/${value.model}` : ''
  const groups = catalog.groups
  const selectedInCatalog =
    selected === '' || groups.some((group) => group.models.some((model) => `${group.id}/${model.id}` === selected))
  const selectedLabel = (() => {
    if (selected === '') return '跟随当前会话'
    for (const group of groups) {
      for (const model of group.models) {
        if (`${group.id}/${model.id}` === selected) return `${group.name} · ${model.name}`
      }
    }
    return selected
  })()

  const pickModel = (next: string) => {
    if (next === '') {
      void save([
        { op: 'set', path: ['provider'], value: '' },
        { op: 'set', path: ['model'], value: '' },
      ])
      return
    }
    const slash = next.indexOf('/')
    if (slash <= 0 || slash === next.length - 1) return
    void save([
      { op: 'set', path: ['provider'], value: next.slice(0, slash) },
      { op: 'set', path: ['model'], value: next.slice(slash + 1) },
    ])
  }

  // —— 提炼间隔 ——
  const committed = typeof value.throttleMinutes === 'number' ? value.throttleMinutes : 10
  const [draft, setDraft] = useState(String(committed))
  const [throttleError, setThrottleError] = useState<string | null>(null)
  const editing = useRef(false)
  const pending = useRef<number | null>(null)
  const timer = useRef<number | undefined>(undefined)

  // 宿主值变化（首次加载 / 别处改过 / 保存被拒后重读）→ 没在编辑时同步到输入框
  useEffect(() => {
    if (!editing.current) setDraft(String(committed))
  }, [committed])

  const clearTimer = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }
  useEffect(() => clearTimer, [])

  const parseThrottle = (text: string): number | null => {
    const trimmed = text.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null
    if (parsed < THROTTLE_MIN || parsed > THROTTLE_MAX) return null
    return parsed
  }

  const commitThrottle = () => {
    clearTimer()
    const next = pending.current
    pending.current = null
    if (next === null || next === committed) return
    void save([{ op: 'set', path: ['throttleMinutes'], value: next }])
  }

  const changeThrottle = (text: string) => {
    setDraft(text)
    const parsed = parseThrottle(text)
    if (parsed === null) {
      setThrottleError(`请输入 ${THROTTLE_MIN}–${THROTTLE_MAX} 之间的整数（分钟）`)
      pending.current = null
      clearTimer()
      return
    }
    setThrottleError(null)
    pending.current = parsed
    clearTimer()
    if (parsed === committed) return
    // 键盘连续输入时不要每个按键都写一次配置：停手 500ms 再落盘，失焦立即落盘。
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      commitThrottle()
    }, THROTTLE_COMMIT_DELAY_MS)
  }

  if (status !== 'ready') {
    return (
      <SettingsPage>
        <Diagnostic snapshot={snapshot} />
        <div className="memx-st-notice" data-kind={status === 'unavailable' ? 'error' : 'info'} role="status">
          {status === 'loading'
            ? '正在读取 memx 配置…（宿主已下发设置项，等待首个配置值）'
            : '当前宿主没有暴露 memx 的配置（插件未启用，或 dsh 还没重启加载新版薄壳包）。重启 dsh web 后再看这一页。'}
        </div>
      </SettingsPage>
    )
  }

  return (
    <SettingsPage>
      <Diagnostic snapshot={snapshot} />
      {notice && (
        <div className="memx-st-notice" data-kind={notice.kind} role="status">
          {notice.text}
        </div>
      )}
      {!writable && (
        <div className="memx-st-notice" data-kind="info" role="status">
          当前部署的设置文档是只读的（writable = false），这里的改动不会落盘。
        </div>
      )}

      <div className={`memx-st-card${writable ? '' : ' memx-st-disabled'}`}>
        <div className="memx-st-row">
          <label className="memx-st-label" htmlFor="memx-st-model">
            提炼模型
            <small>轮末自动提炼用；显式 memory_write 不受影响</small>
          </label>
          <div className="memx-st-field">
            <div className="memx-st-inline">
              <select
                id="memx-st-model"
                className="memx-st-select"
                aria-label="提炼模型"
                value={selected}
                disabled={!writable || catalog.state === 'loading'}
                onChange={(event) => pickModel(event.target.value)}
              >
                <option value="">跟随当前会话</option>
                {!selectedInCatalog && selected !== '' && <option value={selected}>{selected}</option>}
                {groups.map((group) => (
                  <optgroup key={group.id} label={group.name}>
                    {group.models.map((model) => (
                      <option key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>
                        {model.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                className="memx-st-input"
                style={{ width: 'auto', cursor: 'pointer' }}
                onClick={reloadCatalog}
                disabled={catalog.state === 'loading'}
                title="重新读取模型目录"
              >
                {catalog.state === 'loading' ? '读取中…' : '刷新目录'}
              </button>
            </div>
            {catalog.state === 'error' ? (
              <span className="memx-st-error">模型目录读取失败：{catalog.error}</span>
            ) : (
              <span className="memx-st-hint">
                选项按 provider 分组；空 = 跟随当前会话（用会话自己的模型）。
              </span>
            )}
          </div>
        </div>

        <div className="memx-st-row">
          <label className="memx-st-label" htmlFor="memx-st-auto">
            自动提炼
            <small>关掉后轮末不再补记</small>
          </label>
          <div className="memx-st-field">
            <div className="memx-st-inline">
              <input
                id="memx-st-auto"
                className="memx-st-check"
                type="checkbox"
                checked={value.autoRefine ?? true}
                disabled={!writable}
                onChange={(event) => void save([{ op: 'set', path: ['autoRefine'], value: event.target.checked }])}
              />
              <span className="memx-st-hint">
                {(value.autoRefine ?? true)
                  ? '开：每轮结束识别到记忆信号就自动提炼写盘'
                  : '关：只保留显式 memory_write（对话里说"记住"仍然会写）'}
              </span>
            </div>
          </div>
        </div>

        <div className="memx-st-row">
          <label className="memx-st-label" htmlFor="memx-st-throttle">
            提炼间隔
            <small>分钟；两次自动提炼之间的最小间隔</small>
          </label>
          <div className="memx-st-field">
            <div className="memx-st-inline">
              <input
                id="memx-st-throttle"
                className="memx-st-input"
                type="number"
                inputMode="numeric"
                min={THROTTLE_MIN}
                max={THROTTLE_MAX}
                step={1}
                value={draft}
                disabled={!writable}
                aria-invalid={throttleError ? 'true' : undefined}
                onFocus={() => {
                  editing.current = true
                }}
                onChange={(event) => changeThrottle(event.target.value)}
                onBlur={() => {
                  editing.current = false
                  commitThrottle()
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitThrottle()
                }}
              />
              <span className="memx-st-hint">分钟（{THROTTLE_MIN}–{THROTTLE_MAX}）</span>
            </div>
            {throttleError ? <span className="memx-st-error">{throttleError}</span> : null}
          </div>
        </div>
      </div>

      <div className="memx-st-notice" data-kind="info">
        <dl className="memx-st-dl">
          <dt>注入</dt>
          <dd>每个会话读一次（会话内字节恒定）；本会话新写的记忆，下个会话才可见。</dd>
          <dt>当前提炼模型</dt>
          <dd>{selectedLabel}</dd>
          <dt>配置归属</dt>
          <dd>
            DSH profile 补丁条目 <code>memx</code>（四个字段都按 volatile 热更，改完即时生效，无需重启）
          </dd>
        </dl>
      </div>
    </SettingsPage>
  )
}
