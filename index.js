// index.js — Бэкенд для Telegram Mini App
const express = require('express');
const cors = require('cors');

const app = express();

// Разрешаем CORS для фронтенда и Telegram
app.use(cors());
app.use(express.json());

// Простая "база данных" в памяти
let data = {
  message: "Бэкенд запущен!",
  timestamp: new Date().toISOString(),
  updates: [],
  users: {}
};

// Проверка состояния сервера (для фронтенда)
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Получение данных (для бота)
app.get('/api/data', (req, res) => {
  res.json(data);
});

// Приём данных из Mini App
app.post('/webapp-data', async (req, res) => {
  try {
    const { initData, payload, queryId } = req.body;

    console.log('Получено /webapp-data:', { type: payload.type, userId: payload.userData?.id });

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
      receivedAt: new Date().toISOString()
    });

    // Обновляем метку времени
    data.timestamp = new Date().toISOString();

    // Ответ
    res.json({ ok: true, message: 'Данные получены' });

  } catch (err) {
    console.error('Ошибка в /webapp-data:', err);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
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
    </ul>
    <p>Используется для Telegram Mini App.</p>
  `);
});

// Порт и хост (обязательно для Render)
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Сервер запущен на http://${HOST}:${PORT}`);
  console.log(`Backend URL: https://server-iyp2.onrender.com`);
});