const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || "medlab-secret-change-me";
const DB_PATH = path.join(__dirname, "medlab.json");

// ─── Simple JSON Database (بدل SQLite) ───────────────────────────────────────
let store = { changes: {}, devices: {} };

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      store = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!store.changes) store.changes = {};
      if (!store.devices) store.devices = {};
    }
  } catch { store = { changes: {}, devices: {} }; }
}

function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(store)); } catch {}
}

function upsertChange(row) {
  const existing = store.changes[row.id];
  if (!existing || row.timestamp > existing.timestamp) {
    store.changes[row.id] = row;
    saveDB();
    return true;
  }
  return false;
}

function getChangesSince(since) {
  return Object.values(store.changes)
    .filter(c => c.timestamp > since)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 1000);
}

loadDB();
console.log(`📦 Loaded ${Object.keys(store.changes).length} changes from DB`);

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      devices: Object.keys(store.devices).length,
      changes: Object.keys(store.changes).length,
      uptime: Math.floor(process.uptime()),
      time: Date.now()
    }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("MedLab Sync Server v1.0");
  }
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const clients = new Map();

function broadcast(data, excludeDeviceId = null) {
  const msg = JSON.stringify(data);
  for (const [deviceId, ws] of clients) {
    if (deviceId !== excludeDeviceId && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

wss.on("connection", (ws, req) => {
  let deviceId = null;
  let authenticated = false;

  console.log(`[+] New connection from ${req.socket.remoteAddress}`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "auth") {
      if (msg.secret !== SECRET) {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        ws.close();
        return;
      }
      deviceId = msg.device_id || crypto.randomUUID();
      authenticated = true;
      clients.set(deviceId, ws);
      store.devices[deviceId] = { name: msg.device_name || "Unknown", last_seen: Date.now() };
      saveDB();
      console.log(`[✓] Auth: ${msg.device_name || deviceId}`);
      ws.send(JSON.stringify({ type: "auth_ok", device_id: deviceId, server_time: Date.now() }));
      return;
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    if (msg.type === "pull") {
      const changes = getChangesSince(msg.since || 0);
      ws.send(JSON.stringify({ type: "pull_response", changes, server_time: Date.now() }));
      return;
    }

    if (msg.type === "push") {
      const { changes } = msg;
      if (!Array.isArray(changes) || changes.length === 0) return;
      const saved = [];
      for (const c of changes) {
        if (!c.store || !c.record_id) continue;
        const row = {
          id: c.id || `${c.store}:${c.record_id}:${Date.now()}`,
          store: c.store,
          record_id: c.record_id,
          data: typeof c.data === "string" ? c.data : JSON.stringify(c.data),
          deleted: c.deleted ? 1 : 0,
          timestamp: c.timestamp || Date.now(),
          device_id: deviceId,
        };
        if (upsertChange(row)) saved.push(row);
      }
      ws.send(JSON.stringify({ type: "push_ack", count: saved.length }));
      if (saved.length > 0) {
        broadcast({ type: "changes", changes: saved }, deviceId);
        console.log(`[→] ${deviceId} pushed ${saved.length} changes`);
      }
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      return;
    }
  });

  ws.on("close", () => {
    if (deviceId) { clients.delete(deviceId); console.log(`[-] Disconnected: ${deviceId}`); }
  });

  ws.on("error", (err) => console.error(`[!] WS Error:`, err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`✅ MedLab Sync Server running on port ${PORT}`);
});

setInterval(() => saveDB(), 60000);
