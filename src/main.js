const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile, spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ROLES_DIR = path.join(ROOT, "roles");
const RUNS_DIR = path.join(ROOT, "runs");
const RPA_SCRIPT = path.join(ROOT, "tools", "rpa-control.ps1");
const VERIFY_LIVE_RPA_SCRIPT = path.join(ROOT, "tools", "verify-live-rpa.ps1");
const VISION_AGENT_SCRIPT = path.join(ROOT, "tools", "vision_agent.py");
const ACTION_SCHEMA = path.join(ROOT, "schemas", "action.schema.json");
const APP_ICON = path.join(ROOT, "assets", "icon.ico");
const LIVE_STUDIO_EXE = "C:\\Program Files\\TikTok LIVE Studio\\1.29.0\\TikTok LIVE Studio.exe";
const LIVE_STUDIO_LAUNCHER_EXE = "C:\\Program Files\\TikTok LIVE Studio\\TikTok LIVE Studio Launcher.exe";
const LIVE_STUDIO_CDP = "http://127.0.0.1:9222";

let mainWindow;
let activeRun = null;

function quotePowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function isRunningAsAdmin() {
  if (process.platform !== "win32") return true;
  const script = "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
  const result = await execFileText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 10000 });
  return result.ok && /true/i.test(result.stdout);
}

async function relaunchAsAdmin() {
  if (process.platform !== "win32") return false;
  const relaunchArgs = process.argv.slice(1);
  const argumentList = relaunchArgs.map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`).join(" ");
  const command = argumentList
    ? `Start-Process -FilePath ${quotePowerShellString(process.execPath)} -ArgumentList ${quotePowerShellString(argumentList)} -Verb RunAs`
    : `Start-Process -FilePath ${quotePowerShellString(process.execPath)} -Verb RunAs`;
  const result = await execFileText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { timeout: 30000 });
  return result.ok;
}

function execFileText(file, args = [], options = {}) {
  return new Promise((resolve) => {
    let actualFile = file;
    let actualArgs = args;
    if (/\.(cmd|bat)$/i.test(file)) {
      actualFile = "cmd.exe";
      actualArgs = ["/d", "/s", "/c", "call", file, ...args.map((arg) => String(arg))];
    }
    const child = execFile(
      actualFile,
      actualArgs,
      { windowsHide: true, timeout: options.timeout ?? 30000, cwd: options.cwd ?? ROOT },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          error: error?.message ?? null
        });
      }
    );
    if (options.input != null) child.stdin?.end(options.input, "utf8");
  });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function imageDataUrl(filePath) {
  if (!filePath || !(await pathExists(filePath))) return null;
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function firstLine(text) {
  return (text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
}

async function findOnPath(command) {
  const result = await execFileText("where.exe", [command], { timeout: 10000 });
  if (!result.ok) return null;
  const candidates = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return candidates.find((item) => item.toLowerCase().endsWith(".cmd")) || candidates[0] || null;
}

async function getProcessRunning(imageName) {
  const result = await execFileText("tasklist.exe", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], { timeout: 10000 });
  return result.ok && result.stdout.toLowerCase().includes(imageName.toLowerCase());
}

async function startLiveStudioViaShell() {
  try {
    const target = (await pathExists(LIVE_STUDIO_LAUNCHER_EXE)) ? LIVE_STUDIO_LAUNCHER_EXE : LIVE_STUDIO_EXE;
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true, stdout: "", stderr: "" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function startLiveStudioWithDebugPort(run) {
  if (!(await pathExists(LIVE_STUDIO_LAUNCHER_EXE))) {
    await appendLog(run, "issue", "未找到 Live Studio Launcher，无法用调试端口启动");
    return false;
  }
  const escaped = LIVE_STUDIO_LAUNCHER_EXE.replace(/'/g, "''");
  const command = `Start-Process -FilePath '${escaped}' -ArgumentList '--remote-debugging-port=9222'`;
  const result = await execFileText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { timeout: 20000 });
  if (!result.ok) {
    await appendLog(run, "issue", `带调试端口启动 Live Studio 失败：${result.stderr || result.error || result.stdout || "未知错误"}`);
    return false;
  }
  return true;
}

async function fetchJson(url, timeout = 5000) {
  const result = await execFileText(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -UseBasicParsing -Uri '${url}' -TimeoutSec ${Math.ceil(timeout / 1000)}).Content`
    ],
    { timeout: timeout + 3000 }
  );
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function ensureLiveStudioCdp(run) {
  let version = await fetchJson(`${LIVE_STUDIO_CDP}/json/version`, 3000);
  if (version?.webSocketDebuggerUrl) {
    await appendLog(run, "done", "Live Studio CDP 调试端口已可用：9222");
    return true;
  }

  await appendLog(run, "action", "正在尝试用 --remote-debugging-port=9222 启动 Live Studio");
  await startLiveStudioWithDebugPort(run);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    version = await fetchJson(`${LIVE_STUDIO_CDP}/json/version`, 3000);
    if (version?.webSocketDebuggerUrl) {
      await appendLog(run, "done", "Live Studio CDP 调试端口已打开：9222");
      return true;
    }
  }

  await appendLog(run, "issue", "现有 Live Studio 可能未携带调试参数，正在重启并强制打开 CDP 9222");
  await execFileText(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-Process 'TikTok LIVE Studio' -ErrorAction SilentlyContinue | Stop-Process -Force"
    ],
    { timeout: 15000 }
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await startLiveStudioWithDebugPort(run);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    version = await fetchJson(`${LIVE_STUDIO_CDP}/json/version`, 3000);
    if (version?.webSocketDebuggerUrl) {
      await appendLog(run, "done", "Live Studio 已重启并打开 CDP 调试端口：9222");
      return true;
    }
  }
  await appendLog(run, "issue", "未能打开 Live Studio CDP 调试端口，将回退到截图/RPA 方案");
  return false;
}

async function ensureLiveStudioRunning(run) {
  if (await getProcessRunning("TikTok LIVE Studio.exe")) {
    await appendLog(run, "done", "Live Studio 已在运行");
    return true;
  }
  if (!(await pathExists(LIVE_STUDIO_LAUNCHER_EXE)) && !(await pathExists(LIVE_STUDIO_EXE))) {
    await appendLog(run, "issue", "未找到 Live Studio 默认安装路径，无法自动启动");
    return false;
  }

  await appendLog(run, "action", "Live Studio 未运行，正在自动启动");
  const launch = await startLiveStudioViaShell();
  if (!launch.ok) {
    await appendLog(run, "issue", `启动 Live Studio 被系统拒绝：${launch.stderr || launch.error || launch.stdout || "未知错误"}`);
    return false;
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await getProcessRunning("TikTok LIVE Studio.exe")) {
      await appendLog(run, "done", "Live Studio 已自动启动");
      return true;
    }
  }
  await appendLog(run, "issue", "已尝试自动启动 Live Studio，但未检测到运行进程");
  return false;
}

