/* Firebase setup for CRYP Mining Game.
 * This web config is public by design; protect your database with Firebase Security Rules.
 */
(() => {
  "use strict";

  const firebaseConfig = {
    apiKey: "AIzaSyAu8x-RIQRlux8pD9ebKPsEwe61OTKE6a4",
    authDomain: "cryp-togame.firebaseapp.com",
    projectId: "cryp-togame",
    storageBucket: "cryp-togame.firebasestorage.app",
    messagingSenderId: "917610798196",
    appId: "1:917610798196:web:698b409f745c78b5428521",
    measurementId: "G-NGBSDN3H8B"
  };

  if (!window.firebase) {
    console.error("Firebase SDK не завантажився. Перевір підключення до інтернету.");
    window.crypFirebase = { ready: false, error: "sdk-missing" };
    return;
  }

  try {
    const app = window.firebase.apps.length
      ? window.firebase.app()
      : window.firebase.initializeApp(firebaseConfig);

    window.crypFirebase = {
      ready: true,
      app,
      auth: window.firebase.auth(),
      db: window.firebase.firestore()
    };
    console.info("Firebase ініціалізовано для CRYP Mining Game.");
  } catch (error) {
    console.error("Не вдалося ініціалізувати Firebase:", error);
    window.crypFirebase = { ready: false, error };
  }
})();
