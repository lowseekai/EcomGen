/**
 * 上线前实测：安全性 + 连通性。
 *
 * 对**当前源码构建出的镜像**执行，覆盖：
 * 响应头、会话 Cookie 属性、上传类型白名单、路径穿越、未授权访问、
 * 支付回调、SSE、管理端概览。
 */

const BASE = "http://127.0.0.1:8787";
const API = `${BASE}/api/v1`;
// 不内置任何口令：脚本要能在任何环境跑，但绝不把凭据写进仓库。
// 用法：ECOMGEN_BOOTSTRAP_EMAIL=... ECOMGEN_BOOTSTRAP_PASSWORD=... pnpm smoke:live
const EMAIL = process.env.ECOMGEN_BOOTSTRAP_EMAIL;
const PASSWORD = process.env.ECOMGEN_BOOTSTRAP_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("缺少凭据：请设置 ECOMGEN_BOOTSTRAP_EMAIL 与 ECOMGEN_BOOTSTRAP_PASSWORD 后重试。");
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  → ${detail}` : ""}`);
}

async function main() {
  // ---------- 1. 连通性 ----------
  const health = await fetch(`${BASE}/health`);
  check("GET /health 返回 200", health.status === 200, `${health.status} ${await health.text()}`);

  const spa = await fetch(`${BASE}/`);
  const html = await spa.text();
  check("GET / 返回 SPA", spa.status === 200 && html.includes("<div id=\"root\""), `${spa.status}`);

  const deep = await fetch(`${BASE}/admin`);
  check("SPA 深链回退", deep.status === 200, `${deep.status}`);

  // ---------- 2. 安全响应头 ----------
  const headers = spa.headers;
  check("X-Content-Type-Options: nosniff", headers.get("x-content-type-options") === "nosniff", headers.get("x-content-type-options"));
  check("X-Frame-Options: DENY", headers.get("x-frame-options") === "DENY", headers.get("x-frame-options"));
  check("Referrer-Policy: no-referrer", headers.get("referrer-policy") === "no-referrer", headers.get("referrer-policy"));
  const csp = headers.get("content-security-policy") ?? "";
  check("CSP 存在且禁止 object-src", csp.includes("object-src 'none'"), csp.slice(0, 60) + "…");
  check("CSP 允许 antd 内联样式", csp.includes("style-src 'self' 'unsafe-inline'"), "style-src");
  check("CSP 脚本无 unsafe-inline", !/script-src[^;]*unsafe-inline/.test(csp), "script-src");

  // ---------- 3. 未授权访问 ----------
  const anon = await fetch(`${API}/projects`);
  check("未登录访问业务接口返回 401", anon.status === 401, `${anon.status}`);

  const anonAdmin = await fetch(`${API}/admin/dashboard`);
  check("未登录访问管理端返回 401", anonAdmin.status === 401, `${anonAdmin.status}`);

  // ---------- 4. 登录与会话 Cookie ----------
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  check("站长登录成功", login.status === 200, `${login.status}`);
  const setCookie = login.headers.get("set-cookie") ?? "";
  check("会话 Cookie 带 HttpOnly", /httponly/i.test(setCookie), setCookie.slice(0, 80) + "…");
  check("会话 Cookie 带 SameSite", /samesite/i.test(setCookie), "samesite");
  const cookie = setCookie.split(";")[0];

  // 错误口令
  const badLogin = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: "definitely-wrong" }),
  });
  check("错误口令返回 401", badLogin.status === 401, `${badLogin.status}`);

  // ---------- 5. 上传类型白名单（P0-1 回归）----------
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`;
  for (const [label, type, filename] of [
    ["SVG 作为 image/svg+xml", "image/svg+xml", "payload.svg"],
    ["SVG 伪装成 image/png", "image/png", "payload.svg"],
    ["XML 类型", "application/xml", "payload.xml"],
  ]) {
    const form = new FormData();
    form.append("name", "audit");
    form.append("file", new Blob([svg], { type }), filename);
    const response = await fetch(`${API}/patterns/upload`, { method: "POST", headers: { cookie }, body: form });
    check(`拒绝上传：${label}`, response.status === 400 || response.status === 415, `${response.status}`);
  }

  // ---------- 6. 路径穿越 ----------
  const traversals = [
    "/api/v1/files/../../../../etc/passwd",
    "/assets/../../package.json",
    "/%2e%2e/%2e%2e/package.json",
    "/api/v1/files/assets/..%2f..%2f..%2fpackage.json",
  ];
  for (const path of traversals) {
    const response = await fetch(`${BASE}${path}`, { headers: { cookie } });
    const body = await response.text();
    const leaked = body.includes("\"dependencies\"") || body.includes("root:x:");
    // 正确的不变量是「没有文件内容泄漏」。返回 SPA 首页（200 + index.html）是正常回退：
    // fetch 在发送前就会归一化 `..`，这类请求根本到不了穿越路径。
    const spaFallback = body.includes('<div id="root"');
    check(`路径穿越不泄漏文件内容：${path}`, !leaked && (response.status >= 400 || spaFallback), `${response.status}`);
  }

  // ---------- 7. 支付回调 ----------
  const notify = await fetch(`${API}/payments/notify/epay`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "pid=1&trade_no=x&sign=bad" });
  const notifyBody = await notify.text();
  check("支付回调可达且返回纯文本", notify.status === 200 && /^(success|fail)$/.test(notifyBody.trim()), `${notify.status} ${notifyBody.trim()}`);

  // ---------- 8. 管理端概览 ----------
  const dashboard = await fetch(`${API}/admin/dashboard`, { headers: { cookie } });
  const dashboardBody = await dashboard.json().catch(() => null);
  check(
    "管理端概览可读且结构完整",
    dashboard.status === 200 && dashboardBody && typeof dashboardBody.users?.total === "number" && typeof dashboardBody.billing?.uncertain === "number",
    `${dashboard.status}`,
  );

  // ---------- 9. SSE ----------
  const sseNoProject = await fetch(`${API}/events`, { headers: { cookie } });
  check("SSE 缺 projectId 返回 400", sseNoProject.status === 400, `${sseNoProject.status}`);

  // ---------- 10. 退出登录 ----------
  const logout = await fetch(`${API}/auth/logout`, { method: "POST", headers: { cookie } });
  check("退出登录成功", logout.status === 200 || logout.status === 204, `${logout.status}`);
  const afterLogout = await fetch(`${API}/projects`, { headers: { cookie } });
  check("退出后旧 Cookie 失效", afterLogout.status === 401, `${afterLogout.status}`);

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    console.log("失败项：");
    for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("执行异常:", error);
  process.exit(1);
});
