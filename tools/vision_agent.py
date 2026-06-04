# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import base64
import ctypes
import io
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import mss
import pyautogui
import pygetwindow as gw
import pyperclip
import requests
from dotenv import load_dotenv
from PIL import Image


DEFAULT_MIMO_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1"
DEFAULT_MIMO_MODEL = "mimo-v2-omni"
MAX_IMAGE_PIXELS = 1_000_000
MAX_IMAGE_LONGEST = 1400
STEP_SLEEP_SEC = 1.0


def emit(event: str, message: str, **extra: Any) -> None:
    print(json.dumps({"event": event, "message": message, **extra}, ensure_ascii=False), flush=True)


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def find_window(title_substr: str) -> Any | None:
    key = title_substr.lower()
    wins = [w for w in gw.getAllWindows() if key in (w.title or "").lower()]
    return wins[0] if wins else None


def activate_window(win: Any) -> None:
    try:
        if win.isMinimized:
            win.restore()
            time.sleep(0.2)
        win.activate()
    except Exception as exc:
        emit("warn", f"激活窗口失败：{exc}")
    time.sleep(0.5)


def clamp_region(sct: mss.mss, left: int, top: int, width: int, height: int) -> tuple[int, int, int, int]:
    screen = sct.monitors[0]
    s_left, s_top = screen["left"], screen["top"]
    s_right = s_left + screen["width"]
    s_bottom = s_top + screen["height"]
    c_left = max(left, s_left)
    c_top = max(top, s_top)
    c_right = min(left + width, s_right)
    c_bottom = min(top + height, s_bottom)
    if c_right <= c_left or c_bottom <= c_top:
        raise RuntimeError("窗口截图区域无效")
    return c_left, c_top, c_right - c_left, c_bottom - c_top


def grab_window(win: Any, sct: mss.mss, save_path: Path) -> tuple[Image.Image, float, int, int, int, int]:
    wl, wt = int(win.left), int(win.top)
    ww, wh = int(win.width), int(win.height)
    area = max(ww * wh, 1)
    longest = max(ww, wh, 1)
    scale = min(1.0, math.sqrt(MAX_IMAGE_PIXELS / area), MAX_IMAGE_LONGEST / longest)
    sw = max(1, round(ww * scale))
    sh = max(1, round(wh * scale))
    cap_l, cap_t, cap_w, cap_h = clamp_region(sct, wl, wt, ww, wh)
    raw = sct.grab({"left": cap_l, "top": cap_t, "width": cap_w, "height": cap_h})
    img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    if img.size != (sw, sh):
        img = img.resize((sw, sh), Image.Resampling.LANCZOS)
    img.save(save_path, format="PNG")
    return img, scale, sw, sh, wl, wt


def image_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def extract_json_object(text: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for idx in range(start, len(text)):
        if text[idx] == "{":
            depth += 1
        elif text[idx] == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(text[start : idx + 1])
                    return value if isinstance(value, dict) else None
                except json.JSONDecodeError:
                    return None
    return None


def ask_mimo(api_key: str, base_url: str, model: str, img: Image.Image, prompt: str) -> str:
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64(img)}"}},
                ],
            }
        ],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    resp = requests.post(url, headers=headers, json=payload, timeout=180)
    if not resp.ok:
        raise RuntimeError(f"MiMo HTTP {resp.status_code}: {resp.text[:1200]}")
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def ask_codex(codex_path: str, root: Path, img_path: Path, prompt: str, output_path: Path) -> str:
    if not codex_path:
        raise RuntimeError("未找到 Codex CLI 可执行文件")
    cmd = [
        codex_path,
        "exec",
        "--ignore-user-config",
        "--json",
        "--output-last-message",
        str(output_path),
        "--sandbox",
        "read-only",
        "--image",
        str(img_path),
    ]
    try:
        result = subprocess.run(cmd, input=prompt, text=True, encoding="utf-8", cwd=str(root), capture_output=True, timeout=180)
    except FileNotFoundError as exc:
        raise RuntimeError(f"Codex CLI 路径不可执行：{codex_path}；{exc}") from exc
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Codex CLI 调用失败")[:1200])
    if output_path.exists():
        return output_path.read_text(encoding="utf-8")
    return result.stdout


