// index.js — Бэкенд для Telegram Mini App
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Разрешаем CORS для фронтенда и Telegram
app.use(cors());
app.use(express.json());

// Конфигурация бота
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

// Проверяем обязательные переменные окружения
if (!BOT_TOKEN) {
  console.error('❌ Ошибка: BOT_TOKEN не задан в переменных окружения');
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error('❌ Ошибка: ADMIN_ID не задан в переменных окружения');
  process.exit(1);
}

// Функция для отправки сообщения в бот
async function sendToBot(chatId, message, parseMode = 'HTML') {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: parseMode
      })
    });
    
    const result = await response.json();
    if (result.ok) {
      console.log(`✅ Сообщение отправлено в чат ${chatId}`);
      return true;
    } else {
      console.error(`❌ Ошибка отправки в чат ${chatId}:`, result);
      return false;
    }
  } catch (error) {
    console.error(`❌ Ошибка отправки в чат ${chatId}:`, error);
    return false;
  }
}

// Функция для ответа на WebApp Query
async function answerWebAppQuery(queryId, result) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerWebAppQuery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        web_app_query_id: queryId,
        result: result
      })
    });
    
    const responseData = await response.json();
    if (responseData.ok) {
      console.log(`✅ WebApp Query ${queryId} отвечен`);
      return true;
    } else {
      console.error(`❌ Ошибка ответа на WebApp Query ${queryId}:`, responseData);
      return false;
    }
  } catch (error) {
    console.error(`❌ Ошибка ответа на WebApp Query ${queryId}:`, error);
    return false;
  }
}

// Централизованная функция обработки всех данных
async function processWebAppData(payload, queryId = null) {
  try {
    console.log('🔄 Обработка данных из Mini App:', { 
      type: payload.type, 
      userId: payload.userData?.id,
      queryId: queryId 
    });

    // Сохраняем данные пользователя
    if (payload.userData) {
      const userId = payload.userData.id;
      data.users[userId] = {
        ...payload.userData,
        lastInteraction: new Date().toISOString(),
        lastPayloadType: payload.type
      };
    }

    // Добавляем в историю
    data.updates.push({
      type: payload.type,
      payload: payload,
      receivedAt: new Date().toISOString(),
      queryId: queryId
    });

    // Обновляем метку времени
    data.timestamp = new Date().toISOString();

    // Определяем, нужно ли отправлять уведомление админу
    const shouldNotifyAdmin = isImportantEvent(payload.type);
    
    let sentToAdmin = false;
    if (shouldNotifyAdmin) {
      // Формируем сообщение для администратора только для важных событий
      const adminMessage = formatAdminMessage(payload);
      
      // Отправляем уведомление администратору
      sentToAdmin = await sendToBot(ADMIN_ID, adminMessage);
    } else {
      // Для обычных событий просто логируем
      console.log(`📊 Событие ${payload.type} залогировано (не отправлено админу)`);
    }

    // Если есть queryId, отвечаем на WebApp Query
    let answeredQuery = false;
    if (queryId) {
      const result = {
        type: 'article',
        id: 'success',
        title: '✅ Данные получены',
        input_message_content: {
          message_text: 'Данные успешно отправлены!',
          parse_mode: 'HTML'
        }
      };
      
      answeredQuery = await answerWebAppQuery(queryId, result);
    }

    // Логируем результат
    console.log('✅ Обработка завершена:', {
      type: payload.type,
      userId: payload.userData?.id,
      sentToAdmin,
      answeredQuery,
      isImportant: shouldNotifyAdmin
    });

    return {
      success: true,
      sentToAdmin,
      answeredQuery,
      logged: true,
      message: 'Данные обработаны успешно'
    };

  } catch (error) {
    console.error('❌ Ошибка обработки данных:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Функция определения важных событий
function isImportantEvent(eventType) {
  const importantEvents = [
    'contact_form',      // Контактные формы
    'service_interest',  // Интерес к услугам
    'order_submit',      // Заказы
    'payment_request',   // Запросы на оплату
    'error_report',      // Критические ошибки
    'support_request'    // Запросы поддержки
  ];
  
  return importantEvents.includes(eventType);
}

// Функция форматирования сообщения для администратора
function formatAdminMessage(payload) {
  const baseMessage = `📱 **Важное событие из Mini App**\n\n` +
    `👤 **Пользователь:** ${payload.userData?.firstName || 'Неизвестно'} ${payload.userData?.lastName || ''}\n` +
    `🆔 **ID:** ${payload.userData?.id || '—'}\n` +
    `📝 **Тип:** ${payload.type || 'unknown'}\n` +
    `⏰ **Время:** ${new Date().toLocaleString('ru-RU')}\n\n`;

  let detailsMessage = '';
  
  // Добавляем детали в зависимости от типа данных
  switch (payload.type) {
    case 'contact_form':
      detailsMessage = `📋 **Контактная форма:**\n` +
        `Имя: ${payload.formData?.name || '—'}\n` +
        `Сообщение: ${payload.formData?.message || '—'}`;
      break;
    case 'service_interest':
      detailsMessage = `🎯 **Интерес к услуге:**\n` +
        `Услуга: ${payload.service || '—'}`;
      break;
    case 'order_submit':
      detailsMessage = `🛒 **Новый заказ:**\n` +
        `Товар: ${payload.product || '—'}\n` +
        `Сумма: ${payload.amount || '—'}`;
      break;
    case 'payment_request':
      detailsMessage = `💳 **Запрос на оплату:**\n` +
        `Сумма: ${payload.amount || '—'}\n` +
        `Метод: ${payload.paymentMethod || '—'}`;
      break;
    case 'error_report':
      detailsMessage = `⚠️ **Критическая ошибка:**\n` +
        `Ошибка: ${payload.error || '—'}\n` +
        `Страница: ${payload.page || '—'}\n` +
        `Стек: ${payload.stack || '—'}`;
      break;
    case 'support_request':
      detailsMessage = `🆘 **Запрос поддержки:**\n` +
        `Тема: ${payload.topic || '—'}\n` +
        `Описание: ${payload.description || '—'}`;
      break;
    default:
      detailsMessage = `📄 **Данные:**\n${JSON.stringify(payload, null, 2)}`;
  }

  return baseMessage + detailsMessage;
}

// Простая "база данных" в памяти
let data = {
  message: "Бэкенд запущен!",
  timestamp: new Date().toISOString(),
  updates: [],
  users: {},
  analytics: {
    totalRequests: 0,
    requestsByType: {},
    requestsByUser: {},
    errors: []
  }
};

// Проверка состояния сервера (для фронтенда)
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    stats: {
      totalRequests: data.analytics.totalRequests,
      totalUsers: Object.keys(data.users).length,
      totalUpdates: data.updates.length
    }
  });
});

