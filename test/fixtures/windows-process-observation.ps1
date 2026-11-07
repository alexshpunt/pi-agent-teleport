param([Parameter(Mandatory = $true)][string]$Observer)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$root = Join-Path ([IO.Path]::GetTempPath()) ('teleport-native-' + [Guid]::NewGuid().ToString('N') + ' owned space')
$child = $null
$child32 = $null
try {
    $liveCwd = Join-Path $root ('changed cwd ' + [char]0x03B4)
    [IO.Directory]::CreateDirectory($liveCwd) | Out-Null
    $ready = Join-Path $root 'ready'
    $session = Join-Path $root 'quoted session.jsonl'
    $exe = Join-Path $root 'conhost.exe'
    Add-Type -OutputAssembly $exe -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public class OwnedChild {
    public static void Main(string[] args) {
        Environment.CurrentDirectory = args[0];
        File.WriteAllText(args[1], "ready");
        Thread.Sleep(120000);
    }
}
'@
    $arguments = @($liveCwd, $ready, '--session', $session) | ForEach-Object { '"' + $_ + '"' }
    $child = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not [IO.File]::Exists($ready)) {
        if ($child.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Owned native child did not become ready.' }
        Start-Sleep -Milliseconds 50
    }
    # Invoke in this same PowerShell process so observation adds no child to its tree.
    $busy = (& $Observer -RootPid $PID) | ConvertFrom-Json
    $native = @($busy.foreground_processes | Where-Object { $_.pid -eq $child.Id })
    if ($busy.shell_pid -ne $PID -or $busy.shell_owns_foreground -or $native.Count -ne 1) { throw 'Native child identity/busy verdict mismatch.' }
    if ($native[0].cwd -cne $liveCwd) { throw ('Live native cwd mismatch: ' + $native[0].cwd) }
    if (($native[0].argv | ConvertTo-Json -Compress) -cne (@($exe, $liveCwd, $ready, '--session', $session) | ConvertTo-Json -Compress)) { throw 'Native quoted argv mismatch.' }
    if (@($busy.foreground_processes | Where-Object { $_.pid -eq 4 }).Count -ne 0) { throw 'Foreign Windows process leaked into the owned tree.' }
    $childId = $child.Id
    $child.Kill()
    $child.WaitForExit()
    $idle = (& $Observer -RootPid $PID) | ConvertFrom-Json
    if (-not $idle.shell_owns_foreground -or @($idle.foreground_processes).Count -ne 1 -or $idle.foreground_processes[0].pid -ne $PID) { throw ('Native idle shell verdict mismatch: ' + ($idle | ConvertTo-Json -Depth 5 -Compress)) }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Process -Id $PID).Path
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Observer + '" ' + $PID
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $probe = [Diagnostics.Process]::Start($start)
    try {
        $output = $probe.StandardOutput.ReadToEndAsync()
        $errors = $probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(15000)) { $probe.Kill(); throw 'External native observer timed out.' }
        if ($probe.ExitCode -ne 0) { throw $errors.GetAwaiter().GetResult() }
        $external = $output.GetAwaiter().GetResult() | ConvertFrom-Json
        if (-not $external.shell_owns_foreground -or $external.shell_pid -ne $PID -or @($external.foreground_processes).Count -ne 1) { throw 'The observer was counted as a terminal occupant.' }
    } finally { $probe.Dispose() }
    $ready32 = Join-Path $root 'ready32'
    $script32 = "[IO.File]::WriteAllText('" + $ready32.Replace("'", "''") + "','ready'); [Threading.Thread]::Sleep(120000)"
    $encoded32 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script32))
    $child32 = Start-Process -FilePath (Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded32) -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not [IO.File]::Exists($ready32)) {
        if ($child32.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Owned WOW64 child did not become ready.' }
        Start-Sleep -Milliseconds 50
    }
    $unknown = (& $Observer -RootPid $PID) | ConvertFrom-Json
    if ($unknown.shell_owns_foreground -or @($unknown.foreground_processes).Count -ne 0) { throw 'An unreadable WOW64 descendant was treated as known or idle.' }
    $rootRejected = $false
    try { & $Observer -RootPid $child32.Id | Out-Null } catch { $rootRejected = $true }
    if (-not $rootRejected) { throw 'An unsupported WOW64 root was accepted.' }
    $child32.Kill()
    $child32.WaitForExit()
    [ordered]@{ rootPid = $PID; childPid = $childId; cwd = $liveCwd; argv = $native[0].argv; busy = $busy; idle = $idle; external = $external; unknown = $unknown; wow64RootRejected = $rootRejected } | ConvertTo-Json -Depth 7 -Compress
} finally {
    if ($null -ne $child32) {
        if (-not $child32.HasExited) { $child32.Kill(); $child32.WaitForExit() }
        $child32.Dispose()
    }
    if ($null -ne $child) {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
    }
    if ([IO.Directory]::Exists($root)) { Remove-Item -LiteralPath $root -Recurse -Force }
}
