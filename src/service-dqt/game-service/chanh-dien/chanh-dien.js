// ===========================================================================
// CHÁNH ĐIỆN TỊNH TÂM — game cộng đồng cho bot Zalo
// Port từ https://github.com/khanhdevngu/chanh-dien-online-bear (MIT)
//
// Ý tưởng: cả nhóm cùng ngồi trong MỘT chánh điện (36 chỗ). Ai gõ "tham gia"
// thì được xếp vào nệm trống gần nhất, các thao tác sau đó gõ trực tiếp không
// cần prefix: tụng kinh, dâng lễ, xem công đức, đổi áo, ra về...
//
//   QTV nhóm:  {p}chanhdien on | off | check | reset
//   Mọi người: {p}chanhdien help | top | status
//   Trong điện (gõ thẳng, không cần prefix):
//     tham gia            -> an tọa vào nệm trống
//     ra                  -> rời điện, nhường chỗ
//     tung kinh           -> niệm Phật (cập nhật dòng sự kiện)
//     1 / canh sen        -> dâng cánh sen   (+1 công đức)
//     2 / dang huong      -> dâng hương      (+5 công đức)
//     3 / hoa sen         -> dâng hoa sen    (+20 công đức)
//     4 / thinh chuong    -> thỉnh chuông    (+99 công đức)
//     cong duc / ds / help
//     doi ao nam|nu|ba|ni|su|tre
//
// Ảnh chánh điện được vẽ lại theo nhịp gộp (debounce) để 20 người dâng lễ
// cùng lúc cũng chỉ tốn 1 ảnh, không spam nhóm.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { MessageType } from "../../../api-zalo/index.js";
import { getApiManager, isAdmin } from "../../../index.js";
import {
  sendMessageQuery,
  sendMessageWarning,
  sendMessageComplete,
  sendMessageFailed,
  sendMessageInsufficientAuthority,
  sendMessageImageNotQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import { createChanhDienImage, TOTAL_SEATS } from "../../../utils/canvas/canvas-chanh-dien.js";
import { clearImagePath } from "../../../utils/canvas/index.js";
import { getGlobalPrefix } from "../../service.js";
import { checkBeforeJoinGame } from "../index.js";
import { gameState } from "../game-manager.js";

// ===========================================================================
// CẤU HÌNH
// ===========================================================================
const ASSET_DIR = process.env.CHANH_DIEN_ASSET_DIR || path.resolve("./assets/chanh-dien");

const TTL_INFO = 180_000; // tin thông tin
const TTL_NOTICE = 30_000; // tin nhắc nhẹ
const TTL_IMAGE = 0; // ảnh chánh điện: không tự xoá (là "màn hình" của điện)

const RECALL_DELAY_MS = 45_000; // thu hồi ảnh điện cũ sau 45s để nhóm kịp xem
const RENDER_DEBOUNCE_MS = 1_200; // gộp nhiều thao tác trong 1.2s -> vẽ 1 ảnh
const MEMBER_IDLE_MS = 45 * 60_000; // 45 phút không tương tác -> tự nhường chỗ
const ROOM_IDLE_MS = 60 * 60_000; // 60 phút điện vắng -> đóng
const SWEEP_INTERVAL_MS = 10 * 60_000; // quét dọn định kỳ

const SKINS = ["man", "woman", "granny", "nun", "monk", "child"];

const SUTRA = [
  "Nam mô A Di Đà Phật",
  "Nam mô Bổn Sư Thích Ca Mâu Ni Phật",
  "Nam mô Đại Bi Quán Thế Âm Bồ Tát",
  "Nguyện cầu bình an cho gia đình",
  "Cầu cho cha mẹ được khỏe mạnh",
  "Nguyện đem công đức này hướng về khắp tất cả",
];

// 4 mâm lễ giống bản web gốc
const GIFTS = [
  { key: "canhsen", label: "Cánh sen", emoji: "🌸", coins: 1, words: ["1", "canh sen", "canhsen", "sen", "canh"] },
  { key: "danghuong", label: "Dâng hương", emoji: "🕯️", coins: 5, words: ["2", "dang huong", "danghuong", "huong", "nhang", "xong huong"] },
  { key: "hoasen", label: "Hoa sen", emoji: "🪷", coins: 20, words: ["3", "hoa sen", "hoasen", "hoa"] },
  { key: "thinhchuong", label: "Thỉnh chuông", emoji: "🔔", coins: 99, words: ["4", "thinh chuong", "thinhchuong", "chuong", "dong chuong"] },
];

const ROBES = {
  nam: "man",
  "ao nam": "man",
  nu: "woman",
  "ao nu": "woman",
  ba: "granny",
  "ao ba": "granny",
  "ao nau": "granny",
  ni: "nun",
  "su co": "nun",
  su: "monk",
  thay: "monk",
  "su thay": "monk",
  tre: "child",
  "tre em": "child",
  em: "child",
};

// ===========================================================================
// TIỆN ÍCH CHUỖI
// ===========================================================================
/** Bỏ dấu tiếng Việt + lowercase + gộp khoảng trắng. */
function norm(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function skinForUid(uid) {
  let h = 7;
  for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SKINS[h % SKINS.length];
}

function log(msg) {
  console.log(chalk.cyan(`[chanh-dien] ${msg}`));
}
function logErr(msg, err) {
  console.error(chalk.red(`[chanh-dien] ${msg}`), err || "");
}

// ===========================================================================
// KHO DỮ LIỆU
// ===========================================================================
function store() {
  if (!gameState?.data) return { rooms: {}, merits: {}, activeThreads: {} };
  const d = gameState.data;
  if (!d.chanhDien || typeof d.chanhDien !== "object") {
    d.chanhDien = { rooms: {}, merits: {}, activeThreads: {} };
  }
  const s = d.chanhDien;
  if (!s.rooms) s.rooms = {};
  if (!s.merits) s.merits = {};
  if (!s.activeThreads) s.activeThreads = {};
  return s;
}

function markDirty() {
  if (gameState?.changes) gameState.changes.chanhDien = true;
}

function activeList(botId) {
  const s = store();
  if (!s.activeThreads[botId]) s.activeThreads[botId] = [];
  return s.activeThreads[botId];
}

function meritKey(botId, uid) {
  return `${botId}:${uid}`;
}

function meritOf(botId, uid, name) {
  const s = store();
  const k = meritKey(botId, uid);
  if (!s.merits[k]) {
    s.merits[k] = { uid: String(uid), name: name || String(uid), coins: 0, gifts: 0, chants: 0, visits: 0, lastAt: 0 };
  }
  if (name) s.merits[k].name = name;
  return s.merits[k];
}

// ===========================================================================
// PHÒNG (MỖI NHÓM LÀ MỘT CHÁNH ĐIỆN)
// ===========================================================================
const apis = {}; // botId -> api
const renderTimers = new Map(); // threadId -> timeout
const recalling = new Set(); // threadId -> đang chờ thu hồi ảnh cũ

function apiOf(botId) {
  return apis[botId] || (botId ? getApiManager(botId)?.apiZalo : null) || Object.values(apis)[0] || null;
}

function msgTypeOf(room) {
  return room?.type === MessageType.DirectMessage ? MessageType.DirectMessage : MessageType.GroupMessage;
}

function newRoom(threadId, botId, type) {
  return {
    threadId: String(threadId),
    botId,
    type: type || MessageType.GroupMessage,
    members: [],
    note: "",
    lastSent: null,
    openedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function getRoom(threadId) {
  const s = store();
  return s.rooms[String(threadId)] || null;
}

function ensureRoom(threadId, botId, type) {
  const s = store();
  const key = String(threadId);
  if (!s.rooms[key]) s.rooms[key] = newRoom(key, botId, type);
  s.rooms[key].updatedAt = Date.now();
  return s.rooms[key];
}

function dropRoom(threadId) {
  const s = store();
  const key = String(threadId);
  const room = s.rooms[key];
  if (!room) return null;
  delete s.rooms[key];
  clearRenderTimer(key);
  markDirty();
  return room;
}

function findMember(room, uid) {
  return room?.members?.find((m) => String(m.uid) === String(uid)) || null;
}

function freeSeat(room) {
  const used = new Set(room.members.map((m) => m.seat));
  for (let i = 0; i < TOTAL_SEATS; i++) if (!used.has(i)) return i;
  return -1;
}

/** Người ngồi lâu không tương tác thì tự nhường chỗ cho người mới. */
function pruneMembers(room) {
  if (!room?.members?.length) return 0;
  const now = Date.now();
  const before = room.members.length;
  room.members = room.members.filter((m) => now - (m.lastAt || 0) < MEMBER_IDLE_MS);
  const removed = before - room.members.length;
  if (removed > 0) markDirty();
  return removed;
}

// ===========================================================================
// GỬI TIN
// ===========================================================================
async function reply(api, message, text, kind = "query", ttl = TTL_INFO) {
  try {
    if (kind === "complete") return await sendMessageComplete(api, message, text, ttl);
    if (kind === "warning") return await sendMessageWarning(api, message, text, ttl);
    if (kind === "failed") return await sendMessageFailed(api, message, text, ttl);
    if (kind === "authority") return await sendMessageInsufficientAuthority(api, message, text, ttl);
    return await sendMessageQuery(api, message, text, ttl);
  } catch (e) {
    logErr("Không gửi được tin:", e?.message || e);
    return null;
  }
}

/** Thu hồi ảnh điện cũ (theo chuẩn Section 12 README.md). */
async function recallOldImage(api, room) {
  const prev = room?.lastSent;
  if (!prev || !api) return;
  room.lastSent = null;
  const threadId = room.threadId;
  const msgType = msgTypeOf(room);

  const sentMsgId = prev?.message?.msgId || prev?.attachment?.[0]?.msgId || prev?.data?.msgId || prev?.msgId;
  if (!sentMsgId) return;
  const cliMsgId = prev?.message?.cliMsgId || prev?.attachment?.[0]?.cliMsgId || sentMsgId;

  try {
    await api
      .undoMessage({
        threadId,
        type: msgType,
        data: { quote: { globalMsgId: String(sentMsgId), cliMsgId: String(cliMsgId) } },
      })
      .catch(() => {});
    await api
      .deleteMessage({ type: msgType, threadId, data: { cliMsgId, msgId: sentMsgId, uidFrom: room.botId } }, false)
      .catch(() => {});
  } catch {
    /* thu hồi lỗi không được làm hỏng luồng chơi */
  }
}

function scheduleRecall(api, room) {
  const threadId = room?.threadId;
  if (!threadId || recalling.has(threadId)) return;
  recalling.add(threadId);
  const t = setTimeout(async () => {
    recalling.delete(threadId);
    try {
      await recallOldImage(api, room);
    } catch {
      /* bỏ qua */
    }
  }, RECALL_DELAY_MS);
  t.unref?.();
}

async function clearTemp(imagePath) {
  if (!imagePath) return;
  try {
    await clearImagePath(imagePath);
  } catch {
    /* bỏ qua */
  }
}

// ===========================================================================
// VẼ + GỬI ẢNH ĐIỆN
// ===========================================================================
function boardOf(room) {
  return [...room.members]
    .filter((m) => m.coins > 0)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3)
    .map((m) => ({ name: m.name, coins: m.coins }));
}

function noteOf(room) {
  const head = room.note || "Gõ “tham gia” để an tọa";
  return `${head} · ${room.members.length}/${TOTAL_SEATS} chỗ`;
}

function payloadOf(room) {
  return {
    assetDir: ASSET_DIR,
    members: room.members.map((m) => ({ name: m.name, skin: m.skin, seatIndex: m.seat })),
    board: boardOf(room),
    note: noteOf(room),
  };
}

/**
 * Vẽ lại chánh điện và gửi vào nhóm.
 * @param {object} room
 * @param {string} caption tin nhắn kèm ảnh
 */
async function drawHall(room, caption) {
  const api = apiOf(room.botId);
  if (!api) return false;

  let imagePath = null;
  try {
    imagePath = await createChanhDienImage(payloadOf(room));
  } catch (e) {
    logErr("Vẽ chánh điện lỗi:", e?.message || e);
  }

  if (!imagePath) {
    // Không vẽ được thì vẫn báo trạng thái bằng chữ, không để im lặng
    try {
      await api.sendMessage({ msg: caption || "Chánh điện đang mở.", ttl: TTL_IMAGE }, room.threadId, msgTypeOf(room));
    } catch {
      /* bỏ qua */
    }
    return false;
  }

  try {
    // Thu hồi ảnh cũ trước khi thay ảnh mới
    if (room.lastSent) scheduleRecall(api, room);
    const res = await sendMessageImageNotQuote(
      api,
      { success: true, message: caption || "", type: msgTypeOf(room) },
      room.threadId,
      imagePath,
      TTL_IMAGE,
      false,
      msgTypeOf(room)
    );
    room.lastSent = res;
    return true;
  } catch (e) {
    logErr("Gửi ảnh chánh điện lỗi:", e?.message || e);
    return false;
  } finally {
    await clearTemp(imagePath);
  }
}

function clearRenderTimer(threadId) {
  const t = renderTimers.get(String(threadId));
  if (t) {
    clearTimeout(t);
    renderTimers.delete(String(threadId));
  }
}

/**
 * Gộp các thao tác liên tiếp trong RENDER_DEBOUNCE_MS thành 1 lần vẽ.
 * 20 người dâng lễ cùng lúc => chỉ 1 ảnh, và caption lấy sự kiện cuối.
 */
function scheduleDraw(room, caption) {
  const key = String(room.threadId);
  room.pendingCaption = caption || room.pendingCaption || "";
  if (renderTimers.has(key)) return;

  const t = setTimeout(async () => {
    renderTimers.delete(key);
    const live = getRoom(key);
    if (!live) return;
    const cap = live.pendingCaption || "";
    live.pendingCaption = "";
    try {
      await drawHall(live, cap);
    } catch (e) {
      logErr("scheduleDraw lỗi:", e?.message || e);
    }
  }, RENDER_DEBOUNCE_MS);
  t.unref?.();
  renderTimers.set(key, t);
}

// ===========================================================================
// HÀNH ĐỘNG TRONG ĐIỆN
// ===========================================================================
function joined(room, api, uid, name) {
  const existing = findMember(room, uid);
  if (existing) return { ok: false, reason: "already", member: existing };

  pruneMembers(room);
  const seat = freeSeat(room);
  if (seat < 0) return { ok: false, reason: "full" };

  const member = {
    uid: String(uid),
    name: String(name || uid).slice(0, 24),
    skin: skinForUid(uid),
    seat,
    coins: 0,
    gifts: 0,
    chants: 0,
    joinedAt: Date.now(),
    lastAt: Date.now(),
  };
  room.members.push(member);

  const merit = meritOf(room.botId, uid, member.name);
  merit.visits = (merit.visits || 0) + 1;
  merit.lastAt = Date.now();

  room.note = `${member.name} vừa an tọa`;
  room.updatedAt = Date.now();
  markDirty();
  return { ok: true, member };
}

function left(room, uid) {
  const idx = room.members.findIndex((m) => String(m.uid) === String(uid));
  if (idx === -1) return null;
  const [m] = room.members.splice(idx, 1);
  room.note = `${m.name} đã rời điện`;
  room.updatedAt = Date.now();
  markDirty();
  return m;
}

/** Đọc hành động từ câu người dùng gõ (đã bỏ dấu). */
function parseAction(raw, member) {
  const text = norm(raw);
  if (!text) return null;

  if (["tham gia", "vao", "ngoi", "an toa", "join", "xin vao", "vao dien", "cho toi mot cho", "toi tham gia"].includes(text)) {
    return { type: "join" };
  }
  if (["ra", "roi", "thoat", "ve", "leave", "roi dien", "xuat", "di ve"].includes(text)) {
    return { type: "leave" };
  }
  if (["tung kinh", "niem phat", "nam mo", "le phat", "cau an", "cau nguyen", "tung"].includes(text)) {
    return { type: "chant" };
  }
  if (["cong duc", "bang cong duc", "top", "bxh", "bang xep hang"].includes(text)) {
    return { type: "board" };
  }
  if (["danh sach", "ds", "ai dang ngoi", "thanh vien", "xem ai"].includes(text)) {
    return { type: "list" };
  }
  if (["help", "huong dan", "hd", "giup", "cach choi"].includes(text)) {
    return { type: "help" };
  }

  // đổi áo: "doi ao su" / "ao ni" / "doi ao"
  const robeMatch = text.match(/^(?:doi ao|ao|doi)\s*(.*)$/);
  if (robeMatch) {
    const robe = robeMatch[1].trim();
    if (!robe) return { type: "robe", robe: null };
    if (ROBES[robe]) return { type: "robe", robe: ROBES[robe] };
    return { type: "robe", robe: null, invalid: true };
  }

  // dâng lễ: theo số 1-4 hoặc tên mâm lễ
  for (const gift of GIFTS) {
    if (gift.words.includes(text)) return { type: "gift", gift };
  }

  // "dang huong cau cho me khoa" -> lấy mâm lễ + lời nguyện
  for (const gift of GIFTS) {
    for (const w of gift.words) {
      if (w.length > 2 && text.startsWith(w + " ")) {
        return { type: "gift", gift, wish: raw.trim().slice(w.length).trim() };
      }
    }
  }

  return null;
}

// ===========================================================================
// XỬ LÝ HÀNH ĐỘNG
// ===========================================================================
async function doJoin(api, message, room) {
  const uid = String(message.data?.uidFrom || "");
  const name = message.data?.dName || String(uid);
  const res = joined(room, api, uid, name);

  if (!res.ok && res.reason === "already") {
    await reply(api, message, `Bạn đã an tọa ở chỗ ${res.member.seat + 1}/${TOTAL_SEATS} rồi.\nGõ “tụng kinh” hoặc “2” để dâng hương nhé!`, "query", TTL_NOTICE);
    return true;
  }
  if (!res.ok && res.reason === "full") {
    await reply(
      api,
      message,
      `Chánh điện đã đủ ${TOTAL_SEATS} chỗ.\nChờ ai đó gõ “ra” để nhường chỗ, hoặc thử lại sau ít phút (người ngồi lâu không tương tác sẽ tự nhường).`,
      "warning",
      TTL_NOTICE
    );
    return true;
  }

  scheduleDraw(room, `🙏 ${res.member.name} đã an tọa · chỗ ${room.members.length}/${TOTAL_SEATS}`);
  return true;
}

async function doLeave(api, message, room) {
  const uid = String(message.data?.uidFrom || "");
  const m = left(room, uid);
  if (!m) {
    await reply(api, message, "Bạn đang không ở trong điện.", "warning", TTL_NOTICE);
    return true;
  }
  if (room.members.length === 0) {
    await reply(api, message, `🏮 ${m.name} đã rời điện. Điện giờ vắng, gõ “tham gia” để mở lại.`, "complete", TTL_NOTICE);
  } else {
    scheduleDraw(room, `🚪 ${m.name} đã rời điện · còn ${room.members.length}/${TOTAL_SEATS}`);
  }
  return true;
}

async function doChant(api, message, room, member) {
  const line = SUTRA[Math.floor(Math.random() * SUTRA.length)];
  member.chants = (member.chants || 0) + 1;
  member.lastAt = Date.now();
  const merit = meritOf(room.botId, member.uid, member.name);
  merit.chants = (merit.chants || 0) + 1;
  merit.lastAt = Date.now();
  room.note = `${member.name} đang tụng kinh`;
  markDirty();

  await reply(api, message, `📿 ${member.name}: “${line}”`, "complete", TTL_NOTICE);
  return true;
}

async function doGift(api, message, room, member, gift, wish) {
  member.coins += gift.coins;
  member.gifts = (member.gifts || 0) + 1;
  member.lastAt = Date.now();

  const merit = meritOf(room.botId, member.uid, member.name);
  merit.coins = (merit.coins || 0) + gift.coins;
  merit.gifts = (merit.gifts || 0) + 1;
  merit.lastAt = Date.now();

  room.note = `${member.name} dâng ${gift.label.toLowerCase()} +${gift.coins}`;
  room.updatedAt = Date.now();
  markDirty();

  const wishText = wish ? `\nLời nguyện: “${wish.slice(0, 120)}”` : "";
  const big = gift.coins >= 99 ? "\n🔔 Chuông ngân, cả điện cùng hoan hỷ!" : "";
  scheduleDraw(
    room,
    `${gift.emoji} ${member.name} dâng ${gift.label} +${gift.coins} công đức · tổng ${member.coins}${wishText}${big}`
  );
  return true;
}

async function doBoard(api, message, room) {
  const top = boardOf(room);
  if (top.length === 0) {
    await reply(api, message, "Chưa ai dâng lễ trong điện này.\nGõ “1” hoặc “canh sen” để bắt đầu.", "query", TTL_INFO);
    return true;
  }
  const medal = ["🥇", "🥈", "🥉"];
  const lines = top.map((t, i) => `${medal[i]} ${t.name} — ${t.coins} công đức`);
  await reply(api, message, `🏆 TẤM LÒNG THÀNH (trong điện)\n${lines.join("\n")}`, "complete", TTL_INFO);
  return true;
}

async function doList(api, message, room) {
  if (room.members.length === 0) {
    await reply(api, message, "Điện đang vắng.\nGõ “tham gia” để an tọa.", "query", TTL_INFO);
    return true;
  }
  const lines = room.members
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((m, i) => `${i + 1}. ${m.name} — chỗ ${m.seat + 1} · ${m.coins} công đức`);
  await reply(
    api,
    message,
    `🧘 ĐANG AN TỌA (${room.members.length}/${TOTAL_SEATS})\n${lines.slice(0, 20).join("\n")}${
      lines.length > 20 ? `\n… và ${lines.length - 20} người nữa` : ""
    }`,
    "query",
    TTL_INFO
  );
  return true;
}

async function doRobe(api, message, room, member, robe, invalid) {
  if (invalid || !robe) {
    await reply(
      api,
      message,
      "Chọn áo bằng lệnh:\n• đổi áo nam\n• đổi áo nữ\n• đổi áo bà\n• đổi áo ni\n• đổi áo sư\n• đổi áo trẻ",
      "warning",
      TTL_INFO
    );
    return true;
  }
  member.skin = robe;
  member.lastAt = Date.now();
  room.note = `${member.name} đã đổi áo`;
  markDirty();
  scheduleDraw(room, `👘 ${member.name} đã đổi áo · ${room.members.length}/${TOTAL_SEATS} chỗ`);
  return true;
}

function helpText(prefix) {
  return (
    `🏮 CHÁNH ĐIỆN TỊNH TÂM\n` +
    `Cả nhóm cùng ngồi trong một chánh điện ${TOTAL_SEATS} chỗ.\n\n` +
    `TRONG ĐIỆN — gõ thẳng, không cần ${prefix}:\n` +
    `• tham gia — an tọa vào nệm trống\n` +
    `• ra — rời điện, nhường chỗ\n` +
    `• tụng kinh — niệm Phật\n` +
    `• 1 cánh sen (+1) · 2 dâng hương (+5) · 3 hoa sen (+20) · 4 thỉnh chuông (+99)\n` +
    `• công đức — bảng tấm lòng thành trong điện\n` +
    `• ds — ai đang ngồi\n` +
    `• đổi áo nam|nữ|bà|ni|sư|trẻ\n\n` +
    `LỆNH NHÓM:\n` +
    `• ${prefix}chanhdien on — mở điện (QTV)\n` +
    `• ${prefix}chanhdien off — đóng điện (QTV)\n` +
    `• ${prefix}chanhdien top — bảng công đức toàn bot\n` +
    `• ${prefix}chanhdien status — tình trạng điện\n` +
    `• ${prefix}chanhdien help`
  );
}

// ===========================================================================
// LỆNH "chanhdien ..."
// ===========================================================================
async function toggleHall(api, message, threadId, botId, open, groupSettings) {
  const prefix = getGlobalPrefix(botId);
  const list = activeList(botId);

  if (open) {
    if (groupSettings && message.type !== MessageType.DirectMessage) {
      const activeGame = groupSettings?.[threadId]?.activeGame;
      if (activeGame === false || activeGame === undefined) {
        await reply(
          api,
          message,
          `Nhóm chưa bật tương tác game.\nVui lòng dùng ${prefix}gameactive trước rồi mở lại điện.`,
          "warning",
          TTL_INFO
        );
        return;
      }
    }
    if (!list.includes(String(threadId))) {
      list.push(String(threadId));
      markDirty();
    }
    const room = ensureRoom(threadId, botId, message.type);
    await reply(
      api,
      message,
      `🏮 CHÁNH ĐIỆN đã mở.\n\nMọi người gõ “tham gia” để an tọa.\nSau đó gõ thẳng: tụng kinh · 1/2/3/4 để dâng lễ · công đức · ra.`,
      "complete",
      TTL_INFO
    );
    await drawHall(room, `🏮 Chánh điện đã mở · ${room.members.length}/${TOTAL_SEATS} chỗ`);
    return;
  }

  const idx = list.indexOf(String(threadId));
  if (idx !== -1) {
    list.splice(idx, 1);
    markDirty();
  }
  const room = dropRoom(threadId);
  if (room?.lastSent) {
    const apiLocal = apiOf(botId);
    recallOldImage(apiLocal, room).catch(() => {});
  }
  await reply(api, message, "🚪 CHÁNH ĐIỆN đã đóng trong nhóm này.", "complete", TTL_INFO);
}

async function showTop(api, message, botId) {
  const s = store();
  const all = Object.values(s.merits).filter((m) => m.coins > 0);
  if (all.length === 0) {
    await reply(api, message, "Chưa ai dâng lễ lần nào.", "query", TTL_INFO);
    return;
  }
  all.sort((a, b) => b.coins - a.coins || b.gifts - a.gifts);
  const lines = all.slice(0, 10).map((m, i) => `${i + 1}. ${m.name} — ${m.coins} công đức · ${m.gifts} lễ`);
  await reply(api, message, `🏆 BẢNG CÔNG ĐỨC TOÀN BOT\n${lines.join("\n")}`, "complete", TTL_INFO);
}

async function showStatus(api, message, room) {
  if (!room) {
    await reply(api, message, "Nhóm chưa mở chánh điện.\nQTV dùng lệnh “chanhdien on” để mở.", "warning", TTL_INFO);
    return;
  }
  const top = boardOf(room);
  const topText = top.length ? top.map((t, i) => `${i + 1}. ${t.name} — ${t.coins}`).join("\n") : "chưa có ai dâng lễ";
  await reply(
    api,
    message,
    `🏮 CHÁNH ĐIỆN\nĐang an tọa: ${room.members.length}/${TOTAL_SEATS}\nTấm lòng thành:\n${topText}\nMở lúc: ${new Date(room.openedAt).toLocaleString("vi-VN")}`,
    "query",
    TTL_INFO
  );
}

async function checkAssets(api, message) {
  const need = ["hall.jpg", ...SKINS.map((s) => `c_${s}.png`)];
  const missing = need.filter((f) => !fs.existsSync(path.join(ASSET_DIR, f)));
  if (missing.length === 0) {
    await reply(api, message, `✅ Đủ tài nguyên chánh điện trong:\n${ASSET_DIR}`, "complete", TTL_INFO);
  } else {
    await reply(api, message, `⚠️ Thiếu ${missing.length} file trong ${ASSET_DIR}:\n${missing.join(", ")}`, "warning", TTL_INFO);
  }
}

/**
 * Xử lý lệnh "chanhdien ..." (có prefix).
 */
export async function handleChanhDienCommand(api, message, groupSettings) {
  if (!(await checkBeforeJoinGame(api, message, groupSettings, false))) return;

  const botId = api.getBotId();
  const threadId = String(message.threadId);
  const senderId = String(message.data?.uidFrom || "");
  apis[botId] = api;

  if (message.type === MessageType.DirectMessage) {
    await reply(api, message, "🏮 Chánh điện chỉ mở trong nhóm chat.", "warning", TTL_NOTICE);
    return;
  }

  const prefix = getGlobalPrefix(botId);
  const content = String(message.data?.content || "").trim();
  const parts = content.split(/\s+/).filter(Boolean);
  const sub = norm(parts[1] || "");
  const admin = isAdmin(botId, senderId, threadId);

  // QTV: mở / đóng điện
  if (["on", "open", "mo", "bat", "off", "close", "dong", "tat"].includes(sub)) {
    if (!admin) {
      await reply(api, message, "Chỉ Quản trị viên nhóm mới mở/đóng được chánh điện.", "authority", TTL_INFO);
      return;
    }
    await toggleHall(api, message, threadId, botId, ["on", "open", "mo", "bat"].includes(sub), groupSettings);
    return;
  }

  if (["check", "assets", "tainguyen"].includes(sub)) {
    if (!admin) {
      await reply(api, message, "Chỉ Quản trị viên nhóm mới dùng được lệnh này.", "authority", TTL_INFO);
      return;
    }
    await checkAssets(api, message);
    return;
  }

  if (["reset", "clear", "xoa"].includes(sub)) {
    if (!admin) {
      await reply(api, message, "Chỉ Quản trị viên nhóm mới dùng được lệnh này.", "authority", TTL_INFO);
      return;
    }
    const room = dropRoom(threadId);
    if (room?.lastSent) await recallOldImage(api, room).catch(() => {});
    await reply(api, message, "🧹 Đã dọn chánh điện của nhóm này.", "complete", TTL_INFO);
    return;
  }

  const room = getRoom(threadId);

  if (["top", "rank", "bxh", "xephang"].includes(sub)) {
    await showTop(api, message, botId);
    return;
  }
  if (["status", "info", "tt"].includes(sub)) {
    await showStatus(api, message, room);
    return;
  }
  if (["help", "huongdan", "hd", ""].includes(sub)) {
    await reply(api, message, helpText(prefix), "query", TTL_INFO);
    return;
  }

  if (!room) {
    await reply(
      api,
      message,
      admin
        ? `Nhóm chưa mở chánh điện.\nDùng ${prefix}chanhdien on để mở.`
        : `Nhóm chưa mở chánh điện.\nNhờ Quản trị viên nhóm dùng ${prefix}chanhdien on để mở.`,
      "warning",
      TTL_INFO
    );
    return;
  }

  // Các sub còn lại chuyển thành hành động trong điện
  const argText = parts.slice(1).join(" ");
  if (["join", "vao", "thamgia"].includes(sub)) {
    await doJoin(api, message, room);
    return;
  }
  const member = findMember(room, senderId);
  if (!member) {
    await reply(api, message, "Bạn chưa an tọa trong điện.\nGõ “tham gia” để tìm chỗ ngồi.", "warning", TTL_NOTICE);
    return;
  }
  const action = parseAction(argText, member);
  if (!action) {
    await reply(api, message, `Không hiểu “${argText}”.\nGõ “help” để xem cách chơi.`, "warning", TTL_NOTICE);
    return;
  }
  await dispatchAction(api, message, room, member, action);
}

/** Thực thi một hành động đã parse. */
async function dispatchAction(api, message, room, member, action) {
  switch (action.type) {
    case "join":
      return doJoin(api, message, room);
    case "leave":
      return doLeave(api, message, room);
    case "chant":
      return doChant(api, message, room, member);
    case "gift":
      return doGift(api, message, room, member, action.gift, action.wish);
    case "board":
      return doBoard(api, message, room);
    case "list":
      return doList(api, message, room);
    case "robe":
      return doRobe(api, message, room, member, action.robe, action.invalid);
    case "help":
      return reply(api, message, helpText(getGlobalPrefix(room.botId)), "query", TTL_INFO);
    default:
      return false;
  }
}

/**
 * Trả lời nhanh bằng tin nhắn trần (không cần prefix), giống lối chơi game khác.
 * Chỉ nhận khi nhóm đã mở điện. Người CHƯA an tọa chỉ dùng được tham gia/help/ds/công đức
 * để tránh nuốt nhầm tin nhắn thường ngày của nhóm.
 */
export async function handleChanhDienQuickReply(api, message) {
  if (message.type !== MessageType.GroupMessage) return false;

  let content = "";
  if (typeof message.data?.content === "string") content = message.data.content.trim();
  else if (message.data?.content && typeof message.data.content === "object") {
    content = String(message.data.content.title || message.data.content.caption || "").trim();
  }
  if (!content || content.length > 40) return false;

  const botId = api.getBotId();
  const threadId = String(message.threadId);

  // Nhóm chưa mở điện thì im lặng, không chiếm tin nhắn
  if (!activeList(botId).includes(threadId)) return false;
  const room = getRoom(threadId);
  if (!room) return false;

  const uid = String(message.data?.uidFrom || "");
  const member = findMember(room, uid);
  const action = parseAction(content, member);
  if (!action) return false;

  // Chưa an tọa: chỉ cho tham gia + xem thông tin
  if (!member && !["join", "help", "list", "board"].includes(action.type)) {
    await reply(api, message, "Bạn chưa an tọa trong điện.\nGõ “tham gia” để tìm chỗ ngồi.", "warning", TTL_NOTICE);
    return true;
  }

  apis[botId] = api;
  log(`${message.data?.dName || uid} -> ${action.type}${action.gift ? ":" + action.gift.key : ""}`);
  await dispatchAction(api, message, room, member, action);
  return true;
}

// ===========================================================================
// DỌN DẸP ĐỊNH KỲ
// ===========================================================================
let sweepJob = null;

function sweep() {
  const s = store();
  const now = Date.now();
  let changed = false;

  for (const [threadId, room] of Object.entries(s.rooms)) {
    if (!room) {
      delete s.rooms[threadId];
      changed = true;
      continue;
    }
    const before = room.members.length;
    room.members = room.members.filter((m) => now - (m.lastAt || 0) < MEMBER_IDLE_MS);
    if (room.members.length !== before) {
      room.note = "Một số người đã rời điện do lâu không tương tác";
      changed = true;
    }
    if (room.members.length === 0 && now - (room.updatedAt || 0) > ROOM_IDLE_MS) {
      delete s.rooms[threadId];
      clearRenderTimer(threadId);
      changed = true;
    }
  }

  if (changed) markDirty();
}

// ===========================================================================
// KHỞI TẠO
// ===========================================================================
export async function initializeChanhDien(api) {
  if (api?.getBotId) apis[api.getBotId()] = api;

  const s = store();
  for (const [threadId, room] of Object.entries(s.rooms)) {
    if (!room || !Array.isArray(room.members)) {
      delete s.rooms[threadId];
      continue;
    }
    room.lastSent = null; // tin nhắn cũ không còn thu hồi được sau khi khởi động lại
    room.pendingCaption = "";
  }
  markDirty();

  if (!fs.existsSync(path.join(ASSET_DIR, "hall.jpg"))) {
    logErr(`Thiếu ${path.join(ASSET_DIR, "hall.jpg")} — ảnh chánh điện sẽ không vẽ được.`);
  }

  if (sweepJob) clearInterval(sweepJob);
  sweepJob = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepJob.unref?.();

  const rooms = Object.keys(s.rooms).length;
  console.log(chalk.magentaBright(`Chánh Điện Tịnh Tâm started — ${rooms} điện đang mở, ${TOTAL_SEATS} chỗ mỗi điện`));
}
