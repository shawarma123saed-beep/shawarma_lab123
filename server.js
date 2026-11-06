const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// ==================== 📁 مسارات حفظ البيانات ==================== //

const dataDir = path.join(__dirname, 'data');

const menuFile = path.join(dataDir, 'menu.json');
const invoicesFile = path.join(dataDir, 'invoices.json');
const cancelledFile = path.join(dataDir, 'cancelled_orders.json');
const employeesFile = path.join(dataDir, 'employees.json');
const advancesFile = path.join(dataDir, 'advances.json');
const leavesFile = path.join(dataDir, 'leaves.json'); // 🌟 ملف الإجازات الجديد
const ratingsFile = path.join(dataDir, 'ratings.json');
const reportsFile = path.join(dataDir, 'daily_reports.json');
const kitchenOrdersFile = path.join(dataDir, 'kitchen_orders.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('📁 تم إنشاء مجلد البيانات بنجاح:', dataDir);
}

// ==================== 💱 سعر الصرف ==================== //

let currentExchangeRate = 15000.0;

const fetchExchangeRateFromServer = () => {
  https.get('https://liranews.info/api/public/v1/price/usdsypd', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  }, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        if (data.trim().startsWith('<')) {
          console.error('⚠️ الرابط أرجع HTML بدلاً من JSON');
          return;
        }

        const parsedData = JSON.parse(data);

        const liveRate = parseFloat(
          parsedData?.usdsypd?.sell ||
          parsedData?.usdsypd?.value
        );

        if (!isNaN(liveRate) && liveRate > 0) {
          currentExchangeRate = liveRate;

          console.log(
            '💱 تم تحديث سعر الصرف:',
            currentExchangeRate
          );

          io.emit('exchange_rate_updated', {
            exchangeRate: currentExchangeRate
          });
        }
      } catch (e) {
        console.error('⚠️ خطأ في تحليل سعر الصرف:', e.message);
      }
    });
  }).on('error', (err) => {
    console.error(
      '⚠️ تعذر جلب سعر الصرف، الاحتفاظ بالسعر الحالي:',
      currentExchangeRate
    );
  });
};

fetchExchangeRateFromServer();
setInterval(fetchExchangeRateFromServer, 15 * 60 * 1000);

// ==================== 📦 الطلبات النشطة ==================== //

let serverActiveOrders = [];
let kitchenOrders = [];

// ==================== 🟢 منع تكرار إشعارات الجهوزية ==================== //

const readyNotifiedOrders = new Set();

const normalizeOrderId = (id) => {
  if (id === undefined || id === null || id === '') {
    return null;
  }

  return String(id);
};

// ==================== 🟢 تهيئة الملفات ==================== //

const initializeJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      JSON.stringify([], null, 2),
      'utf8'
    );

    console.log('📄 تم إنشاء الملف:', path.basename(filePath));
  }
};

[
  menuFile,
  invoicesFile,
  cancelledFile,
  employeesFile,
  advancesFile,
  leavesFile, // 🌟 تهيئة ملف الإجازات
  ratingsFile,
  reportsFile,
  kitchenOrdersFile
].forEach(initializeJsonFile);

// ==================== 📂 قراءة وكتابة JSON ==================== //

const readJsonFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');

      if (data.trim() === '') return [];

      const parsed = JSON.parse(data);

      if (Array.isArray(parsed)) return parsed;

      if (parsed && typeof parsed === 'object') {
        return [parsed];
      }
    }
  } catch (e) {
    console.error(
      '❌ خطأ في قراءة الملف:',
      filePath,
      e.message
    );
  }

  return [];
};

const writeJsonFile = (filePath, data) => {
  const tempFile = `${filePath}.tmp`;

  try {
    if (data === undefined) {
      console.warn(
        '⚠️ محاولة كتابة بيانات undefined:',
        filePath
      );
      return false;
    }

    const jsonData = typeof data === 'string'
      ? data
      : JSON.stringify(data, null, 2);

    if (jsonData === undefined) {
      return false;
    }

    fs.writeFileSync(tempFile, jsonData, 'utf8');
    fs.renameSync(tempFile, filePath);

    return true;

  } catch (e) {
    console.error(
      '❌ خطأ في كتابة الملف:',
      filePath,
      e.message
    );

    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (_) {}

    return false;
  }
};

// ==================== 👥 معالجة قوائم الموظفين والسلف والإجازات ==================== //

const normalizeListPayload = (payload, possibleKeys = []) => {
  let target = payload;
  if (Array.isArray(payload) && payload.length === 1 && (Array.isArray(payload[0]) || (payload[0] && typeof payload[0] === 'object'))) {
    target = payload[0];
  }

  if (Array.isArray(target)) {
    return target;
  }

  if (!target || typeof target !== 'object') {
    throw new Error('البيانات المرسلة ليست قائمة أو كائناً صالحاً');
  }

  for (const key of possibleKeys) {
    if (Array.isArray(target[key])) {
      return target[key];
    }
  }

  if (Array.isArray(target.data)) {
    return target.data;
  }

  if (Array.isArray(target.list)) {
    return target.list;
  }

  throw new Error('لم يتم العثور على قائمة بيانات داخل الإرسال');
};

