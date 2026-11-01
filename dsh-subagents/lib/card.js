/**
 * 任务卡：交给下一位 agent 的最小指令。
 *
 * 与 PR comment 的分工：comment 面向人与追溯（判定 + 证据），任务卡面向执行者
 * （目标 + 边界 + 验收 + 指针）。只用 comment 的问题是 executor 得从散文里推断
 * 边界，最容易发生「顺手重构」。
 */

export const MAX_ROUNDS = 3

export class CardError extends Error {
  constructor(missing) {
    super(`任务卡缺少或非法字段: ${missing.join(', ')}`)
    this.name = 'CardError'
    this.missing = missing
  }
}

const REQUIRED = ['role', 'goal', 'round', 'boundaries', 'acceptance', 'pointers']

function lines(items) {
  return items.map((item) => `- ${item}`).join('\n')
}

/**
 * @param {{ role: string, goal: string, round: number, maxRounds?: number,
 *           boundaries: string[], acceptance: string[], pointers: string[] }} input
 */
export function renderCard(input) {
  const missing = []
  for (const key of REQUIRED) {
    if (!(key in input)) missing.push(key)
  }
  if (!input.role) missing.push('role')
  if (!input.goal) missing.push('goal')
  if (!Number.isInteger(input.round) || input.round < 1) missing.push('round')
  for (const key of ['boundaries', 'acceptance', 'pointers']) {
    if (!Array.isArray(input[key]) || input[key].length === 0) missing.push(key)
  }
  const maxRounds = input.maxRounds ?? MAX_ROUNDS
  if (Number.isInteger(input.round) && input.round > maxRounds) {
    missing.push(`round>${maxRounds}`)
  }
  if (missing.length > 0) throw new CardError([...new Set(missing)])

  return [
    `角色: ${input.role}`,
    `目标: ${input.goal}`,
    `轮次: 第 ${input.round} 次 / 共 ${maxRounds} 次`,
    '',
    '边界:',
    lines(input.boundaries),
    '',
    '验收:',
    lines(input.acceptance),
    '',
    '指针:',
    lines(input.pointers),
    '',
  ].join('\n')
}

/** 反向解析，供单测与「任务卡是否自洽」检查。 */
export function parseCard(text) {
  const source = String(text ?? '')
  const role = /^角色: (.+)$/m.exec(source)?.[1]
  const goal = /^目标: (.+)$/m.exec(source)?.[1]
  const round = /^轮次: 第 (\d+) 次 \/ 共 (\d+) 次$/m.exec(source)
  const section = (title) => {
    const block = new RegExp(`^${title}:\\n((?:- .*\\n?)+)`, 'm').exec(source)?.[1] ?? ''
    return block
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2))
  }
  return {
    role,
    goal,
    round: round ? Number(round[1]) : undefined,
    maxRounds: round ? Number(round[2]) : undefined,
    boundaries: section('边界'),
    acceptance: section('验收'),
    pointers: section('指针'),
  }
}
