// server.js
const express = require('express');
const cors = require('cors');

const app = express();

// Разрешаем CORS, чтобы фронтенд (GitHub Pages) мог делать запросы
app.use(cors());
app.use(express.json());

// Простая "база данных" в памяти (для примера)
let data = {
  message: "Привет от бэкенда!",
  timestamp: new Date().toISOString(),
  updates: []
};

// Маршрут: получить данные
app.get('/api/data', (req, res) => {
  res.json(data);
});

// Маршрут: обновить данные (например, с фронтенда)
app.post('/api/update', (req, res) => {
  const { message } = req.body;
  if (message) {
    data.updates.push({
      message,
      time: new Date().toISOString()
    });
    data.message = message;
    data.timestamp = new Date().toISOString();
    return res.status(201).json({ success: true, data: data });
  }
  res.status(400).json({ error: "Поле 'message' обязательно" });
});

// Главная страница (проверка, что сервер жив)
app.get('/', (req, res) => {
  res.send(`
    <h1>Backend API работает! 🚀</h1>
    <p>API: <a href="/api/data">/api/data</a></p>
  `);
});

// Порт: обязательно через process.env.PORT для Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});