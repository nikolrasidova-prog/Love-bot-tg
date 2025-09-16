require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; // числовой Telegram ID администратора
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error('Ошибка: задайте переменные окружения BOT_TOKEN и ADMIN_ID');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const DATA_DIR = __dirname;
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');

// Загрузка анкет
let profiles = [];
try {
  profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
} catch (e) {
  console.error('Не удалось прочитать profiles.json — убедитесь, что файл есть и валиден.');
  profiles = [];
}

// Подписчики для рассылок (хранится в файле)
function loadSubscribers() {
  try {
    return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8')) || [];
  } catch (e) {
    return [];
  }
}

function saveSubscribers(list) {
  try {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('Ошибка записи subscribers.json', e);
  }
}

let subscribers = loadSubscribers();

// Формат сообщения анкеты
function formatProfile(profile) {
  return `🔹 <b>${profile.name}, ${profile.age} лет</b>\n\n${profile.bio}`;
}

function profileKeyboard(index) {
  const p = profiles[index];
  const buttons = [
    [
      Markup.button.callback('Начать общение 💬', `start_${index}`),
      Markup.button.url('Партнёрская ссылка 🔗', p.partner_link)
    ],
    [
      Markup.button.callback('◀️ Назад', `nav_${(index - 1 + profiles.length) % profiles.length}`),
      Markup.button.callback('Вперёд ▶️', `nav_${(index + 1) % profiles.length}`)
    ],
    [
      Markup.button.callback('Подписаться на рассылку ✉️', 'subscribe')
    ]
  ];
  return Markup.inlineKeyboard(buttons);
}

// /start — приветствие и кнопка показа анкет
bot.start((ctx) => {
  const welcome = `Привет, ${ctx.from.first_name || ''}! Я бот-анкета.\nНажми кнопку — покажу анкеты.`;
  return ctx.reply(welcome, Markup.inlineKeyboard([Markup.button.callback('Показать анкеты', 'nav_0')]));
});

// Навигация по анкетам
bot.action(/nav_(\d+)/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  if (!profiles[idx]) return ctx.answerCbQuery('Анкета не найдена.');
  try {
    await ctx.editMessageText(formatProfile(profiles[idx]), {
      parse_mode: 'HTML',
      reply_markup: profileKeyboard(idx).reply_markup
    });
  } catch (e) {
    // если editing не получилось (например, старое сообщение), просто отправим новое
    await ctx.reply(formatProfile(profiles[idx]), { parse_mode: 'HTML', ...profileKeyboard(idx) });
  }
});

// Нажатие "Начать общение" — отправляет уведомление администратору
bot.action(/start_(\d+)/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  const p = profiles[idx];
  if (!p) return ctx.answerCbQuery('Анкета не найдена.');

  await ctx.answerCbQuery('Запрос отправлен администратору.');
  const user = ctx.from;

  const adminMessage = `Пользователь: <b>${user.first_name || ''} ${user.last_name || ''}</b> (@${user.username || '---'})\nID: <code>${user.id}</code>\nХочет начать общение с анкетой: <b>${p.name}, ${p.age} лет</b>\nПартнёрская ссылка: ${p.partner_link}`;

  try {
    await bot.telegram.sendMessage(ADMIN_ID, adminMessage, { parse_mode: 'HTML' });
    await ctx.reply('Спасибо! Администратор увидит запрос и свяжется с вами.');
  } catch (e) {
    console.error('Ошибка отправки администратору:', e);
    await ctx.reply('Произошла ошибка при отправке запроса. Попробуйте позже.');
  }
});

// Подписка на рассылку
bot.action('subscribe', (ctx) => {
  const id = ctx.from.id;
  if (!subscribers.includes(id)) {
    subscribers.push(id);
    saveSubscribers(subscribers);
    return ctx.answerCbQuery('Вы подписаны на рассылку.');
  }
  return ctx.answerCbQuery('Вы уже подписаны.');
});

// Admin-only: отправить простую текстовую рассылку всем подписчикам
bot.command('broadcast', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply('Доступ запрещён.');
  const text = (ctx.message.text || '').replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Использование: /broadcast ТЕКСТ_РАССЫЛКИ');

  let sent = 0;
  for (const chatId of subscribers) {
    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      sent++;
    } catch (e) {
      console.error('Ошибка при отправке рассылки пользователю', chatId, e);
    }
  }
  return ctx.reply(`Рассылка отправлена: ${sent} из ${subscribers.length} подписчиков.`);
});

// Admin-only: отправить конкретную анкету всем подписчикам
bot.command('send_profile', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply('Доступ запрещён.');
  const parts = (ctx.message.text || '').split(' ');
  const idx = Number(parts[1]);
  if (Number.isNaN(idx) || !profiles[idx]) return ctx.reply('Использование: /send_profile ID_анкеты (например /send_profile 0)');

  const text = formatProfile(profiles[idx]);
  let sent = 0;
  for (const chatId of subscribers) {
    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: profileKeyboard(idx).reply_markup });
      sent++;
    } catch (e) {
      console.error('Ошибка при отправке профиля пользователю', chatId, e);
    }
  }
  return ctx.reply(`Анкета #${idx} отправлена: ${sent} из ${subscribers.length} подписчиков.`);
});

// Admin-only: вывести список анкет
bot.command('list_profiles', (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply('Доступ запрещён.');
  const list = profiles.map((p, i) => `${i}: ${p.name}, ${p.age} лет`).join('\n');
  return ctx.reply(list || 'Анкет нет.');
});

// Express для health check (Render ожидает веб-процесс)
const app = express();
app.get('/', (req, res) => res.send('OK — Telegram dating bot is running'));
app.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

// Запуск бота (long polling)
bot.launch().then(() => console.log('Bot started')).catch((e) => console.error(e));

// Грейсфул-стоп
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