def ask_provider(args: argparse.Namespace, root: Path, img: Image.Image, img_path: Path, prompt: str, output_path: Path) -> str:
    if args.provider == "codex":
        return ask_codex(args.codex_path, root, img_path, prompt, output_path)
    if args.provider == "mimo":
        api_key = args.mimo_api_key or os.getenv("XIAOMI_API_KEY", "")
        if not api_key:
            raise RuntimeError("缺少 MiMo API Key")
        return ask_mimo(api_key, args.mimo_base_url, args.mimo_model, img, prompt)
    raise RuntimeError(f"未知 AI 引擎：{args.provider}")


def fallback_report(task: str, role: str, action_log: list[dict[str, Any]], error: str = "") -> str:
    lines = [
        "# LIVE Studio 体验任务报告",
        "",
        f"- 任务：{task}",
        f"- 角色：{role}",
        f"- 执行状态：未完整完成",
    ]
    if error:
        lines.append(f"- 失败原因：{error}")
    lines.extend(["", "## 执行记录"])
    if not action_log:
        lines.append("- 未产生有效操作记录。")
    for item in action_log:
        lines.append(f"- Step {item.get('step', '-')}: {item.get('summary', '')}")
    return "\n".join(lines) + "\n"


def wait_for_human_signal(signal_path: Path, message: str) -> None:
    emit("ask_human", message)
    while not signal_path.exists():
        time.sleep(0.5)
    try:
        signal_path.unlink()
    except OSError:
        pass
    emit("done", "人工协助已完成，重新截图判断")


def to_abs(wl: int, wt: int, scale: float, x: float, y: float) -> tuple[int, int]:
    return int(wl + x / scale), int(wt + y / scale)


def should_finish_require_live(task: str) -> bool:
    text = task.lower()
    return any(word in text for word in ["开播", "直播", "go live", "live", "完成一次开播", "完成游戏开播"])


def looks_live_success(reason: str, current_state: str, experience_note: str) -> bool:
    text = f"{reason} {current_state} {experience_note}".lower()
    success_words = ["已开播", "开播成功", "直播中", "正在直播", "live now", "you are live", "直播已开始"]
    false_words = ["live info", "确认页", "开播前", "未开播", "还未开播", "不能进入", "不能开播"]
    return any(word in text for word in success_words) and not any(word in text for word in false_words)


def focus_game_then_live_studio(live_title: str) -> str:
    live_key = live_title.lower()
    blocked_keywords = [
        "live studio",
        "codex",
        "chrome",
        "edge",
        "feishu",
        "lark",
        "explorer",
        "powershell",
        "terminal",
        "visual studio code",
    ]
    candidates = []
    for window in gw.getAllWindows():
        title = (window.title or "").strip()
        if not title:
            continue
        lower = title.lower()
        if live_key in lower or any(word in lower for word in blocked_keywords):
            continue
        try:
            if window.width < 160 or window.height < 120:
                continue
        except Exception:
            continue
        candidates.append(window)
    if not candidates:
        raise RuntimeError("未找到可聚焦的游戏窗口，请先打开游戏并保持窗口可见")

    game = max(candidates, key=lambda item: int(getattr(item, "width", 0)) * int(getattr(item, "height", 0)))
    activate_window(game)
    time.sleep(2.0)
    live = find_window(live_title)
    if live is None:
        raise RuntimeError("已聚焦游戏窗口，但无法找回 Live Studio 窗口")
    activate_window(live)
    time.sleep(1.0)
    return f"已聚焦疑似游戏窗口「{game.title}」并切回 Live Studio 复查捕获画面"


def execute_action(action: dict[str, Any], scale: float, wl: int, wt: int, live_title: str) -> str:
    atype = action.get("type")
    if atype == "click":
        abs_x, abs_y = to_abs(wl, wt, scale, float(action["x"]), float(action["y"]))
        target = str(action.get("target", "目标"))
        pyautogui.moveTo(abs_x, abs_y, duration=0.25)
        time.sleep(0.2)
        pyautogui.click()
        return f"点击 {target} ({abs_x},{abs_y})"
    if atype == "type":
        text = str(action.get("text", ""))
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.1)
        pyautogui.hotkey("ctrl", "v")
        return f"粘贴输入：{text}"
    if atype == "key":
        key = str(action.get("key", "")).lower()
        pyautogui.press(key)
        return f"按键：{key}"
    if atype == "wait":
        sec = max(0.5, min(10, float(action.get("seconds", 1))))
        time.sleep(sec)
        return f"等待 {sec:g} 秒"
    if atype == "focus_game_then_live_studio":
        return focus_game_then_live_studio(live_title)
    return f"忽略不支持动作：{atype}"


