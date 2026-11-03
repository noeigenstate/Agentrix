const ISOLATION_ERROR = 'Windows 安全实验执行不可用，未启动工作者。';
const failure = () => Object.assign(new Error(ISOLATION_ERROR), { infrastructure: true, code: 'ERR_LAB_WINDOWS_ISOLATION' });

// The only elevated command is a constant operation in our compiled helper. No task, path or model argument follows it.
function prepCommand(binary) {
  return { file: binary, args: ['elevate-host'], options: { windowsHide: true, timeout: 120000, maxBuffer: 4096 } };
}

function createHostPreparation() {
  let attempt;
  return async function ensureHostReady({ verify, prepare, elevate, prompt = true }) {
    try {
      const state = await verify();
      if (state.ready) return;
      if (!attempt) {
        if (!state.elevated && !prompt) throw failure();
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
  static int ElevateHost() {
    // UseShellExecute + runas invokes ShellExecute's UAC flow. Arguments and the target operation are fixed.
    string binary=System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    using(var pinned=new FileStream(binary,FileMode.Open,FileAccess.Read,FileShare.Read)) {
    var info=new System.Diagnostics.ProcessStartInfo {
      FileName=binary,
      Arguments="prepare-host",WorkingDirectory=Environment.SystemDirectory,Verb="runas",UseShellExecute=true,
      WindowStyle=System.Diagnostics.ProcessWindowStyle.Hidden
    };
    using(var helper=System.Diagnostics.Process.Start(info)) {
      if(helper==null || !helper.WaitForExit(110000)) throw new Exception();
      return helper.ExitCode;
    }
    }
  }
}
`;

module.exports = { ISOLATION_ERROR, prepCommand, createHostPreparation, nativeSource };
