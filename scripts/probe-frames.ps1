# 逐帧分析 spritesheet.webp：统计每帧 alpha>0 与 alpha>40 的像素数
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
Write-Host ("frame: {0}x{1}, img: {2}x{3}" -f $fw, $fh, $w, $h)
$all = @()
for ($r = 0; $r -lt $ROWS; $r++) {
  $cells = @()
  for ($f = 0; $f -lt $FRAMES; $f++) {
    $alphaPx = 0; $solidPx = 0; $inkPx = 0
    for ($y = $r * $fh; $y -lt ($r + 1) * $fh; $y++) {
      $base = $y * $stride + $f * $fw * 4
      for ($x = 0; $x -lt $fw; $x++) {
        $idx = $base + $x * 4
        $b = $buf[$idx]; $g = $buf[$idx + 1]; $rch = $buf[$idx + 2]; $a = $buf[$idx + 3]
        if ($a -gt 0) {
          $alphaPx++
          if ($a -gt 40) {
            $solidPx++
            $lum = (0.114 * $b + 0.587 * $g + 0.299 * $rch)
            if ($lum -lt 250) { $inkPx++ }
          }
        }
      }
    }
    $cells += ("F{0}:a{1}s{2}i{3}" -f $f, $alphaPx, $solidPx, $inkPx)
  }
  Write-Host ("row{0}: {1}" -f $r, ($cells -join ' '))
}
