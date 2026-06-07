// ═══════════════════════════════════════════════════════════════════════════
//  MedLab Pro — Sync Client
//  أضف هذا الكود في MedLab Pro بعد تهيئة IDB مباشرة
// ═══════════════════════════════════════════════════════════════════════════

const MedLabSync = (() => {

  // ─── إعدادات ─────────────────────────────────────────────────────────────
  const CONFIG = {
    serverUrl: "wss://YOUR-APP.up.railway.app",   // ← غيّر هذا بعد النشر
    secret:    "medlab-secret-change-me",          // ← نفس السر في السيرفر
    deviceId:  localStorage.getItem("sync_device_id") || (() => {
      const id = crypto.randomUUID();
      localStorage.setItem("sync_device_id", id);
      return id;
    })(),
    deviceName: localStorage.getItem("sync_device_name") || "Device",
    reconnectDelay: 3000,
    // IDB stores اللي تتزامن
    stores: [
      "patients", "requests", "results", "invoices",
      "inventory", "tests", "settings"
    ],
  };

  // ─── الحالة ───────────────────────────────────────────────────────────────
  let ws = null;
  let connected = false;
  let reconnectTimer = null;
  let lastSyncTime = parseInt(localStorage.getItem("last_sync_time") || "0");

  // ─── IDB Helper ──────────────────────────────────────────────────────────
  // استخدم نفس db instance الموجود في MedLab Pro
  // هذه الدوال تفترض أن عندك idb أو dbPromise معرّف مسبقاً
  async function idbGet(store, id) {
    return new Promise((resolve, reject) => {
      const tx = window.db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, record) {
    return new Promise((resolve, reject) => {
      const tx = window.db.transaction(store, "readwrite");
      const req = tx.objectStore(store).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetAll(store) {
    return new Promise((resolve, reject) => {
      const tx = window.db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Pending Queue (للعمل Offline) ───────────────────────────────────────
  let pendingChanges = JSON.parse(localStorage.getItem("pending_changes") || "[]");

  function savePending() {
    localStorage.setItem("pending_changes", JSON.stringify(pendingChanges));
  }

  // استدعِ هذه الدالة في كل مكان تعدّل فيه IDB
  function trackChange(store, record, deleted = false) {
    const change = {
      id:        `${store}:${record.id || record.patientId || Date.now()}:${Date.now()}`,
      store,
      record_id: String(record.id || record.patientId || ""),
      data:      JSON.stringify(record),
      deleted:   deleted ? 1 : 0,
      timestamp: Date.now(),
    };

    pendingChanges.push(change);
    savePending();

    if (connected) flushPending();
  }

  async function flushPending() {
    if (!connected || pendingChanges.length === 0) return;
    const batch = [...pendingChanges];
    pendingChanges = [];
    savePending();

    send({ type: "push", changes: batch });
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────
  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    console.log("[Sync] Connecting...");
    ws = new WebSocket(CONFIG.serverUrl);

    ws.onopen = () => {
      console.log("[Sync] Connected ✓");
      send({
        type:        "auth",
        secret:      CONFIG.secret,
        device_id:   CONFIG.deviceId,
        device_name: CONFIG.deviceName,
      });
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case "auth_ok":
          connected = true;
          updateStatus("متصل ✓", "green");
          // اجلب التغييرات الجديدة أولاً
          send({ type: "pull", since: lastSyncTime });
          break;

        case "auth_failed":
          console.error("[Sync] Auth failed");
          updateStatus("خطأ في المصادقة", "red");
          ws.close();
          break;

        case "pull_response":
          await applyChanges(msg.changes);
          lastSyncTime = msg.server_time || Date.now();
          localStorage.setItem("last_sync_time", String(lastSyncTime));
          // أرسل التغييرات المعلّقة
          await flushPending();
          break;

        case "changes":
          // تغييرات من جهاز آخر
          await applyChanges(msg.changes);
          break;

        case "push_ack":
          console.log(`[Sync] Server confirmed ${msg.count} changes`);
          lastSyncTime = Date.now();
          localStorage.setItem("last_sync_time", String(lastSyncTime));
          break;

        case "pong":
          break;
      }
    };

    ws.onclose = () => {
      connected = false;
      updateStatus("غير متصل", "red");
      console.log("[Sync] Disconnected, reconnecting...");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, CONFIG.reconnectDelay);
    };

    ws.onerror = (err) => {
      console.error("[Sync] WS Error:", err.message || err);
    };
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ─── تطبيق التغييرات الواردة ──────────────────────────────────────────────
  async function applyChanges(changes) {
    if (!changes || changes.length === 0) return;

    for (const c of changes) {
      try {
        if (!CONFIG.stores.includes(c.store)) continue;

        if (c.deleted) {
          // حذف - اختياري: يمكنك تعليم السجل كمحذوف بدل الحذف الفعلي
          const existing = await idbGet(c.store, c.record_id);
          if (existing) {
            existing._deleted = true;
            existing._timestamp = c.timestamp;
            await idbPut(c.store, existing);
          }
        } else {
          const incoming = JSON.parse(c.data);
          const existing = await idbGet(c.store, c.record_id);

          // LWW: الأحدث يفوز
          if (!existing || (incoming._timestamp || c.timestamp) >= (existing._timestamp || 0)) {
            if (!incoming._timestamp) incoming._timestamp = c.timestamp;
            await idbPut(c.store, incoming);
          }
        }
      } catch (err) {
        console.error("[Sync] Error applying change:", c.store, err);
      }
    }

    // أخبر UI بالتحديث
    window.dispatchEvent(new CustomEvent("sync:updated", { detail: changes }));
  }

  // ─── مؤشر الاتصال في UI ───────────────────────────────────────────────────
  function updateStatus(text, color) {
    const el = document.getElementById("sync-status");
    if (el) {
      el.textContent = text;
      el.style.color = color === "green" ? "#22c55e" : "#ef4444";
    }
  }

  // ─── Ping كل 30 ثانية للإبقاء على الاتصال ────────────────────────────────
  setInterval(() => {
    if (connected) send({ type: "ping" });
  }, 30000);

  // ─── API العام ────────────────────────────────────────────────────────────
  return {
    init: connect,
    trackChange,
    flushPending,
    isConnected: () => connected,
    setDeviceName: (name) => {
      CONFIG.deviceName = name;
      localStorage.setItem("sync_device_name", name);
    },
  };
})();

// ─── تشغيل تلقائي بعد تحميل الصفحة ──────────────────────────────────────────
// أضف هذا السطر بعد تهيئة IDB:
// MedLabSync.init();

// ─── مثال: استخدام trackChange عند حفظ مريض ─────────────────────────────────
// بعد حفظ المريض في IDB:
// MedLabSync.trackChange("patients", patientData);

// ─── مثال: مستمع لتحديث UI عند وصول بيانات جديدة ────────────────────────────
// window.addEventListener("sync:updated", (e) => {
//   console.log("تحديثات جديدة:", e.detail.length);
//   // أعد تحميل القائمة المعروضة
// });
