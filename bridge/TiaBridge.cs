using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
#if !TIA_V16
using Siemens.Engineering.Connection;
using Siemens.Engineering.Download;
using Siemens.Engineering.Download.Configurations;
using Siemens.Engineering.Online;
using Siemens.Engineering.SW.TechnologicalObjects;
#else
using System.Xml;
#endif
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

namespace TiaBridge
{
    public static class Program
    {
#if TIA_V16
        internal const string PortalVersion = "16";
#else
        internal const string PortalVersion = "20";
#endif
        private static string PublicApiDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            @"Siemens\Automation\Portal V" + PortalVersion + @"\PublicAPI\V" + PortalVersion);
#if !TIA_V16
        private static string PlcsimRuntimeDir = @"C:\Program Files\Siemens\Automation\PLCSIM_V20\resources\bin\wwwroot\assets\lib\runtime";

#endif

        [STAThread]
        public static int Main(string[] args)
        {
            string envDir = Environment.GetEnvironmentVariable("TIA_PUBLIC_API_DIR");
            if (!string.IsNullOrEmpty(envDir))
            {
                PublicApiDir = envDir;
            }
#if !TIA_V16
            string envSimDir = Environment.GetEnvironmentVariable("TIA_PLCSIM_RUNTIME_DIR");
            if (!string.IsNullOrEmpty(envSimDir) && Directory.Exists(envSimDir))
            {
                PlcsimRuntimeDir = envSimDir;
            }
            PrependNativePaths();
#endif
            AppDomain.CurrentDomain.AssemblyResolve += ResolveOpennessAssembly;

            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            try
            {
                string assemblyPath = Path.Combine(PublicApiDir, "Siemens.Engineering.dll");
                AssemblyName api = AssemblyName.GetAssemblyName(assemblyPath);
                if (api.Name != "Siemens.Engineering" || api.Version.Major.ToString(CultureInfo.InvariantCulture) != PortalVersion)
                    throw new InvalidOperationException("Expected Siemens.Engineering V" + PortalVersion + " at " + assemblyPath + "; found " + api.FullName + ".");
                return RunHost();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("FATAL: " + ex.ToString());
                return 1;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static int RunHost()
        {
            BridgeHost host = new BridgeHost();
            return host.RunLoop();
        }

#if !TIA_V16
        private static void PrependNativePaths()
        {
            string[] extraDirs = new string[]
            {
                PlcsimRuntimeDir,
                @"C:\Program Files\Siemens\Automation\PLCSIM_V20\resources\bin\wwwroot\assets\lib\vplc",
                @"C:\Program Files\Siemens\Automation\PLCSIM_V20\resources\bin",
                @"C:\Program Files\Common Files\Siemens\Automation\Simatic OAM\bin",
                @"C:\Program Files\Common Files\Siemens\Automation\PlcSim"
            };
            string curPath = Environment.GetEnvironmentVariable("PATH") ?? "";
            List<string> valid = new List<string>();
            foreach (string d in extraDirs)
            {
                if (!string.IsNullOrEmpty(d) && Directory.Exists(d)) valid.Add(d);
            }
            if (valid.Count > 0)
            {
                Environment.SetEnvironmentVariable("PATH", string.Join(";", valid.ToArray()) + ";" + curPath);
            }
        }

#endif

        private static Assembly ResolveOpennessAssembly(object sender, ResolveEventArgs args)
        {
            AssemblyName requested = new AssemblyName(args.Name);
            string candidate = Path.Combine(PublicApiDir, requested.Name + ".dll");
            if (File.Exists(candidate))
            {
                return Assembly.LoadFrom(candidate);
            }
#if !TIA_V16
            string simCandidate = Path.Combine(PlcsimRuntimeDir, requested.Name + ".dll");
            if (File.Exists(simCandidate))
            {
                return Assembly.LoadFrom(simCandidate);
            }
#endif
            return null;
        }
    }

    internal partial class BridgeHost
    {
        private readonly JavaScriptSerializer _json;
        private TiaPortal _tia;
        private Project _project;
        private bool _attachedExisting;
        private string _mode = "none";
        partial void ClearHandles();

        public BridgeHost()
        {
            _json = new JavaScriptSerializer();
            _json.MaxJsonLength = int.MaxValue;
        }

        public int RunLoop()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;

                object reqId = null;
                try
                {
                    Dictionary<string, object> req = _json.Deserialize<Dictionary<string, object>>(line);
                    if (req == null) continue;
                    req.TryGetValue("id", out reqId);
                    string cmd = GetStr(req, "cmd", "");
                    Dictionary<string, object> args = GetDict(req, "args");
                    if (cmd == "shutdown")
                    {
                        WriteReply(reqId, true, new Dictionary<string, object> { { "bye", true } }, null);
                        break;
                    }
                    object data = Dispatch(cmd, args);
                    WriteReply(reqId, true, data, null);
                }
                catch (Exception ex)
                {
                    Exception inner = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
                    WriteReply(reqId, false, null, FormatException(inner));
                }
            }
            return 0;
        }

