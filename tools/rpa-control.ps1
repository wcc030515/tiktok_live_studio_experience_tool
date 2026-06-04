param(
  [string]$Mode = "capture",
  [string]$OutDir = ".rpa_tmp",
  [string]$ActionJson = "",
  [string]$WindowTitle = "TikTok LIVE Studio",
  [string]$TargetProcess = "TikTok LIVE Studio"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

$typeDefinition = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class RpaNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const int SW_RESTORE = 9;
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(180);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
  public static void Wheel(int delta) {
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, IntPtr.Zero);
  }
}

public class TaskbarRedFinder {
  static bool IsIconRed(byte r, byte g, byte b) {
    return r >= 190 && g <= 90 && b <= 120 && (r - g) >= 120 && (r - b) >= 80;
  }

  public static int[] Find(string path) {
    using (Bitmap original = new Bitmap(path)) {
      using (Bitmap bmp = new Bitmap(original.Width, original.Height, PixelFormat.Format32bppArgb)) {
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.DrawImage(original, 0, 0, original.Width, original.Height);
        }

        int width = bmp.Width;
        int height = bmp.Height;
        int minY = Math.Max(0, height - 130);
        Rectangle rect = new Rectangle(0, minY, width, height - minY);
        BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
          int stride = data.Stride;
          int step = 2;
          int gridW = (width + step - 1) / step;
          int gridH = ((height - minY) + step - 1) / step;
          bool[] red = new bool[gridW * gridH];
          unsafe {
            byte* ptr = (byte*)data.Scan0;
            for (int gy = 0; gy < gridH; gy++) {
              int y = gy * step;
              byte* row = ptr + y * stride;
              for (int gx = 0; gx < gridW; gx++) {
                int x = gx * step;
                byte* px = row + x * 4;
                red[gy * gridW + gx] = IsIconRed(px[2], px[1], px[0]);
              }
            }
          }

          bool[] visited = new bool[red.Length];
          int[] q = new int[red.Length];
          int bestCount = 0, bestMinGX = 0, bestMaxGX = 0, bestMinGY = 0, bestMaxGY = 0;
          int[] dx = new int[] { 1, -1, 0, 0 };
          int[] dy = new int[] { 0, 0, 1, -1 };
          for (int gy = 0; gy < gridH; gy++) {
            for (int gx = 0; gx < gridW; gx++) {
              int idx = gy * gridW + gx;
              if (visited[idx] || !red[idx]) continue;
              visited[idx] = true;
              int head = 0, tail = 0;
              q[tail++] = idx;
              int count = 0, minGX = gx, maxGX = gx, minGY = gy, maxGY = gy;
              while (head < tail) {
                int cur = q[head++];
                int cy = cur / gridW;
                int cx = cur - cy * gridW;
                count++;
                if (cx < minGX) minGX = cx;
                if (cx > maxGX) maxGX = cx;
                if (cy < minGY) minGY = cy;
                if (cy > maxGY) maxGY = cy;
                for (int k = 0; k < 4; k++) {
                  int nx = cx + dx[k], ny = cy + dy[k];
                  if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
                  int nidx = ny * gridW + nx;
                  if (visited[nidx] || !red[nidx]) continue;
                  visited[nidx] = true;
                  q[tail++] = nidx;
                }
              }
              int boxW = (maxGX - minGX + 1) * step;
              int boxH = (maxGY - minGY + 1) * step;
              if (count > bestCount && count >= 80 && boxW >= 12 && boxW <= 90 && boxH >= 12 && boxH <= 90) {
                bestCount = count;
                bestMinGX = minGX;
                bestMaxGX = maxGX;
                bestMinGY = minGY;
                bestMaxGY = maxGY;
              }
            }
          }
          if (bestCount == 0) return new int[] { -1, -1, 0 };
          int centerX = ((bestMinGX + bestMaxGX + 1) * step) / 2;
          int centerY = minY + ((bestMinGY + bestMaxGY + 1) * step) / 2;
          return new int[] { centerX, centerY, bestCount };
        } finally {
          bmp.UnlockBits(data);
        }
      }
    }
  }
}
"@

$compilerParameters = New-Object System.CodeDom.Compiler.CompilerParameters
$compilerParameters.CompilerOptions = "/unsafe"
$compilerParameters.ReferencedAssemblies.Add("System.Drawing.dll") | Out-Null
Add-Type -TypeDefinition $typeDefinition -CompilerParameters $compilerParameters
[RpaNative]::SetProcessDPIAware() | Out-Null

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$script:TargetPid = 0

function Test-ForegroundTarget {
  if (-not $script:TargetPid) {
    return $false
  }
  [uint32]$foregroundPid = 0
  $foregroundHandle = [RpaNative]::GetForegroundWindow()
  [RpaNative]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid) | Out-Null
  return ([int]$foregroundPid -eq [int]$script:TargetPid)
}

