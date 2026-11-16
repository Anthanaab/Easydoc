// Point d'entrée du paquet de bibliothèques navigateur (construit dans public/vendor/libs.js).
// Une seule copie de Yjs est embarquée : le fournisseur WebSocket, l'éditeur et l'application partagent la même.
// Reconstruction : npm run build
export * as Y from "yjs";
export { WebsocketProvider } from "y-websocket";
export { Marked } from "marked";
export { default as DOMPurify } from "dompurify";
export { createEditor } from "./editor.js";
