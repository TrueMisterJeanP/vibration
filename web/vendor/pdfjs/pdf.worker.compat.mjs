// L'ordre des dépendances est volontaire : les compatibilités doivent être
// installées dans le contexte du worker avant l'évaluation de PDF.js.
import "./pdf.compat.mjs";
export { WorkerMessageHandler } from "./pdf.worker.min.mjs";
