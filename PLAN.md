# PLAN

- [x] Bước 1: Kiểm tra và biên dịch C# Bridge bằng build.ps1. Giữ lại và sửa lỗi cho 4 nhóm: Watch Table (tự tạo + ShowInEditor), SCL External Source, Cross-Reference, và Escape Hatch (GetAttributeInfos/GetAttribute/SetAttribute) + cấu hình phần cứng/IP cơ bản. Bỏ qua phần PLCSIM Runtime API nếu gây lỗi thiếu DLL hoặc bản quyền.
- [x] Bước 2: Kiểm tra và hoàn thiện Ladder DSL trong server/ladder/ (sửa lỗi Sub trong catalog.js, nhánh song song OR trong dsl.js, hỗ trợ NORM_X, SCALE_X, CONV, SIN, COS).
- [x] Bước 3: Nối toàn bộ tool mới vừa biên dịch vào server/index.js.
- [x] Bước 4: Chạy test trong server/ladder/ và kiểm tra server/index.js khởi động không lỗi.
- [x] Bước 5: Cập nhật ngắn gọn danh sách tool mới vào README.md.
