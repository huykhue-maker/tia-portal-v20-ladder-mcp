---
name: tia-ladder-engineer
description: >-
  Closed-loop engineering workflow for Siemens TIA Portal V20 PLC development,
  reading half-finished projects, surgical Ladder (LAD) editing, static verification,
  in-RAM scan-cycle dry-run simulation, compilation, and S7-PLCSIM V20 download.
  Use whenever the user works with TIA Portal V20, S7-1200/S7-1500, Ladder Logic (LAD),
  or PLCSIM V20 via the `tia-portal-v20` MCP server.
---

# TIA Portal V20 Ladder Engineer Workflow

(Bản sao lưu cục bộ của skill đã đăng ký tại `C:\Users\Aaus\.gemini\config\skills\tia-ladder-engineer\SKILL.md`.)

## Quy trình chuẩn
1. `tia_status` -> `tia_open_project` -> `tia_project_blueprint`
2. `tia_read_ladder(blockName, format="both")`
3. `tia_patch_ladder_network` / `tia_create_ladder_block` / `tia_edit_block_interface`
4. `tia_analyze_ladder` (quét Double Coil, Timer/Edge reuse, Cross-Reference)
5. `tia_dry_run_ladder` (mô phỏng chu kỳ quét PLC tức thì trong RAM với kịch bản test)
6. `tia_compile(enableSimulation=true)` -> sửa nếu có lỗi
7. `tia_sim_prepare` -> `tia_download_and_online(action="download")` -> `tia_save_project`

Với bộ hồi quy nhiều block XML offline, gọi `tia_test_ladder_project` với `manifestPath` trỏ đến suite JSON. Dùng `format: "json"` để kiểm tra `ok`, từng assertion và timeline. Ví dụ hoàn chỉnh ở `examples/inspection/suite.json`.
