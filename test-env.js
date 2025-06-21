require("dotenv").config();
console.log({
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY
    ? "[DEFINED]"
    : undefined,
  FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL,
  PORT: process.env.PORT,
  CLIENT_URL: process.env.CLIENT_URL,
});
