# TIA Portal V20 Ladder MCP Server

Bộ công cụ Model Context Protocol (MCP) dành cho **Siemens TIA Portal V20** (S7-1200 / S7-1500), được phát triển chuyên biệt và **hiện tại chỉ hỗ trợ ngôn ngữ Ladder Logic (LAD)**.

> [!IMPORTANT]
> **Phạm vi hỗ trợ hiện tại:** Máy chủ MCP này tập trung tối ưu sâu cho việc đọc hiểu, phân tích, sinh mã và mô phỏng chu kỳ quét đối với khối lệnh **Ladder (LAD)**. Các ngôn ngữ SCL, FBD hay Graph hiện chưa được hỗ trợ.

---

## 1. Tính năng cốt lõi

- **Ngôn ngữ DSL Ladder 2 chiều:** Chuyển đổi mã XML SimaticML cồng kềnh thành cú pháp DSL ngắn gọn, tiết kiệm hơn 90% ngữ cảnh token cho AI.
- **Mô phỏng chu kỳ quét PLC trong RAM (`tia_dry_run_ladder`):** Chạy thử nghiệm và kiểm chứng logic rơ-le, timer TON/TOF, counter CTU, cuộn dây tức thì mà không cần phần cứng hay phần mềm mô phỏng ngoài.
- **Phân tích tĩnh (`tia_analyze_ladder`):** Phát hiện lỗi Double Coil, thiếu xung cạnh, mâu thuẫn Set/Reset trước khi nạp vào PLC.
- **Tương tác TIA Portal V20 trực tiếp:** Kết nối qua Openness API để kiểm tra trạng thái, đọc danh sách tag phần cứng, chỉnh sửa khối dữ liệu DB, biên dịch và chuẩn bị mô phỏng với S7-PLCSIM V20.

---

## 2. Cấu trúc dự án

```text
TIA_Portal_V20_MCP/
├── bridge/            # Cầu nối C# (.NET Framework 4.8 x64) gọi Siemens.Engineering.dll
│   ├── TiaBridge.cs   # Mã nguồn C# giao tiếp Openness API
│   └── TiaBridge.exe  # File thực thi cầu nối (biên dịch qua build.ps1)
├── server/            # Máy chủ MCP chạy trên Node.js (giao thức stdio JSON-RPC)
│   ├── index.js       # Khởi tạo 22 MCP tools
│   └── ladder/        # Bộ biên dịch DSL Ladder, AST, Analyzer và Simulator
├── skill/             # File hướng dẫn tích hợp Skill cho AI Agent
│   └── SKILL.md
├── tests/             # Bộ kiểm thử tự động toàn diện
│   └── run_all.js
├── build.ps1          # Script biên dịch TiaBridge.exe bằng csc.exe có sẵn trên Windows
├── package.json
└── README.md
```

---

## 3. Danh sách 22 MCP Tools (Chuyên biệt cho Ladder)

1. **Quản lý phiên & Dự án:**
   - `tia_status`: Kiểm tra kết nối TIA Portal V20 và quyền Openness.
   - `tia_connect`: Gắn vào tiến trình TIA Portal đang mở hoặc khởi chạy mới.
   - `tia_open_project`: Mở file dự án `.ap20`.
   - `tia_save_project`: Lưu dự án.
   - `tia_close_project`: Đóng dự án.

2. **Dữ liệu & Cấu trúc:**
   - `tia_project_blueprint`: Đọc sơ đồ tổng thể PLC, Blocks, DB, TO, Tags.
   - `tia_list_blocks`: Liệt kê các khối OB, FB, FC, DB.
   - `tia_read_tags`: Đọc bảng PLC Tags.
   - `tia_upsert_tags`: Thêm hoặc cập nhật PLC Tags.
   - `tia_read_db_udt`: Đọc cấu trúc Global DB hoặc UDT.
   - `tia_edit_db_udt`: Chỉnh sửa biến trong DB/UDT.

3. **Thao tác khối Ladder (LAD):**
   - `tia_read_ladder`: Đọc khối LAD dưới dạng DSL ngắn gọn hoặc ASCII rungs.
   - `tia_patch_ladder_network`: Chỉnh sửa, thay thế hoặc thêm từng Network bậc thang.
   - `tia_create_ladder_block`: Tạo mới khối OB, FB, FC dạng LAD.
   - `tia_edit_block_interface`: Chỉnh sửa khai báo biến Input, Output, Temp, Static.
   - `tia_analyze_ladder`: Kiểm tra tĩnh (Double coil, Timer overlap, Cross-reference).
   - `tia_rollback_block`: Khôi phục khối từ bản lưu XML tự động.
   - `tia_export_raw`: Xuất SimaticML XML gốc khi cần tra cứu sâu.

4. **Biên dịch & Kiểm thử mô phỏng:**
   - `tia_dry_run_ladder`: Mô phỏng chu kỳ quét PLC trong RAM không cần bật TIA.
   - `tia_compile`: Biên dịch Software / Hardware (báo cáo lỗi chi tiết).
   - `tia_sim_prepare`: Khởi động S7-PLCSIM V20 và xuất bảng SIM Table CSV.
   - `tia_download_and_online`: Kết nối Online/Offline và nạp xuống CPU ảo.

---

## 4. Hướng dẫn cài đặt & Cấu hình

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
node .\tests\run_all.js
```

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
