// ===========================================================================
// CANVAS CHÁNH ĐIỆN TỊNH TÂM (port từ chanh-dien-online-bear)
// Vẽ "chánh điện" thành 1 ảnh JPEG gửi qua Zalo:
//   nền hall.jpg + hào quang tượng Phật + phật tử đang an tọa + tên + bảng công đức.
//
// CHẤT LƯỢNG ẢNH (quan trọng):
//   - Vẽ ĐÚNG 1:1 ở 1080x1920, KHÔNG scale / KHÔNG supersample => ảnh nền giữ
//     nguyên từng pixel gốc, không bị resample làm mờ hay rỗ.
//   - imageSmoothingQuality = "high" cho sprite.
//   - Xuất JPEG 0.95, chỉ hạ dần khi file vượt ngưỡng Zalo (<480KB) để Zalo
//     không nén lại ảnh (nén lại = mờ).
// ===========================================================================
import fs from "node:fs";
import path from "node:path";

const SW = 1080; // hệ toạ độ gốc (giống index.html của bản web)
const SH = 1920;
const TEMP_DIR = path.resolve("./assets/temp");

const MAX_BYTES = 480 * 1024;
// LƯU Ý CỰC QUAN TRỌNG (đây là nguyên nhân ảnh bị mờ trước đó):
//   - @napi-rs/canvas CHỈ đọc chất lượng khi truyền SỐ NGUYÊN 0..100.
//       toBuffer("image/jpeg", 0.9)  -> bị hiểu là thang 0..100 => ~0 => nén nát, mờ nhoè
//       toBuffer("image/jpeg", {quality: 0.9}) -> BỎ QUA quality, luôn ~90 cố định
//       toBuffer("image/jpeg", 92)   -> đúng ý (dùng cái này)
//   - node-canvas thì ngược lại: nhận số thực 0..1.
// => encodeJpeg() bên dưới tự chọn đúng kiểu theo thư viện đang dùng.
const QUALITY_STEPS = [0.96, 0.93, 0.9, 0.86, 0.8];

// "Noto Serif" không có sẵn trên máy này và font thay thế thiếu glyph tiếng Việt
// (chữ "Hỷ", "Hương" bị thành ô vuông) => dùng Times New Roman / Cambria.
const FONT_SERIF = `"Times New Roman", "Cambria", "Georgia", serif`;
const FONT_SANS = `"Segoe UI", "Arial", "DejaVu Sans", sans-serif`;

let lib = null;
async function loadLib() {
  if (lib) return lib;
  for (const name of ["@napi-rs/canvas", "canvas"]) {
    try {
      const m = await import(name);
      const createCanvas = m.createCanvas ?? m.default?.createCanvas;
      const loadImage = m.loadImage ?? m.default?.loadImage;
      if (createCanvas && loadImage) {
        lib = { createCanvas, loadImage, isNapi: name === "@napi-rs/canvas" };
        return lib;
      }
    } catch {
      /* thử thư viện kế tiếp */
    }
  }
  throw new Error("Không tìm thấy thư viện canvas (@napi-rs/canvas hoặc canvas)");
}

/** Xuất JPEG với chất lượng 0..1, tự đổi sang đúng thang của thư viện canvas. */
function encodeJpeg(canvas, quality) {
  const { isNapi } = lib || {};
  const q = isNapi ? Math.round(quality * 100) : quality;
  return canvas.toBuffer("image/jpeg", q);
}

