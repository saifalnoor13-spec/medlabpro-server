const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");
const Database = require("better-sqlite3");
const crypto = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || "medlab-secret-change-me";

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database("medlab.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS changes (
    id        TEXT PRIMARY KEY,
    store     TEXT NOT NULL,
    record_id TEXT NOT NULL,
    data      TEXT,
    deleted   INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL,
    device_id TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_changes_timestamp ON changes(timestamp);
  CREATE INDEX IF NOT EXISTS idx_changes_store ON changes(store);

  CREATE TABLE IF NOT EXISTS devices (
    device_id   TEXT PRIMARY KEY,
    name        TEXT,
    last_seen   INTEGER
  );
`);

// ─── Prepared Statements ──────────────────────────────────────────────────────
const stmts = {
  upsertChange: db.prepare(`
    INSERT INTO changes (id, store, record_id, data, deleted, timestamp, device_id)
    VALUES (@id, @store, @record_id, @data, @deleted, @timestamp, @device_id)
    ON CONFLICT(id) DO UPDATE SET
      data      = excluded.data,
      deleted   = excluded.deleted,
      timestamp = excluded.timestamp,
      device_id = excluded.device_id
    WHERE excluded.timestamp > changes.timestamp
  `),

  getChangesSince: db.prepare(`
    SELECT * FROM changes WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 1000
  `),

  upsertDevice: db.prepare(`
    INSERT INTO devices (device_id, name, last_seen)
    VALUES (@device_id, @name, @last_seen)
    ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen
  `),
};

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    const deviceCount = db.prepare("SELECT COUNT(*) as c FROM devices").get().c;
    const changeCount = db.prepare("SELECT COUNT(*) as c FROM changes").get().c;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      devices: deviceCount,
      changes: changeCount,
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

// Map: device_id → ws
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
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    // ── AUTH ──────────────────────────────────────────────────────────────────
    if (msg.type === "auth") {
      if (msg.secret !== SECRET) {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        ws.close();
        return;
      }

      deviceId = msg.device_id || crypto.randomUUID();
      authenticated = true;
      clients.set(deviceId, ws);

      stmts.upsertDevice.run({
        device_id: deviceId,
        name: msg.device_name || "Unknown",
        last_seen: Date.now(),
      });

      console.log(`[✓] Auth: ${msg.device_name || deviceId}`);

      ws.send(JSON.stringify({
        type: "auth_ok",
        device_id: deviceId,
        server_time: Date.now(),
      }));
      return;
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    // ── PULL ──────────────────────────────────────────────────────────────────
    if (msg.type === "pull") {
      const since = msg.since || 0;
      const changes = stmts.getChangesSince.all(since);

      ws.send(JSON.stringify({
        type: "pull_response",
        changes,
        server_time: Date.now(),
      }));
      return;
    }

    // ── PUSH ──────────────────────────────────────────────────────────────────
    if (msg.type === "push") {
      const { changes } = msg;
      if (!Array.isArray(changes) || changes.length === 0) return;

      const saved = [];
      const pushMany = db.transaction(() => {
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
          stmts.upsertChange.run(row);
          saved.push(row);
        }
      });
      pushMany();

      // Confirm to sender
      ws.send(JSON.stringify({ type: "push_ack", count: saved.length }));

      // Broadcast to all other devices
      if (saved.length > 0) {
        broadcast({ type: "changes", changes: saved }, deviceId);
        console.log(`[→] ${deviceId} pushed ${saved.length} changes → broadcast`);
      }
      return;
    }

    // ── PING ─────────────────────────────────────────────────────────────────
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      return;
    }
  });

  ws.on("close", () => {
    if (deviceId) {
      clients.delete(deviceId);
      console.log(`[-] Disconnected: ${deviceId}`);
    }
  });

  ws.on("error", (err) => {
    console.error(`[!] WS Error (${deviceId}):`, err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`✅ MedLab Sync Server running on port ${PORT}`);
  console.log(`🔑 Secret: ${SECRET}`);
});
