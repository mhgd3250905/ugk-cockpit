$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog

try {
  # A visible, top-most owner keeps the native dialog in front of the browser.
  # The owner itself is effectively invisible and never appears in the taskbar.
  $owner.Text = 'UGK Cockpit'
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.ClientSize = New-Object System.Drawing.Size(1, 1)
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
  $owner.Opacity = 0.01
  $owner.TopMost = $true
  $owner.Show()
  $owner.Activate()
  $owner.BringToFront()
  [System.Windows.Forms.Application]::DoEvents()

  $dialog.Description = '选择要添加到 UGK Cockpit 的项目文件夹'
  $dialog.ShowNewFolderButton = $false
  $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer

  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
  }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}
