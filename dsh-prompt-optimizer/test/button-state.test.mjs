/**
 * 按钮状态机(纯函数)回归测试。
 *
 * 背景:结果面板移除后,按钮是**同一个位置、多种视觉态**的唯一出口:
 * idle / empty / loading / applied / error。优先级写错会直接导致
 * 「loading 中显示成 idle,点一下就重复发起」「跨会话显示 applied,
 * 点一下把别人的草稿覆盖成旧备份」这类事故,所以单独用纯函数锁住。
 *
 * 运行:`pnpm test`(需先 build,导入 lib/controller.js)。
 */
import assert from 'node:assert/strict'
import { resolveButtonState } from '../lib/controller.js'

const base = { status: 'idle', applied: null, sessionId: 's1', draft: '草稿' }

// b1 优先级:loading 压过一切(包括 applied / error)
{
  const applied = { backup: '旧', text: '新', sessionId: 's1' }
  assert.equal(resolveButtonState({ ...base, status: 'loading', applied }), 'loading')
  assert.equal(resolveButtonState({ ...base, status: 'loading', error: 'boom' }), 'loading')
  console.log('✓ b1 loading 优先级最高')
}

// b2 同会话的 applied 压过 idle / error
{
  const applied = { backup: '旧', text: '新', sessionId: 's1' }
  assert.equal(resolveButtonState({ ...base, applied }), 'applied')
  assert.equal(resolveButtonState({ ...base, applied, status: 'error' }), 'applied')
  console.log('✓ b2 同会话 applied 压过 idle / error')
}

// b3 跨会话的 applied 一律不生效(显示与点击行为都要退回本会话自己的状态)
{
  const applied = { backup: '旧', text: '新', sessionId: 's2' }
  assert.equal(resolveButtonState({ ...base, applied }), 'idle')
  assert.equal(resolveButtonState({ ...base, applied, draft: '   ' }), 'empty')
  assert.equal(resolveButtonState({ ...base, applied, status: 'error' }), 'error')
  console.log('✓ b3 跨会话 applied 不生效')
}

// b4 error 压过 idle / empty(错误要用红色 + title 显形)
{
  assert.equal(resolveButtonState({ ...base, status: 'error' }), 'error')
  assert.equal(resolveButtonState({ ...base, status: 'error', draft: '' }), 'error')
  console.log('✓ b4 error 压过 idle / empty')
}

// b5 空草稿(含纯空白)→ empty;有草稿 → idle
{
  assert.equal(resolveButtonState({ ...base, draft: '' }), 'empty')
  assert.equal(resolveButtonState({ ...base, draft: '   \n ' }), 'empty')
  assert.equal(resolveButtonState({ ...base, draft: 'x' }), 'idle')
  console.log('✓ b5 空草稿 → empty,有草稿 → idle')
}

// b6 done / cancelled 是过渡态:没有 applied 时按钮显示 idle 外观(由 effect 复位)
{
  assert.equal(resolveButtonState({ ...base, status: 'done' }), 'idle')
  assert.equal(resolveButtonState({ ...base, status: 'cancelled' }), 'idle')
  console.log('✓ b6 done / cancelled 回落 idle 外观')
}

// b7 旧宿主不提供 sessionId(两边都是 undefined)时,applied 仍应生效
{
  const applied = { backup: '旧', text: '新' }
  assert.equal(resolveButtonState({ ...base, sessionId: undefined, applied }), 'applied')
  console.log('✓ b7 双方 sessionId 缺失时 applied 仍生效')
}

console.log('\nbutton-state: all passed')
