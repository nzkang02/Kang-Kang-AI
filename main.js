const {
  app,
  BrowserWindow,
  globalShortcut,
  clipboard,
  screen,
  Tray,
  nativeImage,
  ipcMain,
  Menu
} = require("electron");

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const Groq = require("groq-sdk");
const pinyin = require("pinyin");

/* ================= ENCRYPT ================= */
function getSecret() {
  return crypto
    .createHash("sha256")
    .update(os.hostname() + os.userInfo().username)
    .digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getSecret(), iv);
  return (
    iv.toString("hex") +
    ":" +
    Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("hex")
  );
}

function decrypt(data) {
  try {
    const [ivHex, encHex] = data.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      getSecret(),
      Buffer.from(ivHex, "hex")
    );
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, "hex")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

/* ================= CONFIG ================= */
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

function loadApiKey() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const d = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return d.key ? decrypt(d.key) : "";
    }
  } catch {}
  return "";
}

function saveApiKey(key) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ key: encrypt(key) }));
}

let apiKey = loadApiKey();
let groq = apiKey ? new Groq({ apiKey }) : null;

/* ================= STATE ================= */
let win = null;
let tray = null;
let apiFailCount = 0;

/* ================= UTILS ================= */
const hasChinese = t => /[\u4e00-\u9fff]/.test(t);

/* ================= PINYIN (FIX TRIỆT ĐỂ) ================= */
function renderZhWithPinyin(text) {
  const zhChars = [...text].filter(c => /[\u4e00-\u9fff]/.test(c));
  const pys = pinyin(zhChars.join(""), {
    style: pinyin.STYLE_TONE,
    heteronym: false
  });

  let idx = 0;
  return [...text]
    .map(ch => {
      if (/[\u4e00-\u9fff]/.test(ch)) {
        const py = pys[idx]?.[0] || "";
        idx++;
        return `<ruby data-zh="${ch}">${ch}<rt>${py}</rt></ruby>`;
      }
      return `<span>${ch}</span>`;
    })
    .join("");
}

/* ================= AI ================= */
async function translate(text, toZh) {
  if (!groq) throw new Error("NO_API");

  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      messages: [
        { role: "system", content: "Dịch Trung ↔ Việt. Không giải thích." },
        {
          role: "user",
          content: toZh
            ? `Dịch sang tiếng Trung:\n${text}`
            : `Dịch sang tiếng Việt:\n${text}`
        }
      ]
    });
    apiFailCount = 0;
    return res.choices[0].message.content.trim();
  } catch {
    apiFailCount++;
    if (apiFailCount >= 5) showApiInputPopup();
    throw new Error("API_FAIL");
  }
}