def role_strategy(role: str, task: str) -> str:
    text = f"{role} {task}".lower()
    if any(word in text for word in ["游戏", "game", "steam", "roblox"]):
        return (
            "这是游戏主播任务。开播前的必要内容是至少一个游戏源/游戏捕获/游戏窗口源；摄像头是可选项。"
            "必须先确认或添加游戏源；如果没有可捕获游戏窗口，请请求人工协助打开游戏。"
            "添加游戏源时优先尝试手动选择具体游戏进程/游戏窗口，其次才使用 Any full-screen game/自动捕获全屏游戏。"
            "摄像头添加失败或无设备可以记录并跳过。确认已经添加游戏源后即可进入 Go LIVE 流程。"
            "如果已经添加 Game Capture/Full-screen app 但画布黑屏或提示无法捕获，先聚焦一次游戏窗口再切回 Live Studio 复查；如果仍异常，把它记录为体验问题，但不要因此终止开播流程。"
            "如果任务包含完成开播，必须继续到主界面 Go LIVE、Live info 确认页、最终 Go LIVE，并看到直播中/开播成功后才算完成。"
        )
    if any(word in text for word in ["秀场", "show", "camera", "摄像头"]):
        return (
            "这是秀场主播任务。开播前的必要内容是摄像头源和麦克风状态；摄像头是必需项。"
            "必须先确认或添加摄像头源；如果没有摄像头设备或无法开启，请请求人工协助。"
            "确认画布已有摄像头画面后，才进入 Go LIVE 流程。"
        )
    return "先按角色和任务判断必需内容、设备状态和信息配置；缺少核心前置条件时先补齐或请求人工协助。"


def build_step_prompt(task: str, role: str, role_text: str, strategy: str, history: list[dict[str, Any]], sw: int, sh: int, allow_go_live: bool) -> str:
    log = "\n".join([f"- Step {item['step']}: {item['summary']}" for item in history[-10:]]) or "无"
    return f"""
你正在操作 TikTok LIVE Studio。当前截图尺寸为 {sw}x{sh}，动作坐标必须使用截图内坐标。

任务：{task}
执行角色：{role}
角色设定：
{role_text[:1800]}

任务拆解原则：
{strategy}

已执行操作：
{log}

要求：
1. 先理解当前页面和任务缺口，再决定下一步，不要机械寻找某个固定按钮。
2. 动作只能是 click、type、key、wait、focus_game_then_live_studio。
3. 游戏主播任务：未添加游戏源前不能进入 Go LIVE；找不到游戏窗口时 need_human=true。添加游戏源时优先手动选择具体游戏进程/游戏窗口，其次才用 Any full-screen game/自动捕获。
4. 秀场主播任务：未确认摄像头源前不能进入 Go LIVE；没有摄像头设备时 need_human=true。
5. 摄像头对游戏主播是可选项，失败可记录并跳过。
6. 游戏源已添加但画布仍黑屏、无游戏画面、或提示 Couldn't capture / closed / not captured 时，优先输出 action.type="focus_game_then_live_studio"，让工具聚焦游戏窗口后再切回 Live Studio 复查；如果复查后仍失败，把它记录为体验问题，但继续 Go LIVE 流程，不要因为黑屏终止任务。
7. 点击主界面 Go LIVE 只是进入开播前确认；Live info 中还要理解标题、topic、封面、About me 和直播设置。
8. allow_go_live={allow_go_live}；如果为 false，遇到最终真实开播确认必须请求人工协助。
9. 如果任务包含“开播/完成游戏开播/Go LIVE/直播”，只有明确看到直播中/开播成功，才 done=true；只完成添加源、进入 Live info、或点击主界面 Go LIVE 都不能 done=true。
10. 每一步都要从角色视角记录体验观察，包括主界面信息密度、入口理解、弹窗文案、默认值、加载等待、画布反馈、异常提示是否可理解。
11. 不确定的界面元素标注“不确定”，不要编造。
12. 游戏源已添加但画布黑屏/捕获失败是体验问题，不是终止任务的理由；聚焦重试或人工协助后仍异常，也要继续完成 Go LIVE 开播流程。
13. 当 need_human=true 时，工具会等待用户点击“已完成人工协助”；点击后必须基于下一张新截图重新判断当前状态，不要沿用旧截图结论。
14. “完成游戏开播/完成 Go LIVE”的任务目标优先级高于画布质量门槛；画面异常写进报告，但仍继续开播。

只输出 JSON：
{{
  "done": false,
  "need_human": false,
  "reason": "当前判断",
  "current_state": "当前页面/阶段",
  "experience_note": "角色体验记录",
  "action": {{"type":"click","x":123,"y":456,"target":"控件描述"}}
}}
"""


