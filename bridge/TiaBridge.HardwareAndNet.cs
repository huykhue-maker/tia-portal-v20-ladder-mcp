using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Security;
using Siemens.Engineering;
using Siemens.Engineering.Connection;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.HW.HardwareCatalog;
using Siemens.Engineering.SW.TechnologicalObjects;

namespace TiaBridge
{
    internal partial class BridgeHost
    {
        // -------------------- Zero-to-Project Hardware & CPU Configuration --------------------
        private static readonly Dictionary<string, string> CommonHardwarePresets = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "CPU_1212C_DC_DC_DC", "OrderNumber:6ES7 212-1AE40-0XB0/V4.6" },
            { "CPU_1212C_AC_DC_RLY", "OrderNumber:6ES7 212-1BE40-0XB0/V4.6" },
            { "CPU_1214C_DC_DC_DC", "OrderNumber:6ES7 214-1AG40-0XB0/V4.6" },
            { "CPU_1214C_DC_DC_DC_V44", "OrderNumber:6ES7 214-1AG40-0XB0/V4.4" },
            { "CPU_1214C_AC_DC_RLY", "OrderNumber:6ES7 214-1BG40-0XB0/V4.6" },
            { "CPU_1215C_DC_DC_DC", "OrderNumber:6ES7 215-1AG40-0XB0/V4.6" },
            { "CPU_1511_1_PN", "OrderNumber:6ES7 511-1AL03-0AB0/V3.1" },
            { "CPU_1515_2_PN", "OrderNumber:6ES7 515-2AN03-0AB0/V3.1" },
            { "SM_1221_DI16", "OrderNumber:6ES7 221-1BH32-0XB0/V2.0" },
            { "SM_1222_DQ16", "OrderNumber:6ES7 222-1BH32-0XB0/V2.0" },
            { "SM_1223_DI16_DQ16", "OrderNumber:6ES7 223-1BL32-0XB0/V2.0" },
            { "SM_1231_AI4", "OrderNumber:6ES7 231-4HD32-0XB0/V2.0" },
            { "SM_1232_AQ2", "OrderNumber:6ES7 232-4HB32-0XB0/V2.0" },
            { "SM_1234_AI4_AQ2", "OrderNumber:6ES7 234-4HE32-0XB0/V2.0" },
            { "CM_1241_RS485", "OrderNumber:6ES7 241-1CH32-0XB0/V2.2" },
            { "CB_1241_RS485", "OrderNumber:6ES7 241-1CH30-1XB0/V1.0" }
        };

        private string ResolveTypeIdentifier(string spec)
        {
            if (string.IsNullOrEmpty(spec)) throw new ArgumentException("typeIdentifier or preset is required.");
            string mapped;
            if (CommonHardwarePresets.TryGetValue(spec.Trim(), out mapped)) return mapped;
            if (spec.StartsWith("OrderNumber:", StringComparison.OrdinalIgnoreCase)) return spec;
            return "OrderNumber:" + spec.Trim();
        }

        private object CmdHardwareConfig(Dictionary<string, object> args)
        {
            string action = GetStr(args, "action", "presets").ToLowerInvariant();

            if (action == "presets")
            {
                return new Dictionary<string, object> { { "presets", CommonHardwarePresets } };
            }

            if (action == "create_project")
            {
                return CmdCreateProject(args);
            }

            EnsureConnected();

            if (action == "search_catalog")
            {
                string query = GetStr(args, "query", "6ES7 214");
                string filterText = GetStr(args, "filter", "");
                int limit = GetInt(args, "limit", 40);
                IList<CatalogEntry> entries = _tia.HardwareCatalog.Find(query);
                List<object> list = new List<object>();
                foreach (CatalogEntry ce in entries)
                {
                    if (list.Count >= limit) break;
                    if (!string.IsNullOrEmpty(filterText))
                    {
                        bool hit = (ce.Description != null && ce.Description.IndexOf(filterText, StringComparison.OrdinalIgnoreCase) >= 0)
                            || (ce.CatalogPath != null && ce.CatalogPath.IndexOf(filterText, StringComparison.OrdinalIgnoreCase) >= 0)
                            || (ce.Version != null && ce.Version.IndexOf(filterText, StringComparison.OrdinalIgnoreCase) >= 0);
                        if (!hit) continue;
                    }
                    list.Add(new Dictionary<string, object>
                    {
                        { "articleNumber", ce.ArticleNumber ?? "" },
                        { "version", ce.Version ?? "" },
                        { "typeIdentifier", ce.TypeIdentifier ?? "" },
                        { "typeName", ce.TypeName ?? "" },
                        { "catalogPath", ce.CatalogPath ?? "" },
                        { "description", ce.Description ?? "" }
                    });
                }
                return new Dictionary<string, object> { { "query", query }, { "count", list.Count }, { "entries", list } };
            }

            EnsureProject();

            if (action == "add_plc" || action == "add_device")
            {
                string spec = GetStr(args, "typeIdentifier", "CPU_1214C_DC_DC_DC");
                string typeId = ResolveTypeIdentifier(spec);
                string cpuName = GetStr(args, "plcName", "PLC_1");
                string stationName = GetStr(args, "stationName", "Station_" + cpuName);

                Device dev;
                try
                {
                    dev = _project.Devices.CreateWithItem(typeId, cpuName, stationName);
                }
                catch (Exception ex)
                {
                    // Fallback: search catalog by article base if exact firmware version differs on this TIA installation
                    string art = typeId.Replace("OrderNumber:", "").Split('/')[0].Trim();
                    IList<CatalogEntry> found = _tia.HardwareCatalog.Find(art);
                    CatalogEntry latest = found.LastOrDefault(x => !string.IsNullOrEmpty(x.TypeIdentifier));
                    if (latest == null) throw new InvalidOperationException("Failed to create device '" + typeId + "': " + ex.Message);
                    dev = _project.Devices.CreateWithItem(latest.TypeIdentifier, cpuName, stationName);
                    typeId = latest.TypeIdentifier;
                }

                List<string> secApplied = new List<string>();
                List<string> secWarnings = new List<string>();
                if (action == "add_plc")
                {
                    List<PlcTarget> devPlcs = new List<PlcTarget>();
                    CollectPlcItems(dev, dev.DeviceItems, devPlcs);
                    if (devPlcs.Count > 0)
                    {
                        bool defaultDisableSec = !args.ContainsKey("disableSecurity") || GetBool(args, "disableSecurity", true);
                        ConfigureCpuSecurity(devPlcs[0].CpuItem, args, defaultDisableSec, secApplied, secWarnings);
                    }
                }

                return new Dictionary<string, object>
                {
                    { "created", true },
                    { "stationName", dev.Name },
                    { "plcName", cpuName },
                    { "typeIdentifier", typeId },
                    { "securityApplied", secApplied },
                    { "securityWarnings", secWarnings },
                    { "device", DescribeDevice(dev, "") }
                };
            }

            if (action == "plug_module")
            {
                PlcTarget plc = ResolvePlc(args, true);
                string spec = GetStr(args, "typeIdentifier", "");
                string typeId = ResolveTypeIdentifier(spec);
                string modName = GetStr(args, "moduleName", "Module_1");
                int slot = GetInt(args, "slot", 2);

                DeviceItem rack = FindPluggableContainer(plc.Device, typeId, modName, slot);
                if (rack == null)
                {
                    // Try resolving version from HardwareCatalog if exact firmware didn't match
                    string art = typeId.Replace("OrderNumber:", "").Split('/')[0].Trim();
                    foreach (CatalogEntry ce in _tia.HardwareCatalog.Find(art).Reverse())
                    {
                        rack = FindPluggableContainer(plc.Device, ce.TypeIdentifier, modName, slot);
                        if (rack != null) { typeId = ce.TypeIdentifier; break; }
                    }
                }
                if (rack == null)
                {
                    throw new InvalidOperationException("Cannot plug '" + typeId + "' into slot " + slot + " on device '" + plc.Device.Name + "'. Check module compatibility and slot number (S7-1200 expansion slots start at 2, Signal Board is 1, Comm modules are 101..103).");
                }
                DeviceItem plugged = rack.PlugNew(typeId, modName, slot);
                return new Dictionary<string, object>
                {
                    { "plugged", true },
                    { "name", plugged.Name },
                    { "slot", slot },
                    { "typeIdentifier", typeId }
                };
            }

            if (action == "cpu_properties")
            {
                string[] secKeys = new[] { "disableSecurity", "accessControl", "accessLevel", "protectConfigData", "masterSecretPassword", "accessLevelPassword" };
                bool hasSecArgs = secKeys.Any(args.ContainsKey);
                bool forWrite = hasSecArgs || new[] { "enableSystemMemory", "systemMemoryAddress", "enableClockMemory", "clockMemoryAddress", "permitPutGet" }.Any(args.ContainsKey) || GetDict(args, "attributes").Count > 0;
                PlcTarget plc = ResolvePlc(args, forWrite);
                IEngineeringObject cpuObj = plc.CpuItem;
                List<string> applied = new List<string>();
                List<string> warnings = new List<string>();

                if (hasSecArgs)
                {
                    ConfigureCpuSecurity(plc.CpuItem, args, GetBool(args, "disableSecurity", false), applied, warnings);
                }

                // Clock & System Memory Bytes, Startup Mode, PUT/GET, etc.
                if (args.ContainsKey("enableSystemMemory"))
                {
                    bool v = GetBool(args, "enableSystemMemory", true);
                    if (TrySetAttrFuzzy(cpuObj, new string[] { "SystemMemoryByte", "EnableSystemMemoryByte" }, v))
                        applied.Add("SystemMemoryByte=" + v);
                    else
                        warnings.Add("Could not set SystemMemoryByte on " + plc.CpuItem.Name + " (attribute unsupported or read-only).");
                }
                if (args.ContainsKey("systemMemoryAddress"))
                {
                    ulong addr = (ulong)GetInt(args, "systemMemoryAddress", 1);
                    if (TrySetAttrFuzzy(cpuObj, new string[] { "SystemMemoryByteAddress" }, addr))
                        applied.Add("SystemMemoryByteAddress=" + addr);
                    else
                        warnings.Add("Could not set SystemMemoryByteAddress=" + addr + " on " + plc.CpuItem.Name + ".");
                }
                if (args.ContainsKey("enableClockMemory"))
                {
                    bool v = GetBool(args, "enableClockMemory", true);
                    if (TrySetAttrFuzzy(cpuObj, new string[] { "ClockMemoryByte", "EnableClockMemoryByte" }, v))
                        applied.Add("ClockMemoryByte=" + v);
                    else
                        warnings.Add("Could not set ClockMemoryByte on " + plc.CpuItem.Name + " (attribute unsupported or read-only).");
                }
                if (args.ContainsKey("clockMemoryAddress"))
                {
                    ulong addr = (ulong)GetInt(args, "clockMemoryAddress", 0);
                    if (TrySetAttrFuzzy(cpuObj, new string[] { "ClockMemoryByteAddress" }, addr))
                        applied.Add("ClockMemoryByteAddress=" + addr);
                    else
                        warnings.Add("Could not set ClockMemoryByteAddress=" + addr + " on " + plc.CpuItem.Name + ".");
                }
                if (args.ContainsKey("permitPutGet"))
                {
                    bool allow = GetBool(args, "permitPutGet", true);
                    if (TrySetAttrDeep(plc.CpuItem, "PutGetCommunicationAllowed", allow) || TrySetAttrDeep(plc.Device, "PutGetCommunicationAllowed", allow))
                        applied.Add("PutGetCommunicationAllowed=" + allow);
                    else
                        warnings.Add("Could not set PutGetCommunicationAllowed=" + allow + " on " + plc.CpuItem.Name + ".");
                }

                // Arbitrary raw attributes dictionary if provided
                Dictionary<string, object> rawAttrs = GetDict(args, "attributes");
                foreach (KeyValuePair<string, object> kv in rawAttrs)
                {
                    object coerced = CoerceAttributeValue(cpuObj, kv.Key, kv.Value);
                    cpuObj.SetAttribute(kv.Key, coerced);
                    applied.Add(kv.Key + "=" + Convert.ToString(coerced));
                }

                // Return summary of key readable CPU attributes
                Dictionary<string, object> current = new Dictionary<string, object>();
                foreach (EngineeringAttributeInfo ai in cpuObj.GetAttributeInfos())
                {
                    if (ai.Name.IndexOf("Memory", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("Startup", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("Protection", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("AccessControl", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("MasterSecret", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("PutGet", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("Cycle", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("OpcUa", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ai.Name.IndexOf("Webserver", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        try { current[ai.Name] = FormatSimpleValue(cpuObj.GetAttribute(ai.Name)); } catch { }
                    }
                }
                try { var acp = plc.CpuItem.GetService<PlcAccessControlConfigurationProvider>(); if (acp != null) current["PlcAccessControlConfiguration"] = acp.PlcAccessControlConfiguration.ToString(); } catch { }
                try { var alp = plc.CpuItem.GetService<PlcAccessLevelProvider>(); if (alp != null) current["PlcProtectionAccessLevel"] = alp.PlcProtectionAccessLevel.ToString(); } catch { }
                try { var msc = plc.CpuItem.GetService<PlcMasterSecretConfigurator>(); if (msc != null) current["MasterSecretConfiguration"] = msc.MasterSecretConfiguration.ToString(); } catch { }

                return new Dictionary<string, object>
                {
                    { "plc", plc.CpuItem.Name },
                    { "applied", applied },
                    { "warnings", warnings },
                    { "keyAttributes", current }
                };
            }

            if (action == "create_tech_object")
            {
                PlcTarget plc = ResolvePlc(args, true);
                string toName = GetStr(args, "name", "Axis_1");
                string toType = GetStr(args, "type", "TO_PositioningAxis");
                string verStr = GetStr(args, "version", "8.0");

                TechnologicalInstanceDB existing = plc.Software.TechnologicalObjectGroup.TechnologicalObjects.Find(toName);
                if (existing == null)
                {
                    Version ver = new Version(verStr);
                    try
                    {
                        existing = plc.Software.TechnologicalObjectGroup.TechnologicalObjects.Create(toName, toType, ver);
                    }
                    catch
                    {
                        // Try common fallback versions (7.0, 6.0, 5.0, 4.0) across S7-1200 / S7-1500 firmware
                        string[] fallbacks = new string[] { "8.0", "7.0", "6.0", "5.0", "4.0", "3.0", "2.0" };
                        Exception lastEx = null;
                        foreach (string fv in fallbacks)
                        {
                            try { existing = plc.Software.TechnologicalObjectGroup.TechnologicalObjects.Create(toName, toType, new Version(fv)); verStr = fv; break; }
                            catch (Exception ex) { lastEx = ex; }
                        }
                        if (existing == null && lastEx != null) throw lastEx;
                    }
                }

                Dictionary<string, object> toParams = GetDict(args, "parameters");
                List<string> paramChanges = new List<string>();
                List<string> warnings = new List<string>();
                if (existing.Parameters != null)
                {
                    foreach (KeyValuePair<string, object> kv in toParams)
                    {
                        TechnologicalParameter tp = existing.Parameters.Find(kv.Key);
                        if (tp != null)
                        {
                            tp.Value = CoerceSimple(tp.Value, kv.Value);
                            paramChanges.Add(kv.Key + "=" + Convert.ToString(tp.Value));
                        }
                        else
                        {
                            warnings.Add("Parameter '" + kv.Key + "' not found on technological object '" + existing.Name + "'.");
                        }
                    }
                }
                else if (toParams.Count > 0)
                {
                    warnings.Add("Technological object '" + existing.Name + "' exposes no Parameters collection.");
                }

                return new Dictionary<string, object>
                {
                    { "name", existing.Name },
                    { "number", existing.Number },
                    { "type", toType },
                    { "version", verStr },
                    { "parameterChanges", paramChanges },
                    { "warnings", warnings }
                };
            }

            throw new ArgumentException("Unknown hardware_config action: " + action);
        }

        private DeviceItem FindPluggableContainer(Device dev, string typeId, string name, int slot)
        {
            foreach (DeviceItem di in dev.DeviceItems)
            {
                try { if (di.CanPlugNew(typeId, name, slot)) return di; } catch { }
                DeviceItem sub = FindPluggableInItems(di.DeviceItems, typeId, name, slot);
                if (sub != null) return sub;
            }
            return null;
        }

        private DeviceItem FindPluggableInItems(DeviceItemComposition items, string typeId, string name, int slot)
        {
            if (items == null) return null;
            foreach (DeviceItem di in items)
            {
                try { if (di.CanPlugNew(typeId, name, slot)) return di; } catch { }
                DeviceItem sub = FindPluggableInItems(di.DeviceItems, typeId, name, slot);
                if (sub != null) return sub;
            }
            return null;
        }

        private static SecureString ToSecureString(string s)
        {
            SecureString sec = new SecureString();
            if (s != null) foreach (char c in s) sec.AppendChar(c);
            sec.MakeReadOnly();
            return sec;
        }

        private static TEnum ParseEnumStrict<TEnum>(string raw, string paramName) where TEnum : struct
        {
            TEnum val;
            if (!Enum.TryParse<TEnum>(raw, true, out val))
                throw new ArgumentException("Invalid " + paramName + " '" + raw + "'. Allowed: " + string.Join(", ", Enum.GetNames(typeof(TEnum))));
            return val;
        }

        private void ConfigureCpuSecurity(DeviceItem cpuItem, Dictionary<string, object> args, bool disableSec, List<string> applied, List<string> warnings)
        {
            string masterPwd = GetStr(args, "masterSecretPassword", null);
            bool? protectCfg = args.ContainsKey("protectConfigData") ? (bool?)GetBool(args, "protectConfigData", false) : null;
            string reqAc = GetStr(args, "accessControl", "");
            string reqLvl = GetStr(args, "accessLevel", "");
            string lvlPwd = GetStr(args, "accessLevelPassword", null);

            if (!string.IsNullOrEmpty(reqAc)) ParseEnumStrict<PlcAccessControlConfiguration>(reqAc, "accessControl");
            if (!string.IsNullOrEmpty(reqLvl)) ParseEnumStrict<PlcProtectionAccessLevel>(reqLvl, "accessLevel");

            try
            {
                PlcMasterSecretConfigurator msc = cpuItem.GetService<PlcMasterSecretConfigurator>();
                if (msc != null)
                {
                    if (!string.IsNullOrEmpty(masterPwd) && protectCfg != false)
                    {
                        if (msc.MasterSecretConfiguration == MasterSecretConfiguration.WithPassword)
                        {
                            string oldPwd = GetStr(args, "oldMasterSecretPassword", null);
                            if (!string.IsNullOrEmpty(oldPwd)) msc.ChangePassword(ToSecureString(oldPwd), ToSecureString(masterPwd));
                            else { msc.Reset(); msc.Protect(ToSecureString(masterPwd)); }
                        }
                        else msc.Protect(ToSecureString(masterPwd));
                        applied.Add("MasterSecretConfiguration=WithPassword");
                    }
                    else if (protectCfg == false || (disableSec && protectCfg != true))
                    {
                        string oldPwd = GetStr(args, "oldMasterSecretPassword", null);
                        if (msc.MasterSecretConfiguration == MasterSecretConfiguration.WithPassword && !string.IsNullOrEmpty(oldPwd))
                            msc.Unprotect(ToSecureString(oldPwd));
                        else
                            msc.Unprotect();
                        applied.Add("MasterSecretConfiguration=WithoutPassword");
                    }
                }
            }
            catch (Exception ex) { warnings.Add("MasterSecret: " + ex.Message); }

            try
            {
                PlcAccessControlConfigurationProvider acp = cpuItem.GetService<PlcAccessControlConfigurationProvider>();
                if (acp != null && (!string.IsNullOrEmpty(reqAc) || disableSec))
                {
                    PlcAccessControlConfiguration target = ParseEnumStrict<PlcAccessControlConfiguration>(!string.IsNullOrEmpty(reqAc) ? reqAc : "Disabled", "accessControl");
                    acp.PlcAccessControlConfiguration = target;
                    applied.Add("PlcAccessControlConfiguration=" + target);
                }
            }
            catch (Exception ex) { warnings.Add("AccessControl: " + ex.Message); }

            try
            {
                PlcAccessLevelProvider alp = cpuItem.GetService<PlcAccessLevelProvider>();
                if (alp != null && (!string.IsNullOrEmpty(reqLvl) || disableSec || !string.IsNullOrEmpty(lvlPwd)))
                {
                    PlcProtectionAccessLevel target = ParseEnumStrict<PlcProtectionAccessLevel>(!string.IsNullOrEmpty(reqLvl) ? reqLvl : "FullAccess", "accessLevel");
                    if (!string.IsNullOrEmpty(lvlPwd))
                    {
                        alp.SetPassword(target, ToSecureString(lvlPwd));
                        applied.Add("AccessLevelPassword=" + target);
                    }
                    alp.PlcProtectionAccessLevel = target;
                    applied.Add("PlcProtectionAccessLevel=" + target);
                }
            }
            catch (Exception ex) { warnings.Add("AccessLevel: " + ex.Message); }
        }

        private bool TrySetAttrFuzzy(IEngineeringObject obj, string[] names, object val)
        {
            foreach (string nm in names)
            {
                try
                {
                    object coerced = CoerceAttributeValue(obj, nm, val);
                    obj.SetAttribute(nm, coerced);
                    return true;
                }
                catch { }
            }
            return false;
        }

        private sealed class RefEqualityComparer : IEqualityComparer<object>
        {
            public new bool Equals(object x, object y) { return object.ReferenceEquals(x, y); }
            public int GetHashCode(object obj) { return RuntimeHelpers.GetHashCode(obj); }
        }

        private bool TrySetAttrDeep(IEngineeringObject root, string attrName, object val)
        {
            return TrySetAttrDeepCore(root, attrName, val, 0, 5, new HashSet<object>(new RefEqualityComparer()));
        }

        private bool TrySetAttrDeepCore(IEngineeringObject root, string attrName, object val, int depth, int maxDepth, HashSet<object> visited)
        {
            if (root == null || depth > maxDepth || !visited.Add(root)) return false;
            try
            {
                EngineeringAttributeInfo info = root.GetAttributeInfos().FirstOrDefault(a => string.Equals(a.Name, attrName, StringComparison.OrdinalIgnoreCase));
                if (info != null)
                {
                    root.SetAttribute(info.Name, CoerceAttributeValue(root, info.Name, val));
                    return true;
                }
                if (depth >= maxDepth) return false;
                foreach (EngineeringCompositionInfo ci in root.GetCompositionInfos())
                {
                    IEnumerable comp = null;
                    try { comp = root.GetComposition(ci.Name) as IEnumerable; } catch { continue; }
                    if (comp == null) continue;
                    foreach (object child in comp)
                    {
                        IEngineeringObject eo = child as IEngineeringObject;
                        if (eo != null && TrySetAttrDeepCore(eo, attrName, val, depth + 1, maxDepth, visited)) return true;
                    }
                }
            }
            catch { }
            return false;
        }

        // -------------------- Industrial Networking, PROFINET, S7 & OPC UA --------------------
        private void CollectNetworkInterfaces(DeviceItemComposition items, string devName, List<KeyValuePair<DeviceItem, NetworkInterface>> list)
        {
            if (items == null) return;
            foreach (DeviceItem di in items)
            {
                NetworkInterface ni = di.GetService<NetworkInterface>();
                if (ni != null) list.Add(new KeyValuePair<DeviceItem, NetworkInterface>(di, ni));
                CollectNetworkInterfaces(di.DeviceItems, devName, list);
            }
        }

        private object CmdNetworkConfig(Dictionary<string, object> args)
        {
            EnsureProject();
            string action = GetStr(args, "action", "inspect").ToLowerInvariant();

            if (action == "inspect")
            {
                List<object> subnets = new List<object>();
                foreach (Subnet s in _project.Subnets)
                {
                    List<string> ioSys = new List<string>();
                    foreach (IoSystem ios in s.IoSystems) ioSys.Add(ios.Name);
                    subnets.Add(new Dictionary<string, object>
                    {
                        { "name", s.Name },
                        { "typeIdentifier", s.TypeIdentifier },
                        { "ioSystems", ioSys }
                    });
                }

                List<object> ifaces = new List<object>();
                foreach (Device dev in _project.Devices)
                {
                    List<KeyValuePair<DeviceItem, NetworkInterface>> devNis = new List<KeyValuePair<DeviceItem, NetworkInterface>>();
                    CollectNetworkInterfaces(dev.DeviceItems, dev.Name, devNis);
                    foreach (KeyValuePair<DeviceItem, NetworkInterface> kv in devNis)
                    {
                        List<object> nodes = new List<object>();
                        foreach (Node nd in kv.Value.Nodes)
                        {
                            Dictionary<string, object> ndInfo = new Dictionary<string, object>
                            {
                                { "name", nd.Name },
                                { "nodeType", nd.NodeType.ToString() },
                                { "connectedSubnet", nd.ConnectedSubnet != null ? nd.ConnectedSubnet.Name : null }
                            };
                            foreach (string an in new string[] { "Address", "SubnetMask", "UseRouter", "RouterAddress", "PnDeviceName" })
                            {
                                try { ndInfo[an] = FormatSimpleValue(nd.GetAttribute(an)); } catch { }
                            }
                            nodes.Add(ndInfo);
                        }
                        ifaces.Add(new Dictionary<string, object>
                        {
                            { "device", dev.Name },
                            { "interfaceItem", kv.Key.Name },
                            { "interfaceType", kv.Value.InterfaceType.ToString() },
                            { "operatingMode", kv.Value.InterfaceOperatingMode.ToString() },
                            { "nodes", nodes }
                        });
                    }
                }

                return new Dictionary<string, object>
                {
                    { "subnets", subnets },
                    { "interfaces", ifaces }
                };
            }

            if (action == "set_ip" || action == "connect_subnet")
            {
                PlcTarget plc = ResolvePlc(args, true);
                string ifaceFilter = GetStr(args, "interfaceName", "");
                List<KeyValuePair<DeviceItem, NetworkInterface>> devNis = new List<KeyValuePair<DeviceItem, NetworkInterface>>();
                CollectNetworkInterfaces(plc.Device.DeviceItems, plc.Device.Name, devNis);

                KeyValuePair<DeviceItem, NetworkInterface> chosen = devNis.FirstOrDefault(x =>
                    (string.IsNullOrEmpty(ifaceFilter) || x.Key.Name.IndexOf(ifaceFilter, StringComparison.OrdinalIgnoreCase) >= 0) &&
                    x.Value.Nodes.Count > 0);
                if (chosen.Value == null) throw new InvalidOperationException("No Ethernet/PROFINET NetworkInterface with Nodes found on '" + plc.Device.Name + "'.");

                Node node = chosen.Value.Nodes[0];
                List<string> changes = new List<string>();
                List<string> warnings = new List<string>();

                string ip = GetStr(args, "ipAddress", "");
                string mask = GetStr(args, "subnetMask", "");
                string router = GetStr(args, "routerAddress", "");
                string subnetName = GetStr(args, "subnetName", "");
                bool createIoSystem = GetBool(args, "createIoSystem", false);

                if (!string.IsNullOrEmpty(ip)) { node.SetAttribute("Address", ip); changes.Add("Address=" + ip); }
                if (!string.IsNullOrEmpty(mask)) { node.SetAttribute("SubnetMask", mask); changes.Add("SubnetMask=" + mask); }
                if (!string.IsNullOrEmpty(router))
                {
                    try { node.SetAttribute("UseRouter", true); node.SetAttribute("RouterAddress", router); changes.Add("RouterAddress=" + router); }
                    catch (Exception ex) { warnings.Add("RouterAddress='" + router + "' failed: " + ex.Message); }
                }

                if (!string.IsNullOrEmpty(subnetName) || action == "connect_subnet")
                {
                    string sName = string.IsNullOrEmpty(subnetName) ? "PN/IE_1" : subnetName;
                    Subnet sub = _project.Subnets.Find(sName);
                    if (sub == null)
                    {
                        sub = _project.Subnets.Create("System:Subnet.Ethernet", sName);
                        changes.Add("created Subnet '" + sName + "'");
                    }
                    if (node.ConnectedSubnet != sub)
                    {
                        node.ConnectToSubnet(sub);
                        changes.Add("connected to Subnet '" + sName + "'");
                    }
                    if (createIoSystem && chosen.Value.IoControllers.Count > 0 && chosen.Value.IoControllers[0].IoSystem == null)
                    {
                        IoSystem ios = chosen.Value.IoControllers[0].CreateIoSystem(sName + "_IOSystem");
                        changes.Add("created IoSystem '" + ios.Name + "'");
                    }
                }

                return new Dictionary<string, object>
                {
                    { "plc", plc.CpuItem.Name },
                    { "interface", chosen.Key.Name },
                    { "changes", changes },
                    { "warnings", warnings }
                };
            }

            if (action == "opcua")
            {
                PlcTarget plc = ResolvePlc(args, args.ContainsKey("enableServer") || args.ContainsKey("port"));
                List<string> changes = new List<string>();
                List<string> warnings = new List<string>();
                if (args.ContainsKey("enableServer"))
                {
                    bool en = GetBool(args, "enableServer", true);
                    if (en)
                    {
                        if (TrySetAttrDeep(plc.CpuItem, "OpcUaPurchasedLicense", 1)) changes.Add("OpcUaPurchasedLicense=1");
                    }
                    bool serverSet = TrySetAttrDeep(plc.CpuItem, "OpcUaServerActive", en) || TrySetAttrDeep(plc.CpuItem, "ActivateOpcUaServer", en);
                    if (serverSet) changes.Add("OpcUaServer=" + en);
                    else warnings.Add("OPC UA server attribute not supported or writable on CPU '" + plc.CpuItem.Name + "'.");
                }
                if (args.ContainsKey("port"))
                {
                    uint p = (uint)GetInt(args, "port", 4840);
                    if (TrySetAttrDeep(plc.CpuItem, "OpcUaPort", p) || TrySetAttrDeep(plc.CpuItem, "OpcUaServerPort", p))
                        changes.Add("Port=" + p);
                    else
                        warnings.Add("OPC UA port attribute not supported or writable on CPU '" + plc.CpuItem.Name + "'.");
                }
                return new Dictionary<string, object> { { "plc", plc.CpuItem.Name }, { "changes", changes }, { "warnings", warnings } };
            }

            throw new ArgumentException("Unknown network_config action: " + action);
        }
    }
}
