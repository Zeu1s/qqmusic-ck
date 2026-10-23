/*
 * QQ音乐每日签到（金币中心）— 脚本 v3.2（Surge / Loon 双兼容）
 * 一个文件两种模式：
 *   1) http-request 模式：从 QQ音乐 App 自己的请求里抓登录 cookie 存起来
 *      v2 起两个来源都抓：请求正文 JSON 的 comm(uin/authst) 与 Cookie 头(qm_keyst)
 *   2) cron 模式：每天定时用存好的 cookie 调签到接口，结果发通知
 */

const STORE_KEY = "qqmusic_auth_v1";
const ACT_ID = "Z25hHGi";      // 金币中心签到活动
const SCENE_ID = "2";
const API = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const WX_APPID = "wxada7aab80ba27074";

function notify(title, sub, body) {
  $notification.post(title, sub || "", body || "");
}
function loadAuth() {
  try {
    const raw = $persistentStore.read(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveAuth(a) {
  $persistentStore.write(JSON.stringify(a), STORE_KEY);
}
function hash33(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    const shifted = (h | 0) << 5;
    h = h + shifted + str.charCodeAt(i);
  }
  return h & 0x7fffffff;
}
function pickCookieValue(cookie, name) {
  const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]+)").exec(cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
}
function getHeader(name) {
  const headers = ($request && $request.headers) || {};
  for (const k in headers) if (k.toLowerCase() === name) return headers[k];
  return "";
}

/* ---------------- 模式一：抓 cookie ---------------- */
function diagNotify(text) {
  // 诊断通知限流：60 秒内最多一条
  const now = Date.now();
  const last = parseInt($persistentStore.read("qqmusic_diag_at") || "0", 10);
  if (now - last > 60000) {
    $persistentStore.write(String(now), "qqmusic_diag_at");
    notify("QQ音乐抓取诊断", "", text);
  }
}
function argIsOff() {
 // Surge 传字符串（1/2），Loon 可能传对象或 true/false：明确为关才关，其余默认开
 try {
 let a = typeof $argument!== "undefined"? $argument: "";
 if (typeof a === "string" && a.trim().charAt(0) === "{") { try { a = JSON.parse(a);} catch (e) {}}
 if (a && typeof a === "object") {
 for (const k in a) {
 const v = String(a[k]).trim().toLowerCase();
 if (v === "false" || v === "2" || v === "0" || v === "off") return true;
}
 return false;
}
 const sv = String(a == null? "": a).trim().toLowerCase();
 return sv === "2" || sv === "false" || sv === "0" || sv === "off";
} catch (e) { return false;}
}
function capture() {
  // 手动触发：Safari 打开 qqmusic.201922.xyz/run 时，直接执行一次签到
  try {
    if (($request.url || "").indexOf("qqmusic.201922.xyz/run") !== -1) {
      runCheckin();
      return;
    }
  } catch (e) {}
   // 开关「抓取cookie」：Surge 模块里填 1=开、2=关；Loon 插件里是开关。传参形式两边不同，统一解析。
 if (argIsOff()) {
 $done({});
 return;
}
  let found = null;
  // 来源一：请求正文里的 comm（新版 App 主要走这里）
  try {
    const body = typeof $request.body === "string" ? $request.body : "";
    if (body) {
      const uinM = /"uin"\s*:\s*"?(\d+)"?/.exec(body);
      const keyM = /"authst"\s*:\s*"([^"]+)"/.exec(body) || /"qm_keyst"\s*:\s*"([^"]+)"/.exec(body);
      if (uinM && keyM) {
        found = { uin: uinM[1], key: keyM[1], cookie: "uin=o" + uinM[1] + "; qm_keyst=" + keyM[1] };
      }
    }
  } catch (e) {}
  // 来源二：Cookie 头（H5/旧通道）
  if (!found) {
    const cookie = getHeader("cookie");
    if (cookie) {
      const key = pickCookieValue(cookie, "qm_keyst") || pickCookieValue(cookie, "qqmusic_key");
      const uin = (pickCookieValue(cookie, "uin") || pickCookieValue(cookie, "wxuin")).replace(/^o/, "");
      if (key && /^\d+$/.test(uin)) found = { uin: uin, key: key, cookie: cookie };
    }
  }
  if (found) {
    found.ua = getHeader("user-agent");
    found.savedAt = Date.now();
    const prev = loadAuth();
    if (!prev || prev.key !== found.key || prev.uin !== found.uin) {
      saveAuth(found);
      notify("QQ音乐签到", "cookie已保存", "uin " + found.uin + "，之后每天 10:02 自动签到");
    }
  } else {
    // 没抓到也要留个现场：只汇报接口类请求，避免被普通请求刷屏
    try {
      const url = ($request && $request.url) || "";
      const bodyStr = typeof $request.body === "string" ? $request.body : "";
      const ck = getHeader("cookie");
      if (url.indexOf(".fcg") !== -1 || url.indexOf("musicu") !== -1 || url.indexOf("musics") !== -1) {
        diagNotify(
          "看到接口请求但没找到cookie\nURL: " + url.slice(0, 90) +
          "\nCookie: " + (ck ? (ck.indexOf("qm_keyst") !== -1 ? "有(含qm_keyst)" : "有(不含qm_keyst)") : "无") +
          "\n正文: " + bodyStr.length + "字节" + (bodyStr.indexOf("authst") !== -1 ? "，含authst字样" : "，无authst字样")
        );
      }
    } catch (e) {}
  }
  $done({});
}

