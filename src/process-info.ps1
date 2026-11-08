param([Parameter(Mandatory = $true)][int]$RootPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
# ConPTY has no foreground group. Observe native descendants instead of trusting
# cached startup metadata. Like hc, read the live 64-bit PEB; fail closed for WOW64.
if (-not ('TeleportNativeProcesses' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class TeleportNativeProcesses {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInfo { public IntPtr ExitStatus, Peb, Affinity, Priority, Pid, Parent; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
        public uint Size, Usage, Pid;
        public UIntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Image;
    }
    public class ProcessInfo { public int pid; public string cwd; public string[] argv; }
    public class Observation {
        public int shell_pid;
        public bool shell_owns_foreground;
        public ProcessInfo[] foreground_processes;
    }
    class Identity { public ulong Born; public ProcessInfo Info; public bool ConsoleHost; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr process, out bool wow64);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr at, byte[] into, UIntPtr length, out UIntPtr read);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long born, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern int GetCurrentProcessId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetSystemDirectoryW(StringBuilder path, uint length);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, out BasicInfo info, int size, out int written);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string line, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    static byte[] Read(IntPtr process, long at, int length) {
        if (at <= 0 || length < 0 || length > 65536) throw new InvalidOperationException("Invalid native process buffer.");
        var bytes = new byte[length]; UIntPtr count;
        if (!ReadProcessMemory(process, new IntPtr(at), bytes, new UIntPtr((uint)length), out count) || count.ToUInt64() != (ulong)length)
            throw new InvalidOperationException("Native process memory is unavailable.");
        return bytes;
    }
    static string Text(IntPtr process, byte[] descriptor) {
        int length = BitConverter.ToUInt16(descriptor, 0), capacity = BitConverter.ToUInt16(descriptor, 2);
        if (length == 0 || (length & 1) != 0 || length > capacity) throw new InvalidOperationException("Invalid native Unicode string.");
        return new UnicodeEncoding(false, false, true).GetString(Read(process, BitConverter.ToInt64(descriptor, 8), length));
    }
    static ulong Birth(IntPtr process) {
        long born, exit, kernel, user; uint status;
        if (!GetProcessTimes(process, out born, out exit, out kernel, out user) || !GetExitCodeProcess(process, out status) || status != 259)
            throw new InvalidOperationException("Native process is no longer live.");
        return (ulong)born;
    }
    static Identity About(int pid) {
        if (IntPtr.Size != 8) throw new InvalidOperationException("Native observation requires 64-bit PowerShell.");
        IntPtr process = OpenProcess(0x1010, false, pid); // QUERY_LIMITED_INFORMATION | VM_READ
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            ulong born = Birth(process); bool wow64; BasicInfo basic; int written;
            if (!IsWow64Process(process, out wow64) || wow64 ||
                NtQueryInformationProcess(process, 0, out basic, Marshal.SizeOf(typeof(BasicInfo)), out written) != 0 ||
                basic.Pid.ToInt64() != pid || basic.Peb == IntPtr.Zero)
                throw new InvalidOperationException("Native process identity is unavailable (including WOW64).");
            // PEB.ProcessParameters, then CurrentDirectory.DosPath and CommandLine.
            long parameters = BitConverter.ToInt64(Read(process, basic.Peb.ToInt64() + 0x20, 8), 0);
            byte[] directory = Read(process, parameters + 0x38, 16), command = Read(process, parameters + 0x70, 16);
            string cwd = Text(process, directory), line = Text(process, command);
            int count; IntPtr list = CommandLineToArgvW(line, out count);
            if (list == IntPtr.Zero || count < 1) throw new InvalidOperationException("Native argv is unavailable.");
            string[] argv;
            try {
                argv = new string[count];
                for (int i = 0; i < count; i++) argv[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(list, i * IntPtr.Size));
            } finally { LocalFree(list); }
            if (Birth(process) != born ||
                BitConverter.ToInt64(Read(process, basic.Peb.ToInt64() + 0x20, 8), 0) != parameters ||
                !directory.SequenceEqual(Read(process, parameters + 0x38, 16)) || !command.SequenceEqual(Read(process, parameters + 0x70, 16)))
                throw new InvalidOperationException("Native process changed during observation.");
            if (cwd.Length > 3 && cwd.EndsWith("\\")) cwd = cwd.Substring(0, cwd.Length - 1);
            var image = new StringBuilder(32768); uint imageLength = (uint)image.Capacity;
            var system = new StringBuilder(32768);
            uint systemLength = GetSystemDirectoryW(system, (uint)system.Capacity);
            if (!QueryFullProcessImageNameW(process, 0, image, ref imageLength) || systemLength == 0 || systemLength >= system.Capacity)
                throw new InvalidOperationException("Native process image is unavailable.");
            // Console infrastructure is not an occupant. Never trust argv or a basename:
            // a user program named conhost.exe must still keep its terminal busy.
            bool consoleHost = String.Equals(image.ToString(), System.IO.Path.Combine(system.ToString(), "conhost.exe"), StringComparison.OrdinalIgnoreCase);
            return new Identity { Born = born, Info = new ProcessInfo { pid = pid, cwd = cwd, argv = argv }, ConsoleHost = consoleHost };
        } finally { CloseHandle(process); }
    }
    static Dictionary<int, int> Snapshot() {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result = new Dictionary<int, int>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do { result[(int)entry.Pid] = (int)entry.Parent; } while (Process32NextW(snapshot, ref entry));
            if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception(Marshal.GetLastWin32Error());
            return result;
        } finally { CloseHandle(snapshot); }
    }
    static HashSet<int> Tree(Dictionary<int, int> parents, int root) {
        var result = new HashSet<int> { root };
        int observer = GetCurrentProcessId();
        bool added;
        do {
            added = false;
            foreach (var item in parents)
                // The observer and its compiler are not terminal occupants.
                if (item.Key != observer && result.Contains(item.Value) && result.Add(item.Key)) added = true;
        } while (added);
        return result;
    }
    public static Observation Observe(int root) {
        Identity shell = About(root); // An unavailable root must never produce an idle verdict.
        var before = Snapshot();
        var tree = Tree(before, root);
        var native = new Dictionary<int, Identity> { { root, shell } };
        var unknown = new Observation { shell_pid = root, shell_owns_foreground = false, foreground_processes = new ProcessInfo[0] };
        try {
            foreach (int pid in tree) if (pid != root) native[pid] = About(pid);
            foreach (int pid in tree)
                if (pid != root && native[pid].Born < native[before[pid]].Born) return unknown; // reused parent PID
            if (!tree.SetEquals(Tree(Snapshot(), root))) return unknown;
            foreach (int pid in tree) if (About(pid).Born != native[pid].Born) return unknown;
        } catch { return unknown; } // Unreadable or changing descendants are busy, never idle.
        var occupants = native.Values.Where(item => item.Info.pid == root || !item.ConsoleHost).Select(item => item.Info).OrderBy(item => item.pid).ToArray();
        return new Observation {
            shell_pid = root, shell_owns_foreground = occupants.Length == 1,
            foreground_processes = occupants
        };
    }
}
'@
}
[TeleportNativeProcesses]::Observe($RootPid) | ConvertTo-Json -Depth 5 -Compress
