---
name: tia-ladder-engineer
description: >-
  Closed-loop engineering workflow for Siemens TIA Portal V20 PLC development,
  reading half-finished projects, surgical Ladder (LAD) editing, static verification,
  in-RAM scan-cycle dry-run simulation, compilation, and carefully targeted S7-PLCSIM V20 download.
  Use whenever the user works with TIA Portal V20, S7-1200/S7-1500, Ladder Logic (LAD),
  or PLCSIM V20 via the `tia-portal-v20` MCP server.
---

# TIA Portal V20 Ladder Engineer Workflow

(Bản sao lưu cục bộ của skill đã đăng ký tại `C:\Users\Aaus\.gemini\config\skills\tia-ladder-engineer\SKILL.md`.)

## Quy trình chuẩn
1. `tia_status` -> `tia_open_project` -> `tia_project_blueprint`
2. `tia_read_ladder(blockName, format="both")`
3. `tia_patch_ladder_network` / `tia_create_ladder_block` / `tia_edit_block_interface`
   - Với OB mới, chọn `secondaryType: "ProgramCycle" | "Startup" | "CyclicInterrupt"` cùng số OB tương ứng. OB100 có `LostRetentive`/`LostRTC`; OB30 có `Initial_Call`/`Event_Count`.
4. `tia_analyze_ladder` (quét Double Coil, Timer/Edge reuse, Cross-Reference; truyền `targetSymbol`/`targetBlock` và `manifestPath` để xem Impact Analysis trước khi sửa)
5. `tia_dry_run_ladder` (mô phỏng chu kỳ quét PLC tức thì trong RAM với kịch bản test)
6. `tia_compile(enableSimulation=true)` -> sửa nếu có lỗi
7. `tia_sim_prepare` -> `tia_download_and_online(action="list_connections", plcName="...")` -> chọn tên `pcInterface` chính xác -> `tia_download_and_online(action="download", plcName="...", pcInterface="...")` -> `tia_save_project`

Khi thêm CPU **chỉ trong project thử nghiệm** bằng `tia_hardware_config(action="add_plc")`, bảo vệ được giữ nguyên theo mặc định. Nếu hardware compile báo thiếu cấu hình bảo vệ và đã được phép dùng cấu hình mô phỏng, truyền `disableSecurity: true` lúc `add_plc` hoặc `cpu_properties`, sau đó compile lại. Không áp dụng cờ này cho project sản xuất.

Trước khi download, chạy `list_connections` để lấy tên `pcInterface` chính xác. `download` bắt buộc có `plcName` và `pcInterface`; PLC vật lý còn cần `targetAddress`. Mặc định chỉ nạp Software, không khởi động CPU, không dừng module đang chạy và không chấp nhận cấu hình đích khác. Chỉ bật `includeHardware`, `startAfterDownload`, `allowStopModules`, `allowDifferentTargetConfiguration` khi đúng mục đích và kiểm tra `configLog` trong kết quả.

Đọc `CurrentSelection` và `availableSelections` trong `configLog` để chẩn đoán cấu hình nạp. Xem `addresses` và `hardwareIdentifiers` từ blueprint hoặc `add_plc`/`plug_module` trước khi chọn địa chỉ tag.

S7-PLCSIM V20 GUI dùng SIM Table CSV từ `tia_sim_prepare` để theo dõi/đổi tín hiệu. `tia_plcsim_runtime` dùng API của S7-PLCSIM Advanced và chỉ điều khiển được khi `status.runtimeAvailable` là `true`.

Các lệnh MCP được xử lý tuần tự. Cache tags, DB và chữ ký CALL được tách theo project/PLC; chỉ metadata LAD chung được lưu trong `exports/learned_catalog.json`. Có thể gọi `tia_close_project(disconnect=true, closeTia=true)` cả khi phiên TIA chưa mở project.

