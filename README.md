# TIA Portal V20 MCP Server (Ladder & SCL)

Bộ công cụ Model Context Protocol (MCP) dành cho **Siemens TIA Portal V20** (S7-1200 / S7-1500), hỗ trợ tạo dự án, cấu hình CPU/Module/Mạng PROFINET, lập trình **Ladder Logic (LAD)** và **SCL**, quản lý **Watch Table**, **Cross-Reference**, mô phỏng LAD offline và kết nối **S7-PLCSIM Advanced Runtime** khi có Runtime Manager phù hợp.

---

## 1. Tính năng cốt lõi

- **Ngôn ngữ DSL Ladder 2 chiều siêu tối ưu:** Chuyển đổi mã XML SimaticML cồng kềnh thành cú pháp DSL ngắn gọn, tiết kiệm hơn 90% ngữ cảnh token cho AI Agent. Hỗ trợ đầy đủ tiếp điểm, cuộn dây, nhánh song song cổng `O`, khối Timer/Counter, khối toán học (`SUB`, `DIV`, `MOD`), hàm lượng giác (`SIN`, `COS`, `TAN`...), ép kiểu & chuẩn hóa Analog (`CONV`, `NORM_X`, `SCALE_X`, `LIMIT`), truy cập phần tử mảng dynamic `Arr[#idx]` và tập lệnh Motion Control S7-1200/1500 (`MC_Power`, `MC_Reset`, `MC_Home`, `MC_MoveAbsolute`, `MC_MoveRelative`, `MC_MoveVelocity`, `MC_MoveJog`, `MC_Halt`).
- **Hỗ trợ mã nguồn văn bản SCL/DB/UDT:** Xuất và biên dịch trực tiếp mã SCL vào khối chương trình trong TIA Portal qua External Text Sources (`tia_scl_source`).
- **Quản lý Watch Table tự động:** Tự động tạo, đọc, cập nhật, xóa bảng giám sát Watch Table và mở trực tiếp lên màn hình TIA Portal (`tia_watch_table`, `tia_show_in_editor`).
- **Tra cứu chéo Cross-Reference:** Quét toàn dự án hoặc từng khối để xác định chính xác các điểm đọc/ghi của từng biến, DB hoặc UDT (`tia_cross_reference`).
- **Cấu hình phần cứng & Mạng tự động (Zero-to-Project):** Tạo mới project, tra cứu Hardware Catalog, thêm CPU/Module mở rộng theo preset mã đặt hàng, cấu hình System/Clock Memory, PUT/GET, IP, Subnet, PROFINET IO-System và OPC UA (`tia_hardware_config`, `tia_network_config`). Khi thêm CPU, MCP giữ nguyên cấu hình bảo vệ mặc định; `disableSecurity: true` chỉ dùng khi đã chủ động chọn cho project mô phỏng.
- **Mô phỏng 2 tầng độc lập:**
  1. *Tầng 1 (Trong RAM Node.js):* `tia_dry_run_ladder` mô phỏng chu kỳ quét PLC tức thì trong RAM không cần bật TIA Portal hay PLC thật.
  2. *Tầng 2 (S7-PLCSIM Advanced Runtime API):* `tia_plcsim_runtime` dùng `Siemens.Simatic.Simulation.Runtime.Api.x64.dll` khi Runtime Manager của PLCSIM Advanced khả dụng. Chỉ chạy `register`, `read`, `write` và `run_sequence` sau khi `status` trả `runtimeAvailable: true`. S7-PLCSIM V20 GUI thông thường có thể chạy CPU nhưng không tự tạo kết nối Advanced Runtime Manager; trong trường hợp đó hãy dùng SIM Table trong GUI.
- **Phân tích tĩnh (`tia_analyze_ladder`):** Phát hiện lỗi Double Coil, thiếu xung cạnh, mâu thuẫn Set/Reset, biến chưa khai báo trước khi nạp vào PLC.
- **Universal Escape Hatch (`tia_escape_hatch`):** Cung cấp khả năng phản chiếu động (Dynamic Reflection) trên toàn bộ cây đối tượng Openness V20 (`inspect`, `get`, `set`, `invoke`, handle `obj:N`), loại bỏ hoàn toàn "vùng mù" API.

