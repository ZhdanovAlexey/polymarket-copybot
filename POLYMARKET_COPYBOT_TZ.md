# Техническое задание v2.0: PolyMarket CopyBot PRO

> **Версия:** 2.0 Enhanced — без зависимости от Bullpen CLI  
> **Дата:** 12 апреля 2026  
> **Среда разработки:** Claude Code  
> **Подход:** Поэтапная разработка с тестированием после каждого шага

---

## 1. Описание проекта

Автономный бот для копитрейдинга на PolyMarket с профессиональным веб-дашбордом.  
Бот автоматически находит лучших трейдеров, отслеживает их сделки в реальном времени и зеркально копирует на кошелёк пользователя.

**Ключевые улучшения v2.0:**
- Полная настройка и авторизация кошелька через веб-интерфейс (без терминала)
- WebSocket вместо polling для отслеживания сделок (опционально, с fallback на polling)
- Система скоринга трейдеров (не только P&L)
- Управление рисками: стоп-лосс, max drawdown, лимиты на рынок
- Live-лента сделок с push-обновлениями (Server-Sent Events)
- Детальная аналитика: P&L-график, разбивка по трейдерам, по рынкам
- Telegram-уведомления
- Dry Run Mode (симуляция без реальных сделок)

---

## 2. Архитектура API PolyMarket

### 2.1. Data API (публичный, без auth)
- **URL:** `https://data-api.polymarket.com`
- **Для бота:** лидерборд, активность трейдеров, позиции, история сделок

**Эндпоинты:**
```
GET /leaderboard?period=7d&orderBy=pnl&limit=50
GET /activity?user={addr}&type=TRADE&start={ts}&sortBy=TIMESTAMP&sortDirection=ASC
GET /positions?user={addr}
GET /trades?user={addr}&limit=50
GET /value?user={addr}
GET /closed-positions?user={addr}
```

### 2.2. Gamma API (публичный, без auth)
- **URL:** `https://gamma-api.polymarket.com`
- **Для бота:** метаданные рынков (tokenID, tickSize, negRisk)

```
GET /markets?slug={slug}
GET /markets?condition_id={conditionId}
GET /events?slug={eventSlug}
```

### 2.3. CLOB API (торговля, требует auth)
- **URL:** `https://clob.polymarket.com`
- **L1 Auth:** подпись кошельком → деривация API-ключей
- **L2 Auth:** HMAC (key + secret + passphrase) → торговые операции

```
POST /auth/derive-api-key       → получить credentials
GET  /midpoint?token_id={id}    → текущая цена
GET  /book?token_id={id}        → ордербук
POST /order                     → разместить ордер
DELETE /order/{id}               → отменить ордер
GET  /balance                    → баланс USDC
```

### 2.4. WebSocket (реальное время)
- **CLOB WS:** `wss://ws-subscriptions-clob.polymarket.com/ws/`
  - `market` channel — обновления ордербука и цен (public)
  - `user` channel — статус наших ордеров (auth required)
- **RTDS (Real-Time Data Stream):** `wss://ws-live-data.polymarket.com`
  - `activity` topic, type `trades` — live лента сделок всей платформы

### 2.5. Смарт-контракты Polygon
```
CTF Exchange:       0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
Neg Risk Exchange:  0xC5d563A36AE78145C45a50134d48A1215220f80a
CTF (Conditional Tokens): 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
USDC.e:             0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
Neg Risk Adapter:   0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296
```

---

## 3. Технологический стек

| Компонент | Технология |
|-----------|------------|
| Язык | TypeScript |
| Рантайм | Node.js ≥ 18 |
| Торговый SDK | `@polymarket/clob-client` + `ethers` v5 |
| WebSocket | `@polymarket/real-time-data-client` или нативный `ws` |
| Сервер | Express.js |
| Real-time UI | Server-Sent Events (SSE) |
| Frontend | Vanilla HTML/CSS/JS (без React — проще, быстрее) |
| Графики | Chart.js (CDN) |
| Логирование | `pino` (fast, structured) |
| Telegram | `node-telegram-bot-api` |
| Хранение | SQLite через `better-sqlite3` (надёжнее JSON) |
| Конфигурация | dotenv + валидация через zod |

---

## 4. Структура проекта

