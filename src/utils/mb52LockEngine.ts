import { StockReportItem, MB51TransactionItem, VendorDeliverySchedule, WeekDefinition } from '../types';

/**
 * Normalizes any date string (YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, timestamps) into standard ISO YYYY-MM-DD.
 */
export function normalizeToISODate(dateStr?: string): string {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();
  // Standard YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  // DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  // Try Date.parse
  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch {
    // fallback
  }
  return trimmed.slice(0, 10);
}

/**
 * Resolved MB52 Stock Snapshot for a specific component and review week.
 */
export interface ResolvedStockSnapshot {
  effectiveDate: string;
  unrestrictedStock: number;
  inQualityInsp: number;
  totalPhysicalStock: number;
  safetyStock: number;
  primaryItem?: StockReportItem;
  matchingItems: StockReportItem[];
}

/**
 * Resolves the effective MB52 stock snapshot for a component and a given target week or date.
 * If targetWeek is provided:
 * 1. Checks if any active stock snapshot exists on or within the target week (startDate <= date <= endDate).
 *    If so, returns that snapshot.
 * 2. Otherwise, finds the latest active stock snapshot on or before targetWeek.startDate.
 * 3. Falls back to the latest available snapshot, or the earliest if all are future.
 * Also accounts for both unrestricted stock and in-quality inspection stock.
 */
export function getEffectiveStockSnapshot(
  partNumber: string,
  stockList: StockReportItem[] = [],
  targetWeek?: WeekDefinition,
  fallbackDate?: string
): ResolvedStockSnapshot {
  const normFallback = normalizeToISODate(fallbackDate) || '2026-08-01';
  if (!partNumber || stockList.length === 0) {
    return {
      effectiveDate: normFallback,
      unrestrictedStock: 0,
      inQualityInsp: 0,
      totalPhysicalStock: 0,
      safetyStock: 500,
      matchingItems: []
    };
  }

  // Filter items for this part number
  const matching = stockList.filter((s) => s.partNumber === partNumber);
  if (matching.length === 0) {
    return {
      effectiveDate: normFallback,
      unrestrictedStock: 0,
      inQualityInsp: 0,
      totalPhysicalStock: 0,
      safetyStock: 500,
      matchingItems: []
    };
  }

  // Map each item to its normalized date
  const withDates = matching.map((item) => {
    const rawDate = item.stockDate || item.uploadDate || item.lastUpdated;
    const itemDate = normalizeToISODate(rawDate) || normFallback;
    return { item, itemDate };
  });

  let chosenDate = '';

  // If a target week is provided, prioritize snapshots that take effect in or prior to that week
  if (targetWeek && targetWeek.startDate && targetWeek.endDate) {
    const weekStart = normalizeToISODate(targetWeek.startDate);
    const weekEnd = normalizeToISODate(targetWeek.endDate);

    // 1. Look for snapshots falling strictly within the week [weekStart, weekEnd]
    const insideWeek = withDates.filter(
      (w) => !w.item.isPreviousUpload && w.itemDate >= weekStart && w.itemDate <= weekEnd
    );
    if (insideWeek.length > 0) {
      insideWeek.sort((a, b) => b.itemDate.localeCompare(a.itemDate));
      chosenDate = insideWeek[0].itemDate;
    } else {
      // 2. Look for snapshots prior to this week (itemDate < weekStart)
      const beforeWeek = withDates.filter(
        (w) => !w.item.isPreviousUpload && w.itemDate < weekStart
      );
      if (beforeWeek.length > 0) {
        beforeWeek.sort((a, b) => b.itemDate.localeCompare(a.itemDate));
        chosenDate = beforeWeek[0].itemDate;
      }
    }
  }

  // Fallback: If no date determined via week bounds, pick latest active overall
  if (!chosenDate) {
    const activeMatching = withDates.filter((w) => !w.item.isPreviousUpload);
    const candidates = activeMatching.length > 0 ? activeMatching : withDates;
    candidates.sort((a, b) => b.itemDate.localeCompare(a.itemDate));
    chosenDate = candidates[0]?.itemDate || normFallback;
  }

  // Gather all items matching the chosen effective date
  const recordsOnDate = withDates.filter(
    (w) => w.itemDate === chosenDate && !w.item.isPreviousUpload
  );
  const poolOnDate = recordsOnDate.length > 0
    ? recordsOnDate
    : withDates.filter((w) => w.itemDate === chosenDate);

  const unrestrictedSum = poolOnDate.reduce(
    (sum, w) => sum + (Number(w.item.unrestrictedStock) || 0),
    0
  );
  const inQualitySum = poolOnDate.reduce(
    (sum, w) => sum + (Number(w.item.inQualityInsp) || 0),
    0
  );
  const totalPhysical = unrestrictedSum + inQualitySum;
  const primaryItem = poolOnDate[0]?.item;
  const safetyStock = primaryItem ? (Number(primaryItem.safetyStock) || 500) : 500;

  return {
    effectiveDate: chosenDate,
    unrestrictedStock: unrestrictedSum,
    inQualityInsp: inQualitySum,
    totalPhysicalStock: totalPhysical,
    safetyStock,
    primaryItem,
    matchingItems: poolOnDate.map((w) => w.item)
  };
}

