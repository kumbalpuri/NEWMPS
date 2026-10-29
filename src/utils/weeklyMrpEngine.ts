import {
  BOMItem,
  VendorBuyerItem,
  WeekDefinition,
  MonthlyPlanItem,
  MB51TransactionItem,
  StockReportItem,
  FGWeeklyCoverageSummary,
  RMWeeklyRequirementSummary
} from '../types';
import { getEffectiveStockSnapshot } from './mb52LockEngine';

/**
 * Helper to check if a date falls within a week definition range
 */
export function isDateInWeek(dateStr: string, week: WeekDefinition): boolean {
  if (!dateStr || !week.startDate || !week.endDate) return false;
  return dateStr >= week.startDate && dateStr <= week.endDate;
}

/**
 * Helper to match an MB51 transaction to a week definition
 */
export function getWeekForTransaction(
  tx: MB51TransactionItem,
  weeks: WeekDefinition[]
): WeekDefinition | undefined {
  if (tx.weekId) {
    const found = weeks.find((w) => w.id === tx.weekId);
    if (found) return found;
  }
  return weeks.find((w) => isDateInWeek(tx.postingDate, w));
}

/**
 * Computes FG Weekly Plan vs Actual Receipts (MB51 101 prefix 7) vs Dispatches (MB51 601)
 */
export function computeFGWeeklyCoverage(
  selectedMonth: string,
  monthlyPlans: MonthlyPlanItem[],
  weeks: WeekDefinition[],
  mb51List: MB51TransactionItem[],
  stockList: StockReportItem[],
  openingStockDate?: string
): FGWeeklyCoverageSummary[] {
  const monthWeeks = weeks
    .filter((w) => w.month === selectedMonth)
    .sort((a, b) => a.weekNo - b.weekNo);

  const monthPlans = monthlyPlans.filter((p) => p.month === selectedMonth);

  // Derive effective opening date if not explicitly passed
  const effectiveOpeningDate =
    openingStockDate || stockList.find((s) => s.stockDate)?.stockDate;

  return monthPlans.map((plan) => {
    // Find latest uploaded FG stock (opening stock as of openingStockDate)
    const matchingStocks = stockList
      .filter((s) => s.partNumber === plan.fgCode)
      .sort((a, b) => {
        const dateA = a.uploadDate || a.stockDate || '';
        const dateB = b.uploadDate || b.stockDate || '';
        return dateB.localeCompare(dateA);
      });
    const stockItem = matchingStocks[0];
    const startingStock = stockItem ? stockItem.unrestrictedStock : 0;
    const itemBaselineDate = stockItem?.uploadDate || stockItem?.stockDate || effectiveOpeningDate;

    let rollingStock = startingStock;
    let totalActualProd = 0;
    let totalActualDisp = 0;
    let totalPlanTarget = 0;

    const weekSummaries = monthWeeks.map((week) => {
      const planTarget = plan.weeklyBreakdown[week.id] || 0;
      totalPlanTarget += planTarget;

      // Filter MB51 transactions for this FG and this week
      const fgReceipts = mb51List.filter((tx) => {
        const isMvt101 = tx.movementType === '101';
        const isThisFG = tx.partNumber === plan.fgCode;
        const matchesWeek =
          tx.weekId === week.id || isDateInWeek(tx.postingDate, week);
        return isMvt101 && isThisFG && matchesWeek;
      });

      const actualProd = fgReceipts.reduce((sum, tx) => sum + tx.quantity, 0);
      totalActualProd += actualProd;

      const fgDispatches = mb51List.filter((tx) => {
        const isMvt601 = tx.movementType === '601';
        const isThisFG = tx.partNumber === plan.fgCode;
        const matchesWeek =
          tx.weekId === week.id || isDateInWeek(tx.postingDate, week);
        return isMvt601 && isThisFG && matchesWeek;
      });

      const actualDisp = fgDispatches.reduce((sum, tx) => sum + tx.quantity, 0);
      totalActualDisp += actualDisp;

      const variance = actualProd - planTarget;

      // When baseline date is set:
      // If the week ended before the opening stock date, it's historical before the inventory snapshot.
      if (itemBaselineDate && week.endDate < itemBaselineDate) {
        // Historical week prior to opening stock snapshot
      } else {
        // Transactions that occurred on or after baseline date affect rolling stock
        const receiptsFromDate = fgReceipts
          .filter((tx) => !itemBaselineDate || tx.postingDate >= itemBaselineDate)
          .reduce((sum, tx) => sum + tx.quantity, 0);

        const dispatchesFromDate = fgDispatches
          .filter((tx) => !itemBaselineDate || tx.postingDate >= itemBaselineDate)
          .reduce((sum, tx) => sum + tx.quantity, 0);

        rollingStock = rollingStock + receiptsFromDate - dispatchesFromDate;
      }

      return {
        weekId: week.id,
        weekNo: week.weekNo,
        weekLabel: week.weekLabel,
        daysCount: week.daysCount,
        planTarget,
        actualProductionReceipt: actualProd,
        variance,
        actualDispatch: actualDisp,
        closingStock: Math.round(rollingStock)
      };
    });

    const achievementRate =
      totalPlanTarget > 0 ? (totalActualProd / totalPlanTarget) * 100 : 0;

    return {
      fgCode: plan.fgCode,
      fgDescription: plan.fgDescription,
      customerName: plan.customerName,
      startingStock,
      monthlyPlanTarget: plan.monthlyTarget,
      weeks: weekSummaries,
      totalActualProduction: totalActualProd,
      totalActualDispatch: totalActualDisp,
      overallAchievementRate: Math.round(achievementRate * 10) / 10
    };
  });
}

