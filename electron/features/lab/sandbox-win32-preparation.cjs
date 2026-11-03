const path = require('node:path');
const ISOLATION_ERROR = 'Windows 安全实验执行不可用，未启动工作者。';
const failure = () => Object.assign(new Error(ISOLATION_ERROR), { infrastructure: true, code: 'ERR_LAB_WINDOWS_ISOLATION' });

// UAC starts the Windows-owned PowerShell, never an executable or CLR configuration in userData.
// The bootstrap accepts only the freshly compiled payload's identity; the helper's operation is constant.
function prepCommand(binary, sha256, { elevate = true } = {}) {
  if (typeof binary !== 'string' || !path.win32.isAbsolute(binary) || !/^[a-f0-9]{64}$/.test(sha256)) throw failure();
  const system = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const file = path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const bootstrap = `
$ErrorActionPreference='Stop'
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(binary).toString('base64')}'))
$hash=[Security.Cryptography.SHA256]::Create()
$payloadStream=[IO.FileStream]::new($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  if($payloadStream.Length -gt 1048576){throw 'Invalid preparation payload.'}
  $bytes=[byte[]]::new([int]$payloadStream.Length)
  $offset=0
  while($offset -lt $bytes.Length){$read=$payloadStream.Read($bytes,$offset,$bytes.Length-$offset);if($read -eq 0){throw 'Incomplete preparation payload.'};$offset+=$read}
} finally {$payloadStream.Dispose()}
if([BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() -ne '${sha256}'){throw 'Preparation payload changed.'}
$root=[IO.Path]::Combine([Environment]::SystemDirectory,'AgentrixLabPrep-'+[Guid]::NewGuid().ToString('N'))
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm('O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
$null=[IO.Directory]::CreateDirectory($root,$acl)
try {
  $binary=[IO.Path]::Combine($root,'prepare.exe')
  if([IO.Directory]::GetFileSystemEntries($root).Length -ne 0){throw 'Preparation directory is not empty.'}
  [IO.File]::WriteAllBytes($binary,$bytes)
  $pinned=[IO.FileStream]::new($binary,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    if([BitConverter]::ToString($hash.ComputeHash($pinned)).Replace('-','').ToLowerInvariant() -ne '${sha256}'){throw 'Preparation copy changed.'}
    if([IO.Directory]::GetFileSystemEntries($root).Length -ne 1){throw 'Unexpected preparation neighbour.'}
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$binary
    $start.Arguments='prepare-host'
    $start.WorkingDirectory=[Environment]::SystemDirectory
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.EnvironmentVariables.Clear()
    $start.EnvironmentVariables['SystemRoot']=[IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
    $start.EnvironmentVariables['TEMP']=$root
    $start.EnvironmentVariables['TMP']=$root
    $helper=[Diagnostics.Process]::Start($start)
    try {$helper.WaitForExit();$code=$helper.ExitCode} finally {$helper.Dispose()}
  } finally {$pinned.Dispose()}
} finally {[IO.Directory]::Delete($root,$true);$hash.Dispose()}
exit $code
`;
  const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
  const script = elevate ? `
$ErrorActionPreference='Stop'
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\\v1.0\\powershell.exe')
$start.Arguments='-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}'
$start.WorkingDirectory=[Environment]::SystemDirectory
$start.Verb='runas'
$start.UseShellExecute=$true
$start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
$helper=[Diagnostics.Process]::Start($start)
try {$helper.WaitForExit();exit $helper.ExitCode} finally {$helper.Dispose()}
` : bootstrap;
  const command = Buffer.from(script, 'utf16le').toString('base64');
  if (command.length > 30000) throw failure();
  return { file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], options: {
    windowsHide: true, cwd: system, timeout: 120000, maxBuffer: 4096,
    env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: system },
  } };
}

function createHostPreparation({ testing = Boolean(process.env.NODE_TEST_CONTEXT),
  consent = process.env.AGENTRIX_LAB_TEST_PREPARE_HOST === '1' } = {}) {
  let attempt;
  return async function ensureHostReady({ verify, prepare, elevate, prompt = true }) {
    try {
      const state = await verify();
      if (state.ready) return;
      if (!attempt) {
        if ((testing && (!consent || !state.elevated)) || (!state.elevated && !prompt)) throw failure();
        attempt = Promise.resolve().then(() => state.elevated ? prepare() : elevate());
      }
      await attempt;
      // An accepted UAC dialog or a previous success is not evidence of the current ACL state.
      if (!(await verify()).ready) throw failure();
    } catch { throw failure(); }
  };
}

