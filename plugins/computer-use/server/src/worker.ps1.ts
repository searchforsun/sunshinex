/** PowerShell worker 脚本（单一事实源）：由 worker.ts 以 `-EncodedCommand`（UTF-16LE base64，不落盘）
 *  注入 powershell.exe——命令面不受执行策略约束，stdin 留给协议通道。
 *  协议：stdin 行分隔 JSON 请求 `{"id":N,"op":"…","params":{…}}` → stdout 行分隔回执
 *  `{"id":N,"ok":true,"result":{…}}` / `{"id":N,"ok":false,"error":"…"}`；stdin EOF 即干净退出（宿主 close 收口路径）。
 *  Task 18 范围：初始化（DPI 感知 P-Invoke + GDI 程序集）与 screenshot 真实现；观察/动作其余 op 由
 *  Task 19/20 在 switch 内按同一结构充实。写法钉 PS 5.1 兼容（无三元、无 ??、Where-Object 脚本块形）。
 *  约束：脚本内不得出现反引号与 `${`（本文件以 TS 模板字符串承载）、不得出现反斜杠。 */
export const WORKER_PS1 = `# sunshinex computer-use worker：持久 PowerShell 执行器（行分隔 JSON 协议，见文件头 worker.ps1.ts）
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::ErrorEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CU {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INP { public int type; public uint mi; public uint dx; public uint dy; public int wheel; public IntPtr extra; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INP[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
'@
[void][CU]::SetProcessDPIAware()

# 截图（spec §5.2 观察 op）：物理屏 orig 像素 → JPEG（质量可调），base64 随 result 回传；
# 坐标/尺寸缺省取虚拟屏全域，收缩记账（sent 尺寸）在 Node 侧单点落（server/src/scale.ts，Task 19 接线）。
function Invoke-Screenshot($P) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = [int]$vs.X; $y = [int]$vs.Y; $w = [int]$vs.Width; $h = [int]$vs.Height; $quality = 85
  if ($null -ne $P) {
    if ($null -ne $P.x) { $x = [int]$P.x }
    if ($null -ne $P.y) { $y = [int]$P.y }
    if ($null -ne $P.w) { $w = [int]$P.w }
    if ($null -ne $P.h) { $h = [int]$P.h }
    if ($null -ne $P.quality) { $quality = [int]$P.quality }
  }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h))) } finally { $g.Dispose() }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    try {
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
      $ms = New-Object System.IO.MemoryStream
      try { $bmp.Save($ms, $codec, $ep); $bytes = $ms.ToArray() } finally { $ms.Dispose() }
    } finally { $ep.Dispose() }
  } finally { $bmp.Dispose() }
  return @{ b64 = [Convert]::ToBase64String($bytes); x = $x; y = $y; w = $w; h = $h }
}

# op 分派单点：未知 op 抛错走 ok:false 回执路径（动作 op click/type/key/scroll/drag/wait/wait_for/app 随 Task 20 在此充实）
function Invoke-Op($Op, $P) {
  switch ($Op) {
    'screenshot' { return Invoke-Screenshot $P }
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
