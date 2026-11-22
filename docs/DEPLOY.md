# Розгортання серверної версії CRYP Mining (без терміналу і без ключів)

Усе виконує GitHub Actions. Вам потрібні лише кліки в браузері. **JSON-ключів немає**: Google пускає workflow через GitHub OIDC (Workload Identity Federation), і лише якщо в токені одночасно збігаються репозиторій, файл workflow у `main`, гілка запуску, тип події та середовище `production`, яке ви схвалюєте вручну.

> Ролі нижче звірені з документацією Google (посилання в кінці). Частину прав (Cloud Scheduler, Pub/Sub, Eventarc) документація описує лише побічно, тож вони позначені «не підтверджено». Якщо перший запуск покаже `permission denied`, надішліть мені текст помилки: я назву одну конкретну роль, яку додати (не Editor і не Firebase Admin).

## 1. Налаштування Google Cloud (одноразово, ≈ 25 хвилин)

Усюди вгорі має бути проєкт **cryp-togame**. Номер проєкту (`PROJECT_NUMBER`) видно на головній сторінці консолі: [Dashboard](https://console.cloud.google.com/home/dashboard?project=cryp-togame).

### 1.1 Увімкніть API
Відкрийте [це посилання](https://console.cloud.google.com/flows/enableapi?apiid=iam.googleapis.com,iamcredentials.googleapis.com,sts.googleapis.com,serviceusage.googleapis.com,cloudresourcemanager.googleapis.com,firebase.googleapis.com,firebaserules.googleapis.com,firestore.googleapis.com,cloudfunctions.googleapis.com,cloudbuild.googleapis.com,artifactregistry.googleapis.com,run.googleapis.com,eventarc.googleapis.com,pubsub.googleapis.com,cloudscheduler.googleapis.com,runtimeconfig.googleapis.com,compute.googleapis.com&project=cryp-togame) → **Next → Enable**. Розгортальник не має права вмикати API сам, тому їх вмикаємо наперед. `compute.googleapis.com` потрібен, щоб існував стандартний акаунт `PROJECT_NUMBER-compute@developer.gserviceaccount.com`: від його імені працюватимуть функції.

### 1.2 Два сервісні акаунти
Відкрийте [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=cryp-togame) → **Create service account**. Ролі додавайте на сторінці [IAM](https://console.cloud.google.com/iam-admin/iam?project=cryp-togame) → **Grant access**.

**`firebase-migrator`**: лише дані Firestore (не може розгортати, змінювати правила чи IAM).

| Роль | Що дозволяє (за документацією) |
|---|---|
| Cloud Datastore User (`roles/datastore.user`) | читання й запис документів, транзакції |

**`firebase-deployer`**: розгортання й бекап.

| Роль | Навіщо | Статус |
|---|---|---|
| Cloud Functions Developer (`roles/cloudfunctions.developer`) | створення, оновлення й видалення функцій, завантаження коду. Admin не потрібен: його єдина відмінність, `setIamPolicy`, для функцій 2-го покоління не використовується | підтверджено |
| Cloud Run Admin (`roles/run.admin`) | функції 2-го покоління працюють у Cloud Run. Дозвіл `run.services.setIamPolicy` (відкрити виклик гравцям) є лише в Admin, у Developer його немає | підтверджено |
| Cloud Scheduler Admin (`roles/cloudscheduler.admin`) | Firebase CLI створює розклад для `hourlyPodium` | не підтверджено |
| Pub/Sub Editor (`roles/pubsub.editor`) | Firebase CLI створює тему для розкладу | не підтверджено |
| Firebase Rules Admin (`roles/firebaserules.admin`) | `firebaserules.rulesets.create/get/list/delete`, `releases.create/get/list/update` | підтверджено |
| Firebase Viewer (`roles/firebase.viewer`) | читання конфігурації проєкту | з практики |
| Service Usage Consumer (`roles/serviceusage.serviceUsageConsumer`) | користування увімкненими API | підтверджено |
| Cloud Datastore Import Export Admin (`roles/datastore.importExportAdmin`) | `datastore.databases.export/import`, операції. Права на документи не дає | підтверджено |

Додатково для `firebase-deployer`, лише на конкретні ресурси:
- **Service Account User** (`roles/iam.serviceAccountUser`) **на акаунті `PROJECT_NUMBER-compute@developer.gserviceaccount.com`**: [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=cryp-togame) → відкрийте його → вкладка **Principals with access → Grant access**. Це право `actAs` на акаунт виконання функцій (документація вимагає його для того, хто розгортає). Роль видається на один акаунт, а не на весь проєкт.
- **Storage Admin** (`roles/storage.admin`) **лише на бакеті** `cryp-togame.firebasestorage.app` ([Buckets](https://console.cloud.google.com/storage/browser?project=cryp-togame) → бакет → **Permissions → Grant access**): за документацією експорт Firestore вимагає запису до сховища. Службовий акаунт самого Firestore має доступ до бакета в тому самому проєкті за замовчуванням.

Чи потрібен Service Account User ще й на акаунті Cloud Build? Залежить від віку проєкту:
- Проєкти, створені **після липня 2024**, збирають код від імені того ж `PROJECT_NUMBER-compute@developer.gserviceaccount.com`, тож окремий дозвіл не потрібен: достатньо пункту вище.
- Проєкти, створені **до липня 2024**, використовують старий акаунт `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`. Перевірте: [IAM](https://console.cloud.google.com/iam-admin/iam?project=cryp-togame) → увімкніть **Include Google-provided role grants**. Якщо такий акаунт є серед учасників, дайте `firebase-deployer` **Service Account User** і на ньому (тим самим способом).

Ролі для самого акаунта `PROJECT_NUMBER-compute@developer.gserviceaccount.com` (на сторінці IAM → **Grant access**, учасник = цей акаунт):

| Роль | Навіщо | Статус |
|---|---|---|
| Cloud Build Service Account (`roles/cloudbuild.builds.builder`) | у нових проєктах цей акаунт збирає код; документація радить саме цю роль (логи, читання коду, запис образу в Artifact Registry) | підтверджено |
| Cloud Datastore User (`roles/datastore.user`) | функції читають і пишуть Firestore. Може вже бути в складі Editor, але не завжди | з практики |
| Eventarc Event Receiver (`roles/eventarc.eventReceiver`) | прийом події від розкладу `hourlyPodium` | не підтверджено |

Eventarc для `firebase-deployer`: документація описує керування тригерами як роботу службового акаунта Cloud Functions, окремої ролі для розгортальника не вимагає, тому я її не видаю. Якщо розгортання покаже помилку з `eventarc`, додамо **Eventarc Developer** (`roles/eventarc.developer`).

Не видавайте жодному акаунту Editor, Owner чи Firebase Admin.

### 1.3 Workload Identity Federation (замість ключа)
1. [Workload Identity Federation](https://console.cloud.google.com/iam-admin/workload-identity-pools?project=cryp-togame) → **Create pool**. Name: `github` → Continue.
2. Provider: **OpenID Connect (OIDC)**. Provider name: `github-actions`. Issuer (URL): `https://token.actions.githubusercontent.com`. Audiences: «Default audience».
3. Attribute mapping (рядки додаються кнопкою **Add mapping**):
   - `google.subject` = `assertion.sub`
   - `attribute.repository` = `assertion.repository`
   - `attribute.environment` = `assertion.environment`
   - `attribute.workflow_ref` = `assertion.workflow_ref`

   (Для звичайного, не reusable workflow правильний claim це `workflow_ref`; `job_workflow_ref` призначений для reusable workflow.)
4. **Attribute Conditions** → **Add condition**, вставте одним рядком:

   `assertion.repository == 'Jons-ms/mining-game' && assertion.workflow_ref == 'Jons-ms/mining-game/.github/workflows/deploy-firebase.yml@refs/heads/main' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'workflow_dispatch' && assertion.environment == 'production'`

   Тобто токен видається лише цьому репозиторію, цьому файлу workflow з `main`, лише для запуску з `main`, лише для ручного запуску (`workflow_dispatch`) і лише для завдання в середовищі `production` (воно стартує тільки після вашого схвалення).
5. **Save**.

### 1.4 Дозвіл workflow діяти від імені акаунтів
Для **кожного** з двох акаунтів: відкрийте його → вкладка **Principals with access** → **Grant access** → New principals:
`principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.environment/production`
(підставте номер проєкту) → роль **Workload Identity User** (`roles/iam.workloadIdentityUser`) → Save.

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

## 3. Які права потрібні кожному кроку

| Крок | Акаунт | Потрібні права |
|---|---|---|
| `backup` | `firebase-deployer` | Cloud Datastore Import Export Admin; Storage Admin на бакеті |
| `migrate-dry-run` | `firebase-migrator` | Cloud Datastore User (лише читає) |
| `deploy-functions` | `firebase-deployer` | Cloud Functions Developer; Cloud Run Admin; Cloud Scheduler Admin; Pub/Sub Editor; Firebase Viewer; Service Usage Consumer; Service Account User на акаунті виконання |
| `deploy-rules` | `firebase-deployer` | Firebase Rules Admin; Firebase Viewer |
| `migrate-apply` | `firebase-migrator` | Cloud Datastore User |

## 4. Як запускати кожен крок

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

Випадково запустити розгортання чи міграцію неможливо: потрібні запуск із `main`, ваш власний акаунт, збіг поля confirm і ваше схвалення, а Google ще й перевіряє токен за умовою з кроку 1.3.

## 5. Після завершення
Видаліть доступ: у Google Cloud видаліть акаунти `firebase-deployer` і `firebase-migrator` та пул `github` (або лише відкличте роль Workload Identity User). У GitHub можна видалити змінні й середовище `production`.

## Джерела
- [GitHub: OIDC claims (`workflow_ref`, `job_workflow_ref`, `ref`, `event_name`, `environment`)](https://docs.github.com/en/actions/reference/security/oidc)
- [google-github-actions/auth](https://github.com/google-github-actions/auth)
- [Cloud Run functions: IAM](https://docs.cloud.google.com/functions/docs/concepts/iam) і [усунення проблем (акаунт збирання, `actAs`)](https://docs.cloud.google.com/functions/docs/troubleshooting)
- [Ролі Cloud Run](https://docs.cloud.google.com/run/docs/reference/iam/roles) і [ролі Cloud Functions](https://docs.cloud.google.com/functions/docs/reference/iam/roles)
- [Firebase Rules: ролі](https://docs.cloud.google.com/iam/docs/roles-permissions/firebaserules)
- [Firestore IAM](https://docs.cloud.google.com/firestore/native/docs/security/iam) і [експорт/імпорт](https://docs.cloud.google.com/firestore/native/docs/manage-data/export-import)
- [Eventarc: контроль доступу](https://docs.cloud.google.com/eventarc/docs/access-control)
