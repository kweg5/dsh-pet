# 精灵图行动画映射验证 v2（纯内联，无自定义函数）：帧间差异 + 质心 + row1/row2 左右镜像匹配
param(
  [string]$Path = 'E:\DSHproj\plugins\dsh-pet\assets\spritesheet.webp'
)
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$uri = [Uri]::new('file://' + ($Path -replace '\\', '/'))
$bi = New-Object System.Windows.Media.Imaging.BitmapImage
$bi.BeginInit()
$bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$bi.UriSource = $uri
$bi.EndInit()
$w = $bi.PixelWidth
$h = $bi.PixelHeight
$stride = $w * 4
$buf = New-Object byte[] ($stride * $h)
$bi.CopyPixels($buf, $stride, 0)
$FRAMES = 8
$ROWS = 9
$fw = [int]($w / $FRAMES)
$fh = [int]($h / $ROWS)

Write-Host ("img: {0}x{1}, frame: {2}x{3}, grid: {4}x{5}" -f $w, $h, $fw, $fh, $FRAMES, $ROWS)

# 预取所有帧 alpha 掩码
$mask = New-Object 'object[]' ($ROWS * $FRAMES)
for ($r = 0; $r -lt $ROWS; $r++) {
  for ($f = 0; $f -lt $FRAMES; $f++) {
    $m = New-Object byte[] ($fw * $fh)
    for ($y = 0; $y -lt $fh; $y++) {
      $base = ($r * $fh + $y) * $stride + $f * $fw * 4
      for ($x = 0; $x -lt $fw; $x++) {
        if ($buf[$base + $x * 4 + 3] -gt 40) { $m[$x + $y * $fw] = 1 }
      }
    }
    $mask[$r * $FRAMES + $f] = $m
  }
}

# 1) 每行相邻帧差异率 + 质心X
Write-Host "=== 每行：相邻帧差异率 + 每帧质心X ==="
for ($r = 0; $r -lt $ROWS; $r++) {
  $diffs = @(); $cxs = @()
  for ($f = 0; $f -lt $FRAMES; $f++) {
    $m = $mask[$r * $FRAMES + $f]
    if ($f -gt 0) {
      $prev = $mask[$r * $FRAMES + ($f - 1)]
      $d = 0
      for ($i = 0; $i -lt $m.Length; $i++) { if ($m[$i] -ne $prev[$i]) { $d = $d + 1 } }
      $diffs = $diffs + [math]::Round($d / $m.Length, 3)
    }
    $sx = 0; $n = 0
    for ($i = 0; $i -lt $m.Length; $i++) {
      if ($m[$i] -eq 1) { $sx = $sx + ($i % $fw); $n = $n + 1 }
    }
    if ($n -gt 0) { $cxs = $cxs + [math]::Round($sx / $n, 1) } else { $cxs = $cxs + -1 }
  }
  Write-Host ("row{0}: diffs=[{1}]  cx=[{2}]" -f $r, ($diffs -join ','), ($cxs -join ','))
}

# 2) row1 vs flip(row2) 匹配（判断 row1/row2 是否左右镜像对）
Write-Host "=== row1 vs flip(row2) / row1 vs row2 ==="
for ($f = 0; $f -lt $FRAMES; $f++) {
  $a = $mask[1 * $FRAMES + $f]
  $b = $mask[2 * $FRAMES + $f]
  $bf = New-Object byte[] ($fw * $fh)
  for ($y = 0; $y -lt $fh; $y++) {
    for ($x = 0; $x -lt $fw; $x++) { $bf[$x + $y * $fw] = $b[($fw - 1 - $x) + $y * $fw] }
  }
  $d1 = 0; $d2 = 0
  for ($i = 0; $i -lt $a.Length; $i++) {
    if ($a[$i] -ne $bf[$i]) { $d1 = $d1 + 1 }
    if ($a[$i] -ne $b[$i]) { $d2 = $d2 + 1 }
  }
  Write-Host ("F{0}: row1 vs flip(row2) diff={1}   row1 vs row2 raw diff={2}" -f $f, [math]::Round($d1 / $a.Length, 3), [math]::Round($d2 / $a.Length, 3))
}