const validateDataList = (list, listName) => {
  if (!Array.isArray(list)) {
    throw new Error(`قائمة ${listName} غير صالحة`);
  }

  for (let i = 0; i < list.length; i++) {
    const item = list[i];

    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
      throw new Error(
        `العنصر رقم ${i + 1} في قائمة ${listName} غير صالح`
      );
    }
  }

  return true;
};

const saveDataList = (filePath, incomingList, listName) => {
  validateDataList(incomingList, listName);

  const saved = writeJsonFile(filePath, incomingList);

  if (!saved) {
    throw new Error(`فشل حفظ قائمة ${listName} على القرص`);
  }

  const savedList = readJsonFile(filePath);

  if (savedList.length !== incomingList.length) {
    throw new Error(
      `عدد عناصر ${listName} المحفوظة لا يطابق العدد المرسل`
    );
  }

  return savedList;
};

// ==================== 🍳 إدارة طلبات المطبخ ==================== //

const getKitchenOrderId = (order) => {
  if (!order || typeof order !== 'object') return null;

  const id = order.id ?? order.orderId;

  return normalizeOrderId(id);
};

const isFinalKitchenStatus = (status) => {
  const finalStatuses = [
    'ready',
    'completed',
    'delivered',
    'paid',
    'cancelled'
  ];

  return finalStatuses.includes(
    String(status || '').toLowerCase()
  );
};

const saveKitchenOrders = () => {
  const saved = writeJsonFile(kitchenOrdersFile, kitchenOrders);

  if (saved) {
    console.log(
      `💾 تم حفظ طلبات المطبخ. العدد: ${kitchenOrders.length}`
    );
  }

  return saved;
};

const upsertKitchenOrder = (orderData) => {
  if (!orderData || typeof orderData !== 'object') {
    console.warn('⚠️ طلب مطبخ غير صالح');
    return false;
  }

  const orderId = getKitchenOrderId(orderData);

  if (!orderId) {
    console.warn('⚠️ طلب المطبخ لا يحتوي على id أو orderId');
    return false;
  }

  const existingIndex = kitchenOrders.findIndex(
    (order) => getKitchenOrderId(order) === orderId
  );

  if (existingIndex !== -1) {
    kitchenOrders[existingIndex] = {
      ...kitchenOrders[existingIndex],
      ...orderData
    };
  } else {
    kitchenOrders.push(orderData);
  }

  return saveKitchenOrders();
};

const removeKitchenOrder = (orderId) => {
  if (orderId === undefined || orderId === null) {
    return false;
  }

  const normalizedId = String(orderId);

  const oldLength = kitchenOrders.length;

  kitchenOrders = kitchenOrders.filter(
    (order) => getKitchenOrderId(order) !== normalizedId
  );

  if (kitchenOrders.length !== oldLength) {
    saveKitchenOrders();

    console.log(
      `🗑️ تم حذف الطلب #${normalizedId} من المطبخ`
    );

    return true;
  }

  return false;
};

const loadKitchenOrders = () => {
  try {
    kitchenOrders = readJsonFile(kitchenOrdersFile);

    const uniqueOrders = new Map();

    kitchenOrders.forEach((order) => {
      const orderId = getKitchenOrderId(order);

      if (!orderId) return;

      if (isFinalKitchenStatus(order.status)) return;

      uniqueOrders.set(orderId, order);
    });

    kitchenOrders = Array.from(uniqueOrders.values());

    saveKitchenOrders();

    console.log(
      `🍳 تم استرجاع ${kitchenOrders.length} طلب من المطبخ`
    );

  } catch (e) {
    console.error('❌ خطأ في تحميل طلبات المطبخ:', e);
    kitchenOrders = [];
  }
};

loadKitchenOrders();

// ==================== 🔔 إرسال إشعار جهوزية موحد ==================== //