/**
 * Computes Consolidated RM/PM Requirements, MB51 Inwards (101 prefix non-7), Stock Balances & Buyer Assignments
 */
export function computeRMWeeklyRequirements(
  selectedMonth: string,
  monthlyPlans: MonthlyPlanItem[],
  weeks: WeekDefinition[],
  boms: BOMItem[],
  vendorBuyers: VendorBuyerItem[],
  mb51List: MB51TransactionItem[],
  stockList: StockReportItem[],
  openingStockDate?: string
): RMWeeklyRequirementSummary[] {
  const monthWeeks = weeks
    .filter((w) => w.month === selectedMonth)
    .sort((a, b) => a.weekNo - b.weekNo);

  const monthPlans = monthlyPlans.filter((p) => p.month === selectedMonth);

  // Derive effective opening date if not explicitly passed
  const effectiveOpeningDate =
    openingStockDate || stockList.find((s) => s.stockDate)?.stockDate;

  // 1. Group BOM items by componentCode
  const componentMap = new Map<
    string,
    {
      componentCode: string;
      componentDescription: string;
      category: 'RM' | 'PM';
      uom: string;
      usedInFGs: { fgCode: string; fgDescription: string; usagePerFG: number }[];
    }
  >();

  boms.forEach((bom) => {
    const existing = componentMap.get(bom.componentCode);
    if (existing) {
      if (!existing.usedInFGs.some((f) => f.fgCode === bom.fgCode)) {
        existing.usedInFGs.push({
          fgCode: bom.fgCode,
          fgDescription: bom.fgDescription,
          usagePerFG: bom.qty
        });
      }
    } else {
      componentMap.set(bom.componentCode, {
        componentCode: bom.componentCode,
        componentDescription: bom.componentDescription,
        category: bom.category || (bom.componentCode.startsWith('8') ? 'PM' : 'RM'),
        uom: bom.uom,
        usedInFGs: [
          {
            fgCode: bom.fgCode,
            fgDescription: bom.fgDescription,
            usagePerFG: bom.qty
          }
        ]
      });
    }
  });

  const summaries: RMWeeklyRequirementSummary[] = [];

  componentMap.forEach((comp) => {
    // Lookup vendor and buyer from master
    const vbMapping = vendorBuyers.find((vb) =>
      vb.suppliedComponents.includes(comp.componentCode)
    );
    const buyerName = vbMapping
      ? vbMapping.buyerName
      : 'Unassigned Buyer';
    const vendorName = vbMapping ? vbMapping.vendorName : 'Direct / Spot Vendor';
    const vendorCode = vbMapping ? vbMapping.vendorCode : 'V-NONE';
    const leadTimeDays = vbMapping ? vbMapping.leadTimeDays : 7;

    let rollingStock = 0;
    let hasRollingBaseline = false;
    let lastAppliedSnapshotDate = '';

    const weekSummaries = monthWeeks.map((week) => {
      // Lookup Stock Report (Snapshot for this component at this week)
      const stockSnapshot = getEffectiveStockSnapshot(
        comp.componentCode,
        stockList,
        week,
        effectiveOpeningDate
      );
      const snapshotStock = stockSnapshot.totalPhysicalStock;
      const safetyStock = stockSnapshot.safetyStock;
      const itemBaselineDate = stockSnapshot.effectiveDate;

      const isNewSnapshotInThisWeek =
        itemBaselineDate &&
        itemBaselineDate !== lastAppliedSnapshotDate &&
        week.startDate &&
        week.endDate &&
        itemBaselineDate >= week.startDate &&
        itemBaselineDate <= week.endDate;

      if (!hasRollingBaseline || isNewSnapshotInThisWeek) {
        rollingStock = snapshotStock;
        hasRollingBaseline = true;
        lastAppliedSnapshotDate = itemBaselineDate || '';
      }

      const currentStock = Math.round(rollingStock);

      // Calculate Gross Requirement across all active FG plans in this month
      let grossReqForWeek = 0;
      comp.usedInFGs.forEach((fgUsage) => {
        const fgPlan = monthPlans.find((p) => p.fgCode === fgUsage.fgCode);
        if (fgPlan) {
          const fgWeekQty = fgPlan.weeklyBreakdown[week.id] || 0;
          grossReqForWeek += fgWeekQty * fgUsage.usagePerFG;
        }
      });

      grossReqForWeek = Math.round(grossReqForWeek * 100) / 100;

      // Filter MB51 Receipts (Mvt 101 prefix non-7) for this component
      const rmReceipts = mb51List.filter((tx) => {
        const isMvt101 = tx.movementType === '101';
        const isThisComp = tx.partNumber === comp.componentCode;
        const matchesWeek =
          tx.weekId === week.id || isDateInWeek(tx.postingDate, week);
        return isMvt101 && isThisComp && matchesWeek;
      });

      const inwardQty = rmReceipts.reduce((sum, tx) => sum + tx.quantity, 0);

      // Only inward receipts on or after baseline date count as new receipts
      const inwardsFromDate = rmReceipts
        .filter((tx) => !itemBaselineDate || tx.postingDate >= itemBaselineDate)
        .reduce((sum, tx) => sum + tx.quantity, 0);

      rollingStock = rollingStock + inwardsFromDate - grossReqForWeek;

      let status: 'OK' | 'WARNING' | 'SHORTAGE' = 'OK';
      let deficit = 0;

      if (rollingStock < 0) {
        status = 'SHORTAGE';
        deficit = Math.abs(rollingStock);
      } else if (rollingStock < safetyStock) {
        status = 'WARNING';
        deficit = safetyStock - rollingStock;
      }

      return {
        weekId: week.id,
        weekNo: week.weekNo,
        weekLabel: week.weekLabel,
        grossRequirement: grossReqForWeek,
        actualInwardReceipt: inwardQty,
        projectedStock: Math.round(rollingStock),
        deficit: Math.round(deficit),
        status,
        currentStock,
        safetyStock
      };
    });

    const totalGrossReq = weekSummaries.reduce((sum, s) => sum + s.grossRequirement, 0);
    const totalInward = weekSummaries.reduce((sum, s) => sum + s.actualInwardReceipt, 0);
    const maxShortage = Math.max(...weekSummaries.map((s) => s.deficit));
    const overallStatus = weekSummaries.some((s) => s.status === 'SHORTAGE')
      ? 'SHORTAGE'
      : weekSummaries.some((s) => s.status === 'WARNING')
      ? 'WARNING'
      : 'OK';

    summaries.push({
      componentCode: comp.componentCode,
      componentDescription: comp.componentDescription,
      category: comp.category,
      uom: comp.uom,
      buyerName,
      vendorName,
      vendorCode,
      leadTimeDays,
      currentStock: weekSummaries[0].currentStock,
      safetyStock: weekSummaries[0].safetyStock,
      usedInFGs: comp.usedInFGs,
      weeks: weekSummaries,
      totalGrossRequirement: Math.round(totalGrossReq),
      totalInwardReceived: Math.round(totalInward),
      overallStatus,
      maxShortageQty: Math.round(maxShortage)
    });
  });

  // Sort by status: SHORTAGE first, then WARNING, then OK
  return summaries.sort((a, b) => {
    const score = (s: string) =>
      s === 'SHORTAGE' ? 3 : s === 'WARNING' ? 2 : 1;
    return score(b.overallStatus) - score(a.overallStatus);
  });
}