async function activateLiveStudio(run) {
  if (!(await pathExists(LIVE_STUDIO_EXE))) return false;
  await appendLog(run, "action", "正在尝试将 Live Studio 拉到前台");
  const launch = await startLiveStudioViaShell();
  if (!launch.ok) {
    await appendLog(run, "issue", `拉起 Live Studio 失败：${launch.stderr || launch.error || launch.stdout || "未知错误"}`);
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return true;
}

async function getScreenInfo() {
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$s=[System.Windows.Forms.Screen]::PrimaryScreen;",
    "$b=$s.Bounds;",
    "[pscustomobject]@{width=$b.Width;height=$b.Height;device=$s.DeviceName} | ConvertTo-Json -Compress"
  ].join(" ");
  const result = await execFileText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { timeout: 10000 });
  if (!result.ok) return { ok: false, detail: "读取屏幕信息失败" };
  try {
    const parsed = JSON.parse(result.stdout);
    return { ok: true, detail: `${parsed.device || "主显示器"} ${parsed.width}×${parsed.height}`, data: parsed };
  } catch {
    return { ok: false, detail: "屏幕信息解析失败" };
  }
}

async function detectEnvironment() {
  const codexPath = await findOnPath("codex");
  const codexVersion = codexPath
    ? await execFileText(codexPath, ["--version"], { timeout: 10000 })
    : { ok: false, stdout: "", stderr: "" };
  const liveInstalled = (await pathExists(LIVE_STUDIO_LAUNCHER_EXE)) || (await pathExists(LIVE_STUDIO_EXE));
  const liveRunning = await getProcessRunning("TikTok LIVE Studio.exe");
  const cdpVersion = await fetchJson(`${LIVE_STUDIO_CDP}/json/version`, 1500);
  const screenInfo = await getScreenInfo();
  const rpaAvailable = await pathExists(RPA_SCRIPT);

  return {
    liveStudio: {
      status: liveInstalled ? (liveRunning ? "ok" : "warn") : "error",
      label: liveInstalled ? (liveRunning ? "可用" : "未打开") : "未安装",
      detail: liveInstalled ? (liveRunning ? "进程运行中" : "已安装，进程未运行，可自动启动") : "未发现默认安装路径"
    },
    liveLogin: {
      status: liveRunning ? "ok" : "warn",
      label: liveRunning ? "需确认" : "未知",
      detail: liveRunning ? "已打开，登录态需结合读屏确认" : "Live Studio 未运行"
    },
    codex: {
      status: codexPath && codexVersion.ok ? "ok" : "error",
      label: codexPath && codexVersion.ok ? "可调用" : "异常",
      detail: codexPath ? firstLine(codexVersion.stdout) || "Codex CLI 已找到" : "未找到 codex CLI",
      path: codexPath
    },
    desktop: {
      status: rpaAvailable ? "ok" : "error",
      label: rpaAvailable ? "可用" : "不可用",
      detail: rpaAvailable
        ? `截图 · 鼠标 · 键盘脚本已就绪${cdpVersion?.webSocketDebuggerUrl ? "；CDP 9222 已连接" : "；CDP 9222 未连接"}`
        : "RPA 脚本缺失"
    },
    screen: {
      status: screenInfo.ok ? "info" : "error",
      label: screenInfo.ok ? "已记录" : "异常",
      detail: screenInfo.detail
    }
  };
}

async function listRoles() {
  await fs.mkdir(ROLES_DIR, { recursive: true });
  const files = await fs.readdir(ROLES_DIR);
  const preferred = ["萌新游戏主播", "萌新秀场主播", "专业测试专家", "资深主播"];
  return files
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => ({ name: path.basename(name, ".md"), file: path.join(ROLES_DIR, name) }))
    .sort((a, b) => {
      const ia = preferred.indexOf(a.name);
      const ib = preferred.indexOf(b.name);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.name.localeCompare(b.name, "zh-CN");
    });
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

async function appendLog(run, type, message) {
  const row = { time: new Date().toISOString(), type, message };
  run.logs.push(row);
  await fs.appendFile(run.logFile, `[${row.time}] ${type.toUpperCase()} ${message}\n`, "utf8");
  send("task:log", row);
}

async function rpa(run, mode, action = null) {
  const outDir = path.join(run.dir, "screenshots");
  await fs.mkdir(outDir, { recursive: true });
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    RPA_SCRIPT,
    "-Mode",
    mode,
    "-OutDir",
    outDir,
    "-WindowTitle",
    run.focusTitle || "",
    "-TargetProcess",
    run.focusProcess || ""
  ];
  if (action) args.push("-ActionJson", JSON.stringify(action));
  const result = await execFileText("powershell.exe", args, { timeout: 60000 });
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed;
  } catch {
    return { ok: false, error: result.stderr || result.stdout || result.error || "RPA 输出解析失败" };
  }
}

async function clickPinkCta(run) {
  const outDir = path.join(run.dir, "pink-clicks");
  await fs.mkdir(outDir, { recursive: true });
  const focusShot = await rpa(run, "capture");
  if (!focusShot.focused && run.focusTitle === "TikTok LIVE Studio") {
    await activateLiveStudio(run);
  }
  const result = await execFileText(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      VERIFY_LIVE_RPA_SCRIPT,
      "-Click",
      "-OutDir",
      outDir
    ],
    { timeout: 60000 }
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: result.stderr || result.stdout || result.error || "粉色按钮校正输出解析失败" };
  }
}

