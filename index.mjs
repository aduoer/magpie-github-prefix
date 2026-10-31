// magpie-github-prefix —— 只做一件事：
//   把你配的镜像前缀，加在 magpie 发往 GitHub 的每个地址前面（prefix + 原地址）。
//
// 为什么不需要中间人、不需要抓包：magpie 自己就有这个开关。
//   internal/source/source.go 的 Enabled() / githubBase() 在发请求时读**进程环境变量**
//   MAGPIE_MIRRORS=on、MAGPIE_GITHUB_MIRROR=<前缀>，命中 GitHub 的四个域名就按 prefix + url 取；
//   internal/update/mirror.go 对「应用更新」用同一种拼法，前缀来自 settings.json 的 updateMirror。
//   所以这个插件只做三件事：写这两个变量、写 updateMirror、需要时帮你重启一次 magpie。
//
// 为什么要重启：Windows 没有办法改一个**已经在跑的进程**的环境变量，而 magpie 是每次请求现读自己的环境。
// 这就是这个插件里唯一一点不「纯前缀」的部分，也是它全部的复杂度。

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "magpie-github-prefix";
// 插件自己的目录：重启脚本里要拿它去 `magpie plugin on`，所以别写死。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
// 页面（page/boot.js）写死了同一个端口：一处只有一个，页面才能准确找到这里。
// MGP_PORT 只是开发时换端口试跑用的，正常运行时永远 3487。
const PORT = Number(process.env.MGP_PORT) || 3487;
const ON = /^(on|true|1|cn)$/i;

// magpie 会按前缀改写这四个域名（internal/source/source.go 的 URLs()）。
const DOMAINS = ["github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com"];

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------- 路径

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "magpie");
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".config", "magpie");
}

const settingsPath = () => join(configDir(), "settings.json");
const logPath = () => join(tmpdir(), "magpie-github-prefix-restart.log");

// ---------------------------------------------------------------- 前缀

/** 用户填的东西 → 一个能直接拼在原地址前面的前缀。空字符串表示关掉。 */
function normalizePrefix(raw) {
  let v = String(raw ?? "").replace(/\s+/g, "");
  if (!v) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "https://" + v; // gh-proxy.com → https://gh-proxy.com
  if (!/^https?:\/\/[^/]+\/?$/i.test(v)) throw new Error("只认一个 http(s) 地址，例：https://gh-proxy.com/");
  if (!v.endsWith("/")) v += "/"; // 前缀是直接拼上去的，必须带尾斜杠
  return v;
}

const bare = (v) => String(v || "").trim().replace(/\/+$/, "").toLowerCase();

// ---------------------------------------------------------------- 镜像站清单

// 内置的都是「前缀 + 原地址」这一种拼法的镜像（不是 jsDelivr 那种另一套格式）。
// 清单只是候选：同一条线路不同时段差得离谱，谁真能用、有多快，看下面的测速。
const BUILTIN_MIRRORS = [
  { prefix: "https://gh-proxy.com/", note: "老牌，raw / release / clone 都过" },
  { prefix: "https://gh-proxy.org/", note: "gh-proxy 的新域名" },
  { prefix: "https://v4.gh-proxy.org/", note: "gh-proxy 的 IPv4 线路" },
  { prefix: "https://cdn.gh-proxy.org/", note: "gh-proxy 的 CDN 线路" },
  { prefix: "https://ghfast.top/", note: "2026-10 实测三种方式都可用" },
  { prefix: "https://gh.llkk.cc/", note: "可用，偶发超时重试即可" },
  { prefix: "https://ghps.cc/", note: "备用线路" },
  { prefix: "https://ghproxy.net/", note: "raw / clone 可用，大附件不稳" },
  { prefix: "https://gh-proxy.net/", note: "备用线路" },
];

// 测速打在一个真实资源上（1.4 MB 的 release 附件），不是镜像首页：
// 首页快不代表它能把 release 拖下来，而我们对镜像是要下 release 的。
const PROBE_URL = "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-windows-amd64.exe";
const PROBE_HEAD_MS = 10000; // 等到响应头：镜像要先回源，2–4 秒很正常
const PROBE_READ_MS = 3000; // 拿到头之后量 3 秒的速度
const PROBE_MAX = 512 * 1024;