const notifyOrderReady = (orderData) => {
  if (!orderData || typeof orderData !== 'object') {
    return false;
  }

  const orderId = normalizeOrderId(
    orderData.id ?? orderData.orderId
  );

  if (!orderId) {
    console.warn('⚠️ تعذر إرسال إشعار الجهوزية: رقم الطلب مفقود');
    return false;
  }

  const activeOrder = serverActiveOrders.find(
    (order) => getKitchenOrderId(order) === orderId
  );

  const kitchenOrder = kitchenOrders.find(
    (order) => getKitchenOrderId(order) === orderId
  );

  const readyPayload = {
    ...(activeOrder || {}),
    ...(kitchenOrder || {}),
    ...orderData,
    id: orderId,
    orderId: orderId,
    status: 'ready'
  };

  // 🛵 التعديل المطلوب: إرسال الطلب لشاشة الدليفري حصراً وفقط عندما يصبح الطلب جاهزاً بالمطبخ
  if (readyPayload.isDelivery === true) {
    io.emit('driver_new_order', readyPayload);
    console.log(`🛵 تم إرسال طلب الدليفري الجاهز #${orderId} بكل تفاصيله لشاشة السائقين بنجاح`);
  }

  // 🛑 منع الإشعار والنغمة حصراً إذا كان الطلب منشأً من الكاشير ولم يأتِ عبر التطبيق
  const isFromCashier = 
    readyPayload.fromCustomerApp !== true && 
    (readyPayload.fromCashier === true || 
     readyPayload.isCashierOrder === true ||
     readyPayload.isDirectOrder === true ||
     readyPayload.orderType === 'direct' ||
     String(readyPayload.tableNumber || '').includes('كاشير') ||
     String(readyPayload.tableNumber || '').includes('طلب مباشر') ||
     String(readyPayload.tableNumber || '').includes('سفري') ||
     !activeOrder?.fromCustomerApp);

  if (isFromCashier) {
    console.log(`ℹ️ الطلب #${orderId} منشأ من الكاشير، لن يتم إرسال إشعار النغمة أبداً.`);
    return false;
  }

  if (readyNotifiedOrders.has(orderId)) {
    console.log(
      `🔁 تم منع تكرار إشعار الجهوزية للطلب #${orderId}`
    );
    return false;
  }

  readyNotifiedOrders.add(orderId);

  const activeIndex = serverActiveOrders.findIndex(
    (order) => getKitchenOrderId(order) === orderId
  );

  if (activeIndex !== -1) {
    serverActiveOrders[activeIndex] = {
      ...serverActiveOrders[activeIndex],
      ...readyPayload,
      status: 'ready'
    };
  }

  io.emit('order_ready_for_customer', readyPayload);

  console.log(
    `🔔 تم إرسال إشعار جهوزية الطلب #${orderId} للزبون بنجاح`
  );

  return true;
};

// ==================== 🍽️ قائمة الطعام ==================== //

const getMenuData = () => readJsonFile(menuFile);

const saveAndBroadcastMenu = (newMenu) => {
  try {
    if (!Array.isArray(newMenu)) return;

    const saved = writeJsonFile(menuFile, newMenu);

    if (!saved) {
      console.error('❌ فشل حفظ قائمة الطعام');
      return;
    }

    console.log(
      '💾 تم حفظ قائمة الطعام. العدد:',
      newMenu.length
    );

    io.emit('admin_menu_updated', newMenu);
    io.emit('initial_menu_data', newMenu);
    io.emit('menu_data', newMenu);

  } catch (e) {
    console.error('خطأ في حفظ قائمة الطعام:', e);
  }
};

// ==================== 🛠️ REST API ==================== //

app.get('/api/menu', (req, res) => {
  try {
    res.json(getMenuData());
  } catch (e) {
    res.status(500).json({
      error: 'فشل في جلب قائمة الطعام'
    });
  }
});

app.get('/api/invoices', (req, res) => {
  try {
    res.json(readJsonFile(invoicesFile));
  } catch (e) {
    res.status(500).json({
      error: 'فشل في جلب الفواتير'
    });
  }
});

app.get('/api/employees', (req, res) => {
  try {
    res.json(readJsonFile(employeesFile));
  } catch (e) {
    res.status(500).json({
      error: 'فشل في جلب الموظفين'
    });
  }
});

app.get('/api/advances', (req, res) => {
  try {
    res.json(readJsonFile(advancesFile));
  } catch (e) {
    res.status(500).json({
      error: 'فشل في جلب السلف والدفعات'
    });
  }
});

app.get('/api/leaves', (req, res) => {
  try {
    res.json(readJsonFile(leavesFile));
  } catch (e) {
    res.status(500).json({
      error: 'فشل في جلب الإجازات'
    });
  }
});

app.get('/api/exchange-rate', (req, res) => {
  try {
    res.json({
      exchangeRate: currentExchangeRate
    });
  } catch (e) {
    res.status(500).json({
      error: 'فشل في جلب سعر الصرف'
    });
  }
});

// ==================== REST API تحديث المنيو ==================== //