/* ================= POPUP ================= */
function createPopup() {
  if (win) return;

  const { x, y } = screen.getCursorScreenPoint();
  win = new BrowserWindow({
    width: 640,
    height: 380,
    x: x + 12,
    y: y + 12,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.on("closed", () => (win = null));
}

function updatePopup(srcText, translatedText, loading = false) {
  createPopup();

  let zhText = "";
  let viText = "";

  if (hasChinese(srcText)) {
    zhText = srcText;
    viText = translatedText;
  } else {
    zhText = translatedText;
    viText = srcText;
  }

  const zhHtml = renderZhWithPinyin(zhText);

  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
<html>
<head>
<style>
body{
margin:0;
padding:18px;
background:rgba(20,20,20,.96);
font-family:-apple-system,BlinkMacSystemFont,
"PingFang SC","PingFang TC","STKaiti","KaiTi",serif;
color:white;
}
.box{
position:relative;
border-radius:18px;
padding:26px 28px 24px;
background:#1e1e1e;
box-shadow:0 18px 45px rgba(0,0,0,.45);
}
.close{
position:absolute;
right:16px;
top:12px;
cursor:pointer;
opacity:.7;
}
.close:hover{opacity:1}

.status{
position:absolute;
left:18px;
top:18px;
width:10px;
height:10px;
border-radius:50%;
background:${loading ? "#f5c542" : "#34c759"};
}

.zh-wrap{
display:flex;
justify-content:center;
gap:10px;
margin-bottom:14px;
}

.copy-btn{
font-size:14px;
cursor:pointer;
opacity:.6;
user-select:none;
margin-top:6px;
}
.copy-btn:hover{opacity:1}

.zh{
font-size:30px;
line-height:2;
text-align:center;
}

ruby{ruby-position:over;margin:0 4px}
rt{
font-size:12px;
color:#bbb;
letter-spacing:.5px;
user-select:none;
pointer-events:none;
}

.vi{
font-size:16px;
line-height:1.6;
color:#e6e6e6;
text-align:center;
}

.loading{
margin-top:18px;
text-align:center;
color:#aaa;
animation:blink 1.2s infinite;
}
@keyframes blink{
0%{opacity:.3}
50%{opacity:1}
100%{opacity:.3}
}
</style>

<script>
function copyZh(){
  const zh = Array.from(
    document.querySelectorAll(".zh ruby")
  ).map(r => r.dataset.zh).join("");
  if(zh){
    navigator.clipboard.writeText(zh);
    const btn=document.querySelector(".copy-btn");
    btn.innerText="✅";
    setTimeout(()=>btn.innerText="📋",800);
  }
}
</script>
</head>

<body>
<div class="box">
  <div class="status"></div>
  <div class="close" onclick="window.close()">✕</div>

  ${
    !hasChinese(srcText)
      ? `<div class="vi">${viText}</div>
         <hr style="border:0;border-top:1px solid #333;margin:12px 0">`
      : ""
  }

  <div class="zh-wrap">
    <div class="copy-btn" onclick="copyZh()">📋</div>
    <div class="zh">${zhHtml}</div>
  </div>

  ${
    hasChinese(srcText)
      ? `<hr style="border:0;border-top:1px solid #333;margin:12px 0">
         <div class="vi">${viText}</div>`
      : ""
  }

  ${loading ? `<div class="loading">⏳ Đang dịch…</div>` : ""}
</div>
</body>
</html>
`)
  );
}

/* ================= API INPUT POPUP ================= */
function showApiInputPopup() {
  if (win) {
    win.close();
    win = null;
  }

  createPopup();

  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
<body style="background:#1e1e1e;color:white;
font-family:-apple-system;padding:20px">
<h3>🔑 Nhập API Key</h3>

<input id="k" type="password"
style="width:100%;padding:10px;border-radius:8px;border:none" />

<div style="margin-top:16px;text-align:right">
  <button onclick="save()">Save</button>
  <button onclick="window.close()">Cancel</button>
</div>

<script>
const {ipcRenderer}=require("electron");
function save(){
 ipcRenderer.send("save-key",
  document.getElementById("k").value);
}
</script>
</body>
`)
  );
}

ipcMain.on("save-key", (_, key) => {
  if (!key || !key.startsWith("gsk_")) {
    updatePopup("❌", "Bảo Bối Chờ 1 Chút AI Đang Lag", false);
    return;
  }
  saveApiKey(key);
  apiKey = key;
  groq = new Groq({ apiKey });
  apiFailCount = 0;
  updatePopup("✅", "Bảo Bối Save API key okela dùi", false);
});

/* ================= APP ================= */
app.whenReady().then(() => {
  tray = new Tray(
    nativeImage.createFromPath(path.join(__dirname, "icon.png"))
  );
  tray.setToolTip("Kang Kang AI");

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Kang Kang AI", enabled: false },
      { type: "separator" },
      { label: "⌘ + D : Dịch", enabled: false },
      { label: "⌘ + ⌥ + K : Đổi API key", enabled: false },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ])
  );

  globalShortcut.register("Command+D", async () => {
    const text = clipboard.readText().trim();
    if (!text) return;

    updatePopup(text, "", true);

    try {
      const out = hasChinese(text)
        ? await translate(text, false)
        : await translate(text, true);

      updatePopup(text, out, false);
    } catch {
      updatePopup(text, "❌ Bảo Bối AI lỗi dùi khum dịch đượt", false);
    }
  });

  globalShortcut.register("Command+Alt+K", showApiInputPopup);
});

/* ================= KEEP ALIVE ================= */
app.on("window-all-closed", e => e.preventDefault());
process.on("unhandledRejection", () => {});