// 只有自定义清单和测速结果存在这里；「当前用哪个前缀」仍然只有注册表 + settings.json 一处。
const catalogPath = () => join(configDir(), "github-prefix-mirrors.json");

function readCatalog() {
  try {
    const doc = JSON.parse(readFileSync(catalogPath(), "utf8").replace(/^\uFEFF/, ""));
    return {
      custom: Array.isArray(doc.custom) ? doc.custom.filter((v) => typeof v === "string") : [],
      last: doc.last && typeof doc.last === "object" ? doc.last : {},
    };
  } catch {
    return { custom: [], last: {} };
  }
}

function writeCatalog(doc) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(catalogPath(), JSON.stringify(doc, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(`[${ID}] 镜像清单没保存：${err?.message}`);
  }
}

const hostOf = (prefix) => String(prefix).replace(/^https?:\/\//i, "").replace(/\/+$/, "");

function mirrorList() {
  const cat = readCatalog();
  const stored = readStored();
  const cur = bare(stored.base);
  const seen = new Set();
  const out = [];
  const push = (raw, note, builtin) => {
    let prefix;
    try {
      prefix = normalizePrefix(raw);
    } catch {
      return;
    }
    const b = bare(prefix);
    if (seen.has(b)) return;
    seen.add(b);
    out.push({
      prefix,
      name: hostOf(prefix),
      note: note || "",
      builtin,
      current: Boolean(cur) && b === cur,
      last: cat.last[prefix] || null,
    });
  };
  for (const m of BUILTIN_MIRRORS) push(m.prefix, m.note, true);
  for (const p of cat.custom) push(p, "自定义", false);
  // 正在用的那个如果不在清单里（自己填的、清单里被删了），也要有一行，不然看不出来在用啥
  if (cur && !seen.has(cur) && stored.base) out.unshift({
    prefix: stored.base, name: hostOf(stored.base), note: "当前使用（不在清单里）",
    builtin: false, current: true, last: cat.last[stored.base] || null,
  });
  return out;
}

/** 真的去拖一段，量出「能不能代理」和「有多快」。 */
async function probe(prefix) {
  const t0 = Date.now();
  const ac = new AbortController();
  const headTimer = setTimeout(() => ac.abort(), PROBE_HEAD_MS);
  const bad = (why, extra) => ({
    ok: false, status: extra?.status || 0, ttfb: extra?.ttfb || 0,
    bytes: extra?.bytes || 0, kbps: 0, why,
  });

  let res;
  try {
    res = await fetch(prefix + PROBE_URL, {
      signal: ac.signal,
      headers: { range: "bytes=0-" + (PROBE_MAX - 1) },
    });
  } catch (err) {
    clearTimeout(headTimer);
    return bad(ac.signal.aborted ? "连不上（10 秒没回响应头）" : (err?.message || "连不上"));
  }
  clearTimeout(headTimer);
  const ttfb = Date.now() - t0;
  if (!res.ok) return bad("HTTP " + res.status, { status: res.status, ttfb });
  if (!res.body) return bad("没有响应体", { status: res.status, ttfb });

  const reader = res.body.getReader();
  const readStart = Date.now();
  const readTimer = setTimeout(() => {
    try { reader.cancel(); } catch {}
  }, PROBE_READ_MS);
  let bytes = 0;
  let head = null; // 头两个字节：真 exe 是 "MZ"，镜像的错误页是 "<h"
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const v = step.value || new Uint8Array(0);
      if (!head && v.length >= 2) head = String.fromCharCode(v[0], v[1]);
      bytes += v.length;
      if (bytes >= PROBE_MAX) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
  } catch {
    // 我们主动取消读，这里会抛，正常
  } finally {
    clearTimeout(readTimer);
  }

  const readMs = Math.max(1, Date.now() - readStart);
  if (bytes === 0) return bad("连上了但没数据", { status: res.status, ttfb });
  if (head && head !== "MZ") {
    return bad("返回的不是那个文件（镜像给的是个页面）", { status: res.status, ttfb, bytes });
  }
  return {
    ok: true, status: res.status, ttfb, bytes,
    kbps: Math.round(bytes / 1024 / (readMs / 1000)),
    why: "",
  };
}