async function screenshotLooksLikeLiveStudio(screenshotPath) {
  if (!screenshotPath || !(await pathExists(screenshotPath))) return false;
  const script = [
    "Add-Type -AssemblyName System.Drawing;",
    `$img=[System.Drawing.Bitmap]::new('${screenshotPath.replace(/'/g, "''")}');`,
    "$dark=0;$pink=0;$total=0;",
    "for($y=0;$y -lt $img.Height;$y+=12){",
    "  for($x=0;$x -lt $img.Width;$x+=12){",
    "    $c=$img.GetPixel($x,$y);",
    "    if($c.R -lt 45 -and $c.G -lt 45 -and $c.B -lt 55){$dark++}",
    "    if($c.R -gt 210 -and $c.G -lt 90 -and $c.B -gt 90 -and $c.B -lt 210){$pink++}",
    "    $total++",
    "  }",
    "}",
    "$img.Dispose();",
    "[pscustomobject]@{dark=$dark;pink=$pink;total=$total;looks=($dark -gt 800 -and $pink -gt 5)} | ConvertTo-Json -Compress"
  ].join(" ");
  const result = await execFileText("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 15000 });
  if (!result.ok) return false;
  try {
    return Boolean(JSON.parse(result.stdout).looks);
  } catch {
    return false;
  }
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cdpClickTextFromAction(action) {
  const text = `${action.target || ""} ${action.reason || ""}`;
  if (/go\s*live/i.test(text)) return "Go LIVE";
  if (/add source|添加源/i.test(text)) return "Add source";
  if (/game capture|游戏捕获|游戏源/i.test(text)) return "Game Capture";
  if (/add\b|添加|确认添加/i.test(text)) return "Add";
  if (/live center/i.test(text)) return "LIVE Center";
  if (/live info/i.test(text)) return "LIVE info";
  if (/continue|继续|下一步/i.test(text)) return "Continue";
  if (/confirm|确认|确定/i.test(text)) return "Confirm";
  if (/start\s*live|开始直播|开始开播/i.test(text)) return "Start LIVE";
  if (/done|完成/i.test(text)) return "Done";
  const target = String(action.target || "").trim();
  if (target && !/任务栏|taskbar|button|按钮/i.test(target) && target.length <= 40) return target;
  return null;
}

async function withLiveStudioMainPage(callback) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    return { ok: false, error: "playwright-core 未安装" };
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP(LIVE_STUDIO_CDP);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((item) => item.url().includes("/html/main/index.html")) || pages.find((item) => /TikTok LIVE Studio/i.test(item.url()));
    if (!page) return { ok: false, error: "未找到 Live Studio 主页面 WebContents" };
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
    return await callback(page);
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function rankLiveStudioPage(page) {
  const url = page.url();
  if (url.includes("/html/modal/")) return 0;
  if (url.includes("/html/popup/")) return 1;
  if (url.includes("/html/popupEntry/")) return 2;
  if (url.includes("/html/popupMulti/")) return 3;
  if (url.includes("/html/main/")) return 4;
  return 9;
}

async function withLiveStudioPages(callback) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    return { ok: false, error: "playwright-core 未安装" };
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP(LIVE_STUDIO_CDP);
    const pages = browser.contexts()
      .flatMap((context) => context.pages())
      .filter((page) => {
        const url = page.url();
        return url.includes("/html/") && (
          url.includes("TikTok%20LIVE%20Studio") ||
          url.includes("TikTok LIVE Studio") ||
          url.includes("resources/app")
        );
      })
      .sort((a, b) => rankLiveStudioPage(a) - rankLiveStudioPage(b));
    if (pages.length === 0) return { ok: false, error: "未找到 Live Studio WebContents" };
    for (const page of pages) {
      await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
    }
    return await callback(pages);
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function getCdpSnapshot() {
  const version = await fetchJson(`${LIVE_STUDIO_CDP}/json/version`, 1500);
  if (!version?.webSocketDebuggerUrl) return null;
  const result = await withLiveStudioPages(async (pages) => {
    const pageSnapshots = [];
    for (const page of pages) {
      const snapshot = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const controls = [...document.querySelectorAll("button,[role=button],input,textarea,[aria-label],[data-testid]")]
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            text: (el.innerText || el.value || "").trim().slice(0, 80),
            aria: el.getAttribute("aria-label"),
            testid: el.getAttribute("data-testid"),
            id: el.id || null,
            cls: String(el.className || "").slice(0, 100),
            visible: Boolean(rect.width && rect.height),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          };
        })
        .filter((item) => item.visible)
        .slice(0, 80);
      const dialogs = [...document.querySelectorAll("[role=dialog],[aria-modal=true],[class*=modal],[class*=Modal],[class*=dialog],[class*=Dialog],div,section")]
        .filter((el) => visible(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || "").trim();
          const style = getComputedStyle(el);
          const scrollable = el.scrollHeight > el.clientHeight + 8;
          const dialogLike = /LIVE settings|LIVE info|Cancel|Go LIVE|Confirm|Continue|About me|Video settings|Moderators/i.test(text)
            && rect.width > 240
            && rect.height > 180
            && rect.width < window.innerWidth * 0.95
            && rect.height < window.innerHeight * 0.95;
          return {
            text: text.slice(0, 1000),
            cls: String(el.className || "").slice(0, 120),
            role: el.getAttribute("role"),
            zIndex: style.zIndex,
            scrollable,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            dialogLike
          };
        })
        .filter((item) => item.dialogLike)
        .sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h))
        .slice(0, 10);
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body.innerText.slice(0, 2000),
        controls,
        dialogs
      };
      });
      pageSnapshots.push(snapshot);
    }
    return {
      ok: true,
      snapshot: {
        pages: pageSnapshots,
        url: pageSnapshots[0]?.url || "",
        bodyText: pageSnapshots.map((item, index) => `Page ${index + 1}: ${item.url}\n${item.bodyText}`).join("\n\n").slice(0, 5000),
        controls: pageSnapshots.flatMap((item, pageIndex) => item.controls.map((control) => ({ pageIndex, pageUrl: item.url, ...control }))).slice(0, 160)
      }
    };
  });
  return result.ok ? result.snapshot : null;
}

async function executeCdpAction(run, action) {
  if (!["click", "scroll"].includes(action.action)) return { ok: false, skipped: true, error: "非点击/滚动动作不走 CDP" };
  const text = cdpClickTextFromAction(action);
  if (action.action === "click" && !text) return { ok: false, skipped: true, error: "无可用 DOM 文本目标" };
  await appendLog(run, "action", action.action === "scroll" ? "CDP 尝试滚动当前弹窗/页面" : `CDP 尝试点击文本：${text}`);
  return withLiveStudioPages(async (pages) => {
    let lastError = null;
    for (const page of pages) {
      try {
        const result = await page.evaluate(({ text, action, delta }) => {
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          const textMatches = (el, value) => {
            const own = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
            return own === value || new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(own);
          };
          const all = [...document.querySelectorAll("*")].filter(visible);
          const dialogCandidates = all
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const content = (el.innerText || "").trim();
              const style = getComputedStyle(el);
              const dialogLike = (el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || /modal|dialog|popover/i.test(String(el.className || "")) || /LIVE settings|LIVE info|Cancel|About me|Video settings|Moderators/i.test(content))
                && rect.width > 240
                && rect.height > 180
                && rect.width < window.innerWidth * 0.96
                && rect.height < window.innerHeight * 0.96;
              return { el, rect, area: rect.width * rect.height, z: Number(style.zIndex) || 0, dialogLike };
            })
            .filter((item) => item.dialogLike)
            .sort((a, b) => (b.z - a.z) || (a.area - b.area));
          const scope = dialogCandidates[0]?.el || document.body;

          if (action === "scroll") {
            const scrollables = [scope, ...scope.querySelectorAll("*")]
              .filter((el) => visible(el) && el.scrollHeight > el.clientHeight + 8)
              .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
            const target = scrollables[0] || document.scrollingElement || document.documentElement;
            const before = target.scrollTop;
            target.scrollTop += delta || 600;
            return { ok: true, kind: "scroll", before, after: target.scrollTop, scopeText: (scope.innerText || "").slice(0, 120) };
          }

          const clickables = [...scope.querySelectorAll("button,[role=button],[role=option],[role=menuitem],input[type=button],input[type=submit],a,[tabindex],[data-testid],[class*=item],[class*=Item],[class*=card],[class*=Card]")]
            .filter(visible)
            .map((el) => ({ el, rect: el.getBoundingClientRect(), text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim() }))
            .filter((item) => item.text && textMatches(item.el, text))
            .sort((a, b) => {
              const aExact = a.text.toLowerCase() === String(text).toLowerCase() ? 1 : 0;
              const bExact = b.text.toLowerCase() === String(text).toLowerCase() ? 1 : 0;
              return (bExact - aExact) || ((a.rect.width * a.rect.height) - (b.rect.width * b.rect.height)) || (b.rect.y - a.rect.y);
            });
          const target = clickables[0];
          if (!target) {
            return { ok: false, error: `scope 内未找到可点击文本：${text}`, scopeText: (scope.innerText || "").slice(0, 500) };
          }
          const point = center(target.rect);
          target.el.click();
          return {
            ok: true,
            kind: "click",
            text: target.text,
            clickedRect: { x: Math.round(target.rect.x), y: Math.round(target.rect.y), w: Math.round(target.rect.width), h: Math.round(target.rect.height) },
            point: { x: Math.round(point.x), y: Math.round(point.y) },
            scopeText: (scope.innerText || "").slice(0, 180)
          };
        }, { text, action: action.action, delta: action.y || 700 });
        if (!result.ok) throw new Error(result.error || "CDP evaluate action failed");
        await page.waitForTimeout(1000);
        return { ok: true, result: result.kind === "scroll" ? "cdp_scrolled" : `cdp_clicked:${text}`, pageUrl: page.url(), detail: result };
      } catch (error) {
        lastError = error;
      }
    }
    return { ok: false, error: lastError?.message || `未找到可点击文本：${text}` };
  });
}