        private void WriteReply(object id, bool ok, object data, string error)
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["id"] = id;
            res["ok"] = ok;
            if (ok) res["data"] = data;
            else res["error"] = error;
            Console.Out.WriteLine(_json.Serialize(res));
            Console.Out.Flush();
        }

        private string FormatException(Exception ex)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append(ex.GetType().Name).Append(": ").Append(ex.Message);
            if (ex.InnerException != null)
            {
                sb.Append(" | Inner: ").Append(ex.InnerException.GetType().Name).Append(": ").Append(ex.InnerException.Message);
            }
            if (ex is SecurityException || ex.Message.IndexOf("Openness", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                sb.Append(" [Hint: Ensure your Windows user is in the local group 'Siemens TIA Openness' and you have signed out/in, then accept the TIA Openness firewall dialog if shown.]");
            }
            return sb.ToString();
        }

        private object Dispatch(string cmd, Dictionary<string, object> args)
        {
            switch (cmd)
            {
                case "status": return CmdStatus();
                case "connect": return CmdConnect(args);
                case "disconnect": return CmdDisconnect(args);
                case "open_project": return CmdOpenProject(args);
                case "create_project": return CmdCreateProject(args);
                case "save_project": return CmdSaveProject(args);
                case "close_project": return CmdCloseProject();
                case "list_devices": return CmdListDevices();
                case "list_blocks": return CmdListBlocks(args);
                case "list_tags": return CmdListTags(args);
                case "upsert_tags": return CmdUpsertTags(args);
                case "list_types": return CmdListTypes(args);
                case "list_tech_objects": return CmdListTechObjects(args);
                case "existing_object": return CmdExistingObject(args);
                case "export_block": return CmdExportBlock(args);
                case "import_block": return CmdImportBlock(args);
                case "delete_block": return CmdDeleteBlock(args);
                case "export_type": return CmdExportType(args);
                case "import_type": return CmdImportType(args);
                case "delete_type": return CmdDeleteType(args);
                case "compile": return CmdCompile(args);
#if !TIA_V16
                case "sim_launch": return CmdSimLaunch(args);
                case "list_connections": return CmdListConnections(args);
                case "download": return CmdDownload(args);
                case "online": return CmdOnline(args);
                case "station_upload": return CmdStationUpload(args);
                case "watch_table": return CmdWatchTable(args);
                case "show_in_editor": return CmdShowInEditor(args);
                case "scl_source": return CmdSclSource(args);
                case "cross_reference": return CmdCrossReference(args);
                case "hardware_config": return CmdHardwareConfig(args);
                case "network_config": return CmdNetworkConfig(args);
                case "plcsim_runtime": return CmdPlcsimRuntime(args);
                case "sim_codec_self_test": return CmdSimCodecSelfTest();
                case "escape_hatch": return CmdEscapeHatch(args);
#else
                case "sim_codec_self_test": return new { skipped = true, reason = "V16 bridge profile" };
#endif
                default: throw new NotSupportedException("Bridge command '" + cmd + "' is unavailable in the TIA V" + Program.PortalVersion + " profile.");
            }
        }

        // -------------------- Helpers --------------------
        private static Dictionary<string, object> GetDict(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v is Dictionary<string, object>) return (Dictionary<string, object>)v;
            return new Dictionary<string, object>();
        }

        private static string GetStr(Dictionary<string, object> d, string key, string def)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null) return Convert.ToString(v, CultureInfo.InvariantCulture);
            return def;
        }

        private static bool GetBool(Dictionary<string, object> d, string key, bool def)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                if (v is bool) return (bool)v;
                bool b;
                if (bool.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out b)) return b;
            }
            return def;
        }

        private static int GetInt(Dictionary<string, object> d, string key, int def)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                int n;
                if (int.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out n)) return n;
            }
            return def;
        }

        private static bool IsInOpennessGroup()
        {
            try
            {
                WindowsIdentity id = WindowsIdentity.GetCurrent();
                WindowsPrincipal wp = new WindowsPrincipal(id);
                return wp.IsInRole("Siemens TIA Openness") || wp.IsInRole(Environment.MachineName + @"\Siemens TIA Openness");
            }
            catch
            {
                return false;
            }
        }

        private void EnsureConnected()
        {
            if (_tia == null) throw new InvalidOperationException("Not connected to TIA Portal V" + Program.PortalVersion + ". Call tia_connect first.");
        }

        private void EnsureProject()
        {
            EnsureConnected();
            if (_project == null)
            {
                if (_tia.Projects != null && _tia.Projects.Count > 0)
                {
                    _project = _tia.Projects[0];
                }
                else
                {
                    throw new InvalidOperationException("No TIA Portal project is open. Call tia_open_project first.");
                }
            }
        }

        private class PlcTarget
        {
            public Device Device;
            public DeviceItem CpuItem;
            public PlcSoftware Software;
        }

        private List<PlcTarget> FindPlcs()
        {
            EnsureProject();
            List<PlcTarget> list = new List<PlcTarget>();
            foreach (Device dev in _project.Devices)
            {
                CollectPlcItems(dev, dev.DeviceItems, list);
            }
            foreach (DeviceUserGroup grp in _project.DeviceGroups)
            {
                CollectPlcInGroup(grp, list);
            }
            return list;
        }

        private void CollectPlcInGroup(DeviceUserGroup grp, List<PlcTarget> list)
        {
            foreach (Device dev in grp.Devices) CollectPlcItems(dev, dev.DeviceItems, list);
            foreach (DeviceUserGroup sub in grp.Groups) CollectPlcInGroup(sub, list);
        }

        private void CollectPlcItems(Device dev, DeviceItemComposition items, List<PlcTarget> list)
        {
            foreach (DeviceItem item in items)
            {
                SoftwareContainer sc = item.GetService<SoftwareContainer>();
                if (sc != null && sc.Software is PlcSoftware)
                {
                    list.Add(new PlcTarget { Device = dev, CpuItem = item, Software = (PlcSoftware)sc.Software });
                }
                if (item.DeviceItems != null && item.DeviceItems.Count > 0)
                {
                    CollectPlcItems(dev, item.DeviceItems, list);
                }
            }
        }

        // A device, CPU or software name is accepted only if it selects exactly one PLC for a write.
        internal static int SelectPlcIndex(string[][] names, string requested, bool forWrite)
        {
            if (names.Length == 0) throw new InvalidOperationException("No PLC software found in the open project.");
            string choices = string.Join(", ", names.Select(n => n[0] + " (" + n[1] + ")").ToArray());
            if (string.IsNullOrWhiteSpace(requested))
            {
                if (forWrite && names.Length > 1) throw new ArgumentException("Multiple PLCs: specify plcName for this write. Available: " + choices);
                return 0;
            }
            var matches = Enumerable.Range(0, names.Length).Where(i => names[i].Contains(requested, StringComparer.OrdinalIgnoreCase)).ToArray();
            if (matches.Length == 0) throw new ArgumentException("PLC '" + requested + "' not found. Available: " + choices);
            if (forWrite && matches.Length > 1) throw new ArgumentException("Ambiguous plcName '" + requested + "'. Specify a unique device or CPU name. Available: " + choices);
            return matches[0];
        }

        private PlcTarget ResolvePlc(Dictionary<string, object> args, bool forWrite = false)
        {
            List<PlcTarget> plcs = FindPlcs();
            string[][] names = plcs.Select(p => new[] { p.CpuItem.Name, p.Device.Name, p.Software.Name }).ToArray();
            return plcs[SelectPlcIndex(names, GetStr(args, "plcName", ""), forWrite)];
        }

        // -------------------- Commands --------------------
        private object CmdStatus()
        {
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["portalVersion"] = Program.PortalVersion;
            res["user"] = Environment.UserDomainName + "\\" + Environment.UserName;
            res["inOpennessGroup"] = IsInOpennessGroup();
            res["connected"] = _tia != null;
            res["mode"] = _mode;
            res["attachedExisting"] = _attachedExisting;
            res["projectOpen"] = false;
            res["projectPath"] = null;
            res["projectName"] = null;

            if (_tia != null)
            {
                try
                {
                    if (_project == null && _tia.Projects.Count > 0) _project = _tia.Projects[0];
                    if (_project != null)
                    {
                        res["projectOpen"] = true;
                        res["projectName"] = _project.Name;
                        res["projectPath"] = _project.Path != null ? _project.Path.FullName : null;
                    }
                }
                catch (Exception ex)
                {
                    res["sessionWarning"] = ex.Message;
                    _tia = null;
                    _project = null;
                }
            }

            List<object> procs = new List<object>();
            try
            {
                foreach (TiaPortalProcess p in TiaPortal.GetProcesses())
                {
                    Dictionary<string, object> info = new Dictionary<string, object>();
                    info["id"] = p.Id;
                    info["mode"] = p.Mode.ToString();
                    info["projectPath"] = p.ProjectPath != null ? p.ProjectPath.FullName : null;
                    procs.Add(info);
                }
                res["opennessAccessible"] = true;
            }
            catch (Exception ex)
            {
                res["opennessAccessible"] = false;
                res["opennessError"] = FormatException(ex);
            }
            res["runningTiaProcesses"] = procs;

#if !TIA_V16
            Process[] simProcs = Process.GetProcessesByName("S7PLCSIMV20");
            res["plcsimV20Running"] = simProcs.Length > 0;
            res["plcsimV20Pids"] = simProcs.Select(x => x.Id).ToArray();
#endif
            return res;
        }

        private object CmdConnect(Dictionary<string, object> args)
        {
            string mode = GetStr(args, "mode", "auto").ToLowerInvariant();
            int pid = GetInt(args, "processId", 0);

            if (_tia != null)
            {
                try
                {
                    int dummy = _tia.Projects.Count;
                    if (mode == "auto" && pid == 0) return CmdStatus();
                }
                catch { }
                try { if (!_attachedExisting) _tia.Dispose(); } catch { }
                _tia = null;
                _project = null;
                ClearHandles();
                _mode = "none";
                _attachedExisting = false;
            }

            if (mode == "attach" || mode == "auto")
            {
                IList<TiaPortalProcess> list = TiaPortal.GetProcesses();
                TiaPortalProcess chosen = null;
                if (pid > 0)
                {
                    chosen = list.FirstOrDefault(p => p.Id == pid);
                    if (chosen == null) throw new InvalidOperationException("TIA Portal process ID " + pid + " not found.");
                }
                else if (list.Count > 0)
                {
                    chosen = list[0];
                }
                if (chosen != null)
                {
                    _tia = chosen.Attach();
                    _attachedExisting = true;
                    _mode = chosen.Mode.ToString();
                    _project = _tia.Projects.Count > 0 ? _tia.Projects[0] : null;
                    return CmdStatus();
                }
                if (mode == "attach")
                {
                    throw new InvalidOperationException("No running TIA Portal V" + Program.PortalVersion + " instance found to attach. Use mode='ui' or mode='headless' to launch a new instance.");
                }
                // auto falls back to UI so user can see TIA Portal
                mode = "ui";
            }

            TiaPortalMode tm = (mode == "headless" || mode == "withoutui")
                ? TiaPortalMode.WithoutUserInterface
                : TiaPortalMode.WithUserInterface;

            _tia = new TiaPortal(tm);
            _attachedExisting = false;
            _mode = tm.ToString();
            _project = null;
            return CmdStatus();
        }

        private object CmdDisconnect(Dictionary<string, object> args)
        {
            bool closeTia = GetBool(args, "closeTia", false);
            if (_tia != null)
            {
                try
                {
                    if (closeTia || !_attachedExisting)
                    {
                        if (closeTia) _tia.Dispose();
                    }
                }
                catch { }
                _tia = null;
                _project = null;
                ClearHandles();
                _mode = "none";
                _attachedExisting = false;
            }
            return new Dictionary<string, object> { { "disconnected", true } };
        }

        private object CmdOpenProject(Dictionary<string, object> args)
        {
            string path = GetStr(args, "path", "");
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("path is required.");
            FileInfo fi = new FileInfo(path);
#if TIA_V16
            if (!string.Equals(fi.Extension, ".ap16", StringComparison.OrdinalIgnoreCase) || GetBool(args, "upgrade", false))
                throw new ArgumentException("The TIA V16 profile opens native .ap16 projects. Select a matching project and omit upgrade.");
#endif
            if (!fi.Exists) throw new FileNotFoundException("TIA Portal project file not found: " + fi.FullName);

            if (_tia == null)
            {
                CmdConnect(new Dictionary<string, object> { { "mode", GetStr(args, "mode", "auto") } });
            }

            if (_tia.Projects.Count > 0)
            {
                Project existing = _tia.Projects[0];
                if (existing.Path != null && string.Equals(existing.Path.FullName, fi.FullName, StringComparison.OrdinalIgnoreCase))
                {
                    _project = existing;
                    return CmdStatus();
                }
                if (GetBool(args, "closeCurrent", false))
                {
                    existing.Close();
                    _project = null;
                    ClearHandles();
                }
                else
                {
                    throw new InvalidOperationException("Another project is already open (" + existing.Name + "). Pass closeCurrent:true or close it first.");
                }
            }

            bool upgrade = GetBool(args, "upgrade", false);
            _project = upgrade ? _tia.Projects.OpenWithUpgrade(fi) : _tia.Projects.Open(fi);
            return CmdStatus();
        }

        private object CmdCreateProject(Dictionary<string, object> args)
        {
            string targetDir = GetStr(args, "directory", "");
            string name = GetStr(args, "name", "");
            if (string.IsNullOrEmpty(targetDir) || string.IsNullOrEmpty(name))
            {
                throw new ArgumentException("directory and name are required.");
            }
            if (_tia == null)
            {
                CmdConnect(new Dictionary<string, object> { { "mode", GetStr(args, "mode", "auto") } });
            }
            if (_tia.Projects.Count > 0)
            {
                if (GetBool(args, "closeCurrent", false))
                {
                    _tia.Projects[0].Close();
                    _project = null;
                    ClearHandles();
                }
                else
                {
                    throw new InvalidOperationException("Another project is already open (" + _tia.Projects[0].Name + "). Pass closeCurrent:true or close it first.");
                }
            }
            DirectoryInfo di = new DirectoryInfo(targetDir);
            if (!di.Exists) di.Create();
            _project = _tia.Projects.Create(di, name);
            try { _project.IsSimulationDuringBlockCompilationEnabled = true; } catch { }
            return CmdStatus();
        }

        private object CmdSaveProject(Dictionary<string, object> args)
        {
            EnsureProject();
            string saveAsPath = GetStr(args, "saveAsDirectory", "");
            if (!string.IsNullOrEmpty(saveAsPath))
            {
                DirectoryInfo di = new DirectoryInfo(saveAsPath);
                _project.SaveAs(di);
                return new Dictionary<string, object>
                {
                    { "savedAs", true },
                    { "project", _project.Name },
                    { "path", _project.Path != null ? _project.Path.FullName : di.FullName }
                };
            }
            _project.Save();
            return new Dictionary<string, object> { { "saved", true }, { "project", _project.Name } };
        }

        private object CmdCloseProject()
        {
            if (_project == null) return new Dictionary<string, object> { { "closed", false }, { "project", null } };
            string name = _project.Name;
            _project.Close();
            _project = null;
            ClearHandles();
            return new Dictionary<string, object> { { "closed", true }, { "project", name } };
        }

        private object CmdListDevices()
        {
            EnsureProject();
            List<object> devices = new List<object>();
            foreach (Device dev in _project.Devices) devices.Add(DescribeDevice(dev, ""));
            foreach (DeviceUserGroup grp in _project.DeviceGroups) CollectDevicesInGroup(grp, "", devices);
            return new Dictionary<string, object> { { "project", _project.Name }, { "devices", devices } };
        }

        private void CollectDevicesInGroup(DeviceUserGroup grp, string prefix, List<object> outList)
        {
            string p = string.IsNullOrEmpty(prefix) ? grp.Name : prefix + "/" + grp.Name;
            foreach (Device dev in grp.Devices) outList.Add(DescribeDevice(dev, p));
            foreach (DeviceUserGroup sub in grp.Groups) CollectDevicesInGroup(sub, p, outList);
        }

        private Dictionary<string, object> DescribeDevice(Device dev, string groupPath)
        {
            List<object> items = new List<object>();
            CollectItemDescriptions(dev.DeviceItems, items);
            return new Dictionary<string, object>
            {
                { "name", dev.Name },
                { "typeIdentifier", dev.TypeIdentifier },
                { "group", groupPath },
                { "items", items }
            };
        }

        private void CollectItemDescriptions(DeviceItemComposition items, List<object> outList)
        {
            foreach (DeviceItem item in items)
            {
                CollectItemDescription(item, outList);
            }
        }

        private static object ReadOptionalAttribute(IEngineeringObject obj, string name)
        {
            if (obj == null) return null;
            try { return obj.GetAttribute(name); }
            catch (Exception) { return null; }
        }

        private void CollectItemDescription(DeviceItem item, List<object> outList)
        {
            SoftwareContainer sc = item.GetService<SoftwareContainer>();
            bool isPlc = sc != null && sc.Software is PlcSoftware;
            List<object> addresses = new List<object>();
            try
            {
                foreach (Address address in item.Addresses)
                {
                    try
                    {
                        Dictionary<string, object> row = new Dictionary<string, object>
                        {
                            { "ioType", address.IoType.ToString() },
                            { "startAddress", address.StartAddress },
                            { "length", address.Length }
                        };
                        object bitOffset = ReadOptionalAttribute(address as IEngineeringObject, "BitOffset");
                        if (bitOffset != null) row["bitOffset"] = bitOffset;
                        addresses.Add(row);
                    }
                    catch (EngineeringException) { }
                }
            }
            catch (EngineeringException) { }

            object hwId = ReadOptionalAttribute(item, "HardwareIdentifier");
            List<long> hwIds = new List<long>();
#if !TIA_V16
            try
            {
                foreach (HwIdentifier id in item.HwIdentifiers) hwIds.Add(id.Identifier);
            }
            catch (EngineeringException) { }
#endif
            hwIds = hwIds.Distinct().ToList();
            if (hwId == null && hwIds.Count == 1) hwId = hwIds[0];
            if (isPlc || !string.IsNullOrEmpty(item.TypeIdentifier) || addresses.Count > 0 || hwId != null || hwIds.Count > 0)
            {
                Dictionary<string, object> row = new Dictionary<string, object>
                {
                    { "name", item.Name },
                    { "typeIdentifier", item.TypeIdentifier },
                    { "isPlc", isPlc },
                    { "plcSoftwareName", isPlc ? sc.Software.Name : null },
                    { "addresses", addresses }
                };
                if (hwId != null) row["hardwareIdentifier"] = hwId;
                if (hwIds.Count > 0) row["hardwareIdentifiers"] = hwIds;
                outList.Add(row);
            }
            if (item.DeviceItems != null && item.DeviceItems.Count > 0) CollectItemDescriptions(item.DeviceItems, outList);
        }

        private object CmdListBlocks(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            List<object> blocks = new List<object>();
            WalkBlockGroup(plc.Software.BlockGroup, "", blocks);
            return new Dictionary<string, object>
            {
                { "plc", plc.CpuItem.Name },
                { "blocks", blocks }
            };
        }

        private void WalkBlockGroup(PlcBlockGroup grp, string path, List<object> outList)
        {
            foreach (PlcBlock b in grp.Blocks)
            {
                string kind = b.GetType().Name;
                if (b is OB) kind = "OB";
                else if (b is FB) kind = "FB";
                else if (b is FC) kind = "FC";
                else if (b is GlobalDB) kind = "GlobalDB";
                else if (b is InstanceDB) kind = "InstanceDB";
#if !TIA_V16
                else if (b is ArrayDB) kind = "ArrayDB";
#endif

                outList.Add(new Dictionary<string, object>
                {
                    { "name", b.Name },
                    { "number", b.Number },
                    { "type", kind },
                    { "language", b.ProgrammingLanguage.ToString() },
                    { "group", path },
                    { "isConsistent", b.IsConsistent },
                    { "isKnowHowProtected", b.IsKnowHowProtected }
                });
            }
            foreach (PlcBlockUserGroup sub in grp.Groups)
            {
                string subPath = string.IsNullOrEmpty(path) ? sub.Name : path + "/" + sub.Name;
                WalkBlockGroup(sub, subPath, outList);
            }
        }

        private PlcBlock FindBlock(PlcBlockGroup grp, string name, out PlcBlockGroup ownerGroup)
        {
            PlcBlock direct = grp.Blocks.Find(name);
            if (direct != null)
            {
                ownerGroup = grp;
                return direct;
            }
            foreach (PlcBlockUserGroup sub in grp.Groups)
            {
                PlcBlock found = FindBlock(sub, name, out ownerGroup);
                if (found != null) return found;
            }
            ownerGroup = null;
            return null;
        }

        private PlcBlockGroup FindOrCreateBlockGroup(PlcBlockSystemGroup root, string groupPath, bool create)
        {
            if (string.IsNullOrEmpty(groupPath)) return root;
            PlcBlockGroup cur = root;
            string[] parts = groupPath.Split(new char[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string part in parts)
            {
                PlcBlockUserGroup next = cur.Groups.Find(part);
                if (next == null)
                {
                    if (!create) throw new InvalidOperationException("Block group not found: " + groupPath);
                    next = cur.Groups.Create(part);
                }
                cur = next;
            }
            return cur;
        }

        private object CmdListTags(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            List<object> tables = new List<object>();
            WalkTagGroup(plc.Software.TagTableGroup, "", tables);
            return new Dictionary<string, object> { { "plc", plc.CpuItem.Name }, { "tables", tables } };
        }

        private void WalkTagGroup(PlcTagTableGroup grp, string path, List<object> outList)
        {
            foreach (PlcTagTable tbl in grp.TagTables)
            {
                List<object> tags = new List<object>();
                foreach (PlcTag t in tbl.Tags)
                {
                    string comment = "";
                    try
                    {
                        if (t.Comment != null && t.Comment.Items != null && t.Comment.Items.Count > 0)
                        {
                            comment = t.Comment.Items[0].Text ?? "";
                        }
                    }
                    catch { }
                    tags.Add(new Dictionary<string, object>
                    {
                        { "name", t.Name },
                        { "address", t.LogicalAddress },
                        { "type", t.DataTypeName },
                        { "comment", comment }
                    });
                }
                outList.Add(new Dictionary<string, object>
                {
                    { "table", tbl.Name },
                    { "group", path },
                    { "isDefault", tbl.IsDefault },
                    { "tags", tags }
                });
            }
            foreach (PlcTagTableUserGroup sub in grp.Groups)
            {
                string subPath = string.IsNullOrEmpty(path) ? sub.Name : path + "/" + sub.Name;
                WalkTagGroup(sub, subPath, outList);
            }
        }

        private PlcTagTable FindTagTable(PlcTagTableGroup grp, string tableName)
        {
            PlcTagTable found = grp.TagTables.Find(tableName);
            if (found != null) return found;
            foreach (PlcTagTableUserGroup sub in grp.Groups)
            {
                found = FindTagTable(sub, tableName);
                if (found != null) return found;
            }
            return null;
        }

        private object CmdUpsertTags(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args, true);
            string tableName = GetStr(args, "table", "Default tag table");
            PlcTagTable tbl = FindTagTable(plc.Software.TagTableGroup, tableName);
            if (tbl == null)
            {
                if (tableName == "Default tag table")
                {
                    tbl = plc.Software.TagTableGroup.TagTables.FirstOrDefault(x => x.IsDefault);
                }
                if (tbl == null)
                {
                    ArrayList requestedDeletes = args.ContainsKey("delete") ? args["delete"] as ArrayList : null;
                    ArrayList requestedTags = args.ContainsKey("tags") ? args["tags"] as ArrayList : null;
                    if (requestedDeletes != null && requestedDeletes.Count > 0 && (requestedTags == null || requestedTags.Count == 0))
                        throw new InvalidOperationException("Tag table '" + tableName + "' not found; delete will not create a table.");
                    tbl = plc.Software.TagTableGroup.TagTables.Create(tableName);
                }
            }

            object rawTags;
            if (!args.TryGetValue("tags", out rawTags) || !(rawTags is ArrayList))
            {
                if (args.ContainsKey("delete")) rawTags = new ArrayList();
                else throw new ArgumentException("tags array is required.");
            }

            List<string> results = new List<string>();
            List<string> warnings = new List<string>();
            ArrayList deleteNames = args.ContainsKey("delete") ? args["delete"] as ArrayList : null;
            if (deleteNames != null)
            {
                foreach (object rawName in deleteNames)
                {
                    string deleteName = Convert.ToString(rawName);
                    PlcTag existing = tbl.Tags.Find(deleteName);
                    if (existing == null) throw new InvalidOperationException("Tag '" + deleteName + "' not found in table '" + tbl.Name + "'.");
                    existing.Delete();
                    results.Add("deleted " + deleteName);
                }
            }
            foreach (object item in (ArrayList)rawTags)
            {
                Dictionary<string, object> td = item as Dictionary<string, object>;
                if (td == null) continue;
                string name = GetStr(td, "name", "");
                string type = GetStr(td, "type", "Bool");
                string addr = GetStr(td, "address", "");
                string comment = GetStr(td, "comment", null);
                if (string.IsNullOrEmpty(name)) continue;

                PlcTag tag = tbl.Tags.Find(name);
                if (tag == null)
                {
                    tag = tbl.Tags.Create(name, type, addr);
                    results.Add("created " + name + " (" + type + " " + addr + ")");
                }
                else
                {
                    if (!string.IsNullOrEmpty(type)) tag.DataTypeName = type;
                    if (!string.IsNullOrEmpty(addr)) tag.LogicalAddress = addr;
                    results.Add("updated " + name + " (" + tag.DataTypeName + " " + tag.LogicalAddress + ")");
                }
                if (comment != null && tag.Comment != null && tag.Comment.Items != null)
                {
                    if (tag.Comment.Items.Count > 0) tag.Comment.Items[0].Text = comment;
                    else warnings.Add("Comment for tag '" + name + "' was not saved: no active project language item is available.");
                }
                else if (comment != null) warnings.Add("Comment for tag '" + name + "' was not saved: multilingual comment is unavailable.");
            }
            return new Dictionary<string, object> { { "table", tbl.Name }, { "changes", results }, { "warnings", warnings } };
        }

        private object CmdListTypes(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            List<object> types = new List<object>();
            WalkTypeGroup(plc.Software.TypeGroup, "", types);
            return new Dictionary<string, object> { { "plc", plc.CpuItem.Name }, { "types", types } };
        }

        private void WalkTypeGroup(PlcTypeGroup grp, string path, List<object> outList)
        {
            foreach (PlcType t in grp.Types)
            {
                outList.Add(new Dictionary<string, object>
                {
                    { "name", t.Name },
                    { "group", path },
                    { "isConsistent", t.IsConsistent }
                });
            }
            foreach (PlcTypeUserGroup sub in grp.Groups)
            {
                string subPath = string.IsNullOrEmpty(path) ? sub.Name : path + "/" + sub.Name;
                WalkTypeGroup(sub, subPath, outList);
            }
        }

        private PlcType FindPlcType(PlcTypeGroup grp, string name)
        {
            PlcType t = grp.Types.Find(name);
            if (t != null) return t;
            foreach (PlcTypeUserGroup sub in grp.Groups)
            {
                t = FindPlcType(sub, name);
                if (t != null) return t;
            }
            return null;
        }

        private object CmdListTechObjects(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            List<object> tos = new List<object>();
#if !TIA_V16
            if (plc.Software.TechnologicalObjectGroup != null)
            {
                WalkTechGroup(plc.Software.TechnologicalObjectGroup, "", tos);
            }
#endif
            return new Dictionary<string, object> { { "plc", plc.CpuItem.Name }, { "technologicalObjects", tos }, { "enumerationSupported", Program.PortalVersion == "20" } };
        }

