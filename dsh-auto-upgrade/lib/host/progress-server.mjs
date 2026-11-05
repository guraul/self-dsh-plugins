/**
 * 重启/升级期间的「进度服务」——一个只在切换窗口里活着的临时本机服务。
 *
 * 为什么需要它：点升级后 dsh web（3080）会停掉，页面没法问「到哪一步了」；重启完宿主
 * 又换了新令牌，旧页面连新宿主都问不了（401）。所以进度必须由**不随宿主死掉**的东西来报。
 *
 * 它只做两件事：
 *   `GET /`      内联的进度页（进度条 + 阶段），完成后自己 `location.replace` 到新地址；
 *   `GET /state` 当前阶段（JSON，给页面轮询）。
 *
 * 存活策略：观察到完成后再留 15 秒（让页面跳转），或最多 20 分钟——**不常驻**。
 * 只监听 127.0.0.1，只读本机状态（唯一写出的东西是 `progress-port.json`，用于告诉宿主端口）。
 *
 * 用法（由宿主在交接前拉起，detached）：
 *   node progress-server.mjs --state <stateDir> --url-file <url.txt> --base http://127.0.0.1:3080
 */
import { execFileSync } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

/** 完成后保留多久（毫秒）：够页面跳转即可。 */
const DONE_GRACE_MS = 15_000
/** 总存活上限（毫秒）：升级装包可能几分钟，给足余量。 */
const MAX_LIFETIME_MS = 20 * 60_000

/** 解析 `--key value` 形式的参数。 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i]?.startsWith('--') === true) out[argv[i].slice(2)] = argv[i + 1] ?? ''
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const stateDir = args.state ?? ''

/**
 * 找 `url.txt`：launchd 管理时它在 job 的 stdout 旁边（和 helper 的 `resolve_log_path` 同源），
 * 不是 `stateDir` 下。拿不到 launchd 路径才退回调用方给的 `--url-file`。
 * @returns {string} `url.txt` 的绝对路径。
 */
function resolveUrlFile() {
  const label = args.label ?? ''
  if (label !== '') {
    try {
      const printed = execFileSync('/bin/launchctl', ['print', `gui/${String(process.getuid())}/${label}`], { encoding: 'utf8' })
      const matched = /stdout path = (.+)/.exec(printed)
      if (matched !== null) return join(dirname(matched[1].trim()), 'url.txt')
    } catch {
      /* 没有 launchd（或不是 macOS）就走下面的兜底 */
    }
  }
  return args['url-file'] ?? ''
}

const urlFile = resolveUrlFile()
/**
 * 启动瞬间 `url.txt` 里的地址 = **旧进程的**地址（点击时它还是有效的）。
 * done 判据必须排除它，否则会立刻把用户送回一个即将死掉的页面（与 issue #293 同源）。
 */
const baseline = (await readOrSafe(urlFile)).trim()

/**
 * 读文件，失败返回空串（启动阶段用）。
 * @param {string} path 路径。
 * @returns {Promise<string>} 内容或空串。
 */
async function readOrSafe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
const startedAt = Date.now()

/**
 * 读文件，失败给空串（进度服务绝不能因为文件暂时不存在就崩）。
 * @param {string} path 路径。
 * @returns {Promise<string>} 内容或空串。
 */
async function readOr(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 候选地址是否真能认证（令牌是进程级的，旧令牌会 401）。
 * @param {string} url 候选地址。
 * @returns {Promise<boolean>} 200/302/303 视为有效。
 */
async function authenticates(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    return [200, 302, 303].includes(response.status)
  } catch {
    return false
  }
}

/** 推出当前阶段（判据全部来自本机现有产物）。 */
async function snapshot() {
  const elapsedMs = Date.now() - startedAt
  // 只认本轮写的 result.json：上一轮失败的 ok:false 会一直留在磁盘上，
  // 不按 mtime 过滤就会在重试时立刻误报失败、永远不跳转（review 轮 1 的 major 2）。
  let fresh = false
  try {
    fresh = (await stat(join(stateDir, 'result.json'))).mtimeMs > startedAt
  } catch {
    fresh = false
  }
  const result = fresh ? JSON.parse((await readOr(join(stateDir, 'result.json'))) || 'null') : null
  if (result !== null && result.ok === false) {
    return {
      phase: 'failed',
      detail: `本轮升级失败于 ${String(result.failedStep ?? '未知步骤')}，服务已按原样恢复`,
      hint: `若页面打不开：打开 ${urlFile} 里的地址，或 grep 'dsh web: http' 日志后取最后一条`,
      elapsedMs,
    }
  }
  const log = await readOr(join(stateDir, 'restart.log'))
  const tail = log.split('\n').slice(-40).join('\n')
  const candidate = (await readOr(urlFile)).trim()
  const live = candidate === '' ? false : await authenticates(candidate)
  if (live && candidate !== baseline) {
    return { phase: 'done', detail: '新进程已就绪', url: candidate, elapsedMs }
  }
  if (/kickstart ok|relaunching/.test(tail)) return { phase: 'starting', detail: '正在拉起新进程…', elapsedMs }
  if (/install finished/.test(tail) === false && /helper start/.test(tail)) {
    return { phase: 'installing', detail: '正在安装新版本…', elapsedMs }
  }
  if (/host is gone|port .* is free/.test(tail)) return { phase: 'stopping', detail: '正在停止旧进程…', elapsedMs }
  return { phase: 'waiting', detail: '正在准备…', elapsedMs }
}

