// Point d'entrée du paquet de bibliothèques navigateur (construit dans public/vendor/libs.js).
// Une seule copie de Yjs est embarquée : le fournisseur WebSocket, l'éditeur et l'application partagent la même.
// DOMPurify sert à l'aperçu des fichiers Word (HTML produit par le serveur).
// Reconstruction : npm run build
export * as Y from "yjs";
export { WebsocketProvider } from "y-websocket";
export { default as DOMPurify } from "dompurify";
export { createEditor } from "./editor.js";
export { structuredPatch, applyPatch } from "diff"; // fusion des modifications faites pendant une coupure