/* ---------------- 模式二：签到 ---------------- */
function postMusicu(auth, payload) {
  return new Promise((resolve) => {
    $httpClient.post(
      {
        url: API,
        headers: {
          "Content-Type": "application/json",
          "Cookie": auth.cookie,
          "User-Agent": auth.ua || "QQMusic/13.0 iPhone",
          "Referer": "https://y.qq.com/",
        },
        body: JSON.stringify(payload),
        timeout: 30,
      },
      (error, response, data) => {
        if (error) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      }
    );
  });
}
function commMain(auth) {
  return { uin: parseInt(auth.uin, 10), authst: auth.key, mina: 1, appid: WX_APPID, ct: 29, cv: 0, format: "json" };
}
function commAlt(auth) {
  return {
    g_tk: hash33(auth.key), uin: parseInt(auth.uin, 10), format: "json",
    inCharset: "utf-8", outCharset: "utf-8", notice: 0,
    platform: "yqq.json", needNewCode: 1, ct: 24, cv: 4747474,
  };
}
function reqOf(moduleName, method, param) {
  return { module: moduleName, method: method, param: param };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function findFirst(root, keys) {
  let out;
  const seen = [];
  (function walk(v) {
    if (out !== undefined || !v || typeof v !== "object") return;
    if (seen.indexOf(v) !== -1) return;
    seen.push(v);
    for (let i = 0; i < keys.length; i++) {
      if (v[keys[i]] !== undefined && v[keys[i]] !== null && v[keys[i]] !== "") { out = v[keys[i]]; return; }
    }
    for (const k in v) { walk(v[k]); if (out !== undefined) return; }
  })(root);
  return out;
}

/* ---- 小程序签名通道（u6.y.qq.com/cgi-bin/musics.fcg）：抽奖签到、每日任务等走这里 ---- */
const APP_API = "https://u6.y.qq.com/cgi-bin/musics.fcg";
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat";
const LOTTERY_ACT_ID = "Z156KEu";
const DAILY_ACT_ID = "Z1NRf2o";
const LOTTERY_PLAY_ID = "PR-Lottery-20240408-33489273491";
const RAIN_KEY = "1joIuy";
const TIMER_MODULE_ID = "ZGp4ja";

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return out;
}
function sha1Hex(str) {
  const bytes = utf8Bytes(str);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);
  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[chunk + i * 4] << 24) | (bytes[chunk + i * 4 + 1] << 16) | (bytes[chunk + i * 4 + 2] << 8) | bytes[chunk + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(function (h) { return (h >>> 0).toString(16).padStart(8, "0"); }).join("");
}
function base64Encode(bytes) {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += table[b0 >> 2] + table[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? table[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? table[b2 & 63] : "=";
  }
  return out;
}
function zzcSign(payload) {
  const h = sha1Hex(payload).toUpperCase();
  const p1i = [23, 14, 6, 36, 16, 7, 19], p2i = [16, 1, 32, 12, 19, 27, 8, 5];
  const scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
  let part1 = "", part2 = "";
  p1i.forEach(function (i) { part1 += h[i]; });
  p2i.forEach(function (i) { part2 += h[i]; });
  const raw = [];
  for (let i = 0; i < 20; i++) raw.push(scramble[i] ^ parseInt(h.substr(i * 2, 2), 16));
  const middle = base64Encode(raw).replace(/[/\\+=]/g, "");
  return ("zzc" + part1 + middle + part2).toLowerCase();
}
function appComm(auth, ct, cv, mesh) {
  return {
    g_tk: hash33(auth.key), uin: parseInt(auth.uin, 10), format: "json",
    inCharset: "utf-8", outCharset: "utf-8", notice: 0,
    platform: "h5", needNewCode: 1, ct: ct, cv: cv, mesh_devops: mesh,
  };
}
function appCommCoin(auth) { return appComm(auth, 1, 200605, "DevopsCoinCenter3"); }
function appCommBase(auth) { return appComm(auth, 23, 0, "DevopsBase"); }
function appPost(auth, cgiKey, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const url = APP_API + "?_webcgikey=" + encodeURIComponent(cgiKey) + "&_=" + Date.now() + "&sign=" + zzcSign(body);
    $httpClient.post(
      {
        url: url,
        headers: {
          "User-Agent": APP_UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "*/*",
          "xweb_xhr": "1",
          "Referer": "https://servicewechat.com/" + WX_APPID + "/175/page-frame.html",
          "Cookie": "uin=o" + auth.uin + "; qm_keyst=" + auth.key,
        },
        body: body,
        timeout: 30,
      },
      (error, response, data) => {
        if (error) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      }
    );
  });
}
function appOk(res, key) {
  key = key || "req_0";
  if (!res || res.code !== 0) return false;
  const r = res[key];
  if (!r || r.code !== 0) return false;
  const d = r.data;
  if (d && typeof d === "object") {
    const ks = ["retCode", "RetCode", "ret", "Ret", "code"];
    for (let i = 0; i < ks.length; i++) {
      if (ks[i] in d && Number(d[ks[i]]) !== 0) return false;
    }
  }
  return true;
}