/** 进度页（内联，不引外网资源）。 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>dsh web 正在重启</title>
<style>
:root{color-scheme:dark}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f1115;color:#e6e6e6;font:15px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif}
.card{width:420px;padding:28px 32px;border-radius:14px;background:#171a21;box-shadow:0 8px 40px #0006}
h1{margin:0 0 6px;font-size:17px;font-weight:600}
.muted{color:#8b93a1;font-size:13px;margin-bottom:18px}
.bar{height:6px;border-radius:3px;background:#242a35;overflow:hidden;margin-bottom:10px}
.fill{height:100%;width:8%;background:linear-gradient(90deg,#4f7cff,#7aa2ff);transition:width .5s ease}
.steps{margin:14px 0 0;padding:0;list-style:none;font-size:13px;color:#8b93a1}
.steps li{padding:2px 0}
.steps li.on{color:#e6e6e6}
.steps li.bad{color:#ff7a7a}
.sec{color:#5f6775;font-size:12px;margin-top:10px}
</style>
<div class=card>
  <h1>dsh web 正在重启</h1>
  <div class=muted id=detail>正在准备…</div>
  <div class=bar><div class=fill id=fill></div></div>
  <ul class=steps id=steps>
    <li data-p=stopping>停止旧进程</li><li data-p=installing>安装新版本</li>
    <li data-p=starting>拉起新进程</li><li data-p=done>打开界面</li>
  </ul>
  <div class=sec id=sec>0 秒</div>
</div>
<script>
const order=['waiting','stopping','installing','starting','done'];
const fill=document.getElementById('fill'),detail=document.getElementById('detail'),
      steps=[...document.querySelectorAll('#steps li')],sec=document.getElementById('sec');
const t0=Date.now();
async function tick(){
  let s;
  try{ s=await (await fetch('/state',{cache:'no-store'})).json() }catch{ return }
  detail.textContent=s.detail||''; sec.textContent=Math.round((Date.now()-t0)/1000)+' 秒';
  const at=order.indexOf(s.phase);
  fill.style.width=Math.max(8,((at+1)/order.length)*100)+'%';
  steps.forEach(li=>{
    const i=order.indexOf(li.dataset.p);
    li.className = s.phase==='failed'&&li.dataset.p==='stopping' ? 'bad' : (i<=at?'on':'');
  });
  if(s.phase==='done'&&s.url){ location.replace(s.url); return }
  if(s.phase==='failed'){ detail.textContent=s.detail; return }
  setTimeout(tick,700);
}
tick();
</script>`

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  // 页面与 /state 同源，不需要 CORS；不加 `*`，免得任意网页都能探到带令牌的地址。
  const cors = { 'cache-control': 'no-store' }
  if (path === '/state') {
    snapshot().then((state) => {
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(state))
      if (state.phase === 'done') {
        // 完成后留一小段让页面跳转，然后自己退出（不常驻）。
        setTimeout(() => server.close(() => process.exit(0)), DONE_GRACE_MS).unref()
      }
    }).catch(() => {
      // 状态文件读到一半 / 坏了也要答话，否则唯一的进度信息源会猝死（review 轮 1）。
      res.writeHead(500, { ...cors, 'content-type': 'application/json; charset=utf-8' })
      res.end('{"phase":"unknown","detail":"状态暂不可读"}')
    })
    return
  }
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  res.writeHead(404, cors)
  res.end('not found')
})

server.listen(Number(args.port ?? 0), '127.0.0.1', () => {
  const { port } = server.address()
  // 把实际端口写出来，宿主据此拼进度页地址（端口 0 时由系统分配）。
  void writeFile(join(stateDir, 'progress-port.json'), `${JSON.stringify({ port, pid: process.pid }, null, 2)}\n`).catch(() => {})
  setTimeout(() => server.close(() => process.exit(0)), MAX_LIFETIME_MS).unref()
})
