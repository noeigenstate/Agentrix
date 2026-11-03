// Kept as source so the packaged app needs neither a downloaded binary nor a native Node addon.
// Only the trusted host compiles/runs this helper; its input and handles never come from the model.
module.exports = String.raw`
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Threading.Tasks;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public partial class LabSandbox {
  const uint DACL = 4, LABEL = 16;
  const uint RX = 0x1200a9, MODIFY = 0x1301bf;
  const uint INHERIT = 3;
  static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
  static volatile string stage="initialize";
  static readonly bool diagnostics=Environment.GetEnvironmentVariable("AGENTRIX_LAB_DIAGNOSTICS")=="1";
  static readonly Stopwatch clock=Stopwatch.StartNew();
  static readonly object diagnosticGate=new object();
  static HashSet<string> credentialIdentities=new HashSet<string>();
  public class Plan {
    public string file, cwd, runId, job, labRoot, manifest, input;
    public string[] args, readRoots, writeRoots, credentialFiles, pipes, blockedPaths;
    public Dictionary<string,string> env;
    public bool network;
  }
  // Missing roots/launcher fields identify the previous per-file lease format.
  public class Lease {
    public string sid, profile; public string[] paths, roots;
    public int launcherPid; public long launcherCreated;
  }
  sealed class LeaseGuard : IDisposable {
    readonly Mutex mutex;
    public LeaseGuard(string manifest) {
      string key;
      using(var hash=SHA256.Create()) key=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(manifest).ToUpperInvariant()))).Replace("-","");
      mutex=new Mutex(false,"Local\\AgentrixLabLease-"+key);
      try { mutex.WaitOne(); } catch(AbandonedMutexException) { }
    }
    public void Dispose() { mutex.ReleaseMutex(); mutex.Dispose(); }
  }
  sealed class RunLifetime : IDisposable {
    readonly object gate=new object(); IntPtr job; bool stopped;
    public void Bind(IntPtr value) { lock(gate) { job=value; if(stopped) Check(TerminateJobObject(job,1)); } }
    public void Stop() { lock(gate) { stopped=true; if(job!=IntPtr.Zero) Check(TerminateJobObject(job,1)); } }
    public void CheckRunning() { lock(gate) { if(stopped) throw new OperationCanceledException(); } }
    public void Resume(IntPtr thread) { lock(gate) { CheckRunning(); if(ResumeThread(thread)==0xffffffff) Check(false); } }
    public void Dispose() { lock(gate) { job=IntPtr.Zero; } }
  }
  sealed class Grant {
    public string root; public uint rights; public bool propagate=true;
    public readonly List<string> boundaries=new List<string>();
  }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show, reservedSize; public IntPtr reserved2, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SX { public SI info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct FileIdentity {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;
    public uint volume,sizeHigh,sizeLow,links,idHigh,idLow;
    public string Key { get { return volume+":"+idHigh+":"+idLow; } }
  }
  [StructLayout(LayoutKind.Sequential)] struct Cap { public IntPtr sid, capabilities; public int count, reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SidAttr { public IntPtr sid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential)] struct Mapping { public uint read,write,execute,all; }
  [StructLayout(LayoutKind.Sequential)] struct Trustee {
    public IntPtr multiple; public int operation, form, type; public IntPtr name;
  }
  [StructLayout(LayoutKind.Sequential)] struct Access { public uint permissions; public int mode; public uint inheritance; public Trustee trustee; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits basic; public Counters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string file,StringBuilder command,ref SA process,ref SA thread,bool inherit,uint flags,IntPtr env,string cwd,ref SX startup,out PI info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr resultSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(ref SA security,string name);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Limits value,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,IntPtr value,int length,out int returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA security,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetDefaultDllDirectories(uint flags);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,int count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
  [DllImport("kernelbase.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool DeriveCapabilitySidsFromName(string name,out IntPtr groups,out uint groupCount,out IntPtr caps,out uint capCount);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid,out IntPtr text);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string text,out IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string name,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint SetSecurityInfo(IntPtr handle,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor,out ushort control,out uint revision);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint SetEntriesInAclW(int count,ref Access entry,IntPtr oldAcl,out IntPtr acl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool InitializeSecurityDescriptor(IntPtr descriptor,uint revision);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetSecurityDescriptorDacl(IntPtr descriptor,bool present,IntPtr acl,bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FileIdentity information);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder path,uint length,uint flags);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(IntPtr descriptor,IntPtr token,uint access,ref Mapping mapping,IntPtr privileges,ref uint length,out uint granted,out bool allowed);

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void CheckCode(uint code) { if (code != 0) throw new Win32Exception((int)code); }
  static void Trace(string message) {
    if(!diagnostics) return;
    lock(diagnosticGate) { Console.Error.WriteLine("[lab-win32] "+message+" ms="+clock.ElapsedMilliseconds); Console.Error.Flush(); }
  }
  static void Stage(string value) { stage=value; Trace("stage "+value); }
  static string Id(string value) { Guid parsed; if (!Guid.TryParseExact(value,"D",out parsed)) throw new Exception(); return parsed.ToString(); }
  static string JobName(string run,string job) { return "Local\\AgentrixLab-"+Id(run)+(String.IsNullOrEmpty(job)?"":"-"+Id(job)); }
  static string SidString(IntPtr sid) {
    IntPtr text; Check(ConvertSidToStringSidW(sid,out text));
    try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
  }
  static IntPtr Descriptor() {
    string owner = WindowsIdentity.GetCurrent().User.Value;
    IntPtr descriptor; uint size;
    // OWNER RIGHTS suppresses implicit owner WRITE_DAC. A lowbox child cannot open or rewrite its trusted parent.
    Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;SY)(A;;GA;;;"+owner+")(A;;RC;;;OW)",1,out descriptor,out size));
    return descriptor;
  }
  static IntPtr CheckedFile(string file,uint access,out FileIdentity identity) {
    IntPtr handle=CreateFileW(file,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    Check(handle!=new IntPtr(-1));
    try {
      Check(GetFileInformationByHandle(handle,out identity));
      if((identity.attributes & 0x400)!=0) throw new Exception();
      var name=new StringBuilder(32768); uint length=GetFinalPathNameByHandleW(handle,name,32768,0);
      Check(length>0 && length<32768);
      string resolved=name.ToString();
      if(resolved.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase)) resolved="\\\\"+resolved.Substring(8);
      else if(resolved.StartsWith("\\\\?\\")) resolved=resolved.Substring(4);
      if(!String.Equals(resolved.TrimEnd('\\'),Path.GetFullPath(file).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new Exception();
      return handle;
    } catch { CloseHandle(handle); throw; }
  }
  static void Acl(string file,IntPtr sid,uint rights,bool remove,bool deny=false,bool inherit=true,bool propagate=false) {
    IntPtr owner,group,oldAcl,sacl,descriptor,acl=IntPtr.Zero,handle=IntPtr.Zero;
    bool pipe=file.StartsWith("\\\\.\\pipe\\",StringComparison.OrdinalIgnoreCase);
    FileIdentity identity=new FileIdentity(); uint code;
    if(pipe) code=GetNamedSecurityInfoW(file,1,DACL,out owner,out group,out oldAcl,out sacl,out descriptor);
    else {
      try { handle=CheckedFile(file,0x20080,out identity); }
      catch(Win32Exception error) { if(remove && (error.NativeErrorCode==2 || error.NativeErrorCode==3)) return; throw; }
      code=GetSecurityInfo(handle,1,DACL,out owner,out group,out oldAcl,out sacl,out descriptor);
    }
    if (remove && (code == 2 || code == 3)) return;
    CheckCode(code);
    try {
      if(remove) {
        if(oldAcl==IntPtr.Zero) return;
        byte[] bytes=new byte[(ushort)Marshal.ReadInt16(oldAcl,2)]; Marshal.Copy(oldAcl,bytes,0,bytes.Length);
        string trusteeSid=SidString(sid);
        var filtered=new RawAcl(bytes,0); bool changed=false;
        for(int i=filtered.Count-1;i>=0;i--) {
          var ace=filtered[i] as QualifiedAce;
          if(ace!=null && ace.SecurityIdentifier.Value==trusteeSid) { filtered.RemoveAce(i); changed=true; }
        }
        if(!changed) return;
        bytes=new byte[filtered.BinaryLength]; filtered.GetBinaryForm(bytes,0);
        acl=Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes,0,acl,bytes.Length);
      }
      else {
        var entry = new Access { permissions=rights,mode=deny?3:1,inheritance=inherit && Directory.Exists(file)?INHERIT:0,
          trustee=new Trustee { form=0,type=5,name=sid } };
        CheckCode(SetEntriesInAclW(1,ref entry,oldAcl,out acl));
      }
      if(pipe) {
        CheckCode(SetNamedSecurityInfoW(file,1,DACL,IntPtr.Zero,IntPtr.Zero,acl,IntPtr.Zero));
      } else {
        IntPtr security=Marshal.AllocHGlobal(40);
        try { Check(InitializeSecurityDescriptor(security,1)); Check(SetSecurityDescriptorDacl(security,true,acl,false));
          FileIdentity current; IntPtr write=CheckedFile(file,0x60080,out current);
          try {
            if(current.Key!=identity.Key) throw new Exception();
            if(!remove && (rights & 0x116)!=0 && (current.attributes & 0x10)==0 && current.links>1 && !credentialIdentities.Contains(current.Key)) throw new Exception();
            // Propagate only a preflighted grant root. Metadata and cleanup change one verified object.
            if(propagate) CheckCode(SetSecurityInfo(write,1,DACL,IntPtr.Zero,IntPtr.Zero,acl,IntPtr.Zero));
            else Check(SetKernelObjectSecurity(write,DACL,security));
          } finally { CloseHandle(write); }
        }
        finally { Marshal.FreeHGlobal(security); }
      }
    } finally { if(remove) Marshal.FreeHGlobal(acl); else LocalFree(acl); LocalFree(descriptor); if(handle!=IntPtr.Zero) CloseHandle(handle); }
  }
  static IntPtr PipeDescriptor(IntPtr sid) {
    string user=WindowsIdentity.GetCurrent().User.Value;
    IntPtr descriptor; uint size;
    // An elevated creator's default owner can be Administrators, which is deny-only in a lowbox token.
    // Both access checks must pass: the signed-in user, then this job's exact package SID (never AC/ARAP).
    Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;SY)(A;;GA;;;"+user+
      ")(A;;RC;;;OW)(A;;0x12019f;;;"+SidString(sid)+")S:(ML;;NW;;;LW)",1,out descriptor,out size));
    return descriptor;
  }
  static void PipeAcl(string pipe,IntPtr sid) {
    if(!pipe.StartsWith("\\\\.\\pipe\\LOCAL\\agentrix-lab-",StringComparison.OrdinalIgnoreCase)) throw new Exception();
    IntPtr descriptor=PipeDescriptor(sid);
    try {
      bool present,defaulted; IntPtr sacl,dacl;
      Check(GetSecurityDescriptorDacl(descriptor,out present,out dacl,out defaulted));
      Check(GetSecurityDescriptorSacl(descriptor,out present,out sacl,out defaulted));
      CheckCode(SetNamedSecurityInfoW(pipe,1,DACL|LABEL|0x80000000U,IntPtr.Zero,IntPtr.Zero,dacl,sacl));
    } finally { LocalFree(descriptor); }
  }
  static IntPtr NewJob(string name,IntPtr descriptor) {
    var security = new SA { size=Marshal.SizeOf(typeof(SA)),descriptor=descriptor };
    IntPtr job = CreateJobObjectW(ref security,name); Check(job!=IntPtr.Zero);
    var limits = new Limits(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no BREAKAWAY flags.
    if (!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) { CloseHandle(job); Check(false); }
    return job;
  }
  static int[] Pids(IntPtr job) {
    for (int bytes=4096;bytes<=1048576;bytes*=2) {
      IntPtr buffer=Marshal.AllocHGlobal(bytes);
      try {
        int returned;
        if (!QueryInformationJobObject(job,3,buffer,bytes,out returned)) {
          if (Marshal.GetLastWin32Error()==234) continue;
          Check(false);
        }
        int count=Marshal.ReadInt32(buffer,4);
        if (count<0 || 8+count*IntPtr.Size>bytes) throw new Exception();
        var pids=new int[count];
        for(int i=0;i<count;i++) pids[i]=Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt32();
        return pids;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new Exception();
  }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') b.Append('\\',slashes*2+1).Append(c);
      else b.Append('\\',slashes).Append(c);
      slashes=0;
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  static IntPtr Pointer<T>(T value,List<IntPtr> memory) {
    var pointer=Marshal.AllocHGlobal(Marshal.SizeOf(value)); memory.Add(pointer);
    Marshal.StructureToPtr(value,pointer,false); return pointer;
  }
  static void Attribute(IntPtr list,int key,IntPtr pointer,int size) {
    Check(UpdateProcThreadAttribute(list,0,new IntPtr(key),pointer,new IntPtr(size),IntPtr.Zero,IntPtr.Zero));
  }
  static IntPtr Capability(string name) {
    IntPtr groups,caps; uint groupCount,capCount;
    Check(DeriveCapabilitySidsFromName(name,out groups,out groupCount,out caps,out capCount));
    try {
      for(int i=0;i<groupCount;i++) LocalFree(Marshal.ReadIntPtr(groups,i*IntPtr.Size));
      if(capCount!=1) throw new Exception();
      return Marshal.ReadIntPtr(caps);
    } finally { LocalFree(groups); LocalFree(caps); }
  }
  static Task Relay(IntPtr handle,Stream output,string name) {
    return Task.Factory.StartNew(delegate {
      using(var input=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,8192,false)) {
        byte[] buffer=new byte[8192]; int count; bool first=true;
        while((count=input.Read(buffer,0,buffer.Length))>0) {
          if(first) { Trace(name+" first bytes="+count); first=false; }
          output.Write(buffer,0,count); output.Flush();
        }
        Trace(name+" closed");
      }
    },TaskCreationOptions.LongRunning);
  }
  static IEnumerable<string> Tree(string root,Action reparse=null) {
    var pending=new Stack<string>(); pending.Push(root);
    while(pending.Count>0) {
      string file=pending.Pop();
      var attributes=File.GetAttributes(file);
      if((attributes & FileAttributes.ReparsePoint)!=0) { if(reparse!=null) reparse(); continue; }
      yield return file;
      if((attributes & FileAttributes.Directory)!=0) foreach(var child in Directory.EnumerateFileSystemEntries(file)) pending.Push(child);
    }
  }
  static Grant PrepareGrant(string root,uint rights) {
    var grant=new Grant { root=root,rights=rights }; grant.boundaries.Add(root);
    int count=0;
    foreach(string file in Tree(root,delegate { grant.propagate=false; })) {
      if(++count==2048 || count%32768==0) Trace("preflight objects="+count);
      FileIdentity identity; IntPtr handle=CheckedFile(file,0x20080,out identity);
      try {
        if((rights & 0x116)!=0 && (identity.attributes & 0x10)==0 && identity.links>1 && !credentialIdentities.Contains(identity.Key)) throw new Exception();
        IntPtr owner,group,dacl,sacl,descriptor;
        CheckCode(GetSecurityInfo(handle,1,DACL,out owner,out group,out dacl,out sacl,out descriptor));
        try {
          ushort control; uint revision; Check(GetSecurityDescriptorControl(descriptor,out control,out revision));
          if((control & 0x1000)!=0 && !String.Equals(root,file,StringComparison.OrdinalIgnoreCase)) grant.boundaries.Add(file);
        } finally { LocalFree(descriptor); }
      } finally { CloseHandle(handle); }
    }
    Trace("preflight complete objects="+count);
    return grant;
  }
  static void ApplyGrant(Grant grant,IntPtr sid) {
    // A link-bearing tree keeps the previous object-by-object grants; never propagate across an alias.
    foreach(string file in grant.propagate ? grant.boundaries : Tree(grant.root)) {
      if(grant.rights==RX && Allows(FileAcl(file),PackageSids[1],RX)) continue;
      Acl(file,sid,grant.rights,false,false,true,grant.propagate);
    }
  }
  static bool Under(string root,string file) {
    root=Path.GetFullPath(root).TrimEnd('\\'); file=Path.GetFullPath(file).TrimEnd('\\');
    return String.Equals(root,file,StringComparison.OrdinalIgnoreCase) || file.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase);
  }
  static void VerifyBlocked(Plan plan,IntPtr process) {
    IntPtr token,duplicate; Check(OpenProcessToken(process,10,out token));
    try { Check(DuplicateToken(token,2,out duplicate)); } finally { CloseHandle(token); }
    IntPtr privileges=Marshal.AllocHGlobal(1024);
    var mapping=new Mapping { read=0x120089,write=0x120116,execute=0x1200a0,all=0x1f01ff };
    try {
      var roots=new List<string>();
      foreach(string root in (plan.blockedPaths ?? new string[0]).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(file=>file.Length)) {
        if(!roots.Any(parent=>Under(parent,root))) roots.Add(root);
      }
      foreach(string root in roots) {
        // A deliberately broad pre-existing AppContainer ACE must not make protected material readable.
        // This inspects security metadata only; protected file contents never enter the host's output.
        try { File.GetAttributes(root); }
        catch(FileNotFoundException) { continue; } catch(DirectoryNotFoundException) { continue; }
        foreach(string file in Tree(root)) {
          if(Under(plan.labRoot,file) && (plan.readRoots ?? new string[0]).Any(admitted=>Under(plan.labRoot,admitted) && Under(admitted,file))) continue;
          if((plan.credentialFiles ?? new string[0]).Any(admitted=>String.Equals(admitted,file,StringComparison.OrdinalIgnoreCase))) continue;
          IntPtr owner,group,dacl,sacl,descriptor;
          CheckCode(GetNamedSecurityInfoW(file,1,7,out owner,out group,out dacl,out sacl,out descriptor));
          try {
            uint length=1024,granted; bool readable;
            Check(AccessCheck(descriptor,duplicate,1,ref mapping,privileges,ref length,out granted,out readable));
            if(readable) throw new Exception();
          } finally { LocalFree(descriptor); }
        }
      }
    } finally { Marshal.FreeHGlobal(privileges); CloseHandle(duplicate); }
  }
  static void WriteLease(string manifest,Lease lease) {
    string temporary=manifest+".tmp";
    File.WriteAllText(temporary,json.Serialize(lease));
    if(File.Exists(manifest)) File.Replace(temporary,manifest,null); else File.Move(temporary,manifest);
  }
  static void Clean(string manifest) {
    Stage("cleanup lease lock");
    using(var guard=new LeaseGuard(manifest)) {
      if (!File.Exists(manifest)) return;
      Lease lease;
      try { lease=json.Deserialize<Lease>(File.ReadAllText(manifest)); } catch(FileNotFoundException) { return; }
      Stage("cleanup launcher exit");
      if(lease.launcherPid>0) {
        Process launcher=null;
        try { launcher=Process.GetProcessById(lease.launcherPid); }
        catch(ArgumentException) { }
        if(launcher!=null) using(launcher) {
          try { if(launcher.StartTime.ToUniversalTime().Ticks==lease.launcherCreated) launcher.WaitForExit(); }
          catch(InvalidOperationException) { }
          catch(Win32Exception error) { if(error.NativeErrorCode!=87 && error.NativeErrorCode!=1168) throw; }
        }
      }
      IntPtr sid; Check(ConvertStringSidToSidW(lease.sid,out sid));
      try {
        Exception failure=null;
        Stage("cleanup ACL"); int count=0;
        // Workers may have created links or protected DACLs. Remove only our SID, without propagating other ACEs.
        foreach(string root in lease.roots ?? new string[0]) {
          try {
            if(!File.Exists(root) && !Directory.Exists(root)) continue;
            foreach(string file in Tree(root)) {
              try { Acl(file,sid,0,true); } catch(Exception error) { failure=error; }
              if(++count==2048 || count%32768==0) Trace("cleanup objects="+count);
            }
          } catch(Exception error) { failure=error; }
        }
        foreach(var file in (lease.paths ?? new string[0]).Reverse()) { try { Acl(file,sid,0,true); } catch(Exception error) { failure=error; } }
        if(!String.IsNullOrEmpty(lease.profile)) {
          uint code=unchecked((uint)DeleteAppContainerProfile(lease.profile));
          if(code!=0 && code!=0x80070002 && code!=0x80070490) failure=new Win32Exception((int)code);
        }
        if(failure!=null) throw failure;
        File.Delete(manifest);
        Trace("cleanup complete objects="+count);
      }
      finally { LocalFree(sid); }
    }
  }
  static int Run(Plan plan,TextReader control) {
    Stage("run lease lock");
    using(var guard=new LeaseGuard(plan.manifest)) {
      Stage("identity");
      Id(plan.runId); Id(plan.job);
      string profile="agentrix.lab."+plan.runId.Substring(0,8)+"."+plan.job.Replace("-","");
      IntPtr sid; CheckCode((uint)CreateAppContainerProfile(profile,profile,"Agentrix isolated lab run",IntPtr.Zero,0,out sid));
      var paths=new List<string>(); var memory=new List<IntPtr>(); var handles=new List<IntPtr>();
      var lifetime=new RunLifetime();
      Task.Factory.StartNew(delegate {
        try { control.Read(); Trace("control cancelled"); } finally { lifetime.Stop(); }
      },TaskCreationOptions.LongRunning);
      IntPtr descriptor=IntPtr.Zero,list=IntPtr.Zero; PI process=new PI();
      try {
        Lease lease;
        using(var launcher=Process.GetCurrentProcess()) lease=new Lease { sid=SidString(sid),profile=profile,paths=new string[0],
          roots=new string[0],launcherPid=launcher.Id,launcherCreated=launcher.StartTime.ToUniversalTime().Ticks };
        WriteLease(plan.manifest,lease);
        descriptor=Descriptor();
        IntPtr run=NewJob(JobName(plan.runId,null),descriptor); handles.Add(run);
        IntPtr job=NewJob(JobName(plan.runId,plan.job),descriptor); handles.Add(job); lifetime.Bind(job);
        lifetime.CheckRunning();
        foreach(string file in plan.credentialFiles ?? new string[0]) {
          FileIdentity identity; IntPtr handle=CheckedFile(file,0x20080,out identity);
          try { credentialIdentities.Add(identity.Key); } finally { CloseHandle(handle); }
        }
        // Write the undo record before granting access, so even a killed launcher can be recovered.
        Stage("root preflight");
        var grants=(plan.readRoots ?? new string[0]).Distinct(StringComparer.OrdinalIgnoreCase).Select(root=>PrepareGrant(root,RX))
          .Concat((plan.writeRoots ?? new string[0]).Distinct(StringComparer.OrdinalIgnoreCase).Select(root=>PrepareGrant(root,MODIFY))).ToArray();
        paths.AddRange(plan.credentialFiles ?? new string[0]); paths.AddRange(plan.pipes ?? new string[0]);
        var ancestors=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var file in (plan.readRoots ?? new string[0]).Concat(plan.writeRoots ?? new string[0])) {
          var parent=Directory.GetParent(file);
          while(parent!=null) { ancestors.Add(parent.FullName); parent=parent.Parent; }
        }
        paths.AddRange(ancestors);
        paths=paths.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        lease.paths=paths.ToArray(); lease.roots=grants.Select(grant=>grant.root).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        WriteLease(plan.manifest,lease);
        lifetime.CheckRunning();
        Stage("profile ACL");
        IntPtr profilePath; CheckCode((uint)GetAppContainerFolderPath(SidString(sid),out profilePath));
        try { foreach(var file in Tree(Directory.GetParent(Marshal.PtrToStringUni(profilePath)).FullName)) Acl(file,sid,0xd0156,false,true); }
        finally { Marshal.FreeCoTaskMem(profilePath); }
        Stage("ancestor metadata ACL");
        foreach(var ancestor in ancestors) {
          if(Allows(FileAcl(ancestor),PackageSids[1],METADATA)) continue;
          // Traversal is supplied by SeChangeNotifyPrivilege. Metadata grants help tools that stat
          // their parents, but must not require rewriting system-owned ancestors such as Users/.
          try { Acl(ancestor,sid,METADATA,false,false,false); }
          catch(Win32Exception aclError) { if(aclError.NativeErrorCode!=5) throw; }
        }
        Stage("root ACL");
        foreach(var grant in grants) { lifetime.CheckRunning(); ApplyGrant(grant,sid); }
        foreach(var file in plan.credentialFiles ?? new string[0]) Acl(file,sid,MODIFY,false);
        Stage("pipe ACL");
        foreach(var pipe in plan.pipes ?? new string[0]) PipeAcl(pipe,sid);
        IntPtr inRead,inWrite,outRead,outWrite,errRead,errWrite;
        var inherit=new SA { size=Marshal.SizeOf(typeof(SA)),inherit=1 };
        Stage("stdio");
        Check(CreatePipe(out inRead,out inWrite,ref inherit,0)); handles.Add(inRead); handles.Add(inWrite);
        Check(CreatePipe(out outRead,out outWrite,ref inherit,0)); handles.Add(outRead); handles.Add(outWrite);
        Check(CreatePipe(out errRead,out errWrite,ref inherit,0)); handles.Add(errRead); handles.Add(errWrite);
        foreach(var handle in new[]{inWrite,outRead,errRead}) Check(SetHandleInformation(handle,1,0));
        IntPtr length=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,4,0,ref length);
        Stage("attributes");
        list=Marshal.AllocHGlobal(length); Check(InitializeProcThreadAttributeList(list,4,0,ref length));
        // Winsock initialization reads its system catalog even when the phase has no network capability.
        var capabilitySids=new List<IntPtr>(); capabilitySids.Add(Capability("registryRead"));
        if(plan.network) capabilitySids.Add(Capability("internetClient"));
        memory.AddRange(capabilitySids);
        IntPtr capArray=Marshal.AllocHGlobal(capabilitySids.Count*Marshal.SizeOf(typeof(SidAttr))); memory.Add(capArray);
        for(int i=0;i<capabilitySids.Count;i++) Marshal.StructureToPtr(new SidAttr { sid=capabilitySids[i],attributes=4 },
          IntPtr.Add(capArray,i*Marshal.SizeOf(typeof(SidAttr))),false);
        var caps=new Cap { sid=sid,capabilities=capArray,count=capabilitySids.Count };
        Attribute(list,0x20009,Pointer(caps,memory),Marshal.SizeOf(caps));
        Attribute(list,0x2000f,Pointer(1,memory),4); // ALL_APPLICATION_PACKAGES opt-out: LPAC.
        IntPtr jobs=Marshal.AllocHGlobal(2*IntPtr.Size); memory.Add(jobs); Marshal.WriteIntPtr(jobs,0,run); Marshal.WriteIntPtr(jobs,IntPtr.Size,job);
        Attribute(list,0x2000d,jobs,2*IntPtr.Size);
        IntPtr stdio=Marshal.AllocHGlobal(3*IntPtr.Size); memory.Add(stdio);
        int offset=0; foreach(var handle in new[]{inRead,outWrite,errWrite}) { Marshal.WriteIntPtr(stdio,offset,handle); offset+=IntPtr.Size; }
        Attribute(list,0x20002,stdio,3*IntPtr.Size);
        var start=new SX(); start.info.cb=Marshal.SizeOf(start); start.attributes=list;
        start.info.flags=0x100; start.info.input=inRead; start.info.output=outWrite; start.info.error=errWrite;
        string environment=String.Join("\0",plan.env.OrderBy(e=>e.Key,StringComparer.OrdinalIgnoreCase).Select(e=>e.Key+"="+e.Value))+"\0\0";
        IntPtr env=Marshal.StringToHGlobalUni(environment); memory.Add(env);
        var security=new SA { size=Marshal.SizeOf(typeof(SA)),descriptor=descriptor };
        string arguments=Quote(plan.file)+" "+String.Join(" ",(plan.args ?? new string[0]).Select(Quote));
        Stage("process creation");
        lifetime.CheckRunning();
        Check(CreateProcessW(plan.file,new StringBuilder(arguments),ref security,ref security,true,0x08080404,env,plan.cwd,ref start,out process));
        handles.Add(process.process); handles.Add(process.thread);
        Trace("worker created pid="+process.pid);
        Stage("protected paths"); VerifyBlocked(plan,process.process);
        foreach(var handle in new[]{inRead,outWrite,errWrite}) { CloseHandle(handle); handles.Remove(handle); }
        Task output=Relay(outRead,Console.OpenStandardOutput(),"stdout"),error=Relay(errRead,Console.OpenStandardError(),"stderr");
        handles.Remove(outRead); handles.Remove(errRead);
        Task input=Task.Factory.StartNew(delegate {
          Trace("payload write begin");
          try {
            using(var stream=new FileStream(new SafeFileHandle(inWrite,true),FileAccess.Write,8192,false)) {
              byte[] bytes=Encoding.UTF8.GetBytes(plan.input ?? ""); stream.Write(bytes,0,bytes.Length);
            }
            Trace("payload write closed");
          } catch(Exception inputError) {
            lifetime.Stop(); Trace("payload write failed hresult="+inputError.HResult); throw;
          }
        },TaskCreationOptions.LongRunning); handles.Remove(inWrite);
        Stage("worker resume");
        lifetime.Resume(process.thread);
        Stage("worker running");
        WaitForSingleObject(process.process,0xffffffff); uint code; Check(GetExitCodeProcess(process.process,out code));
        Trace("worker exited code="+code);
        Check(TerminateJobObject(job,1));
        for(int i=0;i<200 && Pids(job).Length>0;i++) System.Threading.Thread.Sleep(10);
        if(Pids(job).Length>0) throw new Exception();
        Stage("stdio drain");
        Task.WaitAll(output,error); input.Wait();
        return (int)code;
      } finally {
        Stage("launcher release");
        lifetime.Dispose();
        if(list!=IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
        foreach(var handle in handles.AsEnumerable().Reverse()) if(handle!=IntPtr.Zero) CloseHandle(handle);
        foreach(var pointer in memory) Marshal.FreeHGlobal(pointer);
        LocalFree(descriptor); FreeSid(sid);
        // The host is the only cleaner. Its lease lock and process wait cover normal exits, stops and crashes.
        if(!File.Exists(plan.manifest)) DeleteAppContainerProfile(profile);
      }
    }
  }
  public static int Main(string[] args) {
    try {
      Check(SetDefaultDllDirectories(0x800)); // Subsequent native loads use System32; preparation starts in a protected directory.
      if(args.Length==1 && args[0]=="host-ready") { Console.Write(json.Serialize(new { ready=HostReady(),elevated=Elevated() })); return 0; }
      if(args.Length==1 && args[0]=="prepare-host") return PrepareHost();
      if(args.Length==1 && args[0]=="run") {
        // The host writes UTF-8. Keep this reader alive for cancellation without Console's OEM decoder.
        var control=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true),false,4096);
        Stage("frame read"); string frame=control.ReadLine();
        if(frame==null || frame.Length>16777216) throw new Exception();
        Trace("frame chars="+frame.Length);
        var plan=json.Deserialize<Plan>(frame); Stage("frame parsed");
        return Run(plan,control);
      }
      if(args.Length==2 && args[0]=="clean") { Clean(args[1]); return 0; }
      if(args.Length>=2 && (args[0]=="list" || args[0]=="kill")) {
        string name=JobName(args[1],args.Length>2?args[2]:null);
        IntPtr job=OpenJobObjectW(args[0]=="kill"?0x1f003fU:4U,false,name);
        if(job==IntPtr.Zero) { int code=Marshal.GetLastWin32Error(); if(code!=2) throw new Win32Exception(code); Console.Write("[]"); return 0; }
        try {
          if(args[0]=="kill") { Check(TerminateJobObject(job,1)); for(int i=0;i<500 && Pids(job).Length>0;i++) System.Threading.Thread.Sleep(10); }
          int[] pids=Pids(job); if(args[0]=="kill" && pids.Length>0) throw new Exception();
          Console.Write(json.Serialize(pids)); return 0;
        } finally { CloseHandle(job); }
      }
      return 2;
    } catch(Win32Exception error) { Console.Error.Write("Windows lab isolation failed at "+stage+" ("+error.NativeErrorCode+")."); return 125; }
      catch { Console.Error.Write("Windows lab isolation failed at "+stage+"."); return 125; }
  }
}
`;