async function restoreAndCaptureLiveStudio(run) {
  let observation = await rpa(run, "capture");
  let visuallyReady = await screenshotLooksLikeLiveStudio(observation.screenshot);
  if (observation.ok && observation.focused && visuallyReady) {
    return observation;
  }

  await appendLog(run, "observe", `Live Studio 未在截图中可见，正在恢复窗口（前台校验=${observation.focused ? "通过" : "未通过"}，视觉校验=${visuallyReady ? "通过" : "未通过"}）`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await activateLiveStudio(run);
    observation = await rpa(run, "capture");
    visuallyReady = await screenshotLooksLikeLiveStudio(observation.screenshot);
    await appendLog(run, "observe", `恢复尝试 ${attempt}/3：前台校验=${observation.focused ? "通过" : "未通过"}，视觉校验=${visuallyReady ? "通过" : "未通过"}`);
    if (observation.ok && observation.focused && visuallyReady) {
      return observation;
    }
  }
  observation.focused = false;
  observation.visualLiveStudio = visuallyReady;
  return observation;
}

function compactHistory(run) {
  return run.logs
    .slice(-10)
    .map((row) => `${row.type}: ${row.message}`)
    .join("\n");
}

function isGameLiveTask(config) {
  return /游戏|game|steam|roblox|游戏主播|游戏源|game capture/i.test(`${config.task || ""} ${config.role || ""}`);
}

function inferGameSourceState(snapshot) {
  const text = `${snapshot?.bodyText || ""} ${JSON.stringify(snapshot?.controls || [])}`.toLowerCase();
  const inSourcePicker = /select source|choose source|source type|game capture[\s\S]{0,400}window capture|window capture[\s\S]{0,400}display capture|browser source|image source|选择[\s\S]{0,80}源|游戏捕获[\s\S]{0,400}窗口捕获|窗口捕获[\s\S]{0,400}显示器捕获/.test(text);
  const hasAddSource = /add source|添加源/.test(text);
  const hasGameCaptureOption = /game capture|游戏捕获/.test(text);
  const hasGameSourceOnCanvas = /game capture|游戏源|roblox|steam|monster hunter|window capture|display capture/.test(text)
    && !/live settings|live info/.test(text)
    && !inSourcePicker;
  return {
    required: false,
    inSourcePicker,
    hasAddSource,
    hasGameCaptureOption,
    hasGameSourceOnCanvas,
    summary: hasGameSourceOnCanvas
      ? "已在主界面/画布相关 DOM 中看到疑似游戏源或游戏窗口信息。"
      : inSourcePicker
        ? "当前疑似处于添加源/源选择流程，需要选择 Game Capture 并点击 Add/添加。"
        : hasAddSource
          ? "当前看到 Add source 入口，但尚未确认画布已有游戏源。"
          : "尚未确认画布已有游戏源，也未稳定识别到添加源入口。"
  };
}