// 3 个并发：这条线的总带宽就那么大，全开反而每个都测成 0。
async function speedtest(targets) {
  const queue = targets.slice();
  const results = {};
  const worker = async () => {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      results[p] = await probe(p);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  if (Object.keys(results).length) {
    const cat = readCatalog();
    const at = new Date().toISOString();
    for (const [p, r] of Object.entries(results)) cat.last[p] = { ...r, at };
    writeCatalog(cat);
  }
  return results;
}

// ---------------------------------------------------------------- 环境变量（用户级，HKCU\Environment）

function run(command, args, env) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (err) {
    return String(err?.stdout || "") || "";
  }
}

/** 读用户环境变量里存的这两个（bak 之后重启的 magpie 才会读到它们）。 */
function readStored() {
  if (!isWindows) {
    return { mirrors: String(process.env.MAGPIE_MIRRORS || ""), base: String(process.env.MAGPIE_GITHUB_MIRROR || "") };
  }
  const script =
    "$o=@{m=[Environment]::GetEnvironmentVariable('MAGPIE_MIRRORS','User');" +
    "b=[Environment]::GetEnvironmentVariable('MAGPIE_GITHUB_MIRROR','User')};" +
    "$o|ConvertTo-Json -Compress";
  const out = run("powershell", ["-NoProfile", "-Command", script]);
  try {
    const j = JSON.parse(out.trim().split(/\r?\n/).pop());
    return { mirrors: String(j.m || ""), base: String(j.b || "") };
  } catch {
    return { mirrors: "", base: "" };
  }
}

/** 写用户环境变量（[Environment]::SetEnvironmentVariable 会顺手广播 WM_SETTINGCHANGE）。 */
function writeStored(prefix) {
  if (!isWindows) return { ok: false, why: "只有 Windows 才写注册表；别的系统请自己 export 这两个变量" };
  // 值走环境变量递进去，不拼进命令字符串，免得前缀里的字符被 PowerShell 解释。
  const script = prefix
    ? "$v=$env:MGP_V;[Environment]::SetEnvironmentVariable('MAGPIE_MIRRORS','on','User');" +
      "[Environment]::SetEnvironmentVariable('MAGPIE_GITHUB_MIRROR',$v,'User')"
    : "[Environment]::SetEnvironmentVariable('MAGPIE_MIRRORS',$null,'User');" +
      "[Environment]::SetEnvironmentVariable('MAGPIE_GITHUB_MIRROR',$null,'User')";
  run("powershell", ["-NoProfile", "-Command", script], { MGP_V: prefix });
  const after = readStored();
  const ok = prefix ? bare(after.base) === bare(prefix) : !String(after.base || "").trim();
  return { ok, stored: after };
}

// ---------------------------------------------------------------- settings.json 的 updateMirror

