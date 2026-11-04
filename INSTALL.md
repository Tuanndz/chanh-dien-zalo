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
  rooms: {},
  merits: {},
  activeThreads: {},
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
  "name": "chanhdien",
  "alias": ["cdien", "dientuong"],
  "description": "Chánh Điện Tịnh Tâm — cả nhóm cùng ngồi thiền trong một chánh điện 36 chỗ, gõ \"tham gia\" để an tọa, dâng lễ để tích công đức",
  "syntax": "{p}chanhdien [on|off|top|status|help]",
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
#chanhdien on          → QTV mở điện (nhóm phải bật gameactive trước)
tham gia               → an tọa
2                      → dâng hương +5
tụng kinh              → niệm Phật
công đức               → top 3 trong điện
ra                     → nhường chỗ
#chanhdien off         → QTV đóng điện
```

## Kiểm tra tài nguyên

```
#chanhdien check
```

Báo thiếu file nào trong `assets/chanh-dien/`.

## Tuỳ chỉnh nhanh

| Muốn đổi | Sửa ở |
|---|---|
| Số chỗ | `ROWS`, `COLS` trong `canvas-chanh-dien.js` (mặc định 6×6 = 36) |
| Vị trí hàng ghế | `ROW_Y` trong `canvas-chanh-dien.js` (đo lại theo `hall.jpg`) |
| Giá trị mâm lễ | `GIFTS[].coins` trong `chanh-dien.js` |
| Thời gian nhường chỗ | `MEMBER_IDLE_MS` (mặc định 45 phút) |
| Thời gian tự đóng điện | `ROOM_IDLE_MS` (mặc định 60 phút) |
| Nhịp gộp vẽ ảnh | `RENDER_DEBOUNCE_MS` (mặc định 1200ms) |
| Thư mục asset | biến môi trường `CHANH_DIEN_ASSET_DIR` |
