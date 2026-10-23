/*
 * QQ音乐每日签到（金币中心）— Surge 脚本 v2
 * 一个文件两种模式：
 *   1) http-request 模式：从 QQ音乐 App 自己的请求里抓登录凭证存起来
 *      v2 起两个来源都抓：请求正文 JSON 的 comm(uin/authst) 与 Cookie 头(qm_keyst)
 *   2) cron 模式：每天定时用存好的凭证调签到接口，结果发通知
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
  for (let i = 0; i < str.length; i++) h += (h << 5) + str.charCodeAt(i);
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

/* ---------------- 模式一：抓凭证 ---------------- */
function diagNotify(text) {
  // 诊断通知限流：60 秒内最多一条
  const now = Date.now();
  const last = parseInt($persistentStore.read("qqmusic_diag_at") || "0", 10);
  if (now - last > 60000) {
    $persistentStore.write(String(now), "qqmusic_diag_at");
    notify("QQ音乐抓取诊断", "", text);
  }
}
function capture() {
  // 手动触发：Safari 打开 qqmusic.201922.xyz/run 时，直接执行一次签到
  try {
    if (($request.url || "").indexOf("qqmusic.201922.xyz/run") !== -1) {
      runCheckin();
      return;
    }
  } catch (e) {}
  // 模块开关「抓取凭证」：在模块设置里填 1 = 开，2 = 关（未走模块时默认开）
  const argVal = typeof $argument !== "undefined" ? String($argument).trim() : "";
  if (argVal === "2" || argVal.toLowerCase() === "false") {
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
      notify("QQ音乐签到", "登录凭证已保存", "uin " + found.uin + "，之后每天 10:02 自动签到");
    }
  } else {
    // 没抓到也要留个现场：只汇报接口类请求，避免被普通请求刷屏
    try {
      const url = ($request && $request.url) || "";
      const bodyStr = typeof $request.body === "string" ? $request.body : "";
      const ck = getHeader("cookie");
      if (url.indexOf(".fcg") !== -1 || url.indexOf("musicu") !== -1 || url.indexOf("musics") !== -1) {
        diagNotify(
          "看到接口请求但没找到凭证\nURL: " + url.slice(0, 90) +
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
async function queryState(auth, comm) {
  const payload = {
    comm: comm,
    req_0: reqOf("music.actCenter.ActCenterSignNewSvr", "GetSignInSummary", { ActID: ACT_ID }),
    req_1: reqOf("music.actCenter.ActCenterSignNewSvr", "GetSignInTaskList", { ActID: ACT_ID, ScenesID: SCENE_ID }),
  };
  const res = await postMusicu(auth, payload);
  if (!res || res.code !== 0) return null;
  const s = res.req_0, t = res.req_1;
  if (!s || s.code !== 0 || !t || t.code !== 0) return null;
  const info = (t.data && t.data.Info) || (s.data && s.data.Info) || {};
  return { info: info, raw: res };
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
async function lvzSign(auth, comm) {
  // 绿钻成长值签到（非绿钻账号会失败，静默忽略）
  const payload = {
    comm: comm,
    req_0: reqOf("music.lvz.MuFest13TaskSvr", "EveryDaySignLvzScore", { Uin: parseInt(auth.uin, 10), Cmd: "get" }),
  };
  const res = await postMusicu(auth, payload);
  if (!res || res.code !== 0 || !res.req_0 || res.req_0.code !== 0) return "";
  const d = res.req_0.data || {};
  if (d.Ret === 0) {
    const score = d.Info && d.Info.Score ? "（成长值 +" + d.Info.Score + "）" : "";
    return "\n绿钻成长值签到成功" + score;
  }
  if (d.Ret === 20019) return "\n绿钻成长值今日已签";
  return "";
}

async function runCheckin() {
  const auth = loadAuth();
  if (!auth) {
    notify("QQ音乐签到", "还没有凭证", "请先打开 QQ音乐 App 任意页面一次，让脚本抓到登录凭证");
    $done();
    return;
  }
  let comm = commMain(auth);
  let state = await queryState(auth, comm);
  if (!state) {
    comm = commAlt(auth);
    state = await queryState(auth, comm);
  }
  if (!state) {
    notify("QQ音乐签到", "签到失败", "接口无响应或凭证已失效，请打开 QQ音乐 App 刷新一次凭证后再试");
    $done();
    return;
  }
  let msg;
  if (state.info.IsSignIn) {
    msg = "金币中心今日已签到";
  } else {
    const r = await doSignIn(auth, comm);
    if (r.ok) {
      msg = "金币中心签到成功";
    } else {
      notify("QQ音乐签到", "签到失败", "接口返回异常：" + JSON.stringify(r.raw || {}).slice(0, 200));
      $done();
      return;
    }
  }
  const extra = await lvzSign(auth, comm);
  notify("QQ音乐签到", "完成", msg + extra);
  $done();
}

/* ---------------- 入口 ---------------- */
if (typeof $request !== "undefined") {
  capture();
} else {
  runCheckin();
}

/* ================= 使用说明：怎么开启、怎么关闭 =================
【总开关】Surge →「模块」→「QQ音乐自动签到」
  - 停用模块 = 全部停止：不再抓凭证、每天的自动签到停、手动签到也失效。
  - 启用模块 = 恢复全部功能。平时保持启用即可，不用管它。

【抓取凭证开关】Surge →「模块」→「QQ音乐自动签到」→ 设置里的「抓取凭证」填数字：
  - 填 1 = 开：打开 QQ 音乐 App 时，自动抓取/刷新登录凭证。
  - 填 2 = 关：不再抓取，只用已经存好的凭证每天签到。
  - 平时建议填 2（少打扰）；这两种情况才改成 1：
    ① 第一次使用，还没抓到过凭证；
    ② 某天签到通知说「还没有凭证」或签到失败（多半是凭证过期了）。
    改成 1 → 开一次 QQ 音乐 → 收到「登录凭证已保存」通知 → 再改回 2。

【自动签到】每天北京时间 10:02 自动执行，结果以通知告知（成功/已签到/失败）。
  - 改时间：编辑模块文件里「QQ音乐签到」那一行的 cronexp="2 10 * * *"，
    格式为「分 时 * * *」，例如改成晚上 21:30 就是 "30 21 * * *"；
    改完把模块删掉、重新从安装链接装一次才生效。
  - 只想停掉自动签到：删掉模块里「QQ音乐签到」那一行后重装模块，
    抓凭证和手动签到不受影响。

【手动签到】Surge 里的定时脚本没法在界面上手动点运行，用这个代替：
  - 用 Safari 打开 https://qqmusic.201922.xyz/run ，会立刻执行一次签到，
    结果看通知。需要模块处于启用状态才会触发。

【凭证存在哪】只存在你这台手机的 Surge 本地存储里，不经过任何服务器。
  删掉模块再重装，凭证一般不会丢；万一丢了，按上面的方法重新抓一次即可。
================================================================= */