/**
 * Returns the effective MB52 upload / baseline date for a specific line item.
 * Looks for the most recent stock upload date recorded for this material code.
 * Falls back to the global opening stock date or today's date if not explicitly set.
 */
export function getLineItemMB52UploadDate(
  partNumber: string,
  stockList: StockReportItem[] = [],
  fallbackDate?: string,
  targetWeek?: WeekDefinition
): string {
  const snapshot = getEffectiveStockSnapshot(partNumber, stockList, targetWeek, fallbackDate);
  return snapshot.effectiveDate;
}

/**
 * Checks if a given date (YYYY-MM-DD) is strictly prior to the line item's MB52 upload date.
 * Any date before the upload date is considered historical / read-only.
 */
export function isDateBeforeMB52Upload(
  date: string,
  mb52UploadDate: string
): boolean {
  if (!date || !mb52UploadDate) return false;
  const normDate = normalizeToISODate(date);
  const normUploadDate = normalizeToISODate(mb52UploadDate);
  return normDate < normUploadDate;
}

/**
 * Determines if a stock report entry is read-only.
 * A stock item is read-only if:
 * 1. It is explicitly flagged as `isReadOnly` or `isPreviousUpload`
 * 2. Its stockDate / uploadDate is older than the most recent upload date for this partNumber
 */
export function isStockRecordReadOnly(
  item: StockReportItem,
  stockList: StockReportItem[] = [],
  openingStockDate?: string
): boolean {
  if (item.isReadOnly || item.isPreviousUpload) return true;

  const latestDate = getLineItemMB52UploadDate(item.partNumber, stockList, openingStockDate);
  const itemDate = item.uploadDate || item.stockDate;

  if (itemDate && latestDate && itemDate < latestDate) {
    return true;
  }

  return false;
}

/**
 * Determines if an MB51 transaction is read-only based on the line item's MB52 upload date.
 * If the transaction postingDate is before the MB52 upload date, it is read-only.
 */
export function isMB51TxReadOnly(
  tx: MB51TransactionItem,
  stockList: StockReportItem[] = [],
  openingStockDate?: string
): boolean {
  if (tx.isReadOnly) return true;
  const lineUploadDate = getLineItemMB52UploadDate(tx.partNumber, stockList, openingStockDate);
  return isDateBeforeMB52Upload(tx.postingDate, lineUploadDate);
}

/**
 * Determines if a vendor delivery schedule is read-only based on the line item's MB52 upload date.
 * Even the buyer cannot add or modify a schedule before the upload date for that component.
 */
export function isScheduleReadOnly(
  schedule: VendorDeliverySchedule,
  stockList: StockReportItem[] = [],
  openingStockDate?: string
): boolean {
  if (schedule.isReadOnly) return true;
  const lineUploadDate = getLineItemMB52UploadDate(schedule.componentCode, stockList, openingStockDate);
  return isDateBeforeMB52Upload(schedule.expectedDeliveryDate, lineUploadDate);
}