async function callCodex(run, config, roleText, observation, step) {
  const codex = await findOnPath("codex");
  const outputFile = path.join(run.dir, `codex-action-${String(step).padStart(2, "0")}.json`);
  const gameTask = isGameLiveTask(config);
  const gameSourceState = inferGameSourceState(observation.cdpSnapshot);
  gameSourceState.required = gameTask;
  if (!codex) {
    return {
      ok: false,
      action: {
        action: "ask_human",
        reason: "未找到 Codex CLI，无法调用 AI 判断。",
        confidence: 1,
        target: null,
        x: null,
        y: null,
        text: null,
        key: null,
        app: null,
        wait_ms: null,
        need_human: true,
        current_state: "Codex CLI 不可用，无法判断当前页面状态",
        experience_note: "作为执行角色会被阻断，无法继续体验流程。",
        issue: {
          title: "Codex CLI 不可用",
          severity: "Critical",
          description: "任务执行时未找到 Codex CLI，无法完成 AI 判断。"
        }
      }
    };
  }

  const prompt = [
    "你是一个通用 Windows 桌面 Computer Use Agent，同时也是产品体验研究员，正在帮助产品经理体验 TikTok LIVE Studio 或其它桌面功能。",
    "你必须先理解当前页面/弹窗状态，再结合任务目标和执行角色，输出下一步鼠标/键盘/等待/启动/聚焦动作，并记录角色体验感受。",
    "只输出符合 schema 的 JSON。不要输出 Markdown。",
    "",
    "重要原则：",
    "1. 你可以点击、双击、输入文字、按键、组合键、滚动、等待、启动应用、聚焦窗口、请求人工协助或结束任务。",
    "2. 坐标必须使用当前整屏截图的屏幕坐标，x 从左到右，y 从上到下。",
    "3. 如果目标窗口被遮挡、最小化或不在前台，优先用 focus_window 或 launch_app 处理。",
    "4. 每一步都要在 current_state 中说明当前处于什么页面/弹窗/任务阶段；在 experience_note 中从执行角色视角记录理解成本、困惑点、信心、体验问题或正向体验。",
    "5. 如果看到主界面 Go LIVE，只代表进入开播前检查流程，不代表已经开播成功；点击后通常会出现 Live info / 直播信息确认窗口，必须继续观察和判断。",
    "6. 如果出现 Live info、直播标题、topic、封面、About me、直播设置、确认按钮等弹窗，你要理解这些内容，判断默认值是否足够、角色是否容易理解，再决定点击 Continue/Go LIVE/Confirm/Start 等下一步。",
    "7. 如果弹窗/设置页有可滚动内容，且当前只看到部分设置，请先用 scroll 观察更多内容；滚动后再决定是否继续点击最终按钮。",
    "8. 如果任务要求真实开播，且用户允许真实开播，可以点击最终确认开播按钮；否则遇到最终确认前要 ask_human。",
    "9. 只有明确看到已经进入直播中状态、直播性能/聊天进入 live 后状态、或页面提示开播成功，才可以 action=finish。不要在点击主界面 Go LIVE 后立刻 finish。",
    "10. 如果发现新弹窗/浮层，先判断它是什么、是否阻塞当前任务、是否值得从角色视角体验；不要机械关闭。右上角 LIVE Chat 浮窗是全屏游戏主播阅读观众评论用的，不是错误弹窗，除非遮挡关键操作或任务要求体验聊天浮窗，否则不要当作阻塞。",
    "11. 如果你连续看不懂页面、遇到验证码/登录/安全验证/权限弹窗，请 ask_human。",
    "12. 如果当前画布内容不完整，例如缺少游戏画面、摄像头、麦克风状态不清晰，要从角色视角记录体验问题，并可尝试 Add source 或相关配置。",
    "13. 如果任务或角色包含游戏主播、游戏源、Game Capture、Steam、Roblox 等游戏开播语义，那么进入开播流程前必须先确认画布/源列表中已经存在至少一个游戏源。没有确认游戏源前，不允许点击主界面 Go LIVE，也不允许点击 Live info 中的最终 Go LIVE。",
    "14. 游戏源添加的优先路径是：点击 Add source / 添加源 -> 在源选择页选择 Game Capture / 游戏捕获 -> 点击 Add / 添加 / Done。添加后必须回到主界面并确认画布或源列表中出现游戏源/游戏窗口，再继续开播。",
    "15. 如果用户已经提前打开全屏游戏，你需要把它作为待捕获对象；若 Game Capture 后还需要选择具体游戏窗口，请选择最像当前游戏的窗口。找不到游戏窗口或无法确认添加成功时 ask_human，不要跳过游戏源直接开播。",
    "16. 达成任务目标后 action=finish，并在 reason 中总结完成情况和关键体验发现。",
    "17. press_key/hotkey 使用 Windows SendKeys 写法，例如 Enter 用 {ENTER}，Esc 用 {ESC}，Ctrl+V 用 ^v，Alt+Tab 用 %{TAB}。",
    "18. scroll 动作用 y 表示滚动方向和幅度；CDP 会优先滚动当前弹窗或页面里的可滚动容器，向下滚动用 700，向上滚动用 -700。",
    "19. launch_app 的 app 优先填写可执行文件路径、协议或系统可识别的启动目标；如果不知道路径，可先 focus_window 或 ask_human。",
    "",
    `任务描述：${config.task}`,
    `报告类型：${config.reportType}`,
    `角色：${config.role}`,
    `当前步数：${step} / ${config.maxSteps}`,
    `允许真实开播：${config.allowRealGoLive ? "是" : "否"}`,
    `Live Studio 默认路径：${LIVE_STUDIO_EXE}`,
    "",
    "游戏源前置状态：",
    gameTask
      ? JSON.stringify(gameSourceState)
      : "当前任务未识别为游戏开播任务，按普通任务推进。",
    "",
    "角色设定：",
    roleText.slice(0, 1800),
    "",
    "最近历史摘要：",
    compactHistory(run) || "无",
    "",
    "当前截图信息：",
    observation.ok
      ? `截图路径：${observation.screenshot}\n屏幕尺寸：${observation.screen?.width}x${observation.screen?.height}\n目标窗口已尝试置前：${observation.focused ? "是" : "否"}`
      : `截图失败：${observation.error || "未知错误"}`,
    "",
    "当前 DOM/CDP 摘要：",
    observation.cdpSnapshot
      ? JSON.stringify({
        activeOrModalFirstUrl: observation.cdpSnapshot.url,
        pages: observation.cdpSnapshot.pages?.map((page, index) => ({
          index,
          url: page.url,
          bodyText: page.bodyText?.slice(0, 1200),
          controls: page.controls?.slice(0, 60)
        })).slice(0, 6),
        controls: observation.cdpSnapshot.controls?.slice(0, 100)
      })
      : "不可用",
    "",
    "请输出下一步动作。"
  ].join("\n");

  const args = [
    "exec",
    "--ignore-user-config",
    "--json",
    "--output-last-message",
    outputFile,
    "--output-schema",
    ACTION_SCHEMA,
    "--sandbox",
    "read-only"
  ];
  if (observation?.screenshot) args.push("--image", observation.screenshot);

  const result = await execFileText(codex, args, { timeout: 150000, input: prompt });
  if (!result.ok || !(await pathExists(outputFile))) {
    return { ok: false, error: result.stderr || result.stdout || result.error };
  }

  try {
    const action = JSON.parse(await fs.readFile(outputFile, "utf8"));
    return { ok: true, action, raw: result.stdout };
  } catch (error) {
    return { ok: false, error: `Codex 输出解析失败：${error.message}` };
  }
}

function normalizeAction(action) {
  return {
    action: action.action,
    reason: action.reason ?? "",
    confidence: action.confidence ?? 0,
    target: action.target ?? null,
    x: action.x ?? null,
    y: action.y ?? null,
    text: action.text ?? null,
    key: action.key ?? null,
    app: action.app ?? null,
    wait_ms: action.wait_ms ?? null,
    need_human: Boolean(action.need_human),
    current_state: action.current_state ?? "",
    experience_note: action.experience_note ?? "",
    issue: action.issue ?? null
  };
}

function canonicalActionKey(action) {
  const text = `${action.target || ""} ${action.reason || ""}`.toLowerCase();
  if (action.action === "focus_window" && /live studio|tiktok/.test(text)) return "focus:live-studio";
  if (action.action === "click" && /任务栏|taskbar/.test(text) && /live studio|tiktok/.test(text)) return "click:taskbar-live-studio";
  if (action.action === "click" && /go\s*live|开播|粉色/.test(text)) return "click:go-live";
  return `${action.action}:${(action.target || "").toLowerCase().trim()}:${Math.round(Number(action.x || 0) / 30)}:${Math.round(Number(action.y || 0) / 30)}`;
}

function registerRepeat(run, action) {
  const key = canonicalActionKey(action);
  if (run.lastActionKey === key) {
    run.repeatCount += 1;
  } else {
    run.lastActionKey = key;
    run.repeatCount = 1;
  }
  return { key, count: run.repeatCount };
}

function showInspectorWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function hideInspectorForLiveTask(run) {
  if (!run?.focusTitle || !/Live Studio/i.test(run.focusTitle)) return;
  await Promise.resolve();
}

function humanHelpMessage(action, fallback) {
  const text = `${action?.current_state || ""} ${action?.target || ""} ${action?.reason || ""} ${action?.experience_note || ""}`;
  if (/测试.*开播.*警告|开播.*警告|warning|warn/i.test(text)) {
    return "发现测试开播警告弹窗无法关闭，请求人工协助关闭。";
  }
  if (/弹窗|dialog|modal|popup/i.test(text)) {
    return `连续 2 次点击未能推进当前弹窗，请求人工协助处理后继续：${action?.target || fallback}`;
  }
  return fallback;
}

