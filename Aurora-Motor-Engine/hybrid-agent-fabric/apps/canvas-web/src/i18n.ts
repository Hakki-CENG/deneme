/**
 * Lightweight i18n (internationalization) module for Aurora Canvas.
 * Supports English (en) and Turkish (tr) with easy extensibility.
 * Zero dependencies — pure TypeScript.
 */

export type Locale = "en" | "tr";

const translations: Record<Locale, Record<string, string>> = {
  en: {
    // Navigation & Layout
    "app.title": "Aurora Canvas",
    "app.subtitle": "Durable agent control center",
    "app.welcome": "Create or select an agent to open conversation, terminal, files, changes, browser and automation panels.",

    // Sidebar
    "sidebar.agents": "Agents",
    "sidebar.new_agent": "New agent",
    "sidebar.no_profile": "No agent profile",
    "sidebar.search": "Search sessions…",
    "sidebar.refresh": "Refresh",
    "sidebar.import_repo": "Import repository",

    // Chat
    "chat.placeholder": "Message the agent…",
    "chat.send": "Send",
    "chat.no_messages": "No messages yet",
    "chat.title": "Conversation",

    // Terminal
    "terminal.title": "Terminal",
    "terminal.run": "Run",
    "terminal.placeholder": "Enter command…",

    // Files
    "files.title": "Files",
    "files.refresh": "Refresh",
    "files.save": "Save",
    "files.select": "Select a file",

    // Changes
    "changes.title": "Changes",
    "changes.git_changes": "Git changes",
    "changes.switch": "Switch",
    "changes.create": "Create",
    "changes.commit": "Commit",

    // Status
    "status.running": "running",
    "status.idle": "idle",
    "status.closed": "closed",
    "status.failed": "failed",
    "status.connecting": "connecting",

    // Tabs
    "tab.chat": "Conversation",
    "tab.terminal": "Terminal",
    "tab.files": "Files",
    "tab.changes": "Changes",
    "tab.browser": "Browser",
    "tab.media": "Media",
    "tab.artifacts": "Artifacts",
    "tab.tree": "Tree",
    "tab.tasks": "Tasks",
    "tab.society": "Society",
    "tab.models": "Models",
    "tab.profiles": "Profiles",
    "tab.mcp": "MCP",
    "tab.secrets": "Secrets",
    "tab.channels": "Channels",

    // Actions
    "action.login": "Login",
    "action.logout": "Logout",
    "action.delete": "Delete",
    "action.cancel": "Cancel",
    "action.confirm": "Confirm",
    "action.approve": "Approve",
    "action.deny": "Deny",
    "action.enable": "Enable",
    "action.disable": "Disable",
    "action.archive": "Archive",
    "action.restore": "Restore",
    "action.export": "Export",
    "action.create": "Create",
    "action.add": "Add",
    "action.remove": "Remove",
    "action.close": "Close",
    "action.open": "Open",
    "action.copy": "Copy",
    "action.paste": "Paste",

    // Errors
    "error.load_failed": "Failed to load data",
    "error.save_failed": "Failed to save changes",
    "error.network": "Network error — check your connection",
    "error.auth_required": "Authentication required",
    "error.permission_denied": "Permission denied",
    "error.not_found": "Resource not found",
    "error.server": "Server error — please try again",
    "error.unknown": "An unknown error occurred",
    "error.attachment_too_large": "Attachment exceeds 2.8 MB",
    "error.max_images": "A prompt supports at most 8 images",

    // Inspector
    "inspector.questions": "Questions",
    "inspector.no_questions": "No open questions",
    "inspector.shells": "Background shells",
    "inspector.no_shells": "No background shells",
    "inspector.approvals": "Approvals",
    "inspector.no_approvals": "No pending approvals",
    "inspector.family": "Agent family",
    "inspector.no_family": "No directly reachable agents",
    "inspector.runtime": "Runtime",
    "inspector.profile": "Profile",
    "inspector.model": "Model",
    "inspector.fallbacks": "Fallbacks",
    "inspector.tasks": "Open tasks",
    "inspector.sequence": "Sequence",
    "inspector.fleet": "Fleet events",
    "inspector.budget": "Budget",
    "inspector.verified": "Verified",
    "inspector.diagnostics": "Diagnostics",
    "inspector.fanout": "Fan-out",
    "inspector.cache": "Cache",
    "inspector.inbox": "queued or uncertain messages",

    // Models
    "models.session_route": "Session route",
    "models.no_fallbacks": "No fallback routes",
    "models.use": "Use",
    "models.add_config": "Add configuration",
    "models.display_name": "display name",
    "models.model_id": "model id",
    "models.base_url": "custom base URL (optional)",
    "models.data_policy": "Data policy",

    // Bulk operations
    "bulk.selected": "selected",
    "bulk.close": "Close selected",
    "bulk.clear": "Clear",

    // Time
    "time.just_now": "just now",
    "time.minutes_ago": "{n} minutes ago",
    "time.hours_ago": "{n} hours ago",
    "time.days_ago": "{n} days ago",
  },

  tr: {
    // Navigation & Layout
    "app.title": "Aurora Canvas",
    "app.subtitle": "Dayanıklı ajan kontrol merkezi",
    "app.welcome": "Sohbet, terminal, dosya, değişiklik, tarayıcı ve otomasyon panellerini açmak için bir ajan oluşturun veya seçin.",

    // Sidebar
    "sidebar.agents": "Ajanlar",
    "sidebar.new_agent": "Yeni ajan",
    "sidebar.no_profile": "Ajan profili yok",
    "sidebar.search": "Oturum ara…",
    "sidebar.refresh": "Yenile",
    "sidebar.import_repo": "Depo içe aktar",

    // Chat
    "chat.placeholder": "Ajana mesaj gönder…",
    "chat.send": "Gönder",
    "chat.no_messages": "Henüz mesaj yok",
    "chat.title": "Sohbet",

    // Terminal
    "terminal.title": "Terminal",
    "terminal.run": "Çalıştır",
    "terminal.placeholder": "Komut girin…",

    // Files
    "files.title": "Dosyalar",
    "files.refresh": "Yenile",
    "files.save": "Kaydet",
    "files.select": "Dosya seçin",

    // Changes
    "changes.title": "Değişiklikler",
    "changes.git_changes": "Git değişiklikleri",
    "changes.switch": "Değiştir",
    "changes.create": "Oluştur",
    "changes.commit": "İşle",

    // Status
    "status.running": "çalışıyor",
    "status.idle": "boşta",
    "status.closed": "kapalı",
    "status.failed": "başarısız",
    "status.connecting": "bağlanıyor",

    // Tabs
    "tab.chat": "Sohbet",
    "tab.terminal": "Terminal",
    "tab.files": "Dosyalar",
    "tab.changes": "Değişiklikler",
    "tab.browser": "Tarayıcı",
    "tab.media": "Medya",
    "tab.artifacts": "Eserler",
    "tab.tree": "Ağaç",
    "tab.tasks": "Görevler",
    "tab.society": "Topluluk",
    "tab.models": "Modeller",
    "tab.profiles": "Profiller",
    "tab.mcp": "MCP",
    "tab.secrets": "Gizler",
    "tab.channels": "Kanallar",

    // Actions
    "action.login": "Giriş",
    "action.logout": "Çıkış",
    "action.delete": "Sil",
    "action.cancel": "İptal",
    "action.confirm": "Onayla",
    "action.approve": "Onayla",
    "action.deny": "Reddet",
    "action.enable": "Etkinleştir",
    "action.disable": "Devre dışı",
    "action.archive": "Arşivle",
    "action.restore": "Geri yükle",
    "action.export": "Dışa aktar",
    "action.create": "Oluştur",
    "action.add": "Ekle",
    "action.remove": "Kaldır",
    "action.close": "Kapat",
    "action.open": "Aç",
    "action.copy": "Kopyala",
    "action.paste": "Yapıştır",

    // Errors
    "error.load_failed": "Veri yüklenemedi",
    "error.save_failed": "Değişiklikler kaydedilemedi",
    "error.network": "Ağ hatası — bağlantınızı kontrol edin",
    "error.auth_required": "Kimlik doğrulama gerekli",
    "error.permission_denied": "İzin reddedildi",
    "error.not_found": "Kaynak bulunamadı",
    "error.server": "Sunucu hatası — lütfen tekrar deneyin",
    "error.unknown": "Bilinmeyen bir hata oluştu",
    "error.attachment_too_large": "Ek 2.8 MB'ı aşıyor",
    "error.max_images": "Bir mesaj en fazla 8 resim destekler",

    // Inspector
    "inspector.questions": "Sorular",
    "inspector.no_questions": "Açık soru yok",
    "inspector.shells": "Arka plan kabukları",
    "inspector.no_shells": "Arka plan kabuğu yok",
    "inspector.approvals": "Onaylar",
    "inspector.no_approvals": "Bekleyen onay yok",
    "inspector.family": "Ajan ailesi",
    "inspector.no_family": "Erişilebilir ajan yok",
    "inspector.runtime": "Çalışma zamanı",
    "inspector.profile": "Profil",
    "inspector.model": "Model",
    "inspector.fallbacks": "Yedekler",
    "inspector.tasks": "Açık görevler",
    "inspector.sequence": "Sıra",
    "inspector.fleet": "Filo olayları",
    "inspector.budget": "Bütçe",
    "inspector.verified": "Doğrulanmış",
    "inspector.diagnostics": "Tanılama",
    "inspector.fanout": "Yayılım",
    "inspector.cache": "Önbellek",
    "inspector.inbox": "kuyruğa alınmış veya belirsiz mesaj",

    // Models
    "models.session_route": "Oturum rotası",
    "models.no_fallbacks": "Yedek rota yok",
    "models.use": "Kullan",
    "models.add_config": "Yapılandırma ekle",
    "models.display_name": "görünen ad",
    "models.model_id": "model kimliği",
    "models.base_url": "özel temel URL (isteğe bağlı)",
    "models.data_policy": "Veri politikası",

    // Bulk operations
    "bulk.selected": "seçili",
    "bulk.close": "Seçilenleri kapat",
    "bulk.clear": "Temizle",

    // Time
    "time.just_now": "az önce",
    "time.minutes_ago": "{n} dakika önce",
    "time.hours_ago": "{n} saat önce",
    "time.days_ago": "{n} gün önce",
  },
};

let currentLocale: Locale = "en";

/** Set the active locale */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
  try { localStorage.setItem("aurora-locale", locale); } catch {}
}

/** Get the active locale */
export function getLocale(): Locale {
  try {
    const stored = localStorage.getItem("aurora-locale");
    if (stored === "en" || stored === "tr") return stored;
  } catch {}
  // Auto-detect from browser
  const lang = navigator.language?.split("-")[0];
  if (lang === "tr") return "tr";
  return "en";
}

/** Translate a key with optional interpolation */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = getLocale();
  let text = translations[locale]?.[key] ?? translations.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}

/** Get all available locales */
export function availableLocales(): Locale[] {
  return ["en", "tr"];
}

/** Initialize locale from storage or browser */
export function initLocale(): Locale {
  const locale = getLocale();
  currentLocale = locale;
  return locale;
}
