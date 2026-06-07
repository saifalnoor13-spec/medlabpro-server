# MedLab Pro — Sync Server
## دليل النشر الكامل

---

## 📁 الملفات

```
medlab-sync-server/
├── server.js        ← السيرفر الرئيسي
├── package.json     ← المكتبات
├── railway.toml     ← إعدادات Railway
└── sync-client.js  ← الكود الذي تضيفه لـ MedLab Pro
```

---

## 🚀 خطوات النشر على Railway

### 1. إنشاء حساب
- اذهب إلى https://railway.app
- سجّل بحساب GitHub (مجاني)

### 2. رفع الكود على GitHub
```bash
# في جهازك، افتح Terminal أو CMD داخل مجلد medlab-sync-server
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/medlab-sync-server.git
git push -u origin main
```

### 3. نشر على Railway
1. من Railway dashboard اضغط **New Project**
2. اختر **Deploy from GitHub repo**
3. اختر الـ repo اللي رفعته
4. Railway يكتشف Node.js تلقائياً وينشر

### 4. إضافة المتغيرات (مهم جداً)
في Railway → مشروعك → **Variables** أضف:
```
SYNC_SECRET = كلمة_سر_قوية_هنا
PORT        = 3000
```
> ⚠️ غيّر SYNC_SECRET لكلمة سر قوية وسرية

### 5. الحصول على الرابط
بعد النشر، Railway يعطيك رابط مثل:
```
https://medlab-sync-server-production-xxxx.up.railway.app
```

---

## 🔌 دمج في MedLab Pro

### الخطوة 1: أضف مؤشر الاتصال في HTML
```html
<!-- في الـ header أو toolbar -->
<span id="sync-status" style="font-size:12px; margin-right:8px;">⟳ جاري الاتصال...</span>
```

### الخطوة 2: أضف sync-client.js
انسخ كل محتوى sync-client.js وألصقه في MedLab Pro قبل إغلاق `</body>`

### الخطوة 3: غيّر إعدادات الاتصال
في sync-client.js ابحث عن:
```javascript
serverUrl: "wss://YOUR-APP.up.railway.app",
secret:    "medlab-secret-change-me",
```
وغيّرها إلى رابطك وكلمة السر.

### الخطوة 4: شغّل Sync بعد تهيئة IDB
```javascript
// بعد ما يكتمل فتح IDB (في onsuccess)
MedLabSync.init();
```

### الخطوة 5: تتبع التغييرات
في كل مكان تحفظ فيه بيانات في IDB، أضف:
```javascript
// مثال: بعد حفظ مريض
transaction.oncomplete = () => {
  MedLabSync.trackChange("patients", patientData);
};

// مثال: بعد حفظ نتيجة
transaction.oncomplete = () => {
  MedLabSync.trackChange("results", resultData);
};

// مثال: حذف
MedLabSync.trackChange("patients", { id: patientId }, true);
```

### الخطوة 6: استمع لتحديثات واجهة المستخدم
```javascript
window.addEventListener("sync:updated", (e) => {
  // أعد تحميل البيانات المعروضة
  loadPatients();      // مثلاً
  loadRequests();
});
```

---

## ✅ اختبار السيرفر

افتح المتصفح وادخل:
```
https://YOUR-APP.up.railway.app/health
```
يجب أن ترى:
```json
{
  "status": "ok",
  "devices": 0,
  "changes": 0,
  "uptime": 10,
  "time": 1234567890
}
```

---

## 🔒 الأمان

- السيرفر يطلب `SYNC_SECRET` عند كل اتصال
- كل جهاز يحصل على `device_id` فريد محفوظ في localStorage
- البيانات مشفرة عبر WSS (HTTPS)

---

## 📊 كيف يعمل النظام

```
جهاز A (يحفظ مريض)
    ↓ trackChange("patients", data)
    ↓ push → السيرفر
    ↓ السيرفر يحفظ في SQLite
    ↓ يبث لكل الأجهزة الأخرى
جهاز B, C, D ← applyChanges() → IDB محدّث
```

**LWW (Last Write Wins):**  
إذا عدّل جهازان نفس السجل في نفس الوقت، التعديل الأحدث (بالـ timestamp) يفوز.

---

## 💰 التكلفة على Railway

- **Hobby Plan**: مجاني لأول $5 شهرياً
- مشروع بحجم MedLab Pro لن يتجاوز $1-2 شهرياً