async function authExpired(auth) {
 // 探活：看原始回包里有没有明确的未登录信号；网络错误不算过期，避免误报
 const res = await postMusicu(auth, {
 comm: commMain(auth),
 req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "GetSignInSummary", { ActID: ACT_ID}),
});
 if (!res) return false;
 try {
 const s = JSON.stringify(res);
 if (/"code":1000/.test(s)) return true;
 if (/未登录|登录已过期|请先登录|登陆已过期|身份验证失败/.test(s)) return true;
} catch (e) {}
 return false;
}

/* ---- 金币中心签到 + 连续签到奖励 ---- */
function extractSignState(res) {
  if (!res || res.code !== 0) return null;
  const s = res.req_0, t = res.req_1;
  if (!s || s.code !== 0 || !t || t.code !== 0 || !s.data || !t.data) return null;
  const info = t.data.Info || s.data.Info || {};
  const tli = t.data.TaskListInfo || {};
  const taskList = ((tli.TaskList || {}).ContinueTaskList) || {};
  return { info: info, taskList: taskList };
}
async function queryState(auth, comm) {
  const payload = {
    comm: comm,
    req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "GetSignInSummary", { ActID: ACT_ID }),
    req_1: reqOf("music.actCenter.ActCenterSignNewSvr", "GetSignInTaskList", { ActID: ACT_ID, ScenesID: SCENE_ID }),
  };
  return extractSignState(await postMusicu(auth, payload));
}
async function doSignIn(auth, comm) {
  const payload = {
    comm: comm,
    req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "SignIn", { ActID: ACT_ID, ScenesID: SCENE_ID }),
  };
  const res = await postMusicu(auth, payload);
  if (!res || res.code !== 0 || !res.req_0) return { ok: false, raw: res };
  const d = res.req_0.data || {};
  return { ok: res.req_0.code === 0 && (d.retCode === 0 || d.retCode === undefined), data: d, raw: res };
}
function formatCoinReward(task) {
  const pl = task && task.PrizeList;
  const prize = Array.isArray(pl) && pl.length ? pl[0] : null;
  if (!prize) return "";
  if (prize.Name) return "（" + prize.Name + "）";
  if (prize.Value) return "（+" + prize.Value + " 金币）";
  return "";
}
function taskCoinValue(task) {
  const pl = (task && task.PrizeList) || [];
  for (let i = 0; i < pl.length; i++) if (pl[i] && Number(pl[i].Type) === 12) return Number(pl[i].Value || 0);
  return pl.length && pl[0] ? Number(pl[0].Value || 0) : 0;
}
async function claimSignPrizeMusicu(auth, comm, taskList, st) {
  const vals = Object.values(taskList || {});
  let task = null;
  for (let i = 0; i < vals.length; i++) if (vals[i] && vals[i].State === 2) { task = vals[i]; break; }
  if (!task) return "";
  const res = await postMusicu(auth, {
    comm: comm,
    req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "AwardPrize", { ActID: ACT_ID, TaskID: task.ID }),
  });
  const d = (res && res.req_0 && res.req_0.data) || {};
  if (res && res.code === 0 && res.req_0 && res.req_0.code === 0 && (d.retCode === 0 || d.retCode === 100004)) {
    st.ok++; st.coins += taskCoinValue(task);
    return formatCoinReward(task);
  }
  st.fail++;
  return "（连续奖励领取失败）";
}

/* ---- 绿钻成长值签到 ---- */
async function lvzSign(auth, comm) {
  const payload = {
    comm: comm,
    req_0: reqOf("music.lvz.MuFest13TaskSvr", "EveryDaySignLvzScore", { Uin: parseInt(auth.uin, 10), Cmd: "get" }),
  };
  const res = await postMusicu(auth, payload);
  if (!res || res.code !== 0 || !res.req_0 || res.req_0.code !== 0) return "";
  const d = res.req_0.data || {};
  if (d.Ret === 0) {
    const score = d.Info && d.Info.Score ? "（成长值 +" + d.Info.Score + "）" : "";
    return "绿钻成长值签到成功" + score;
  }
  if (d.Ret === 20019) return "绿钻成长值今日已签";
  return "";
}