async function tryLoad(loadImage, file) {
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return await loadImage(file);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SƠ ĐỒ CHỖ NGỒI
// Số liệu hàng ghế được đo trực tiếp trên hall.jpg của repo này (5 hàng nệm
// thật, từ y≈1240 tới y≈1712), nên người ngồi đúng trên nệm chứ không lơ lửng.
// 6 hàng x 6 cột = 36 chỗ như bản gốc.
// ---------------------------------------------------------------------------
const ROWS = 6;
const COLS = 6;
const AISLE = 0.9;

// tâm từng hàng nệm (đo trên ảnh nền)
const ROW_Y = [1240, 1310, 1392, 1487, 1595, 1712];

export const TOTAL_SEATS = ROWS * COLS;

export function buildSeats() {
  const seats = [];
  for (let r = 0; r < ROWS; r++) {
    const t = ROWS > 1 ? r / (ROWS - 1) : 0; // 0 = hàng xa nhất, 1 = hàng gần nhất
    const y = ROW_Y[r];
    const half = 320 + 100 * t; // nửa chiều rộng sàn theo độ xa
    const scale = 0.26 + 0.24 * t; // sprite nhỏ ở xa, lớn ở gần
    for (let c = 0; c < COLS; c++) {
      let u = (c - (COLS - 1) / 2) / ((COLS - 1) / 2); // -1..1
      u += (Math.sign(u) * AISLE) / (COLS - 1); // mở lối đi giữa
      // kẹp trong khung để người ngồi sát mép không bị cắt mất nửa người
      const x = Math.max(62, Math.min(SW - 62, SW / 2 + u * half));
      seats.push({ x, y, scale, r, c, order: r * COLS + c });
    }
  }
  // Lấp từ hàng gần camera + gần lối đi trước => nhìn đầy đặn như bản live
  seats.sort((a, b) => b.r - a.r || Math.abs(a.x - SW / 2) - Math.abs(b.x - SW / 2));
  return seats;
}

// ---------------------------------------------------------------------------
// TIỆN ÍCH VẼ
// ---------------------------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clipText(ctx, text, maxWidth) {
  let s = String(text || "");
  if (ctx.measureText(s).width <= maxWidth) return s;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxWidth) s = s.slice(0, -1);
  return s + "…";
}

/**
 * Tạo ảnh chánh điện.
 * @param {object} info
 * @param {string} info.assetDir   thư mục chứa hall.jpg + c_*.png + fx_*.png
 * @param {Array}  info.members    [{ name, skin, seatIndex, isMe }]
 * @param {Array}  info.board      [{ name, coins }]  (top công đức)
 * @param {string} info.note       dòng chú thích dưới cùng
 * @returns {Promise<string|null>} đường dẫn file JPEG
 */
