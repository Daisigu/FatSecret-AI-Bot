# fatsecret-voice-bot

Телеграм-бот: голосовое сообщение → Gemini (распознавание речи + парсинг в структуру)
→ поиск продукта в FatSecret → запись в дневник питания.

## Как это работает

```
Голосовое (.ogg) ──▶ Gemini (interactions.create, аудио на вход)
                          │  response_format: JSON-схема
                          ▼
              [{food_query_en, food_name_ru, grams}, ...]
                          │
                          ▼
        FatSecret foods.search  (топ-5 кандидатов на каждый продукт)
                          │
                          ▼
        Gemini снова: выбирает лучший food_id среди кандидатов
                          │
                          ▼
        FatSecret food.get.v4  → находим порцию с metric_serving_unit == "g"
                          │        number_of_units = grams / metric_serving_amount
                          ▼
        FatSecret food_entry.create  → запись в дневник (meal определяется
                                        по текущему часу: завтрак/обед/ужин)
```

Один запрос в Gemini делает распознавание речи и разбор одновременно — отдельного
STT-сервиса не нужно, Gemini понимает аудио напрямую (в т.ч. `audio/ogg` — ровно
то, что присылает Telegram для голосовых).

## Почему два похода к FatSecret на каждый продукт

- `food_entry.create` требует **user-level** доступ (3-legged OAuth 1.0a) — это
  единственный способ писать в чужой (твой) дневник. Публичный OAuth 2.0
  client-credentials для этого не подходит.
- Порции (`serving_id`) у каждого продукта свои, и чтобы перевести граммы
  в `number_of_units`, нужно сначала получить список порций через `food.get`.

## Установка

Нужен Node.js **24.12+** (type stripping стабилен; у тебя достаточно 24.17, Node 26 Current тоже подходит). Переменные из `.env` подхватываются через `--env-file`. TypeScript запускается нативно (`node file.ts`), без tsx.

```bash
npm install
cp .env.example .env
```

Заполни `.env`:

1. **TELEGRAM_BOT_TOKEN** — получи у [@BotFather](https://t.me/BotFather).
2. **TELEGRAM_ALLOWED_USER_IDS** — твой числовой Telegram ID (узнать можно у
   [@userinfobot](https://t.me/userinfobot)). Бот отвечает "Доступ запрещён"
   всем остальным.
3. **GEMINI_API_KEY** — ключ из [Google AI Studio](https://aistudio.google.com/apikey).
4. **FATSECRET_CONSUMER_KEY / FATSECRET_CONSUMER_SECRET** — из твоего приложения
   на [platform.fatsecret.com](https://platform.fatsecret.com).

### Разовая авторизация FatSecret (3-legged OAuth)

Диарийные методы FatSecret требуют, чтобы ты один раз залогинился и разрешил
приложению доступ к своему аккаунту:

```bash
npm run fatsecret:auth
```

Скрипт покажет ссылку → открой её в браузере → залогинься на fatsecret.com →
скопируй показанный PIN обратно в терминал. В конце скрипт выведет
`FATSECRET_ACCESS_TOKEN` и `FATSECRET_ACCESS_TOKEN_SECRET` — впиши их в `.env`.
Токен не истекает, пока ты его не отзовёшь в настройках аккаунта FatSecret.

> **Про домен `authentication.fatsecret.com`**: старые примеры в интернете
> (и первая версия этого скрипта) используют `www.fatsecret.com/oauth/*`.
> Сейчас этот хост стоит за Cloudflare managed challenge и блокирует любые
> не-браузерные запросы (`cf-mitigated: challenge`) — это подтверждённая,
> открытая проблема на стороне FatSecret. Актуальная документация вместо
> этого использует `authentication.fatsecret.com`, который Cloudflare не
> закрывает — именно этот хост и используется в скрипте.

### Запуск

```bash
npm run dev      # разработка: node --watch --env-file=.env src/index.ts
npm start        # прод: тот же runtime, без сборки
npm run typecheck
```

## Ограничения и что можно улучшить

- **IP whitelisting для OAuth 2.0**: если захочешь параллельно использовать
  OAuth 2.0 для публичного поиска (без токена пользователя), FatSecret требует
  занести IP сервера в белый список в личном кабинете. Текущая реализация
  этого не требует, т.к. везде используется OAuth 1.0a с уже готовым
  пользовательским токеном.
- **Оценка веса "на глаз"**: если сказать "съел яблоко" без веса, Gemini
  оценит граммы по средним значениям — это грубая оценка, не медицинская
  точность.
- **Неоднозначные продукты**: если FatSecret не находит уверенного совпадения,
  бот сообщает об этом вместо того, чтобы записать наугад — можно расширить
  под переспрос ("это правда сырой рис, а не варёный?") через followup-сообщение.
- **Модели Gemini/имена версий** в `.env.example` могут устареть — проверь
  актуальный список на https://ai.google.dev/gemini-api/docs/models, если
  бот начнёт получать ошибку "model not found".
- Один и тот же токен FatSecret означает, что бот пишет в **один** дневник —
  это ожидаемо для личного трекера, но не годится, если позже захочешь
  многопользовательский бот (тогда каждому пользователю нужен свой access
  token/secret, полученный через тот же `fatsecret:auth`-флоу).
