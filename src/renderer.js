const $ = (selector) => document.querySelector(selector);
const envList = $("#env-list");
const roleSelect = $("#role");
const logEl = $("#log");

let reportFile = null;
let logDir = null;
let startedAt = null;
let timer = null;
let stepCount = 0;
let envPassed = false;
let issueImages = [];
let lastEnv = null;

function show(id) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === id);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function pillClass(status) {
  if (status === "ok") return "ok";
  if (status === "warn") return "warn";
  if (status === "info") return "info";
  return "error";
}

function renderEnv(env) {
  lastEnv = env;
  const items = [
    ["Live Studio", env.liveStudio],
    ["Live Studio 登录状态", env.liveLogin],
    ["Codex CLI", env.codex],
    ["桌面操作能力", env.desktop],
    ["屏幕信息", env.screen]
  ];
  envList.innerHTML = items.map(([name, item]) => `
    <li class="env-item">
      <div>
        <div class="env-name">${escapeHtml(name)}</div>
        <div class="env-detail">${escapeHtml(item.detail || "")}</div>
      </div>
      <span class="pill ${pillClass(item.status)}">${escapeHtml(item.label)}</span>
    </li>
  `).join("");
  envPassed = computeEnvPassed();
  updateStartButton();
}

function computeEnvPassed() {
  if (!lastEnv) return false;
  const baseOk = ["ok", "warn"].includes(lastEnv.liveStudio?.status) && lastEnv.desktop?.status === "ok";
  if (!baseOk) return false;
  if ($("#ai-provider")?.value === "mimo") return true;
  return lastEnv.codex?.status === "ok";
}

async function refreshEnv() {
  envPassed = false;
  updateStartButton();
  envList.innerHTML = `<li class="env-item"><div><div class="env-name">检测中</div><div class="env-detail">正在检查本机环境</div></div><span class="pill info">进行中</span></li>`;
  try {
    const env = await window.inspector.detectEnv();
    renderEnv(env);
  } catch (error) {
    envPassed = false;
    updateStartButton();
    envList.innerHTML = `<li class="env-item"><div><div class="env-name">环境检测失败</div><div class="env-detail">${escapeHtml(error.message || error)}</div></div><span class="pill error">异常</span></li>`;
  }
}

function updateStartButton() {
  const button = $("#start-task");
  const hasTask = Boolean($("#task").value.trim());
  envPassed = computeEnvPassed();
  const canStart = envPassed && hasTask;
  button.classList.toggle("disabled", !canStart);
  button.setAttribute("aria-disabled", canStart ? "false" : "true");
  if (!hasTask) {
    button.title = "请输入任务";
  } else if (!envPassed) {
    button.title = "请确保通过环境检测";
  } else {
    button.title = "";
  }
}

async function loadRoles() {
  const roles = await window.inspector.listRoles();
  roleSelect.innerHTML = roles.map((role) => `<option value="${escapeHtml(role.name)}">${escapeHtml(role.name)}</option>`).join("");
}

function selectedReportType() {
  return $("#report-type button.active").dataset.value;
}

function readConfig() {
  const provider = $("#ai-provider").value;
  localStorage.setItem("aiProvider", provider);
  localStorage.setItem("mimoBaseUrl", $("#mimo-base-url").value.trim());
  localStorage.setItem("mimoModel", $("#mimo-model").value.trim());
  if ($("#mimo-api-key").value.trim()) {
    localStorage.setItem("mimoApiKey", $("#mimo-api-key").value.trim());
  }
  return {
    task: $("#task").value.trim(),
    reportType: selectedReportType(),
    role: roleSelect.value,
    maxSteps: Number($("#max-steps").value || 60),
    readInterval: Number($("#interval").value || 1),
    allowRealGoLive: $("#allow-live").checked,
    saveScreenshots: $("#save-shots").checked,
    aiProvider: provider,
    mimoBaseUrl: $("#mimo-base-url").value.trim(),
    mimoModel: $("#mimo-model").value.trim(),
    mimoApiKey: $("#mimo-api-key").value.trim() || localStorage.getItem("mimoApiKey") || ""
  };
}

function updateProviderUi() {
  const isMimo = $("#ai-provider").value === "mimo";
  $("#mimo-settings").hidden = !isMimo;
  updateStartButton();
}

function resetRunUi() {
  stepCount = 0;
  logEl.textContent = "";
  $("#step-count").textContent = `0 / ${$("#max-steps").value || 60}`;
  $("#running-interval").textContent = `${$("#interval").value}s`;
  $("#stage-box").classList.remove("need-human");
  $("#human-done").hidden = true;
  $("#stage-title").textContent = "当前阶段：准备启动";
  $("#stage-copy").textContent = "正在初始化任务。";
  startedAt = Date.now();
  clearInterval(timer);
  timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const min = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const sec = String(elapsed % 60).padStart(2, "0");
    $("#elapsed").textContent = `${min}:${sec}`;
  }, 500);
}

function appendLog(row) {
  const time = new Date(row.time).toLocaleTimeString("zh-CN", { hour12: false });
  logEl.textContent += `[${time}] ${row.type.toUpperCase()} ${row.message}\n`;
  logEl.scrollTop = logEl.scrollHeight;

  if (["observe", "action", "done"].includes(row.type)) {
    $("#human-done").hidden = true;
    stepCount += row.type === "action" ? 1 : 0;
    $("#step-count").textContent = `${stepCount} / ${$("#max-steps").value || 60}`;
    $("#stage-title").textContent = row.type === "action" ? "当前阶段：执行动作" : "当前阶段：观察与判断";
    $("#stage-copy").textContent = row.message;
  }
  if (row.type === "ask_human") {
    $("#stage-box").classList.add("need-human");
    $("#stage-title").textContent = "需要人工协助";
    $("#stage-copy").textContent = row.message;
    $("#human-done").hidden = false;
  }
  if (row.type === "issue") {
    $("#stage-copy").textContent = row.message;
  }
}

