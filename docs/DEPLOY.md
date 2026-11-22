# Розгортання серверної версії CRYP Mining (без терміналу)

Усе виконує GitHub Actions. Вам потрібні лише кліки в браузері.

## 1. Одноразове налаштування (≈ 10 хвилин)

### 1.1 Сервісний акаунт у Google Cloud
1. Відкрийте <https://console.cloud.google.com/iam-admin/serviceaccounts?project=cryp-togame> (вгорі має бути проєкт **cryp-togame**).
2. Натисніть **Create service account**. Назва: `github-deploy`. Натисніть **Create and continue**.
3. У полі **Select a role** додайте ці ролі (кнопка **Add another role** для кожної):
   - **Editor**
   - **Cloud Functions Admin**
   - **Cloud Run Admin**
   - **Service Account User**
   - **Firebase Admin**
   - **Cloud Datastore Import Export Admin**
   - **Storage Admin**
4. Натисніть **Done**.

### 1.2 Ключ
1. У списку натисніть на `github-deploy@…` → вкладка **Keys** → **Add key → Create new key → JSON → Create**.
2. Браузер завантажить файл `.json`. Нікому його не надсилайте.

### 1.3 Секрет у GitHub
1. Відкрийте <https://github.com/Jons-ms/mining-game/settings/secrets/actions> → **New repository secret**.
2. Name: `FIREBASE_SERVICE_ACCOUNT`.
3. Secret: відкрийте завантажений `.json` у текстовому редакторі, скопіюйте **весь** вміст і вставте. Натисніть **Add secret**.

## 2. Порядок запуску

Actions → **Deploy Firebase** → **Run workflow** → у списку **Step to run** виберіть крок → **Run workflow**. Дочекайтеся зеленої позначки й напишіть мені перед наступним кроком.

| № | Крок | Що робить | Чи безпечно |
|---|------|-----------|-------------|
| 1 | `backup` | Повний експорт Firestore в сховище проєкту | Лише читає |
| 2 | `deploy-functions` | Публікує Cloud Functions | Старий сайт їх не викликає |
| 3 | `migrate-dry-run` | Пробний прогін міграції, нічого не пише | Лише читає |
| 4 | `deploy-rules` | Публікує правила. **Перед цим попередьте друзів, що гра на паузі** | З цього моменту старий сайт не може зберігати |
| 5 | `migrate-apply` | Міграція гравців і перший знімок Подіуму | Нічого не видаляє |
| 6 | Злити Pull Request `server-migration` у `main` | Публікує новий сайт | |
| 7 | `migrate-apply` ще раз | Підхоплює можливі залишки | Ідемпотентний |

## 3. Після завершення
Видаліть ключ і акаунт: у Google Cloud → Service accounts → `github-deploy` → **Delete**, а в GitHub видаліть секрет `FIREBASE_SERVICE_ACCOUNT`.