app.post('/api/menu', (req, res) => {
  try {
    const body = req.body;
    let currentMenu = getMenuData();

    if (Array.isArray(body)) {
      currentMenu = body;
    } else if (body && typeof body === 'object') {
      if (!body.id) {
        body.id = Date.now().toString();
      }

      const index = currentMenu.findIndex(
        (i) => i.id != null &&
          i.id.toString() === body.id.toString()
      );

      if (index !== -1) {
        currentMenu[index] = {
          ...currentMenu[index],
          ...body
        };
      } else {
        currentMenu.push(body);
      }
    }

    saveAndBroadcastMenu(currentMenu);

    res.json({
      success: true,
      menu: currentMenu
    });

  } catch (e) {
    res.status(500).json({
      error: 'فشل في تحديث قائمة الطعام'
    });
  }
});

// ==================== ⏱️ مؤقتات المطبخ ==================== //

const kitchenTimers = {};

// ==================== ⚡ SOCKET.IO ==================== //

io.on('connection', (socket) => {

  console.log('⚡ جهاز متصل جديد:', socket.id);

  // ==================== إرسال البيانات الأولية ==================== //

  socket.emit('initial_menu_data', getMenuData());
  socket.emit('menu_data', getMenuData());

  socket.emit('initial_invoices', readJsonFile(invoicesFile));
  socket.emit('initial_cancelled_orders', readJsonFile(cancelledFile));

  socket.emit('initial_employees_data', readJsonFile(employeesFile));
  socket.emit('initial_advances_data', readJsonFile(advancesFile));
  socket.emit('initial_leaves_data', readJsonFile(leavesFile)); // 🌟 إرسال الإجازات الأولية

  socket.emit('initial_ratings_data', readJsonFile(ratingsFile));
  socket.emit('initial_reports_data', readJsonFile(reportsFile));

  socket.emit('exchange_rate_updated', {
    exchangeRate: currentExchangeRate
  });

  socket.emit('initial_kitchen_orders', kitchenOrders);

  // ==================== 📦 طلبات الكاشير ==================== //

  socket.on('get_active_orders', () => {
    socket.emit('initial_orders', serverActiveOrders);

    console.log(
      `📦 تم إرسال ${serverActiveOrders.length} طلب نشط للكاشير`
    );
  });

  // 🛵 جلب طلبات الدليفري الجاهزة فقط للسائق عند الاتصال
  socket.on('get_driver_orders', () => {
    const readyDeliveryOrders = serverActiveOrders.filter(
      order => order.isDelivery === true && String(order.status || '').toLowerCase() === 'ready'
    );
    socket.emit('initial_orders', readyDeliveryOrders);
    console.log(`🛵 تم إرسال ${readyDeliveryOrders.length} طلب دليفري جاهز للسائق`);
  });

  socket.on('clear_server_active_orders', () => {
    serverActiveOrders = [];

    console.log('🧹 تم تفريغ طلبات الكاشير');

    io.emit('initial_orders', []);
  });

  // ==================== 🍳 طلبات المطبخ ==================== //

  socket.on('get_kitchen_orders', () => {
    socket.emit('initial_kitchen_orders', kitchenOrders);

    console.log(
      `📥 تم إرسال ${kitchenOrders.length} طلب للمطبخ`
    );
  });

  // ==================== 🍽️ المنيو ==================== //

  socket.on('get_menu', () => {
    const menu = getMenuData();

    socket.emit('initial_menu_data', menu);
    socket.emit('admin_menu_updated', menu);
    socket.emit('menu_data', menu);
  });

  socket.on('fetch_menu', () => {
    const menu = getMenuData();

    socket.emit('initial_menu_data', menu);
    socket.emit('admin_menu_updated', menu);
    socket.emit('menu_data', menu);
  });

  socket.on('clear_printed_invoices', () => {
    const saved = writeJsonFile(invoicesFile, []);

    if (!saved) return;

    io.emit('initial_invoices', []);

    console.log('🗑️ تم تفريغ الفواتير بعد الطباعة');
  });

  socket.on('clear_cancelled_orders', () => {
    const saved = writeJsonFile(cancelledFile, []);

    if (!saved) return;

    io.emit('initial_cancelled_orders', []);

    console.log('🗑️ تم تفريغ الطلبات الملغاة بعد الطباعة');
  });

  socket.on('admin_update_menu', (newMenuData) => {
    if (Array.isArray(newMenuData)) {
      saveAndBroadcastMenu(newMenuData);

    } else if (newMenuData && typeof newMenuData === 'object') {
      let currentMenu = getMenuData();

      if (!newMenuData.id) {
        newMenuData.id = Date.now().toString();
      }

      const index = currentMenu.findIndex(
        (i) => i.id != null &&
          i.id.toString() === newMenuData.id.toString()
      );

      if (index !== -1) {
        currentMenu[index] = {
          ...currentMenu[index],
          ...newMenuData
        };
      } else {
        currentMenu.push(newMenuData);
      }

      saveAndBroadcastMenu(currentMenu);
    }
  });

  socket.on('update_menu_item', (itemData) => {
    let currentMenu = getMenuData();

    if (itemData && itemData.id) {
      const index = currentMenu.findIndex(
        (i) => i.id != null &&
          i.id.toString() === itemData.id.toString()
      );

      if (index !== -1) {
        currentMenu[index] = {
          ...currentMenu[index],
          ...itemData
        };
      } else {
        currentMenu.push(itemData);
      }

      saveAndBroadcastMenu(currentMenu);
    }
  });

  // ========================================================= //
  // ==================== 👥 الموظفون ======================== //
  // ========================================================= //

  socket.on('update_employees_list', (empDataList, callback) => {

    console.log('');
    console.log('📨 استقبل السيرفر طلب تحديث الموظفين');
    console.log('🔌 مصدر الإرسال:', socket.id);

    try {
      const listToSave = normalizeListPayload(
        empDataList,
        ['employees', 'employeeList', 'employeesList']
      );

      console.log(
        `👥 عدد الموظفين المستلمين: ${listToSave.length}`
      );

      const savedEmployees = saveDataList(
        employeesFile,
        listToSave,
        'الموظفين'
      );

      console.log(
        `✅ تم حفظ الموظفين بنجاح في: ${employeesFile}`
      );

      console.log(
        `📊 العدد النهائي المحفوظ: ${savedEmployees.length}`
      );

      io.emit('employees_data_updated', savedEmployees);

      if (typeof callback === 'function') {
        callback({
          ok: true,
          count: savedEmployees.length,
          message: 'تم حفظ الموظفين بنجاح'
        });
      }

    } catch (e) {

      console.error('❌ فشل حفظ الموظفين:', e.message);

      if (typeof callback === 'function') {
        callback({
          ok: false,
          count: 0,
          message: e.message
        });
      }
    }
  });

  // ========================================================= //
  // ==================== 💸 السلف والدفعات ================== //
  // ========================================================= //

  socket.on('update_advances_list', (advDataList, callback) => {

    console.log('');
    console.log('📨 استقبل السيرفر طلب تحديث السلف والدفعات');
    console.log('🔌 مصدر الإرسال:', socket.id);

    try {
      const listToSave = normalizeListPayload(
        advDataList,
        ['advances', 'advanceList', 'advancesList']
      );

      console.log(
        `💸 عدد السلف والدفعات المستلمة: ${listToSave.length}`
      );

      const savedAdvances = saveDataList(
        advancesFile,
        listToSave,
        'السلف والدفعات'
      );

      console.log(
        `✅ تم حفظ السلف والدفعات بنجاح في: ${advancesFile}`
      );

      console.log(
        `📊 العدد النهائي المحفوظ: ${savedAdvances.length}`
      );

      io.emit('advances_data_updated', savedAdvances);

      if (typeof callback === 'function') {
        callback({
          ok: true,
          count: savedAdvances.length,
          message: 'تم حفظ السلف والدفعات بنجاح'
        });
      }

    } catch (e) {

      console.error('❌ فشل حفظ السلف والدفعات:', e.message);

      if (typeof callback === 'function') {
        callback({
          ok: false,
          count: 0,
          message: e.message
        });
      }
    }
  });

  // ========================================================= //
  // ==================== 🌴 الإجازات ======================== //
  // ========================================================= //

  socket.on('update_leaves_list', (leavesDataList, callback) => {

    console.log('');
    console.log('📨 استقبل السيرفر طلب تحديث الإجازات');
    console.log('🔌 مصدر الإرسال:', socket.id);

    try {
      const listToSave = normalizeListPayload(
        leavesDataList,
        ['leaves', 'leaveList', 'leavesList']
      );

      console.log(
        `🌴 عدد الإجازات المستلمة: ${listToSave.length}`
      );

      const savedLeaves = saveDataList(
        leavesFile,
        listToSave,
        'الإجازات'
      );

      console.log(
        `✅ تم حفظ الإجازات بنجاح في: ${leavesFile}`
      );

      console.log(
        `📊 العدد النهائي المحفوظ: ${savedLeaves.length}`
      );

      io.emit('leaves_data_updated', savedLeaves);

      if (typeof callback === 'function') {
        callback({
          ok: true,
          count: savedLeaves.length,
          message: 'تم حفظ الإجازات بنجاح'
        });
      }

    } catch (e) {

      console.error('❌ فشل حفظ الإجازات:', e.message);

      if (typeof callback === 'function') {
        callback({
          ok: false,
          count: 0,
          message: e.message
        });
      }
    }
  });

  // ==================== 📥 استقبال طلبات الزبائن ==================== //

  socket.on('send_order', (orderData) => {

    if (!orderData || typeof orderData !== 'object') {
      console.warn('⚠️ تم استقبال طلب غير صالح');
      return;
    }

    const orderId = normalizeOrderId(
      orderData.id ?? orderData.orderId
    );

    if (!orderId) {
      console.warn('⚠️ تم استقبال طلب دون رقم معرف');
      return;
    }

    // تحديد أن هذا الطلب قادم من تطبيق الزبون الخاص
    const normalizedOrder = {
      ...orderData,
      id: orderId,
      orderId: orderId,
      fromCustomerApp: true, // علامة واضحة تثبت أن الطلب من الزبون عبر التطبيق
      fromCashier: false
    };

    const existingIndex = serverActiveOrders.findIndex(
      (o) => getKitchenOrderId(o) === orderId
    );

    if (existingIndex === -1) {
      serverActiveOrders.push(normalizedOrder);
    } else {
      serverActiveOrders[existingIndex] = {
        ...serverActiveOrders[existingIndex],
        ...normalizedOrder
      };
    }

    io.emit('new_order_to_cashier', normalizedOrder);

    if (normalizedOrder.isDelivery) {
      console.log(
        '🛵 تم استقبال طلب دليفري وإرساله للكاشير (بانتظار تجهيز المطبخ ليصل للسائق):',
        normalizedOrder.customerName,
        '| الهاتف:',
        normalizedOrder.customerPhone,
        '| الرقم:',
        orderId
      );
      // تم إلغاء الإرسال المباشر لشاشة السائق هنا، ولن يرسل إلا عند جهوزية المطبخ عبر notifyOrderReady
    } else {
      console.log(
        '📥 تم استقبال طلب زبون وإرساله للكاشير فقط:',
        orderId
      );
    }
  });

  // ==================== 🚀 تحويل الطلب للمدير ==================== //

  socket.on('cashier_forward_order', (orderData) => {

    if (!orderData || typeof orderData !== 'object') return;

    io.emit('new_order_to_manager', orderData);

    console.log(
      '🚀 تم إرسال الطلب للمدير:',
      orderData.id || orderData.orderId
    );
  });

  // ==================== 🔄 تحديث حالة الطلب العامة ==================== //

  socket.on('update_order_status', (statusData) => {

    if (!statusData || typeof statusData !== 'object') return;

    const orderId = normalizeOrderId(
      statusData.orderId ?? statusData.id
    );

    const status = String(
      statusData.status || ''
    ).toLowerCase();

    if (!orderId) return;

    const orderIndex = serverActiveOrders.findIndex(
      (o) => getKitchenOrderId(o) === orderId
    );

    if (orderIndex !== -1) {
      serverActiveOrders[orderIndex] = {
        ...serverActiveOrders[orderIndex],
        ...statusData,
        id: orderId,
        orderId: orderId,
        status: status
      };
    }

    const normalizedStatusData = {
      ...statusData,
      id: orderId,
      orderId: orderId,
      status: status
    };

    io.emit('order_status_updated', normalizedStatusData);

    console.log(
      '🔄 تحديث حالة الطلب:',
      orderId,
      'إلى:',
      status
    );

    if (status === 'ready') {
      notifyOrderReady(normalizedStatusData);
    }

    if (isFinalKitchenStatus(status)) {

      removeKitchenOrder(orderId);

      io.emit('kitchen_order_updated', normalizedStatusData);

      if (kitchenTimers[orderId]) {
        clearTimeout(kitchenTimers[orderId]);
        delete kitchenTimers[orderId];

        console.log(
          `✅ تم إيقاف مؤقت الطلب #${orderId}`
        );
      }
    }
  });

  // ==================== 🛵 تسليم طلب الدليفري ==================== //

  socket.on('order_delivered_notification', (data) => {

    if (!data || typeof data !== 'object') return;

    const orderId = normalizeOrderId(
      data.orderId ?? data.id
    );

    if (!orderId) return;

    console.log(
      `🛵 تم تسليم طلب الدليفري #${orderId}`
    );

    serverActiveOrders = serverActiveOrders.filter(
      (o) => getKitchenOrderId(o) !== orderId
    );

    removeKitchenOrder(orderId);

    io.emit('order_delivered_notification', {
      ...data,
      orderId
    });

    io.emit('kitchen_order_updated', {
      ...data,
      id: orderId,
      orderId,
      status: 'delivered'
    });

    if (kitchenTimers[orderId]) {
      clearTimeout(kitchenTimers[orderId]);
      delete kitchenTimers[orderId];
    }
  });

  // ==================== 👨‍🍳 إرسال طلب للمطبخ ==================== //

  socket.on('send_to_kitchen', (orderData) => {

    if (!orderData || typeof orderData !== 'object') {
      console.error('❌ بيانات الطلب المرسل للمطبخ غير صالحة');
      return;
    }

    const orderId = getKitchenOrderId(orderData);

    if (!orderId) {
      console.error(
        '❌ طلب المطبخ لا يحتوي على id أو orderId'
      );
      return;
    }

    // إذا تم إرسال الطلب من الكاشير مباشرة (وليس عبر سكت طلب الزبون)
    const normalizedOrder = {
      ...orderData,
      id: orderId,
      orderId: orderId,
      fromCustomerApp: orderData.fromCustomerApp === true, // الحفاظ على حالتها إن وجدت أو اعتبارها من الكاشير
    };

    const activeIndex = serverActiveOrders.findIndex(
      (order) => getKitchenOrderId(order) === orderId
    );

    if (activeIndex !== -1) {
      serverActiveOrders[activeIndex] = {
        ...serverActiveOrders[activeIndex],
        ...normalizedOrder
      };
    } else {
      serverActiveOrders.push(normalizedOrder);
    }

    const saved = upsertKitchenOrder(normalizedOrder);

    if (!saved) {
      console.error(
        `❌ لم يتم تأكيد حفظ الطلب #${orderId}`
      );
    }

    io.emit('new_kitchen_order', normalizedOrder);

    console.log(
      `👨‍🍳 تم إرسال الطلب #${orderId} للمطبخ بعد موافقة الكاشير`
    );

    if (kitchenTimers[orderId]) {
      clearTimeout(kitchenTimers[orderId]);
    }

    kitchenTimers[orderId] = setTimeout(() => {

      console.log(
        `⚠️ الطلب #${orderId} تأخر أكثر من 15 دقيقة`
      );

      io.emit('admin_order_delayed_warning', {
        orderId: orderId,
        tableNumber: normalizedOrder.tableNumber || '1',
        items: normalizedOrder.items || [],
        createdAt: normalizedOrder.createdAt || new Date().toISOString(),
        delayedMinutes: 15
      });

    }, 15 * 60 * 1000);
  });

  // ==================== 🔄 تحديث طلب المطبخ ==================== //

  socket.on('update_kitchen_order', (orderData) => {

    if (!orderData || typeof orderData !== 'object') {
      console.warn('⚠️ تحديث طلب مطبخ غير صالح');
      return;
    }

    const orderId = getKitchenOrderId(orderData);

    const status = String(
      orderData.status || ''
    ).toLowerCase();

    if (!orderId) {
      console.warn(
        '⚠️ تحديث المطبخ لا يحتوي على id أو orderId'
      );
      return;
    }

    const normalizedOrder = {
      ...orderData,
      id: orderId,
      orderId: orderId,
      status: status
    };

    if (isFinalKitchenStatus(status)) {
      removeKitchenOrder(orderId);
    } else {
      upsertKitchenOrder(normalizedOrder);
    }

    const activeIndex = serverActiveOrders.findIndex(
      (order) => getKitchenOrderId(order) === orderId
    );

    if (activeIndex !== -1) {
      serverActiveOrders[activeIndex] = {
        ...serverActiveOrders[activeIndex],
        ...normalizedOrder
      };
    }

    io.emit('kitchen_order_updated', normalizedOrder);

    console.log(
      '🔄 تحديث طلب المطبخ:',
      orderId,
      'الحالة:',
      status
    );

    if (status === 'ready') {
      notifyOrderReady(normalizedOrder);
    }

    if (isFinalKitchenStatus(status)) {

      if (kitchenTimers[orderId]) {

        clearTimeout(kitchenTimers[orderId]);
        delete kitchenTimers[orderId];

        console.log(
          `✅ تم إيقاف مؤقت الطلب #${orderId}`
        );
      }
    }
  });

  // ==================== 📄 حفظ الفواتير ==================== //

  socket.on('save_printed_invoice', (invoiceData) => {

    if (!invoiceData || typeof invoiceData !== 'object') {
      return;
    }

    let invoices = readJsonFile(invoicesFile);

    const orderId = invoiceData.orderId || invoiceData.id;

    const exists = invoices.some(
      (inv) => (inv.orderId || inv.id) === orderId
    );

    if (!exists) {

      invoices.push(invoiceData);

      const saved = writeJsonFile(invoicesFile, invoices);

      if (!saved) {
        console.error('❌ فشل حفظ الفاتورة');
        return;
      }
    }

    io.emit('admin_new_invoice_saved', invoiceData);

    console.log(
      '📄 تم حفظ الفاتورة للطلب:',
      orderId
    );
  });

  // ==================== 👥 جلب الموظفين والسلف والإجازات ==================== //

  socket.on('get_employees', () => {

    const emps = readJsonFile(employeesFile);
    const advs = readJsonFile(advancesFile);
    const levs = readJsonFile(leavesFile);

    socket.emit('initial_employees_data', emps);
    socket.emit('initial_advances_data', advs);
    socket.emit('initial_leaves_data', levs);

    console.log(
      `📥 طلب بيانات الموظفين والسلف والإجازات من الجهاز: ${socket.id}`
    );

    console.log(
      `👥 تم إرسال ${emps.length} موظف | 💸 ${advs.length} سلفة | 🌴 ${levs.length} إجازة`
    );
  });

  // ==================== 📊 التقرير اليومي ==================== //

  socket.on('close_register_and_send_report', (reportData) => {

    if (!reportData || typeof reportData !== 'object') return;

    let reports = readJsonFile(reportsFile);

    reports.push(reportData);

    const saved = writeJsonFile(reportsFile, reports);

    if (!saved) {
      console.error('❌ فشل حفظ التقرير اليومي');
      return;
    }

    io.emit('admin_daily_report_received', reportData);

    console.log(
      '📊 تم حفظ التقرير المالي اليومي'
    );
  });

  // ==================== 🚨 إلغاء الطلب من الكاشير ==================== //

  socket.on('cancel_order_to_admin', (cancelData) => {

    if (!cancelData || typeof cancelData !== 'object') return;

    const orderId = normalizeOrderId(
      cancelData.orderId ?? cancelData.id
    );

    if (!orderId) return;

    let invoices = readJsonFile(invoicesFile);

    invoices = invoices.filter(
      (inv) => normalizeOrderId(inv.orderId || inv.id) !== orderId
    );

    writeJsonFile(invoicesFile, invoices);

    let cancelledOrders = readJsonFile(cancelledFile);

    cancelledOrders.push(cancelData);

    writeJsonFile(cancelledFile, cancelledOrders);

    serverActiveOrders = serverActiveOrders.filter(
      (o) => getKitchenOrderId(o) !== orderId
    );

    removeKitchenOrder(orderId);

    if (kitchenTimers[orderId]) {

      clearTimeout(kitchenTimers[orderId]);
      delete kitchenTimers[orderId];
    }

    const kitchenCancellationUpdate = {
      ...cancelData,
      id: orderId,
      orderId: orderId,
      status: 'cancelled'
    };

    io.emit('kitchen_order_updated', kitchenCancellationUpdate);

    io.emit('admin_order_cancelled', cancelData);

    io.emit('update_admin_invoices', {
      orderId: orderId,
      status: 'DELETED_AND_CANCELLED'
    });

    io.emit('order_cancelled_by_cashier', cancelData);

    console.log(
      `🚨 تم إلغاء الطلب #${orderId}. السبب: ${cancelData.cancellationReason || 'بدون سبب'}`
    );
  });

  // ==================== 🚫 إلغاء الطلب للزبون ==================== //

  socket.on('cancel_order_to_customer', (cancelData) => {

    if (!cancelData || typeof cancelData !== 'object') return;

    io.emit('order_cancelled_by_cashier', cancelData);

    console.log(
      '🚨 تم إرسال إشعار إلغاء الطلب للزبون'
    );
  });

  // ==================== ⭐ تقييمات العملاء ==================== //

  socket.on('submit_rating', (ratingData) => {

    if (!ratingData || typeof ratingData !== 'object') return;

    let ratings = readJsonFile(ratingsFile);

    ratings.push(ratingData);

    const saved = writeJsonFile(ratingsFile, ratings);

    if (!saved) {
      console.error('❌ فشل حفظ التقييم');
      return;
    }

    io.emit('admin_new_rating', ratingData);

    console.log(
      '⭐ تم حفظ التقييم وإرساله للمدير'
    );
  });

  // ==================== 🔴 قطع الاتصال ==================== //

  socket.on('disconnect', () => {

    console.log(
      '❌ انقطع اتصال الجهاز:',
      socket.id
    );
  });

});