// Based on the documented system-drive metadata and Null-device preparation. This partial class has no dynamic targets.
// https://github.com/microsoft/mxc/blob/main/docs/host-prep.md
const nativeSource = String.raw`
public partial class LabSandbox {
  const uint METADATA = 0x120088;
  static readonly string[] PackageSids = { "S-1-15-2-1", "S-1-15-2-2" };
  const string NullPath = "\\\\?\\GLOBALROOT\\Device\\Null";
  const string NullDescriptor = "O:BAG:SYD:(A;;GRGWGX;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;RC)(A;;GRGWGX;;;AC)(A;;GRGWGX;;;S-1-15-2-2)S:(ML;;NW;;;LW)";
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string file,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr handle,uint info,IntPtr descriptor,uint length,out uint required);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle,uint info,IntPtr descriptor);

  static bool Elevated() { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
  static string SystemDrive() { return Path.GetPathRoot(Environment.SystemDirectory); }
  static RawAcl FileAcl(string file) {
    IntPtr owner,group,dacl,sacl,descriptor;
    CheckCode(GetNamedSecurityInfoW(file,1,DACL,out owner,out group,out dacl,out sacl,out descriptor));
    try {
      if(dacl==IntPtr.Zero) throw new Exception();
      byte[] bytes=new byte[(ushort)Marshal.ReadInt16(dacl,2)]; Marshal.Copy(dacl,bytes,0,bytes.Length);
      return new RawAcl(bytes,0);
    } finally { LocalFree(descriptor); }
  }
  static uint FileMask(uint mask) {
    if((mask & 0x80000000)!=0) mask |= 0x120089;
    if((mask & 0x40000000)!=0) mask |= 0x120116;
    if((mask & 0x20000000)!=0) mask |= 0x1200a0;
    if((mask & 0x10000000)!=0) mask |= 0x1f01ff;
    return mask & 0x1fffff;
  }
  static bool Allows(RawAcl acl,string sid,uint rights) {
    uint allowed=0;
    foreach(var ace in acl.Cast<GenericAce>().OfType<QualifiedAce>()) {
      if(ace.SecurityIdentifier.Value!=sid || (ace.AceFlags & AceFlags.InheritOnly)!=0) continue;
      uint mask=FileMask(unchecked((uint)ace.AccessMask));
      if(ace.AceQualifier==AceQualifier.AccessDenied && (mask & rights)!=0) return false;
      if(ace.AceQualifier==AceQualifier.AccessAllowed) allowed |= mask;
    }
    return (allowed & rights)==rights;
  }
  static IntPtr OpenNull(uint access) {
    IntPtr handle=CreateFileW(NullPath,access,7,IntPtr.Zero,3,0,IntPtr.Zero);
    Check(handle!=new IntPtr(-1)); return handle;
  }
  static RawSecurityDescriptor NullSecurity() {
    IntPtr handle=OpenNull(0x20000);
    try {
      uint size; GetKernelObjectSecurity(handle,DACL|LABEL,IntPtr.Zero,0,out size);
      if(size==0 || size>65536) throw new Exception();
      IntPtr buffer=Marshal.AllocHGlobal((int)size);
      try { Check(GetKernelObjectSecurity(handle,DACL|LABEL,buffer,size,out size));
        byte[] bytes=new byte[size]; Marshal.Copy(buffer,bytes,0,bytes.Length); return new RawSecurityDescriptor(bytes,0); }
      finally { Marshal.FreeHGlobal(buffer); }
    } finally { CloseHandle(handle); }
  }
  static bool HostReady() {
    try {
      var root=FileAcl(SystemDrive());
      if(!PackageSids.All(sid=>Allows(root,sid,METADATA))) return false;
      var device=NullSecurity();
      if(device.DiscretionaryAcl==null || !PackageSids.All(sid=>Allows(device.DiscretionaryAcl,sid,0x1201bf))) return false;
      if(device.SystemAcl==null) return false;
      foreach(GenericAce ace in device.SystemAcl) {
        if((int)ace.AceType!=17 || ace.BinaryLength<20) continue;
        byte[] bytes=new byte[ace.BinaryLength]; ace.GetBinaryForm(bytes,0);
        if(new SecurityIdentifier(bytes,8).Value=="S-1-16-4096" && (BitConverter.ToUInt32(bytes,4) & 1)!=0) return true;
      }
      return false;
    } catch { return false; }
  }
  static int PrepareHost() {
    if(!Elevated()) return 65;
    stage="host preparation";
    string root=SystemDrive();
    foreach(string identity in PackageSids) {
      var acl=FileAcl(root);
      if(Allows(acl,identity,METADATA)) continue;
      // Do not silently merge a pre-existing, differently scoped ACE owned by another application.
      if(acl.Cast<GenericAce>().OfType<QualifiedAce>().Any(ace=>ace.SecurityIdentifier.Value==identity &&
        ace.AceQualifier==AceQualifier.AccessAllowed && (ace.AceFlags & AceFlags.Inherited)==0)) throw new Exception();
      IntPtr sid; Check(ConvertStringSidToSidW(identity,out sid));
      try { Acl(root,sid,METADATA,false,false,false); } finally { LocalFree(sid); }
    }
    IntPtr handle=OpenNull(0xe0000),descriptor; uint size;
    try {
      Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(NullDescriptor,1,out descriptor,out size));
      try { Check(SetKernelObjectSecurity(handle,1|2|DACL|LABEL,descriptor)); } finally { LocalFree(descriptor); }
    } finally { CloseHandle(handle); }
    return HostReady()?0:125;
  }
}
`;

module.exports = { ISOLATION_ERROR, prepCommand, createHostPreparation, nativeSource };
