$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$csharpDefinition = @'
using System;
using System.Runtime.InteropServices;

namespace UgkCockpit.Platform
{
    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    [ClassInterface(ClassInterfaceType.None)]
    internal class FileOpenDialogRCW
    {
    }

    [ComImport]
    [Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);

        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(FILEOPENDIALOGOPTIONS fos);
        void GetOptions(out FILEOPENDIALOGOPTIONS pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(SIGDN sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [Flags]
    internal enum FILEOPENDIALOGOPTIONS : uint
    {
        FOS_OVERWRITEPROMPT = 0x00000002,
        FOS_STRICTFILETYPES = 0x00000004,
        FOS_NOCHANGEDIR = 0x00000008,
        FOS_PICKFOLDERS = 0x00000020,
        FOS_FORCEFILESYSTEM = 0x00000040,
        FOS_ALLNONSTORAGEITEMS = 0x00000080,
        FOS_NOVALIDATE = 0x00000100,
        FOS_ALLOWMULTISELECT = 0x00000200,
        FOS_PATHMUSTEXIST = 0x00000800,
        FOS_FILEMUSTEXIST = 0x00001000,
        FOS_CREATEPROMPT = 0x00002000,
        FOS_SHAREAWARE = 0x00004000,
        FOS_NOREADONLYRETURN = 0x00008000,
        FOS_NOTESTFILECREATE = 0x00010000,
        FOS_HIDEMRUPLACES = 0x00020000,
        FOS_HIDEPINNEDPLACES = 0x00040000,
        FOS_NODEREFERENCELINKS = 0x00100000,
        FOS_OKBUTTONNEEDSINTERACTION = 0x00200000,
        FOS_DONTADDTORECENT = 0x02000000,
        FOS_FORCESHOWHIDDEN = 0x10000000,
        FOS_DEFAULTNOMINIMODE = 0x20000000,
        FOS_FORCEPREVIEWPANEON = 0x40000000,
        FOS_SUPPORTSTREAMABLEITEMS = 0x80000000
    }

    internal enum SIGDN : uint
    {
        SIGDN_NORMALDISPLAY = 0,
        SIGDN_PARENTRELATIVEPARSING = 0x80018001,
        SIGDN_DESKTOPABSOLUTEPARSING = 0x80028000,
        SIGDN_PARENTRELATIVEEDITING = 0x80031001,
        SIGDN_DESKTOPABSOLUTEEDITING = 0x8004c000,
        SIGDN_FILESYSPATH = 0x80058000,
        SIGDN_URL = 0x80068000,
        SIGDN_PARENTRELATIVEFORADDRESSBAR = 0x8007c001,
        SIGDN_PARENTRELATIVE = 0x80080001,
        SIGDN_PARENTRELATIVEFORUI = 0x80094001
    }

    public static class NativeFolderPicker
    {
        private static readonly Guid ClientGuid = new Guid("9684C2AC-5B7C-4C67-93C9-9A6376FD2424");
        private const int S_OK = 0;
        private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

        public const string DefaultTitle = "\u9009\u62E9\u8981\u6DFB\u52A0\u5230 UGK Cockpit \u7684\u9879\u76EE\u6587\u4EF6\u5939";
        public const string DefaultOkButtonLabel = "\u9009\u62E9\u6587\u4EF6\u5939";

        public static string Show(IntPtr ownerHwnd, string title = null, string okButtonLabel = null)
        {
            IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
            try
            {
                FILEOPENDIALOGOPTIONS options;
                dialog.GetOptions(out options);
                options |= FILEOPENDIALOGOPTIONS.FOS_PICKFOLDERS
                         | FILEOPENDIALOGOPTIONS.FOS_FORCEFILESYSTEM
                         | FILEOPENDIALOGOPTIONS.FOS_PATHMUSTEXIST;
                dialog.SetOptions(options);

                Guid clientGuid = ClientGuid;
                try
                {
                    dialog.SetClientGuid(ref clientGuid);
                }
                catch
                {
                    // Ignore if environment does not support client GUID
                }

                string dialogTitle = !string.IsNullOrEmpty(title) ? title : DefaultTitle;
                dialog.SetTitle(dialogTitle);

                string dialogOkLabel = !string.IsNullOrEmpty(okButtonLabel) ? okButtonLabel : DefaultOkButtonLabel;
                dialog.SetOkButtonLabel(dialogOkLabel);

                int hr = dialog.Show(ownerHwnd);
                if (hr == S_OK)
                {
                    IShellItem item;
                    dialog.GetResult(out item);
                    if (item != null)
                    {
                        try
                        {
                            string path;
                            item.GetDisplayName(SIGDN.SIGDN_FILESYSPATH, out path);
                            return path;
                        }
                        finally
                        {
                            Marshal.ReleaseComObject(item);
                        }
                    }
                    return null;
                }
                else if (hr == ERROR_CANCELLED)
                {
                    return null;
                }
                else
                {
                    Marshal.ThrowExceptionForHR(hr);
                    return null;
                }
            }
            finally
            {
                if (dialog != null)
                {
                    Marshal.ReleaseComObject(dialog);
                }
            }
        }
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'UgkCockpit.Platform.NativeFolderPicker').Type) {
  Add-Type -TypeDefinition $csharpDefinition
}

$owner = New-Object System.Windows.Forms.Form

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

  $selectedPath = [UgkCockpit.Platform.NativeFolderPicker]::Show($owner.Handle)
  if (![string]::IsNullOrEmpty($selectedPath)) {
    Write-Output $selectedPath
  }
} finally {
  $owner.Close()
  $owner.Dispose()
}
