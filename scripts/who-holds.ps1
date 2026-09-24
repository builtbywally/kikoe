param([string]$Path)
# Asks the Windows Restart Manager which processes hold a file open.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class RM {
  [StructLayout(LayoutKind.Sequential)] struct UNIQUE_PROCESS { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct INFO {
    public UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
    public int Type; public int Status; public int Session; [MarshalAs(UnmanagedType.Bool)] public bool Restartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint n, string[] files, uint a, UNIQUE_PROCESS[] b, uint c, string[] d);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint need, ref uint n, [In, Out] INFO[] info, ref uint reasons);
  public static List<string> Who(string path) {
    var r = new List<string>(); uint h; RmStartSession(out h, 0, Guid.NewGuid().ToString());
    try {
      RmRegisterResources(h, 1, new[] { path }, 0, null, 0, null);
      uint need = 0, n = 0, why = 0; RmGetList(h, out need, ref n, null, ref why);
      var info = new INFO[need]; n = need;
      if (need > 0 && RmGetList(h, out need, ref n, info, ref why) == 0)
        for (int i = 0; i < n; i++) r.Add(info[i].Process.pid + " " + info[i].AppName + " " + info[i].Service);
    } finally { RmEndSession(h); }
    return r;
  }
}
"@
foreach ($line in [RM]::Who($Path)) {
  $procId = [int]($line.Split(' ')[0])
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  "$line | $($p.Path)"
  try { "  command line: " + (Get-CimInstance Win32_Process -Filter "ProcessId=$procId").CommandLine } catch {}
}