async function waitForHumanAssistance(run, message) {
  await appendLog(run, "ask_human", message);
  showInspectorWindow();
  run.waitingForHuman = true;
  await new Promise((resolve) => {
    run.resumeHuman = resolve;
  });
  run.waitingForHuman = false;
  run.resumeHuman = null;
  if (run.stopped) return false;
  await appendLog(run, "done", "人工协助已完成，继续任务");
  await hideInspectorForLiveTask(run);
  return true;
}

async function executeAction(run, action) {
  const normalized = normalizeAction(action);
  if (normalized.action === "ask_human" || normalized.need_human) {
    return { pause: true, reason: "need_human", message: normalized.reason || "需要人工协助" };
  }
  if (normalized.action === "finish") {
    await appendLog(run, "done", normalized.reason || "任务目标已完成");
    return { stop: true, reason: "finish" };
  }
  if (normalized.action === "observe") {
    await appendLog(run, "observe", normalized.reason || "继续观察");
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { stop: false };
  }

  if (normalized.action === "focus_window") {
    run.focusTitle = normalized.target || run.focusTitle;
    run.focusProcess = normalized.app || run.focusProcess;
  }
  if (normalized.action === "launch_app" && normalized.app && /TikTok LIVE Studio/i.test(normalized.app)) {
    run.focusTitle = "TikTok LIVE Studio";
    run.focusProcess = "TikTok LIVE Studio";
  }

  await appendLog(run, "action", `${normalized.action}: ${normalized.reason}`);
  const actionText = `${normalized.target || ""} ${normalized.reason || ""}`;
  const isTaskbarClick = normalized.action === "click" && /任务栏|taskbar/i.test(actionText);
  const isGoLiveClick = normalized.action === "click" && !isTaskbarClick && /go\s*live|开播按钮|开始直播|粉色按钮|粉色\s*CTA/i.test(actionText);
  let redirectedGoLiveToSource = false;
  if (isGoLiveClick && run.gameSourceRequired && !run.gameSourceConfirmed) {
    await appendLog(run, "issue", "游戏开播任务尚未确认已添加游戏源，已拦截 Go LIVE，优先进入 Add source 流程");
    if (!run.gameCanAddSource) {
      return {
        pause: true,
        reason: "need_human",
        message: "游戏开播前必须先添加游戏源，但当前页面未识别到 Add source 入口。请人工协助打开添加源入口或确认游戏源已存在后继续。"
      };
    }
    normalized.target = "Add source";
    normalized.reason = "游戏开播前必须先添加游戏源，改为点击 Add source";
    redirectedGoLiveToSource = true;
  }
  let result = await executeCdpAction(run, normalized);
  if (!result.ok && !result.skipped) {
    await appendLog(run, "issue", `CDP 动作失败，将回退 RPA：${result.error || "未知错误"}`);
  }
  if (!result.ok) {
    result = isGoLiveClick && !redirectedGoLiveToSource ? await clickPinkCta(run) : await rpa(run, "act", normalized);
  }
  if (!result.ok) {
    await appendLog(run, "issue", `动作执行失败：${result.error || result.reason || "未知错误"}`);
    return { stop: true, reason: "action_failed" };
  }
  if (isGoLiveClick && result.candidate) {
    await appendLog(run, "done", `已用粉色 CTA 校正点击：x=${result.candidate.centerX}, y=${result.candidate.centerY}`);
  } else {
    const focusText = result.focused == null ? "" : `，目标窗口前台校验=${result.focused ? "通过" : "未通过"}`;
    const cdpDetail = result.pageUrl ? `，CDP页面=${result.pageUrl}，详情=${JSON.stringify(result.detail || {}).slice(0, 300)}` : "";
    await appendLog(run, "done", `动作执行完成：${result.result || normalized.action}${focusText}${cdpDetail}`);
  }
  return { stop: false, observation: result };
}

async function writeReport(run, config, env, role, actions, state) {
  const issues = actions
    .filter((item) => item.issue)
    .map((item) => ({ ...item.issue, screenshot: item.screenshot || null }));
  if (issues.length === 0) {
    issues.push({
      title: state === "任务完成" ? "未发现明确问题" : "任务未完整完成",
      severity: state === "任务完成" ? "Minor" : "Major",
      description: state === "任务完成" ? "本次执行未沉淀明确体验问题。" : "任务在完成目标前结束，详见日志。"
    });
  }

  const report = [
    "# LIVE Studio experience assistant 报告",
    "",
    `- 任务描述：${config.task}`,
    `- 报告类型：${config.reportType}`,
    `- 执行角色：${role}`,
    `- 执行状态：${state}`,
    `- 执行时间：${new Date().toLocaleString("zh-CN")}`,
    `- 截图读屏间隔：${config.readInterval}s`,
    "",
    "## 环境信息",
    "",
    `- Live Studio：${env.liveStudio.label}，${env.liveStudio.detail}`,
    `- Codex CLI：${env.codex.label}，${env.codex.detail}`,
    `- 桌面操作能力：${env.desktop.label}，${env.desktop.detail}`,
    `- 屏幕信息：${env.screen.detail}`,
    "",
    "## 动作轨迹",
    "",
    ...actions.flatMap((item, index) => [
      `### Step ${index + 1}: ${item.action}`,
      "",
      `- 当前状态：${item.current_state || "未记录"}`,
      `- 目标：${item.target || "无"}`,
      `- 坐标：${item.x != null && item.y != null ? `${item.x}, ${item.y}` : "无"}`,
      `- 理由：${item.reason}`,
      `- 角色体验记录：${item.experience_note || "未记录"}`,
      `- 置信度：${item.confidence}`,
      item.screenshot ? `- 截图：${item.screenshot}` : "",
      ""
    ]),
    "## 问题列表",
    "",
    ...issues.flatMap((issue, index) => [
      `### ${index + 1}. ${issue.title}`,
      "",
      `- 严重程度：${issue.severity}`,
      `- 描述：${issue.description}`,
      ""
    ]),
    "## 原始产物",
    "",
    `- 日志文件：${run.logFile}`,
    `- 运行目录：${run.dir}`
  ].join("\n");

  await fs.writeFile(run.reportFile, report, "utf8");
  return { issues, reportFile: run.reportFile, logDir: run.dir };
}

