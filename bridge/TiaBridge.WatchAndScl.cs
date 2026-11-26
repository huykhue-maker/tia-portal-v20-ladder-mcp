using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Siemens.Engineering;
using Siemens.Engineering.Connection;
#if !TIA_V16
using Siemens.Engineering.CrossReference;
#endif
using Siemens.Engineering.HW;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.ExternalSources;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;
using Siemens.Engineering.SW.WatchAndForceTables;
using Siemens.Engineering.Upload;
using Siemens.Engineering.Upload.Configurations;

namespace TiaBridge
{
    internal partial class BridgeHost
    {
        // -------------------- Watch & Force Tables --------------------
        private PlcWatchTable FindWatchTable(PlcWatchAndForceTableGroup grp, string name, out PlcWatchAndForceTableGroup owner)
        {
            PlcWatchTable wt = grp.WatchTables.Find(name);
            if (wt != null) { owner = grp; return wt; }
            foreach (PlcWatchAndForceTableUserGroup sub in grp.Groups)
            {
                wt = FindWatchTable(sub, name, out owner);
                if (wt != null) return wt;
            }
            owner = null;
            return null;
        }

        private void WalkWatchGroup(PlcWatchAndForceTableGroup grp, string path, List<object> watchList, List<object> forceList)
        {
            foreach (PlcWatchTable wt in grp.WatchTables)
            {
                watchList.Add(new Dictionary<string, object>
                {
                    { "name", wt.Name },
                    { "group", path },
                    { "entryCount", wt.Entries.Count },
                    { "isConsistent", wt.IsConsistent }
                });
            }
            foreach (PlcForceTable ft in grp.ForceTables)
            {
                int fCount = 0;
                try
                {
                    IEnumerable en = ((IEngineeringObject)ft).GetComposition("Entries") as IEnumerable;
                    if (en != null) foreach (object x in en) { fCount++; if (x == null) { } }
                }
                catch { }
                forceList.Add(new Dictionary<string, object>
                {
                    { "name", ft.Name },
                    { "group", path },
                    { "entryCount", fCount }
                });
            }
            foreach (PlcWatchAndForceTableUserGroup sub in grp.Groups)
            {
                string sp = string.IsNullOrEmpty(path) ? sub.Name : path + "/" + sub.Name;
                WalkWatchGroup(sub, sp, watchList, forceList);
            }
        }

        private static string GetMlComment(object obj)
        {
            try
            {
                PropertyInfo pi = obj.GetType().GetProperty("Comment");
                if (pi == null) return "";
                MultilingualText mt = pi.GetValue(obj, null) as MultilingualText;
                if (mt != null && mt.Items != null && mt.Items.Count > 0)
                {
                    foreach (MultilingualTextItem it in mt.Items)
                    {
                        if (!string.IsNullOrEmpty(it.Text)) return it.Text;
                    }
                }
            }
            catch { }
            return "";
        }

