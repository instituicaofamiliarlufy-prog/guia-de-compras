// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCGzgFbleV3H6tZpOEW0voPke0LY9VTJs8",
  authDomain: "guia-de-compras-2f883.firebaseapp.com",
  projectId: "guia-de-compras-2f883",
  storageBucket: "guia-de-compras-2f883.firebasestorage.app",
  messagingSenderId: "375038437557",
  appId: "1:375038437557:web:f3e21dc6f40b2a04e076fc"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Cloud Firestore and get a reference to the service
const db = getFirestore(app); // <--- ADD THIS LINE

// Export the initialized app and db instances
// This makes them available for other JavaScript files to import.
export { app, db }; // <--- MODIFY THIS LINE to export 'db' as well
