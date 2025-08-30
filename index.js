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

// Система мгновенных обновлений (SSE)
let sseClients = new Map(); // SSE соединения по user_id

// Функция отправки мгновенных обновлений
function sendRealTimeUpdate(userId, updateType, data) {
  const client = sseClients.get(userId);
  if (client) {
    try {
      const updateData = {
        type: updateType,
        data: data,
        timestamp: Date.now()
      };
      
      client.write(`data: ${JSON.stringify(updateData)}\n\n`);
      console.log(`⚡ Мгновенное обновление отправлено пользователю ${userId}: ${updateType}`);
      return true;
    } catch (error) {
      console.error(`❌ Ошибка отправки обновления пользователю ${userId}:`, error);
      sseClients.delete(userId);
      return false;
    }
  }
  return false;
}

// SSE endpoint для мгновенных обновлений
app.get('/api/frontend/events/:user_id', (req, res) => {
  const userId = req.params.user_id;
  
  // Настройка SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Добавляем клиента
  sseClients.set(userId, res);
  console.log(`📡 SSE подключение для пользователя ${userId}`);

  // Отправляем приветственное сообщение
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    message: 'Мгновенные обновления подключены',
    timestamp: Date.now()
  })}\n\n`);

  // Обработка закрытия соединения
  req.on('close', () => {
    sseClients.delete(userId);
    console.log(`📡 SSE отключение для пользователя ${userId}`);
  });

  req.on('error', (error) => {
    console.error(`❌ Ошибка SSE для пользователя ${userId}:`, error);
    sseClients.delete(userId);
  });
});

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
    sseClients.delete(userId); // Закрываем SSE соединения
    console.log(`👤 Пользователь ${userId} удален из активных (неактивен 15+ минут)`);
  });
  
  if (inactiveUsers.length > 0) {
    console.log(`🧹 Очищено ${inactiveUsers.length} неактивных пользователей`);
  }
}

// Функция очистки старых данных в кэше
function cleanupOldData() {
  const maxItemsPerType = 1000; // Максимум 1000 элементов на тип данных
  const cutoffTime = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 дней
  
  Object.keys(botDataCache).forEach(type => {
    if (Array.isArray(botDataCache[type])) {
      const originalLength = botDataCache[type].length;
      
      // Фильтруем старые данные
      botDataCache[type] = botDataCache[type].filter(item => {
        const itemTime = new Date(item.timestamp || item.received_at || 0).getTime();
        return itemTime > cutoffTime;
      });
      
      // Ограничиваем количество элементов
      if (botDataCache[type].length > maxItemsPerType) {
        botDataCache[type] = botDataCache[type].slice(-maxItemsPerType);
      }
      
      const removedCount = originalLength - botDataCache[type].length;
      if (removedCount > 0) {
        console.log(`🧹 Очищено ${removedCount} старых элементов из ${type}`);
      }
    }
  });
}

// Функция для удаления дубликатов в кэше
function removeDuplicates() {
  Object.keys(botDataCache).forEach(type => {
    if (Array.isArray(botDataCache[type])) {
      const originalLength = botDataCache[type].length;
      
      // Создаем Map для удаления дубликатов по ID
      const uniqueMap = new Map();
      botDataCache[type].forEach(item => {
        if (item.id !== undefined) {
          // Если элемент с таким ID уже есть, берем более новый
          if (uniqueMap.has(item.id)) {
            const existingItem = uniqueMap.get(item.id);
            const existingTime = new Date(existingItem.timestamp || existingItem.received_at || 0).getTime();
            const newTime = new Date(item.timestamp || item.received_at || 0).getTime();
            
            if (newTime > existingTime) {
              uniqueMap.set(item.id, item);
            }
          } else {
            uniqueMap.set(item.id, item);
          }
        } else {
          // Для элементов без ID добавляем их в конец
          uniqueMap.set(`no_id_${Date.now()}_${Math.random()}`, item);
        }
      });
      
      botDataCache[type] = Array.from(uniqueMap.values());
      
      const removedCount = originalLength - botDataCache[type].length;
      if (removedCount > 0) {
        console.log(`🧹 Удалено ${removedCount} дубликатов из ${type}`);
      }
    }
  });
}

// Функция для получения статистики кэша
function getCacheStats() {
  const stats = {};
  Object.keys(botDataCache).forEach(type => {
    if (Array.isArray(botDataCache[type])) {
      stats[type] = {
        count: botDataCache[type].length,
        hasDuplicates: false
      };
      
      // Проверяем дубликаты
      const ids = botDataCache[type].map(item => item.id).filter(id => id !== undefined);
      const uniqueIds = new Set(ids);
      if (ids.length !== uniqueIds.size) {
        stats[type].hasDuplicates = true;
        stats[type].duplicateCount = ids.length - uniqueIds.size;
      }
    } else {
      stats[type] = { count: 1, type: typeof botDataCache[type] };
    }
  });
  return stats;
}

// Запускаем очистку каждые 5 минут
setInterval(cleanupInactiveUsers, 5 * 60 * 1000);
// Запускаем очистку старых данных каждые 30 минут
setInterval(cleanupOldData, 30 * 60 * 1000);
// Запускаем удаление дубликатов каждые 10 минут
setInterval(removeDuplicates, 10 * 60 * 1000);

// Endpoint для проверки статистики кэша
app.get('/api/admin/cache-stats', (req, res) => {
  try {
    const stats = getCacheStats();
    const activeUsersCount = activeUsers.size;
    const userDataCount = userDataCache.size;
    const sseConnectionsCount = sseClients.size;
    
    res.json({
      success: true,
      cache_stats: stats,
      active_users: activeUsersCount,
      user_data_cache: userDataCount,
      sse_connections: sseConnectionsCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Ошибка получения статистики кэша:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для принудительной очистки дубликатов
app.post('/api/admin/remove-duplicates', (req, res) => {
  try {
    const beforeStats = getCacheStats();
    removeDuplicates();
    const afterStats = getCacheStats();
    
    const removedCounts = {};
    Object.keys(beforeStats).forEach(type => {
      if (beforeStats[type].count && afterStats[type].count) {
        const removed = beforeStats[type].count - afterStats[type].count;
        if (removed > 0) {
          removedCounts[type] = removed;
        }
      }
    });
    
    res.json({
      success: true,
      message: 'Дубликаты удалены',
      removed_counts: removedCounts,
      before_stats: beforeStats,
      after_stats: afterStats
    });
  } catch (error) {
    console.error('❌ Ошибка удаления дубликатов:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
        // Для отзывов, заказов, сообщений чата и заказов чата ОБЪЕДИНЯЕМ данные
        if (Array.isArray(data)) {
          if (Array.isArray(botDataCache[type])) {
            // Создаем Map для быстрого поиска существующих элементов
            const existingMap = new Map();
            botDataCache[type].forEach(item => {
              if (item.id !== undefined) {
                existingMap.set(item.id, item);
              }
            });
            
            // Фильтруем новые элементы
            const newItems = [];
            const duplicateIds = [];
            
            data.forEach(item => {
              if (item.id !== undefined) {
                if (existingMap.has(item.id)) {
                  duplicateIds.push(item.id);
                  // Обновляем существующий элемент, если данные изменились
                  const existingItem = existingMap.get(item.id);
                  if (JSON.stringify(existingItem) !== JSON.stringify(item)) {
                    existingMap.set(item.id, item);
                    console.log(`🔄 Обновлен элемент ${type} с ID ${item.id}`);
                  }
                } else {
                  newItems.push(item);
                }
              } else {
                // Если у элемента нет ID, добавляем его
                newItems.push(item);
              }
            });
            
            // Обновляем кэш с новыми и обновленными элементами
            botDataCache[type] = Array.from(existingMap.values());
            
            if (newItems.length > 0) {
              botDataCache[type] = [...botDataCache[type], ...newItems];
              console.log(`📥 Объединены ${type} от бота: добавлено ${newItems.length} новых элементов из ${data.length}`);
            }
            
            if (duplicateIds.length > 0) {
              console.log(`🔄 Найдено ${duplicateIds.length} дубликатов в ${type}: ${duplicateIds.slice(0, 5).join(', ')}${duplicateIds.length > 5 ? '...' : ''}`);
            }
            
            console.log(`📊 Итого в кэше ${type}: ${botDataCache[type].length} элементов`);
          } else {
            // Если кэш пустой, просто копируем данные
            botDataCache[type] = [...data];
            console.log(`📥 Инициализированы ${type} от бота: ${data.length} элементов`);
          }
        } else {
          // Если это не массив, заменяем
          botDataCache[type] = data;
          console.log(`📥 Заменены ${type} от бота: ${typeof data}`);
        }
      } else {
        // Для остальных типов проверяем, это пакет или отдельный элемент
        if (Array.isArray(data)) {
          // Это пакет данных - объединяем с существующими
          if (Array.isArray(botDataCache[type])) {
            const existingMap = new Map();
            botDataCache[type].forEach(item => {
              if (item.id !== undefined) {
                existingMap.set(item.id, item);
              }
            });
            
            const newItems = [];
            data.forEach(item => {
              if (item.id !== undefined) {
                if (existingMap.has(item.id)) {
                  // Обновляем существующий элемент
                  existingMap.set(item.id, item);
                } else {
                  newItems.push(item);
                }
              } else {
                newItems.push(item);
              }
            });
            
            botDataCache[type] = Array.from(existingMap.values());
            
            if (newItems.length > 0) {
              botDataCache[type] = [...botDataCache[type], ...newItems];
              console.log(`📥 Объединен пакет данных от бота: ${type} - добавлено ${newItems.length} новых элементов из ${data.length}`);
            } else {
              console.log(`📥 Пакет данных от бота: ${type} - все ${data.length} элементов уже существуют`);
            }
          } else {
            botDataCache[type] = [...data];
            console.log(`📥 Инициализирован пакет данных от бота: ${type} - ${data.length} элементов`);
          }
        } else {
          // Это отдельный элемент - добавляем его
          if (Array.isArray(botDataCache[type])) {
            // Проверяем, нет ли уже такого элемента
            const existingIndex = botDataCache[type].findIndex(item => item.id === data.id);
            if (existingIndex === -1) {
              botDataCache[type].push(data);
              console.log(`📥 Добавлен новый элемент от бота: ${type}`);
            } else {
              // Обновляем существующий элемент
              botDataCache[type][existingIndex] = data;
              console.log(`📥 Обновлен существующий элемент от бота: ${type}, ID: ${data.id}`);
            }
          } else {
            botDataCache[type] = [data];
            console.log(`📥 Инициализирован элемент от бота: ${type}`);
          }
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
    
    // Получаем старые данные для сравнения
    const oldData = userDataCache.get(user_id);
    
    // Обновляем данные пользователя в кэше
    userDataCache.set(user_id, {
      ...data,
      lastUpdate: Date.now()
    });
    
    // Обновляем активность пользователя
    if (activeUsers.has(user_id)) {
      activeUsers.get(user_id).lastSeen = Date.now();
    }
    
    // Проверяем изменения и отправляем мгновенные обновления
    if (oldData) {
      // Проверяем новые заказы
      const oldOrdersCount = oldData.orders_count || 0;
      const newOrdersCount = data.orders_count || 0;
      if (newOrdersCount > oldOrdersCount) {
        console.log(`🆕 Обнаружено ${newOrdersCount - oldOrdersCount} новых заказов для пользователя ${user_id}`);
        sendRealTimeUpdate(user_id, 'new_orders', {
          count: newOrdersCount - oldOrdersCount,
          orders: data.orders,
          total_orders: newOrdersCount
        });
      }
      
      // Проверяем новые сообщения
      const oldMessagesCount = oldData.chat_messages_count || 0;
      const newMessagesCount = data.chat_messages_count || 0;
      if (newMessagesCount > oldMessagesCount) {
        console.log(`🆕 Обнаружено ${newMessagesCount - oldMessagesCount} новых сообщений для пользователя ${user_id}`);
        sendRealTimeUpdate(user_id, 'new_messages', {
          count: newMessagesCount - oldMessagesCount,
          messages: data.chat_messages,
          total_messages: newMessagesCount
        });
      }
      
      // Проверяем изменения статуса заказов
      if (data.orders && oldData.orders) {
        const statusChanges = [];
        data.orders.forEach(newOrder => {
          const oldOrder = oldData.orders.find(o => o.id === newOrder.id);
          if (oldOrder && oldOrder.status !== newOrder.status) {
            statusChanges.push({
              order_id: newOrder.id,
              old_status: oldOrder.status,
              new_status: newOrder.status,
              service: newOrder.service_name
            });
          }
        });
        
        if (statusChanges.length > 0) {
          console.log(`🔄 Обнаружено ${statusChanges.length} изменений статуса заказов для пользователя ${user_id}`);
          sendRealTimeUpdate(user_id, 'status_changes', {
            changes: statusChanges,
            count: statusChanges.length
          });
        }
      }
    } else {
      // Первая загрузка данных - отправляем уведомление о готовности
      console.log(`🎉 Первая загрузка данных для пользователя ${user_id}`);
      sendRealTimeUpdate(user_id, 'data_ready', {
        orders_count: data.orders_count || 0,
        messages_count: data.chat_messages_count || 0,
        message: 'Данные загружены и готовы к использованию'
      });
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
    
    // Отправляем сигнал боту для немедленной загрузки данных пользователя
    if (user_id !== 'unknown') {
      console.log(`🚀 Запрос немедленной загрузки данных для пользователя ${user_id}`);
      // Бот получит этот сигнал при следующем обращении к /api/bot/pending
    }
    
    res.json({
      success: true,
      message: 'Пользователь зарегистрирован',
      user_id: user_id,
      immediate_load_requested: user_id !== 'unknown'
    });
    
  } catch (error) {
    console.error('❌ Ошибка регистрации пользователя:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для запроса немедленной загрузки данных пользователя
app.post('/api/frontend/request-immediate-load', (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'Отсутствует user_id'
      });
    }
    
    // Регистрируем пользователя как активного если не зарегистрирован
    if (!activeUsers.has(user_id)) {
      activeUsers.set(user_id, {
        lastSeen: Date.now(),
        registeredAt: Date.now()
      });
    } else {
      activeUsers.get(user_id).lastSeen = Date.now();
    }
    
    console.log(`⚡ Запрос немедленной загрузки данных для пользователя ${user_id}`);
    
    res.json({
      success: true,
      message: 'Запрос немедленной загрузки принят',
      user_id: user_id
    });
    
  } catch (error) {
    console.error('❌ Ошибка запроса немедленной загрузки:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для получения списка активных пользователей (для бота)
app.get('/api/bot/active-users', (req, res) => {
  try {
    const activeUsersList = [];
    
    for (const [userId, userData] of activeUsers.entries()) {
      activeUsersList.push({
        user_id: userId,
        lastSeen: userData.lastSeen,
        registeredAt: userData.registeredAt,
        isActive: (Date.now() - userData.lastSeen) < 15 * 60 * 1000 // Активен если был онлайн последние 15 минут
      });
    }
    
    console.log(`📊 Запрос активных пользователей: ${activeUsersList.length} пользователей`);
    
    res.json({
      success: true,
      active_users: activeUsersList,
      count: activeUsersList.length,
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения активных пользователей:', error);
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
  console.log(`📡 Режим: Хранилище данных для бота с мгновенными обновлениями`);
  console.log(`📊 Endpoints: /api/bot/data, /api/bot/process, /api/frontend/events`);
});