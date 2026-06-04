param(
  [switch]$Click,
  [string]$OutDir = ".rpa_tmp"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$compilerParameters = New-Object System.CodeDom.Compiler.CompilerParameters
$compilerParameters.CompilerOptions = "/unsafe"
$compilerParameters.ReferencedAssemblies.Add("System.Drawing.dll") | Out-Null
$typeDefinition = @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class RpaWin32 {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(500);
        mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(80);
        mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    }
}

public class PinkComponent {
    public int count;
    public int minX;
    public int minY;
    public int maxX;
    public int maxY;
    public int width;
    public int height;
    public int centerX;
    public int centerY;
}

public class PinkFinder {
    static bool IsPink(byte r, byte g, byte b) {
        return r >= 210 && g <= 90 && b >= 90 && b <= 200 && (r - g) >= 120;
    }

    public static PinkComponent[] Find(string path) {
        using (Bitmap original = new Bitmap(path)) {
            using (Bitmap bmp = new Bitmap(original.Width, original.Height, PixelFormat.Format32bppArgb)) {
                using (Graphics g = Graphics.FromImage(bmp)) {
                    g.DrawImage(original, 0, 0, original.Width, original.Height);
                }

                int width = bmp.Width;
                int height = bmp.Height;
                Rectangle rect = new Rectangle(0, 0, width, height);
                BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try {
                    int stride = data.Stride;
                    int step = 2;
                    int gridW = (width + step - 1) / step;
                    int gridH = (height + step - 1) / step;
                    bool[] pink = new bool[gridW * gridH];
                    unsafe {
                        byte* ptr = (byte*)data.Scan0;
                        for (int gy = 0; gy < gridH; gy++) {
                            int y = gy * step;
                            byte* row = ptr + y * stride;
                            for (int gx = 0; gx < gridW; gx++) {
                                int x = gx * step;
                                byte* px = row + x * 4;
                                byte b = px[0], g = px[1], r = px[2];
                                pink[gy * gridW + gx] = IsPink(r, g, b);
                            }
                        }
                    }

                    bool[] visited = new bool[pink.Length];
                    List<PinkComponent> comps = new List<PinkComponent>();
                    int[] dx = new int[] { 1, -1, 0, 0 };
                    int[] dy = new int[] { 0, 0, 1, -1 };
                    List<int> q = new List<int>();

                    for (int gy = 0; gy < gridH; gy++) {
                        for (int gx = 0; gx < gridW; gx++) {
                            int idx = gy * gridW + gx;
                            if (visited[idx] || !pink[idx]) continue;
                            visited[idx] = true;
                            q.Add(idx);
                            int count = 0, minGX = gx, maxGX = gx, minGY = gy, maxGY = gy;
                            long sumGX = 0, sumGY = 0;
                            int qIndex = 0;
                            while (qIndex < q.Count) {
                                int cur = q[qIndex++];
                                int cy = cur / gridW;
                                int cx = cur - cy * gridW;
                                count++;
                                sumGX += cx;
                                sumGY += cy;
                                if (cx < minGX) minGX = cx;
                                if (cx > maxGX) maxGX = cx;
                                if (cy < minGY) minGY = cy;
                                if (cy > maxGY) maxGY = cy;
                                for (int k = 0; k < 4; k++) {
                                    int nx = cx + dx[k], ny = cy + dy[k];
                                    if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
                                    int nidx = ny * gridW + nx;
                                    if (visited[nidx] || !pink[nidx]) continue;
                                    visited[nidx] = true;
                                    q.Add(nidx);
                                }
                            }

                            int boxW = (maxGX - minGX + 1) * step;
                            int boxH = (maxGY - minGY + 1) * step;
                            if (count > 250 && boxW > 70 && boxH > 20) {
                                PinkComponent c = new PinkComponent();
                                c.count = count;
                                c.minX = minGX * step;
                                c.minY = minGY * step;
                                c.maxX = Math.Min(width - 1, (maxGX + 1) * step);
                                c.maxY = Math.Min(height - 1, (maxGY + 1) * step);
                                c.width = boxW;
                                c.height = boxH;
                                c.centerX = (int)Math.Round((double)sumGX / count * step);
                                c.centerY = (int)Math.Round((double)sumGY / count * step);
                                comps.Add(c);
                            }
                        }
                    }
                    comps.Sort((a,b) => b.count.CompareTo(a.count));
                    if (comps.Count > 5) comps = comps.GetRange(0, 5);
                    return comps.ToArray();
                } finally {
                    bmp.UnlockBits(data);
                }
            }
        }
    }
}
"@
Add-Type -TypeDefinition $typeDefinition -CompilerParameters $compilerParameters

[RpaWin32]::SetProcessDPIAware() | Out-Null

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Capture-Screen([string]$Path) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  return @{ width = $bounds.Width; height = $bounds.Height }
}

function Find-PinkButton([string]$Path) {
  return [PinkFinder]::Find($Path)
}

function Save-Crop([string]$Source, [object]$Candidate, [string]$Path) {
  $img = [System.Drawing.Bitmap]::new($Source)
  try {
    $x = [Math]::Max(0, [int]$Candidate.centerX - 140)
    $y = [Math]::Max(0, [int]$Candidate.centerY - 50)
    $w = [Math]::Min(280, $img.Width - $x)
    $h = [Math]::Min(100, $img.Height - $y)
    $rect = [System.Drawing.Rectangle]::new($x, $y, $w, $h)
    $crop = $img.Clone($rect, $img.PixelFormat)
    $crop.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $crop.Dispose()
  } finally {
    $img.Dispose()
  }
}

$before = Join-Path $OutDir "before.png"
$screen = Capture-Screen $before
$candidates = @(Find-PinkButton $before)
if ($candidates.Count -eq 0) {
  [pscustomobject]@{
    ok = $false
    reason = "pink_button_not_found"
    screenshot = (Resolve-Path $before).Path
    screen = $screen
  } | ConvertTo-Json -Depth 5
  exit 2
}

$best = $candidates[0]
$cropPath = Join-Path $OutDir "verify_crop.png"
Save-Crop $before $best $cropPath

$clicked = $false
if ($Click) {
  [RpaWin32]::SetCursorPos([int]$best.centerX, [int]$best.centerY) | Out-Null
  Start-Sleep -Milliseconds 500
  [RpaWin32]::Click([int]$best.centerX, [int]$best.centerY)
  $clicked = $true
  Start-Sleep -Milliseconds 3000
}

$after = Join-Path $OutDir "after.png"
Capture-Screen $after | Out-Null

[pscustomobject]@{
  ok = $true
  clicked = $clicked
  screen = $screen
  candidate = $best
  allCandidates = $candidates
  before = (Resolve-Path $before).Path
  crop = (Resolve-Path $cropPath).Path
  after = (Resolve-Path $after).Path
} | ConvertTo-Json -Depth 8