function readUpdateMirror() {
  try {
    const text = readFileSync(settingsPath(), "utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) return "";
    const doc = JSON.parse(text);
    return String(doc?.updateMirror || "");
  } catch {
    return "";
  }
}

/** magpie 自己的 exe：PATH 上找得到就用它（找不到就退回直接改文件）。 */
function magpieExe() {
  if (magpieExe.cached !== undefined) return magpieExe.cached;
  let found = "";
  for (const name of ["magpie-windows-amd64.exe", "magpie.exe"]) {
    const hit = run("where", [name]).trim().split(/\r?\n/)[0];
    if (hit && existsSync(hit)) { found = hit; break; }
  }
  magpieExe.cached = found;
  return found;
}

/**
 * 让 magpie 自己写 updateMirror。
 *
 * 直接改 settings.json 不稳：这个键带 omitempty（`json:"updateMirror,omitempty"`），
 * magpie 用自己内存里那份设置回写文件时，会把刚写进去、它没读到过的值丢掉
 * （实测 21:50 那次就被吃掉，页面于是显示「应用更新 —」）。
 * 走 `magpie update mirror` 就不会：它改的是内存里那一份，落盘也由它自己来。
 * 这个命令没有可选的前缀参数就什么也不改，所以一定能跑。
 */
function writeUpdateMirror(prefix) {
  const exe = magpieExe();
  if (exe) {
    run(exe, ["update", "mirror", prefix || "off"]);
    const now = readUpdateMirror();
    const ok = prefix ? bare(now) === bare(prefix) : !String(now || "").trim();
    if (ok) return { ok: true, via: "cli" };
  }
  return writeUpdateMirrorFile(prefix);
}

/** 命令行不可用时的退路：只改 updateMirror 这一个键，tmp + rename 原子替换。 */
function writeUpdateMirrorFile(prefix) {
  let doc = {};
  try {
    const text = readFileSync(settingsPath(), "utf8").replace(/^\uFEFF/, "");
    if (text.trim()) doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, why: "settings.json 不是合法 JSON，先修好它：" + err.message };
  }
  if (prefix) doc.updateMirror = prefix;
  else delete doc.updateMirror;
  const target = settingsPath();
  const tmp = target + ".tmp-" + process.pid;
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

// ---------------------------------------------------------------- 状态

function state() {
  const stored = readStored();
  const live = {
    mirrors: String(process.env.MAGPIE_MIRRORS || "").trim(),
    base: String(process.env.MAGPIE_GITHUB_MIRROR || "").trim(),
  };
  // 宿主进程是 magpie 亲手拉起来的，它的 process.env 就是 magpie 的环境 ——
  // 于是「magpie 现在读到了什么」不用去猜别的进程。
  // 这里严格比（含结尾斜杠）：magpie 是拿前缀直接拼地址的，斜杠算不算数不归我们猜，
  // 反正保存的值一定带斜杠，重启一次就两边完全一致了。
  const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  const active = Boolean(stored.base) && ON.test(live.mirrors) && same(live.base, stored.base);

  return {
    prefix: stored.base,
    stored,
    live,
    active,
    updateMirror: readUpdateMirror(),
    domains: DOMAINS,
    restartLog: logPath(),
  };
}

// ---------------------------------------------------------------- 重启 magpie

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// 重启 magpie 的 PowerShell 脚本。单独抽出来是为了能 `node index.mjs --print-restart-script`
// 把它打印出来看（也方便试跑），不用真的点一次重启。
function buildRestartScript({ hostPid, prefix, log }) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$log = " + q(log),
    "function W($m){ Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $m) -Encoding UTF8 }",
    "W 'restart: 开始'",
    "Start-Sleep -Milliseconds 1200",
    // 从宿主（我们自己的 pid）往上找那个 magpie 界面进程，比按名字猜准
    "$exe = $null; $pid0 = " + hostPid,
    "$keepTray = $false",
    "for ($i = 0; $i -lt 10; $i++) {",
    "  $p = Get-CimInstance Win32_Process -Filter (\"ProcessId=\" + $pid0)",
    "  if (-not $p) { break }",
    "  if ($p.Name -match '^magpie.*\\.exe$' -and $p.Name -notmatch 'bun') {",
    "    $exe = $p.ExecutablePath; $keepTray = ($p.CommandLine -match 'tray'); break",
    "  }",
    "  $pid0 = $p.ParentProcessId",
    "}",
    "if (-not $exe) { W 'restart: 没找到 magpie 的 exe，放弃（手动退出再打开也一样）'; exit 2 }",
    "W ('restart: magpie = ' + $exe + '  pid ' + $pid0)",
    "$env:MAGPIE_MIRRORS = 'on'",
    "$env:MAGPIE_GITHUB_MIRROR = " + q(prefix),
    "& taskkill /PID $pid0 /T /F | Out-Null",
    "Start-Sleep -Milliseconds 1500",
    "if ($keepTray) { Start-Process -FilePath $exe -ArgumentList 'tray' }",
    "else { Start-Process -FilePath $exe }",
    // 重开之后把插件再激活一次：magpie 给页面的是带版本号的地址，插件被重新登记过页面才会换新地址。
    // 这行只是让刚起来的 magpie 重新登记（不重启它），失败了也不影响插件本身。
    "Start-Sleep -Seconds 4",
    "& $exe plugin on " + q(PLUGIN_DIR) + " | Out-Null",
    "W 'restart: 完成'",
    "",
  ].join("\r\n");
}