/* ---- 抽奖签到 + 金币抽奖 ---- */
async function lotterySignState(auth) {
  const comm = appCommCoin(auth);
  const res = await appPost(auth, "GetSignInSummary", {
    comm: comm,
    req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "GetSignInSummary", { ActID: LOTTERY_ACT_ID }),
    req_1: reqOf("music.actCenter.ActCenterSignNewSvr", "GetSignInTaskList", { ActID: LOTTERY_ACT_ID }),
  });
  if (!appOk(res, "req_0") || !appOk(res, "req_1")) return null;
  const sd = res.req_0.data || {}, td = res.req_1.data || {};
  const tli = td.TaskListInfo || {};
  return {
    info: td.Info || sd.Info || {},
    taskList: ((tli.TaskList || {}).ContinueTaskList) || {},
  };
}
async function lotterySign(auth, st) {
  let lstate = await lotterySignState(auth);
  if (!lstate) return "";
  const comm = appCommCoin(auth);
  let signedNow = false;
  if (!lstate.info.IsSignIn) {
    const r = await appPost(auth, "SignIn", {
      comm: comm,
      req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "SignIn", { ActID: LOTTERY_ACT_ID }),
    });
    if (!appOk(r)) { st.fail++; return "抽奖签到失败"; }
    st.ok++;
    signedNow = true;
    lstate = (await lotterySignState(auth)) || lstate;
  } else {
    st.ok++;
  }
  const vals = Object.values(lstate.taskList || {});
  let task = null;
  for (let i = 0; i < vals.length; i++) if (vals[i] && vals[i].State === 2) { task = vals[i]; break; }
  if (task) {
    const r = await appPost(auth, "AwardPrize", {
      comm: comm,
      req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "AwardPrize", { ActID: LOTTERY_ACT_ID, TaskID: task.ID }),
    });
    if (appOk(r)) { st.ok++; st.coins += taskCoinValue(task); return "抽奖签到" + formatCoinReward(task); }
    st.fail++;
    return "抽奖签到完成（领奖失败）";
  }
  return signedNow ? "抽奖签到成功" : "抽奖今日已签";
}
function formatLotteryGift(data) {
  let gift = findFirst(data, ["lotteryGift"]);
  if (typeof gift === "string") {
    try { gift = JSON.parse(gift); } catch (e) { if (gift.trim()) return { text: gift.trim(), coins: 0 }; }
  }
  const src = gift && typeof gift === "object" ? gift : data;
  const name = findFirst(src, ["giftName", "prizeName", "PrizeName", "name"]);
  const val = Number(findFirst(src, ["awardValue", "RewardGold", "rewardGold", "coinNum", "coin"]) || 0);
  if (name && val) return { text: String(name) + " +" + val, coins: val };
  if (name) return { text: String(name), coins: 0 };
  if (val) return { text: "金币 +" + val, coins: val };
  return { text: "已领取", coins: 0 };
}
async function lotteryDraw(auth, st) {
  const comm = appCommCoin(auth);
  const info = await appPost(auth, "GetCoinUserInfo", {
    comm: comm,
    req_0: reqOf("music.actCenter.CoinLotterySvr", "GetCoinUserInfo", { Param: 1, Playid: LOTTERY_PLAY_ID }),
  });
  if (!appOk(info)) return "";
  const remain = parseInt(findFirst((info.req_0 || {}).data, ["lotteryRemain"]) || "0", 10);
  if (!(remain > 0)) return "";
  const gifts = [];
  const n = Math.min(remain, 10);
  for (let i = 0; i < n; i++) {
    const res = await appPost(auth, "UserCoinLottery", {
      comm: comm,
      req_0: reqOf("music.actCenter.CoinLotterySvr", "UserCoinLottery", { Param: 1, Playid: LOTTERY_PLAY_ID }),
    });
    if (!appOk(res)) { st.fail++; break; }
    const g = formatLotteryGift((res.req_0 || {}).data);
    gifts.push(g.text);
    st.ok++; st.coins += g.coins;
    await sleep(350);
  }
  return gifts.length ? "金币抽奖 " + gifts.length + " 次：" + gifts.join("、") : "";
}

