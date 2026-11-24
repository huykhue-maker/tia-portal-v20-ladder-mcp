using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Threading;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.TechnologicalObjects;
using Siemens.Engineering.SW.Types;
using Siemens.Engineering.SW.WatchAndForceTables;
#if WITH_PLCSIM_API
using Siemens.Simatic.Simulation.Runtime;
#endif

namespace TiaBridge
{
    internal partial class BridgeHost
    {
        // ==================== 1. UNIVERSAL ESCAPE HATCH (DYNAMIC REFLECTION) ====================
        private string RegisterHandle(object obj)
        {
            if (obj == null) return null;
            foreach (KeyValuePair<string, object> kv in _handles)
            {
                if ( object.ReferenceEquals(kv.Value, obj) || kv.Value.Equals(obj) ) return kv.Key;
            }
            string id = "obj:" + (_nextHandleId++);
            _handles[id] = obj;
            return id;
        }

        private static bool IsSimpleType(Type t)
        {
            return t.IsPrimitive || t.IsEnum || t == typeof(string) || t == typeof(decimal) || t == typeof(Version) || t == typeof(Guid) || t == typeof(DateTime);
        }

        private object FormatSimpleValue(object val)
        {
            if (val == null) return null;
            Type t = val.GetType();
            if (t.IsEnum || val is Version || val is Guid) return val.ToString();
            if (val is DateTime) return ((DateTime)val).ToString("o");
            if (t.IsPrimitive || val is string || val is decimal) return val;
            if (val is byte[]) return BitConverter.ToString((byte[])val);
            if (val is string[]) return val;
            return RegisterHandle(val) + " (" + t.Name + ")";
        }

        private object CoerceSimple(object currentVal, object rawNew)
        {
            if (rawNew == null) return null;
            if (currentVal == null) return rawNew;
            return CoerceToType(currentVal.GetType(), rawNew);
        }

        private object CoerceToType(Type targetType, object raw)
        {
            if (raw == null || targetType == null) return raw;
            if (targetType.IsAssignableFrom(raw.GetType())) return raw;
            string s = Convert.ToString(raw, CultureInfo.InvariantCulture);
            if (raw is string && s.StartsWith("obj:") && _handles.ContainsKey(s))
            {
                return _handles[s];
            }
            if (targetType.IsEnum) return Enum.Parse(targetType, s, true);
            if (targetType == typeof(bool)) return Convert.ToBoolean(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(int)) return Convert.ToInt32(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(uint)) return Convert.ToUInt32(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(long)) return Convert.ToInt64(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(ulong)) return Convert.ToUInt64(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(short)) return Convert.ToInt16(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(ushort)) return Convert.ToUInt16(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(byte)) return Convert.ToByte(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(float)) return Convert.ToSingle(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(double)) return Convert.ToDouble(raw, CultureInfo.InvariantCulture);
            if (targetType == typeof(string)) return s;
            if (targetType == typeof(Version)) return new Version(s);
            return Convert.ChangeType(raw, targetType, CultureInfo.InvariantCulture);
        }

        private object CoerceAttributeValue(IEngineeringObject obj, string attrName, object rawVal)
        {
            try
            {
                EngineeringAttributeInfo ai = obj.GetAttributeInfos().FirstOrDefault(x => string.Equals(x.Name, attrName, StringComparison.OrdinalIgnoreCase));
                if (ai != null && ai.SupportedTypes != null && ai.SupportedTypes.Any())
                {
                    foreach (Type st in ai.SupportedTypes)
                    {
                        try { return CoerceToType(st, rawVal); } catch { }
                    }
                }
                object cur = obj.GetAttribute(attrName);
                if (cur != null) return CoerceToType(cur.GetType(), rawVal);
            }
            catch { }
            return rawVal;
        }

        private object ResolveTargetObject(Dictionary<string, object> args)
        {
            string target = GetStr(args, "target", "project").Trim();
            if (_handles.ContainsKey(target)) return _handles[target];
            if (string.Equals(target, "tia", StringComparison.OrdinalIgnoreCase)) { EnsureConnected(); return _tia; }
            if (string.Equals(target, "project", StringComparison.OrdinalIgnoreCase)) { EnsureProject(); return _project; }

            int colon = target.IndexOf(':');
            string kind = (colon >= 0 ? target.Substring(0, colon) : target).ToLowerInvariant();
            string arg = colon >= 0 ? target.Substring(colon + 1) : "";

