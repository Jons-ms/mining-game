# CRYP Mining

Браузерна гра з авторизацією Firebase та збереженням прогресу у Cloud Firestore.

## Спільний курс CRYP

Спільний курс і стан його зміни зберігаються у документі `market/exchangeRate`. Клієнти підписуються на нього та оновлюють курс транзакцією Firestore. Наявна логіка курсу збережена.

## Рейтинг «Подіум»

Подіум показує до десяти гравців за формулою:

`баланс гривень + баланс CRYP × поточний курс CRYP`

GitHub Actions щогодини читає потрібні поля гравців і поточний курс, визначає топ-10 та записує у `podium/current` лише місце, нікнейм, баланс гривень і загальний капітал. `updatedAt` ставить сам Firestore. Workflow запускається о 17-й хвилині кожної години за UTC, щоб зменшити затримки через пікове навантаження на початку години. GitHub може відкласти запланований запуск під час високого навантаження, тому оновлення не є точним до хвилини.

Сайт підписується тільки на публічний документ рейтингу. Правила Firestore дозволяють гравцю читати/змінювати лише власне збереження `players/{uid}`, а клієнтам — лише читати `podium/current`. Серверний REST API працює через окремий обліковий запис Google Cloud і обходить Firestore Security Rules, тому workflow вибірково читає тільки поля `playerName`, `cash`, `cryp` та ніколи не записує UID або приватні поля у публічний рейтинг.

## Одноразове налаштування

Для цього варіанта не потрібні Cloud Functions, Cloud Scheduler чи Firebase Functions білінг. Firestore залишається базою даних, а GitHub Actions запускає розрахунок. Потрібно налаштувати Google Cloud Workload Identity Federation для GitHub Actions:

1. Перевір, що у проєкті `cryp-togame` увімкнений Cloud Firestore API і створений окремий service account лише для рейтингу.
2. Дай цьому service account доступ до Firestore через власну IAM-роль із дозволами `datastore.databases.get`, `datastore.entities.get`, `datastore.entities.list`, `datastore.entities.create` та `datastore.entities.update`. Вони потрібні для читання гравців/курсу і запису рейтингу. Така роль все одно може читати всі документи бази; не давай обліковому запису ширші ролі Owner/Editor/Admin.
3. Створи Workload Identity Pool і OIDC Provider для issuer `https://token.actions.githubusercontent.com`. Зістав claims `google.subject=assertion.sub`, `attribute.repository=assertion.repository`, `attribute.ref=assertion.ref`; обмеж умову provider репозиторієм `Jons-ms/mining-game` і гілкою `refs/heads/main`.
4. Дозволь цьому provider impersonate service account через роль `roles/iam.workloadIdentityUser`, обмеживши прив’язку репозиторієм `Jons-ms/mining-game`.
5. У GitHub відкрий **Settings → Secrets and variables → Actions → Variables** і додай:
   - `GCP_WORKLOAD_IDENTITY_PROVIDER` — повний resource name provider-а, наприклад `projects/123456789/locations/global/workloadIdentityPools/github/providers/mining-game`;
   - `GCP_SERVICE_ACCOUNT` — email service account-а.
   
   Використовується короткоживучий OIDC-токен; постійний JSON-ключ у GitHub зберігати не потрібно.
6. Перед розгортанням звір `firestore.rules` з правилами у Firebase Console. Об’єднай наявні правила, якщо база має інші колекції: розгортання локального файлу замінює весь активний набір. Після перевірки опублікуй правила командою `firebase deploy --only firestore:rules`.
7. Злий PR у `main`. У GitHub відкрий **Actions → Update Podium → Run workflow**, запусти workflow вручну та перевір, що документ `podium/current` створився. Після цього він оновлюватиметься за розкладом.

Знімок створюється вже першим успішним запуском. Щогодинний розклад GitHub працює лише після появи workflow у default branch; запуски можна перевіряти у вкладці **Actions**.

## Межі довіри та витрати

Публічний документ не містить балансу CRYP або інших приватних полів. Але баланс гравця зараз формується у браузері; гравець може змінити власний стан до збереження. Серверне формування рейтингу захищає публічний документ від запису клієнтами, але не захищає гру від накрутки балансу.

Кожне оновлення читає всіх гравців, тому кількість читань зростає з кількістю акаунтів. GitHub Actions може затримати розклад під навантаженням; це щогодинне фонове оновлення, а не гарантований запуск точно у визначену хвилину.