/* ---- 红包雨 ---- */
function redOk(res) {
  if (!appOk(res)) return false;
  const d = (res.req_0 || {}).data;
  if (!d || !("Code" in d)) return true;
  return Number(d.Code) === 0 || Number(d.Code) === 10000;
}
function readRestChance(data) {
  if (!data || typeof data !== "object") return 0;
  let config = data.BaseConfig;
  if (typeof config === "string") { try { config = JSON.parse(config); } catch (e) { return 0; } }
  if (!config || typeof config !== "object") return 0;
  const session = config.session;
  const segments = session && session.timeSegment;
  if (!Array.isArray(segments)) return 0;
  const now = Math.floor(Date.now() / 1000);
  let active = null;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] && Number(segments[i].status) === 2) { active = segments[i]; break; }
  }
  if (!active) {
    for (let i = 0; i < segments.length; i++) {
      const rng = segments[i] && segments[i].timeRangeTs;
      if (Array.isArray(rng) && rng.length >= 2 && Number(rng[0]) <= now && now <= Number(rng[1])) { active = segments[i]; break; }
    }
  }
  if (!active) return 0;
  return Math.max(0, parseInt(active.restChance || "0", 10));
}
function readPrizeCoins(data) {
  let infos = findFirst(data, ["PrizeInfos", "prizeInfos"]);
  if (typeof infos === "string") { try { infos = JSON.parse(infos); } catch (e) { infos = null; } }
  if (infos && typeof infos === "object") {
    let total = 0;
    const results = infos.results || [];
    for (let i = 0; i < results.length; i++) {
      const info = results[i] && results[i].info;
      if (!info) continue;
      const prizes = info.thePrize || [];
      for (let j = 0; j < prizes.length; j++) {
        if (prizes[j] && /金币/.test(String(prizes[j].prizeName || ""))) {
          total += Number(prizes[j].sendPrizeNum || prizes[j].prizeNum || 0);
        }
      }
    }
    if (total) return total;
  }
  return Number(findFirst(data, ["awardValue", "RewardGold", "rewardGold", "coinNum", "coin"]) || 0);
}
async function redPacketRain(auth, st) {
  const comm = appCommCoin(auth);
  const res = await appPost(auth, "Raining", {
    comm: comm,
    req_0: reqOf("music.actCenter.RedPacketRainSvr", "Raining", { RainKey: RAIN_KEY }),
  });
  if (!redOk(res)) return "";
  const rest = readRestChance((res.req_0 || {}).data);
  if (rest <= 0) return "";
  let completed = 0, coins = 0;
  const n = Math.min(rest, 6);
  for (let i = 0; i < n; i++) {
    const chance = await appPost(auth, "IncrChance", {
      comm: comm,
      req_0: reqOf("music.actCenter.RedPacketRainSvr", "IncrChance", { RainKey: RAIN_KEY, IncrType: 2 }),
    });
    if (!redOk(chance)) { st.fail++; break; }
    await sleep(800);
    const draw = await appPost(auth, "DrawPrizes", {
      comm: comm,
      req_0: reqOf("music.actCenter.RedPacketRainSvr", "DrawPrizes", { RainKey: RAIN_KEY, HitNum: 10, HitStreakNum: 0 }),
    });
    if (!redOk(draw)) { st.fail++; break; }
    completed++;
    st.ok++;
    const pc = readPrizeCoins((draw.req_0 || {}).data);
    coins += pc; st.coins += pc;
  }
  return completed ? "红包雨 " + completed + " 次" + (coins ? "：+" + coins + " 金币" : "") : "";
}

