import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const encode = command => Buffer.from(command, 'utf16le').toString('base64')
const quote = value => `'${value.replaceAll("'", "''")}'`

/** 只运行固定的本机取令牌动作，不接受网页传入的路径或命令。 */
export async function openLoginTerminal(dataDir) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('自动打开 PowerShell 仅支持 Windows，请按页面说明手动获取令牌。'), { statusCode: 400 })
  }
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const keyFile = path.join(dataDir, 'settings.json')
  const command = [
    "$Host.UI.RawUI.WindowTitle = 'Our Free Model - 获取登录令牌'",
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $ofmLoginKey = (Get-Content -LiteralPath ${quote(keyFile)} -Raw -Encoding UTF8 | ConvertFrom-Json).forwardKey`,
    "  if ([string]::IsNullOrWhiteSpace($ofmLoginKey)) { throw '配置文件没有登录令牌' }",
    '  Set-Clipboard -Value $ofmLoginKey',
    '  $ofmLoginKey = $null',
    "  Write-Host '登录令牌已复制。回到网页，粘贴到登录令牌输入框即可。' -ForegroundColor Green",
    "  Write-Host '完成后可以关闭此窗口，请勿向他人分享令牌。'",
    "} catch { Write-Host '获取令牌失败，请检查本地 settings.json 或使用页面的手动入口。' -ForegroundColor Red }",
  ].join('\n')
  const launch = `Start-Process -FilePath ${quote(powershell)} -WindowStyle Normal -ArgumentList '-NoProfile -STA -NoExit -EncodedCommand ${encode(command)}' -ErrorAction Stop`
  await runFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(launch)], {
    windowsHide: true, timeout: 10000,
  })
}