        private static bool SetMlComment(object obj, string comment, out string error)
        {
            error = null;
            if (comment == null) return false;
            try
            {
                PropertyInfo pi = obj.GetType().GetProperty("Comment");
                MultilingualText mt = pi != null ? (pi.GetValue(obj, null) as MultilingualText) : null;
                if (mt == null && obj is IEngineeringObject)
                {
                    mt = ((IEngineeringObject)obj).GetAttribute("Comment") as MultilingualText;
                }
                if (mt != null && mt.Items != null && mt.Items.Count > 0)
                {
                    mt.Items[0].Text = comment;
                    return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static PlcWatchAndForceTableDisplayFormat ParseDisplayFormat(string fmt)
        {
            if (string.IsNullOrEmpty(fmt)) return PlcWatchAndForceTableDisplayFormat.Undef;
            string f = fmt.Trim();
            foreach (string enumName in Enum.GetNames(typeof(PlcWatchAndForceTableDisplayFormat)))
            {
                if (string.Equals(enumName, f, StringComparison.OrdinalIgnoreCase))
                {
                    return (PlcWatchAndForceTableDisplayFormat)Enum.Parse(typeof(PlcWatchAndForceTableDisplayFormat), enumName);
                }
            }
            string low = f.ToLowerInvariant().Replace(" ", "").Replace("_", "");
            if (low == "auto" || low == "undef" || low == "default") return PlcWatchAndForceTableDisplayFormat.Undef;
            if (low.Contains("bool")) return PlcWatchAndForceTableDisplayFormat.Bool;
            if (low.Contains("float") || low.Contains("real")) return PlcWatchAndForceTableDisplayFormat.Float;
            if (low.Contains("hex")) return PlcWatchAndForceTableDisplayFormat.Hex;
            if (low.Contains("bin")) return PlcWatchAndForceTableDisplayFormat.Bin;
            if (low.Contains("oct")) return PlcWatchAndForceTableDisplayFormat.Octal;
            if (low.Contains("bcd")) return PlcWatchAndForceTableDisplayFormat.BCD;
            if (low.Contains("unsigned") || low == "udec") return PlcWatchAndForceTableDisplayFormat.DEC_unsigned;
            if (low == "dec" || low.Contains("int") || low.Contains("signed")) return PlcWatchAndForceTableDisplayFormat.DEC_signed;
            if (low.Contains("simatictime") || low == "s5time") return PlcWatchAndForceTableDisplayFormat.SIMATIC_Time;
            if (low.Contains("tod") || low.Contains("timeofday")) return PlcWatchAndForceTableDisplayFormat.TIME_OF_DAY;
            if (low.Contains("dt") || low.Contains("dateandtime")) return PlcWatchAndForceTableDisplayFormat.DATE_AND_TIME;
            if (low.Contains("date")) return PlcWatchAndForceTableDisplayFormat.Date;
            if (low.Contains("time")) return PlcWatchAndForceTableDisplayFormat.Time;
            if (low.Contains("counter")) return PlcWatchAndForceTableDisplayFormat.Counter;
            if (low.Contains("pointer") || low.Contains("any")) return PlcWatchAndForceTableDisplayFormat.Pointer;
            if (low.Contains("str")) return PlcWatchAndForceTableDisplayFormat.String;
            if (low.Contains("char")) return PlcWatchAndForceTableDisplayFormat.Character;
#if !TIA_V16
            if (low.Contains("symbol")) return PlcWatchAndForceTableDisplayFormat.Symbolic;
#endif
            return PlcWatchAndForceTableDisplayFormat.Undef;
        }

        private static string GetEntryComment(PlcTableCommentEntry entry)
        {
            try
            {
                object raw = ((IEngineeringObject)entry).GetAttribute("Comment");
                MultilingualText mt = raw as MultilingualText;
                if (mt != null && mt.Items != null && mt.Items.Count > 0)
                {
                    foreach (MultilingualTextItem it in mt.Items)
                    {
                        if (!string.IsNullOrEmpty(it.Text)) return it.Text;
                    }
                }
                return raw != null ? raw.ToString() : "";
            }
            catch { return ""; }
        }

        private static bool TrySetEntryAttr(PlcTableCommentEntry entry, string name, object value, out string error)
        {
            error = null;
            if (value == null) return false;
            try
            {
                ((IEngineeringObject)entry).SetAttribute(name, value);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static string FormatEntryAttr(PlcTableCommentEntry entry, string name)
        {
            try
            {
                object v = ((IEngineeringObject)entry).GetAttribute(name);
                return v != null ? v.ToString() : "";
            }
            catch { return ""; }
        }

        private object CmdWatchTable(Dictionary<string, object> args)
        {
            string action = GetStr(args, "action", "list").ToLowerInvariant();
            PlcTarget plc = ResolvePlc(args, action != "list" && action != "read" && action != "export");
            PlcWatchAndForceTableGroup root = plc.Software.WatchAndForceTableGroup;

            if (action == "list")
            {
                List<object> wts = new List<object>();
                List<object> fts = new List<object>();
                WalkWatchGroup(root, "", wts, fts);
                return new Dictionary<string, object>
                {
                    { "plc", plc.CpuItem.Name },
                    { "watchTables", wts },
                    { "forceTables", fts }
                };
            }

            string tableName = GetStr(args, "name", "Watch_Table_MCP");
            PlcWatchAndForceTableGroup owner;
            PlcWatchTable wt = FindWatchTable(root, tableName, out owner);

            if (action == "read")
            {
                if (wt == null) throw new InvalidOperationException("Watch table '" + tableName + "' not found.");
                List<object> rows = new List<object>();
                foreach (PlcTableCommentEntry e in wt.Entries)
                {
                    rows.Add(new Dictionary<string, object>
                    {
                        { "name", FormatEntryAttr(e, "Name") },
                        { "address", FormatEntryAttr(e, "Address") },
                        { "displayFormat", FormatEntryAttr(e, "DisplayFormat") },
                        { "modifyValue", FormatEntryAttr(e, "ModifyValue") },
                        { "comment", GetEntryComment(e) }
                    });
                }
                if (GetBool(args, "showInEditor", false)) wt.ShowInEditor();
                return new Dictionary<string, object>
                {
                    { "table", wt.Name },
                    { "entryCount", rows.Count },
                    { "entries", rows }
                };
            }

            if (action == "delete")
            {
                if (wt == null) throw new InvalidOperationException("Watch table '" + tableName + "' not found.");
                wt.Delete();
                return new Dictionary<string, object> { { "deleted", tableName } };
            }

            if (action == "export")
            {
                if (wt == null) throw new InvalidOperationException("Watch table '" + tableName + "' not found.");
                string outPath = GetStr(args, "path", "");
                FileInfo fi = new FileInfo(outPath);
                if (fi.Directory != null && !fi.Directory.Exists) fi.Directory.Create();
                if (fi.Exists) fi.Delete();
                wt.Export(fi, ExportOptions.WithDefaults);
                return new Dictionary<string, object> { { "table", wt.Name }, { "path", fi.FullName } };
            }

            if (action == "import")
            {
                string xmlPath = GetStr(args, "path", "");
                FileInfo fi = new FileInfo(xmlPath);
                if (!fi.Exists) throw new FileNotFoundException("Watch table XML not found: " + fi.FullName);
                IList<PlcWatchTable> imp = root.WatchTables.Import(fi, ImportOptions.Override);
                bool shown = false;
                if (GetBool(args, "showInEditor", false) && imp.Count > 0) { imp[0].ShowInEditor(); shown = true; }
                return new Dictionary<string, object>
                {
                    { "imported", imp.Select(x => x.Name).ToArray() },
                    { "shownInEditor", shown }
                };
            }

            if (action == "upsert" || action == "create")
            {
                bool clearExisting = GetBool(args, "clearExisting", false);
                if (wt != null && clearExisting)
                {
                    wt.Delete();
                    wt = null;
                }
                if (wt == null)
                {
                    wt = root.WatchTables.Create(tableName);
                }

                object rawEntries;
                List<string> changes = new List<string>();
                List<string> warnings = new List<string>();
                if (args.TryGetValue("entries", out rawEntries) && rawEntries is ArrayList)
                {
                    Dictionary<string, PlcTableCommentEntry> existingMap = new Dictionary<string, PlcTableCommentEntry>(StringComparer.OrdinalIgnoreCase);
                    foreach (PlcTableCommentEntry ex in wt.Entries)
                    {
                        string exName = FormatEntryAttr(ex, "Name");
                        string exAddr = FormatEntryAttr(ex, "Address");
                        string k = !string.IsNullOrEmpty(exName) ? exName : exAddr;
                        if (!string.IsNullOrEmpty(k) && !existingMap.ContainsKey(k)) existingMap[k] = ex;
                    }

                    foreach (object item in (ArrayList)rawEntries)
                    {
                        Dictionary<string, object> ed = item as Dictionary<string, object>;
                        if (ed == null) continue;
                        string eName = GetStr(ed, "name", "");
                        string eAddr = GetStr(ed, "address", "");
                        string eFmt = GetStr(ed, "displayFormat", "");
                        string eMod = GetStr(ed, "modifyValue", null);
                        string eCom = GetStr(ed, "comment", null);

                        string key = !string.IsNullOrEmpty(eName) ? eName : eAddr;
                        if (string.IsNullOrEmpty(key)) continue;

                        PlcTableCommentEntry entry;
                        bool isNew = false;
                        if (!existingMap.TryGetValue(key, out entry))
                        {
                            entry = wt.Entries.Create();
                            existingMap[key] = entry;
                            isNew = true;
                        }

                        // Address must be written before the symbolic name on most V20 CPUs.
                        bool idOk = false;
                        string err;
                        if (!string.IsNullOrEmpty(eAddr))
                        {
                            if (TrySetEntryAttr(entry, "Address", eAddr, out err)) idOk = true;
                            else warnings.Add(key + ": Address='" + eAddr + "' failed (" + err + ")");
                        }
                        if (!string.IsNullOrEmpty(eName))
                        {
                            if (TrySetEntryAttr(entry, "Name", eName, out err)) idOk = true;
                            else warnings.Add(key + ": Name='" + eName + "' failed (" + err + ")");
                        }

                        if (isNew && !idOk)
                        {
                            try { entry.Delete(); } catch { }
                            existingMap.Remove(key);
                            warnings.Add(key + ": removed empty entry because neither Address nor Name could be set");
                            continue;
                        }
                        changes.Add((isNew ? "added " : "updated ") + key);

                        if (!string.IsNullOrEmpty(eFmt))
                        {
                            if (!TrySetEntryAttr(entry, "DisplayFormat", ParseDisplayFormat(eFmt), out err))
                            {
                                warnings.Add(key + ": DisplayFormat='" + eFmt + "' failed (" + err + ")");
                            }
                        }
                        if (eMod != null)
                        {
                            if (!TrySetEntryAttr(entry, "ModifyValue", eMod, out err))
                            {
                                warnings.Add(key + ": ModifyValue failed (" + err + ")");
                            }
                        }
                        if (eCom != null)
                        {
                            string mlErr;
                            if (!SetMlComment(entry, eCom, out mlErr))
                            {
                                if (!TrySetEntryAttr(entry, "Comment", eCom, out err))
                                {
                                    warnings.Add(key + ": Comment failed (" + (mlErr ?? err ?? "unsupported") + ")");
                                }
                            }
                        }
                    }
                }

                bool shown = false;
                if (GetBool(args, "showInEditor", false))
                {
                    try { wt.ShowInEditor(); shown = true; }
                    catch (Exception ex) { warnings.Add("ShowInEditor failed: " + ex.Message); }
                }

                return new Dictionary<string, object>
                {
                    { "table", wt.Name },
                    { "entryCount", wt.Entries.Count },
                    { "changes", changes },
                    { "warnings", warnings },
                    { "shownInEditor", shown }
                };
            }

            throw new ArgumentException("Unknown watch_table action: " + action);
        }

        // -------------------- Show In TIA Portal GUI Editor --------------------
        private object CmdShowInEditor(Dictionary<string, object> args)
        {
            EnsureProject();
            string targetKind = GetStr(args, "kind", "block").ToLowerInvariant();
            string targetName = GetStr(args, "name", "");

            if (targetKind == "device" || targetKind == "network" || targetKind == "topology")
            {
                PlcTarget p = ResolvePlc(args);
                View v = targetKind == "network" ? View.Network : (targetKind == "topology" ? View.Topology : View.Device);
                p.Device.ShowInEditor(v);
                return new Dictionary<string, object> { { "shown", p.Device.Name }, { "view", v.ToString() } };
            }

            PlcTarget plc = ResolvePlc(args);
            if (targetKind == "block")
            {
                if (string.IsNullOrEmpty(targetName)) throw new ArgumentException("name is required for show_in_editor kind 'block'.");
                PlcBlockGroup owner;
                PlcBlock blk = FindBlock(plc.Software.BlockGroup, targetName, out owner);
                if (blk == null) throw new InvalidOperationException("Block '" + targetName + "' not found.");
                blk.ShowInEditor();
                return new Dictionary<string, object> { { "shown", blk.Name }, { "kind", "block" } };
            }
            if (targetKind == "watch_table" || targetKind == "watchtable")
            {
                if (string.IsNullOrEmpty(targetName)) throw new ArgumentException("name is required for show_in_editor kind 'watch_table'.");
                PlcWatchAndForceTableGroup owner;
                PlcWatchTable wt = FindWatchTable(plc.Software.WatchAndForceTableGroup, targetName, out owner);
                if (wt == null) throw new InvalidOperationException("Watch table '" + targetName + "' not found.");
                wt.ShowInEditor();
                return new Dictionary<string, object> { { "shown", wt.Name }, { "kind", "watch_table" } };
            }
            if (targetKind == "tag_table" || targetKind == "tagtable")
            {
                PlcTagTable tt = string.IsNullOrEmpty(targetName)
                    ? plc.Software.TagTableGroup.TagTables.FirstOrDefault(x => x.IsDefault)
                    : FindTagTable(plc.Software.TagTableGroup, targetName);
                if (tt == null) throw new InvalidOperationException("Tag table '" + targetName + "' not found.");
                tt.ShowInEditor();
                return new Dictionary<string, object> { { "shown", tt.Name }, { "kind", "tag_table" } };
            }
            if (targetKind == "udt" || targetKind == "type")
            {
                if (string.IsNullOrEmpty(targetName)) throw new ArgumentException("name is required for show_in_editor kind 'type'.");
                PlcType pt = FindPlcType(plc.Software.TypeGroup, targetName);
                if (pt == null) throw new InvalidOperationException("PLC data type '" + targetName + "' not found.");
                pt.ShowInEditor();
                return new Dictionary<string, object> { { "shown", pt.Name }, { "kind", "type" } };
            }
            throw new ArgumentException("Unknown show_in_editor kind: " + targetKind + " (use block | watch_table | tag_table | type | device | network | topology)");
        }

        // -------------------- SCL & External Text Sources --------------------
        private object CmdSclSource(Dictionary<string, object> args)
        {
            string action = GetStr(args, "action", "export").ToLowerInvariant();
            PlcTarget plc = ResolvePlc(args, action == "import" || action == "write");
            PlcExternalSourceSystemGroup extGrp = plc.Software.ExternalSourceGroup;

            if (action == "export" || action == "read")
            {
                string blockName = GetStr(args, "blockName", "");
                string typeName = GetStr(args, "typeName", "");
                string outPath = GetStr(args, "outPath", "");
                bool withDeps = GetBool(args, "withDependencies", false);

                List<IGenerateSource> targets = new List<IGenerateSource>();
                string label = "";
                string ext = ".scl";

                if (!string.IsNullOrEmpty(blockName))
                {
                    PlcBlockGroup owner;
                    PlcBlock blk = FindBlock(plc.Software.BlockGroup, blockName, out owner);
                    if (blk == null) throw new InvalidOperationException("Block '" + blockName + "' not found.");
                    IGenerateSource gs = blk as IGenerateSource;
                    if (gs == null) throw new InvalidOperationException("Block '" + blockName + "' (" + blk.ProgrammingLanguage + ") does not support text source generation (use tia_read_ladder or tia_export_raw for LAD/FBD).");
                    targets.Add(gs);
                    label = blk.Name;
                    if (blk is GlobalDB || blk is InstanceDB || blk is ArrayDB) ext = ".db";
                }
                else if (!string.IsNullOrEmpty(typeName))
                {
                    PlcType t = FindPlcType(plc.Software.TypeGroup, typeName);
                    if (t == null) throw new InvalidOperationException("UDT '" + typeName + "' not found.");
                    IGenerateSource gs = t as IGenerateSource;
                    if (gs == null) throw new InvalidOperationException("UDT '" + typeName + "' does not support source generation.");
                    targets.Add(gs);
                    label = t.Name;
                    ext = ".udt";
                }
                else
                {
                    throw new ArgumentException("Provide blockName or typeName to export as SCL/DB/UDT text source.");
                }

                if (string.IsNullOrEmpty(outPath))
                {
                    outPath = Path.Combine(Path.GetTempPath(), "tia_mcp_" + label + ext);
                }
                FileInfo fi = new FileInfo(outPath);
                if (fi.Directory != null && !fi.Directory.Exists) fi.Directory.Create();
                if (fi.Exists) fi.Delete();

                GenerateOptions opts = withDeps ? GenerateOptions.WithDependencies : GenerateOptions.None;
                extGrp.GenerateSource(targets, fi, opts);
                string code = File.ReadAllText(fi.FullName, Encoding.UTF8);

                return new Dictionary<string, object>
                {
                    { "name", label },
                    { "path", fi.FullName },
                    { "sourceCode", code }
                };
            }

            if (action == "import" || action == "write")
            {
                string code = GetStr(args, "sourceCode", null);
                string filePath = GetStr(args, "filePath", "");
                string srcName = GetStr(args, "sourceName", "MCP_Generated_Source");
                string groupPath = GetStr(args, "group", "");
                bool keepSource = GetBool(args, "keepExternalSource", false);
                string temporaryPath = null;

                if (!string.IsNullOrEmpty(code))
                {
                    string ext = code.IndexOf("DATA_BLOCK", StringComparison.OrdinalIgnoreCase) >= 0 && code.IndexOf("FUNCTION", StringComparison.OrdinalIgnoreCase) < 0
                            ? ".db"
                            : (code.IndexOf("TYPE ", StringComparison.OrdinalIgnoreCase) >= 0 && code.IndexOf("FUNCTION", StringComparison.OrdinalIgnoreCase) < 0 ? ".udt" : ".scl");
                    temporaryPath = Path.Combine(Path.GetTempPath(), "tia_mcp_scl_" + Guid.NewGuid().ToString("N") + ext);
                    filePath = temporaryPath;
                    File.WriteAllText(filePath, code, new UTF8Encoding(true));
                }

                try
                {
                FileInfo fi = new FileInfo(filePath);
                if (!fi.Exists) throw new FileNotFoundException("SCL/DB/UDT source file not found: " + fi.FullName);

                PlcExternalSource existing = extGrp.ExternalSources.Find(srcName);
                if (existing != null) existing.Delete();

                PlcExternalSource srcObj = extGrp.ExternalSources.CreateFromFile(srcName, fi.FullName);
                IList<IEngineeringObject> generated;
                try
                {
                    if (!string.IsNullOrEmpty(groupPath))
                    {
#if TIA_V16
                        throw new NotSupportedException("TIA V16 Openness generates SCL blocks into the root Program blocks folder; omit 'group'.");
#else
                        PlcBlockGroup grp = FindOrCreateBlockGroup(plc.Software.BlockGroup, groupPath, true);
                        PlcBlockUserGroup ugrp = grp as PlcBlockUserGroup;
                        generated = ugrp != null
                            ? srcObj.GenerateBlocksFromSource(ugrp, GenerateBlockOption.KeepOnError)
                            : srcObj.GenerateBlocksFromSource(GenerateBlockOption.KeepOnError);
#endif
                    }
                    else
                    {
                        generated = srcObj.GenerateBlocksFromSource(GenerateBlockOption.KeepOnError);
                    }
                }
                finally
                {
                    if (!keepSource)
                    {
                        try { srcObj.Delete(); } catch { }
                    }
                }

                List<string> genNames = new List<string>();
                foreach (IEngineeringObject g in generated)
                {
                    try
                    {
                        object n = g.GetAttribute("Name");
                        genNames.Add(n != null ? n.ToString() : g.GetType().Name);
                    }
                    catch { genNames.Add(g.GetType().Name); }
                }

                return new Dictionary<string, object>
                {
                    { "imported", true },
                    { "filePath", fi.FullName },
                    { "generatedObjects", genNames }
                };
                }
                finally { if (temporaryPath != null) { try { File.Delete(temporaryPath); } catch { } } }
            }

            throw new ArgumentException("Unknown scl_source action: " + action);
        }

#if !TIA_V16
        // -------------------- Project-Wide Cross-Reference --------------------
        private object CmdCrossReference(Dictionary<string, object> args)
        {
            PlcTarget plc = ResolvePlc(args);
            string filterStr = GetStr(args, "filter", "used").ToLowerInvariant();
            string symbolFilter = GetStr(args, "symbol", "").Trim();
            string blockName = GetStr(args, "blockName", "");
            int limit = GetInt(args, "limit", 200);

            CrossReferenceFilter filter = CrossReferenceFilter.ObjectsWithReferences;
            if (filterStr == "all") filter = CrossReferenceFilter.AllObjects;
            else if (filterStr == "unused") filter = CrossReferenceFilter.UnusedObjects;
            else if (filterStr == "without_references" || filterStr == "unreferenced") filter = CrossReferenceFilter.ObjectsWithoutReferences;

            CrossReferenceService xsvc = null;
            if (!string.IsNullOrEmpty(blockName))
            {
                PlcBlockGroup owner;
                PlcBlock blk = FindBlock(plc.Software.BlockGroup, blockName, out owner);
                if (blk == null) throw new InvalidOperationException("Block '" + blockName + "' not found.");
                xsvc = blk.GetService<CrossReferenceService>();
            }
            else
            {
                xsvc = plc.Software.GetService<CrossReferenceService>();
            }
            if (xsvc == null) throw new InvalidOperationException("CrossReferenceService is not available on target.");

            CrossReferenceResult xres = xsvc.GetCrossReferences(filter);
            List<object> items = new List<object>();
            CollectCrossRefSources(xres.Sources, symbolFilter, limit, items);

            return new Dictionary<string, object>
            {
                { "plc", plc.CpuItem.Name },
                { "filter", filter.ToString() },
                { "symbolFilter", symbolFilter },
                { "count", items.Count },
                { "sources", items }
            };
        }

        private void CollectCrossRefSources(SourceObjectComposition sources, string symbolFilter, int limit, List<object> outList)
        {
            if (sources == null) return;
            foreach (SourceObject src in sources)
            {
                if (outList.Count >= limit) return;
                bool match = string.IsNullOrEmpty(symbolFilter)
                    || (!string.IsNullOrEmpty(src.Name) && src.Name.IndexOf(symbolFilter, StringComparison.OrdinalIgnoreCase) >= 0)
                    || (!string.IsNullOrEmpty(src.Address) && src.Address.IndexOf(symbolFilter, StringComparison.OrdinalIgnoreCase) >= 0);

                if (match && (src.References.Count > 0 || string.IsNullOrEmpty(symbolFilter)))
                {
                    List<object> refs = new List<object>();
                    foreach (ReferenceObject ro in src.References)
                    {
                        List<object> locs = new List<object>();
                        foreach (Location loc in ro.Locations)
                        {
                            locs.Add(new Dictionary<string, object>
                            {
                                { "location", loc.ReferenceLocation ?? "" },
                                { "access", loc.Access.ToString() },
                                { "address", loc.Address ?? "" }
                            });
                        }
                        refs.Add(new Dictionary<string, object>
                        {
                            { "referencedIn", ro.Name ?? "" },
                            { "type", ro.TypeName ?? "" },
                            { "path", ro.Path ?? "" },
                            { "locations", locs }
                        });
                    }
                    outList.Add(new Dictionary<string, object>
                    {
                        { "name", src.Name ?? "" },
                        { "address", src.Address ?? "" },
                        { "typeName", src.TypeName ?? "" },
                        { "path", src.Path ?? "" },
                        { "referenceCount", refs.Count },
                        { "references", refs }
                    });
                }

                if (src.Children != null && src.Children.Count > 0)
                {
                    CollectCrossRefSources(src.Children, symbolFilter, limit, outList);
                }
            }
        }
#endif

        // -------------------- Station Upload from Physical PLC --------------------
        private object CmdStationUpload(Dictionary<string, object> args)
        {
            EnsureProject();
            string modeName = GetStr(args, "mode", "PN/IE");
            string pcFilter = GetStr(args, "pcInterface", "");
            string targetAddr = GetStr(args, "targetAddress", "");
            if (string.IsNullOrEmpty(targetAddr)) throw new ArgumentException("targetAddress (e.g. '192.168.0.1') is required for station upload.");

            StationUploadProvider up = _project.GetService<StationUploadProvider>();
            if (up == null) throw new InvalidOperationException("StationUploadProvider service is not available on project.");

            ConfigurationMode mode = up.Configuration.Modes.Find(modeName);
            if (mode == null) throw new InvalidOperationException("Connection mode '" + modeName + "' not found.");

            ConfigurationPcInterface pc = string.IsNullOrEmpty(pcFilter)
                ? mode.PcInterfaces.FirstOrDefault()
                : mode.PcInterfaces.FirstOrDefault(p => p.Name.IndexOf(pcFilter, StringComparison.OrdinalIgnoreCase) >= 0);
            if (pc == null) throw new InvalidOperationException("PC interface matching '" + pcFilter + "' not found.");

            ConfigurationAddress addr = null;
#if TIA_V16
            if (pc.Subnets.Count > 0)
            {
                addr = pc.Subnets[0].Addresses.Find(targetAddr) ?? pc.Subnets[0].Addresses.Create(targetAddr);
            }
            else if (pc.Addresses != null)
            {
                addr = pc.Addresses.Find(targetAddr) ?? pc.Addresses.Create(targetAddr);
            }
            else
            {
                throw new InvalidOperationException("No subnet or address collection on PC interface '" + pc.Name + "'.");
            }
#else
            if (pc.TargetInterfaces.Count > 0)
            {
                addr = pc.TargetInterfaces[0].Addresses.Find(targetAddr) ?? pc.TargetInterfaces[0].Addresses.Create(targetAddr);
            }
            else if (pc.Subnets.Count > 0)
            {
                addr = pc.Subnets[0].Addresses.Find(targetAddr) ?? pc.Subnets[0].Addresses.Create(targetAddr);
            }
            else
            {
                throw new InvalidOperationException("No target interface or subnet on PC interface '" + pc.Name + "'.");
            }
#endif

            List<string> log = new List<string>();
            UploadResult res = up.StationUpload(addr, delegate(UploadConfiguration cfg)
            {
                log.Add(cfg.GetType().Name + ": " + cfg.Message);
            });

            return new Dictionary<string, object>
            {
                { "state", res.State.ToString() },
                { "errorCount", res.ErrorCount },
                { "warningCount", res.WarningCount },
                { "uploadedStation", res.UploadedStation != null ? res.UploadedStation.Name : null },
                { "configLog", log }
            };
        }
    }
}
