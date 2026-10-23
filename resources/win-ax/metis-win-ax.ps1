# metis-win-ax.ps1 (G24): Windows focus snapshot and compare-and-insert through UI Automation and SendInput.
#
# Launched by src/main/win-ax-helper.ts as the pinned System32 powershell.exe with -File and ONE argv word
# (ax-focus-snapshot | ax-insert). The dictated text and every other parameter of ax-insert arrive on STDIN as JSON,
# never on the command line (a command line is readable by any local process). Output is ONE JSON line on stdout with
# the same shape the macOS helper writes (see src/main/mac-ax-helper.ts). The text of a field is never output: only
# its SHA-256 and length. A password field is never read at all.
#
# ax-insert order: validate the request, re-resolve the focused element NOW, refuse a secure field first, compare
# pid / top-level window / runtime id / value hash / selection, refuse a target in a higher integrity level (UIPI would
# drop the input), wait for Ctrl/Alt/Win to be released, re-resolve and re-compare as the last step before the first
# key, then send UTF-16 code units as KEYEVENTF_UNICODE (no clipboard, never Enter), re-checking the foreground window
# between chunks, then read the value back. Anything that cannot be read back is reported "unverified".

param([Parameter(Position = 0)][string]$Command = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:SentAny = $false
$utf8 = New-Object System.Text.UTF8Encoding $false
$MaxValueChars = 1000000
$MaxTextChars = 8000

function Emit($object) {
  $json = ($object | ConvertTo-Json -Compress -Depth 6)
  $bytes = $utf8.GetBytes($json + "`n")
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

function Emit-Snapshot($status, $s) {
  $o = [ordered]@{
    status = $status; pid = $null; bundleId = $null; processStartMs = $null; windowId = $null; role = $null
    subrole = $null; token = $null; secure = $false; editable = $false; terminal = $false; valueHash = $null
    valueLength = $null; valueTooLarge = $false; selection = $null
  }
  if ($null -ne $s) { foreach ($k in @($o.Keys)) { if ($s.ContainsKey($k)) { $o[$k] = $s[$k] } } }
  Emit $o
}

function Emit-Insert($outcome, $reason, $method, $terminal, $sanitized, $textHash, $textLength) {
  Emit ([ordered]@{
      outcome = $outcome; reason = $reason; method = $method; terminal = [bool]$terminal; sanitized = [bool]$sanitized
      textHash = $textHash; textLength = [int]$textLength; clipboard = 'not_used'
    })
}

function Sha256Hex([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($text))) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

# The inert sink: control characters (C0, DEL, C1), line/paragraph separators and bidi controls never reach a field.
# Line breaks and tabs become a space, everything else in those ranges is dropped, an unpaired surrogate is dropped.
# Mirrors terminalSafe in native/mac-helper/main.swift and inertText in src/main/features/dictation/dictation-insert-win.ts.
function Get-InertText([string]$text, [bool]$trimTrailing) {
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $text.Length; $i++) {
    $c = [int]$text[$i]
    if ($c -eq 0x0A -or $c -eq 0x0D -or $c -eq 0x09 -or $c -eq 0x0B -or $c -eq 0x0C -or $c -eq 0x85 -or $c -eq 0x2028 -or $c -eq 0x2029) { [void]$sb.Append(' '); continue }
    if (($c -le 0x1F) -or ($c -ge 0x7F -and $c -le 0x9F) -or $c -eq 0x200E -or $c -eq 0x200F -or ($c -ge 0x202A -and $c -le 0x202E) -or ($c -ge 0x2066 -and $c -le 0x2069)) { continue }
    if ($c -ge 0xD800 -and $c -le 0xDBFF) {
      if (($i + 1) -lt $text.Length -and [int]$text[$i + 1] -ge 0xDC00 -and [int]$text[$i + 1] -le 0xDFFF) {
        [void]$sb.Append($text[$i]); [void]$sb.Append($text[$i + 1]); $i++
      }
      continue
    }
    if ($c -ge 0xDC00 -and $c -le 0xDFFF) { continue }
    [void]$sb.Append($text[$i])
  }
  $result = $sb.ToString()
  if ($trimTrailing) { $result = $result.TrimEnd(' ') }
  return $result
}

if ($Command -ne 'ax-focus-snapshot' -and $Command -ne 'ax-insert') {
  Emit-Insert 'refused' 'invalid_request' 'none' $false $false $null 0
  exit 0
}
$isInsert = ($Command -eq 'ax-insert')

function Fail-Unsupported() {
  if ($isInsert) { Emit-Insert 'unsupported' 'unsupported' 'none' $false $false $null 0 } else { Emit-Snapshot 'no_focus' $null }
  exit 0
}

# Constrained Language Mode (AppLocker / WDAC) blocks Add-Type: nothing can be done safely, say so.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Fail-Unsupported }

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MetisWin {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

  public static string ClassName(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static bool ModifiersDown() {
    // Ctrl, Alt (Menu), left/right Windows. Shift does not change a Unicode packet.
    int[] keys = new int[] { 0x11, 0x12, 0x5B, 0x5C };
    foreach (int k in keys) { if ((GetAsyncKeyState(k) & 0x8000) != 0) return true; }
    return false;
  }
  // The mandatory integrity RID of a process (0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system), or -1 when it
  // cannot be opened (which is what an elevated or protected process looks like to a medium-integrity caller).
  public static int IntegrityRid(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return -1;
    try {
      IntPtr token;
      if (!OpenProcessToken(h, 0x8, out token)) return -1;
      try {
        int needed = 0;
        GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
        if (needed <= 0) return -1;
        IntPtr buf = Marshal.AllocHGlobal(needed);
        try {
          int ret;
          if (!GetTokenInformation(token, 25, buf, needed, out ret)) return -1;
          IntPtr sid = Marshal.ReadIntPtr(buf);
          byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
          if (count == 0) return -1;
          return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        } finally { Marshal.FreeHGlobal(buf); }
      } finally { CloseHandle(token); }
    } finally { CloseHandle(h); }
  }
  // Sends the UTF-16 code units as KEYEVENTF_UNICODE down/up pairs. Returns how many INPUT records the OS accepted
  // (2 per unit); fewer than asked means the OS blocked some of it (UIPI, another thread's input hook).
  public static uint SendUnits(string units) {
    INPUT[] inputs = new INPUT[units.Length * 2];
    for (int i = 0; i < units.Length; i++) {
      for (int d = 0; d < 2; d++) {
        INPUT input = new INPUT();
        input.type = 1;
        input.U.ki.wVk = 0;
        input.U.ki.wScan = (ushort)units[i];
        input.U.ki.dwFlags = 0x0004 | (d == 1 ? 0x0002u : 0u);
        inputs[i * 2 + d] = input;
      }
    }
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
} catch { Fail-Unsupported }

$TerminalProcesses = @('windowsterminal', 'wt', 'openconsole', 'conhost', 'cmd', 'powershell', 'powershell_ise', 'pwsh', 'wezterm-gui', 'alacritty', 'mintty', 'conemu', 'conemu64', 'kitty', 'tabby')
$TerminalClasses = @('CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass', 'PseudoConsoleWindow', 'mintty', 'VirtualConsoleClass', 'org.wezfurlong.wezterm')
$TerminalElementClasses = @('TermControl', 'TerminalControl')

function Get-Pattern($element, $pattern) {
  $obj = $null
  try { if ($element.TryGetCurrentPattern($pattern, [ref]$obj)) { return $obj } } catch { }
  return $null
}

# The field's text and selection through TextPattern (preferred: offsets are coherent) or ValuePattern. Never output.
function Read-Field($element) {
  $r = @{ text = $null; selection = $null; tooLarge = $false; readOnly = $false; hasValue = $false; hasText = $false }
  $tp = Get-Pattern $element ([System.Windows.Automation.TextPattern]::Pattern)
  $vp = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $vp) { $r.hasValue = $true; $r.readOnly = [bool]$vp.Current.IsReadOnly }
  try {
    if ($null -ne $tp) {
      $r.hasText = $true
      $text = $tp.DocumentRange.GetText($MaxValueChars + 1)
      if ($text.Length -gt $MaxValueChars) { $r.tooLarge = $true; return $r }
      $r.text = $text
      $sels = $tp.GetSelection()
      if ($sels.Length -eq 1) {
        $pre = $tp.DocumentRange.Clone()
        [void]$pre.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $sels[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        $loc = $pre.GetText($MaxValueChars + 1).Length
        $len = $sels[0].GetText($MaxValueChars + 1).Length
        if ($loc + $len -le $text.Length) { $r.selection = @{ location = [int]$loc; length = [int]$len } }
      }
    } elseif ($null -ne $vp) {
      $text = [string]$vp.Current.Value
      if ($text.Length -gt $MaxValueChars) { $r.tooLarge = $true; return $r }
      $r.text = $text
    }
  } catch { $r.text = $null; $r.selection = $null }
  return $r
}

# One look at the focused element. Returns @{ kind = ok | no_focus | permission; ...fields; text = internal only }.
function Resolve-Focus() {
  $fg = [MetisWin]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { return @{ kind = 'no_focus' } }
  [uint32]$fgPid = 0
  [void][MetisWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $own = [MetisWin]::IntegrityRid([uint32][System.Diagnostics.Process]::GetCurrentProcess().Id)
  $target = [MetisWin]::IntegrityRid($fgPid)
  if ($target -lt 0 -or ($own -ge 0 -and $target -gt $own)) { return @{ kind = 'permission'; pid = [int]$fgPid } }
  try { $element = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { return @{ kind = 'no_focus' } }
  if ($null -eq $element) { return @{ kind = 'no_focus' } }
  $info = $element.Current
  if ([int]$info.ProcessId -ne [int]$fgPid) { return @{ kind = 'no_focus' } }
  $pidValue = [int]$fgPid
  $proc = $null; $procName = ''; $startMs = $null
  try {
    $proc = [System.Diagnostics.Process]::GetProcessById($pidValue)
    $procName = $proc.ProcessName
    $startMs = [long]([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds()
  } catch { }
  $safeName = ($procName -replace '[^A-Za-z0-9_.-]', '_')
  if ($safeName.Length -gt 100) { $safeName = $safeName.Substring(0, 100) }
  $runtime = $null
  try { $runtime = ($element.GetRuntimeId() -join '.') } catch { }
  if ([string]::IsNullOrEmpty($runtime)) { $token = $null }
  elseif ($runtime.Length -gt 150) { $token = 'h' + (Sha256Hex $runtime) }
  else { $token = $runtime }
  $cls = [MetisWin]::ClassName($fg)
  $terminal = ($TerminalProcesses -contains $procName.ToLowerInvariant()) -or ($TerminalClasses -contains $cls) -or ($TerminalElementClasses -contains [string]$info.ClassName)
  $role = ([string]$info.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
  $s = @{
    kind = 'ok'; pid = $pidValue
    bundleId = $(if ($safeName) { 'win:' + $safeName } else { $null })
    processStartMs = $startMs
    windowId = 'w' + $fg.ToInt64().ToString()
    role = $role; subrole = $null; token = $token
    secure = [bool]$info.IsPassword
    editable = $false; terminal = [bool]$terminal
    valueHash = $null; valueLength = $null; valueTooLarge = $false; selection = $null; text = $null
  }
  if ($s.secure) { return $s }   # a password field is never read
  $f = Read-Field $element
  $s.valueTooLarge = $f.tooLarge
  $s.selection = $f.selection
  if ($null -ne $f.text) {
    $s.text = $f.text
    $s.valueHash = Sha256Hex $f.text
    $s.valueLength = [int]$f.text.Length
  }
  $kindEditable = ($role -eq 'Edit' -or $role -eq 'Document' -or $role -eq 'ComboBox')
  if ($info.IsEnabled -and $info.IsKeyboardFocusable) {
    $s.editable = ($f.hasValue -and -not $f.readOnly) -or (-not $f.hasValue -and $f.hasText -and $kindEditable)
  }
  return $s
}

try {
  if (-not $isInsert) {
    $s = Resolve-Focus
    if ($s.kind -eq 'permission') { Emit-Snapshot 'permission' $null }
    elseif ($s.kind -ne 'ok') { Emit-Snapshot 'no_focus' $null }
    else { Emit-Snapshot 'ok' $s }
    exit 0
  }

  # ---- ax-insert -------------------------------------------------------------------------------------------------
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false)
  $raw = $reader.ReadToEnd()
  $req = $null
  if ($raw.Length -gt 262144) { Emit-Insert 'refused' 'invalid_request' 'none' $false $false $null 0; exit 0 }
  try { $req = $raw | ConvertFrom-Json } catch { }
  $valid = $false
  if ($null -ne $req) {
    $names = @($req.PSObject.Properties.Name)
    $valid = @(@('pid', 'windowId', 'token', 'valueHash', 'valueLength', 'selectionLocation', 'selectionLength', 'text') | Where-Object { $names -notcontains $_ }).Count -eq 0
  }
  if ($valid) {
    $valid = ($req.text -is [string]) -and ($req.windowId -is [string]) -and ($req.token -is [string]) -and ($req.valueHash -is [string]) `
      -and ($req.valueHash -match '^[0-9a-f]{64}$') -and ($req.token -match '^[A-Za-z0-9_.:@-]{1,160}$') -and ($req.windowId -match '^[A-Za-z0-9_.:@-]{1,160}$') `
      -and ($req.text.Length -ge 1) -and ($req.text.Length -le $MaxTextChars)
  }
  if ($valid) {
    try {
      $reqPid = [int]$req.pid; $reqLen = [int]$req.valueLength; $reqLoc = [int]$req.selectionLocation; $reqSelLen = [int]$req.selectionLength
      $valid = $reqPid -gt 0 -and $reqLen -ge 0 -and $reqLoc -ge 0 -and $reqSelLen -ge 0 -and ($reqLoc + $reqSelLen) -le $reqLen
    } catch { $valid = $false }
  }
  if (-not $valid) { Emit-Insert 'refused' 'invalid_request' 'none' $false $false $null 0; exit 0 }

  function Compare-Target($s) {
    # Secure first, then identity, then content. Returns $null when the target is exactly what was bound.
    if ($s.kind -eq 'permission') { return 'permission' }
    if ($s.kind -ne 'ok') { return 'target_changed' }
    if ($s.secure) { return 'secure_field' }
    if ($s.pid -ne $reqPid -or $s.windowId -ne $req.windowId -or $s.token -ne $req.token) { return 'target_changed' }
    if ($s.valueTooLarge -or $null -eq $s.valueHash -or $null -eq $s.selection) { return 'unsupported' }
    if ($s.valueHash -ne $req.valueHash -or $s.valueLength -ne $reqLen -or $s.selection.location -ne $reqLoc -or $s.selection.length -ne $reqSelLen) { return 'target_changed' }
    if (-not $s.editable) { return 'unsupported' }
    return $null
  }

  $first = Resolve-Focus
  $refusal = Compare-Target $first
  if ($null -ne $refusal) {
    $outcome = $(if ($refusal -eq 'unsupported') { 'unsupported' } else { 'refused' })
    Emit-Insert $outcome $refusal 'none' ($first.ContainsKey('terminal') -and $first.terminal) $false $null 0
    exit 0
  }
  $terminal = [bool]$first.terminal
  $text = Get-InertText ([string]$req.text) $terminal
  $sanitized = ($text -ne [string]$req.text)
  if ($text.Length -eq 0) { Emit-Insert 'refused' 'invalid_request' 'none' $terminal $sanitized $null 0; exit 0 }
  $textHash = Sha256Hex $text

  # Ctrl/Alt/Win still down (the dictation chord) would turn Unicode packets into shortcuts: wait briefly, then refuse.
  $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
  while ([MetisWin]::ModifiersDown() -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
  if ([MetisWin]::ModifiersDown()) { Emit-Insert 'refused' 'target_changed' 'none' $terminal $sanitized $null 0; exit 0 }

  # The last look before the first key: same checks again on a fresh resolve.
  $last = Resolve-Focus
  $refusal = Compare-Target $last
  if ($null -ne $refusal) {
    $outcome = $(if ($refusal -eq 'unsupported') { 'unsupported' } else { 'refused' })
    Emit-Insert $outcome $refusal 'none' $terminal $sanitized $null 0
    exit 0
  }
  $fgNow = [MetisWin]::GetForegroundWindow()
  $expected = $first.text.Substring(0, $reqLoc) + $text + $first.text.Substring($reqLoc + $reqSelLen)

  # Chunks of at most 32 UTF-16 units, never splitting a surrogate pair; the foreground window is re-checked between them.
  $pos = 0; $complete = $true; $acceptedAny = $false
  while ($pos -lt $text.Length) {
    $take = [Math]::Min(32, $text.Length - $pos)
    if (($pos + $take) -lt $text.Length -and [char]::IsHighSurrogate($text[$pos + $take - 1])) { $take-- }
    if ($take -le 0) { $take = 1 }
    if ($pos -gt 0 -and [MetisWin]::GetForegroundWindow() -ne $fgNow) { $complete = $false; break }
    $chunk = $text.Substring($pos, $take)
    $accepted = [MetisWin]::SendUnits($chunk)
    if ($accepted -gt 0) { $acceptedAny = $true; $script:SentAny = $true }
    if ($accepted -ne [uint32]($chunk.Length * 2)) { $complete = $false; break }
    $pos += $take
  }
  if (-not $acceptedAny) {
    # The OS accepted nothing: UIPI or an input hook blocked it. Nothing was typed.
    Emit-Insert 'refused' 'permission' 'none' $terminal $sanitized $null 0
    exit 0
  }
  if (-not $complete) { Emit-Insert 'unverified' $null 'ax' $terminal $sanitized $textHash $text.Length; exit 0 }
  if ($terminal) { Emit-Insert 'unverified' $null 'ax' $true $sanitized $textHash $text.Length; exit 0 }

  # Read the value back (the app may need a moment to process the queued input).
  $verified = $false
  $until = [DateTime]::UtcNow.AddMilliseconds(600)
  do {
    Start-Sleep -Milliseconds 60
    $now = Resolve-Focus
    if ($now.kind -eq 'ok' -and -not $now.secure -and $now.token -eq $req.token -and $null -ne $now.text -and $now.valueHash -eq (Sha256Hex $expected)) { $verified = $true; break }
  } while ([DateTime]::UtcNow -lt $until)
  Emit-Insert $(if ($verified) { 'verified' } else { 'unverified' }) $null 'ax' $false $sanitized $textHash $text.Length
  exit 0
} catch {
  if ($isInsert -and $script:SentAny) { Emit-Insert 'unverified' $null 'ax' $false $false $null 0 }
  elseif ($isInsert) { Emit-Insert 'unsupported' 'unsupported' 'none' $false $false $null 0 }
  else { Emit-Snapshot 'no_focus' $null }
  exit 0
}