// Получение данных (для бота)
app.get('/api/data', (req, res) => {
  res.json(data);
});

// Получение статистики
app.get('/api/stats', (req, res) => {
  const stats = {
    totalRequests: data.analytics.totalRequests,
    requestsByType: data.analytics.requestsByType,
    requestsByUser: data.analytics.requestsByUser,
    totalUsers: Object.keys(data.users).length,
    totalUpdates: data.updates.length,
    lastUpdate: data.timestamp
  };
  res.json(stats);
});

// Приём данных из Mini App (централизованный endpoint)
app.post('/webapp-data', async (req, res) => {
  try {
    const { initData, payload, queryId } = req.body;

    // Увеличиваем счетчик запросов
    data.analytics.totalRequests++;
    
    // Увеличиваем счетчик по типу
    const type = payload.type || 'unknown';
    data.analytics.requestsByType[type] = (data.analytics.requestsByType[type] || 0) + 1;
    
    // Увеличиваем счетчик по пользователю
    if (payload.userData?.id) {
      const userId = payload.userData.id;
      data.analytics.requestsByUser[userId] = (data.analytics.requestsByUser[userId] || 0) + 1;
    }

    // Обрабатываем данные
    const result = await processWebAppData(payload, queryId);

    // Ответ
    res.json(result);

  } catch (err) {
    console.error('Ошибка в /webapp-data:', err);
    
    // Логируем ошибку
    data.analytics.errors.push({
      timestamp: new Date().toISOString(),
      error: err.message,
      stack: err.stack
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'Internal Server Error',
      message: err.message 
    });
  }
});

// Новый endpoint для всех типов данных
app.post('/api/event', async (req, res) => {
  try {
    const { type, data: eventData, userData, queryId } = req.body;
    
    const payload = {
      type: type,
      ...eventData,
      userData: userData,
      timestamp: new Date().toISOString()
    };

    const result = await processWebAppData(payload, queryId);
    res.json(result);

  } catch (err) {
    console.error('Ошибка в /api/event:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Internal Server Error' 
    });
  }
});

// Endpoint для получения данных пользователя
app.get('/api/user/:userId', (req, res) => {
  const userId = req.params.userId;
  const userData = data.users[userId];
  
  if (userData) {
    res.json({
      success: true,
      user: userData,
      stats: {
        totalRequests: data.analytics.requestsByUser[userId] || 0,
        lastActivity: userData.lastInteraction
      }
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'User not found'
    });
  }
});

// Endpoint для очистки данных
app.post('/api/clear', (req, res) => {
  try {
    // Очищаем все данные
    data = {
      message: "Данные очищены",
      timestamp: new Date().toISOString(),
      updates: [],
      users: {},
      analytics: {
        totalRequests: 0,
        requestsByType: {},
        requestsByUser: {},
        errors: []
      }
    };
    
    console.log('🗑️ Данные очищены администратором');
    
    res.json({
      success: true,
      message: 'Данные очищены успешно',
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('Ошибка при очистке данных:', err);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error'
    });
  }
});

// Главная страница
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ Backend API работает!</h1>
    <p>URL: <code>https://server-iyp2.onrender.com</code></p>
    <p>Маршруты:</p>
    <ul>
      <li><a href="/health">/health</a> — проверка</li>
      <li><a href="/api/data">/api/data</a> — данные</li>
      <li><a href="/api/stats">/api/stats</a> — статистика</li>
    </ul>
    <p>Используется для Telegram Mini App.</p>
    <p><strong>Статистика:</strong></p>
    <ul>
      <li>Всего запросов: ${data.analytics.totalRequests}</li>
      <li>Пользователей: ${Object.keys(data.users).length}</li>
      <li>Обновлений: ${data.updates.length}</li>
    </ul>
  `);
});

// Порт и хост (обязательно для Render)
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Сервер запущен на http://${HOST}:${PORT}`);
  console.log(`Backend URL: https://server-iyp2.onrender.com`);
  console.log(`Bot Token: ${BOT_TOKEN ? '✅ Настроен' : '❌ Не настроен'}`);
  console.log(`Admin ID: ${ADMIN_ID}`);
  console.log(`📊 Централизованная система обработки данных активирована`);
});