async function startTask(config) {
  if (activeRun?.running) throw new Error("已有任务正在执行");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(RUNS_DIR, stamp);
  await fs.mkdir(dir, { recursive: true });
  const run = {
    running: true,
    stopped: false,
    dir,
    logs: [],
    actions: [],
    logFile: path.join(dir, "task.log"),
    reportFile: path.join(dir, "report.md"),
    lastActionKey: "",
    repeatCount: 0,
    focusFailureCount: 0,
    gameSourceRequired: isGameLiveTask(config),
    gameSourceConfirmed: false,
    gameCanAddSource: false,
    focusTitle: /live studio/i.test(config.task) ? "TikTok LIVE Studio" : "",
    focusProcess: /live studio/i.test(config.task) ? "TikTok LIVE Studio" : ""
  };
  activeRun = run;

  send("task:started", { dir });
  await appendLog(run, "observe", "任务启动，正在执行环境复检");

  const env = await detectEnvironment();
  send("env:update", env);
  await appendLog(run, "done", "环境复检完成");

  if (/live studio/i.test(config.task)) {
    const liveReady = await ensureLiveStudioRunning(run);
    if (!liveReady) {
      const report = await writeReport(run, config, env, config.role, [], "启动失败");
      return finishRun(run, "任务失败", "启动失败", report, 0);
    }
    run.cdpAvailable = await ensureLiveStudioCdp(run);
    await activateLiveStudio(run);
  }

  const roles = await listRoles();
  const selected = roles.find((item) => item.name === config.role) || roles[0];
  const roleText = selected ? await fs.readFile(selected.file, "utf8") : "";
  await appendLog(run, "observe", `已加载角色：${selected?.name || "未选择"}`);

  let finalState = "未完成";
  for (let step = 1; step <= config.maxSteps; step += 1) {
    if (run.stopped) {
      finalState = "用户终止";
      break;
    }

    await appendLog(run, "observe", `Step ${step}: 正在截图并读取屏幕`);
    const observation = /live studio/i.test(config.task) ? await restoreAndCaptureLiveStudio(run) : await rpa(run, "capture");
    if (/live studio/i.test(config.task) && run.cdpAvailable) {
      observation.cdpSnapshot = await getCdpSnapshot();
      if (observation.cdpSnapshot) {
        await appendLog(run, "done", `CDP 已读取 DOM：${observation.cdpSnapshot.controls?.length || 0} 个可见控件`);
        if (run.gameSourceRequired) {
          const gameState = inferGameSourceState(observation.cdpSnapshot);
          run.gameCanAddSource = Boolean(gameState.hasAddSource || gameState.inSourcePicker || gameState.hasGameCaptureOption);
          if (gameState.hasGameSourceOnCanvas) run.gameSourceConfirmed = true;
          await appendLog(run, "observe", `游戏源检查：${gameState.summary}`);
        }
      }
    }
    if (!observation.ok) {
      await appendLog(run, "ask_human", `无法截图或聚焦目标窗口：${observation.error || "未知错误"}`);
      finalState = "需要人工协助";
      break;
    }
    if (!observation.focused && /live studio/i.test(config.task)) {
      await appendLog(run, "issue", "Live Studio 仍未成功置前，将交给 Codex 判断是否点击任务栏或请求人工协助");
      run.focusFailureCount += 1;
      if (run.focusFailureCount >= 3) {
        await appendLog(run, "ask_human", "连续 3 次未能将 Live Studio 置于前台，请人工协助切换窗口后继续。");
        finalState = "需要人工协助";
        break;
      }
    } else {
      run.focusFailureCount = 0;
    }

    await appendLog(run, "action", `Step ${step}: 正在调用 Codex 判断下一步`);
    const codexResult = await callCodex(run, config, roleText, observation, step);
    if (run.stopped) {
      finalState = "用户终止";
      break;
    }
    if (!codexResult.ok) {
      await appendLog(run, "ask_human", `Codex 调用失败：${codexResult.error || "未知错误"}`);
      finalState = "需要人工协助";
      break;
    }

    const action = normalizeAction(codexResult.action);
    action.screenshot = observation.screenshot;
    run.actions.push(action);
    await appendLog(run, action.need_human ? "ask_human" : "done", `Codex 决策：${action.action} · ${action.reason}`);

    const repeat = registerRepeat(run, action);
    if (action.action === "click" && repeat.count >= 2) {
      const message = humanHelpMessage(action, `连续 2 次点击操作仍未推进：${repeat.key}。请人工协助处理当前页面或弹窗后继续。`);
      const canContinue = await waitForHumanAssistance(run, message);
      run.lastActionKey = "";
      run.repeatCount = 0;
      if (!canContinue) {
        finalState = "用户终止";
        break;
      }
      continue;
    }
    if (repeat.count >= 3 && !["finish", "ask_human"].includes(action.action)) {
      const canContinue = await waitForHumanAssistance(run, `连续 ${repeat.count} 次尝试同类操作仍未推进：${repeat.key}。请人工协助确认窗口或目标控件状态。`);
      run.lastActionKey = "";
      run.repeatCount = 0;
      if (!canContinue) {
        finalState = "用户终止";
        break;
      }
      continue;
    }

    const actionResult = await executeAction(run, action);
    if (actionResult.pause) {
      const canContinue = await waitForHumanAssistance(run, actionResult.message || "需要人工协助");
      if (!canContinue) {
        finalState = "用户终止";
        break;
      }
      continue;
    }
    if (actionResult.reason === "finish") {
      finalState = "任务完成";
      break;
    }
    if (actionResult.stop) {
      finalState = actionResult.reason === "need_human" ? "需要人工协助" : "执行失败";
      break;
    }

    const waitMs = Math.max(500, Number(config.readInterval || 1) * 1000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (finalState === "未完成") finalState = "达到最大步数";
  const report = await writeReport(run, config, env, selected?.name || config.role, run.actions, finalState);
  await appendLog(run, "done", "本地报告已生成");
  return finishRun(run, finalState === "任务完成" ? "任务已完成" : finalState, `${run.actions.length} 步`, report, run.actions.length);
}

function finishRun(run, status, duration, report, steps) {
  run.running = false;
  activeRun = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  send("task:finished", {
    status,
    steps,
    duration,
    issues: report.issues,
    reportFile: report.reportFile,
    logDir: report.logDir
  });
}

function mapVisionEventType(event) {
  if (event === "finished") return "done";
  if (event === "warn" || event === "error") return "issue";
  if (event === "ask_human") return "ask_human";
  if (event === "action") return "action";
  if (event === "done") return "done";
  return "observe";
}

async function readVisionResult(run) {
  const resultFile = path.join(run.dir, "result.json");
  if (!(await pathExists(resultFile))) {
    return {
      issues: [{
        title: "视觉 Agent 未生成结果文件",
        severity: "Major",
        description: "任务结束时未找到 result.json，请查看日志目录。"
      }],
      reportFile: run.reportFile,
      logDir: run.dir,
      success: false,
      steps: run.steps || 0
    };
  }
  const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
  const actions = Array.isArray(result.action_log) ? result.action_log : [];
  const issueKeywords = /请求人工协助|失败|无法|未能|错误|不确定|黑屏|缺少|困惑|不清楚|不明确|担心|焦虑|不敢|成本|提示|入口|默认|等待|加载/;
  const issues = actions
    .filter((item) => issueKeywords.test(String(`${item.summary || ""} ${item.experience_note || ""} ${item.current_state || ""}`)))
    .slice(0, 10)
    .map((item, index) => {
      const summary = String(item.summary || "");
      const note = String(item.experience_note || "");
      const state = String(item.current_state || "");
      const blocking = /请求人工协助|失败|无法|未能|错误|黑屏/.test(`${summary} ${state}`);
      const titleSource = blocking ? summary : note || state || summary;
      return {
        title: String(titleSource || `体验观察 ${index + 1}`).replace(/\s+/g, " ").slice(0, 64),
        severity: blocking ? "Major" : "Minor",
        description: note || state || summary || "详见本地报告。",
        screenshot: item.screenshot || null
      };
    });
  if (issues.length === 0) {
    issues.push({
      title: result.success ? "未发现明确阻塞问题" : "任务未完整完成",
      severity: result.success ? "Minor" : "Major",
      description: result.success ? "本次执行未沉淀明确问题，请查看完整报告。" : "任务未达到 done=true，详见完整报告和操作日志。"
    });
  }
  return {
    issues,
    reportFile: result.reportFile || run.reportFile,
    logDir: result.logDir || run.dir,
    success: Boolean(result.success),
    steps: actions.length
  };
}

async function startVisionTask(config) {
  if (activeRun?.running) throw new Error("已有任务正在执行");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(RUNS_DIR, stamp);
  await fs.mkdir(dir, { recursive: true });
  const roles = await listRoles();
  const selected = roles.find((item) => item.name === config.role) || roles[0];
  const run = {
    running: true,
    stopped: false,
    dir,
    logs: [],
    steps: 0,
    logFile: path.join(dir, "task.log"),
    reportFile: path.join(dir, "report.md"),
    humanSignalFile: path.join(dir, "human.done"),
    child: null
  };
  activeRun = run;

  send("task:started", { dir });
  const aiProvider = config.aiProvider || "codex";
  const aiLabel = aiProvider === "codex" ? "Codex CLI" : (config.apiProviderLabel || aiProvider);
  await appendLog(run, "observe", `任务启动，AI 引擎：${aiLabel}`);

  const liveReady = /live studio/i.test(config.task) ? await ensureLiveStudioRunning(run) : true;
  if (!liveReady) {
    await fs.writeFile(run.reportFile, "# 任务失败\n\n未能启动或找到 Live Studio。", "utf8");
    return finishRun(run, "任务失败", "启动失败", {
      issues: [{ title: "Live Studio 启动失败", severity: "Critical", description: "未能启动或找到 Live Studio。" }],
      reportFile: run.reportFile,
      logDir: run.dir
    }, 0);
  }

  const args = [
    VISION_AGENT_SCRIPT,
    "--root", ROOT,
    "--run-dir", dir,
    "--task", config.task,
    "--role", config.role,
    "--role-file", selected?.file || "",
    "--window-title", "TikTok LIVE Studio",
    "--max-steps", String(config.maxSteps || 60),
    "--human-signal", run.humanSignalFile,
    "--provider", aiProvider
  ];
  if (aiProvider === "codex") {
    const codexPath = await findOnPath("codex");
    if (codexPath) args.push("--codex-path", codexPath);
  }
  if (config.allowRealGoLive) args.push("--allow-go-live");
  if (aiProvider !== "codex") {
    args.push("--api-base-url", config.apiBaseUrl || config.mimoBaseUrl || "");
    args.push("--api-model", config.apiModel || config.mimoModel || "");
    args.push("--api-key", config.apiKey || config.mimoApiKey || "");
  }

  await appendLog(run, "observe", `已加载角色：${selected?.name || config.role}`);
  const child = spawn("python", args, {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      AI_API_KEY: config.apiKey || config.mimoApiKey || process.env.AI_API_KEY || "",
      XIAOMI_API_KEY: config.apiKey || config.mimoApiKey || process.env.XIAOMI_API_KEY || ""
    }
  });
  run.child = child;

  let stdoutBuffer = "";
  child.stdout.on("data", async (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.event === "action") run.steps += 1;
        if (row.event === "ask_human") {
          run.waitingForHuman = true;
          showInspectorWindow();
        }
        if (row.event === "done" && run.waitingForHuman) {
          run.waitingForHuman = false;
        }
        await appendLog(run, mapVisionEventType(row.event), row.message || row.event);
      } catch {
        await appendLog(run, "observe", line.slice(0, 500));
      }
    }
  });
  child.stderr.on("data", async (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) await appendLog(run, "issue", text.slice(0, 1000));
  });
  child.on("close", async (code) => {
    if (activeRun !== run) return;
    if (run.stopped) {
      await fs.writeFile(run.reportFile, "# 任务已终止\n\n用户终止了任务。", "utf8").catch(() => {});
      return finishRun(run, "用户终止", `${run.steps} 步`, {
        issues: [{ title: "用户终止任务", severity: "Major", description: "任务被用户手动终止。" }],
        reportFile: run.reportFile,
        logDir: run.dir
      }, run.steps);
    }
    const result = await readVisionResult(run).catch(async (error) => {
      await appendLog(run, "issue", error.message);
      return {
        issues: [{ title: "读取视觉 Agent 结果失败", severity: "Major", description: error.message }],
        reportFile: run.reportFile,
        logDir: run.dir,
        success: false,
        steps: run.steps
      };
    });
    finishRun(run, result.success ? "任务已完成" : (code === 2 ? "需要人工协助" : "任务未完整完成"), `${result.steps || run.steps} 步`, result, result.steps || run.steps);
  });

  return { ok: true };
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 920,
    minWidth: 590,
    minHeight: 560,
    title: "LIVE Studio experience assistant",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
}