/* ---- 每日任务：查询、上报类任务、领奖、定时金币 ---- */
async function fetchFloorTasks(auth, pageId, floorIds) {
  const res = await appPost(auth, "GetFloors", {
    comm: appCommCoin(auth),
    req_0: reqOf("music.activeCenter.FloorManagerSvr", "GetFloors", { Release: 1, PageID: pageId, PersonalityMode: 1, FloorIDs: floorIds }),
  });
  if (!res || res.code !== 0 || !res.req_0 || res.req_0.code !== 0) return null;
  const data = res.req_0.data;
  if (!data || data.RetCode !== 0) return null;
  const tasks = [];
  const floors = data.Floors || [];
  for (let i = 0; i < floors.length; i++) {
    const items = (floors[i] && floors[i].ItemList) || [];
    for (let j = 0; j < items.length; j++) {
      let conf = items[j] && items[j].ResourceConf;
      if (typeof conf === "string") { try { conf = JSON.parse(conf); } catch (e) { continue; } }
      if (!conf || typeof conf !== "object") continue;
      const list = ((conf.ActTaskModule || {}).TaskList) || [];
      for (let k = 0; k < list.length; k++) {
        if (list[k] && typeof list[k] === "object") {
          const t = {}; for (const key in list[k]) t[key] = list[k][key];
          t._actID = conf.ActID || DAILY_ACT_ID;
          tasks.push(t);
        }
      }
    }
  }
  return tasks;
}
async function getDailyTasks(auth) {
  let t = await fetchFloorTasks(auth, "18NtBy", [193]);
  if (!t || !t.length) t = await fetchFloorTasks(auth, "songpopup", [85]);
  return t;
}
function isTimedTask(t) {
  return t.ID === "26EIHk" || Number(t.Type) === 600 || /定时领金币/.test(t.Name || "");
}
async function claimReadyTasks(auth, tasks, st) {
  const comm = appCommBase(auth);
  const claimed = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || t.State !== 2) continue;
    const pl = t.PrizeList;
    if (!Array.isArray(pl)) continue;
    let hasCoin = false;
    for (let j = 0; j < pl.length; j++) if (pl[j] && Number(pl[j].Type) === 12 && Number(pl[j].Value) > 0) hasCoin = true;
    if (!hasCoin) continue;
    const res = await appPost(auth, "AwardTaskPrize", {
      comm: comm,
      req_0: reqOf("music.activeCenter.ActTaskNewSvr", "AwardTaskPrize", { actID: t._actID, TaskID: t.ID }),
    });
    const d = res && res.req_0 && res.req_0.data;
    if (res && res.code === 0 && res.req_0 && res.req_0.code === 0 && d && d.retCode === 0) {
      const v = Number(d.awardValue || 0);
      claimed.push((t.Name || t.ID) + (v ? " +" + v : ""));
      st.ok++; st.coins += v;
    } else {
      st.fail++;
    }
  }
  return claimed;
}
async function reportTask(auth, t) {
  const res = await appPost(auth, "TaskActDataReport", {
    comm: appCommBase(auth),
    req_0: reqOf("music.activeCenter.ActTaskNewSvr", "TaskActDataReport", { actID: t._actID || DAILY_ACT_ID, taskID: t.ID, actData: 1 }),
  });
  return appOk(res);
}
async function dailyTasks(auth, st) {
  let tasks = await getDailyTasks(auth);
  if (!tasks) { st.fail++; return "每日任务查询失败"; }
  const preds = [
    function (t) { return t.ID === "Zff1WO" || /皇宫身份/.test(t.Name || ""); },
    function (t) { return t.ID === "5E9TC" || /摇钱树/.test(t.Name || ""); },
  ];
  for (let i = 0; i < preds.length; i++) {
    let t = null;
    for (let j = 0; j < tasks.length; j++) if (preds[i](tasks[j])) { t = tasks[j]; break; }
    if (t && t.State === 1) {
      if (await reportTask(auth, t)) {
        st.ok++;
        await sleep(1200);
        const fresh = await getDailyTasks(auth);
        if (fresh) tasks = fresh;
      } else {
        st.fail++;
      }
    }
  }
  // 浏览/查看类任务：名字是纯「看」的动作、且奖励含金币的，用同一个上报接口完成（服务器认客户端上报）。
 // 收藏/关注/分享/邀请/下载/听歌/广告等不在此列，一律不碰。
 const BROWSE_RE = /浏览|查看|逛一逛|逛逛|围观|访问/;
 const SKIP_RE = /收藏|关注|分享|邀请|下载|购买|开通|听|播放|评论|点赞|广告|填写|输入/;
 let browseTried = 0;
 for (let i = 0; i < tasks.length && browseTried < 6; i++) {
 const t = tasks[i];
 if (!t || t.State!== 1 || isTimedTask(t)) continue;
 if (t.ID === "Zff1WO" || t.ID === "5E9TC") continue;
 const nm = t.Name || "";
 if (!BROWSE_RE.test(nm) || SKIP_RE.test(nm)) continue;
 const pl = Array.isArray(t.PrizeList)? t.PrizeList: [];
 let hasCoin = false;
 for (let j = 0; j < pl.length; j++) if (pl[j] && Number(pl[j].Type) === 12 && Number(pl[j].Value) > 0) hasCoin = true;
 if (!hasCoin) continue;
 browseTried++;
 const need = Math.min(Math.max((Number(t.TaskMaxTimes) || 1) - (Number(t.TaskFinishTime) || 0), 1), 3);
 for (let n = 0; n < need; n++) {
 if (!(await reportTask(auth, t))) break;
 await sleep(1200);
 const fresh = await getDailyTasks(auth);
 if (fresh) tasks = fresh;
 let now = null;
 for (let j = 0; j < tasks.length; j++) if (tasks[j].ID === t.ID) { now = tasks[j]; break;}
 if (!now || now.State === 2) break;
}
}
 const rest = [];
  for (let i = 0; i < tasks.length; i++) if (!isTimedTask(tasks[i])) rest.push(tasks[i]);
  const claimed = await claimReadyTasks(auth, rest, st);
  return claimed.length ? "每日任务领奖：" + claimed.join("、") : "";
}
async function timedCoins(auth, st) {
  const lines = [];
  const floor = await fetchFloorTasks(auth, "18NtBy", [193]);
  const timed = (floor || []).filter(isTimedTask);
  if (timed.length) {
    const c = await claimReadyTasks(auth, timed, st);
    if (c.length) lines.push("定时金币：" + c.join("、"));
  }
  const res = await appPost(auth, "GetTaskModules", {
    comm: appCommBase(auth),
    req_0: reqOf("music.activeCenter.ActTaskNewSvr", "GetTaskModules", { actID: DAILY_ACT_ID, taskModuleIDs: [TIMER_MODULE_ID] }),
  });
  if (appOk(res)) {
    const mods = ((res.req_0 || {}).data || {}).taskModules || {};
    const tt = [];
    for (const k in mods) {
      const m = mods[k];
      if (m && Array.isArray(m.TaskList)) {
        for (let i = 0; i < m.TaskList.length; i++) {
          const t = {}; for (const key in m.TaskList[i]) t[key] = m.TaskList[i][key];
          t._actID = DAILY_ACT_ID;
          tt.push(t);
        }
      }
    }
    if (tt.length) {
      const c = await claimReadyTasks(auth, tt, st);
      if (c.length) lines.push("定时宝箱：" + c.join("、"));
    }
  }
  return lines.join("\n");
}