#if !TIA_V16
        private void WalkTechGroup(TechnologicalInstanceDBGroup grp, string path, List<object> outList)
        {
            foreach (TechnologicalInstanceDB to in grp.TechnologicalObjects)
            {
                outList.Add(new Dictionary<string, object>
                {
                    { "name", to.Name },
                    { "number", to.Number },
                    { "group", path },
                    { "isConsistent", to.IsConsistent }
                });
            }
            foreach (TechnologicalInstanceDBUserGroup sub in grp.Groups)
            {
                string subPath = string.IsNullOrEmpty(path) ? sub.Name : path + "/" + sub.Name;
                WalkTechGroup(sub, subPath, outList);
            }
        }

#endif

        // Resolve and use the same live object in this bridge request, including its actual folder.
        private object CmdExistingObject(Dictionary<string, object> args)
        {
            string action = GetStr(args, "action", "describe");
            if (action != "describe" && action != "export" && action != "import")
                throw new ArgumentException("Expected describe, export or import.");
            PlcTarget plc = ResolvePlc(args, action == "import" || GetBool(args, "forWrite", false));
            string kind = GetStr(args, "kind", "block");
            string name = GetStr(args, "name", "");
            PlcBlock block = null;
            PlcType udt = null;
            PlcBlockGroup blockGroup = null;
            PlcTypeGroup typeGroup = null;
            if (kind == "block") block = FindBlock(plc.Software.BlockGroup, name, out blockGroup);
            else if (kind == "udt")
            {
                udt = FindPlcType(plc.Software.TypeGroup, name);
                if (udt != null) typeGroup = (PlcTypeGroup)udt.Parent;
            }
            else throw new ArgumentException("Expected block or udt.");
            if (block == null && udt == null) throw new InvalidOperationException(kind + " '" + name + "' not found.");

            var folders = new Stack<string>();
            IEngineeringObject parent = block != null ? (IEngineeringObject)blockGroup : typeGroup;
            while (parent is PlcBlockUserGroup || parent is PlcTypeUserGroup)
            {
                folders.Push(parent is PlcBlockUserGroup ? ((PlcBlockUserGroup)parent).Name : ((PlcTypeUserGroup)parent).Name);
                parent = parent.Parent;
            }
            string group = string.Join("/", folders.ToArray());
            if (args.ContainsKey("group") && !string.Equals(GetStr(args, "group", "").Replace('\\', '/').Trim('/'), group, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Requested group does not match the current group: '" + group + "'.");
            var scope = new Dictionary<string, object>
            {
                { "projectPath", Path.GetFullPath(_project.Path.FullName).ToUpperInvariant() },
                { "device", plc.Device.Name }, { "cpu", plc.CpuItem.Name }, { "software", plc.Software.Name },
                { "group", group }, { "kind", kind }, { "name", block != null ? block.Name : udt.Name },
                { "objectType", block != null ? block.GetType().Name : udt.GetType().Name },
                { "number", block != null ? block.Number.ToString(CultureInfo.InvariantCulture) : "" }
            };
            if (action == "describe") return scope;
            FileInfo file = new FileInfo(GetStr(args, "xmlPath", ""));
            if (action == "export")
            {
                if (block != null) block.Export(file, ExportOptions.WithDefaults);
                else udt.Export(file, ExportOptions.WithDefaults);
                return scope;
            }

            var expected = GetDict(args, "expectedScope");
            if (scope.Any(kv => !expected.ContainsKey(kv.Key) || !object.Equals(kv.Value, expected[kv.Key])))
                throw new InvalidOperationException("The project, PLC or object has changed since the snapshot. Import cancelled.");
            ValidateImportXml(file);
            if (block != null) blockGroup.Blocks.Import(file, ImportOptions.Override);
            else typeGroup.Types.Import(file, ImportOptions.Override);
            return new { imported = true, name = scope["name"] };
        }

        private static void ValidateImportXml(FileInfo file)
        {
#if TIA_V16
            using (XmlReader reader = XmlReader.Create(file.FullName))
            {
                reader.MoveToContent();
                if (reader.Name != "Document") throw new InvalidOperationException("Expected a SimaticML Document.");
                bool nativeV16 = false;
                const string nsRoot = "http://www.siemens.com/automation/Openness/SW/";
                while (reader.Read())
                {
                    if (reader.NodeType != XmlNodeType.Element) continue;
                    if (reader.Depth == 1 && reader.Name == "Engineering")
                    {
                        if (reader.GetAttribute("version") != "V16")
                            throw new InvalidOperationException("TIA V16 import requires native V16 SimaticML XML. Export the source from TIA V16.");
                        nativeV16 = true;
                    }
                    string ns = reader.NamespaceURI;
                    foreach (string prefix in new[] { nsRoot + "Interface/v", nsRoot + "NetworkSource/FlgNet/v" })
                    {
                        if (!ns.StartsWith(prefix, StringComparison.Ordinal)) continue;
                        int revision;
                        if (!int.TryParse(ns.Substring(prefix.Length), out revision) || revision < 1 || revision > 4)
                            throw new InvalidOperationException("XML namespace is not supported by the V16 profile: " + ns);
                    }
                }
                if (!nativeV16) throw new InvalidOperationException("Missing Engineering version V16 in SimaticML XML.");
            }
#endif
        }

        private object CmdExportBlock(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            string blockName = GetStr(args, "blockName", "");
            string outPath = GetStr(args, "outPath", "");
            string format = GetStr(args, "format", "xml").ToLowerInvariant();
            if (string.IsNullOrEmpty(blockName)) throw new ArgumentException("blockName is required.");

            PlcBlockGroup owner;
            PlcBlock blk = FindBlock(plc.Software.BlockGroup, blockName, out owner);
            if (blk == null) throw new InvalidOperationException("Block '" + blockName + "' not found in PLC '" + plc.CpuItem.Name + "'.");

#if TIA_V16
            if (format != "xml") throw new NotSupportedException("TIA V16 exports SimaticML XML only. Use format=xml.");
#else
            if (format == "s7dcl")
            {
                DirectoryInfo dir = new DirectoryInfo(outPath);
                if (!dir.Exists) dir.Create();
                DocumentExportResult res = blk.ExportAsDocuments(dir, blk.Name);
                List<string> files = new List<string>();
                foreach (FileInfo f in res.ExportedDocuments) files.Add(f.FullName);
                return new Dictionary<string, object>
                {
                    { "blockName", blk.Name },
                    { "format", "s7dcl" },
                    { "state", res.State.ToString() },
                    { "files", files }
                };
            }
            else
#endif
            {
                FileInfo fi = new FileInfo(outPath);
                if (fi.Directory != null && !fi.Directory.Exists) fi.Directory.Create();
                if (fi.Exists) fi.Delete();
                blk.Export(fi, ExportOptions.WithDefaults);
                return new Dictionary<string, object>
                {
                    { "blockName", blk.Name },
                    { "number", blk.Number },
                    { "language", blk.ProgrammingLanguage.ToString() },
                    { "format", "xml" },
                    { "path", fi.FullName }
                };
            }
        }

        private object CmdImportBlock(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args, true);
            string xmlPath = GetStr(args, "xmlPath", "");
            string groupPath = GetStr(args, "group", "");
            string format = GetStr(args, "format", "xml").ToLowerInvariant();

#if TIA_V16
            if (format != "xml") throw new NotSupportedException("TIA V16 imports SimaticML XML only.");
#else
            if (format == "s7dcl")
            {
                string docName = GetStr(args, "docName", "");
                DirectoryInfo dir = new DirectoryInfo(xmlPath);
                PlcBlockGroup documentGroup = FindOrCreateBlockGroup(plc.Software.BlockGroup, groupPath, true);
                DocumentImportResultForBlocks res = documentGroup.Blocks.ImportFromDocuments(dir, docName, ImportDocumentOptions.Override);
                return new Dictionary<string, object> { { "imported", true }, { "state", res.State.ToString() } };
            }
            else
#endif
            {
                FileInfo fi = new FileInfo(xmlPath);
                if (!fi.Exists) throw new FileNotFoundException("Import XML not found: " + fi.FullName);
                ValidateImportXml(fi);
                PlcBlockGroup targetGrp = FindOrCreateBlockGroup(plc.Software.BlockGroup, groupPath, true);
                IList<PlcBlock> imported = targetGrp.Blocks.Import(fi, ImportOptions.Override);
                return new Dictionary<string, object>
                {
                    { "imported", true },
                    { "blocks", imported.Select(b => b.Name).ToArray() }
                };
            }
        }

        private object CmdDeleteBlock(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args, true);
            string blockName = GetStr(args, "blockName", "");
            PlcBlockGroup owner;
            PlcBlock blk = FindBlock(plc.Software.BlockGroup, blockName, out owner);
            if (blk == null) throw new InvalidOperationException("Block '" + blockName + "' not found.");
            blk.Delete();
            return new Dictionary<string, object> { { "deleted", blockName } };
        }

        private object CmdExportType(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            string typeName = GetStr(args, "typeName", "");
            string outPath = GetStr(args, "outPath", "");
            PlcType t = FindPlcType(plc.Software.TypeGroup, typeName);
            if (t == null) throw new InvalidOperationException("PLC data type '" + typeName + "' not found.");
            FileInfo fi = new FileInfo(outPath);
            if (fi.Directory != null && !fi.Directory.Exists) fi.Directory.Create();
            if (fi.Exists) fi.Delete();
            t.Export(fi, ExportOptions.WithDefaults);
            return new Dictionary<string, object> { { "typeName", t.Name }, { "path", fi.FullName } };
        }

        private object CmdImportType(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args, true);
            string xmlPath = GetStr(args, "xmlPath", "");
            FileInfo fi = new FileInfo(xmlPath);
            if (!fi.Exists) throw new FileNotFoundException("UDT XML not found: " + fi.FullName);
            ValidateImportXml(fi);
            PlcTypeGroup target = plc.Software.TypeGroup;
            foreach (string part in GetStr(args, "group", "").Replace('\\', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries))
                target = target.Groups.Find(part) ?? target.Groups.Create(part);
            IList<PlcType> res = target.Types.Import(fi, ImportOptions.Override);
            return new Dictionary<string, object> { { "imported", true }, { "types", res.Select(x => x.Name).ToArray() } };
        }

        private object CmdDeleteType(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args, true);
            string name = GetStr(args, "typeName", "");
            if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("typeName is required for delete_type.");
            PlcType type = FindPlcType(plc.Software.TypeGroup, name);
            if (type == null) throw new InvalidOperationException("PLC data type '" + name + "' not found.");
            type.Delete();
            return new Dictionary<string, object> { { "deleted", name }, { "plc", plc.CpuItem.Name } };
        }

        private object CmdCompile(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args, true);
            bool enableSim = GetBool(args, "enableSimulation", true);
            bool includeHardware = GetBool(args, "includeHardware", false);

            if (enableSim)
            {
                try { _project.IsSimulationDuringBlockCompilationEnabled = true; }
                catch { }
            }

            List<object> swMsgs = new List<object>();
            ICompilable swComp = plc.Software.GetService<ICompilable>();
            CompilerResult swRes = swComp.Compile();
            CollectCompileMessages(swRes.Messages, swMsgs);

            Dictionary<string, object> output = new Dictionary<string, object>();
            output["plc"] = plc.CpuItem.Name;
            output["simulationSupported"] = _project.IsSimulationDuringBlockCompilationEnabled;
            output["software"] = new Dictionary<string, object>
            {
                { "state", swRes.State.ToString() },
                { "errorCount", swRes.ErrorCount },
                { "warningCount", swRes.WarningCount },
                { "messages", swMsgs }
            };

            if (includeHardware)
            {
                ICompilable hwComp = plc.Device.GetService<ICompilable>();
                if (hwComp != null)
                {
                    CompilerResult hwRes = hwComp.Compile();
                    List<object> hwMsgs = new List<object>();
                    CollectCompileMessages(hwRes.Messages, hwMsgs);
                    output["hardware"] = new Dictionary<string, object>
                    {
                        { "state", hwRes.State.ToString() },
                        { "errorCount", hwRes.ErrorCount },
                        { "warningCount", hwRes.WarningCount },
                        { "messages", hwMsgs }
                    };
                }
            }
            return output;
        }

        private void CollectCompileMessages(CompilerResultMessageComposition msgs, List<object> outList)
        {
            foreach (CompilerResultMessage m in msgs)
            {
                if (!string.IsNullOrEmpty(m.Description))
                {
                    outList.Add(new Dictionary<string, object>
                    {
                        { "state", m.State.ToString() },
                        { "path", m.Path },
                        { "description", m.Description },
                        { "errorCount", m.ErrorCount },
                        { "warningCount", m.WarningCount }
                    });
                }
                if (m.Messages != null && m.Messages.Count > 0)
                {
                    CollectCompileMessages(m.Messages, outList);
                }
            }
        }

