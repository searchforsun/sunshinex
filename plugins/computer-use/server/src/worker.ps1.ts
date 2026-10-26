/** PowerShell worker 脚本（单一事实源）：由 worker.ts 以 `-EncodedCommand`（UTF-16LE base64，不落盘）
 *  注入 powershell.exe——命令面不受执行策略约束，stdin 留给协议通道。
 *  协议：stdin 行分隔 JSON 请求 `{"id":N,"op":"…","params":{…}}` → stdout 行分隔回执
 *  `{"id":N,"ok":true,"result":{…}}` / `{"id":N,"ok":false,"error":"…"}`；stdin EOF 即干净退出（宿主 close 收口路径）。
 *  Task 19 范围：screenshot 补 sent 尺寸缩放输出与 cursor/foreground 采集；uia_snapshot（UIA 遍历，
 *  交互元素优先）/window_list（EnumWindows Z 序）新增；动作 op 由 Task 20 在 switch 内按同一结构充实。
 *  写法钉 PS 5.1 兼容（无三元、无 ??、Where-Object 脚本块形）；约束：脚本内不得出现反引号与 `${`
 *  （本文件以 TS 模板字符串承载）、不得出现反斜杠。 */
export const WORKER_PS1 = `# sunshinex computer-use worker：持久 PowerShell 执行器（行分隔 JSON 协议，见文件头 worker.ps1.ts）
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::ErrorEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CU {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INP { public int type; public uint mi; public uint dx; public uint dy; public int wheel; public IntPtr extra; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INP[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(ref PT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  // 顶层窗口句柄清单：EnumWindows 枚举序即 Z 序（顶在前）；可见性/标题过滤在 PS 侧做（C# 面保持最小）
  public static List<IntPtr> TopWindows() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
[void][CU]::SetProcessDPIAware()

# 前台窗口标题采集（截图/window_list 元数据面）：句柄无题或空时返回空串（字段恒在，值可为空）
function Get-ForegroundTitle {
  $fg = [CU]::GetForegroundWindow()
  if ($fg -eq [System.IntPtr]::Zero) { return '' }
  $len = [CU]::GetWindowTextLength($fg)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder($len + 1)
  [void][CU]::GetWindowText($fg, $sb, $sb.Capacity)
  return $sb.ToString()
}

# 截图（spec §5.2 观察 op）：CopyFromScreen 截物理屏 orig 图 → 按 sent 尺寸缩放输出（缩放置账：目标
# sent 尺寸由 Node 侧 shrinkToEdge 预算随参数下发——region 路径；全域路径无几何入参，由本侧按同规则
# （长边 1568 封顶只缩不放大）自算）→ JPEG（质量可调）base64 随 result 回传；实际记账（物理 w/h +
# sentW/sentH 回声）与 cursor/foreground 一并回传，Node 侧置 lastMeta（server/src/dispatch.ts）。
function Invoke-Screenshot($P) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = [int]$vs.X; $y = [int]$vs.Y; $w = [int]$vs.Width; $h = [int]$vs.Height; $quality = 85
  $sentW = 0; $sentH = 0
  if ($null -ne $P) {
    if ($null -ne $P.x) { $x = [int]$P.x }
    if ($null -ne $P.y) { $y = [int]$P.y }
    if ($null -ne $P.w) { $w = [int]$P.w }
    if ($null -ne $P.h) { $h = [int]$P.h }
    if ($null -ne $P.sentW) { $sentW = [int]$P.sentW }
    if ($null -ne $P.sentH) { $sentH = [int]$P.sentH }
    if ($null -ne $P.quality) { $quality = [int]$P.quality }
  }
  if ($sentW -le 0 -or $sentH -le 0) {
    $s = [Math]::Min(1.0, 1568.0 / [Math]::Max($w, $h))
    $sentW = [int][Math]::Max(1, [Math]::Round($w * $s, [MidpointRounding]::AwayFromZero))
    $sentH = [int][Math]::Max(1, [Math]::Round($h * $s, [MidpointRounding]::AwayFromZero))
  }
  $src = New-Object System.Drawing.Bitmap($w, $h)
  try {
    $g = [System.Drawing.Graphics]::FromImage($src)
    try { $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h))) } finally { $g.Dispose() }
    $out = $src
    if ($sentW -ne $w -or $sentH -ne $h) { $out = New-Object System.Drawing.Bitmap([System.Drawing.Image]$src, $sentW, $sentH) }
    try {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      try {
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
        $ms = New-Object System.IO.MemoryStream
        try { $out.Save($ms, $codec, $ep); $bytes = $ms.ToArray() } finally { $ms.Dispose() }
      } finally { $ep.Dispose() }
    } finally {
      if (-not [object]::ReferenceEquals($out, $src)) { $out.Dispose() }
    }
  } finally { $src.Dispose() }
  $pt = New-Object CU+PT
  [void][CU]::GetCursorPos([ref]$pt)
  return @{ b64 = [Convert]::ToBase64String($bytes); x = $x; y = $y; w = $w; h = $h; sentW = $sentW; sentH = $sentH; cursor = @{ x = $pt.X; y = $pt.Y }; foreground = Get-ForegroundTitle }
}

# UIA 观察快照（spec §5.2）：scope=window → 前台窗口子树（Descendants）；scope=desktop → 根元素直接
# 子层（顶层元素概览，与工具 schema 描述一致）。装配懒加载（UIA 不可用时报 ok:false，截图/窗口面不受累）。
# 交互元素优先排序后 1..N 编号成行：[N] ControlType 'Name' (x,y,WxH) enabled|disabled；扫描上限 600 防
# 巨树（浏览器整 UIA 树）拖死 worker，交互/其他两列各收 300（Node 侧再统一截 300）。
function Invoke-UiaSnapshot($P) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $scope = 'window'
  if ($null -ne $P -and $null -ne $P.scope) { $scope = [string]$P.scope }
  if ($scope -eq 'desktop') {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  } else {
    $fg = [CU]::GetForegroundWindow()
    if ($fg -eq [System.IntPtr]::Zero) { throw 'no foreground window' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  }
  $interactiveTypes = @('Button','Edit','ComboBox','CheckBox','RadioButton','Hyperlink','MenuItem','ListItem','TabItem','TreeItem','Slider','Spinner','SplitButton','Document','List','Table','Tab')
  $hits = New-Object System.Collections.ArrayList
  $others = New-Object System.Collections.ArrayList
  $scanMax = [Math]::Min($all.Count, 600)
  for ($i = 0; $i -lt $scanMax; $i++) {
    try {
      $c = $all[$i].Current
      $ct = 'Unknown'
      if ($null -ne $c.ControlType) { $ct = $c.ControlType.ProgrammaticName.Replace('ControlType.', '') }
      $name = $c.Name
      if ($null -eq $name) { $name = '' }
      if ($name.Length -gt 80) { $name = $name.Substring(0, 80) }
      $name = $name.Replace("'", "''")
      $r = $c.BoundingRectangle
      $rect = '(no rect)'
      if (-not $r.IsEmpty) { $rect = '({0},{1},{2}x{3})' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }
      $state = 'disabled'
      if ($c.IsEnabled) { $state = 'enabled' }
      $line = '{0} {1} {2} {3}' -f $ct, ("'" + $name + "'"), $rect, $state
      if ($interactiveTypes.Contains($ct)) {
        if ($hits.Count -lt 300) { [void]$hits.Add($line) }
      } else {
        if ($others.Count -lt 300) { [void]$others.Add($line) }
      }
      if ($hits.Count -ge 300 -and $others.Count -ge 300) { break }
    } catch { continue } # 元素快照中途失效（窗口切换/元素消亡）——跳过不废整单
  }
  $lines = New-Object System.Collections.ArrayList
  $n = 0
  foreach ($line in $hits) { $n++; [void]$lines.Add(('[{0}] {1}' -f $n, $line)) }
  foreach ($line in $others) { $n++; [void]$lines.Add(('[{0}] {1}' -f $n, $line)) }
  return @{ lines = $lines }
}

# 顶层窗口清单（spec §5.2）：选型 EnumWindows P-Invoke（非 Process.GetProcesses 过滤 MainWindowTitle
# ——后者无 Z 序且大量进程 MainWindowTitle 为空）；EnumWindows 枚举序即 Z 序（顶在前），行内附前台标记。
function Invoke-WindowList {
  $fg = [CU]::GetForegroundWindow()
  $lines = New-Object System.Collections.ArrayList
  $n = 0
  foreach ($h in [CU]::TopWindows()) {
    if (-not [CU]::IsWindowVisible($h)) { continue }
    $len = [CU]::GetWindowTextLength($h)
    if ($len -le 0) { continue }
    $sb = New-Object System.Text.StringBuilder($len + 1)
    [void][CU]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString().Replace("'", "''")
    if ($title.Length -gt 100) { $title = $title.Substring(0, 100) }
    $procId = [uint32]0
    [void][CU]::GetWindowThreadProcessId($h, [ref]$procId)
    $n++
    $mark = ''
    if ($h -eq $fg) { $mark = ' foreground' }
    [void]$lines.Add(('[{0}] {1} pid={2}{3}' -f $n, ("'" + $title + "'"), $procId, $mark))
  }
  return @{ lines = $lines }
}

# op 分派单点：未知 op 抛错走 ok:false 回执路径（动作 op click/type/key/scroll/drag/wait/wait_for/app 随 Task 20 在此充实）
function Invoke-Op($Op, $P) {
  switch ($Op) {
    'screenshot' { return Invoke-Screenshot $P }
    'uia_snapshot' { return Invoke-UiaSnapshot $P }
    'window_list' { return Invoke-WindowList $P }
    default { throw "unknown op: $Op" }
  }
}

# 主循环：按行读请求 → 分派 → 单行 JSON 回执；坏行/异常不退出（回 ok:false），stdin EOF 收口
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $r = Invoke-Op $req.op $req.params
    # PS 5.1 口径：.NET 方法调用不能作管道后段（ExpressionsMustBeFirstInPipeline）——先落变量再 WriteLine
    $json = @{ id = $req.id; ok = $true; result = $r } | ConvertTo-Json -Compress -Depth 5
    [Console]::Out.WriteLine($json)
  } catch {
    $id = $null
    if ($null -ne $req) { $id = $req.id }
    $json = @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 5
    [Console]::Out.WriteLine($json)
  }
  [void][Console]::Out.Flush()
}
`;