app.whenReady().then(async () => {
  const admin = await isRunningAsAdmin();
  if (!admin) {
    const relaunched = await relaunchAsAdmin();
    if (relaunched) {
      app.quit();
      return;
    }
  }
  await fs.mkdir(RUNS_DIR, { recursive: true });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("env:detect", detectEnvironment);
ipcMain.handle("roles:list", listRoles);
ipcMain.handle("roles:openDir", () => shell.openPath(ROLES_DIR));
ipcMain.handle("task:start", async (_event, config) => {
  startVisionTask(config).catch((error) => {
    send("task:log", { time: new Date().toISOString(), type: "issue", message: error.message });
    send("task:error", { message: error.message });
  });
  return { ok: true };
});
ipcMain.handle("task:stop", async () => {
  if (activeRun) {
    activeRun.stopped = true;
    await appendLog(activeRun, "issue", "用户请求终止任务");
    activeRun.child?.kill?.();
    activeRun.resumeHuman?.();
  }
  return { ok: true };
});
ipcMain.handle("task:humanDone", async () => {
  if (activeRun?.waitingForHuman) {
    if (activeRun.humanSignalFile) {
      await fs.writeFile(activeRun.humanSignalFile, String(Date.now()), "utf8").catch(() => {});
    }
    activeRun.resumeHuman?.();
    return { ok: true };
  }
  return { ok: false, error: "当前没有等待人工协助的任务" };
});
ipcMain.handle("image:dataUrl", async (_event, filePath) => imageDataUrl(filePath));
ipcMain.handle("file:open", async (_event, filePath) => shell.openPath(filePath));
ipcMain.handle("dir:open", async (_event, dirPath) => shell.openPath(dirPath));