function ensureImageViewer() {
  let viewer = $("#image-viewer");
  if (viewer) return viewer;
  viewer = document.createElement("div");
  viewer.id = "image-viewer";
  viewer.className = "image-viewer";
  viewer.hidden = true;
  viewer.innerHTML = `
    <button class="image-viewer-close" id="image-viewer-close" type="button" aria-label="关闭">×</button>
    <img class="image-viewer-img" id="image-viewer-img" alt="问题截图大图" />
  `;
  document.body.appendChild(viewer);
  $("#image-viewer-close").addEventListener("click", () => {
    viewer.hidden = true;
    $("#image-viewer-img").removeAttribute("src");
  });
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) {
      viewer.hidden = true;
      $("#image-viewer-img").removeAttribute("src");
    }
  });
  return viewer;
}

async function renderIssues(issues) {
  const enriched = await Promise.all(issues.map(async (issue) => {
    if (!issue.screenshot) return { ...issue, image: null };
    const image = await window.inspector.imageDataUrl(issue.screenshot).catch(() => null);
    return { ...issue, image };
  }));
  issueImages = enriched.map((issue) => issue.image);
  $("#issue-count").textContent = `${issues.length} 个问题`;
  $("#issue-list").innerHTML = enriched.map((issue, index) => {
    const shot = issue.image
      ? `<button class="thumb-btn" type="button" data-index="${index}" title="${escapeHtml(issue.screenshot)}"><img class="thumb-img" src="${issue.image}" alt="问题截图" /></button>`
      : issue.screenshot
        ? `<div class="thumb-missing" title="${escapeHtml(issue.screenshot)}">截图缺失</div>`
        : "";
    return `
      <li class="issue ${shot ? "issue-with-shot" : ""}">
        <div>
          <div class="issue-head">
            <span>${escapeHtml(issue.title)}</span>
            <span class="pill ${issue.severity === "Critical" ? "danger" : issue.severity === "Major" ? "warn" : "info"}">${escapeHtml(issue.severity)}</span>
          </div>
          <p>${escapeHtml(issue.description)}</p>
        </div>
        ${shot}
      </li>
    `;
  }).join("");
  document.querySelectorAll(".thumb-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const image = issueImages[Number(button.dataset.index)];
      if (!image) return;
      ensureImageViewer();
      $("#image-viewer-img").src = image;
      $("#image-viewer").hidden = false;
    });
  });
}

document.querySelectorAll("#report-type button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("#report-type button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});

$("#refresh-env").addEventListener("click", refreshEnv);
$("#task").addEventListener("input", updateStartButton);
$("#ai-provider").addEventListener("change", updateProviderUi);
$("#open-roles").addEventListener("click", () => window.inspector.openRolesDir());
$("#start-task").addEventListener("click", async () => {
  const config = readConfig();
  if (!config.task) {
    alert("请输入任务");
    return;
  }
  if (!envPassed) {
    alert("请确保通过环境检测");
    return;
  }
  resetRunUi();
  show("running");
  await window.inspector.startTask(config);
});
$("#stop-task").addEventListener("click", () => window.inspector.stopTask());
$("#human-done").addEventListener("click", async () => {
  $("#human-done").hidden = true;
  $("#stage-box").classList.remove("need-human");
  $("#stage-title").textContent = "当前阶段：继续执行";
  $("#stage-copy").textContent = "已收到人工协助完成信号，正在继续观察。";
  await window.inspector.humanDone();
});
$("#back-home").addEventListener("click", () => show("prepare"));
$("#open-report").addEventListener("click", () => reportFile && window.inspector.openFile(reportFile));
$("#open-log-dir").addEventListener("click", () => logDir && window.inspector.openDir(logDir));

window.inspector.onEnvUpdate(renderEnv);
window.inspector.onTaskStarted(() => appendLog({ time: new Date().toISOString(), type: "observe", message: "任务运行目录已创建" }));
window.inspector.onTaskLog(appendLog);
window.inspector.onTaskError((payload) => {
  clearInterval(timer);
  $("#stage-box").classList.add("need-human");
  $("#stage-title").textContent = "任务异常";
  $("#stage-copy").textContent = payload.message;
});
window.inspector.onTaskFinished((payload) => {
  clearInterval(timer);
  reportFile = payload.reportFile;
  logDir = payload.logDir;
  $("#done-title").textContent = payload.status;
  $("#done-summary").textContent = `共执行 ${payload.steps} 步 · ${payload.duration} · 发现 ${payload.issues.length} 个问题 · 本地报告已生成`;
  renderIssues(payload.issues);
  show("done");
});

loadRoles();
$("#ai-provider").value = localStorage.getItem("aiProvider") || "codex";
$("#mimo-base-url").value = localStorage.getItem("mimoBaseUrl") || "https://token-plan-cn.xiaomimimo.com/v1";
$("#mimo-model").value = localStorage.getItem("mimoModel") || "mimo-v2-omni";
$("#mimo-api-key").value = localStorage.getItem("mimoApiKey") || "";
updateProviderUi();
refreshEnv();