---

## 2. Cấu trúc dự án

MCP xử lý `tools/call` theo FIFO để không chồng lệnh Openness. Cache tag/DB/chữ ký CALL nằm trong RAM theo project và PLC; `exports/learned_catalog.json` chỉ giữ metadata lệnh LAD dùng chung. Simulator reset biến `Temp` trước mỗi scan/CALL và đặt `#Initial_Call` của OB ở scan đầu tiên; analyzer cảnh báo `TEMP_READ_BEFORE_WRITE`.

```text
TIA_Portal_V20_MCP/
├── bridge/                        # Cầu nối C# (.NET Framework 4.8 x64) gọi TIA Openness V20
│   ├── TiaBridge.cs               # Lõi Openness, dự án, block, tags, biên dịch, download
│   ├── TiaBridge.WatchAndScl.cs   # Watch Table, ShowInEditor, SCL External Source, Cross-Reference
│   ├── TiaBridge.HardwareAndNet.cs# Phần cứng (Catalog, CPU, Module, TO) & Mạng (IP, PROFINET, OPC UA)
│   ├── TiaBridge.PlcsimAndEscape.cs# Điều khiển S7-PLCSIM Runtime & Escape Hatch phản chiếu động
│   └── TiaBridge.exe              # File thực thi cầu nối (biên dịch qua build.ps1)
├── server/                        # Máy chủ MCP chạy trên Node.js (giao thức stdio JSON-RPC)
│   ├── index.js                   # Khởi tạo 31 MCP tools
│   └── ladder/                    # Bộ biên dịch DSL Ladder V20, AST, Analyzer và Simulator
├── skill/                         # File hướng dẫn tích hợp Skill cho AI Agent
│   └── SKILL.md
├── tests/                         # Bộ kiểm thử tự động toàn diện (offline, TIA & cô lập đa PLC)
│   └── run_all.js
├── build.ps1                      # Script biên dịch TiaBridge.exe bằng csc.exe có sẵn trên Windows
├── package.json
└── README.md
```

---

## 3. Danh sách 31 MCP Tools

1. **Quản lý phiên & Dự án (5 tools):**
   - `tia_status`: Kiểm tra kết nối TIA Portal V20 và quyền Openness.
   - `tia_connect`: Gắn vào tiến trình TIA Portal đang mở hoặc khởi chạy mới.
   - `tia_open_project`: Mở file dự án `.ap20`.
   - `tia_save_project`: Lưu dự án.
   - `tia_close_project`: Đóng dự án; `disconnect`/`closeTia` vẫn hoạt động khi phiên chưa mở project.

2. **Dữ liệu & Cấu trúc (6 tools):**
   - `tia_project_blueprint`: Đọc sơ đồ tổng thể PLC, Blocks, DB, TO, Tags.
   - `tia_list_blocks`: Liệt kê các khối OB, FB, FC, DB.
   - `tia_read_tags`: Đọc bảng PLC Tags.
   - `tia_upsert_tags`: Thêm, cập nhật hoặc xóa PLC Tags bằng `delete: ["TagName"]`.
   - `tia_read_db_udt`: Đọc cấu trúc Global DB hoặc UDT.
   - `tia_edit_db_udt`: Tạo, sửa hoặc xóa Global DB, Instance DB hoặc UDT; xóa sao lưu XML trước.

3. **Thao tác khối Ladder (7 tools):**
   - `tia_read_ladder`: Đọc khối LAD dưới dạng DSL ngắn gọn hoặc ASCII rungs.
   - `tia_patch_ladder_network`: Chỉnh sửa, thay thế hoặc thêm từng Network bậc thang (hỗ trợ cổng `O` V20, `SUB`, `CONV`, `SIN`, `COS`, `NORM_X`, `SCALE_X`, `LIMIT`, Mảng, `MC_*`).
   - `tia_create_ladder_block`: Tạo mới OB, FB, FC dạng LAD; OB nhận `secondaryType: ProgramCycle | Startup | CyclicInterrupt` để sinh đúng thông tin hệ thống.
   - `tia_edit_block_interface`: Chỉnh sửa khai báo biến Input, Output, Temp, Static.
   - `tia_analyze_ladder`: Kiểm tra tĩnh (Double coil, Timer overlap, Cross-reference).
   - `tia_rollback_block`: Liệt kê/khôi phục backup hoặc xóa block/UDT sau khi tạo backup định danh.
   - `tia_export_raw`: Xuất SimaticML XML gốc khi cần tra cứu sâu.