```
polymarket-copybot/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
│
├── src/
│   ├── index.ts                    # Entry point
│   ├── config.ts                   # Загрузка и валидация .env (zod)
│   │
│   ├── core/
│   │   ├── bot.ts                  # Главный класс Bot (start/stop/lifecycle)
│   │   ├── leaderboard.ts          # Модуль скоринга и отбора трейдеров
│   │   ├── tracker.ts              # Отслеживание сделок (polling + WS)
│   │   ├── executor.ts             # Исполнение BUY/SELL ордеров
│   │   ├── redeemer.ts             # Auto-redeem выигрышных позиций
│   │   ├── risk-manager.ts         # Стоп-лоссы, лимиты, drawdown
│   │   └── portfolio.ts            # Отслеживание своего портфеля
│   │
│   ├── api/
│   │   ├── data-api.ts             # Обёртка Data API
│   │   ├── gamma-api.ts            # Обёртка Gamma API
│   │   ├── clob-client.ts          # Инициализация ClobClient
│   │   └── websocket.ts            # WebSocket подписки
│   │
│   ├── dashboard/
│   │   ├── server.ts               # Express + SSE
│   │   ├── routes/
│   │   │   ├── api.ts              # REST API для дашборда
│   │   │   ├── auth.ts             # Авторизация кошелька
│   │   │   └── sse.ts              # Server-Sent Events stream
│   │   └── public/
│   │       ├── index.html          # SPA - Single Page App
│   │       ├── css/
│   │       │   └── styles.css      # Стили (dark theme)
│   │       └── js/
│   │           ├── app.js          # Главный модуль
│   │           ├── dashboard.js    # Виджеты и метрики
│   │           ├── charts.js       # Графики Chart.js
│   │           ├── trades.js       # Журнал сделок
│   │           ├── traders.js      # Карточки трейдеров
│   │           ├── settings.js     # Настройки / Setup wizard
│   │           └── sse-client.js   # SSE подключение
│   │
│   ├── db/
│   │   ├── database.ts             # Инициализация SQLite
│   │   ├── migrations.ts           # Создание таблиц
│   │   └── queries.ts              # SQL-запросы
│   │
│   ├── notifications/
│   │   └── telegram.ts             # Telegram-бот уведомления
│   │
│   └── utils/
│       ├── logger.ts               # Pino logger
│       ├── retry.ts                # Exponential backoff
│       └── helpers.ts              # Утилиты
│
├── data/                           # Runtime (в .gitignore)
│   ├── copybot.db                  # SQLite база
│   └── copybot.log
│
└── scripts/
    └── check-balance.ts            # Утилита проверки баланса
```

---

## 5. Веб-интерфейс — детальный дизайн

### 5.1. Setup Wizard (первый запуск)

При первом открытии дашборда пользователь видит **пошаговый мастер настройки**:

**Шаг 1: Подключение кошелька**
- Поле ввода Private Key (с маской — показывать только последние 4 символа)
- Кнопка "Connect Wallet"
- После ввода — показать: адрес кошелька, баланс USDC.e, баланс MATIC
- Индикатор: зелёный ✓ если баланс достаточный, жёлтый ⚠ если нет MATIC

**Шаг 2: Активация торговли**
- Кнопка "Derive API Keys" — вызывает createOrDeriveApiKey()
- Статус: "API Keys derived ✓"
- Кнопка "Approve USDC" — отправляет approve-транзакцию на CTF Exchange
- Статус: "USDC Approved ✓ (tx: 0x...)"
- Кнопка "Approve CTF Tokens" — setApprovalForAll для outcome tokens
- Статус: "CTF Approved ✓"

**Шаг 3: Настройки бота**
- Размер ставки: slider/input ($1 — $100, default $5)
- Количество трейдеров: slider (5 — 20, default 10)
- Период лидерборда: dropdown (1d / 7d / 30d)
- Интервал polling: dropdown (15s / 30s / 60s)
- Max Slippage: input (1% — 10%, default 5%)
- Daily Loss Limit: input ($0 = off, default $50)
- Dry Run Mode: toggle (вкл/выкл, default: ВКЛ для первого запуска)
- Telegram Token: input (optional)
- Telegram Chat ID: input (optional)

**Шаг 4: Pre-flight Check**
- Автоматическая проверка:
  - ✓ CLOB API доступен
  - ✓ Data API доступен
  - ✓ API Keys работают
  - ✓ USDC баланс > 0
  - ✓ MATIC баланс > 0.01
  - ✓ Approvals установлены
- Кнопка "Start Bot" (если всё зелёное)

**Важно:** Private Key сохраняется ТОЛЬКО на сервере в `.env` файл. Он НЕ хранится в браузере, НЕ передаётся обратно клиенту. Фронтенд работает через серверный API.

### 5.2. Основной дашборд — Layout