export async function createChanhDienImage(info = {}) {
  const { assetDir, members = [], board = [], note = "" } = info;
  const { createCanvas, loadImage } = await loadLib();

  // --- vẽ 1:1 ở 1080x1920 ---
  const canvas = createCanvas(SW, SH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // --- nền ---
  const hall = await tryLoad(loadImage, path.join(assetDir || "", "hall.jpg"));
  if (hall) ctx.drawImage(hall, 0, 0, SW, SH);
  else {
    ctx.fillStyle = "#140a06";
    ctx.fillRect(0, 0, SW, SH);
  }

  // --- hào quang tượng Phật ---
  const halo = await tryLoad(loadImage, path.join(assetDir || "", "fx_halo.png"));
  if (halo) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.22;
    const hw = halo.width * 2.6;
    const hh = halo.height * 2.6;
    ctx.drawImage(halo, SW / 2 - hw / 2, 520 - hh * 0.5, hw, hh);
    ctx.restore();
  }

  // --- phật tử đang an tọa (vẽ từ hàng xa đến gần) ---
  const seats = buildSeats();
  const spriteCache = new Map();
  const getSprite = async (skin) => {
    if (spriteCache.has(skin)) return spriteCache.get(skin);
    const img = await tryLoad(loadImage, path.join(assetDir || "", `c_${skin}.png`));
    spriteCache.set(skin, img);
    return img;
  };

  const placed = members
    .filter((m) => Number.isInteger(m.seatIndex) && m.seatIndex >= 0 && m.seatIndex < seats.length)
    .map((m) => ({ ...m, seat: seats[m.seatIndex] }))
    .sort((a, b) => a.seat.y - b.seat.y);

  for (const m of placed) {
    const seat = m.seat;
    const img = (await getSprite(m.skin || "man")) || (await getSprite("man"));
    const s = seat.scale * 1.05;
    let tagH;
    if (img) {
      const w = img.width * s;
      const h = img.height * s;
      ctx.drawImage(img, seat.x - w / 2, seat.y - h, w, h);
      tagH = h;
    } else {
      // không có sprite: vẽ bóng người tối giản để vẫn thấy chỗ có người
      const w = 100 * s;
      const h = 240 * s;
      ctx.fillStyle = "rgba(24,12,8,.8)";
      roundRect(ctx, seat.x - w / 2, seat.y - h, w, h, 12);
      ctx.fill();
      tagH = h;
    }

    // tên phật tử — cỡ chữ theo độ xa, giới hạn bề rộng để 6 người/hàng không đè nhau
    const fsTag = Math.max(15, Math.round(19 * seat.scale + 8));
    ctx.font = `600 ${fsTag}px ${FONT_SERIF}`;
    const label = clipText(ctx, m.name, 128);
    const tw = ctx.measureText(label).width + 18;
    const th = Math.round(fsTag * 1.5);
    const tagY = seat.y - tagH - 6;
    const tagX = Math.max(10, Math.min(SW - tw - 10, seat.x - tw / 2));
    ctx.fillStyle = m.isMe ? "rgba(138,42,30,.92)" : "rgba(16,9,6,.8)";
    roundRect(ctx, tagX, tagY - th / 2, tw, th, th / 2);
    ctx.fill();
    if (m.isMe) {
      ctx.strokeStyle = "rgba(226,176,79,.95)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = "#f6ead2";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, tagX + tw / 2, tagY + 1);
  }

  // --- header: số phật tử ---
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const chipText = `${members.length}/${TOTAL_SEATS} phật tử`;
  ctx.font = `600 28px ${FONT_SANS}`;
  const cw = ctx.measureText(chipText).width + 48;
  ctx.fillStyle = "rgba(24,13,8,.9)";
  roundRect(ctx, 34, 40, cw, 56, 28);
  ctx.fill();
  ctx.strokeStyle = "rgba(226,176,79,.55)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#e8b954";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(chipText, 34 + cw / 2, 69);

  // --- bảng công đức (top 3 trong điện) ---
  const top = board.filter((b) => b && b.coins > 0).slice(0, 3);
  if (top.length > 0) {
    const bw = 330;
    const bh = 60 + top.length * 44;
    const bx = SW - bw - 34;
    const by = 116;
    ctx.fillStyle = "rgba(24,13,8,.9)";
    roundRect(ctx, bx, by, bw, bh, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(226,176,79,.55)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `600 24px ${FONT_SERIF}`;
    ctx.fillStyle = "#e8b954";
    ctx.fillText("TẤM LÒNG THÀNH", bx + 20, by + 30);

    ctx.font = `500 23px ${FONT_SANS}`;
    top.forEach((b, i) => {
      const ly = by + 72 + i * 44;
      ctx.fillStyle = "#f6ead2";
      ctx.fillText(clipText(ctx, `${i + 1}. ${b.name}`, bw - 96), bx + 20, ly);
      ctx.textAlign = "right";
      ctx.fillStyle = "#c9ab84";
      ctx.fillText(String(b.coins), bx + bw - 20, ly);
      ctx.textAlign = "left";
    });
  }

  // --- dòng ghi chú dưới cùng ---
  if (note) {
    ctx.font = `600 26px ${FONT_SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const nw = Math.min(SW - 80, ctx.measureText(note).width + 70);
    ctx.fillStyle = "rgba(12,7,5,.84)";
    roundRect(ctx, SW / 2 - nw / 2, SH - 104, nw, 58, 29);
    ctx.fill();
    ctx.strokeStyle = "rgba(226,176,79,.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#f0dfbe";
    ctx.fillText(clipText(ctx, note, nw - 50), SW / 2, SH - 74);
  }

  // --- xuất JPEG: chất lượng cao nhất có thể mà vẫn dưới ngưỡng Zalo ---
  let buf = null;
  for (const q of QUALITY_STEPS) {
    buf = encodeJpeg(canvas, q);
    if (buf.length <= MAX_BYTES) break;
  }

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const file = path.join(TEMP_DIR, `chanh-dien-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
  fs.writeFileSync(file, buf);
  return file;
}