4. **Biên dịch & Kiểm thử mô phỏng (5 tools):**
   - `tia_dry_run_ladder`: Mô phỏng chu kỳ quét PLC trong RAM không cần bật TIA.
   - `tia_test_ladder_project`: Nạp thư mục XML LAD, phân tích tĩnh và chạy nhiều ca kiểm thử độc lập từ một file JSON.
   - `tia_compile`: Biên dịch Software / Hardware (báo cáo lỗi chi tiết).
   - `tia_sim_prepare`: Khởi động S7-PLCSIM V20 và xuất bảng SIM Table CSV.
   - `tia_download_and_online`: Kết nối Online/Offline và nạp xuống CPU ảo/PLC thật.

5. **Watch Table, SCL, Cross-Reference & Giao diện TIA (4 tools mới):**
   - `tia_watch_table`: Tạo, đọc, cập nhật, xóa, xuất/nhập Watch Table (và liệt kê Force Table) trực tiếp trong TIA Portal, hỗ trợ mở thẳng lên màn hình bằng `ShowInEditor`.
   - `tia_show_in_editor`: Mở nhanh khối lệnh, Watch Table, Tag Table, UDT hoặc khung nhìn phần cứng/mạng ngay trên giao diện TIA Portal V20.
   - `tia_scl_source`: Xuất/nhập nguồn `.scl`/`.db`/`.udt`; khi nhập đè block xác định được tên, sao lưu source cũ và dọn file tạm.
   - `tia_cross_reference`: Tra cứu chéo (Cross-Reference) toàn dự án hoặc theo khối để biết chính xác biến/DB/UDT đang được đọc/ghi ở đâu.

6. **Phần cứng, Mạng công nghiệp, PLCSIM Runtime & Escape Hatch (4 tools mới):**
   - `tia_hardware_config`: Tra cứu Hardware Catalog, xem preset mã đặt hàng, thêm CPU PLC (giữ nguyên bảo vệ mặc định, trừ khi yêu cầu thay đổi rõ ràng), cắm module mở rộng vào slot, cấu hình System/Clock Memory Byte, PUT/GET và tạo Technological Object (`TO_PositioningAxis`, `PID_Compact`...).
   - `tia_network_config`: Kiểm tra cả thiết bị trong DeviceGroups; đặt IP/kết nối Subnet bằng `plcName` hoặc `deviceName`, từ chối tên interface mơ hồ, cấu hình PROFINET IO-System và OPC UA.
   - `tia_plcsim_runtime`: Điều khiển CPU ảo qua S7-PLCSIM Advanced Runtime Manager khi có kết nối API (đăng ký/gắn CPU ảo, Power/Run/Stop, đọc/ghi tín hiệu và chạy kịch bản test).
   - `tia_escape_hatch`: Công cụ phản chiếu động vạn năng trên `IEngineeringObject` — cho phép soi thuộc tính/composition/service/method (`inspect`), đọc/ghi thuộc tính động (`get`/`set`), gọi phương thức (`invoke`) và quản lý handle `obj:N`.

---

## 4. Hướng dẫn cài đặt & Cấu hình

### Chạy một project kiểm thử offline

Trên Windows, nhấp đúp `Run-Offline-Demo.cmd` để chạy ví dụ. Với Node.js, cũng có thể chạy từ thư mục gốc:

```powershell
node server/test-project.js examples/inspection/suite.json
```

Ví dụ dùng ba block XML tổng hợp. `FB_Inspection` gọi `FC_Eligible` để kiểm tra điều kiện và `FB_Delay` để theo dõi timer. Ba kịch bản kiểm tra tín hiệu giữ đủ lâu, xung ngắn và trường hợp chức năng bị tắt.