def build_report_prompt(task: str, role: str, role_text: str, history: list[dict[str, Any]]) -> str:
    facts = "\n".join(
        f"- Step {item['step']}: {item['summary']} | 状态：{item.get('current_state','')} | 体验：{item.get('experience_note','')} | 截图：{item.get('screenshot','')}"
        for item in history
    ) or "- 无"
    return f"""
请基于真实操作日志和最终截图，输出中文体验报告。不要编造未执行步骤，不确定就写不确定。

任务：{task}
角色：{role}
角色设定：
{role_text[:1200]}

真实操作日志：
{facts}

报告要求：
1. 报告不能只写最终阻断点。即使任务未完整完成，也要覆盖已经真实体验过的每个阶段：主界面、添加源入口、源选择页、Game Capture 设置页、添加后画布效果、Go LIVE/Live info（如果到达）。
2. 尽可能多发现体验问题，但必须基于日志事实。每个问题都给标题、严重级别、问题描述、用户影响、证据截图路径、建议。
3. 重点评价新手游戏主播会不会理解：当前是否已经准备好、游戏画面是否被观众看到、默认值是否合理、错误提示是否能指导下一步、按钮/入口是否明确、等待/加载是否有反馈。
4. 至少输出 5 个候选体验问题；如果日志事实不足 5 个，说明哪些是“观察不足/需补测”，不要硬编。
5. 如果最终已经走完开播流程，体验可以结束；游戏源黑屏/捕获失败应作为问题写进报告，而不是作为继续反复修复的理由。

报告结构：
1. 用户人设与关注清单
2. 任务完成度与关键结论
3. 分阶段体验过程分析
4. 问题列表（含截图证据路径）
5. 体验亮点
6. 总体评估与 Top 3 建议
"""


