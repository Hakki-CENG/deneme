/**
 * Route Registration Index
 * Tüm route modüllerini buradan kayıt ediyoruz.
 * main.ts sadece bu dosyayı çağırır.
 */
export { registerCognitiveRoutes } from "./cognitive.js";
export { registerMetaControllerRoutes } from "./meta-controller.js";
export { registerAuroraServiceRoutes } from "./aurora-services.js";
export { registerObservabilityRoutes } from "./observability.js";