function Focus-Window {
  param([string]$Title, [string]$ProcName)
  $proc = $null
  if ($ProcName) {
    $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "*$ProcName*" } | Select-Object -First 1
  }
  if (-not $proc -and $Title) {
    $proc = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 `
        -and $_.MainWindowTitle -like "*$Title*" `
        -and $_.ProcessName -notin @("chrome", "msedge", "firefox", "electron", "Code", "WindowsTerminal")
    } | Select-Object -First 1
  }
  if (-not $proc -and $Title -like "*Live Studio*") {
    $proc = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 `
        -and ($_.ProcessName -like "*TikTok*" -or $_.MainWindowTitle -like "*Live Studio*") `
        -and $_.ProcessName -notin @("chrome", "msedge", "firefox", "electron", "Code", "WindowsTerminal")
    } | Select-Object -First 1
  }
  if (-not $proc) {
    return $false
  }
  $script:TargetPid = [int]$proc.Id
  [RpaNative]::ShowWindow($proc.MainWindowHandle, [RpaNative]::SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds 200
  try {
    [Microsoft.VisualBasic.Interaction]::AppActivate([int]$proc.Id) | Out-Null
  } catch {}
  Start-Sleep -Milliseconds 250
  [RpaNative]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 500
  if (Test-ForegroundTarget) {
    return $true
  }

  if ($ProcName -like "*TikTok*" -or $Title -like "*Live Studio*") {
    $tempShot = Join-Path $OutDir "focus_taskbar_probe.png"
    Capture-Screen $tempShot | Out-Null
    $icon = [TaskbarRedFinder]::Find((Resolve-Path $tempShot).Path)
    if ($icon[0] -ge 0) {
      [RpaNative]::Click([int]$icon[0], [int]$icon[1])
      Start-Sleep -Milliseconds 900
      if (Test-ForegroundTarget) {
        return $true
      }
    }
  }

  return $false
}

function Capture-Screen {
  param([string]$Path)
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  return @{ width = $bounds.Width; height = $bounds.Height; path = (Resolve-Path $Path).Path }
}

function Send-Key {
  param([string]$Key)
  [System.Windows.Forms.SendKeys]::SendWait($Key)
}

function Invoke-Action {
  param([object]$Action)
  switch ($Action.action) {
    "click" {
      [RpaNative]::Click([int]$Action.x, [int]$Action.y)
      return "clicked"
    }
    "double_click" {
      [RpaNative]::Click([int]$Action.x, [int]$Action.y)
      Start-Sleep -Milliseconds 120
      [RpaNative]::Click([int]$Action.x, [int]$Action.y)
      return "double_clicked"
    }
    "type_text" {
      Set-Clipboard -Value ([string]$Action.text)
      Send-Key "^v"
      return "typed_text"
    }
    "press_key" {
      Send-Key ([string]$Action.key)
      return "pressed_key"
    }
    "hotkey" {
      Send-Key ([string]$Action.key)
      return "pressed_hotkey"
    }
    "scroll" {
      $delta = -720
      if ($Action.y -ne $null) { $delta = [int]$Action.y }
      [RpaNative]::Wheel($delta)
      return "scrolled"
    }
    "wait" {
      $ms = 1500
      if ($Action.wait_ms -ne $null) { $ms = [int]$Action.wait_ms }
      Start-Sleep -Milliseconds $ms
      return "waited"
    }
    "launch_app" {
      if (-not $Action.app) { throw "launch_app requires app" }
      Start-Process -FilePath ([string]$Action.app)
      return "launched_app"
    }
    "focus_window" {
      $ok = Focus-Window -Title ([string]$Action.target) -ProcName ([string]$Action.app)
      if (-not $ok) { throw "target window not found" }
      return "focused_window"
    }
    default {
      return "noop"
    }
  }
}

try {
  $focusedBefore = Focus-Window -Title $WindowTitle -ProcName $TargetProcess
  if ($Mode -eq "act") {
    if (-not $ActionJson) { throw "ActionJson is required in act mode" }
    $action = $ActionJson | ConvertFrom-Json
    $result = Invoke-Action -Action $action
    Start-Sleep -Milliseconds 800
  } else {
    $result = "captured"
  }
  $focusedAfter = Test-ForegroundTarget

  $shotPath = Join-Path $OutDir ("screen_" + (Get-Date -Format "yyyyMMdd_HHmmss_fff") + ".png")
  $screen = Capture-Screen $shotPath
  [pscustomobject]@{
    ok = $true
    mode = $Mode
    result = $result
    focused = $focusedAfter
    focusedBefore = $focusedBefore
    targetPid = $script:TargetPid
    screenshot = $screen.path
    screen = @{ width = $screen.width; height = $screen.height }
  } | ConvertTo-Json -Depth 8
} catch {
  [pscustomobject]@{
    ok = $false
    mode = $Mode
    error = $_.Exception.Message
  } | ConvertTo-Json -Depth 8
  exit 2
}
