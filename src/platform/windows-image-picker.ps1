$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.OpenFileDialog

try {
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

  $dialog.Title = ([char]0x9009).ToString() + ([char]0x62E9) + ([char]0x9879) + ([char]0x76EE) + ([char]0x5934) + ([char]0x50CF) + ([char]0x56FE) + ([char]0x7247)
  $dialog.Filter = 'Image files (*.png;*.jpg;*.jpeg;*.gif;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.webp'
  $dialog.Multiselect = $false
  $dialog.CheckFileExists = $true
  $dialog.CheckPathExists = $true
  $dialog.RestoreDirectory = $true
  $dialog.DereferenceLinks = $false

  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.FileName
  }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}
