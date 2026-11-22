# Розгортання серверної версії CRYP Mining (без терміналу і без ключів)

Усе виконує GitHub Actions. Вам потрібні лише кліки в браузері. **JSON-ключів немає**: Google пускає workflow через GitHub OIDC (Workload Identity Federation), і лише якщо збігаються репозиторій, файл workflow у `main` та середовище `production`, яке ви схвалюєте вручну.

> Важливо: ролі нижче складені за документацією Google/Firebase, але ще **не перевірені реальним розгортанням**. Якщо перший запуск покаже `permission denied`, надішліть мені текст помилки: я назву конкретну роль, яку додати (не Editor і не Firebase Admin).

## 1. Налаштування Google Cloud (одноразово, ≈ 20 хвилин)

Усюди вгорі має бути проєкт **cryp-togame**. Номер проєкту (`PROJECT_NUMBER`) видно на головній сторінці консолі: [Dashboard](https://console.cloud.google.com/home/dashboard?project=cryp-togame).

### 1.1 Увімкніть API
Відкрийте [це посилання](https://console.cloud.google.com/flows/enableapi?apiid=iam.googleapis.com,iamcredentials.googleapis.com,sts.googleapis.com,cloudresourcemanager.googleapis.com,cloudfunctions.googleapis.com,cloudbuild.googleapis.com,artifactregistry.googleapis.com,run.googleapis.com,eventarc.googleapis.com,pubsub.googleapis.com,cloudscheduler.googleapis.com,firebaserules.googleapis.com,firestore.googleapis.com&project=cryp-togame) → **Next/Enable**. Це дає змогу не видавати розгортальнику право вмикати API самому.

### 1.2 Два сервісні акаунти (кожен з мінімумом прав)
Відкрийте [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=cryp-togame) → **Create service account**.

**Акаунт `firebase-migrator`** (лише дані Firestore, не може розгортати чи змінювати IAM):

| Роль | Навіщо |
|---|---|
| Cloud Datastore User | читає й пише документи Firestore під час міграції |

**Акаунт `firebase-deployer`** (розгортання функцій і правил, бекап):

| Роль | Навіщо |
|---|---|
| Cloud Functions Admin | створити/оновити функції |
| Cloud Run Admin | функції 2-го покоління працюють у Cloud Run, відкриття виклику для гравців |
| Cloud Build Editor | збирання функцій |
| Artifact Registry Writer | зберегти зібраний образ |
| Cloud Scheduler Admin | розклад для `hourlyPodium` |
| Pub/Sub Editor | тема для розкладу |
| Firebase Rules Admin | публікація `firestore.rules` |
| Firebase Viewer | читання конфігурації проєкту |
| Service Usage Consumer | користування увімкненими API |
| Cloud Datastore Import Export Admin | бекап Firestore |

Додатково для `firebase-deployer`:
- на сервісний акаунт `PROJECT_NUMBER-compute@developer.gserviceaccount.com` (відкрийте його в списку → **Permissions → Grant access**) дайте **Service Account User**: функції працюватимуть від його імені. Це право на один акаунт, а не на весь проєкт;
- на сховище `cryp-togame.firebasestorage.app` ([Cloud Storage → Buckets](https://console.cloud.google.com/storage/browser?project=cryp-togame) → відкрийте бакет → **Permissions → Grant access**) дайте **Storage Admin** тільки на цей бакет: експорт Firestore потребує запису туди.

Не видавайте жодному з акаунтів Editor, Owner чи Firebase Admin.

### 1.3 Workload Identity Federation (замість ключа)
1. [Workload Identity Federation](https://console.cloud.google.com/iam-admin/workload-identity-pools?project=cryp-togame) → **Create pool**. Name: `github` → Continue.
2. Provider: **OpenID Connect (OIDC)**. Provider name: `github-actions`. Issuer (URL): `https://token.actions.githubusercontent.com`. Audiences: залиште «Default audience».
3. Configure provider attributes: Attribute mapping (додайте рядки кнопкою **Add mapping**):
   - `google.subject` = `assertion.sub`
   - `attribute.repository` = `assertion.repository`
   - `attribute.environment` = `assertion.environment`
   - `attribute.job_workflow_ref` = `assertion.job_workflow_ref`
4. **Attribute Conditions** → **Add condition**, вставте (одним рядком):
   `assertion.repository == 'Jons-ms/mining-game' && assertion.job_workflow_ref == 'Jons-ms/mining-game/.github/workflows/deploy-firebase.yml@refs/heads/main'`
   Так токен отримає лише цей workflow із гілки `main`.
5. **Save**.

### 1.4 Дозвіл workflow діяти від імені акаунтів
Для **кожного** з двох акаунтів: відкрийте його → вкладка **Permissions** → **Grant access** → New principals:
`principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.environment/production`
(підставте номер проєкту) → роль **Workload Identity User** → Save. Тобто діяти від імені акаунта може лише запуск, схвалений у середовищі `production`.

## 2. Налаштування GitHub (одноразово, ≈ 5 хвилин)

1. [Settings → Environments](https://github.com/Jons-ms/mining-game/settings/environments) → **New environment** → назва `production` → **Configure environment**:
   - **Required reviewers**: додайте себе (`Jons-ms`). **Prevent self-review не вмикайте**, інакше ви не зможете схвалити власний запуск.
   - **Deployment branches and tags** → *Selected branches and tags* → додайте `main`.
   - **Save protection rules**.
2. [Settings → Secrets and variables → Actions → вкладка Variables](https://github.com/Jons-ms/mining-game/settings/variables/actions) → **New repository variable** (це не секрети, лише адреси). Додайте три:
   - `GCP_WIF_PROVIDER` = `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-actions`
   - `GCP_DEPLOYER_SA` = `firebase-deployer@cryp-togame.iam.gserviceaccount.com`
   - `GCP_MIGRATOR_SA` = `firebase-migrator@cryp-togame.iam.gserviceaccount.com`
3. [Settings → Actions → General](https://github.com/Jons-ms/mining-game/settings/actions): *Workflow permissions* → **Read repository contents and packages permissions**; *Fork pull request workflows from outside collaborators* → **Require approval for all outside collaborators**. Save.

## 3. Як запускати кожен крок

1. [Actions](https://github.com/Jons-ms/mining-game/actions) → **Deploy Firebase** → **Run workflow** (гілка запуску має бути `main`).
2. Поля: **Step to run** — крок; **confirm** — впишіть ту саму назву кроку (захист від випадкового запуску); **ref** — `server-migration`.
3. Відкрийте запуск → жовте повідомлення **Review deployments** → поставте галочку `production` → **Approve and deploy**. До цього жодних доступів до Google немає.
4. Дочекайтеся зеленої позначки й напишіть мені перед наступним кроком.

| № | Крок | Що робить | Чи змінює production |
|---|------|-----------|----------------------|
| 1 | `backup` | Повний експорт Firestore в сховище проєкту | Ні (лише копія) |
| 2 | `migrate-dry-run` | Пробний прогін: читає, нічого не пише. Заодно перевіряє, що вхід без ключа працює | Ні |
| 3 | `deploy-functions` | Публікує Cloud Functions (старий сайт їх не викликає) | Так, додає функції |
| 4 | `deploy-rules` | Публікує правила. **Перед цим попередьте друзів, що гра на паузі** | Так: старий сайт більше не зможе зберігати |
| 5 | `migrate-apply` | Міграція гравців і перший знімок Подіуму, нічого не видаляє | Так, змінює документи гравців |
| 6 | Злити Pull Request `server-migration` у `main` | Публікує новий сайт | Так |
| 7 | `migrate-apply` ще раз | Підхоплює можливі залишки | Ідемпотентний |

Міграція й розгортання пишуться лише в `production` після вашого схвалення; випадково запустити їх неможливо: потрібні запуск із `main`, ваш власний акаунт, збіг поля confirm і ваше схвалення.

## 4. Після завершення
Видаліть доступ: у Google Cloud видаліть акаунти `firebase-deployer` і `firebase-migrator` та пул `github` (або лише відкличте роль Workload Identity User). У GitHub можна видалити змінні й середовище `production`.
