/** PowerShell worker 脚本（单一事实源）：由 worker.ts 经环境变量 CU_WORKER_PS1（gzip+base64，不落盘）
 *  注入 powershell.exe，小引导以 -EncodedCommand 解压后 Invoke-Expression 执行——Task 20 起脚本本体
 *  超出 CreateProcess 命令行 32767 字符上限，单一 -EncodedCommand 形态退役（详见 worker.ts 头注）。
 *  协议：stdin 行分隔 JSON 请求 `{"id":N,"op":"…","params":{…}}` → stdout 行分隔回执
 *  `{"id":N,"ok":true,"result":{…}}` / `{"id":N,"ok":false,"error":"…"}`；stdin EOF 即干净退出（宿主 close 收口路径）。
 *  Task 19 范围：screenshot 补 sent 尺寸缩放输出与 cursor/foreground 采集；uia_snapshot（UIA 遍历，
 *  交互元素优先）/window_list（EnumWindows Z 序）。
 *  Task 20 范围：动作 op 九件落地——click（SetCursorPos+SendInput 按位旗标 down/up ×clicks）/type
 *  （KEYEVENTF_UNICODE 逐码元，LF 转 Enter）/key（VK 表组合键顺序按/逆序放）/scroll（mouse_event
 *  0x0800 逐刻度 ±120×amount）/drag（路径插值 SetCursorPos+左键按放）/wait（Start-Sleep）/wait_for
 *  （UIA 文本 250ms 轮询，缺省 10s，超时回 found:false 不抛）/app（launch=Start-Process、focus=轻敲
 *  Alt+SW_RESTORE+SetForegroundWindow）。SendInput 载荷修为真实 INPUT 布局（type+MOUSEINPUT/KEYBDINPUT
 *  union——x64 40 字节；旧扁平 32 字节形态会被 cbSize 校验整体拒发）。
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
  // SendInput 载荷（真实 INPUT 布局）：type + MOUSEINPUT(KI 同位 union)——cbSize 必须等于系统 sizeof(INPUT)
  // （x64 40 / x86 28），布局错会被 SendInput 整体拒发（Task 18 遗留扁平形态在此修正，随 Task 20 首次实弹）。
  // MI.data 取 int：wheelDelta 语义为有符号（负值向下），按 4 字节原位编组与 DWORD 形态等价。
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public int data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct IUNION { [FieldOffset(0)] public MI mi; [FieldOffset(0)] public KI ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INP { public uint type; public IUNION u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INP[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(ref PT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
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
  // 单事件发送封装（返回实际送达数——PS 侧不等 1 即抛）：mouse 位旗标（MOUSEEVENTF_*，type=0）/
  // vk 按下抬起（up 时 KEYEVENTF_KEYUP=2，type=1）/ unicode 码元（KEYEVENTF_UNICODE=4，抬起并 2）。
  // C# 数组元素是变量语义——跨嵌套 struct 字段链赋值合法（PS 侧有值类型拷贝坑，故封装在此）。
  public static uint SendMouseFlag(uint flags) {
    INP[] inp = new INP[1];
    inp[0].type = 0;
    inp[0].u.mi.flags = flags;
    return SendInput(1, inp, Marshal.SizeOf(typeof(INP)));
  }
  public static uint SendVk(ushort vk, bool up) {
    INP[] inp = new INP[1];
    inp[0].type = 1;
    inp[0].u.ki.vk = vk;
    if (up) { inp[0].u.ki.flags = 2; }
    return SendInput(1, inp, Marshal.SizeOf(typeof(INP)));
  }
  public static uint SendUnicode(ushort code, bool up) {
    INP[] inp = new INP[1];
    inp[0].type = 1;
    inp[0].u.ki.scan = code;
    if (up) { inp[0].u.ki.flags = 6; } else { inp[0].u.ki.flags = 4; }
    return SendInput(1, inp, Marshal.SizeOf(typeof(INP)));
  }
}
'@
[void][CU]::SetProcessDPIAware()

# 窗口标题读取（focus 匹配/window_list/前台采集共用；句柄无题或空时返回空串）
function Get-WindowTitle($h) {
  $len = [CU]::GetWindowTextLength($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder($len + 1)
  [void][CU]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

# 前台窗口标题采集（截图/window_list/wait_for 元数据面）：字段恒在，值可为空
function Get-ForegroundTitle {
  $fg = [CU]::GetForegroundWindow()
  if ($fg -eq [System.IntPtr]::Zero) { return '' }
  return Get-WindowTitle $fg
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

# ===== 动作面公共（Task 20）：SendInput 单事件封装（送达数非 1 即抛——UAC 安全桌面/输入被拦截时可见失败，不静默） =====
function Send-MouseFlag($flags) {
  $sent = [CU]::SendMouseFlag([uint32]$flags)
  if ($sent -ne 1) { throw ('SendInput mouse event blocked (sent ' + $sent + ' of 1)') }
}
function Send-Vk($vk, $up) {
  $sent = [CU]::SendVk([uint16]$vk, [bool]$up)
  if ($sent -ne 1) { throw ('SendInput key event blocked (vk=' + $vk + ', sent ' + $sent + ' of 1)') }
}
function Send-UnicodeChar($code, $up) {
  $sent = [CU]::SendUnicode([uint16]$code, [bool]$up)
  if ($sent -ne 1) { throw ('SendInput unicode event blocked (code=' + $code + ', sent ' + $sent + ' of 1)') }
}

# click（动作 op）：SetCursorPos 移动 → SendInput down/up ×clicks（同位连击由系统按双击时限自动并合识别）；
# button 位旗标（brief 钉）：left 0x0002/0x0004, right 0x0008/0x0010, middle 0x0020/0x0040。
# 坐标已是物理像素（Node 侧按 lastMeta 反算，此侧不换算）。
function Invoke-Click($P) {
  $x = [int]$P.x
  $y = [int]$P.y
  if (-not [CU]::SetCursorPos($x, $y)) { throw ('SetCursorPos failed at ' + $x + ',' + $y) }
  Start-Sleep -Milliseconds 30
  $down = [uint32]2
  $up = [uint32]4
  if ([string]$P.button -eq 'right') { $down = [uint32]8; $up = [uint32]16 }
  if ([string]$P.button -eq 'middle') { $down = [uint32]32; $up = [uint32]64 }
  $clicks = 1
  if ($null -ne $P.clicks) { $clicks = [int]$P.clicks }
  if ($clicks -lt 1) { $clicks = 1 }
  if ($clicks -gt 3) { $clicks = 3 }
  $i = 0
  while ($i -lt $clicks) {
    Send-MouseFlag $down
    Start-Sleep -Milliseconds 40
    Send-MouseFlag $up
    $i++
    if ($i -lt $clicks) { Start-Sleep -Milliseconds 60 }
  }
  return @{ x = $x; y = $y; button = [string]$P.button; clicks = $clicks }
}

# type（动作 op）：SendInput KEYEVENTF_UNICODE(0x0004) 逐码元 down/up——UTF-16 码元级下发，astral 平面
# 字符（代理对两码元）连发由应用侧合回一字符（AutoHotkey 同口径，无需 Node 侧拆字）；CR(13) 跳过（防
# CRLF 双换行），LF(10) 转 Enter 键（VK_RETURN=13，工具 schema 承诺的换行语义）；2ms 步进给目标应用
# 消息循环消化时间。
function Invoke-Type($P) {
  $text = ''
  if ($null -ne $P.text) { $text = [string]$P.text }
  $sent = 0
  foreach ($ch in $text.ToCharArray()) {
    $code = [int]$ch
    if ($code -eq 13) { continue }
    if ($code -eq 10) {
      Send-Vk 13 $false
      Start-Sleep -Milliseconds 10
      Send-Vk 13 $true
    } else {
      Send-UnicodeChar $code $false
      Start-Sleep -Milliseconds 2
      Send-UnicodeChar $code $true
    }
    $sent++
  }
  return @{ sent = $sent }
}

# key（动作 op）：VK 常量映射表（组合键：序列全按下 → 逆序全抬起）；映射缺失且单字符非字母数字 →
# ok:false 未知键（不猜键）。字母数字 VK=ASCII 大写，单字符路径兜底。
function Invoke-Key($P) {
  $names = @()
  if ($null -ne $P.keys) { $names = @($P.keys) }
  if ($names.Count -eq 0) { throw 'keys: expected at least one key name' }
  $map = New-VkMap
  $vks = New-Object System.Collections.ArrayList
  foreach ($raw in $names) {
    $n = ([string]$raw).Trim().ToLowerInvariant()
    $vk = -1
    if ($map.ContainsKey($n)) { $vk = [int]$map[$n] }
    if ($vk -lt 0 -and $n.Length -eq 1) {
      $c = [int][char]($n.ToUpperInvariant())
      if (($c -ge 48 -and $c -le 57) -or ($c -ge 65 -and $c -le 90)) { $vk = $c }
    }
    if ($vk -lt 0) { throw ('unknown key name: ' + $n) }
    [void]$vks.Add($vk)
  }
  foreach ($vk in $vks) { Send-Vk $vk $false }
  for ($i = $vks.Count - 1; $i -ge 0; $i--) { Send-Vk $vks[$i] $true }
  return @{ keys = @($names) }
}

# VK 常量表（常用键集合：修饰/方向/编辑键/F1-F12/小键盘运算/OEM 常用标点）；键名大小写不敏
# （PS 哈希表缺省）。字母数字不入表——单字符路径按 VK=ASCII 兜底；反斜杠键名受本文件无反斜杠约束不收。
function New-VkMap {
  $m = @{}
  $m['backspace'] = 8
  $m['tab'] = 9
  $m['enter'] = 13
  $m['return'] = 13
  $m['shift'] = 16
  $m['ctrl'] = 17
  $m['control'] = 17
  $m['alt'] = 18
  $m['menu'] = 18
  $m['pause'] = 19
  $m['capslock'] = 20
  $m['escape'] = 27
  $m['esc'] = 27
  $m['space'] = 32
  $m['pageup'] = 33
  $m['pgup'] = 33
  $m['pagedown'] = 34
  $m['pgdn'] = 34
  $m['end'] = 35
  $m['home'] = 36
  $m['left'] = 37
  $m['up'] = 38
  $m['right'] = 39
  $m['down'] = 40
  $m['insert'] = 45
  $m['ins'] = 45
  $m['delete'] = 46
  $m['del'] = 46
  $m['win'] = 91
  $m['meta'] = 91
  $m['apps'] = 93
  $m['f1'] = 112
  $m['f2'] = 113
  $m['f3'] = 114
  $m['f4'] = 115
  $m['f5'] = 116
  $m['f6'] = 117
  $m['f7'] = 118
  $m['f8'] = 119
  $m['f9'] = 120
  $m['f10'] = 121
  $m['f11'] = 122
  $m['f12'] = 123
  $m[';'] = 186
  $m['='] = 187
  $m[','] = 188
  $m['-'] = 189
  $m['.'] = 190
  $m['/'] = 191
  $m['['] = 219
  $m[']'] = 221
  $m["'"] = 222
  $m['multiply'] = 106
  $m['add'] = 107
  $m['subtract'] = 109
  $m['decimal'] = 110
  $m['divide'] = 111
  return $m
}

# scroll（动作 op）：mouse_event MOUSEEVENTF_WHEEL(0x0800) 逐刻度下发，wheelDelta=±120×amount
# （up 正/down 负）；可选 x/y（Node 侧反算后的物理坐标）先 SetCursorPos 定位滚动点。
function Invoke-Scroll($P) {
  $amount = 1
  if ($null -ne $P.amount) { $amount = [int]$P.amount }
  if ($amount -lt 1) { $amount = 1 }
  if ($amount -gt 50) { $amount = 50 }
  $step = 120
  if ([string]$P.direction -eq 'down') { $step = -120 }
  if ($null -ne $P.x -and $null -ne $P.y) {
    if (-not [CU]::SetCursorPos([int]$P.x, [int]$P.y)) { throw 'SetCursorPos failed before scroll' }
    Start-Sleep -Milliseconds 30
  }
  $i = 0
  while ($i -lt $amount) {
    [void][CU]::mouse_event([uint32]0x0800, 0, 0, $step, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    $i++
  }
  return @{ direction = [string]$P.direction; amount = $amount }
}

# drag（动作 op）：左键按下 → SetCursorPos 路径插值（步长 ~20 物理像素，8..150 步钳制，10ms/步给目标
# 应用拖拽消息泵时间）→ 抬起；中途 SetCursorPos 失败先抬起左键再抛（不留悬按下态）。
function Invoke-Drag($P) {
  $x1 = [int]$P.from[0]
  $y1 = [int]$P.from[1]
  $x2 = [int]$P.to[0]
  $y2 = [int]$P.to[1]
  if (-not [CU]::SetCursorPos($x1, $y1)) { throw ('SetCursorPos failed at ' + $x1 + ',' + $y1) }
  Start-Sleep -Milliseconds 80
  Send-MouseFlag 2
  Start-Sleep -Milliseconds 80
  $dist = [Math]::Abs($x2 - $x1) + [Math]::Abs($y2 - $y1)
  $steps = [int][Math]::Ceiling($dist / 20.0)
  if ($steps -lt 8) { $steps = 8 }
  if ($steps -gt 150) { $steps = 150 }
  $i = 1
  while ($i -le $steps) {
    $xi = [int][Math]::Round($x1 + ($x2 - $x1) * $i / $steps, [MidpointRounding]::AwayFromZero)
    $yi = [int][Math]::Round($y1 + ($y2 - $y1) * $i / $steps, [MidpointRounding]::AwayFromZero)
    if (-not [CU]::SetCursorPos($xi, $yi)) {
      Send-MouseFlag 4
      throw ('SetCursorPos failed mid-drag at ' + $xi + ',' + $yi)
    }
    Start-Sleep -Milliseconds 10
    $i++
  }
  Start-Sleep -Milliseconds 40
  Send-MouseFlag 4
  return @{ from = @($x1, $y1); to = @($x2, $y2); steps = $steps }
}

# wait（动作 op）：Start-Sleep（毫秒精度承载小数秒）；0..120 钳制（Node 侧已钳，此处兜底防误占串行队列）。
function Invoke-Wait($P) {
  $s = 1.0
  if ($null -ne $P.seconds) { $s = [double]$P.seconds }
  if ($s -lt 0) { $s = 0.0 }
  if ($s -gt 120) { $s = 120.0 }
  Start-Sleep -Milliseconds ([int]($s * 1000))
  return @{ slept = $s }
}

# UIA 文本在场探测（wait_for 轮询单元）：前台窗口 Descendants 扫 Name 含 target（OrdinalIgnoreCase
# 子串，对齐 schema "exact substring" 宽松面）；扫描上限 600 对齐 uia_snapshot；元素快照中途失效跳过。
function Test-UiaTextPresent($target) {
  $fg = [CU]::GetForegroundWindow()
  if ($fg -eq [System.IntPtr]::Zero) { return $false }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $scanMax = [Math]::Min($all.Count, 600)
  for ($i = 0; $i -lt $scanMax; $i++) {
    try {
      $name = $all[$i].Current.Name
      if ($null -eq $name) { continue }
      if ($name.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    } catch { continue }
  }
  return $false
}

# wait_for（动作 op）：UIA 文本轮询（250ms 步进，单请求内自旋——不占 Node 侧重试轮）；mode appear/
# disappear；timeout 缺省 10s、上限 120s。超时**不抛**：回 found:false 显式回执（Node 侧转 isError 文本
# 带 foreground 现场），模型据此换策略。
function Invoke-WaitFor($P) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $target = ''
  if ($null -ne $P.target) { $target = [string]$P.target }
  if ($target.Trim() -eq '') { throw 'target: expected non-empty text to wait for' }
  $mode = 'appear'
  if ($null -ne $P.mode) { $mode = [string]$P.mode }
  if ($mode -ne 'appear' -and $mode -ne 'disappear') { throw ('unknown mode: ' + $mode) }
  $timeout = 10.0
  if ($null -ne $P.timeout) { $timeout = [double]$P.timeout }
  if ($timeout -le 0) { $timeout = 10.0 }
  if ($timeout -gt 120) { $timeout = 120.0 }
  $start = [DateTime]::UtcNow
  $deadline = $start.AddSeconds($timeout)
  $present = $false
  while ($true) {
    $present = Test-UiaTextPresent $target
    if ($mode -eq 'appear' -and $present) { break }
    if ($mode -eq 'disappear' -and (-not $present)) { break }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  }
  $elapsed = [Math]::Round(([DateTime]::UtcNow - $start).TotalSeconds, 2)
  $found = $true
  if ($mode -eq 'appear' -and (-not $present)) { $found = $false }
  if ($mode -eq 'disappear' -and $present) { $found = $false }
  return @{ found = $found; mode = $mode; target = $target; elapsed = $elapsed; foreground = (Get-ForegroundTitle) }
}

# 按标题子串找可见顶层窗口（OrdinalIgnoreCase；EnumWindows 枚举序即 Z 序——首个命中即最顶层）。
function Find-WindowByTitle($needle) {
  foreach ($h in [CU]::TopWindows()) {
    if (-not [CU]::IsWindowVisible($h)) { continue }
    $t = Get-WindowTitle $h
    if ($t -eq '') { continue }
    if ($t.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $h }
  }
  return [System.IntPtr]::Zero
}

# app（动作 op）：launch=.NET ProcessStartInfo（UseShellExecute=true——Start-Menu 名/可执行路径/文档
# 关联打开同 ShellExecute 语义；**选型实测**：Start-Process cmdlet 在 windowsHide 子进程上下文报
# 「找不到所需的全部信息」，.NET 直启可跑通且同样回 pid）；focus=标题子串找窗 → 前台锁定规避双招
# （Alt 敲击+AttachThreadInput 借前台线程输入态 → 兜底 SwitchToThisWindow）→ 回读前台句柄验证。
function Invoke-App($P) {
  $action = [string]$P.action
  $target = ''
  if ($null -ne $P.target) { $target = [string]$P.target }
  if ($target.Trim() -eq '') { throw 'target: expected app name or executable path (launch) / window title (focus)' }
  if ($action -eq 'launch') {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $target
    $psi.UseShellExecute = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    return @{ action = 'launch'; pid = $proc.Id }
  }
  if ($action -eq 'focus') {
    $h = Find-WindowByTitle $target
    if ($h -eq [System.IntPtr]::Zero) { throw ('no visible window title contains: ' + $target) }
    # 前台锁定规避双招（回读前台句柄验证，focused 供 Node 转 isError）：
    # M1 轻敲 Alt 伪装用户输入 + AttachThreadInput 借前台线程输入态（后台进程 SetForegroundWindow
    # 需用户输入上下文——借前台线程的）+ BringWindowToTop/SetForegroundWindow；
    # M2 兜底 SwitchToThisWindow（任务栏切换同源路径，实弹 M1 被拒时它通过）。
    [void][CU]::keybd_event([byte]18, [byte]0, [uint32]0, [System.UIntPtr]::Zero)
    [void][CU]::keybd_event([byte]18, [byte]0, [uint32]2, [System.UIntPtr]::Zero)
    $fg = [CU]::GetForegroundWindow()
    $fgThread = [uint32]0
    $fgThread = [CU]::GetWindowThreadProcessId($fg, [ref]$fgThread)
    $my = [CU]::GetCurrentThreadId()
    $focusedNow = $false
    if ($fg -ne [System.IntPtr]::Zero -and $fgThread -gt 0) {
      [void][CU]::AttachThreadInput($my, $fgThread, $true)
      [void][CU]::ShowWindow($h, 9)
      [void][CU]::BringWindowToTop($h)
      [void][CU]::SetForegroundWindow($h)
      [void][CU]::AttachThreadInput($my, $fgThread, $false)
      Start-Sleep -Milliseconds 150
      if ([CU]::GetForegroundWindow() -eq $h) { $focusedNow = $true }
    }
    if (-not $focusedNow) {
      [CU]::SwitchToThisWindow($h, $true)
      [void][CU]::ShowWindow($h, 9)
      Start-Sleep -Milliseconds 200
      if ([CU]::GetForegroundWindow() -eq $h) { $focusedNow = $true }
    }
    return @{ action = 'focus'; focused = $focusedNow; title = (Get-WindowTitle $h) }
  }
  throw ('unknown action: ' + $action)
}

# op 分派单点：未知 op 抛错走 ok:false 回执路径
function Invoke-Op($Op, $P) {
  switch ($Op) {
    'screenshot' { return Invoke-Screenshot $P }
    'uia_snapshot' { return Invoke-UiaSnapshot $P }
    'window_list' { return Invoke-WindowList $P }
    'click' { return Invoke-Click $P }
    'type' { return Invoke-Type $P }
    'key' { return Invoke-Key $P }
    'scroll' { return Invoke-Scroll $P }
    'drag' { return Invoke-Drag $P }
    'wait' { return Invoke-Wait $P }
    'wait_for' { return Invoke-WaitFor $P }
    'app' { return Invoke-App $P }
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