function restartMagpie(prefix) {
  if (!isWindows) return { ok: false, why: "只有 Windows 能自动重启，手动退出再打开 magpie 就行" };

  // magpie 可能用 Job Object 管着子进程（宿主就在里面），普通 spawn 出来的帮手会跟着一起被杀。
  // 用 WMI 拉起，父进程是 WmiPrvSE，不在那个作业里：magpie 关掉了，帮手还活着，能把 magpie 再开起来。
  const dir = mkdtempSync(join(tmpdir(), "maggp-"));
  const scriptPath = join(dir, "restart.ps1");
  const ps = buildRestartScript({ hostPid: process.pid, prefix, log: logPath() });

  try {
    // 带 BOM：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 猜，中文注释足以把脚本读坏
    writeFileSync(scriptPath, "\uFEFF" + ps, "utf8");
  } catch (err) {
    return { ok: false, why: "写不了重启脚本：" + err.message };
  }

  const file = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + scriptPath + '"';
  const launcher =
    "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=" + q(file) + "} | Out-Null";
  try {
    run("powershell", ["-NoProfile", "-Command", launcher]);
  } catch (err) {
    return { ok: false, why: err.message };
  }
  return { ok: true, log: logPath() };
}

// ---------------------------------------------------------------- 页面

// 注意：这里用普通模板字符串，不要用 String.raw —— magpie 加载插件时会把非 ASCII 转成
// \uXXXX 转义，String.raw 不解释转义，页面上就会直接显示成 "\u955C" 这种东西。
// 也因为它是普通模板字符串：这段 HTML/JS 里要写反斜杠必须写成两个。
const PAGE = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub 镜像前缀</title>
<style>
  :root { color-scheme: light dark; --line:#e3e3ea; --soft:#f4f4f7; --muted:#767680; --ok:#1a9d63; --warn:#c8811a; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 22px 26px;
    font: 13px/1.65 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: var(--magpie-bg, #fff); color: var(--magpie-fg, #1b1b1f);
  }
  body.dark { --line:#2c2d31; --soft:#1d1e21; --muted:#9a9aa4; background:#141518; color:#e9e9ec; }
  h1 { margin: 0 0 2px; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; }
  input {
    flex: 1; min-width: 0; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; outline: none;
  }
  input:focus { border-color: #4a86ff; }
  button {
    padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--soft); color: inherit; font: inherit; cursor: pointer; white-space: nowrap;
  }
  button:hover { filter: brightness(.97); }
  button.primary { background: #4a86ff; border-color: #4a86ff; color: #fff; }
  button.ghost { background: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  .card { margin: 16px 0 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .line { display: flex; gap: 10px; align-items: baseline; padding: 9px 12px; border-top: 1px solid var(--line); }
  .line:first-child { border-top: 0; }
  .line .k { width: 92px; flex: none; color: var(--muted); }
  .line .v { flex: 1; min-width: 0; word-break: break-all; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--muted); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .hint { padding: 9px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .hint b { color: inherit; font-weight: 600; }
  .targets { margin: 18px 0 0; font-size: 12px; color: var(--muted); }
  .targets code { font-family: ui-monospace, Consolas, monospace; color: var(--magpie-fg, inherit); }
  .targets div { padding: 2px 0; }
  .note { margin: 18px 0 0; padding-top: 14px; border-top: 1px dashed var(--line); color: var(--muted); font-size: 12px; }
  .msg { margin-top: 10px; font-size: 12px; min-height: 18px; }
  .msg.err { color: #d5453c; }
  .msg.ok { color: var(--ok); }
  h2 { display: flex; align-items: baseline; gap: 8px; margin: 22px 0 8px; font-size: 13px; font-weight: 600; }
  h2 .muted { color: var(--muted); font-weight: 400; font-size: 12px; }
  .mrow { display: flex; align-items: center; gap: 9px; padding: 7px 12px; border-top: 1px solid var(--line); }
  .mrow:first-child { border-top: 0; }
  .mname { width: 190px; flex: none; font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mval { flex: 1; min-width: 0; color: var(--muted); font-size: 12px; font-family: ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mval.ok { color: var(--ok); }
  .mval.bad { color: #d5453c; }
  .tag { font-size: 11px; color: var(--ok); border: 1px solid currentColor; border-radius: 999px; padding: 0 6px; }
  .mrow button { padding: 3px 9px; font-size: 12px; border-radius: 6px; }
  .row.mt { margin-top: 10px; }
</style>
</head><body>
<h1>GitHub 镜像前缀</h1>
<p class="sub">magpie 发往 GitHub 的地址，前面都加上这个前缀。就这一件事。</p>

<div class="row">
  <input id="p" spellcheck="false" placeholder="https://gh-proxy.com/">
  <button class="primary" id="save">保存</button>
  <button class="ghost" id="off" title="清掉前缀，直连 GitHub">关掉</button>
</div>
<div class="msg" id="msg"></div>

<div class="card" id="card">
  <div class="line"><span class="dot" id="d1"></span><span class="k">magpie</span><span class="v" id="v1">读取中…</span></div>
  <div class="line"><span class="k">应用更新</span><span class="v" id="v2">—</span></div>
  <div class="hint" id="h1"></div>
</div>

<h2>镜像站 <span class="muted" id="mstate">测速是让镜像真的去拖一段 1.4 MB 的 release 附件</span></h2>
<div class="row">
  <button id="testall">测速全部</button>
  <span class="muted" style="font-size:12px" id="tinfo"></span>
</div>
<div class="card" id="mtab" style="margin-top:10px"></div>
<div class="row mt">
  <input id="mp" spellcheck="false" placeholder="https://你的镜像站/">
  <button id="madd">添加</button>
</div>

<div class="targets" id="targets"></div>

<p class="note">
  前缀是<b>直接拼在原地址前面</b>（<code>前缀 + https://github.com/…</code>），所以它必须是一个以 <code>/</code> 结尾的地址，插件会自动补。
  上面那四个域名是 magpie 会改写的那几个。<br>
  Windows 改不了一个已经在跑的进程的环境变量，所以新的前缀要<b>重启一次 magpie</b> 才进得去；
  「应用更新」那条走 settings.json，保存就立刻生效。
</p>

<script>
const $ = (id) => document.getElementById(id);
const state = { active: false, prefix: "" };

// 主题：带过来的 ?theme=，或者系统深浅色
{
  const q = new URLSearchParams(location.search).get("theme");
  const dark = q ? q === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) document.body.classList.add("dark");
}

function render(s) {
  state.active = !!s.active;
  state.prefix = s.prefix || "";
  if (document.activeElement !== $("p")) $("p").value = state.prefix ? s.stored.base : "";

  const d1 = $("d1"), v1 = $("v1"), h1 = $("h1");
  d1.className = "dot " + (s.active ? "ok" : (s.stored.base ? "warn" : ""));
  if (!s.stored.base) {
    v1.textContent = "没有前缀，直连 GitHub";
    h1.innerHTML = "填一个镜像站地址，点保存。";
  } else if (s.active) {
    v1.textContent = "正在用 " + s.live.base;
    h1.innerHTML = "已经生效了，不用重启。";
  } else {
    v1.textContent = "这一版 magpie 还没读到 " + s.stored.base;
    h1.innerHTML = "变量写好了，但当前这个 magpie 进程还是旧环境（它读到的：" +
      (s.live.base ? s.live.base : "空") + "）。点下面这个按钮重启一次就进得去。" +
      '<br><button class="primary" id="restart" style="margin-top:8px">重启 magpie</button>';
  }

  $("v2").textContent = s.updateMirror || "（没设，更新直连 GitHub）";
  $("targets").innerHTML = s.domains.map((d) =>
    "<div><code>https://" + d + "/…</code> → <code>" + (s.stored.base || "前缀") + "https://" + d + "/…</code></div>").join("");

  const btn = $("restart");
  if (btn) btn.onclick = () => doRestart(btn);
}

function say(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

async function call(path, body) {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.why || ("HTTP " + r.status));
  return j;
}

async function refresh() {
  try { render((await call("/api/state")).state); }
  catch (e) { say("本地服务没应答（magpie 可能正在重启）：" + e.message, "err"); }
}

$("save").onclick = async () => {
  $("save").disabled = true;
  try {
    const out = await call("/api/apply", { prefix: $("p").value });
    render(out.state);
    say(out.state.active ? "保存好了，已经生效。" : "保存好了，重启 magpie 后生效。", "ok");
  } catch (e) { say(e.message, "err"); }
  finally { $("save").disabled = false; }
};

$("off").onclick = async () => {
  try {
    const out = await call("/api/apply", { prefix: "" });
    $("p").value = "";
    render(out.state);
    say("清掉了。重启 magpie 后它会直接连 GitHub。", "ok");
  } catch (e) { say(e.message, "err"); }
};

async function doRestart(btn) {
  btn.disabled = true;
  btn.textContent = "正在重启…";
  try {
    const out = await call("/api/restart", {});
    say("magpie 正在重启，几秒后回到这一页就是新的了。日志：" + out.log, "ok");
  } catch (e) {
    say("重启没起来：" + e.message + "（手动退出再打开 magpie 也一样）", "err");
    btn.disabled = false; btn.textContent = "重启 magpie";
  }
}

// ---------------------------------------------------------------- 镜像站那一块

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function speedText(r) {
  if (!r) return "没测过";
  if (!r.ok) return r.why || "连不上";
  return r.kbps + " KB/s · " + r.ttfb + " ms";
}

function renderMirrors(list) {
  const box = $("mtab");
  if (!list || !list.length) {
    box.innerHTML = '<div class="mrow"><span class="mval">清单是空的</span></div>';
    return;
  }
  box.innerHTML = list.map((m) => {
    const cls = m.last ? (m.last.ok ? "ok" : "bad") : "";
    const tag = m.current ? '<span class="tag">当前</span>' : "";
    const del = m.builtin ? "" : '<button class="ghost" data-act="del" data-p="' + esc(m.prefix) + '">删</button>';
    return '<div class="mrow">' +
      '<span class="dot ' + (m.current ? "ok" : "") + '"></span>' +
      '<span class="mname" title="' + esc(m.note) + '">' + esc(m.name) + '</span>' +
      '<span class="mval ' + cls + '">' + esc(speedText(m.last)) + '</span>' + tag +
      '<button data-act="use" data-p="' + esc(m.prefix) + '">用这个</button>' + del +
      '</div>';
  }).join("");
}

async function loadMirrors() {
  try {
    renderMirrors((await call("/api/mirrors")).mirrors);
  } catch (e) {
    $("mtab").innerHTML = '<div class="mrow"><span class="mval bad">' + esc(e.message) + '</span></div>';
  }
}

$("mtab").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const prefix = b.getAttribute("data-p");
  b.disabled = true;
  try {
    if (b.getAttribute("data-act") === "use") {
      const out = await call("/api/apply", { prefix });
      render(out.state);
      renderMirrors((await call("/api/mirrors")).mirrors);
      say(out.state.active ? "换成 " + prefix + "，已经生效。" : "换成 " + prefix + "，重启 magpie 后生效。", "ok");
    } else {
      renderMirrors((await call("/api/mirrors/remove", { prefix })).mirrors);
      say("从清单里删掉了 " + prefix, "ok");
    }
  } catch (err) {
    say(err.message, "err");
    b.disabled = false;
  }
});

$("testall").onclick = async () => {
  const btn = $("testall");
  btn.disabled = true;
  btn.textContent = "测速中…";
  $("tinfo").textContent = "每个镜像最多等 10 秒响应头，再量 3 秒速度";
  try {
    const out = await call("/api/speedtest", {});
    renderMirrors(out.mirrors);
    const live = out.mirrors.filter((m) => m.last && m.last.ok);
    const best = live.slice().sort((a, b) => b.last.kbps - a.last.kbps)[0];
    $("tinfo").textContent = "能用 " + live.length + " / " + out.mirrors.length +
      (best ? " · 最快 " + best.name + " " + best.last.kbps + " KB/s" : "") + "（结果记着，下次打开还在）";
  } catch (e) {
    $("tinfo").textContent = "测速失败：" + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "测速全部";
  }
};

$("madd").onclick = async () => {
  const btn = $("madd");
  btn.disabled = true;
  try {
    const out = await call("/api/mirrors/add", { prefix: $("mp").value });
    $("mp").value = "";
    renderMirrors(out.mirrors);
    say("加进清单了，要启用还得点它那行的「用这个」。", "ok");
  } catch (e) {
    say(e.message, "err");
  } finally {
    btn.disabled = false;
  }
};

refresh();
loadMirrors();
</script>
</body></html>`;

// ---------------------------------------------------------------- HTTP

function send(res, code, body, type) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": type || "application/json; charset=utf-8",
    "cache-control": "no-store",
    // magpie 的插件页是 sandbox="allow-scripts" 的 iframe：里面的 origin 是 null（不透明），
    // 所以页面往这个本地服务发的每个请求对它来说都是跨域，必须允许。
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 65536) raw = "";
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    // application/json 的 POST 会先来一个预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      return res.end();
    }
    if (url === "/" || url === "/index.html") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (url === "/favicon.ico") return send(res, 204, "");
    if (url === "/api/state") return send(res, 200, { ok: true, state: state() });
    if (url === "/api/mirrors") return send(res, 200, { ok: true, mirrors: mirrorList() });

    if (url === "/api/speedtest" && req.method === "POST") {
      const body = await readBody(req);
      let targets;
      if (body.prefix) {
        try {
          targets = [normalizePrefix(body.prefix)];
        } catch (err) {
          return send(res, 400, { ok: false, why: err.message });
        }
      } else {
        targets = mirrorList().map((m) => m.prefix);
      }
      const results = await speedtest(targets);
      return send(res, 200, { ok: true, results, mirrors: mirrorList() });
    }

    if (url === "/api/mirrors/add" && req.method === "POST") {
      const body = await readBody(req);
      let prefix;
      try {
        prefix = normalizePrefix(body.prefix);
      } catch (err) {
        return send(res, 400, { ok: false, why: err.message });
      }
      if (!prefix) return send(res, 400, { ok: false, why: "填一个镜像站地址，例：https://gh-proxy.com/" });
      const cat = readCatalog();
      if (!cat.custom.some((p) => bare(p) === bare(prefix))) cat.custom.push(prefix);
      writeCatalog(cat);
      return send(res, 200, { ok: true, mirrors: mirrorList() });
    }

    if (url === "/api/mirrors/remove" && req.method === "POST") {
      const body = await readBody(req);
      const cat = readCatalog();
      cat.custom = cat.custom.filter((p) => bare(p) !== bare(body.prefix));
      writeCatalog(cat);
      return send(res, 200, { ok: true, mirrors: mirrorList() });
    }

    if (url === "/api/apply" && req.method === "POST") {
      const body = await readBody(req);
      let prefix;
      try {
        prefix = normalizePrefix(body.prefix);
      } catch (err) {
        return send(res, 400, { ok: false, why: err.message });
      }
      const env = writeStored(prefix);
      if (!env.ok && isWindows) {
        return send(res, 500, { ok: false, why: "环境变量没写进去（HKCU\\Environment），可能被安全软件拦了" });
      }
      const upd = writeUpdateMirror(prefix);
      return send(res, 200, { ok: true, updateMirror: upd.ok, why: upd.why, state: state() });
    }

    if (url === "/api/restart" && req.method === "POST") {
      const prefix = String(readStored().base || "");
      if (!prefix) return send(res, 400, { ok: false, why: "先保存一个前缀再重启" });
      const out = restartMagpie(prefix);
      if (!out.ok) return send(res, 500, out);
      return send(res, 200, out);
    }

    return send(res, 404, { ok: false, why: "没有这个地址" });
  } catch (err) {
    return send(res, 500, { ok: false, why: err?.message || String(err) });
  }
});

// ---------------------------------------------------------------- 插件入口

let up = false;
let pending = false;

/** 端口被占（多半是上一个宿主还没退干净）就过两秒再来，页面那边会自己重连。 */
function listen() {
  if (up || pending) return;
  pending = true;
  const onError = (err) => {
    pending = false;
    console.error(`[${ID}] 127.0.0.1:${PORT} 起不来（${err?.code || err?.message}），2 秒后再试`);
    setTimeout(listen, 2000);
  };
  server.once("error", onError);
  server.listen(PORT, "127.0.0.1", () => {
    server.removeListener("error", onError);
    server.on("error", (err) => console.error(`[${ID}] 服务出错：${err?.message}`));
    up = true;
    pending = false;
    console.log(`[${ID}] 打开 magpie → 侧边栏「GitHub 镜像」，或直接访问 http://127.0.0.1:${PORT}/`);
  });
}

// 开发用：把重启脚本原样打印出来看一眼，不执行、不碰 magpie。
if (process.argv.includes("--print-restart-script")) {
  process.stdout.write(
    buildRestartScript({
      hostPid: Number(process.env.MGP_PID) || process.pid,
      prefix: normalizePrefix(process.env.MGP_PREFIX) || "https://gh-proxy.com/",
      log: logPath(),
    }),
  );
  process.exit(0);
}

let started = false;
function start() {
  if (started) return;
  started = true;
  listen();
}

start();

export default {
  id: ID,
  // magpie 用 OpenCode v1 的形式加载插件；这里不要供应商，只要宿主（Bun）这个进程。
  server: async () => {
    start();
    return {};
  },
};
