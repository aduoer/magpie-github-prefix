# 手动重启 magpie。页面上那个「重启 magpie」按钮做的是同一件事，这里是把同一套动作做成双击版：
# 页面被 magpie 判成「此页面已停止工作」时按钮点不了，就双击同目录的 restart-magpie.cmd。
$ErrorActionPreference = "SilentlyContinue"

$exe = (Get-Command magpie-windows-amd64.exe -ErrorAction SilentlyContinue).Source
if (-not $exe) { $exe = "D:ProgrammingTOOLmagpie-windows-amd64.exe" }
$plugin = $PSScriptRoot

# 前缀只有一份真源：注册表里的用户环境变量。少了这一行，新开的 magpie 还是读旧前缀。
$env:MAGPIE_MIRRORS       = [Environment]::GetEnvironmentVariable("MAGPIE_MIRRORS", "User")
$env:MAGPIE_GITHUB_MIRROR = [Environment]::GetEnvironmentVariable("MAGPIE_GITHUB_MIRROR", "User")
Write-Host ("前缀 = " + $env:MAGPIE_GITHUB_MIRROR)

$gui = Get-Process magpie-windows-amd64 -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($gui) {
  Write-Host ("关掉 magpie（pid " + $gui.Id + "）…")
  & taskkill /PID $gui.Id /T /F | Out-Null
  Start-Sleep -Milliseconds 1500
}
Write-Host "重新打开…"
Start-Process -FilePath $exe
Start-Sleep -Seconds 5
& $exe plugin on $plugin | Out-Null
Write-Host "完成：插件已重新登记。回到 magpie 的「GitHub 镜像」页，点一次「重试」就好。"
Start-Sleep -Seconds 3
