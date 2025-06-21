const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Check if already initialized to avoid multiple initializations
if (!admin.apps.length) {
  try {
    let serviceAccount;

    // 1. Check GOOGLE_APPLICATION_CREDENTIALS environment variable first
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const serviceAccountPath = path.resolve(
        process.env.GOOGLE_APPLICATION_CREDENTIALS
      );
      if (!fs.existsSync(serviceAccountPath)) {
        throw new Error(
          `Error: GOOGLE_APPLICATION_CREDENTIALS points to a file that does not exist: ${serviceAccountPath}`
        );
      }
      serviceAccount = require(serviceAccountPath);
      console.log(
        `Loaded service account from GOOGLE_APPLICATION_CREDENTIALS: ${serviceAccountPath}`
      );
    }
    // 2. Fallback to FIREBASE_SERVICE_ACCOUNT environment variable
    else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      console.log(
        "Loaded service account from FIREBASE_SERVICE_ACCOUNT environment variable"
      );
    }
    // 3. Fallback to serviceAccountKey.json file in the server directory
    else {
      const serviceAccountPath = path.resolve(
        __dirname,
        "..",
        "serviceAccountKey.json"
      );
      if (!fs.existsSync(serviceAccountPath)) {
        throw new Error(
          "Error: Missing Firebase service account credentials.\n" +
            `The file '${serviceAccountPath}' was not found.\n` +
            "Please do one of the following:\n" +
            "1. Ensure a `serviceAccountKey.json` file is in the `server` directory. You can generate this file from the Firebase Console under Project Settings > Service Accounts.\n" +
            "2. Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of your service account JSON file.\n" +
            "3. Alternatively, set the `FIREBASE_SERVICE_ACCOUNT` environment variable with your service account JSON.\n" +
            "For more details, see: https://firebase.google.com/docs/admin/setup"
        );
      }
      serviceAccount = require(serviceAccountPath);
      console.log(`Loaded service account from file: ${serviceAccountPath}`);
    }

    // Validate the loaded JSON
    if (
      !serviceAccount.type ||
      !serviceAccount.project_id ||
      !serviceAccount.private_key
    ) {
      throw new Error(
        "Error: Invalid service account JSON. Missing required fields (type, project_id, or private_key)."
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://cardchampions-53543-default-rtdb.firebaseio.com",
    });

    // Configure Firestore to ignore undefined properties
    const db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });

    console.log("Firebase Admin initialized successfully");
  } catch (error) {
    console.error("Firebase initialization error:", error.message);
    process.exit(1); // Exit if initialization fails
  }
}

const db = admin.firestore();

module.exports = { db };