```
┌─────────────────────────────────────────────────────────────┐
│  HEADER: PolyMarket CopyBot PRO                            │
│  [● Running] [Wallet: 0x1a2b...3c4d] [USDC: $142.50]      │
│  [MATIC: 0.34] [⚙ Settings] [■ Stop Bot]                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ Total PnL│ │ Win Rate │ │ Trades   │ │ Today PnL│      │
│  │ +$23.45  │ │  67.3%   │ │   47     │ │  +$5.10  │      │
│  │ ▲ +12.3% │ │ 32W/16L  │ │ 3 failed │ │ 5 trades │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
│                                                             │
│  ┌───────────────────────────────────────────────────┐      │
│  │          P&L CHART (Chart.js — линейный)          │      │
│  │     ____/\___/\/\___/\________                    │      │
│  │  __/                          \___                │      │
│  │  [1H] [24H] [7D] [30D] [ALL]                     │      │
│  └───────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────────────┐  ┌────────────────────────┐      │
│  │   TRACKED TRADERS    │  │    LIVE TRADE FEED     │      │
│  │                      │  │                        │      │
│  │  1. HorizonSplendid  │  │  10:42 BUY "BTC>120k" │      │
│  │     PnL: +$4M        │  │  → Copied $5 @ 0.43   │      │
│  │     Copied: 12 trades│  │                        │      │
│  │     Last: 2 min ago  │  │  10:41 SELL "ETH>5k"  │      │
│  │  ────────────────    │  │  → Sold 100% @ 0.87   │      │
│  │  2. reachingthesky   │  │                        │      │
│  │     PnL: +$3.7M      │  │  10:38 BUY "Fed Cut"  │      │
│  │     Copied: 8 trades │  │  → Copied $5 @ 0.61   │      │
│  │     Last: 5 min ago  │  │                        │      │
│  │  ...                 │  │  10:35 SKIP "low liq"  │      │
│  └──────────────────────┘  └────────────────────────┘      │
│                                                             │
│  ┌───────────────────────────────────────────────────┐      │
│  │              TRADE LOG (таблица)                   │      │
│  │  Time | Trader | Market | Side | Outcome | $  |St │      │
│  │  ─────────────────────────────────────────────────│      │
│  │  10:42 | Horiz.. | BTC>120k | BUY | Yes | $5 | ✓ │      │
│  │  10:41 | reach.. | ETH>5k   | SELL| Yes | $4 | ✓ │      │
│  │  10:38 | bcda    | Fed Cut  | BUY | No  | $5 | ✓ │      │
│  │  10:20 | bcda    | Trump..  | BUY | Yes | $5 | ✗ │      │
│  │  [Search...] [Filter: All ▼] [Export CSV]         │      │
│  └───────────────────────────────────────────────────┘      │
│                                                             │
│  ┌───────────────────────────────────────────────────┐      │
│  │           OPEN POSITIONS (портфель)               │      │
│  │  Market        | Outcome | Shares | Avg | Cur |PnL│      │
│  │  BTC > $120k   | Yes     | 11.6   | .43 | .47 |+5%│      │
│  │  Fed Rate Cut  | No      | 8.2    | .61 | .58 |-5%│      │
│  │  Total Value: $47.80                              │      │
│  └───────────────────────────────────────────────────┘      │
│                                                             │
│  FOOTER: Uptime: 4h 23m | Polling: 30s | v2.0.0           │
└─────────────────────────────────────────────────────────────┘
```

### 5.3. Страница настроек (Settings)

Доступна через кнопку ⚙ в хедере. Позволяет менять параметры на лету (без перезапуска бота, где возможно):

**Торговля:**
- Размер ставки ($)
- Max Slippage (%)
- Max позиций одновременно
- Blacklist рынков (по тегу или slug)

**Риск-менеджмент:**
- Daily Loss Limit ($) — при достижении бот останавливается
- Max Drawdown (%) — от начального баланса
- Стоп-лосс на трейдера — прекратить копировать, если его PnL упал ниже порога

**Отслеживание:**
- Количество трейдеров (top-N)
- Период лидерборда
- Интервал polling
- Min trader volume ($) — фильтр активности
- Min trade size ($) — не копировать микро-сделки трейдера

**Уведомления:**
- Telegram: вкл/выкл, token, chat ID
- Уведомлять о: каждой сделке / только ошибках / daily summary

**Система:**
- Dry Run Mode (toggle)
- Принудительное обновление лидерборда (кнопка)
- Экспорт всех сделок (CSV)
- Сброс данных (очистить БД)

---

## 6. Функциональные требования — детально

### 6.1. Скоринг трейдеров (улучшенный отбор)

Вместо простой сортировки по P&L — **композитный скоринг**:

```typescript
interface TraderScore {
  address: string;
  name: string;
  // Сырые данные с лидерборда
  pnl_7d: number;        // P&L за неделю
  volume_7d: number;      // объём за неделю
  // Рассчитанные метрики
  winRate: number;         // процент прибыльных позиций
  avgTradeSize: number;    // средний размер сделки
  tradesCount: number;     // кол-во сделок за период
  // Композитный скор
  score: number;           // взвешенная сумма
}

// Формула скоринга (настраиваемые веса):
score = (pnl_normalized * 0.4)        // 40% — прибыль
      + (winRate * 0.25)               // 25% — стабильность
      + (volume_normalized * 0.15)     // 15% — активность
      + (tradesCount_normalized * 0.10) // 10% — частота сделок
      + (consistency * 0.10)           // 10% — равномерность (нет 1 lucky trade)
```

