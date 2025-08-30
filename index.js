// Простой бэкенд-посредник для Telegram Mini App
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

// Простая "база данных" для хранения данных от Mini App
let miniAppData = {
  pendingData: [],
  processedData: [],
  lastUpdate: null
};

// Хранилище данных от бота
let botData = {
  messages: [],
  requests: [],
  errors: [],
  reviews: [],
  support_requests: [],
  chat_messages: []
};

// Функция для добавления данных от Mini App
function addMiniAppData(payload, queryId = null) {
  const dataEntry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    payload: payload,
    queryId: queryId,
    processed: false
  };
  
  miniAppData.pendingData.push(dataEntry);
  miniAppData.lastUpdate = new Date().toISOString();
  
  console.log(`📝 Данные добавлены в очередь: ${dataEntry.id}`);
  return dataEntry.id;
}

// Функция ответа на WebApp Query
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

// Основной endpoint для приема данных из Mini App
app.post('/webapp-data', async (req, res) => {
  try {
    const { payload, queryId } = req.body;
    
    console.log('📨 Получены данные из Mini App:', {
      type: payload.type,
      userId: payload.userData?.id,
      queryId: queryId
    });

    // Добавляем данные в очередь для обработки ботом
    const dataId = addMiniAppData(payload, queryId);

    // Отвечаем на WebApp Query если есть
    let answeredQuery = false;
    if (queryId) {
      const result = {
        type: 'article',
        id: 'success',
        title: '✅ Данные получены',
        input_message_content: {
          message_text: 'Данные успешно получены!',
          parse_mode: 'HTML'
        }
      };
      
      answeredQuery = await answerWebAppQuery(queryId, result);
    }

    // Отправляем ответ
    res.json({
      success: true,
      dataId: dataId,
      answeredQuery,
      message: 'Данные добавлены в очередь для обработки'
    });

  } catch (error) {
    console.error('❌ Ошибка обработки данных:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для бота - получение новых данных
app.get('/api/bot/pending', (req, res) => {
  try {
    // Возвращаем все необработанные данные
    const pendingData = miniAppData.pendingData.filter(item => !item.processed);
    
    res.json({
      success: true,
      data: pendingData,
      count: pendingData.length,
      lastUpdate: miniAppData.lastUpdate
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения данных для бота:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для бота - отметка данных как обработанных
app.post('/api/bot/process', (req, res) => {
  try {
    const { dataIds } = req.body;
    
    if (!Array.isArray(dataIds)) {
      return res.status(400).json({
        success: false,
        error: 'dataIds должен быть массивом'
      });
    }
    
    let processedCount = 0;
    
    dataIds.forEach(id => {
      const dataIndex = miniAppData.pendingData.findIndex(item => item.id === id);
      if (dataIndex !== -1) {
        const dataItem = miniAppData.pendingData[dataIndex];
        dataItem.processed = true;
        
        // Перемещаем в обработанные
        miniAppData.processedData.push(dataItem);
        miniAppData.pendingData.splice(dataIndex, 1);
        
        processedCount++;
      }
    });
    
    res.json({
      success: true,
      processedCount,
      message: `Обработано ${processedCount} записей`
    });
    
  } catch (error) {
    console.error('❌ Ошибка отметки данных как обработанных:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Хранилище данных от бота (в памяти)
let botDataCache = {
  messages: [],
  requests: [],
  errors: [],
  reviews: [],
  support_requests: [],
  chat_messages: [],
  chat_orders: [],
  average_rating: null
};

// Система адаптивной синхронизации
let activeUsers = new Map(); // Активные пользователи
let userDataCache = new Map(); // Кэш данных пользователей

// Функция очистки неактивных пользователей
function cleanupInactiveUsers() {
  const cutoff = Date.now() - 15 * 60 * 1000; // 15 минут
  const inactiveUsers = [];
  
  for (const [userId, userData] of activeUsers.entries()) {
    if (userData.lastSeen < cutoff) {
      inactiveUsers.push(userId);
    }
  }
  
  inactiveUsers.forEach(userId => {
    activeUsers.delete(userId);
    userDataCache.delete(userId);
    console.log(`👤 Пользователь ${userId} удален из активных (неактивен 15+ минут)`);
  });
  
  if (inactiveUsers.length > 0) {
    console.log(`🧹 Очищено ${inactiveUsers.length} неактивных пользователей`);
  }
}

// Запускаем очистку каждые 5 минут
setInterval(cleanupInactiveUsers, 5 * 60 * 1000);

// Endpoint для получения данных от бота
app.post('/api/bot/data', (req, res) => {
  try {
    const { type, data } = req.body;
    
    if (!type || !data) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствуют обязательные поля: type, data'
      });
    }
    
    // Добавляем данные в кэш
    if (botDataCache[type] !== undefined) {
      if (type === 'average_rating') {
        // Для средней оценки заменяем значение
        botDataCache[type] = data;
        console.log(`📥 Получена средняя оценка от бота: ${data.average_rating}/5 (${data.total_reviews} отзывов)`);
      } else if (type === 'reviews' || type === 'requests' || type === 'chat_messages' || type === 'chat_orders') {
        // Для отзывов, заказов, сообщений чата и заказов чата заменяем весь массив
        botDataCache[type] = data;
        console.log(`📥 Получены ${type} от бота: ${Array.isArray(data) ? data.length : 1} элементов (полная замена)`);
      } else {
        // Для остальных типов проверяем, это пакет или отдельный элемент
        if (Array.isArray(data)) {
          // Это пакет данных - заменяем весь массив
          botDataCache[type] = data;
          console.log(`📥 Получен пакет данных от бота: ${type} - ${data.length} элементов (полная замена)`);
        } else {
          // Это отдельный элемент - добавляем его
          botDataCache[type].push(data);
          console.log(`📥 Получены данные от бота: ${type}`);
        }
      }
    } else {
      console.log(`⚠️ Неизвестный тип данных от бота: ${type}`);
    }
    
    res.json({
      success: true,
      message: 'Данные получены'
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения данных от бота:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для получения данных пользователя от бота
app.post('/api/bot/user-data', (req, res) => {
  try {
    const { user_id, data } = req.body;
    
    if (!user_id || !data) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствуют обязательные поля: user_id, data'
      });
    }
    
    // Обновляем данные пользователя в кэше
    userDataCache.set(user_id, {
      ...data,
      lastUpdate: Date.now()
    });
    
    // Обновляем активность пользователя
    if (activeUsers.has(user_id)) {
      activeUsers.get(user_id).lastSeen = Date.now();
    }
    
    console.log(`📥 Получены данные пользователя ${user_id}: ${data.orders_count || 0} заказов, ${data.chat_messages_count || 0} сообщений`);
    
    res.json({
      success: true,
      message: 'Данные пользователя получены'
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения данных пользователя от бота:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для регистрации активного пользователя
app.post('/api/frontend/register-user', (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствует user_id'
      });
    }
    
    // Регистрируем пользователя как активного
    activeUsers.set(user_id, {
      lastSeen: Date.now(),
      registeredAt: Date.now()
    });
    
    console.log(`👤 Пользователь ${user_id} зарегистрирован как активный`);
    
    res.json({
      success: true,
      message: 'Пользователь зарегистрирован',
      user_id: user_id
    });
    
  } catch (error) {
    console.error('❌ Ошибка регистрации пользователя:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для heartbeat (подтверждение активности)
app.post('/api/frontend/heartbeat', (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствует user_id'
      });
    }
    
    // Обновляем активность пользователя
    if (activeUsers.has(user_id)) {
      activeUsers.get(user_id).lastSeen = Date.now();
    }
    
    res.json({
      success: true,
      message: 'Heartbeat получен',
      user_id: user_id
    });
    
  } catch (error) {
    console.error('❌ Ошибка heartbeat:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для получения данных пользователя
app.get('/api/frontend/user-data/:user_id', (req, res) => {
  try {
    const { user_id } = req.params;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствует user_id'
      });
    }
    
    // Проверяем, есть ли данные пользователя в кэше
    if (userDataCache.has(user_id)) {
      const userData = userDataCache.get(user_id);
      
      // Проверяем актуальность данных (не старше 5 минут)
      const dataAge = Date.now() - userData.lastUpdate;
      if (dataAge < 5 * 60 * 1000) {
        console.log(`📤 Отправлены кэшированные данные пользователя ${user_id}`);
        return res.json({
          success: true,
          data: userData,
          fromCache: true,
          dataAge: Math.round(dataAge / 1000)
        });
      }
    }
    
    // Если данных нет или они устарели
    console.log(`📭 Данные пользователя ${user_id} не найдены или устарели`);
    res.json({
      success: false,
      error: 'Данные пользователя не найдены или устарели',
      user_id: user_id
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения данных пользователя:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для получения данных для фронтенда
// Бэкенд только передает данные, всю логику пагинации и обработки делает бот
app.get('/api/frontend/data/:type', async (req, res) => {
  try {
    const { type } = req.params;
    
    if (botDataCache[type] === undefined) {
      return res.status(400).json({
        success: false,
        error: `Неизвестный тип данных: ${type}`
      });
    }
    
    // Просто возвращаем все данные, которые есть в кэше
    // Бот сам решает, что и сколько отправлять
    res.json({
      success: true,
      data: botDataCache[type] || [],
      count: Array.isArray(botDataCache[type]) ? botDataCache[type].length : 1,
      total: Array.isArray(botDataCache[type]) ? botDataCache[type].length : 1
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения данных для фронтенда:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для получения статистики
app.get('/api/frontend/stats', async (req, res) => {
  try {
    const stats = {
      messages: botDataCache.messages.length,
      requests: botDataCache.requests.length,
      errors: botDataCache.errors.length,
      reviews: botDataCache.reviews.length,
      support_requests: botDataCache.support_requests.length,
      chat_messages: botDataCache.chat_messages.length,
      chat_orders: botDataCache.chat_orders.length,
      average_rating: botDataCache.average_rating ? botDataCache.average_rating.average_rating : 0,
      total_reviews: botDataCache.average_rating ? botDataCache.average_rating.total_reviews : 0
    };
    
    res.json({
      success: true,
      stats: stats
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения статистики для фронтенда:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для очистки кэша (используется ботом при перезапуске)
app.post('/api/bot/clear-cache', (req, res) => {
  try {
    const { type } = req.body;
    
    if (type) {
      // Очищаем конкретный тип данных
      if (botDataCache[type] !== undefined) {
        if (type === 'average_rating') {
          botDataCache[type] = null;
        } else {
          botDataCache[type] = [];
        }
        console.log(`🧹 Кэш ${type} очищен ботом`);
      }
    } else {
      // Очищаем весь кэш
      botDataCache = {
        messages: [],
        requests: [],
        errors: [],
        reviews: [],
        support_requests: [],
        chat_messages: [],
        chat_orders: [],
        average_rating: null
      };
      console.log('🧹 Весь кэш очищен ботом');
    }
    
    res.json({
      success: true,
      message: type ? `Кэш ${type} очищен` : 'Весь кэш очищен'
    });
    
  } catch (error) {
    console.error('❌ Ошибка очистки кэша:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для приема данных от бота
app.post('/api/bot/store', (req, res) => {
  try {
    const { type, data, timestamp } = req.body;
    
    if (!type || !data) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствуют обязательные поля: type, data'
      });
    }
    
    // Добавляем данные в соответствующую категорию
    const dataWithTimestamp = {
      ...data,
      timestamp: timestamp || new Date().toISOString(),
      received_at: new Date().toISOString()
    };
    
    if (botData[type]) {
      botData[type].push(dataWithTimestamp);
      console.log(`✅ Данные сохранены: ${type}, ID: ${data.id}`);
    } else {
      console.log(`⚠️ Неизвестный тип данных: ${type}`);
    }
    
    res.json({
      success: true,
      message: `Данные типа ${type} сохранены`,
      count: botData[type] ? botData[type].length : 0
    });
    
  } catch (error) {
    console.error('❌ Ошибка сохранения данных от бота:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Универсальный endpoint для любых событий
app.post('/api/event', async (req, res) => {
  try {
    const { type, data: eventData, userData, queryId } = req.body;
    
    const payload = {
      type: type,
      data: eventData,
      userData: userData
    };

    // Пересылаем в основной endpoint
    const response = await fetch(`${req.protocol}://${req.get('host')}/webapp-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload, queryId })
    });

    const result = await response.json();
    res.json(result);

  } catch (error) {
    console.error('❌ Ошибка в /api/event:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Проверка состояния сервера
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    message: 'Backend работает как посредник'
  });
});

// Главная страница
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ Backend-посредник работает!</h1>
    <p><strong>Роль:</strong> Хранилище данных между фронтендом и ботом</p>
    <p><strong>URL:</strong> <code>https://server-iyp2.onrender.com</code></p>
    <p><strong>Endpoints:</strong></p>
    <ul>
      <li><code>POST /webapp-data</code> — прием данных из Mini App</li>
      <li><code>GET /api/bot/data</code> — получение данных для бота</li>
      <li><code>POST /api/bot/process</code> — отметка данных как обработанных</li>
      <li><code>POST /api/event</code> — универсальный endpoint для событий</li>
      <li><code>GET /health</code> — проверка состояния</li>
    </ul>
    <p><strong>Функции:</strong></p>
    <ul>
      <li>📨 Принимает данные из фронтенда</li>
      <li>💾 Сохраняет их в памяти</li>
      <li>🤖 Предоставляет данные боту по запросу</li>
      <li>✅ Отвечает на WebApp Query</li>
    </ul>
    <p><strong>Статистика:</strong></p>
    <ul>
      <li>Ожидающих обработки: ${miniAppData.pendingData.length}</li>
      <li>Обработанных: ${miniAppData.processedData.length}</li>
      <li>Последнее обновление: ${miniAppData.lastUpdate || 'Нет данных'}</li>
    </ul>
  `);
});

// Порт и хост для Render
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log('🚀 Backend-хранилище запущено!');
  console.log(`📍 URL: https://server-iyp2.onrender.com`);
  console.log(`🤖 Bot Token: ${BOT_TOKEN ? '✅ Настроен' : '❌ Не настроен'}`);
  console.log(`👤 Admin ID: ${ADMIN_ID}`);
  console.log(`📡 Режим: Хранилище данных для бота`);
  console.log(`📊 Endpoints: /api/bot/data, /api/bot/process`);
});