            PlcTarget plc = ResolvePlc(args);
            switch (kind)
            {
                case "plc":
                case "cpu":
                    if (!string.IsNullOrEmpty(arg)) plc = ResolvePlc(new Dictionary<string, object> { { "plcName", arg } });
                    return plc.CpuItem;
                case "device":
                    if (!string.IsNullOrEmpty(arg))
                    {
                        EnsureProject();
                        Device d = _project.Devices.FirstOrDefault(x => string.Equals(x.Name, arg, StringComparison.OrdinalIgnoreCase));
                        if (d != null) return d;
                    }
                    return plc.Device;
                case "software":
                    if (!string.IsNullOrEmpty(arg)) plc = ResolvePlc(new Dictionary<string, object> { { "plcName", arg } });
                    return plc.Software;
                case "block":
                    PlcBlockGroup bOwner;
                    PlcBlock blk = FindBlock(plc.Software.BlockGroup, arg, out bOwner);
                    if (blk == null) throw new InvalidOperationException("Block '" + arg + "' not found.");
                    return blk;
                case "to":
                case "tech":
                    TechnologicalInstanceDB to = plc.Software.TechnologicalObjectGroup.TechnologicalObjects.Find(arg);
                    if (to == null) throw new InvalidOperationException("Technological Object '" + arg + "' not found.");
                    return to;
                case "watch":
                    PlcWatchAndForceTableGroup wOwner;
                    PlcWatchTable wt = FindWatchTable(plc.Software.WatchAndForceTableGroup, arg, out wOwner);
                    if (wt == null) throw new InvalidOperationException("Watch Table '" + arg + "' not found.");
                    return wt;
                case "tagtable":
                    PlcTagTable tt = string.IsNullOrEmpty(arg)
                        ? plc.Software.TagTableGroup.TagTables.FirstOrDefault(x => x.IsDefault)
                        : FindTagTable(plc.Software.TagTableGroup, arg);
                    if (tt == null) throw new InvalidOperationException("Tag Table '" + arg + "' not found.");
                    return tt;
                case "type":
                case "udt":
                    PlcType pt = FindPlcType(plc.Software.TypeGroup, arg);
                    if (pt == null) throw new InvalidOperationException("UDT '" + arg + "' not found.");
                    return pt;
                default:
                    throw new ArgumentException("Unknown target selector '" + target + "'. Use 'project', 'tia', 'cpu', 'device', 'software', 'block:<Name>', 'to:<Name>', 'watch:<Name>', 'tagtable:<Name>', 'type:<Name>', or a handle 'obj:N'.");
            }
        }

        private object CmdEscapeHatch(Dictionary<string, object> args)
        {
            string action = GetStr(args, "action", "inspect").ToLowerInvariant();

            if (action == "list_handles")
            {
                List<object> list = new List<object>();
                foreach (KeyValuePair<string, object> kv in _handles)
                {
                    string name = "";
                    IEngineeringObject eo = kv.Value as IEngineeringObject;
                    if (eo != null) { try { object n = eo.GetAttribute("Name"); if (n != null) name = n.ToString(); } catch { } }
                    list.Add(new Dictionary<string, object>
                    {
                        { "handle", kv.Key },
                        { "type", kv.Value.GetType().FullName },
                        { "name", name }
                    });
                }
                return new Dictionary<string, object> { { "count", list.Count }, { "handles", list } };
            }

            if (action == "release_handles")
            {
                string h = GetStr(args, "handle", "");
                if (!string.IsNullOrEmpty(h)) { _handles.Remove(h); return new Dictionary<string, object> { { "released", h } }; }
                int c = _handles.Count;
                _handles.Clear();
                return new Dictionary<string, object> { { "releasedAll", c } };
            }

            object obj = ResolveTargetObject(args);
            string handle = RegisterHandle(obj);
            IEngineeringObject eobj = obj as IEngineeringObject;

            if (action == "inspect")
            {
                string filter = GetStr(args, "filter", "");
                bool readValues = GetBool(args, "includeValues", true);
                List<object> attrs = new List<object>();
                List<object> comps = new List<object>();
                List<string> services = new List<string>();

                if (eobj != null)
                {
                    foreach (EngineeringAttributeInfo ai in eobj.GetAttributeInfos())
                    {
                        if (!string.IsNullOrEmpty(filter) && ai.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        Dictionary<string, object> row = new Dictionary<string, object>
                        {
                            { "name", ai.Name },
                            { "access", ai.AccessMode.ToString() },
                            { "types", ai.SupportedTypes != null ? ai.SupportedTypes.Select(t => t.Name).ToArray() : new string[0] }
                        };
                        if (readValues && ai.AccessMode != EngineeringAttributeAccessMode.Write)
                        {
                            try { row["value"] = FormatSimpleValue(eobj.GetAttribute(ai.Name)); } catch { }
                        }
                        attrs.Add(row);
                    }
                    foreach (EngineeringCompositionInfo ci in eobj.GetCompositionInfos())
                    {
                        int count = -1;
                        try
                        {
                            ICollection col = eobj.GetComposition(ci.Name) as ICollection;
                            if (col != null) count = col.Count;
                        }
                        catch { }
                        comps.Add(new Dictionary<string, object> { { "name", ci.Name }, { "count", count } });
                    }
                }

                IEngineeringServiceProvider sp = obj as IEngineeringServiceProvider;
                if (sp != null)
                {
                    foreach (EngineeringServiceInfo si in sp.GetServiceInfos())
                    {
                        services.Add(si.Type.FullName);
                    }
                }

                List<string> clrMethods = obj.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .Where(m => !m.IsSpecialName && m.DeclaringType != typeof(object))
                    .Select(m => m.ReturnType.Name + " " + m.Name + "(" + string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name).ToArray()) + ")")
                    .Distinct()
                    .Take(60)
                    .ToList();

