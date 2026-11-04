# Gắn vào bot zlbotnta — 4 bước

Copy 2 thư mục vào đúng chỗ:

```
src/service-dqt/game-service/chanh-dien/chanh-dien.js
src/utils/canvas/canvas-chanh-dien.js
assets/chanh-dien/            (hall.jpg + c_*.png + fx_*.png)
```

Sau đó sửa 4 file dưới đây.

---

## 1. `src/service-dqt/game-service/game-manager.js`

**a. Thêm import** (cạnh import game khác):

```js
import { initializeChanhDien } from "./chanh-dien/chanh-dien.js";
```

**b. Thêm nhánh dữ liệu** trong object `gameState.data`:

```js
chanhDien: {
  enabled: true,
  hall: { members: [], note: "" },
  pr: { on: false, intervalMs: 10800000 },
  merits: {},
  imageIndex: {},
},
```

**c. Thêm cờ thay đổi** trong `gameState.changes`:

```js
chanhDien: false,
```

**d. Thêm vào lúc khởi tạo**, trong `Promise.all([...])` của `initializeGameDataManager`:

```js
initializeChanhDien(api),
```

---

## 2. `src/commands/command.js`

**a. Import:**

```js
import { handleChanhDienCommand } from "../service-dqt/game-service/chanh-dien/chanh-dien.js";
```

**b. Nhánh lệnh nhóm** (switch của `handleCommand`):

```js
case "chanhdien":
case "cdien":
case "dientuong":
  await handleChanhDienCommand(api, message, groupSettings);
  return 0;
```

**c. Nhánh lệnh riêng** (switch của `handleCommandPrivate`):

```js
case "chanhdien":
case "cdien":
case "dientuong":
  await handleChanhDienCommand(api, message, groupSettings);
  break;
```

---

## 3. `src/automations/event-send-msg.js`

**a. Import:**

```js
import { handleChanhDienQuickReply } from "../service-dqt/game-service/chanh-dien/chanh-dien.js";
```

**b. Nhánh tin nhắn riêng** — đặt ngay sau `handleCowQuickReply`:

```js
try {
  if (await handleChanhDienQuickReply(api, message)) return;
} catch (errCd) {
  console.error("[chanh-dien:private] Lỗi handleChanhDienQuickReply:", errCd?.message || errCd);
}
```

**c. Nhánh tin nhắn nhóm** — cũng đặt ngay sau `handleCowQuickReply`, bên trong `if (hasQuickText && shouldProcessCommands)`:

```js
try {
  if (await handleChanhDienQuickReply(api, message)) return;
} catch (errCd) {
  console.error("[chanh-dien] Lỗi handleChanhDienQuickReply:", errCd?.message || errCd);
}
```

> Phải đặt **trước** cổng cooldown / menu navigation, nếu không người chơi gõ nhanh sẽ bị nuốt lượt.

---

## 4. `assets/data/command.json`

Thêm vào mảng `commands`:

```json
{
  "name": "chua",
  "alias": ["chanhdien", "cdien", "dientuong"],
  "description": "Chánh Điện Tịnh Tâm — một chánh điện chung 50 chỗ cho toàn server. Gõ là vào ngay, hoặc gõ \"tham gia\", hoặc thả tim vào ảnh điện. QTV: on/off toàn server, pr on/off/time để gửi ảnh định kỳ cho mọi nhóm, top để xem bảng công đức kèm avatar",
  "syntax": "{p}chua [on|off|pr on|pr off|pr time 30s|top|status|help]",
  "permission": "all",
  "countdown": 2,
  "icon": "🏮",
  "type": 5,
  "author": "NTA",
  "active": true
}
```

---

## Cách chơi

```
#chua                 vào điện ngay (không cần on/off trước)
tham gia              vào điện (không prefix)
❤️ vào ảnh điện        vào điện

2                     dâng hương +5
tụng kinh             niệm Phật
công đức              top 3 trong điện
ra                    nhường chỗ

#chua on              bật toàn server (mọi bot)
#chua pr on           gửi ảnh điện cho toàn bộ nhóm, lặp định kỳ
#chua pr time 15p     đổi chu kỳ
#chua top             ảnh bảng công đức kèm avatar
```

## Kiểm tra tài nguyên

```
#chua check
```

Báo thiếu file nào trong `assets/chanh-dien/`.

## Tuỳ chỉnh nhanh

| Muốn đổi | Sửa ở |
|---|---|
| Số chỗ | `ROWS`, `COLS` trong `canvas-chanh-dien.js` (mặc định 5×10 = 50) |
| Vị trí hàng ghế | `ROW_Y` trong `canvas-chanh-dien.js` (đo lại theo `hall.jpg`) |
| Giá trị mâm lễ | `GIFTS[].coins` trong `chanh-dien.js` |
| Chu kỳ gửi mặc định | `PR_DEFAULT_INTERVAL_MS` (3 giờ) |
| Giới hạn tần suất đồng bộ | `PR_MIN_GAP_MS` (1 phút), `PR_SYNC_DEBOUNCE_MS` (20 giây) |
| Thời gian nhường chỗ | `MEMBER_IDLE_MS` (45 phút) |
| Bật/tắt mặc định | `DEFAULT_ENABLED` (true) |
| Nhịp gộp vẽ ảnh | `RENDER_DEBOUNCE_MS` (1200ms) |
| Thư mục asset | biến môi trường `CHANH_DIEN_ASSET_DIR` |

## Lưu ý khi triển khai

- `#chua on|off|pr` yêu cầu **quản trị bot** (`isAdmin(botId, uid)`), không phải chỉ QTV nhóm.
- Broadcast gửi cho **mọi nhóm của mọi bot** đang chạy trong tiến trình (`apiManager`). Bot con chạy tiến trình riêng thì mỗi tiến trình tự có cờ `enabled` riêng.
- Ảnh gửi lên Zalo được giữ ở mức < 480 KB để Zalo không nén lại (nén lại = mờ).