`tia_upsert_tags(delete=["TagName"], plcName="...")` xóa tag trong table được chọn. `tia_edit_db_udt(action="delete", name="...", kind="db"|"udt")` hoặc `tia_rollback_block(action="delete", blockName="...")` tạo backup XML có định danh trước khi xóa; luôn chọn `plcName` trong project nhiều PLC. `tia_scl_source(action="import")` tự sao lưu source cũ khi xác định được block trùng tên. `tia_network_config` nhận `deviceName` chính xác khi sửa thiết bị ngoài PLC.

Với bộ hồi quy nhiều block XML offline, gọi `tia_test_ladder_project` với `manifestPath` trỏ đến suite JSON. Truyền `targetSymbol` hoặc `targetBlock` để nhận các network bị ảnh hưởng và `suggestedCases`. Dùng `format: "json"` để kiểm tra `ok`, từng assertion và timeline. Ví dụ hoàn chỉnh ở `examples/inspection/suite.json`.

## Interface và DSL

- Khi tạo FC có kết quả, khai báo `interface.Return: [{"name":"Ret_Val","type":"Int"}]` và nối `CALL("FC_X", Ret_Val=#Out)`. Trong XREF, `Input` là đọc, `Output` và `Return` là ghi, `InOut` là đọc/ghi.
- Truyền `startValue` và `retain: true` cho member DB/UDT hoặc interface cần khởi tạo và lưu giữ. `Constant` phải có `startValue` để dry-run khởi tạo giá trị. Dry-run cũng nạp giá trị ban đầu của `Static` khi tạo frame và cho phép `scenario.init` đặt giá trị ở frame gốc.
- Dùng `NO(#Set) => SR(#Bit, R1=NO(#Reset))` khi Reset ưu tiên và `NO(#Reset) => RS(#Bit, S1=NO(#Set))` khi Set ưu tiên. Nối `Q=#State` hoặc nối tiếp `=>` để sử dụng trạng thái chốt.
- Dùng `IN_RANGE(min, val, max[, Type])` và `OUT_RANGE(min, val, max[, Type])` làm điều kiện. `SEL(G, IN0, IN1, OUT[, Type])` chọn `IN1` khi `G` đúng và `IN0` khi `G` sai.
- Dùng `PCONTACT(op, mem)` và `NCONTACT(op, mem)` để bắt cạnh của `op`. Khai báo một bit nhớ riêng cho mỗi tiếp điểm. Với `ADD`, `MUL`, `MIN` và `MAX`, đặt các đầu vào trước biến đích, ví dụ `ADD(#A, #B, #C, #Out, Int)`.
- Hỗ trợ Slice Access (`.%X0`..`.%X63`, `.%B0`..`.%B7`, `.%W0`..`.%W3`, `.%D0`..`.%D1`) và các phép toán Bitwise/Shift: `W_AND`/`W_OR`/`W_XOR` (alias `AND_WORD`/`OR_WORD`/`XOR_WORD`), `SHL(in, n, out[, Type])`, `SHR(in, n, out[, Type])`.
- Hỗ trợ khai báo `Struct` lồng nhau bằng thuộc tính `members: [...]` trên DB/UDT/interface, và tự suy luận kiểu xuyên UDT nhiều cấp sau khi `tia_project_blueprint` hoặc `tia_read_db_udt` nạp `udtsCache`.
- Trong `tia_project_blueprint`, có thể truyền `group` và `maxLearnBlocks` để tối ưu tốc độ trên dự án lớn. Trong `tia_network_config`, dùng `action="connect_io_system"` với `ioSystemName`, `deviceName` và tùy chọn `pnDeviceName` để gắn PROFINET IO Device vào IO System.
- Với Escape Hatch, làm mới handle khi một handle cũ đã bị loại khỏi giới hạn 500. Truyền đường dẫn chuỗi cho tham số `FileInfo` hoặc `DirectoryInfo`. Dùng `target: "device:<Name>"` để chỉ đích danh thiết bị không có PLC trong project nhiều PLC.
