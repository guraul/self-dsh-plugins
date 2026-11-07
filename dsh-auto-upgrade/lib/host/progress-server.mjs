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
/** 3080 的地址（宿主在跑的那个端口）。 */
const base = args.base ?? 'http://127.0.0.1:3080'

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
if (urlFile === '') {
  // #365 之后不再有 stateDir 兜底：拿不到路径就是拿不到，别静默等到超时。
  console.warn('[progress] 找不到 url.txt：进度页无法判断新地址，完成时不会自动跳转')
}
/**
 * 启动瞬间 `url.txt` 里的地址 = **旧进程的**地址（点击时它还是有效的）。
 * done 判据必须排除它，否则会立刻把用户送回一个即将死掉的页面（与 issue #293 同源）。
 */
const baseline = (await readOr(urlFile)).trim()


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

/**
 * 3080 现在有没有人在应答——「重启中」最可靠的信号，不依赖 helper 写没写日志。
 * @returns {Promise<boolean>} 有人在应答返回 true。
 */
async function baseAlive() {
  try {
    const response = await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(1200) })
    return response.status > 0
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
  // 前提：dsh 的令牌每次启动必换（`lib/host/token-url.js`），所以「新地址恰好等于 baseline」
  // 不会发生；真发生了宁可等超时，也不把用户送回即将死掉的页面。
  if (live && candidate !== baseline) {
    return { phase: 'done', detail: '新进程已就绪', url: candidate, elapsedMs }
  }
  const alive = await baseAlive()
  if (!alive) {
    // 3080 没人应答：在装包 → installing；已经 kickstart 过但还没起来 → starting；
    // 其余（刚开始等旧进程退出）→ stopping。三条都可达，`starting` 不再是死代码。
    if (/helper start/.test(tail) && !/install finished/.test(tail)) {
      return { phase: 'installing', detail: '正在安装新版本…', elapsedMs }
    }
    if (/kickstart ok|relaunching/.test(tail)) return { phase: 'starting', detail: '正在拉起新进程…', elapsedMs }
    return { phase: 'stopping', detail: '旧进程已停止，正在等待新进程…', elapsedMs }
  }
  // 端口活着但**旧令牌还能认证**：这是宿主还没退干净的窗口，别报「校验新地址」（会倒退一步）。
  if (live) return { phase: 'stopping', detail: '旧进程正在退出…', elapsedMs }
  return { phase: 'verifying', detail: '新进程已启动，正在校验新地址…', elapsedMs }
}

/** 进度页（内联，不引外网资源）。 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>dsh web 正在重启 · RHINE LAB</title>
<style>
/* 配色取自 Rhine-Lab-Codex-Theme 的 Pioneer 终端面板（skin.css 变量 + skin.json accent）：
   奶油白 #F6F1E5 / 石墨黑 #252B2A / 莱茵橙 #DC7946 / 深赭 #8B3C1C / 分隔线 #D5CDBD / 侧栏 #E8E2D3 */
:root{color-scheme:light;--cream:#F6F1E5;--ink:#252B2A;--line:#D5CDBD;--side:#E8E2D3;
--orange:#DC7946;--rust:#8B3C1C;--muted:#8C8878;--dim:#AAA99E}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:var(--cream);
color:var(--ink);font:15px/1.6 Arial,"PingFang SC","Microsoft YaHei",sans-serif}
.card{width:460px;padding:26px 30px 22px;background:var(--cream);border:1px solid var(--line);border-radius:2px;
box-shadow:0 10px 40px #252B2A14}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:14px}
h1{margin:0;font-size:17px;font-weight:800;letter-spacing:.02em}
.tag{font-size:10px;letter-spacing:1px;color:var(--rust);font-weight:600}
.muted{color:var(--muted);font-size:13px;margin-bottom:14px;min-height:20px}
.bar{height:8px;background:var(--side);border:1px solid var(--line);border-radius:2px;overflow:hidden}
.fill{height:100%;width:6%;background:linear-gradient(90deg,var(--rust),var(--orange));transition:width .45s ease}
.steps{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin:16px 0 0;padding:0;list-style:none;
font-size:12.5px;color:var(--dim)}
.steps li{padding:3px 0 3px 16px;position:relative;letter-spacing:.5px}
.steps li::before{content:"";position:absolute;left:0;top:9px;width:7px;height:7px;border:1px solid var(--line);
border-radius:1px;background:transparent}
.steps li.on{color:var(--ink)}
.steps li.on::before{background:var(--orange);border-color:var(--rust)}
.steps li.bad{color:var(--rust)}
.steps li.bad::before{background:var(--rust);border-color:var(--rust)}
.foot{display:flex;justify-content:space-between;margin-top:14px;padding-top:9px;border-top:1px solid var(--line);
font-size:11px;letter-spacing:.5px;color:var(--muted)}
</style>
<div class=card>
  <div class=head><h1>dsh web 正在重启</h1><span class=tag>RHINE LAB</span></div>
  <div class=muted id=detail>正在准备…</div>
  <div class=bar><div class=fill id=fill></div></div>
  <ul class=steps id=steps><li data-p=waiting>准备</li><li data-p=stopping>停止旧进程</li>
  <li data-p=installing>安装新版本</li><li data-p=starting>拉起新进程</li>
  <li data-p=verifying>校验新地址</li><li data-p=done>打开界面</li></ul>
  <div class=foot><span id=sec>0 秒</span><span>PIONEER TERMINAL</span></div>
</div>
<script>
const order=['waiting','stopping','installing','starting','verifying','done'];
const fill=document.getElementById('fill'),detail=document.getElementById('detail'),
  steps=[...document.querySelectorAll('#steps li')],sec=document.getElementById('sec'),t0=Date.now();
let shown=6;
async function tick(){
  let s; try{ s=await (await fetch('/state',{cache:'no-store'})).json() }catch{ return }
  detail.textContent=s.detail||''; sec.textContent=Math.round((Date.now()-t0)/1000)+' 秒';
  const at=order.indexOf(s.phase);
  const target=Math.max(8,((Math.max(at,0)+1)/order.length)*100);
  // 每帧朝目标挪一点：即使重启只有两三秒，进度条也一直在动，不会「只滑一次」。
  shown = target > shown ? Math.min(target, shown + 7) : target;
  fill.style.width=shown+'%';
  steps.forEach(li=>{const i=order.indexOf(li.dataset.p);
    li.className=s.phase==='failed'&&li.dataset.p==='stopping'?'bad':(i<=at?'on':'')});
  if(s.phase==='done'&&s.url){ fill.style.width='100%'; setTimeout(()=>location.replace(s.url),600); return }
  if(s.phase==='failed'){ detail.textContent=s.detail; return }
  setTimeout(tick,400);
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
    }).catch((error) => {
      console.warn(`[progress] 状态暂不可读：${error instanceof Error ? error.message : String(error)}`)
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