Để dùng cho project riêng, sao chép thư mục `examples/inspection`. Đặt XML của các OB/FB/FC LAD cần kiểm thử vào `blocks/`, kể cả các block được gọi qua `CALL`. Công cụ đọc cả thư mục con. Mỗi file XML chứa một block. Chọn `entry` trong `suite.json` và sửa danh sách `cases`. Mỗi case có tên riêng, có ít nhất một `expect` hoặc `until` và có thể chọn `entry` riêng. `blockDir` tính từ vị trí của `suite.json`.

Mỗi lần chạy chỉ đọc các XML một lượt. Mỗi case bắt đầu với vùng nhớ, bộ đếm và timer mới. Thiếu đích CALL, CALL đệ quy, network đọc không đầy đủ hoặc trùng tên block sẽ dừng bước nạp project và ghi lý do. Lỗi trong một case đã nạp vẫn cho phép chạy các case tiếp theo.

```powershell
node server/test-project.js examples/inspection/suite.json --format json
node server/test-project.js examples/inspection/suite.json --format junit
```

Kết quả JSON gồm phát hiện phân tích tĩnh, từng phép so sánh, timeline và giá trị cuối. JUnit gồm một testcase cho phân tích tĩnh và một testcase cho mỗi case. CLI xuất báo cáo ra stdout. Mã thoát `0` khi đạt, `1` khi có lỗi phân tích hoặc case không đạt và `2` khi không nạp được suite hoặc cú pháp CLI sai (chi tiết trên stderr). Với MCP, gọi `tia_test_ladder_project` bằng `{"manifestPath":"D:/demo/suite.json","format":"json"}` và đọc trường `ok` trong báo cáo.

Phạm vi kiểm tra là mô hình LAD trong RAM. Compile/import project Siemens và xác minh đặc tính CPU vẫn cần TIA Portal hoặc PLCSIM phù hợp.

### Bước 1: Thêm tài khoản vào nhóm Siemens TIA Openness (1 lần duy nhất)
Mở PowerShell bằng quyền Administrator và chạy:
```powershell
net localgroup "Siemens TIA Openness" $env:USERNAME /add
```
Sau đó đăng xuất (Sign out) và đăng nhập lại Windows.

### Bước 2: Biên dịch cầu nối C#
Trong thư mục gốc của dự án, chạy:
```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

### Bước 3: Chạy kiểm thử tự động
```powershell
npm run test:offline        # Chỉ cần Node.js, có thể bỏ qua bước biên dịch bridge
npm run test:tia            # Kiểm thử bridge trên máy Windows có TIA V20 và Openness
npm run test:tia-isolation  # Kiểm thử cô lập đa PLC và checksum backup trên TIA headless
npm test                    # Chạy bộ test offline + TIA smoke test
```

Khi sửa XML offline bằng `tia_patch_ladder_network`, truyền `xmlPath`, `ops` và `previewOnly: true` để xem DSL trước/sau, các khai báo mới và cảnh báo. Để áp dụng cùng thay đổi và nhận báo cáo rút gọn, dùng `compact: true` và bỏ `previewOnly`.

Để hoàn tác, gọi `tia_rollback_block` với `action: "list"` và cùng `xmlPath`. Sau đó gọi `action: "restore"` với `xmlPath` và tên `backupFile` đã chọn. Các bản sao mới gắn với đường dẫn file gốc. Bản sao từ phiên bản cũ vẫn có thể liệt kê bằng `blockName`.

### Bước 4: Cấu hình MCP Client (Ví dụ: Claude Desktop hoặc Antigravity)
Thêm vào file cấu hình `mcp_config.json`:
```json
{
  "mcpServers": {
    "tia-portal-v20": {
      "command": "node",
      "args": [
        "D:\\TIA_Portal_V20_MCP\\server\\index.js"
      ],
      "cwd": "D:\\TIA_Portal_V20_MCP",
      "env": {
        "TIA_PUBLIC_API_DIR": "C:\\Program Files\\Siemens\\Automation\\Portal V20\\PublicAPI\\V20"
      }
    }
  }
}
```

---

## Giấy phép
Phát hành theo giấy phép MIT. Bản quyền (c) 2026 huykhue-maker.
Tất cả các nhãn hiệu TIA Portal, S7-1200, S7-1500 thuộc bản quyền của Siemens AG.