**Фильтры перед скорингом:**
- `volume_7d > MIN_TRADER_VOLUME` (default: $1000)
- `tradesCount > 3` (минимум 3 сделки за период)
- Исключить адреса из blacklist

### 6.2. Отслеживание сделок — Dual Mode

**Режим A: Polling (default, надёжный)**
```
Каждые POLL_INTERVAL_MS (30s):
  для каждого трейдера:
    GET /activity?user={addr}&type=TRADE&start={lastTs+1}
    новые сделки → очередь на исполнение
```

**Режим B: WebSocket + Polling fallback (опционально)**
```
Подключиться к wss://ws-live-data.polymarket.com
Подписаться: { topic: "activity", type: "trades" }
Фильтровать по адресам отслеживаемых трейдеров

При разрыве WS → автоматически переключиться на polling
При восстановлении WS → обратно
```

**Rate limiting:** при получении HTTP 429 — exponential backoff (5s, 10s, 20s, 40s, max 60s)

### 6.3. Исполнение ордеров — BUY

```
1. Получена новая BUY-сделка от трейдера
2. Проверить risk-manager:
   - Daily loss limit не достигнут?
   - Max позиций не превышен?
   - Рынок не в blacklist?
   - Ликвидность рынка достаточна?
3. Получить параметры рынка: GET /markets?condition_id={id} → tickSize, negRisk
4. Получить текущую цену: GET /midpoint?token_id={tokenID}
5. Проверить slippage: |midpoint - traderPrice| / traderPrice < MAX_SLIPPAGE
6. Рассчитать:
   - size = BET_SIZE_USD / midpointPrice
   - roundedPrice = round(midpointPrice, tickSize)
7. Отправить ордер:
   clobClient.createAndPostOrder({tokenID, price, side: BUY, size}, {tickSize, negRisk}, GTC)
8. Записать результат в БД
9. Отправить SSE-event на дашборд
10. Отправить Telegram (если включено)
```

**Dry Run Mode:** шаги 1-6 выполняются, шаг 7 заменяется на запись "simulated" ордера. Позволяет протестировать логику без реальных денег.

### 6.4. Исполнение ордеров — SELL

```
1. Получена SELL-сделка от трейдера
2. Проверить: есть ли у нас позиция по этому tokenID?
   - Из БД: SELECT * FROM positions WHERE token_id = ?
   - Если нет позиции → skip (логировать)
3. Определить долю продажи:
   Вариант A (если трекаем позиции трейдера):
     ratio = traderSellSize / traderTotalPosition
     ourSellSize = ourPosition.size * ratio
   Вариант B (упрощённый):
     Если трейдер продал > 80% → продать всё
     Иначе → продать пропорционально
   Вариант C (conservative, default):
     Всегда продавать всю нашу позицию по этому рынку
4. Получить best bid: GET /book?token_id={tokenID}
5. Отправить SELL ордер по best bid price
6. Обновить позицию в БД
```

### 6.5. Auto-Redeem

```
Каждые REDEEM_CHECK_INTERVAL (5 мин):
  1. GET /positions?user={ourAddress}
  2. Для каждой позиции с redeemable: true:
     a. Вызвать CTF contract: redeemPositions(conditionId, [1,2])
     b. Записать REDEEM в БД
     c. Обновить баланс
     d. SSE notification
```

**Контракт для redeem:**
```typescript
// CTF (Conditional Tokens) contract
const ctf = new ethers.Contract(
  '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045', 
  ctfAbi, 
  wallet
);
// Redeem winning position
await ctf.redeemPositions(
  USDC_ADDRESS,               // collateralToken
  ethers.constants.HashZero,  // parentCollectionId  
  conditionId,                // conditionId рынка
  [1, 2]                      // indexSets для binary market
);
```

### 6.6. Риск-менеджмент

| Правило | Действие |
|---------|----------|
| Daily P&L < -DAILY_LOSS_LIMIT | Остановить бота, Telegram alert |
| Drawdown от пика > MAX_DRAWDOWN_PCT | Остановить бота |
| Трейдер вышел из top-20 | Перестать копировать, не закрывать позиции |
| Рынок ликвидность < MIN_LIQUIDITY | Пропустить сделку (status: skipped) |
| Slippage > MAX_SLIPPAGE | Пропустить сделку |
| Insufficient USDC balance | Пропустить, Telegram alert |
| MATIC balance < 0.01 | Warning в логах и на дашборде |

### 6.7. Telegram-уведомления