                return new Dictionary<string, object>
                {
                    { "handle", handle },
                    { "clrType", obj.GetType().FullName },
                    { "attributes", attrs },
                    { "compositions", comps },
                    { "services", services },
                    { "methods", clrMethods }
                };
            }

            if (action == "get")
            {
                string attr = GetStr(args, "attribute", "");
                string compName = GetStr(args, "composition", "");
                string serviceName = GetStr(args, "service", "");

                if (!string.IsNullOrEmpty(attr))
                {
                    if (eobj != null)
                    {
                        try { return new Dictionary<string, object> { { "handle", handle }, { "attribute", attr }, { "value", FormatSimpleValue(eobj.GetAttribute(attr)) } }; }
                        catch { }
                    }
                    PropertyInfo pi = obj.GetType().GetProperty(attr, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                    if (pi == null) throw new InvalidOperationException("Attribute or property '" + attr + "' not found on " + obj.GetType().Name);
                    object val = pi.GetValue(obj, null);
                    return new Dictionary<string, object>
                    {
                        { "handle", handle },
                        { "property", pi.Name },
                        { "value", IsSimpleType(val != null ? val.GetType() : typeof(string)) ? FormatSimpleValue(val) : RegisterHandle(val) }
                    };
                }

                if (!string.IsNullOrEmpty(compName) && eobj != null)
                {
                    object comp = eobj.GetComposition(compName);
                    IEnumerable en = comp as IEnumerable;
                    if (en == null) return new Dictionary<string, object> { { "compositionHandle", RegisterHandle(comp) } };
                    string findName = GetStr(args, "findName", "");
                    int idx = GetInt(args, "index", -1);
                    List<object> items = new List<object>();
                    int i = 0;
                    foreach (object child in en)
                    {
                        string cName = "";
                        IEngineeringObject ceo = child as IEngineeringObject;
                        if (ceo != null) { try { object n = ceo.GetAttribute("Name"); if (n != null) cName = n.ToString(); } catch { } }
                        if (!string.IsNullOrEmpty(findName) && string.Equals(cName, findName, StringComparison.OrdinalIgnoreCase))
                        {
                            return new Dictionary<string, object> { { "handle", RegisterHandle(child) }, { "name", cName }, { "type", child.GetType().Name } };
                        }
                        if (idx >= 0 && i == idx)
                        {
                            return new Dictionary<string, object> { { "handle", RegisterHandle(child) }, { "name", cName }, { "type", child.GetType().Name } };
                        }
                        items.Add(new Dictionary<string, object> { { "index", i }, { "handle", RegisterHandle(child) }, { "name", cName }, { "type", child.GetType().Name } });
                        i++;
                    }
                    return new Dictionary<string, object> { { "composition", compName }, { "count", items.Count }, { "items", items } };
                }

                if (!string.IsNullOrEmpty(serviceName))
                {
                    IEngineeringServiceProvider sp = obj as IEngineeringServiceProvider;
                    if (sp == null) throw new InvalidOperationException(obj.GetType().Name + " is not an IEngineeringServiceProvider.");
                    EngineeringServiceInfo si = sp.GetServiceInfos().FirstOrDefault(s =>
                        string.Equals(s.Type.FullName, serviceName, StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(s.Type.Name, serviceName, StringComparison.OrdinalIgnoreCase));
                    if (si == null) throw new InvalidOperationException("Service '" + serviceName + "' not available on " + obj.GetType().Name);
                    MethodInfo gm = obj.GetType().GetMethod("GetService").MakeGenericMethod(si.Type);
                    object svc = gm.Invoke(obj, null);
                    return new Dictionary<string, object> { { "service", si.Type.FullName }, { "handle", RegisterHandle(svc) } };
                }

                throw new ArgumentException("Provide 'attribute', 'composition', or 'service' for escape_hatch get.");
            }

            if (action == "set")
            {
                if (eobj == null) throw new InvalidOperationException("Target " + obj.GetType().Name + " is not an IEngineeringObject.");
                Dictionary<string, object> attrs = GetDict(args, "attributes");
                string singleAttr = GetStr(args, "attribute", "");
                if (!string.IsNullOrEmpty(singleAttr) && args.ContainsKey("value"))
                {
                    attrs[singleAttr] = args["value"];
                }
                List<string> updated = new List<string>();
                foreach (KeyValuePair<string, object> kv in attrs)
                {
                    object coerced = CoerceAttributeValue(eobj, kv.Key, kv.Value);
                    eobj.SetAttribute(kv.Key, coerced);
                    updated.Add(kv.Key + "=" + Convert.ToString(coerced));
                }
                return new Dictionary<string, object> { { "handle", handle }, { "updated", updated } };
            }

            if (action == "invoke")
            {
                string methodName = GetStr(args, "method", "");
                if (string.IsNullOrEmpty(methodName)) throw new ArgumentException("method is required.");
                ArrayList rawArgs = args.ContainsKey("methodArgs") && args["methodArgs"] is ArrayList ? (ArrayList)args["methodArgs"] : new ArrayList();

                MethodInfo[] candidates = obj.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .Where(m => string.Equals(m.Name, methodName, StringComparison.OrdinalIgnoreCase) && m.GetParameters().Length == rawArgs.Count)
                    .ToArray();
                if (candidates.Length == 0) throw new InvalidOperationException("Public method '" + methodName + "' with " + rawArgs.Count + " parameter(s) not found on " + obj.GetType().Name);

                Exception lastErr = null;
                foreach (MethodInfo mi in candidates)
                {
                    try
                    {
                        ParameterInfo[] ps = mi.GetParameters();
                        object[] callArgs = new object[ps.Length];
                        for (int i = 0; i < ps.Length; i++) callArgs[i] = CoerceToType(ps[i].ParameterType, rawArgs[i]);
                        object ret = mi.Invoke(obj, callArgs);
                        return new Dictionary<string, object>
                        {
                            { "invoked", mi.Name },
                            { "result", ret == null ? null : (IsSimpleType(ret.GetType()) ? FormatSimpleValue(ret) : RegisterHandle(ret)) }
                        };
                    }
                    catch (Exception ex) { lastErr = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex; }
                }
                throw lastErr ?? new InvalidOperationException("Failed to invoke " + methodName);
            }

            throw new ArgumentException("Unknown escape_hatch action: " + action);
        }

        // ==================== 2. CLOSED-LOOP S7-PLCSIM V20 RUNTIME API ====================
#if WITH_PLCSIM_API
        private readonly Dictionary<string, IInstance> _simInstances = new Dictionary<string, IInstance>(StringComparer.OrdinalIgnoreCase);

        private IInstance GetOrAttachSimInstance(Dictionary<string, object> args)
        {
            string instName = GetStr(args, "instanceName", "");
            if (!string.IsNullOrEmpty(instName) && _simInstances.ContainsKey(instName))
            {
                return _simInstances[instName];
            }
            SInstanceInfo[] regs = SimulationRuntimeManager.RegisteredInstanceInfo;
            if (string.IsNullOrEmpty(instName))
            {
                if (regs == null || regs.Length == 0) throw new InvalidOperationException("No registered PLCSIM virtual PLC instance found. Use action='register' first or start a virtual PLC in S7-PLCSIM V20 / PLCSIM Advanced.");
                instName = regs[0].Name;
            }
            IInstance inst = SimulationRuntimeManager.CreateInterface(instName);
            _simInstances[instName] = inst;
            return inst;
        }

        private static bool TryParseRawPlcAddress(string spec, out char area, out char width, out uint byteOffset, out byte bitOffset, out string explicitType)
        {
            area = '\0'; width = 'X'; byteOffset = 0; bitOffset = 0; explicitType = null;
            if (string.IsNullOrEmpty(spec)) return false;
            string s = spec.Trim();
            if (!s.StartsWith("%")) return false;
            int colon = s.IndexOf(':');
            if (colon > 0) { explicitType = s.Substring(colon + 1).Trim(); s = s.Substring(0, colon).Trim(); }
            if (s.Length < 3) return false;
            area = char.ToUpperInvariant(s[1]);
            if (area != 'I' && area != 'Q' && area != 'M') return false;
            int idx = 2;
            char c2 = char.ToUpperInvariant(s[idx]);
            if (c2 == 'X' || c2 == 'B' || c2 == 'W' || c2 == 'D') { width = c2; idx++; }
            string rest = s.Substring(idx);
            if (width == 'X')
            {
                string[] parts = rest.Split('.');
                if (parts.Length != 2) return false;
                if (!uint.TryParse(parts[0], out byteOffset) || !byte.TryParse(parts[1], out bitOffset)) return false;
                return bitOffset <= 7;
            }
            return uint.TryParse(rest, out byteOffset);
        }

        private static object ReadSimSignal(IInstance inst, string signal)
        {
            char area, width; uint bOff; byte bit; string expType;
            if (TryParseRawPlcAddress(signal, out area, out width, out bOff, out bit, out expType))
            {
                IIOArea io = area == 'I' ? inst.InputArea : (area == 'Q' ? inst.OutputArea : inst.MarkerArea);
                if (width == 'X') return io.ReadBit(bOff, bit);
                if (width == 'B') return io.ReadByte(bOff);
                if (width == 'W')
                {
                    byte[] b = io.ReadBytes(bOff, 2);
                    Array.Reverse(b); // Big-endian S7 memory to little-endian x64
                    if (string.Equals(expType, "UInt", StringComparison.OrdinalIgnoreCase) || string.Equals(expType, "Word", StringComparison.OrdinalIgnoreCase))
                        return BitConverter.ToUInt16(b, 0);
                    return BitConverter.ToInt16(b, 0);
                }
                if (width == 'D')
                {
                    byte[] b = io.ReadBytes(bOff, 4);
                    Array.Reverse(b);
                    if (string.Equals(expType, "Real", StringComparison.OrdinalIgnoreCase)) return BitConverter.ToSingle(b, 0);
                    if (string.Equals(expType, "UDInt", StringComparison.OrdinalIgnoreCase) || string.Equals(expType, "DWord", StringComparison.OrdinalIgnoreCase))
                        return BitConverter.ToUInt32(b, 0);
                    return BitConverter.ToInt32(b, 0);
                }
            }

            string cleanTag = signal.Trim();
            SDataValue dv = inst.Read(cleanTag);
            switch (dv.Type)
            {
                case EPrimitiveDataType.Bool: return dv.Bool;
                case EPrimitiveDataType.Int8: return dv.Int8;
                case EPrimitiveDataType.Int16: return dv.Int16;
                case EPrimitiveDataType.Int32: return dv.Int32;
                case EPrimitiveDataType.Int64: return dv.Int64;
                case EPrimitiveDataType.UInt8: return dv.UInt8;
                case EPrimitiveDataType.UInt16: return dv.UInt16;
                case EPrimitiveDataType.UInt32: return dv.UInt32;
                case EPrimitiveDataType.UInt64: return dv.UInt64;
                case EPrimitiveDataType.Float: return Math.Round(dv.Float, 4);
                case EPrimitiveDataType.Double: return Math.Round(dv.Double, 6);
                case EPrimitiveDataType.Char: return (char)dv.Char;
                case EPrimitiveDataType.WChar: return dv.WChar;
                default: return dv.ToString();
            }
        }

        private static void WriteSimSignal(IInstance inst, string signal, object val)
        {
            char area, width; uint bOff; byte bit; string expType;
            if (TryParseRawPlcAddress(signal, out area, out width, out bOff, out bit, out expType))
            {
                IIOArea io = area == 'I' ? inst.InputArea : (area == 'Q' ? inst.OutputArea : inst.MarkerArea);
                if (width == 'X')
                {
                    bool bv = val is bool ? (bool)val : (Convert.ToDouble(val, CultureInfo.InvariantCulture) != 0);
                    io.WriteBit(bOff, bit, bv);
                    return;
                }
                if (width == 'B') { io.WriteByte(bOff, Convert.ToByte(val, CultureInfo.InvariantCulture)); return; }
                if (width == 'W')
                {
                    short sv = Convert.ToInt16(val, CultureInfo.InvariantCulture);
                    byte[] b = BitConverter.GetBytes(sv);
                    Array.Reverse(b);
                    io.WriteBytes(bOff, b);
                    return;
                }
                if (width == 'D')
                {
                    byte[] b = string.Equals(expType, "Real", StringComparison.OrdinalIgnoreCase) || val is double || val is float || val is decimal
                        ? BitConverter.GetBytes(Convert.ToSingle(val, CultureInfo.InvariantCulture))
                        : BitConverter.GetBytes(Convert.ToInt32(val, CultureInfo.InvariantCulture));
                    Array.Reverse(b);
                    io.WriteBytes(bOff, b);
                    return;
                }
            }

            string cleanTag = signal.Trim();
            SDataValue cur = inst.Read(cleanTag);
            switch (cur.Type)
            {
                case EPrimitiveDataType.Bool:
                    inst.WriteBool(cleanTag, val is bool ? (bool)val : (Convert.ToDouble(val, CultureInfo.InvariantCulture) != 0));
                    break;
                case EPrimitiveDataType.Int8: inst.WriteInt8(cleanTag, Convert.ToSByte(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.Int16: inst.WriteInt16(cleanTag, Convert.ToInt16(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.Int32: inst.WriteInt32(cleanTag, Convert.ToInt32(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.Int64: inst.WriteInt64(cleanTag, Convert.ToInt64(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.UInt8: inst.WriteUInt8(cleanTag, Convert.ToByte(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.UInt16: inst.WriteUInt16(cleanTag, Convert.ToUInt16(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.UInt32: inst.WriteUInt32(cleanTag, Convert.ToUInt32(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.UInt64: inst.WriteUInt64(cleanTag, Convert.ToUInt64(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.Float: inst.WriteFloat(cleanTag, Convert.ToSingle(val, CultureInfo.InvariantCulture)); break;
                case EPrimitiveDataType.Double: inst.WriteDouble(cleanTag, Convert.ToDouble(val, CultureInfo.InvariantCulture)); break;
                default:
                    if (val is string) inst.WriteString(cleanTag, (string)val);
                    else throw new InvalidOperationException("Cannot write non-primitive tag '" + cleanTag + "' of type " + cur.Type);
                    break;
            }
        }

        private object CmdPlcsimRuntime(Dictionary<string, object> args)
        {
            string action = GetStr(args, "action", "status").ToLowerInvariant();

            if (action == "status")
            {
                Dictionary<string, object> res = new Dictionary<string, object>();
                res["plcsimV20GuiRunning"] = Process.GetProcessesByName("S7PLCSIMV20").Length > 0;
                res["vplcHostRunning"] = Process.GetProcessesByName("Siemens.Simatic.PlcSim.VplcHost64").Length > 0
                    || Process.GetProcessesByName("Siemens.Simatic.PlcSim.VplcHost").Length > 0;
                try
                {
                    res["runtimeAvailable"] = SimulationRuntimeManager.IsRuntimeManagerAvailable;
                    res["runtimeInitialized"] = SimulationRuntimeManager.IsInitialized;
                    res["networkMode"] = SimulationRuntimeManager.NetworkMode.ToString();
                    List<object> list = new List<object>();
                    SInstanceInfo[] infos = SimulationRuntimeManager.RegisteredInstanceInfo;
                    if (infos != null)
                    {
                        foreach (SInstanceInfo ii in infos)
                        {
                            Dictionary<string, object> row = new Dictionary<string, object>
                            {
                                { "id", ii.ID },
                                { "name", ii.Name }
                            };
                            try
                            {
                                IInstance inst = SimulationRuntimeManager.CreateInterface(ii.ID);
                                row["operatingState"] = inst.OperatingState.ToString();
                                row["communicationInterface"] = inst.CommunicationInterface.ToString();
                                row["ips"] = inst.ControllerIP;
                            }
                            catch { }
                            list.Add(row);
                        }
                    }
                    res["instances"] = list;
                }
                catch (Exception ex)
                {
                    res["runtimeAvailable"] = false;
                    res["runtimeNote"] = ex.GetType().Name + ": " + ex.Message + " (Start a virtual PLC instance in S7-PLCSIM V20 or PLCSIM Advanced to initialize the Simulation Runtime bus).";
                    res["instances"] = new object[0];
                }
                return res;
            }

            if (action == "register")
            {
                string instName = GetStr(args, "instanceName", "PLC_1_Sim");
                string article = GetStr(args, "articleNumber", "");
                string cpuTypeStr = GetStr(args, "cpuType", "CPU1500_Unspecified");
                bool powerOn = GetBool(args, "powerOn", true);
                bool runCpu = GetBool(args, "run", false);

                IInstance inst = null;
                SInstanceInfo[] existing = SimulationRuntimeManager.RegisteredInstanceInfo;
                if (existing != null && existing.Any(x => string.Equals(x.Name, instName, StringComparison.OrdinalIgnoreCase)))
                {
                    inst = SimulationRuntimeManager.CreateInterface(instName);
                }
                else if (!string.IsNullOrEmpty(article))
                {
                    inst = SimulationRuntimeManager.RegisterInstance(article, instName);
                }
                else
                {
                    ECPUType ct = (ECPUType)Enum.Parse(typeof(ECPUType), cpuTypeStr, true);
                    inst = SimulationRuntimeManager.RegisterInstance(ct, instName);
                }
                _simInstances[instName] = inst;

                if (powerOn && inst.OperatingState == EOperatingState.Off)
                {
                    inst.PowerOn(60000);
                }
                string ip = GetStr(args, "ipAddress", "");
                if (!string.IsNullOrEmpty(ip))
                {
                    string mask = GetStr(args, "subnetMask", "255.255.255.0");
                    string gw = GetStr(args, "gateway", "0.0.0.0");
                    SIPSuite4 suite = new SIPSuite4();
                    suite.IPAddress = new SIP { IPString = ip };
                    suite.SubnetMask = new SIP { IPString = mask };
                    suite.DefaultGateway = new SIP { IPString = gw };
                    inst.SetIPSuite(0, suite, true);
                }
                if (runCpu) inst.Run(30000);

                return new Dictionary<string, object>
                {
                    { "instanceName", inst.Name },
                    { "id", inst.ID },
                    { "operatingState", inst.OperatingState.ToString() },
                    { "ips", inst.ControllerIP }
                };
            }

            IInstance targetInst = GetOrAttachSimInstance(args);

            if (action == "control")
            {
                string op = GetStr(args, "operation", "run").ToLowerInvariant();
                uint timeout = (uint)GetInt(args, "timeoutMs", 30000);
                switch (op)
                {
                    case "power_on": targetInst.PowerOn(timeout); break;
                    case "power_off": targetInst.PowerOff(timeout); break;
                    case "run": targetInst.Run(timeout); break;
                    case "stop": targetInst.Stop(timeout); break;
                    case "memory_reset": targetInst.MemoryReset(timeout); break;
                    case "unregister": targetInst.UnregisterInstance(); _simInstances.Remove(targetInst.Name); return new Dictionary<string, object> { { "unregistered", true } };
                    default: throw new ArgumentException("Unknown control operation: " + op + " (use power_on | power_off | run | stop | memory_reset | unregister)");
                }
                return new Dictionary<string, object>
                {
                    { "instanceName", targetInst.Name },
                    { "operatingState", targetInst.OperatingState.ToString() }
                };
            }

            if (action == "list_tags")
            {
                string search = GetStr(args, "search", "");
                int limit = GetInt(args, "limit", 200);
                targetInst.UpdateTagList(ETagListDetails.IOMCTDB, false);
                List<object> tags = new List<object>();
                foreach (STagInfo ti in (targetInst.TagInfos ?? new STagInfo[0]))
                {
                    if (tags.Count >= limit) break;
                    if (!string.IsNullOrEmpty(search) && (ti.Name == null || ti.Name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0)) continue;
                    tags.Add(new Dictionary<string, object>
                    {
                        { "name", ti.Name },
                        { "area", ti.Area.ToString() },
                        { "dataType", ti.DataType.ToString() },
                        { "primitiveType", ti.PrimitiveDataType.ToString() },
                        { "offset", ti.Offset },
                        { "bit", ti.Bit }
                    });
                }
                return new Dictionary<string, object> { { "instanceName", targetInst.Name }, { "count", tags.Count }, { "tags", tags } };
            }

            if (action == "read")
            {
                if (GetBool(args, "refreshTagList", false)) targetInst.UpdateTagList(ETagListDetails.IOMCTDB, false);
                ArrayList signals = args.ContainsKey("signals") && args["signals"] is ArrayList ? (ArrayList)args["signals"] : new ArrayList();
                Dictionary<string, object> values = new Dictionary<string, object>();
                foreach (object s in signals)
                {
                    string sig = Convert.ToString(s);
                    if (string.IsNullOrEmpty(sig)) continue;
                    try { values[sig] = ReadSimSignal(targetInst, sig); }
                    catch { targetInst.UpdateTagList(ETagListDetails.IOMCTDB, false); values[sig] = ReadSimSignal(targetInst, sig); }
                }
                return new Dictionary<string, object>
                {
                    { "instanceName", targetInst.Name },
                    { "operatingState", targetInst.OperatingState.ToString() },
                    { "values", values }
                };
            }

            if (action == "write")
            {
                if (GetBool(args, "refreshTagList", false)) targetInst.UpdateTagList(ETagListDetails.IOMCTDB, false);
                Dictionary<string, object> writes = GetDict(args, "values");
                List<string> done = new List<string>();
                foreach (KeyValuePair<string, object> kv in writes)
                {
                    try { WriteSimSignal(targetInst, kv.Key, kv.Value); }
                    catch { targetInst.UpdateTagList(ETagListDetails.IOMCTDB, false); WriteSimSignal(targetInst, kv.Key, kv.Value); }
                    done.Add(kv.Key + "=" + Convert.ToString(kv.Value));
                }
                return new Dictionary<string, object>
                {
                    { "instanceName", targetInst.Name },
                    { "written", done }
                };
            }

            if (action == "run_sequence")
            {
                targetInst.UpdateTagList(ETagListDetails.IOMCTDB, false);
                ArrayList watchList = args.ContainsKey("watch") && args["watch"] is ArrayList ? (ArrayList)args["watch"] : new ArrayList();
                ArrayList steps = args.ContainsKey("steps") && args["steps"] is ArrayList ? (ArrayList)args["steps"] : new ArrayList();
                int sampleIntervalMs = Math.Max(10, GetInt(args, "sampleIntervalMs", 50));

                List<object> samples = new List<object>();
                List<object> assertions = new List<object>();
                bool allPassed = true;
                Stopwatch sw = Stopwatch.StartNew();

                Action takeSample = delegate()
                {
                    if (watchList.Count == 0) return;
                    Dictionary<string, object> snap = new Dictionary<string, object>();
                    foreach (object w in watchList)
                    {
                        string sig = Convert.ToString(w);
                        try { snap[sig] = ReadSimSignal(targetInst, sig); } catch { }
                    }
                    samples.Add(new Dictionary<string, object>
                    {
                        { "tMs", sw.ElapsedMilliseconds },
                        { "values", snap }
                    });
                };

                takeSample();
                int stepIdx = 0;
                foreach (object rawStep in steps)
                {
                    stepIdx++;
                    Dictionary<string, object> st = rawStep as Dictionary<string, object>;
                    if (st == null) continue;

                    Dictionary<string, object> wr = GetDict(st, "write");
                    foreach (KeyValuePair<string, object> kv in wr) WriteSimSignal(targetInst, kv.Key, kv.Value);

                    string pulseSig = GetStr(st, "pulse", "");
                    if (!string.IsNullOrEmpty(pulseSig))
                    {
                        int pulseMs = Math.Max(20, GetInt(st, "pulseMs", 100));
                        WriteSimSignal(targetInst, pulseSig, true);
                        Thread.Sleep(pulseMs);
                        takeSample();
                        WriteSimSignal(targetInst, pulseSig, false);
                    }

                    int waitMs = GetInt(st, "waitMs", 0);
                    if (waitMs > 0)
                    {
                        int elapsed = 0;
                        while (elapsed < waitMs)
                        {
                            int sleepChunk = Math.Min(sampleIntervalMs, waitMs - elapsed);
                            Thread.Sleep(sleepChunk);
                            elapsed += sleepChunk;
                            takeSample();
                        }
                    }
                    else
                    {
                        takeSample();
                    }

                    Dictionary<string, object> exp = GetDict(st, "expect");
                    double tol = st.ContainsKey("tolerance") ? Convert.ToDouble(st["tolerance"], CultureInfo.InvariantCulture) : 0.01;
                    foreach (KeyValuePair<string, object> kv in exp)
                    {
                        object actual = ReadSimSignal(targetInst, kv.Key);
                        bool ok = CompareSimValues(actual, kv.Value, tol);
                        if (!ok) allPassed = false;
                        assertions.Add(new Dictionary<string, object>
                        {
                            { "step", stepIdx },
                            { "tMs", sw.ElapsedMilliseconds },
                            { "signal", kv.Key },
                            { "expected", kv.Value },
                            { "actual", actual },
                            { "ok", ok }
                        });
                    }
                }

                return new Dictionary<string, object>
                {
                    { "instanceName", targetInst.Name },
                    { "passed", allPassed },
                    { "elapsedMs", sw.ElapsedMilliseconds },
                    { "assertions", assertions },
                    { "sampleCount", samples.Count },
                    { "samples", samples }
                };
            }

            throw new ArgumentException("Unknown plcsim_runtime action: " + action);
        }

        private static bool CompareSimValues(object actual, object expected, double tol)
        {
            if (actual == null && expected == null) return true;
            if (actual == null || expected == null) return false;
            if (actual is bool || expected is bool)
            {
                bool a = actual is bool ? (bool)actual : (Convert.ToDouble(actual, CultureInfo.InvariantCulture) != 0);
                bool b = expected is bool ? (bool)expected : (Convert.ToDouble(expected, CultureInfo.InvariantCulture) != 0);
                return a == b;
            }
            try
            {
                double da = Convert.ToDouble(actual, CultureInfo.InvariantCulture);
                double db = Convert.ToDouble(expected, CultureInfo.InvariantCulture);
                return Math.Abs(da - db) <= tol;
            }
            catch
            {
                return string.Equals(Convert.ToString(actual), Convert.ToString(expected), StringComparison.OrdinalIgnoreCase);
            }
        }
#else
        private object CmdPlcsimRuntime(Dictionary<string, object> args)
        {
            throw new InvalidOperationException("TiaBridge.exe was compiled without Siemens.Simatic.Simulation.Runtime.Api.x64.dll. Install S7-PLCSIM V20 / PLCSIM Advanced and run build.ps1.");
        }
#endif
    }
}