// ==================== 🚀 تشغيل السيرفر ==================== //

const PORT = 3000;

server.listen(PORT, () => {

  console.log(
    `🚀 السيرفر يعمل بنجاح على المنفذ ${PORT}`
  );

  console.log(
    `🍳 ملف طلبات المطبخ: ${kitchenOrdersFile}`
  );

  console.log(
    `📦 عدد طلبات المطبخ المسترجعة: ${kitchenOrders.length}`
  );

  console.log(
    `👥 عدد الموظفين المحفوظين: ${readJsonFile(employeesFile).length}`
  );

  console.log(
    `💸 عدد السلف والدفعات المحفوظة: ${readJsonFile(advancesFile).length}`
  );

  console.log(
    `🌴 عدد الإجازات المحفوظة: ${readJsonFile(leavesFile).length}`
  );

  console.log(
    '✅ ملفات الموظفين والسلف والإجازات لن يتم تصفيرها عند إعادة تشغيل السيرفر'
  );

  console.log('');
  console.log('================ مزامنة البيانات والرواتب ================');
  console.log('📁 ملف الموظفين:', employeesFile);
  console.log('📁 ملف السلف والدفعات:', advancesFile);
  console.log('📁 ملف الإجازات:', leavesFile);
  console.log('=========================================================');
});