def run(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    load_dotenv(root / ".env")
    run_dir = Path(args.run_dir).resolve()
    screenshots_dir = run_dir / "screenshots"
    human_signal = Path(args.human_signal).resolve() if args.human_signal else run_dir / "human.done"
    screenshots_dir.mkdir(parents=True, exist_ok=True)

    if not is_admin():
        emit("warn", "当前不是管理员权限，真实鼠标键盘操作可能失败；建议用管理员权限启动本工具")

    win = find_window(args.window_title)
    if win is None:
        emit("ask_human", f"未找到窗口：{args.window_title}，请打开 LIVE Studio")
        return 2

    role_text = Path(args.role_file).read_text(encoding="utf-8") if args.role_file and Path(args.role_file).exists() else ""
    strategy = role_strategy(args.role, args.task)
    emit("observe", strategy)

    action_log: list[dict[str, Any]] = []
    success = False
    final_img: Image.Image | None = None

    pyautogui.FAILSAFE = True
    with mss.MSS() as sct:
        for step in range(1, args.max_steps + 1):
            activate_window(win)
            img_path = screenshots_dir / f"step_{step:02d}.png"
            img, scale, sw, sh, wl, wt = grab_window(win, sct, img_path)
            final_img = img
            emit("observe", f"Step {step}: 已截图并读取屏幕", screenshot=str(img_path))

            prompt = build_step_prompt(args.task, args.role, role_text, strategy, action_log, sw, sh, args.allow_go_live)
            output_path = run_dir / f"model_step_{step:02d}.txt"
            try:
                raw = ask_provider(args, root, img, img_path, prompt, output_path)
            except Exception as exc:
                summary = f"AI 调用失败：{exc}"
                emit("ask_human", summary)
                action_log.append({"step": step, "summary": summary, "screenshot": str(img_path)})
                break
            data = extract_json_object(raw)
            if not data:
                summary = "模型返回无法解析，等待后重试"
                emit("warn", summary, raw=raw[:1000])
                action_log.append({"step": step, "summary": summary, "screenshot": str(img_path)})
                time.sleep(STEP_SLEEP_SEC)
                continue

            reason = str(data.get("reason", ""))
            current_state = str(data.get("current_state", ""))
            experience_note = str(data.get("experience_note", ""))
            emit("action", f"Step {step}: {reason}", current_state=current_state, experience_note=experience_note)

            if data.get("need_human"):
                action_log.append({"step": step, "summary": f"请求人工协助：{reason}", "current_state": current_state, "experience_note": experience_note, "screenshot": str(img_path)})
                wait_for_human_signal(human_signal, reason or "需要人工协助")
                time.sleep(STEP_SLEEP_SEC)
                continue

            if data.get("done"):
                if should_finish_require_live(args.task) and not looks_live_success(reason, current_state, experience_note):
                    summary = f"拒绝过早结束：任务要求完成开播，但当前未确认直播中/开播成功。模型理由：{reason}"
                    action_log.append({"step": step, "summary": summary, "current_state": current_state, "experience_note": experience_note, "screenshot": str(img_path)})
                    emit("warn", summary)
                    time.sleep(STEP_SLEEP_SEC)
                    continue
                success = True
                action_log.append({"step": step, "summary": f"任务完成：{reason}", "current_state": current_state, "experience_note": experience_note, "screenshot": str(img_path)})
                emit("done", reason or "任务完成")
                break

            action = data.get("action")
            if not isinstance(action, dict):
                summary = f"无可执行动作：{reason}"
                action_log.append({"step": step, "summary": summary, "current_state": current_state, "experience_note": experience_note, "screenshot": str(img_path)})
                emit("warn", summary)
                time.sleep(STEP_SLEEP_SEC)
                continue

            summary = execute_action(action, scale, wl, wt, args.window_title)
            action_log.append({"step": step, "summary": summary, "current_state": current_state, "experience_note": experience_note, "screenshot": str(img_path), "action": action})
            emit("done", summary)
            time.sleep(STEP_SLEEP_SEC)

    if final_img is None:
        emit("ask_human", "未能生成最终截图")
        return 2

    final_path = screenshots_dir / "final.png"
    final_img.save(final_path, format="PNG")
    (run_dir / "action_log.json").write_text(json.dumps(action_log, ensure_ascii=False, indent=2), encoding="utf-8")
    report_prompt = build_report_prompt(args.task, args.role, role_text, action_log)
    try:
        report_raw = ask_provider(args, root, final_img, final_path, report_prompt, run_dir / "model_report.txt")
    except Exception as exc:
        report_raw = fallback_report(args.task, args.role, action_log, f"报告生成阶段 AI 调用失败：{exc}")
    report_path = run_dir / "report.md"
    report_path.write_text(report_raw, encoding="utf-8")
    result = {"success": success, "action_log": action_log, "reportFile": str(report_path), "logDir": str(run_dir)}
    (run_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("finished", "视觉 Agent 执行结束", success=success, reportFile=str(report_path), logDir=str(run_dir))
    return 0 if success else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--role", required=True)
    parser.add_argument("--role-file", default="")
    parser.add_argument("--window-title", default="TikTok LIVE Studio")
    parser.add_argument("--max-steps", type=int, default=60)
    parser.add_argument("--allow-go-live", action="store_true")
    parser.add_argument("--provider", choices=["codex", "mimo"], default="codex")
    parser.add_argument("--codex-path", default="")
    parser.add_argument("--human-signal", default="")
    parser.add_argument("--mimo-base-url", default=DEFAULT_MIMO_BASE_URL)
    parser.add_argument("--mimo-model", default=DEFAULT_MIMO_MODEL)
    parser.add_argument("--mimo-api-key", default="")
    return parser.parse_args()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        raise SystemExit(run(parse_args()))
    except Exception as exc:
        emit("error", str(exc))
        raise SystemExit(1)