```
🟢 Bot Started
Tracking 10 traders | Balance: $150.00

📈 New Trade Copied
Trader: HorizonSplendidView
Market: Will BTC hit $120k?
Side: BUY Yes @ $0.43
Size: $5.00 (11.6 shares)
Status: ✅ Filled

📉 Position Sold
Market: Will ETH hit $5k?
Side: SELL Yes @ $0.87
P&L: +$2.15 (+43%)

🔴 Bot Stopped (Daily Loss Limit)
Daily P&L: -$52.30
Limit: $50.00

📊 Daily Summary (23:59)
Trades: 12 (9 wins, 3 losses)
P&L today: +$8.45
Win Rate: 75%
Open positions: 6
```

---

## 7. База данных (SQLite)

### 7.1. Таблицы

```sql
-- Настройки системы (key-value)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Отслеживаемые трейдеры
CREATE TABLE tracked_traders (
  address TEXT PRIMARY KEY,
  name TEXT,
  pnl REAL,
  volume REAL,
  win_rate REAL,
  score REAL,
  trades_count INTEGER,
  last_seen_timestamp INTEGER NOT NULL,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1
);

-- Все сделки бота
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  trader_address TEXT NOT NULL,
  trader_name TEXT,
  side TEXT NOT NULL,           -- BUY / SELL
  market_slug TEXT,
  market_title TEXT,
  condition_id TEXT,
  token_id TEXT,
  outcome TEXT,                 -- Yes / No
  size REAL,                    -- количество shares
  price REAL,                   -- цена исполнения
  total_usd REAL,               -- size * price
  order_id TEXT,
  status TEXT NOT NULL,          -- filled / partial / failed / skipped / simulated
  error TEXT,
  original_trader_size REAL,
  original_trader_price REAL,
  is_dry_run INTEGER DEFAULT 0,
  FOREIGN KEY (trader_address) REFERENCES tracked_traders(address)
);

-- Текущие открытые позиции
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL UNIQUE,
  condition_id TEXT,
  market_slug TEXT,
  market_title TEXT,
  outcome TEXT,
  total_shares REAL NOT NULL,
  avg_price REAL NOT NULL,
  total_invested REAL NOT NULL,
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'open'   -- open / closed / redeemed
);

-- P&L снимки для графика
CREATE TABLE pnl_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_pnl REAL,
  unrealized_pnl REAL,
  realized_pnl REAL,
  balance_usdc REAL,
  open_positions_count INTEGER
);

-- Лог активности (всё подряд)
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  type TEXT NOT NULL,            -- trade / redeem / error / start / stop / alert
  message TEXT NOT NULL,
  details TEXT                   -- JSON с доп. данными
);
```

---

## 8. Конфигурация (.env)

```env
# === Кошелёк (заполняется через Setup Wizard или вручную) ===
PRIVATE_KEY=
FUNDER_ADDRESS=
SIGNATURE_TYPE=0                     # 0 = EOA, 1 = Magic/Email

# === API Credentials (auto-generated при setup) ===
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASSPHRASE=

# === Endpoints ===
CLOB_HOST=https://clob.polymarket.com
DATA_API_HOST=https://data-api.polymarket.com
GAMMA_API_HOST=https://gamma-api.polymarket.com
POLYGON_RPC_URL=https://polygon-rpc.com

# === Торговля ===
BET_SIZE_USD=5
POLL_INTERVAL_MS=30000
LEADER_REFRESH_INTERVAL_MS=86400000
TOP_TRADERS_COUNT=10
LEADERBOARD_PERIOD=7d
REDEEM_CHECK_INTERVAL_MS=300000
MAX_SLIPPAGE_PCT=5
SELL_MODE=conservative               # conservative / proportional
DRY_RUN=true

# === Риск-менеджмент ===
DAILY_LOSS_LIMIT_USD=50
MAX_DRAWDOWN_PCT=20
MAX_OPEN_POSITIONS=30
MIN_MARKET_LIQUIDITY=1000
MIN_TRADER_VOLUME=1000

# === Дашборд ===
DASHBOARD_PORT=3000

# === Telegram (optional) ===
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ENABLED=false
TELEGRAM_NOTIFY_TRADES=true
TELEGRAM_NOTIFY_ERRORS=true
TELEGRAM_DAILY_SUMMARY=true

# === Логирование ===
LOG_LEVEL=info
```

---

## 9. ПОЭТАПНАЯ РАЗРАБОТКА (с тестированием)

### ════════════════════════════════════════════════════════
### ЭТАП 1: Скелет проекта + конфигурация
### ════════════════════════════════════════════════════════

**Что делаем:**
- Инициализация npm, tsconfig, .gitignore
- `src/config.ts` — загрузка .env с валидацией через zod
- `src/utils/logger.ts` — настройка pino (вывод в консоль + файл)
- `src/db/database.ts` + `src/db/migrations.ts` — создание SQLite и таблиц
- `.env.example` с комментариями