#if !TIA_V16
        private object CmdSimLaunch(Dictionary<string, object> args)
        {
            string exe = GetStr(args, "exePath", @"C:\Program Files\Siemens\Automation\PLCSIM_V20\S7PLCSIMV20.exe");
            Process[] existing = Process.GetProcessesByName("S7PLCSIMV20");
            if (existing.Length > 0)
            {
                return new Dictionary<string, object>
                {
                    { "alreadyRunning", true },
                    { "pids", existing.Select(p => p.Id).ToArray() }
                };
            }
            if (!File.Exists(exe)) throw new FileNotFoundException("S7-PLCSIM V20 executable not found: " + exe);

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.WorkingDirectory = Path.GetDirectoryName(exe);
            psi.UseShellExecute = true;
            Process proc = Process.Start(psi);
            return new Dictionary<string, object>
            {
                { "started", true },
                { "pid", proc != null ? proc.Id : 0 },
                { "exe", exe }
            };
        }

        private object CmdListConnections(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            DownloadProvider dp = plc.CpuItem.GetService<DownloadProvider>();
            if (dp == null) throw new InvalidOperationException("DownloadProvider service not available on CPU item.");

            List<object> modes = new List<object>();
            foreach (ConfigurationMode mode in dp.Configuration.Modes)
            {
                List<object> pcs = new List<object>();
                foreach (ConfigurationPcInterface pc in mode.PcInterfaces)
                {
                    List<string> targets = new List<string>();
                    foreach (ConfigurationTargetInterface ti in pc.TargetInterfaces) targets.Add(ti.Name);
                    List<string> subnets = new List<string>();
                    foreach (ConfigurationSubnet sub in pc.Subnets) subnets.Add(sub.Name);
                    pcs.Add(new Dictionary<string, object>
                    {
                        { "name", pc.Name },
                        { "number", pc.Number },
                        { "targetInterfaces", targets },
                        { "subnets", subnets }
                    });
                }
                modes.Add(new Dictionary<string, object> { { "name", mode.Name }, { "pcInterfaces", pcs } });
            }
            return new Dictionary<string, object> { { "plc", plc.CpuItem.Name }, { "modes", modes } };
        }

        private object CmdDownload(Dictionary<string, object> args)
        {
            string requestedPlc = GetStr(args, "plcName", "");
            if (string.IsNullOrWhiteSpace(requestedPlc)) throw new ArgumentException("Download requires an explicit plcName.");
            string requestedPc = GetStr(args, "pcInterface", "");
            if (string.IsNullOrWhiteSpace(requestedPc)) throw new ArgumentException("Download requires an explicit pcInterface.");
            bool simTarget = requestedPc.IndexOf("PLCSIM", StringComparison.OrdinalIgnoreCase) >= 0;
            if (!simTarget && string.IsNullOrWhiteSpace(GetStr(args, "targetAddress", ""))) throw new ArgumentException("Physical PLC download requires targetAddress.");
            PlcTarget plc = ResolvePlc(args, true);
            DownloadProvider dp = plc.CpuItem.GetService<DownloadProvider>();
            if (dp == null) throw new InvalidOperationException("DownloadProvider not available.");

            string modeName = GetStr(args, "mode", "PN/IE");
            string pcFilter = requestedPc;
            string targetAddrStr = GetStr(args, "targetAddress", "");
            int targetIdx = GetInt(args, "targetInterfaceIndex", 0);
            bool startAfter = GetBool(args, "startAfterDownload", false);
            bool includeHardware = GetBool(args, "includeHardware", false);

            ConfigurationMode mode = dp.Configuration.Modes.Find(modeName);
            if (mode == null) throw new InvalidOperationException("Connection mode '" + modeName + "' not found. Available: " + string.Join(", ", dp.Configuration.Modes.Select(m => m.Name).ToArray()));

            ConfigurationPcInterface pc = mode.PcInterfaces.FirstOrDefault(p => string.Equals(p.Name, pcFilter, StringComparison.OrdinalIgnoreCase));
            if (pc == null)
            {
                throw new InvalidOperationException("Exact PC interface name '" + pcFilter + "' not found. Available: " + string.Join(", ", mode.PcInterfaces.Select(x => x.Name).ToArray()));
            }
            if (pc.TargetInterfaces.Count == 0 && pc.Subnets.Count == 0) throw new InvalidOperationException("No target interface or subnet on " + pc.Name);

            IConfiguration targetCfg = null;
            ConfigurationAddress cfgAddr = null;
            string targetName = "";

            if (pc.TargetInterfaces.Count > 0)
            {
                if (targetIdx < 0 || targetIdx >= pc.TargetInterfaces.Count) throw new ArgumentOutOfRangeException("targetInterfaceIndex", "Select an existing target interface index.");
                ConfigurationTargetInterface ti = pc.TargetInterfaces[targetIdx];
                targetCfg = ti;
                targetName = ti.Name;
                if (!string.IsNullOrEmpty(targetAddrStr))
                {
                    cfgAddr = ti.Addresses.Find(targetAddrStr) ?? ti.Addresses.Create(targetAddrStr);
                }
            }
            else if (pc.Subnets.Count > 0)
            {
                // ConfigurationSubnet is not an IConfiguration in the V20 Openness API, so it
                // cannot be passed to DownloadProvider.Download.
                throw new InvalidOperationException("Download through a subnet-only PC interface ('" + pc.Name + "') is not supported by TIA Openness V20. Select a PN/IE target interface instead.");
            }

            List<string> log = new List<string>();
            bool allowStop = GetBool(args, "allowStopModules", false);
            bool allowDifferent = GetBool(args, "allowDifferentTargetConfiguration", false);
            DownloadConfigurationDelegate configurePre = delegate(DownloadConfiguration cfg)
            {
                StopModules sm = cfg as StopModules;
                if (sm != null) {
                    if (!allowStop) throw new InvalidOperationException("Download requires stopping running modules. Set allowStopModules=true explicitly if intended.");
                    sm.CurrentSelection = StopModulesSelections.StopAll; log.Add("selected: StopAll (allowStopModules=true)"); return;
                }
                ConsistentBlocksDownload cb = cfg as ConsistentBlocksDownload;
                if (cb != null) { cb.CurrentSelection = ConsistentBlocksDownloadSelections.ConsistentDownload; return; }
                AllBlocksDownload ab = cfg as AllBlocksDownload;
                if (ab != null) { ab.CurrentSelection = AllBlocksDownloadSelections.DownloadAllBlocks; return; }
                OverwriteSystemData osd = cfg as OverwriteSystemData;
                if (osd != null) {
                    if (!includeHardware) throw new InvalidOperationException("Download requires overwriting system data. Set includeHardware=true explicitly if intended.");
                    osd.CurrentSelection = OverwriteSystemDataSelections.Overwrite; log.Add("selected: OverwriteSystemData (includeHardware=true)"); return;
                }
                AlarmTextLibrariesDownload atl = cfg as AlarmTextLibrariesDownload;
                if (atl != null) { atl.CurrentSelection = AlarmTextLibrariesDownloadSelections.ConsistentDownload; return; }
                CheckBeforeDownload chk = cfg as CheckBeforeDownload;
                if (chk != null) { chk.Checked = true; return; }
                DifferentTargetConfiguration dtc = cfg as DifferentTargetConfiguration;
                if (dtc != null)
                {
                    if (!allowDifferent) throw new InvalidOperationException("Target configuration differs. Inspect the target and explicitly set allowDifferentTargetConfiguration=true only if this difference is expected.");
                    dtc.CurrentSelection = DifferentTargetConfigurationSelections.AcceptAll;
                    return;
                }
            };
            DownloadConfigurationDelegate configurePost = delegate(DownloadConfiguration cfg)
            {
                StartModules st = cfg as StartModules;
                if (st != null)
                {
                    st.CurrentSelection = startAfter ? StartModulesSelections.StartModule : StartModulesSelections.NoAction;
                }
            };

            DownloadConfigurationDelegate pre = LogDownloadConfiguration("pre", log, configurePre);
            DownloadConfigurationDelegate post = LogDownloadConfiguration("post", log, configurePost);
            DownloadOptions opts = includeHardware ? (DownloadOptions.Hardware | DownloadOptions.Software) : DownloadOptions.Software;
            DownloadResult res;
            try
            {
                res = cfgAddr != null ? dp.Download(targetCfg, cfgAddr, pre, post, opts) : dp.Download(targetCfg, pre, post, opts);
            }
            catch (Exception ex)
            {
                if (log.Count == 0) throw;
                throw new InvalidOperationException(ex.Message + Environment.NewLine + string.Join(Environment.NewLine, log), ex);
            }
            List<object> msgs = new List<object>();
            CollectDownloadMessages(res.Messages, msgs);
            return new Dictionary<string, object>
            {
                { "plc", plc.CpuItem.Name },
                { "pcInterface", pc.Name },
                { "targetInterface", targetName },
                { "targetAddress", targetAddrStr },
                { "scope", includeHardware ? "Hardware+Software" : "Software only" },
                { "includeHardware", includeHardware },
                { "startAfterDownload", startAfter },
                { "allowStopModules", allowStop },
                { "allowDifferentTargetConfiguration", allowDifferent },
                { "state", res.State.ToString() },
                { "errorCount", res.ErrorCount },
                { "warningCount", res.WarningCount },
                { "configLog", log },
                { "messages", msgs }
            };
        }

        private static DownloadConfigurationDelegate LogDownloadConfiguration(string phase, List<string> log, DownloadConfigurationDelegate configure)
        {
            return delegate(DownloadConfiguration cfg)
            {
                string name = phase + ": " + cfg.GetType().Name;
                log.Add(name + " (" + cfg.Message + ")");
                try { configure(cfg); }
                finally
                {
                    if (cfg is DownloadSelectionConfiguration) log.Add(name + " " + DescribeDownloadSelection(cfg));
                }
            };
        }

        private static string DescribeDownloadSelection(DownloadConfiguration cfg)
        {
            string current = "unavailable";
            string choices = "unavailable";
            try
            {
                PropertyInfo property = cfg.GetType().GetProperty("CurrentSelection", BindingFlags.Instance | BindingFlags.Public);
                if (property != null && property.GetIndexParameters().Length == 0)
                {
                    Type type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
                    if (type.IsEnum) choices = string.Join(", ", Enum.GetNames(type));
                    if (property.CanRead) current = Convert.ToString(property.GetValue(cfg, null), CultureInfo.InvariantCulture);
                }
            }
            catch (Exception) { }
            return "CurrentSelection=" + current + "; availableSelections=[" + choices + "]";
        }

        private void CollectDownloadMessages(DownloadResultMessageComposition msgs, List<object> outList)
        {
            foreach (DownloadResultMessage m in msgs)
            {
                if (!string.IsNullOrEmpty(m.Message))
                {
                    outList.Add(new Dictionary<string, object> { { "state", m.State.ToString() }, { "message", m.Message } });
                }
                if (m.Messages != null && m.Messages.Count > 0) CollectDownloadMessages(m.Messages, outList);
            }
        }

        private object CmdOnline(Dictionary<string, object> args)
        {
            string action = GetStr(args, "action", "status").ToLowerInvariant();
            PlcTarget plc = ResolvePlc(args, action != "status");
            OnlineProvider op = plc.CpuItem.GetService<OnlineProvider>();
            if (op == null) throw new InvalidOperationException("OnlineProvider not available.");

            if (action == "go_online" || action == "online")
            {
                string modeName = GetStr(args, "mode", "PN/IE");
                string pcFilter = GetStr(args, "pcInterface", "");
                ConfigurationMode mode = op.Configuration.Modes.Find(modeName);
                if (mode == null) throw new InvalidOperationException("Connection mode '" + modeName + "' not found. Available: " + string.Join(", ", op.Configuration.Modes.Select(m => m.Name).ToArray()));
                if (!string.IsNullOrWhiteSpace(pcFilter))
                {
                    ConfigurationPcInterface pc = mode.PcInterfaces.FirstOrDefault(p => string.Equals(p.Name, pcFilter, StringComparison.OrdinalIgnoreCase));
                    if (pc == null) throw new InvalidOperationException("Exact PC interface name '" + pcFilter + "' not found. Available: " + string.Join(", ", mode.PcInterfaces.Select(p => p.Name).ToArray()));
                    if (pc.TargetInterfaces.Count == 0) throw new InvalidOperationException("PC interface '" + pc.Name + "' has no target interface for go_online.");
                    op.Configuration.ApplyConfiguration(pc.TargetInterfaces[0]);
                }
                op.GoOnline();
            }
            else if (action == "go_offline" || action == "offline")
            {
                op.GoOffline();
            }
            return new Dictionary<string, object>
            {
                { "plc", plc.CpuItem.Name },
                { "state", op.State.ToString() }
            };
        }
#endif
    }
}
