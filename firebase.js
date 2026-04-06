// firebase.js — fonte única do Firebase SDK v10.12.2
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection, doc, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCGzgFbleV3H6tZpOEW0voPke0LY9VTJs8",
  authDomain:        "guia-de-compras-2f883.firebaseapp.com",
  projectId:         "guia-de-compras-2f883",
  storageBucket:     "guia-de-compras-2f883.firebasestorage.app",
  messagingSenderId: "375038437557",
  appId:             "1:375038437557:web:f3e21dc6f40b2a04e076fc"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

export {
  app, db,
  collection, doc, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy
};