/* ---- 金币余额（签到页 SSR 数据） ---- */
function coinBalanceValue(auth) {
  return new Promise((resolve) => {
    $httpClient.get(
      {
        url: "https://i2.y.qq.com/n3/coin_center/pages/client_v1/sign.html?_hidehd=1&_hdct=1&_miniplayer=1",
        headers: {
          "User-Agent": APP_UA,
          "Cookie": "uin=o" + auth.uin + "; qm_keyst=" + auth.key,
          "Referer": "https://i2.y.qq.com/n3/coin_center/pages/client_v1/index.html",
        },
        timeout: 30,
      },
      (error, response, data) => {
        if (error || !data) { resolve(null); return; }
        const m = /__ssrFirstPageData__="((?:[^"\\]|\\.)*)"/.exec(data);
        if (!m) { resolve(null); return; }
        try {
          const obj = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
          if (obj && obj.coin !== undefined && obj.coin !== null) resolve(parseInt(obj.coin, 10));
          else resolve(null);
        } catch (e) { resolve(null); }
      }
    );
  });
}

/* ---- 主流程 ---- */
async function safeRun(fn, st) {
  try { return await fn(); } catch (e) { st.fail++; return ""; }
}
async function runCheckin() {
  const auth = loadAuth();
  if (!auth) {
    notify("QQ音乐签到", "还没有cookie", "先在模块/插件设置里打开『抓取cookie』，再打开一次 QQ音乐 App，脚本会自动抓取并保存登录cookie");
    $done();
    return;
  }
  const st = { ok: 0, fail: 0, coins: 0 };
  const balBefore = await coinBalanceValue(auth);
  let comm = commMain(auth);
  let state = await queryState(auth, comm);
  if (!state) {
    comm = commAlt(auth);
    state = await queryState(auth, comm);
  }
  if (!state) {
 if (await authExpired(auth)) {
 notify("QQ音乐签到", "⚠️ cookie已失效", "登录cookie已过期，本次签到跳过。重新抓取：①在模块/插件设置里打开『抓取cookie』 ②打开一次 QQ音乐 App，收到『cookie已保存』后把开关关掉。完成后下一次签到自动恢复。");
} else {
 notify("QQ音乐签到", "签到失败", "接口无响应（多半是网络问题），稍后可用 Safari 打开 https://qqmusic.201922.xyz/run 重试");
}
 $done();
 return;
}
  const lines = [];
  let signedNow = false;
  if (!state.info.IsSignIn) {
    const r = await doSignIn(auth, comm);
    if (!r.ok) {
      notify("QQ音乐签到", "签到失败", "接口返回异常：" + JSON.stringify(r.raw || {}).slice(0, 200));
      $done();
      return;
    }
    signedNow = true;
    state = (await queryState(auth, comm)) || state;
  }
  st.ok++;
  let coinMsg = signedNow ? "金币中心签到成功" : "金币中心今日已签到";
  coinMsg += await safeRun(function () { return claimSignPrizeMusicu(auth, comm, state.taskList, st); }, st);
  lines.push(coinMsg);

  const lvz = await safeRun(function () { return lvzSign(auth, comm); }, st);
  if (lvz) { lines.push(lvz); st.ok++; }
  const lot = await safeRun(function () { return lotterySign(auth, st); }, st);
  if (lot) lines.push(lot);
  const draw = await safeRun(function () { return lotteryDraw(auth, st); }, st);
  if (draw) lines.push(draw);
  const dt = await safeRun(function () { return dailyTasks(auth, st); }, st);
  if (dt) lines.push(dt);
  const hour = new Date().getHours();
  if (hour === 9 || hour === 10) {
    const tc = await safeRun(function () { return timedCoins(auth, st); }, st);
    if (tc) lines.push(tc);
  }
  if ([0, 8, 12, 16, 20, 22].indexOf(hour) !== -1) {
    const rain = await safeRun(function () { return redPacketRain(auth, st); }, st);
    if (rain) lines.push(rain);
  }
  const balAfter = await coinBalanceValue(auth);
  if (balAfter !== null && balAfter !== undefined) {
    let balLine = "金币余额：" + balAfter;
    if (balBefore !== null && balBefore !== undefined) {
      const delta = balAfter - balBefore;
      balLine += "（本次 " + (delta >= 0 ? "+" : "") + delta + "）";
    }
    lines.push(balLine);
  }
  let summary = "汇总：成功 " + st.ok + " 项，失败 " + st.fail + " 项";
  if (balBefore !== null && balBefore !== undefined && balAfter !== null && balAfter !== undefined) {
    const delta = balAfter - balBefore;
    summary += "，本次到账 " + (delta >= 0 ? "+" : "") + delta + " 金币";
  } else if (st.coins > 0) {
    summary += "，本次领取 +" + st.coins + " 金币";
  }
  lines.push(summary);
  notify("QQ音乐签到", "完成", lines.join("\n"));
  $done();
}