**Тест после этапа:**
```bash
npx ts-node src/index.ts
# Ожидаемый результат:
# [INFO] Config loaded successfully
# [INFO] Database initialized: data/copybot.db
# [INFO] Tables created: settings, tracked_traders, trades, positions, pnl_snapshots, activity_log
# [INFO] Logger writing to: data/copybot.log
# Файл data/copybot.db существует и содержит таблицы
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 2: API-обёртки (только чтение)
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/api/data-api.ts` — класс DataApi:
  - `getLeaderboard(period, orderBy, limit)` → TraderInfo[]
  - `getActivity(address, type, start)` → Activity[]
  - `getPositions(address)` → Position[]
  - `getTrades(address, limit)` → Trade[]
  - `getValue(address)` → number
- `src/api/gamma-api.ts` — класс GammaApi:
  - `getMarket(slugOrConditionId)` → Market
  - `getEvents(slug)` → Event
- `src/utils/retry.ts` — retry с exponential backoff
- Общий HTTP-клиент с retry и rate limit handling

**Тест после этапа:**
```bash
npx ts-node -e "
  import { DataApi } from './src/api/data-api';
  const api = new DataApi();
  
  // Тест 1: Лидерборд
  const leaders = await api.getLeaderboard('7d', 'pnl', 10);
  console.log('Top 10 traders:', leaders.map(t => t.name));
  
  // Тест 2: Активность конкретного трейдера
  const activity = await api.getActivity(leaders[0].address, 'TRADE');
  console.log('Last 5 trades:', activity.slice(0, 5));
  
  // Тест 3: Позиции трейдера
  const positions = await api.getPositions(leaders[0].address);
  console.log('Open positions:', positions.length);
"
# Ожидаемый результат: реальные данные с PolyMarket
# Имена трейдеров, их сделки и позиции выводятся в консоль
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 3: Модуль лидерборда и скоринга
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/core/leaderboard.ts` — класс Leaderboard:
  - `fetchAndScore()` → TrackedTrader[]
  - `calculateScore(trader)` → number
  - `filterByActivity(traders)` → traders
  - `saveToDb(traders)`
  - `loadFromDb()` → TrackedTrader[]

**Тест после этапа:**
```bash
npx ts-node -e "
  import { Leaderboard } from './src/core/leaderboard';
  const lb = new Leaderboard();
  
  const traders = await lb.fetchAndScore();
  console.table(traders.map(t => ({
    name: t.name,
    pnl: t.pnl.toFixed(0),
    winRate: (t.winRate * 100).toFixed(1) + '%',
    score: t.score.toFixed(2),
    trades: t.tradesCount
  })));
  
  // Проверяем, что данные сохранились в БД
  const fromDb = lb.loadFromDb();
  console.log('Saved to DB:', fromDb.length, 'traders');
"
# Ожидаемый результат: таблица top-10 с расчитанными скорами
# Данные сохранены в SQLite
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 4: Трекер сделок (polling)
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/core/tracker.ts` — класс Tracker:
  - `initialize(traders)` — установить lastSeenTimestamp для всех
  - `pollOnce()` — один цикл опроса всех трейдеров
  - `startPolling()` — запустить интервал
  - `stopPolling()` — остановить
  - `onNewTrade(callback)` — EventEmitter для обработки новых сделок

**Тест после этапа:**
```bash
npx ts-node -e "
  import { Tracker } from './src/core/tracker';
  import { Leaderboard } from './src/core/leaderboard';
  
  const lb = new Leaderboard();
  const traders = await lb.fetchAndScore();
  
  const tracker = new Tracker();
  await tracker.initialize(traders);
  
  tracker.onNewTrade((trade) => {
    console.log('🔔 NEW TRADE DETECTED:');
    console.log('  Trader:', trade.traderName);
    console.log('  Side:', trade.side);
    console.log('  Market:', trade.title);
    console.log('  Outcome:', trade.outcome);
    console.log('  Size:', trade.size, '@ price:', trade.price);
  });
  
  // Запустить один цикл
  const newTrades = await tracker.pollOnce();
  console.log('New trades found:', newTrades.length);
  
  // Запустить непрерывный polling на 2 минуты
  tracker.startPolling();
  setTimeout(() => {
    tracker.stopPolling();
    console.log('Polling stopped');
  }, 120000);
"
# Ожидаемый результат:
# При первом pollOnce() — 0 новых (всё помечено как seen)
# За 2 минуты polling — если трейдеры торгуют, увидим их сделки
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 5: Базовый дашборд (read-only)
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/dashboard/server.ts` — Express сервер
- `src/dashboard/routes/api.ts`:
  - `GET /api/status` — статус бота
  - `GET /api/traders` — список трейдеров из БД
  - `GET /api/trades` — журнал сделок из БД
  - `GET /api/metrics` — агрегированные метрики
