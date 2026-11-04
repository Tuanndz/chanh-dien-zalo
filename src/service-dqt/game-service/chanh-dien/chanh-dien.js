// ===========================================================================
// CHÁNH ĐIỆN TỊNH TÂM — game cộng đồng cho bot Zalo
// Port từ https://github.com/khanhdevngu/chanh-dien-online-bear (MIT)
//
// MÔ HÌNH: MỘT chánh điện chung cho toàn server (50 chỗ). Mọi nhóm của mọi bot
// đều nhìn thấy cùng một điện; ai vào bằng cách nào cũng hiện lên cùng một chỗ.
//
//   {p}chua                  -> vào điện ngay (không cần on/off trước)
//   gõ thẳng "tham gia"      -> vào điện
//   thả ❤️ vào ảnh điện       -> vào điện (giống masoi thả tim vào sảnh)
//
//   {p}chua on|off           -> BẬT/TẮT toàn server (mọi bot: bot con + bot phụ)
//   {p}chua pr on|off        -> bật/tắt gửi ảnh điện định kỳ cho TOÀN BỘ nhóm
//   {p}chua pr time 30s|15p|1h  -> đổi chu kỳ gửi (mặc định 3 giờ)
//   {p}chua top              -> ảnh bảng công đức kèm avatar
//   {p}chua status | help
//   {p}chua check | reset    -> (QTV bot)
//
// Trong điện gõ thẳng: ra · tụng kinh · 1/2/3/4 · công đức · ds · đổi áo ...
// ===========================================================================
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { MessageType } from "../../../api-zalo/index.js";
import { getApiManager, isAdmin, apiManager } from "../../../index.js";
import {
  sendMessageQuery,
  sendMessageWarning,
  sendMessageComplete,
  sendMessageFailed,
  sendMessageInsufficientAuthority,
  sendMessageImageNotQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import { createChanhDienImage, createChanhDienTopImage, TOTAL_SEATS } from "../../../utils/canvas/canvas-chanh-dien.js";
import { clearImagePath } from "../../../utils/canvas/index.js";
import { getGlobalPrefix } from "../../service.js";
import { checkBeforeJoinGame } from "../index.js";
import { gameState } from "../game-manager.js";

// ===========================================================================
// CẤU HÌNH
// ===========================================================================
const ASSET_DIR = process.env.CHANH_DIEN_ASSET_DIR || path.resolve("./assets/chanh-dien");
const THUMB_DIR = path.resolve("./assets/user-thumb");

const TTL_INFO = 180_000;
const TTL_NOTICE = 30_000;
const TTL_IMAGE = 0;

const RECALL_DELAY_MS = 45_000;
const RENDER_DEBOUNCE_MS = 1_200;

// Broadcast (chua pr)
const PR_DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 giờ
const PR_MIN_INTERVAL_MS = 10_000; // sàn 10 giây
const PR_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PR_SYNC_DEBOUNCE_MS = 20_000; // gộp các lượt vào điện rồi đồng bộ 1 lần
const PR_MIN_GAP_MS = 60_000; // không gửi lại toàn bộ nhóm dày hơn 1 phút
const GROUP_CACHE_MS = 10 * 60_000;

const MEMBER_IDLE_MS = 45 * 60_000;
const HALL_IDLE_MS = 6 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;

// Mặc định BẬT để gõ #chua là vào được ngay; QTV gõ "#chua off" để tắt toàn server.
const DEFAULT_ENABLED = true;

const SKINS = ["man", "woman", "granny", "nun", "monk", "child"];

const SUTRA = [
  "Nam mô A Di Đà Phật",
  "Nam mô Bổn Sư Thích Ca Mâu Ni Phật",
  "Nam mô Đại Bi Quán Thế Âm Bồ Tát",
  "Nguyện cầu bình an cho gia đình",
  "Cầu cho cha mẹ được khỏe mạnh",
  "Nguyện đem công đức này hướng về khắp tất cả",
];

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
// TIỆN ÍCH
// ===========================================================================
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(chalk.cyan(`[chanh-dien] ${msg}`));
const logErr = (msg, err) => console.error(chalk.red(`[chanh-dien] ${msg}`), err || "");

/** "30s" / "15p" / "1h" / "2 gio" -> ms */
function parseDuration(text) {
  const m = norm(text).match(/^(\d+)\s*(s|giay|p|phut|m|min|h|gio|tieng)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2] || "p";
  if (!Number.isFinite(n) || n <= 0) return null;
  if (["s", "giay"].includes(u)) return n * 1000;
  if (["p", "phut", "m", "min"].includes(u)) return n * 60_000;
  if (["h", "gio", "tieng"].includes(u)) return n * 3_600_000;
  return null;
}

function humanDuration(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} giờ`;
  if (ms % 60_000 === 0) return `${ms / 60_000} phút`;
  return `${Math.round(ms / 1000)} giây`;
}

// ===========================================================================
// KHO DỮ LIỆU (một điện chung)
// ===========================================================================
function store() {
  if (!gameState?.data) {
    return { enabled: DEFAULT_ENABLED, hall: { members: [], note: "" }, pr: { on: false, intervalMs: PR_DEFAULT_INTERVAL_MS }, merits: {}, imageIndex: {} };
  }
  const d = gameState.data;
  if (!d.chanhDien || typeof d.chanhDien !== "object") {
    d.chanhDien = { enabled: DEFAULT_ENABLED, hall: { members: [], note: "" }, pr: { on: false, intervalMs: PR_DEFAULT_INTERVAL_MS }, merits: {}, imageIndex: {} };
  }
  const s = d.chanhDien;
  if (typeof s.enabled !== "boolean") s.enabled = DEFAULT_ENABLED;
  if (!s.hall || !Array.isArray(s.hall.members)) s.hall = { members: [], note: "" };
  if (!s.pr) s.pr = { on: false, intervalMs: PR_DEFAULT_INTERVAL_MS };
  if (!s.pr.intervalMs) s.pr.intervalMs = PR_DEFAULT_INTERVAL_MS;
  if (!s.merits) s.merits = {};
  if (!s.imageIndex) s.imageIndex = {};
  return s;
}

function markDirty() {
  if (gameState?.changes) gameState.changes.chanhDien = true;
}

function meritOf(uid, name) {
  const s = store();
  const k = String(uid);
  if (!s.merits[k]) {
    s.merits[k] = { uid: k, name: name || k, coins: 0, gifts: 0, chants: 0, visits: 0, lastAt: 0 };
  }
  if (name) s.merits[k].name = name;
  return s.merits[k];
}

// ===========================================================================
// GỬI TIN
// ===========================================================================
const apis = {}; // botId -> api (dự phòng khi apiManager chưa có)
const threadLast = new Map(); // threadId -> res (để thu hồi ảnh cũ)

function apiOf(botId) {
  return apis[botId] || (botId ? getApiManager(botId)?.apiZalo : null) || Object.values(apis)[0] || null;
}

/** Tất cả bot đang chạy trong tiến trình (bot chính + bot con + bot phụ), gộp theo botId. */
function allApis() {
  const byBot = new Map();
  try {
    for (const item of Object.values(apiManager?.apiManagerObject || {})) {
      const a = item?.apiZalo;
      if (a) byBot.set(String(a.getBotId?.() ?? item.id), a);
    }
  } catch {
    /* bỏ qua */
  }
  // bổ sung bot chưa có trong apiManager (vd. lúc mới khởi động)
  for (const [botId, a] of Object.entries(apis)) {
    if (!a) continue;
    const key = String(a.getBotId?.() ?? botId);
    if (!byBot.has(key)) byBot.set(key, a);
  }
  return [...byBot.values()];
}

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

async function clearTemp(imagePath) {
  if (!imagePath) return;
  try {
    await clearImagePath(imagePath);
  } catch {
    /* bỏ qua */
  }
}

/** Ghi nhớ msgId -> threadId để bắt reaction ❤️ về sau. */
function indexImage(res, threadId) {
  const id = res?.message?.msgId || res?.attachment?.[0]?.msgId || res?.msgId;
  if (!id) return;
  const s = store();
  s.imageIndex[String(id)] = String(threadId);
  const keys = Object.keys(s.imageIndex);
  if (keys.length > 800) for (const k of keys.slice(0, 200)) delete s.imageIndex[k];
  markDirty();
}

async function recallThread(api, threadId, type) {
  const prev = threadLast.get(String(threadId));
  if (!prev || !api) return;
  threadLast.delete(String(threadId));
  const sentMsgId = prev?.message?.msgId || prev?.attachment?.[0]?.msgId || prev?.msgId;
  if (!sentMsgId) return;
  const cliMsgId = prev?.message?.cliMsgId || prev?.attachment?.[0]?.cliMsgId || sentMsgId;
  try {
    await api
      .undoMessage({ threadId, type, data: { quote: { globalMsgId: String(sentMsgId), cliMsgId: String(cliMsgId) } } })
      .catch(() => {});
    await api.deleteMessage({ type, threadId, data: { cliMsgId, msgId: sentMsgId, uidFrom: api.getBotId?.() } }, false).catch(() => {});
  } catch {
    /* bỏ qua */
  }
}

// ===========================================================================
// VẼ ẢNH
// ===========================================================================
function boardOf() {
  const s = store();
  return [...s.hall.members]
    .filter((m) => m.coins > 0)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3)
    .map((m) => ({ name: m.name, coins: m.coins }));
}

function payloadOf() {
  const s = store();
  return {
    assetDir: ASSET_DIR,
    members: s.hall.members.map((m) => ({ name: m.name, skin: m.skin, seatIndex: m.seat })),
    board: boardOf(),
    note: `${s.hall.note || "Gõ “tham gia” để an tọa"} · ${s.hall.members.length}/${TOTAL_SEATS} chỗ`,
  };
}

/** Gửi ảnh điện vào MỘT nhóm. */
async function sendHallTo(threadId, botId, type, caption) {
  const api = apiOf(botId);
  if (!api) return false;

  let imagePath = null;
  try {
    imagePath = await createChanhDienImage(payloadOf());
  } catch (e) {
    logErr("Vẽ chánh điện lỗi:", e?.message || e);
  }
  if (!imagePath) return false;

  try {
    const prev = threadLast.get(String(threadId));
    if (prev) {
      const t = setTimeout(() => recallThread(api, threadId, type).catch(() => {}), RECALL_DELAY_MS);
      t.unref?.();
    }
    const res = await sendMessageImageNotQuote(
      api,
      { success: true, message: caption || "", type },
      threadId,
      imagePath,
      TTL_IMAGE,
      false,
      type
    );
    threadLast.set(String(threadId), res);
    indexImage(res, threadId);
    return true;
  } catch (e) {
    logErr(`Gửi ảnh điện lỗi (${threadId}):`, e?.message || e);
    return false;
  } finally {
    await clearTemp(imagePath);
  }
}

// gộp nhiều thao tác liên tiếp trong cùng 1 nhóm -> vẽ 1 ảnh
const drawTimers = new Map();
function scheduleDrawTo(threadId, botId, type, caption) {
  const key = String(threadId);
  const prev = drawTimers.get(key);
  if (prev) {
    prev.caption = caption || prev.caption;
    return;
  }
  const entry = { caption: caption || "" };
  const t = setTimeout(async () => {
    drawTimers.delete(key);
    try {
      await sendHallTo(threadId, botId, type, entry.caption);
    } catch (e) {
      logErr("scheduleDrawTo lỗi:", e?.message || e);
    }
  }, RENDER_DEBOUNCE_MS);
  t.unref?.();
  drawTimers.set(key, entry);
}

// ===========================================================================
// BROADCAST (chua pr)
// ===========================================================================
const groupCache = new Map(); // botId -> { ids, at }
let prTimer = null;
let syncTimer = null;
let pendingCaption = "";
let lastBroadcastAt = 0;

async function groupsOf(api) {
  const botId = api.getBotId?.();
  const hit = groupCache.get(botId);
  if (hit && Date.now() - hit.at < GROUP_CACHE_MS) return hit.ids;
  try {
    const res = await api.getAllGroups();
    const ids = Object.keys(res?.gridVerMap || {});
    groupCache.set(botId, { ids, at: Date.now() });
    return ids;
  } catch (e) {
    logErr("Không lấy được danh sách nhóm:", e?.message || e);
    return hit?.ids || [];
  }
}

function defaultBroadcastCaption() {
  const s = store();
  return `🏮 CHÁNH ĐIỆN TỊNH TÂM · ${s.hall.members.length}/${TOTAL_SEATS} chỗ\nThả ❤️ vào ảnh hoặc gõ “tham gia” để an tọa.`;
}

/**
 * Gửi ảnh điện hiện tại cho TOÀN BỘ nhóm của TOÀN BỘ bot.
 * @param {string} caption
 * @param {{force?: boolean}} opts  force = bỏ qua giới hạn 1 phút
 */
async function broadcastHall(caption, { force = false } = {}) {
  const s = store();
  const now = Date.now();
  if (!force && now - lastBroadcastAt < PR_MIN_GAP_MS) return 0;
  lastBroadcastAt = now;

  let imagePath = null;
  try {
    imagePath = await createChanhDienImage(payloadOf());
  } catch (e) {
    logErr("Vẽ ảnh broadcast lỗi:", e?.message || e);
  }
  if (!imagePath) return 0;

  const text = caption || defaultBroadcastCaption();
  let sent = 0;
  let failed = 0;

  for (const api of allApis()) {
    const ids = await groupsOf(api);
    for (const gid of ids) {
      try {
        const res = await sendMessageImageNotQuote(
          api,
          { success: true, message: text, type: MessageType.GroupMessage },
          gid,
          imagePath,
          TTL_IMAGE,
          false,
          MessageType.GroupMessage
        );
        indexImage(res, gid);
        threadLast.set(String(gid), res);
        sent++;
      } catch {
        failed++;
      }
      await sleep(250); // giãn nhịp tránh rate limit
    }
  }

  await clearTemp(imagePath);
  log(`Broadcast xong: ${sent} nhóm${failed ? `, ${failed} lỗi` : ""}`);
  return sent;
}

function startPrTimer() {
  if (prTimer) {
    clearInterval(prTimer);
    prTimer = null;
  }
  const s = store();
  if (!s.pr.on) return;
  prTimer = setInterval(() => {
    if (!store().pr.on) return;
    broadcastHall(defaultBroadcastCaption(), { force: true }).catch(() => {});
  }, s.pr.intervalMs);
  prTimer.unref?.();
}

/** Khi có người vào điện lúc đang bật pr -> đồng bộ lại toàn bộ nhóm (gộp 20s). */
function scheduleSyncBroadcast(caption) {
  const s = store();
  if (!s.pr.on) return;
  pendingCaption = caption || pendingCaption;
  if (syncTimer) return;
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    const cap = pendingCaption;
    pendingCaption = "";
    try {
      await broadcastHall(cap || defaultBroadcastCaption());
    } catch (e) {
      logErr("Đồng bộ broadcast lỗi:", e?.message || e);
    }
  }, PR_SYNC_DEBOUNCE_MS);
  syncTimer.unref?.();
}

// ===========================================================================
// HÀNH ĐỘNG
// ===========================================================================
function findMember(uid) {
  const s = store();
  return s.hall.members.find((m) => String(m.uid) === String(uid)) || null;
}

function freeSeat() {
  const s = store();
  const used = new Set(s.hall.members.map((m) => m.seat));
  for (let i = 0; i < TOTAL_SEATS; i++) if (!used.has(i)) return i;
  return -1;
}

function pruneMembers() {
  const s = store();
  const now = Date.now();
  const before = s.hall.members.length;
  s.hall.members = s.hall.members.filter((m) => now - (m.lastAt || 0) < MEMBER_IDLE_MS);
  if (s.hall.members.length !== before) markDirty();
  return before - s.hall.members.length;
}

function joined(uid, name) {
  const s = store();
  const existing = findMember(uid);
  if (existing) return { ok: false, reason: "already", member: existing };

  pruneMembers();
  const seat = freeSeat();
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
  s.hall.members.push(member);

  const merit = meritOf(uid, member.name);
  merit.visits = (merit.visits || 0) + 1;
  merit.lastAt = Date.now();

  s.hall.note = `${member.name} vừa an tọa`;
  s.hall.updatedAt = Date.now();
  markDirty();
  return { ok: true, member };
}

function left(uid) {
  const s = store();
  const idx = s.hall.members.findIndex((m) => String(m.uid) === String(uid));
  if (idx === -1) return null;
  const [m] = s.hall.members.splice(idx, 1);
  s.hall.note = `${m.name} đã rời điện`;
  s.hall.updatedAt = Date.now();
  markDirty();
  return m;
}

function parseAction(raw) {
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

  const robeMatch = text.match(/^(?:doi ao|ao|doi)\s*(.*)$/);
  if (robeMatch) {
    const robe = robeMatch[1].trim();
    if (!robe) return { type: "robe", robe: null };
    if (ROBES[robe]) return { type: "robe", robe: ROBES[robe] };
    return { type: "robe", robe: null, invalid: true };
  }

  for (const gift of GIFTS) {
    if (gift.words.includes(text)) return { type: "gift", gift };
  }
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
// THỰC THI HÀNH ĐỘNG
// ===========================================================================
function ctxOf(message) {
  return {
    threadId: String(message.threadId),
    botId: message.__botId || null,
    type: message.type === MessageType.DirectMessage ? MessageType.DirectMessage : MessageType.GroupMessage,
  };
}

async function doJoin(api, message) {
  const uid = String(message.data?.uidFrom || "");
  const name = message.data?.dName || String(uid);
  const res = joined(uid, name);
  const c = ctxOf(message);

  if (!res.ok && res.reason === "already") {
    await reply(api, message, `Bạn đã an tọa ở chỗ ${res.member.seat + 1}/${TOTAL_SEATS} rồi.\nGõ “tụng kinh” hoặc “2” để dâng hương nhé!`, "query", TTL_NOTICE);
    return true;
  }
  if (!res.ok && res.reason === "full") {
    await reply(api, message, `Chánh điện đã đủ ${TOTAL_SEATS} chỗ.\nChờ ai đó gõ “ra”, hoặc thử lại sau (người ngồi lâu không tương tác sẽ tự nhường).`, "warning", TTL_NOTICE);
    return true;
  }

  const cap = `🙏 ${res.member.name} đã an tọa · chỗ ${store().hall.members.length}/${TOTAL_SEATS}`;
  scheduleDrawTo(c.threadId, c.botId, c.type, cap);
  scheduleSyncBroadcast(cap);
  return true;
}

async function doLeave(api, message) {
  const uid = String(message.data?.uidFrom || "");
  const m = left(uid);
  if (!m) {
    await reply(api, message, "Bạn đang không ở trong điện.", "warning", TTL_NOTICE);
    return true;
  }
  const c = ctxOf(message);
  const n = store().hall.members.length;
  if (n === 0) {
    await reply(api, message, `🏮 ${m.name} đã rời điện. Điện giờ vắng, gõ “tham gia” để mở lại.`, "complete", TTL_NOTICE);
  } else {
    scheduleDrawTo(c.threadId, c.botId, c.type, `🚪 ${m.name} đã rời điện · còn ${n}/${TOTAL_SEATS}`);
  }
  scheduleSyncBroadcast(`🚪 ${m.name} đã rời điện · còn ${n}/${TOTAL_SEATS}`);
  return true;
}

async function doChant(api, message, member) {
  const line = SUTRA[Math.floor(Math.random() * SUTRA.length)];
  member.chants = (member.chants || 0) + 1;
  member.lastAt = Date.now();
  const merit = meritOf(member.uid, member.name);
  merit.chants = (merit.chants || 0) + 1;
  merit.lastAt = Date.now();
  store().hall.note = `${member.name} đang tụng kinh`;
  markDirty();
  await reply(api, message, `📿 ${member.name}: “${line}”`, "complete", TTL_NOTICE);
  return true;
}

async function doGift(api, message, member, gift, wish) {
  member.coins += gift.coins;
  member.gifts = (member.gifts || 0) + 1;
  member.lastAt = Date.now();

  const merit = meritOf(member.uid, member.name);
  merit.coins = (merit.coins || 0) + gift.coins;
  merit.gifts = (merit.gifts || 0) + 1;
  merit.lastAt = Date.now();

  store().hall.note = `${member.name} dâng ${gift.label.toLowerCase()} +${gift.coins}`;
  store().hall.updatedAt = Date.now();
  markDirty();

  const c = ctxOf(message);
  const wishText = wish ? `\nLời nguyện: “${wish.slice(0, 120)}”` : "";
  const big = gift.coins >= 99 ? "\n🔔 Chuông ngân, cả điện cùng hoan hỷ!" : "";
  const cap = `${gift.emoji} ${member.name} dâng ${gift.label} +${gift.coins} công đức · tổng ${member.coins}${wishText}${big}`;
  scheduleDrawTo(c.threadId, c.botId, c.type, cap);
  scheduleSyncBroadcast(`${gift.emoji} ${member.name} dâng ${gift.label} +${gift.coins}`);
  return true;
}

async function doBoard(api, message) {
  const top = boardOf();
  if (top.length === 0) {
    await reply(api, message, "Chưa ai dâng lễ trong điện.\nGõ “1” hoặc “canh sen” để bắt đầu.", "query", TTL_INFO);
    return true;
  }
  const medal = ["🥇", "🥈", "🥉"];
  await reply(api, message, `🏆 TẤM LÒNG THÀNH\n${top.map((t, i) => `${medal[i]} ${t.name} — ${t.coins} công đức`).join("\n")}`, "complete", TTL_INFO);
  return true;
}

async function doList(api, message) {
  const members = store().hall.members;
  if (members.length === 0) {
    await reply(api, message, "Điện đang vắng.\nGõ “tham gia” để an tọa.", "query", TTL_INFO);
    return true;
  }
  const lines = [...members].sort((a, b) => a.seat - b.seat).map((m, i) => `${i + 1}. ${m.name} — chỗ ${m.seat + 1} · ${m.coins} công đức`);
  await reply(
    api,
    message,
    `🧘 ĐANG AN TỌA (${members.length}/${TOTAL_SEATS})\n${lines.slice(0, 20).join("\n")}${lines.length > 20 ? `\n… và ${lines.length - 20} người nữa` : ""}`,
    "query",
    TTL_INFO
  );
  return true;
}

async function doRobe(api, message, member, robe, invalid) {
  if (invalid || !robe) {
    await reply(api, message, "Chọn áo bằng lệnh:\n• đổi áo nam\n• đổi áo nữ\n• đổi áo bà\n• đổi áo ni\n• đổi áo sư\n• đổi áo trẻ", "warning", TTL_INFO);
    return true;
  }
  member.skin = robe;
  member.lastAt = Date.now();
  store().hall.note = `${member.name} đã đổi áo`;
  markDirty();
  const c = ctxOf(message);
  scheduleDrawTo(c.threadId, c.botId, c.type, `👘 ${member.name} đã đổi áo · ${store().hall.members.length}/${TOTAL_SEATS} chỗ`);
  return true;
}

async function dispatchAction(api, message, member, action) {
  switch (action.type) {
    case "join":
      return doJoin(api, message);
    case "leave":
      return doLeave(api, message);
    case "chant":
      return doChant(api, message, member);
    case "gift":
      return doGift(api, message, member, action.gift, action.wish);
    case "board":
      return doBoard(api, message);
    case "list":
      return doList(api, message);
    case "robe":
      return doRobe(api, message, member, action.robe, action.invalid);
    case "help":
      return reply(api, message, helpText(getGlobalPrefix(api.getBotId())), "query", TTL_INFO);
    default:
      return false;
  }
}

// ===========================================================================
// AVATAR cho bảng công đức
// ===========================================================================
async function avatarPathOf(api, uid) {
  const base = path.join(THUMB_DIR, String(uid));
  for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
    try {
      if (fs.existsSync(base + ext)) return base + ext;
    } catch {
      /* bỏ qua */
    }
  }
  try {
    const res = await api.getInfoMembers([String(uid)]);
    const url = res?.profiles?.[uid]?.avatar || res?.profiles?.[String(uid)]?.avatar;
    if (!url) return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 500) return null;
    const ct = String(r.headers.get("content-type") || "");
    const ext = ct.includes("png") ? ".png" : ct.includes("webp") ? ".webp" : ".jpg";
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const file = base + ext;
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}

async function showTop(api, message) {
  const s = store();
  const all = Object.values(s.merits).filter((m) => m.coins > 0);
  if (all.length === 0) {
    await reply(api, message, "Chưa ai dâng lễ lần nào.\nGõ “tham gia” rồi “2” để dâng hương nhé!", "query", TTL_INFO);
    return;
  }
  all.sort((a, b) => b.coins - a.coins || b.gifts - a.gifts);
  const top = all.slice(0, 10);

  const entries = [];
  for (const m of top) {
    entries.push({ name: m.name, coins: m.coins, gifts: m.gifts, avatarPath: await avatarPathOf(api, m.uid) });
  }

  let imagePath = null;
  try {
    imagePath = await createChanhDienTopImage({
      assetDir: ASSET_DIR,
      entries,
      totalMembers: s.hall.members.length,
      note: `Cập nhật ${new Date().toLocaleString("vi-VN")}`,
    });
  } catch (e) {
    logErr("Vẽ bảng công đức lỗi:", e?.message || e);
  }

  if (!imagePath) {
    // không vẽ được thì trả bảng chữ
    await reply(api, message, `🏆 TẤM LÒNG THÀNH\n${entries.map((e, i) => `${i + 1}. ${e.name} — ${e.coins} công đức`).join("\n")}`, "complete", TTL_INFO);
    return;
  }

  try {
    await sendMessageImageNotQuote(
      api,
      { success: true, message: `🏆 TẤM LÒNG THÀNH · top ${entries.length} người dâng lễ nhiều nhất`, type: message.type },
      String(message.threadId),
      imagePath,
      TTL_IMAGE,
      false,
      message.type
    );
  } catch (e) {
    logErr("Gửi ảnh bảng công đức lỗi:", e?.message || e);
  } finally {
    await clearTemp(imagePath);
  }
}

// ===========================================================================
// HELP
// ===========================================================================
function helpText(prefix) {
  const s = store();
  return (
    `🏮 CHÁNH ĐIỆN TỊNH TÂM\n` +
    `Một chánh điện chung ${TOTAL_SEATS} chỗ cho toàn server.\n` +
    `Đang có ${s.hall.members.length}/${TOTAL_SEATS} phật tử.\n\n` +
    `VÀO ĐIỆN — chọn 1 trong 3 cách:\n` +
    `• ${prefix}chua — vào ngay\n` +
    `• gõ thẳng “tham gia”\n` +
    `• thả ❤️ vào ảnh chánh điện\n\n` +
    `TRONG ĐIỆN — gõ thẳng, không cần ${prefix}:\n` +
    `• ra — rời điện, nhường chỗ\n` +
    `• tụng kinh — niệm Phật\n` +
    `• 1 cánh sen (+1) · 2 dâng hương (+5) · 3 hoa sen (+20) · 4 thỉnh chuông (+99)\n` +
    `• công đức — top 3 trong điện\n` +
    `• ds — ai đang ngồi\n` +
    `• đổi áo nam|nữ|bà|ni|sư|trẻ\n\n` +
    `LỆNH (QTV bot):\n` +
    `• ${prefix}chua on | off — bật/tắt toàn server\n` +
    `• ${prefix}chua pr on | off — gửi ảnh điện định kỳ cho mọi nhóm\n` +
    `• ${prefix}chua pr time 30s|15p|1h — đổi chu kỳ (mặc định 3 giờ)\n` +
    `• ${prefix}chua top — ảnh bảng công đức kèm avatar`
  );
}

// ===========================================================================
// LỆNH "chua ..."
// ===========================================================================
async function showStatus(api, message) {
  const s = store();
  const top = boardOf();
  const topText = top.length ? top.map((t, i) => `${i + 1}. ${t.name} — ${t.coins}`).join("\n") : "chưa có ai dâng lễ";
  const prText = s.pr.on ? `đang gửi mỗi ${humanDuration(s.pr.intervalMs)}` : "đang tắt";
  await reply(
    api,
    message,
    `🏮 CHÁNH ĐIỆN\n` +
      `Toàn server: ${s.enabled ? "BẬT" : "TẮT"}\n` +
      `Đang an tọa: ${s.hall.members.length}/${TOTAL_SEATS}\n` +
      `Gửi định kỳ: ${prText}\n` +
      `Tấm lòng thành:\n${topText}`,
    "query",
    TTL_INFO
  );
}

async function checkAssets(api, message) {
  const need = ["hall.jpg", ...SKINS.map((s) => `c_${s}.png`)];
  const missing = need.filter((f) => !fs.existsSync(path.join(ASSET_DIR, f)));
  if (missing.length === 0) {
    await reply(api, message, `✅ Đủ tài nguyên chánh điện trong:\n${ASSET_DIR}\nTổng chỗ: ${TOTAL_SEATS}`, "complete", TTL_INFO);
  } else {
    await reply(api, message, `⚠️ Thiếu ${missing.length} file trong ${ASSET_DIR}:\n${missing.join(", ")}`, "warning", TTL_INFO);
  }
}

export async function handleChanhDienCommand(api, message, groupSettings) {
  if (!(await checkBeforeJoinGame(api, message, groupSettings, false))) return;

  const botId = api.getBotId();
  const threadId = String(message.threadId);
  const senderId = String(message.data?.uidFrom || "");
  apis[botId] = api;
  message.__botId = botId;

  if (message.type === MessageType.DirectMessage) {
    await reply(api, message, "🏮 Chánh điện chỉ chơi được trong nhóm chat.", "warning", TTL_NOTICE);
    return;
  }

  const prefix = getGlobalPrefix(botId);
  const content = String(message.data?.content || "").trim();
  const parts = content.split(/\s+/).filter(Boolean);
  const sub = norm(parts[1] || "");
  const arg = norm(parts[2] || "");
  const isBotAdmin = isAdmin(botId, senderId);

  // ---- bật/tắt toàn server ----
  if (["on", "off", "bat", "tat", "mo", "dong"].includes(sub)) {
    if (!isBotAdmin) {
      await reply(api, message, "Chỉ quản trị bot mới bật/tắt chánh điện toàn server.", "authority", TTL_INFO);
      return;
    }
    const turnOn = ["on", "bat", "mo"].includes(sub);
    const s = store();
    s.enabled = turnOn;
    if (!turnOn) {
      s.pr.on = false;
      startPrTimer();
    }
    markDirty();
    await reply(
      api,
      message,
      turnOn
        ? `✅ CHÁNH ĐIỆN đã BẬT toàn server.\n\nMọi nhóm của mọi bot đều vào được: gõ ${prefix}chua, “tham gia”, hoặc thả ❤️ vào ảnh điện.\nMuốn bot tự gửi ảnh định kỳ: ${prefix}chua pr on`
        : "🚪 CHÁNH ĐIỆN đã TẮT toàn server (kèm tắt gửi định kỳ).",
      "complete",
      TTL_INFO
    );
    return;
  }

  // ---- chua pr on|off|time ----
  if (sub === "pr") {
    if (!isBotAdmin) {
      await reply(api, message, "Chỉ quản trị bot mới điều khiển gửi định kỳ.", "authority", TTL_INFO);
      return;
    }
    const s = store();

    if (["on", "bat", "mo"].includes(arg)) {
      s.enabled = true;
      s.pr.on = true;
      markDirty();
      startPrTimer();
      const n = await broadcastHall(defaultBroadcastCaption(), { force: true });
      await reply(
        api,
        message,
        `📣 Đã BẬT gửi chánh điện định kỳ.\n• Chu kỳ: mỗi ${humanDuration(s.pr.intervalMs)}\n• Vừa gửi: ${n} nhóm\n\nKhi có người thả ❤️ hoặc gõ “tham gia”, ảnh sẽ được đồng bộ lại toàn bộ nhóm.`,
        "complete",
        TTL_INFO
      );
      return;
    }

    if (["off", "tat", "dong"].includes(arg)) {
      s.pr.on = false;
      markDirty();
      startPrTimer();
      await reply(api, message, "🔕 Đã TẮT gửi chánh điện định kỳ. Bot không tự gửi nữa.", "complete", TTL_INFO);
      return;
    }

    if (arg === "time" || arg === "interval") {
      const raw = parts[3] || "";
      const ms = parseDuration(raw);
      if (!ms || ms < PR_MIN_INTERVAL_MS || ms > PR_MAX_INTERVAL_MS) {
        await reply(
          api,
          message,
          `Chu kỳ không hợp lệ.\nVí dụ: ${prefix}chua pr time 30s · ${prefix}chua pr time 15p · ${prefix}chua pr time 1h\n(Tối thiểu 10 giây, tối đa 24 giờ)`,
          "warning",
          TTL_INFO
        );
        return;
      }
      s.pr.intervalMs = ms;
      markDirty();
      startPrTimer();
      await reply(api, message, `⏱️ Đã đổi chu kỳ gửi thành mỗi ${humanDuration(ms)}.`, "complete", TTL_INFO);
      return;
    }

    // không tham số -> xem trạng thái
    await reply(
      api,
      message,
      `📣 GỬI ĐỊNH KỲ\nTrạng thái: ${s.pr.on ? "BẬT" : "TẮT"}\nChu kỳ: mỗi ${humanDuration(s.pr.intervalMs)}\n\nĐổi bằng:\n${prefix}chua pr on | off\n${prefix}chua pr time 30s|15p|1h`,
      "query",
      TTL_INFO
    );
    return;
  }

  if (["check", "assets", "tainguyen"].includes(sub)) {
    if (!isBotAdmin) {
      await reply(api, message, "Chỉ quản trị bot mới dùng được lệnh này.", "authority", TTL_INFO);
      return;
    }
    await checkAssets(api, message);
    return;
  }

  if (["reset", "clear", "xoa"].includes(sub)) {
    if (!isBotAdmin) {
      await reply(api, message, "Chỉ quản trị bot mới dùng được lệnh này.", "authority", TTL_INFO);
      return;
    }
    const s = store();
    s.hall = { members: [], note: "Điện vừa được dọn", updatedAt: Date.now() };
    markDirty();
    await reply(api, message, "🧹 Đã dọn chánh điện (toàn server).", "complete", TTL_INFO);
    return;
  }

  if (["top", "rank", "bxh", "xephang"].includes(sub)) {
    await showTop(api, message);
    return;
  }
  if (["status", "info", "tt"].includes(sub)) {
    await showStatus(api, message);
    return;
  }
  if (["help", "huongdan", "hd"].includes(sub)) {
    await reply(api, message, helpText(prefix), "query", TTL_INFO);
    return;
  }

  const s = store();
  if (!s.enabled) {
    await reply(
      api,
      message,
      isBotAdmin
        ? `Chánh điện đang TẮT toàn server.\nBật bằng: ${prefix}chua on`
        : "Chánh điện đang tạm tắt.\nNhờ quản trị bot bật lại bằng lệnh “chua on”.",
      "warning",
      TTL_INFO
    );
    return;
  }

  // Không gõ gì thêm, hoặc gõ "tham gia"/"vào" -> vào điện luôn
  const JOIN_WORDS = ["", "tham gia", "thamgia", "join", "vao", "vao dien", "ngoi", "an toa", "xin vao", "choi"];
  if (JOIN_WORDS.includes(sub)) {
    await doJoin(api, message);
    return;
  }

  const member = findMember(senderId);
  if (!member) {
    await reply(api, message, `Bạn chưa an tọa trong điện.\nGõ ${prefix}chua (hoặc “tham gia”) để tìm chỗ ngồi.`, "warning", TTL_NOTICE);
    return;
  }

  const argText = parts.slice(1).join(" ");
  const action = parseAction(argText);
  if (!action) {
    await reply(api, message, `Không hiểu “${argText}”.\nGõ “help” để xem cách chơi.`, "warning", TTL_NOTICE);
    return;
  }
  await dispatchAction(api, message, member, action);
}

/**
 * Gõ thẳng "tham gia" (không prefix) -> vào điện, ở bất kỳ nhóm nào.
 */
export async function handleChanhDienQuickReply(api, message) {
  if (message.type !== MessageType.GroupMessage) return false;

  let content = "";
  if (typeof message.data?.content === "string") content = message.data.content.trim();
  else if (message.data?.content && typeof message.data.content === "object") {
    content = String(message.data.content.title || message.data.content.caption || "").trim();
  }
  if (!content || content.length > 40) return false;

  const s = store();
  if (!s.enabled) return false;

  const botId = api.getBotId();
  const uid = String(message.data?.uidFrom || "");
  if (!uid || uid === String(botId)) return false;

  const action = parseAction(content);
  if (!action) return false;

  apis[botId] = api;
  message.__botId = botId;

  if (action.type === "join") {
    await doJoin(api, message);
    return true;
  }

  const member = findMember(uid);
  if (!member) {
    if (["help", "list", "board"].includes(action.type)) {
      await dispatchAction(api, message, null, action);
      return true;
    }
    await reply(api, message, "Bạn chưa an tọa trong điện.\nGõ “tham gia” để tìm chỗ ngồi.", "warning", TTL_NOTICE);
    return true;
  }

  log(`${message.data?.dName || uid} -> ${action.type}${action.gift ? ":" + action.gift.key : ""}`);
  await dispatchAction(api, message, member, action);
  return true;
}

/**
 * Thả ❤️ vào ảnh chánh điện -> vào điện luôn (giống masoi thả tim vào sảnh).
 */
export async function handleChanhDienReaction(api, reaction) {
  try {
    const content = reaction?.data?.content;
    if (Number(content?.rType) !== 5) return false;

    const msgId = String(content?.rMsg?.[0]?.gMsgID ?? "");
    if (!msgId) return false;

    const uid = String(reaction?.data?.uidFrom || "");
    if (!uid || uid === String(api.getBotId())) return false;

    const s = store();
    if (!s.enabled) return false;

    const threadId = s.imageIndex[msgId];
    if (!threadId) return false; // không phải ảnh điện của bot
    if (findMember(uid)) return false; // đã ngồi rồi

    apis[api.getBotId()] = api;
    const name = reaction?.data?.dName || String(uid);
    const res = joined(uid, name);
    if (!res.ok) return false;

    const cap = `💗 ${res.member.name} thả tim và an tọa · chỗ ${s.hall.members.length}/${TOTAL_SEATS}`;
    scheduleDrawTo(threadId, api.getBotId(), MessageType.GroupMessage, cap);
    scheduleSyncBroadcast(cap);
    log(`${name} thả tim vào ảnh điện -> chỗ ${res.member.seat + 1}`);
    return true;
  } catch (e) {
    logErr("Lỗi xử lý thả tim vào điện:", e?.message || e);
    return false;
  }
}

// ===========================================================================
// DỌN DẸP + KHỞI TẠO
// ===========================================================================
let sweepJob = null;

function sweep() {
  const s = store();
  const now = Date.now();
  pruneMembers();
  if (s.hall.members.length === 0 && now - (s.hall.updatedAt || 0) > HALL_IDLE_MS) {
    s.hall.note = "Điện vắng đã lâu";
  }
  // dọn index ảnh cũ
  const keys = Object.keys(s.imageIndex);
  if (keys.length > 800) for (const k of keys.slice(0, 200)) delete s.imageIndex[k];
  markDirty();
}

export async function initializeChanhDien(api) {
  if (api?.getBotId) apis[api.getBotId()] = api;

  const s = store();
  threadLast.clear();
  drawTimers.clear();
  if (!Array.isArray(s.hall.members)) s.hall.members = [];
  markDirty();

  if (!fs.existsSync(path.join(ASSET_DIR, "hall.jpg"))) {
    logErr(`Thiếu ${path.join(ASSET_DIR, "hall.jpg")} — ảnh chánh điện sẽ không vẽ được.`);
  }

  startPrTimer();

  if (sweepJob) clearInterval(sweepJob);
  sweepJob = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepJob.unref?.();

  console.log(
    chalk.magentaBright(
      `Chánh Điện Tịnh Tâm started — ${TOTAL_SEATS} chỗ, ${s.hall.members.length} phật tử, ` +
        `server ${s.enabled ? "BẬT" : "TẮT"}, gửi định kỳ ${s.pr.on ? humanDuration(s.pr.intervalMs) : "tắt"}`
    )
  );
}
