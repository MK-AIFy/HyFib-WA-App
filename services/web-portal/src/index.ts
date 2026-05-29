import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
import { Logger, parseUrlPath, sendMetrics } from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("web-portal", config.logLevel as "debug" | "info" | "warn" | "error");
const port = 3000;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HyFib WhatsApp Business Platform</title>
  <style>
    :root {
      --bg: #f4f1e8;
      --panel: #fffdf8;
      --ink: #152127;
      --muted: #5c686f;
      --brand: #0a7f78;
      --accent: #ff7a18;
      --line: #dae2de;
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 20% 10%, #f8d08d 0%, transparent 30%),
        radial-gradient(circle at 80% 30%, #9ad9cc 0%, transparent 35%),
        var(--bg);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .app {
      width: min(1120px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: 0 12px 40px rgba(21,33,39,.1);
      overflow: hidden;
    }
    .header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .brand {
      font-size: 18px;
      font-weight: 700;
    }
    .header small { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 0;
    }
    .panel {
      padding: 20px;
      border-right: 1px solid var(--line);
      background: #fff;
    }
    .panel h3 {
      margin: 0 0 12px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--muted);
    }
    .main {
      padding: 20px;
    }
    label {
      display: block;
      margin: 10px 0 6px;
      font-size: 12px;
      color: var(--muted);
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      font: inherit;
      background: #fff;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
      background: var(--brand);
      color: #fff;
      margin-top: 12px;
    }
    button.secondary {
      background: #fff;
      color: var(--ink);
      border: 1px solid var(--line);
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    pre {
      background: #101a1f;
      color: #e7f4f2;
      border-radius: 12px;
      padding: 14px;
      max-height: 380px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.5;
    }
    .kpi {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 16px;
    }
    .kpi div {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      background: #fff;
    }
    .kpi b { display: block; font-size: 20px; }
    .kpi span { color: var(--muted); font-size: 12px; }
    @media (max-width: 920px) {
      .grid { grid-template-columns: 1fr; }
      .panel { border-right: 0; border-bottom: 1px solid var(--line); }
      .kpi { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="header">
      <div>
        <div class="brand">HyFib WhatsApp Business Control Plane</div>
        <small>Multi-user marketing, sales, and e-commerce operations</small>
      </div>
      <small id="status">Disconnected</small>
    </div>

    <div class="grid">
      <section class="panel">
        <h3>Workspace Context</h3>

        <label>Gateway URL</label>
        <input id="baseUrl" value="/api/v1" />

        <label>Tenant ID</label>
        <input id="tenantId" placeholder="tenant_xxx" />

        <label>Role</label>
        <select id="role">
          <option>platform_owner</option>
          <option>tenant_admin</option>
          <option selected>marketing_manager</option>
          <option>sales_agent</option>
          <option>support_agent</option>
          <option>analyst</option>
          <option>compliance_auditor</option>
        </select>

        <label>Actor ID</label>
        <input id="actorId" value="user_console" />

        <h3 style="margin-top:20px;">Quick Actions</h3>
        <div class="actions">
          <button onclick="health()">Health</button>
          <button class="secondary" onclick="listTenants()">Tenants</button>
          <button class="secondary" onclick="createTenant()">Create Tenant</button>
          <button class="secondary" onclick="listTemplates()">Templates</button>
          <button class="secondary" onclick="analytics()">Analytics</button>
        </div>
      </section>

      <section class="main">
        <div class="kpi">
          <div><b id="kpiTenants">0</b><span>Tenants</span></div>
          <div><b id="kpiTemplates">0</b><span>Templates</span></div>
          <div><b id="kpiCampaigns">0</b><span>Campaigns</span></div>
          <div><b id="kpiContacts">0</b><span>Contacts</span></div>
        </div>

        <label>Response</label>
        <pre id="output">Ready.</pre>
      </section>
    </div>
  </div>

  <script>
    const headers = () => ({
      'content-type': 'application/json',
      'x-tenant-id': document.getElementById('tenantId').value,
      'x-role': document.getElementById('role').value,
      'x-actor-id': document.getElementById('actorId').value
    });

    const url = (path) => document.getElementById('baseUrl').value + path;

    function setOutput(data) {
      document.getElementById('output').textContent = JSON.stringify(data, null, 2);
      document.getElementById('status').textContent = 'Connected';
    }

    async function req(path, method = 'GET', body) {
      const res = await fetch(url(path), { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({ status: res.status }));
      setOutput({ status: res.status, data });
      return data;
    }

    async function health() {
      const res = await fetch('/health');
      const data = await res.json();
      setOutput(data);
    }

    async function listTenants() {
      const data = await req('/tenants');
      document.getElementById('kpiTenants').textContent = (data.items || []).length;
    }

    async function createTenant() {
      const name = 'Tenant ' + new Date().toISOString().slice(11, 19);
      const data = await req('/tenants', 'POST', { name });
      if (data.id) {
        document.getElementById('tenantId').value = data.id;
      }
    }

    async function listTemplates() {
      const data = await req('/templates');
      document.getElementById('kpiTemplates').textContent = (data.items || []).length;
    }

    async function analytics() {
      const data = await req('/analytics');
      const totals = data.totals || {};
      document.getElementById('kpiTemplates').textContent = totals.templates || 0;
      document.getElementById('kpiCampaigns').textContent = totals.campaigns || 0;
      document.getElementById('kpiContacts').textContent = totals.contacts || 0;
    }
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  const path = parseUrlPath(req.url);

  if (path === "/metrics") {
    sendMetrics(res);
    return;
  }

  if (path === "/health") {
    const payload = JSON.stringify({
      service: "web-portal",
      status: "ok",
      timestamp: new Date().toISOString()
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(payload);
    return;
  }

  if (path === "/" || path === "/index.html") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, () => {
  logger.info("service_started", {
    port,
    nodeEnv: config.nodeEnv
  });
});

server.on("error", (error) => {
  logger.error("service_error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