- `src/dashboard/public/index.html` — основной HTML
- `src/dashboard/public/css/styles.css` — dark theme стили
- `src/dashboard/public/js/app.js` — загрузка данных + рендер

На этом этапе дашборд только ЧИТАЕТ данные. Кнопки Start/Stop — заглушки.

**Тест после этапа:**
```bash
npx ts-node src/index.ts
# Открыть http://localhost:3000
# Проверить:
# ✓ Страница загружается с dark theme
# ✓ Карточки метрик отображаются (пока нули)
# ✓ Список трейдеров загружается (если есть в БД из этапа 3)
# ✓ Журнал сделок отображается (пока пустой)
# ✓ API эндпоинты отвечают (проверить через curl)
curl http://localhost:3000/api/status
curl http://localhost:3000/api/traders
curl http://localhost:3000/api/metrics
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 6: Setup Wizard + авторизация кошелька
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/dashboard/routes/auth.ts`:
  - `POST /api/auth/connect-wallet` — принять private key, вернуть адрес + балансы
  - `POST /api/auth/derive-keys` — вызвать createOrDeriveApiKey()
  - `POST /api/auth/approve-usdc` — отправить approve tx
  - `POST /api/auth/approve-ctf` — setApprovalForAll
  - `GET /api/auth/preflight` — проверить всё
  - `GET /api/auth/balance` — текущие балансы USDC + MATIC
- `src/dashboard/public/js/settings.js` — Setup Wizard UI
- `src/api/clob-client.ts` — инициализация ClobClient

**Тест после этапа:**
```bash
npx ts-node src/index.ts
# Открыть http://localhost:3000
# Проверить:
# ✓ При первом входе показывается Setup Wizard
# ✓ Ввод Private Key → отображается адрес и балансы
# ✓ "Derive API Keys" → статус OK
# ✓ "Approve USDC" → транзакция отправлена (проверить на PolygonScan)
# ✓ Pre-flight check → все пункты зелёные
# ✓ Private Key сохранён в .env, НЕ доступен из браузера
# ✓ При повторном входе — Wizard пропускается, показывается дашборд
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 7: Исполнение ордеров (DRY RUN)
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/core/executor.ts` — класс Executor:
  - `executeBuy(trade, dryRun)` → TradeResult
  - `executeSell(trade, dryRun)` → TradeResult
  - В dry run: все расчёты реальные, но ордер не отправляется
- `src/core/portfolio.ts` — класс Portfolio:
  - `getPosition(tokenId)` → Position | null
  - `updatePosition(trade)` — обновить после покупки/продажи
  - `getAllPositions()` → Position[]
- `src/core/risk-manager.ts` — класс RiskManager:
  - `canTrade()` → { allowed: boolean, reason?: string }
  - `checkSlippage(currentPrice, traderPrice)` → boolean
  - `checkDailyLimit()` → boolean
- Интеграция: Tracker → RiskManager → Executor → Portfolio → DB

**Тест после этапа:**
```bash
# Установить DRY_RUN=true в .env
npx ts-node src/index.ts
# Бот запускается, находит трейдеров, начинает polling
# При обнаружении сделки — в логах:
# [INFO] New trade detected: BUY "BTC>120k" Yes by HorizonSplendidView
# [INFO] Risk check: PASSED
# [INFO] DRY RUN: Would buy 11.6 shares @ $0.43 = $5.00
# [INFO] Saved simulated trade to DB
# 
# В дашборде:
# ✓ Сделки появляются в trade log (с меткой "DRY RUN")
# ✓ Метрики обновляются
# ✓ Позиции отображаются (симулированные)
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 8: Реальная торговля
### ════════════════════════════════════════════════════════

**Что делаем:**
- Доработать `executor.ts` — реальная отправка ордеров через ClobClient
- Обработка ответов: filled / partial / rejected
- Retry при сетевых ошибках
- Проверка статуса ордера (GET /order/{id})

**Тест после этапа:**
```bash
# Установить DRY_RUN=false, BET_SIZE_USD=1 (минимум для теста!)
npx ts-node src/index.ts
# Подождать пока трейдер совершит сделку...
# В логах:
# [INFO] REAL TRADE: BUY 2.3 shares "BTC>120k" Yes @ $0.43
# [INFO] Order placed: orderId=abc123, status=filled
# 
# Проверить на PolyMarket UI что позиция реально открылась
# Проверить через API: GET /positions?user={ourAddress}
```

⚠️ **Рекомендация:** начать с $1 ставки. Дать поработать 1-2 часа. Убедиться что BUY работает. Потом протестировать SELL (дождаться продажи одного из трейдеров).

---

### ════════════════════════════════════════════════════════
### ЭТАП 9: SSE + Live Feed + Графики
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/dashboard/routes/sse.ts` — Server-Sent Events endpoint
  - `GET /api/sse` — persistent connection
  - Events: `trade`, `balance`, `status`, `alert`, `pnl_update`