/* ---------------- 入口 ---------------- */
if (typeof $request !== "undefined") {
  capture();
} else {
  runCheckin();
}

/* ================= 使用说明（Surge / Loon 通用） =================
【总开关】
- Surge：模块 →「QQ音乐自动签到」，停用 = 全部停止；启用 = 恢复。
- Loon：插件 →「QQ音乐自动签到」，关闭 = 全部停止；打开 = 恢复。
平时保持启用即可，不用管它。

【抓取cookie开关】
- Surge：模块设置里的「抓取cookie」填数字，1 = 开、2 = 关。
- Loon：插件设置里的「抓取cookie」开关，开 / 关即可。
- 平时关着（Surge 填 2）：只用已存的 cookie 每天签到，不再抓取。
- 这两种情况才打开：① 第一次使用、还没抓到过 cookie；
  ② 收到「⚠️ cookie已失效」通知。打开 → 开一次 QQ 音乐 App →
  收到「cookie已保存」通知 → 再关掉（Surge 改回 2）。

【自动签到】每天北京时间 10:02 自动执行，结果以通知告知。
- 改时间：Surge 改模块文件里「QQ音乐签到」一行的 cronexp="2 10 * * *"，格式「分 时 * * *」，
  如晚上 21:30 就是 "30 21 * * *"；Loon 改插件里 cron 那行的时间。
  改完删掉模块/插件、重新从安装链接装一次才生效。

【手动签到】定时脚本没法在界面上点运行，用这个代替：
- 保持 Surge / Loon 代理开着，用 Safari 打开 https://qqmusic.201922.xyz/run ，
  会立刻执行一次签到，结果看通知。

【cookie 存在哪】只存在你这台手机本地（Surge / Loon 各存各的、互不相通），
不经过任何服务器。在哪个应用里用，就要在哪个应用里抓一次。
删掉模块/插件再重装，cookie 一般不会丢；万一丢了重新抓一次即可。

【cookie 过期提示】每次运行先探活：只有接口明确回「未登录」才判定过期
（网络超时不算、不会误报）。判定过期会单独发一条「⚠️ cookie已失效」
通知并跳过当天剩余动作，按通知里的步骤重新抓一次即可。

【每天自动做的事】（互不影响，通知里逐项报账）
- 金币中心签到 + 连续签到奖励领取；顺带绿钻成长值签到；
- 抽奖签到 + 金币抽奖（用完当天次数）；
- 每日任务：已完成待领的金币奖励自动领；「答题」「摇钱树」和
  浏览/查看类任务（名字是纯「看」的动作、奖励含金币的）自动上报完成；
- 定时金币：9 点、10 点时段内运行时顺手领（10:02 正在窗口内）；
- 红包雨：0/8/12/16/20/22 点时段内运行时顺手领。
- 通知最后一行「汇总」报：成功几项、失败几项、本次到账多少金币
  （按运行前后的金币余额差计算）。
没包含：收藏歌曲/歌单、关注歌手（要动账号内容）、听歌时长类
（服务器有播放记录对账）、第三方广告浏览类活动（广告平台验收，
脚本做不了）。这些需要时请在 App 里手动完成。

【更新说明】本脚本托管在 GitHub（Zeu1s/tools）。Surge 对远程文件有缓存，
同地址更新可能读不到新版，所以每个版本都用带版本号的新文件名发布；
升级时删掉旧模块/插件、用新链接装一次即可。
完整文档见仓库 README。
================================================================= */