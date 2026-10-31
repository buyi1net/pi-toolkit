import type { MessageTables } from "../../../i18n/index.ts";

const EN = {
  "module.providers.label": "Provider usage",
  "module.providers.description": "Query provider balance and quota for the editor status bar",
  "module.providers.menu.label": "Balance query",
  "module.providers.menu.description": "Credentials, refresh interval and model usage stats",
  "module.providers.enabled.label": "Enable provider usage",
  "module.providers.enabled.description": "When off, provider balance/quota queries are not made and the editor status bar shows no provider segments (reload to apply)",
  "module.providers.refresh.label": "Balance refresh interval",
  "module.providers.refresh.description": "How often provider balance/quota data is queried",
  "module.providers.refresh.30": "30 seconds",
  "module.providers.refresh.60": "1 minute",
  "module.providers.refresh.120": "2 minutes",
  "module.providers.refresh.300": "5 minutes",
  "module.providers.providerAccess.label": "Provider credentials",
  "module.providers.providerAccess.description": "Read-only: kept in the standalone file",
  "module.providers.providerAccess.configured": "Configured",
  "module.providers.providerAccess.missing": "Not configured",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.providers.label": "供应商用量",
  "module.providers.description": "查询供应商余额与套餐额度，供编辑器状态栏显示",
  "module.providers.menu.label": "余额查询",
  "module.providers.menu.description": "凭据状态、刷新间隔与模型用量统计",
  "module.providers.enabled.label": "启用供应商用量",
  "module.providers.enabled.description": "关闭后不发起供应商余额/套餐查询，编辑器状态栏的供应商分段整块消失（重载 pi 后生效）",
  "module.providers.refresh.label": "余额刷新间隔",
  "module.providers.refresh.description": "供应商余额/套餐数据的查询频率",
  "module.providers.refresh.30": "30 秒",
  "module.providers.refresh.60": "1 分钟",
  "module.providers.refresh.120": "2 分钟",
  "module.providers.refresh.300": "5 分钟",
  "module.providers.providerAccess.label": "供应商凭据",
  "module.providers.providerAccess.description": "只读：保存在独立文件",
  "module.providers.providerAccess.configured": "已配置",
  "module.providers.providerAccess.missing": "未配置",
};

const ZH_TW: typeof EN = {
  "module.providers.label": "供應商用量",
  "module.providers.description": "查詢供應商餘額與套餐額度，供編輯器狀態列顯示",
  "module.providers.menu.label": "餘額查詢",
  "module.providers.menu.description": "憑證狀態、重新整理間隔與模型用量統計",
  "module.providers.enabled.label": "啟用供應商用量",
  "module.providers.enabled.description": "關閉後不發起供應商餘額/套餐查詢，編輯器狀態列的供應商分段整塊消失（重新載入 pi 後生效）",
  "module.providers.refresh.label": "餘額重新整理間隔",
  "module.providers.refresh.description": "供應商餘額/套餐資料的查詢頻率",
  "module.providers.refresh.30": "30 秒",
  "module.providers.refresh.60": "1 分鐘",
  "module.providers.refresh.120": "2 分鐘",
  "module.providers.refresh.300": "5 分鐘",
  "module.providers.providerAccess.label": "供應商憑證",
  "module.providers.providerAccess.description": "唯讀：保存在獨立檔案",
  "module.providers.providerAccess.configured": "已設定",
  "module.providers.providerAccess.missing": "未設定",
};

export const PROVIDERS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

export type ProvidersMessageKey = keyof typeof EN;