- `src/dashboard/public/js/sse-client.js` — подключение к SSE
- `src/dashboard/public/js/charts.js` — Chart.js графики:
  - P&L Timeline (линейный)
  - Распределение по трейдерам (donut)
  - Win/Loss (bar)
- Live Trade Feed (обновляется через SSE без refresh)
- Баланс в хедере обновляется в реальном времени
- PnL snapshots сохраняются каждые 5 минут

**Тест после этапа:**
```bash
# Запустить бота
npx ts-node src/index.ts
# Открыть дашборд в двух вкладках
# 
# Проверить:
# ✓ При новой сделке — обе вкладки обновляются мгновенно (SSE)
# ✓ Баланс в хедере обновляется
# ✓ График P&L рисуется
# ✓ Live Feed показывает сделки в реальном времени
# ✓ Переключатели периодов на графике работают (1H / 24H / 7D)
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 10: Start/Stop + Auto-Redeem + Telegram
### ════════════════════════════════════════════════════════

**Что делаем:**
- `src/core/bot.ts` — класс Bot (main orchestrator):
  - `start()` — запустить все подсистемы
  - `stop()` — graceful shutdown
  - `getStatus()` — текущее состояние
- Dashboard: кнопки Start/Stop вызывают `POST /api/bot/start` и `/stop`
- `src/core/redeemer.ts` — auto-redeem через CTF контракт
- `src/notifications/telegram.ts` — отправка уведомлений
- Страница Settings в UI — динамическое изменение параметров

**Тест после этапа:**
```bash
npx ts-node src/index.ts
# Открыть дашборд
# 
# ✓ Нажать Stop → бот остановился, индикатор красный
# ✓ Нажать Start → бот запустился, индикатор зелёный
# ✓ Telegram: получили "🟢 Bot Started"
# ✓ При сделке: Telegram notification
# ✓ Изменить BET_SIZE в Settings → применилось без перезапуска
# ✓ Auto-redeem: если есть resolved market — средства автоматически забраны
```

---

### ════════════════════════════════════════════════════════
### ЭТАП 11: Полировка и production-ready
### ════════════════════════════════════════════════════════

**Что делаем:**
- Error boundary на всех уровнях (ни одна ошибка не крашит бота)
- Graceful shutdown (SIGTERM / SIGINT)
- Reconnect logic для WebSocket
- Export CSV с фронтенда
- README.md с инструкциями
- Docker-compose (опционально)

**Финальный тест:**
```bash
# 1. Fresh install test
git clone && npm install && cp .env.example .env
npm start
# Открыть localhost:3000 → Setup Wizard → настроить → запустить

# 2. Stress test
# Дать поработать 24 часа в dry run mode
# Проверить: нет memory leaks, нет крашей, логи чистые

# 3. Real money test
# BET_SIZE=1, DRY_RUN=false
# Поработать 2-3 часа, проверить реальные сделки

# 4. Kill test
# Убить процесс (Ctrl+C), перезапустить
# Бот должен продолжить с того места, где остановился
# (lastSeenTimestamp из БД)
```

---

## 10. Критерии приёмки (финальные)

| # | Критерий | Этап |
|---|----------|------|
| 1 | `npm start` запускает бота и дашборд без ошибок | 1 |
| 2 | Data API и Gamma API возвращают реальные данные | 2 |
| 3 | Top-10 трейдеров определяются с композитным скором | 3 |
| 4 | Новые сделки трейдеров обнаруживаются через polling | 4 |
| 5 | Дашборд открывается с dark theme, метрики отображаются | 5 |
| 6 | Setup Wizard: ввод ключа → деривация → approve → preflight | 6 |
| 7 | Dry Run: сделки симулируются, записываются в БД | 7 |
| 8 | Реальные ордера размещаются и исполняются | 8 |
| 9 | SSE: дашборд обновляется в реальном времени без refresh | 9 |
| 10 | Start/Stop через UI работает корректно | 10 |
| 11 | Auto-redeem забирает средства с закрытых рынков | 10 |
| 12 | Telegram-уведомления приходят | 10 |
| 13 | Бот не падает при ошибках (log & continue) | 11 |
| 14 | После рестарта бот продолжает с сохранённого состояния | 11 |
| 15 | Баланс USDC и MATIC отображаются в хедере дашборда | 6 |
| 16 | P&L график рисуется с переключателями периодов | 9 |
| 17 | Risk manager останавливает бота при превышении лимитов | 7 |
| 18 | Dry Run mode позволяет тестировать без денег | 7 |
| 19 | Settings можно менять через UI без перезапуска | 10 |
| 20 | Экспорт сделок в CSV | 11 |
