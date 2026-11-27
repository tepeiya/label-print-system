// UDI 批次赋码打印（主从层级：一箱 N 件 + 箱标）—— 与 api/index.ts 同风格
import http from './index';

export interface PackPrintTemplate {
  id: number;
  code: string | null;
  name: string;
  category?: string | null;
}

export interface PackPrintMeta {
  maxUnitQty: number;
  prefix: { prefix: string; valid: boolean; note?: string };
  unitTemplates: PackPrintTemplate[];
  cartonTemplates: PackPrintTemplate[];
  allTemplates: PackPrintTemplate[];
}

export interface PackPrintBody {
  gtin: string;
  lot: string;
  expiry?: string;
  production?: string;
  qty?: number;
  serial: { mode: 'auto' | 'list'; from?: string; prefix?: string; padding?: number; list?: string[]; count?: number };
  sscc?: string;
  parentSscc?: string;
  unitTemplateCode?: string;
  cartonTemplateCode?: string;
  unitTemplateId?: number;
  cartonTemplateId?: number;
  printerId?: number;
  copiesUnit?: number;
  copiesCarton?: number;
  dryRun?: boolean;
  register?: boolean;
  workOrderNo?: string;
  fieldMap?: { gtin?: string; lot?: string; expiry?: string; serial?: string; sscc?: string; qty?: string; extra?: Record<string, string | number> };
}

export interface PackPrintResult {
  dryRun: boolean;
  gtin14: string;
  lot: string;
  expiryGs1: string | null;
  expiryIso: string | null;
  sscc: string;
  ssccAuto: boolean;
  packageId: number | null;
  unitCount: number;
  serialRange: string;
  unitSerials: string[];
  unitJobId: number | null;
  cartonJobId: number | null;
  registered: { created: number; existed: number; failed: number } | null;
  warnings: string[];
}

export const apiPackPrintMeta = (): Promise<PackPrintMeta> => http.get('/udi/pack-print/meta');

export const apiPackPrint = (body: PackPrintBody): Promise<PackPrintResult> =>
  http.post('/udi/pack-print', body);
