import {
  ExplodedBOMComponentSummary,
  WeekDefinition,
  VendorDeliverySchedule,
  BOMGanttDaySimulation,
  BOMGanttTimelineResult,
  BOMGanttDayDelivery,
  BOMGanttDayStatus,
  StockReportItem
} from '../types';
import { normalizeToISODate } from './mb52LockEngine';

/**
 * Generates an array of ISO dates (YYYY-MM-DD) between start and end date (inclusive)
 */
export function getDatesInRange(startDateStr: string, endDateStr: string): string[] {
  const dates: string[] = [];
  try {
    const curr = new Date(startDateStr + 'T00:00:00');
    const end = new Date(endDateStr + 'T00:00:00');

    // Safety guard against infinite loops (up to 120 days for multi-week / full-month simulation)
    let count = 0;
    while (curr <= end && count < 120) {
      const yyyy = curr.getFullYear();
      const mm = String(curr.getMonth() + 1).padStart(2, '0');
      const dd = String(curr.getDate()).padStart(2, '0');
      dates.push(`${yyyy}-${mm}-${dd}`);
      curr.setDate(curr.getDate() + 1);
      count++;
    }
  } catch (e) {
    console.error('Failed to generate date range:', e);
  }
  return dates;
}

/**
 * Formats YYYY-MM-DD into short display like "08 Sep" or "Tue 08 Sep"
 */
export function formatGanttDate(dateStr: string): { label: string; weekday: string; full: string } {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const dayName = weekdays[d.getDay()] || '';
    const monthName = months[d.getMonth()] || '';
    const dayNum = String(d.getDate()).padStart(2, '0');

    return {
      label: `${dayNum} ${monthName}`,
      weekday: dayName,
      full: `${dayName}, ${dayNum} ${monthName}`
    };
  } catch {
    return {
      label: dateStr.slice(5),
      weekday: '',
      full: dateStr
    };
  }
}

/**
 * Builds a map of ISO date -> total physical stock (unrestricted + inQualityInsp)
 * from active MB52 stock records for a given part number.
 */
export function buildPartStockSnapshotsByDate(
  partNumber: string,
  stockList?: StockReportItem[],
  fallbackDate?: string,
  fallbackStock?: number
): Map<string, number> {
  const snapshotMap = new Map<string, number>();

  if (stockList && stockList.length > 0) {
    const activeRecords = stockList.filter(
      (s) => s.partNumber === partNumber && !s.isPreviousUpload
    );
    const recordsToUse =
      activeRecords.length > 0
        ? activeRecords
        : stockList.filter((s) => s.partNumber === partNumber);

    recordsToUse.forEach((rec) => {
      const rawDate = rec.stockDate || rec.uploadDate || rec.lastUpdated || fallbackDate;
      const isoDate = normalizeToISODate(rawDate);
      if (isoDate) {
        const qty = (Number(rec.unrestrictedStock) || 0) + (Number(rec.inQualityInsp) || 0);
        snapshotMap.set(isoDate, (snapshotMap.get(isoDate) || 0) + qty);
      }
    });
  }

  if (snapshotMap.size === 0 && fallbackDate && fallbackStock !== undefined) {
    const isoFallback = normalizeToISODate(fallbackDate);
    if (isoFallback) {
      snapshotMap.set(isoFallback, fallbackStock);
    }
  }

  return snapshotMap;
}

/**
 * Core Gantt Simulation Engine:
 * Simulates day-by-day inventory consumption vs expected vendor arrival dates across the entire month.
 * - Whenever an opening stock is added/uploaded on a date D, that opening stock acts as the base on date D.
 * - For all subsequent days and future weeks until month end, each day's opening stock is the previous day's
 *   closing stock (never resetting to zero at week boundaries).
 * - If a new opening stock is added on a later date D2, the calculation resets to the new opening stock on D2
 *   and rolls forward from D2 until month end.
 */
export function simulateBOMComponentDailyTimeline(
  comp: ExplodedBOMComponentSummary,
  fgCode: string,
  fgDescription: string,
  fgTotalGrossTarget: number,
  week: WeekDefinition,
  activeDeliverySchedules: VendorDeliverySchedule[],
  options?: {
    customInitialStock?: number;
    effectiveStockDate?: string; // e.g. "2026-08-06"
    simulatedDeliveries?: VendorDeliverySchedule[];
    horizonDays?: number; // e.g. 7 or 14
    nonWorkingDays?: string[]; // e.g. ['Sun']
    stockList?: StockReportItem[];
    monthWeeks?: WeekDefinition[];
    weekGrossTargets?: Record<string, number>;
  }
): BOMGanttTimelineResult {
  const initialStock =
    options?.customInitialStock !== undefined
      ? options.customInitialStock
      : comp.currentStock;

  const safetyStock = comp.safetyStock || 0;
  const bomQty = comp.bomQty || 1;
  const nonWorking = options?.nonWorkingDays || ['Sun'];

  // Determine effective stock date (MB52 upload baseline date)
  const rawStockDate = options?.effectiveStockDate || comp.stockDate || comp.uploadDate;
  const effectiveStockDate = rawStockDate ? normalizeToISODate(rawStockDate) : undefined;

  // Target display date range for the selected week
  const targetStartDate = week.startDate || '2026-08-01';
  let targetEndDate = week.endDate || '2026-08-07';

  if (options?.horizonDays && options.horizonDays > week.daysCount) {
    const s = new Date(targetStartDate + 'T00:00:00');
    s.setDate(s.getDate() + options.horizonDays - 1);
    const yyyy = s.getFullYear();
    const mm = String(s.getMonth() + 1).padStart(2, '0');
    const dd = String(s.getDate()).padStart(2, '0');
    targetEndDate = `${yyyy}-${mm}-${dd}`;
  }

  // Reconstruct all weeks in the month so we can roll stock continuously from Week 1 to Month End
  let allMonthWeeks: WeekDefinition[] = [];
  if (options?.monthWeeks && options.monthWeeks.length > 0) {
    allMonthWeeks = [...options.monthWeeks].sort((a, b) => a.weekNo - b.weekNo);
  } else if (comp.weekDetails && comp.weekDetails.some((wd) => wd.startDate && wd.endDate)) {
    allMonthWeeks = comp.weekDetails
      .filter((wd) => wd.startDate && wd.endDate)
      .map((wd) => ({
        id: wd.weekId,
        month: week.month,
        weekNo: wd.weekNo,
        weekLabel: wd.weekLabel,
        startDate: wd.startDate!,
        endDate: wd.endDate!,
        daysCount: wd.daysCount || 7,
        workingDays: wd.workingDays || 6
      }))
      .sort((a, b) => a.weekNo - b.weekNo);
  }

  if (allMonthWeeks.length === 0) {
    // Fallback: construct standard month weeks if not present on weekDetails
    const monthPrefix = week.month || targetStartDate.slice(0, 7);
    if (monthPrefix === '2026-08') {
      allMonthWeeks = [
        { id: 'w-2026-08-01', month: '2026-08', weekNo: 1, weekLabel: 'Week 1 (01-07 Aug)', startDate: '2026-08-01', endDate: '2026-08-07', daysCount: 7, workingDays: 6 },
        { id: 'w-2026-08-02', month: '2026-08', weekNo: 2, weekLabel: 'Week 2 (08-14 Aug)', startDate: '2026-08-08', endDate: '2026-08-14', daysCount: 7, workingDays: 6 },
        { id: 'w-2026-08-03', month: '2026-08', weekNo: 3, weekLabel: 'Week 3 (15-21 Aug)', startDate: '2026-08-15', endDate: '2026-08-21', daysCount: 7, workingDays: 6 },
        { id: 'w-2026-08-04', month: '2026-08', weekNo: 4, weekLabel: 'Week 4 (22-31 Aug)', startDate: '2026-08-22', endDate: '2026-08-31', daysCount: 10, workingDays: 8 }
      ];
    } else {
      allMonthWeeks = [week];
    }
  }

  // Precompute daily FG target and daily component requirement for each week in the month
  const weekDailyRates = new Map<string, { dailyFgTarget: number; dailyCompReq: number; startDate: string; endDate: string }>();

  allMonthWeeks.forEach((w) => {
    const wDates = getDatesInRange(w.startDate, w.endDate);
    const wWorkingDates = wDates.filter((d) => {
      const { weekday } = formatGanttDate(d);
      return !nonWorking.includes(weekday);
    });
    const wEffectiveWorkingDays = wWorkingDates.length > 0 ? wWorkingDates.length : (wDates.length || 7);

    let wFgGrossTarget = fgTotalGrossTarget;
    if (w.id === week.id || w.weekNo === week.weekNo) {
      wFgGrossTarget = fgTotalGrossTarget;
    } else if (options?.weekGrossTargets && options.weekGrossTargets[w.id] !== undefined) {
      wFgGrossTarget = options.weekGrossTargets[w.id];
    } else if (comp.weekDetails) {
      const wd = comp.weekDetails.find((item) => item.weekId === w.id || item.weekNo === w.weekNo);
      if (wd) {
        if (wd.fgGrossTarget !== undefined) {
          wFgGrossTarget = wd.fgGrossTarget;
        } else if (bomQty > 0) {
          wFgGrossTarget = Math.round(wd.grossRequired / bomQty);
        }
      }
    }

    const wDailyFg = wEffectiveWorkingDays > 0 ? Math.ceil(wFgGrossTarget / wEffectiveWorkingDays) : 0;
    const wDailyComp = Math.round(wDailyFg * bomQty);

    weekDailyRates.set(w.id, {
      dailyFgTarget: wDailyFg,
      dailyCompReq: wDailyComp,
      startDate: w.startDate,
      endDate: w.endDate
    });
  });

  // Ensure selected week's daily rate is always available
  const selectedWeekRate = weekDailyRates.get(week.id);
  const dailyFgTarget = selectedWeekRate ? selectedWeekRate.dailyFgTarget : 0;
  const dailyCompReq = selectedWeekRate ? selectedWeekRate.dailyCompReq : 0;

  // Build map of date -> uploaded MB52 stock for this component
  const snapshotMap = buildPartStockSnapshotsByDate(
    comp.componentCode,
    options?.stockList,
    effectiveStockDate || targetStartDate,
    initialStock
  );

  // Determine full simulation start and end date across the month
  const firstMonthWeekStart = allMonthWeeks[0]?.startDate || targetStartDate;
  const lastMonthWeekEnd = allMonthWeeks[allMonthWeeks.length - 1]?.endDate || targetEndDate;
  const fullSimStartDate = targetStartDate < firstMonthWeekStart ? targetStartDate : firstMonthWeekStart;
  const fullSimEndDate = targetEndDate > lastMonthWeekEnd ? targetEndDate : lastMonthWeekEnd;

  // Identify the active reference snapshot for the viewed week (latest snapshot on or before targetEndDate)
  const snapshotDatesAsc = Array.from(snapshotMap.keys()).sort();
  const snapshotsUpToTargetEnd = snapshotDatesAsc.filter((d) => d <= targetEndDate);
  const activeBaselineDate =
    snapshotsUpToTargetEnd.length > 0
      ? snapshotsUpToTargetEnd[snapshotsUpToTargetEnd.length - 1]
      : undefined;

  // If the active baseline date is strictly prior to fullSimStartDate, anchor its stock at fullSimStartDate
  let effectiveAnchorDate = activeBaselineDate;
  if (activeBaselineDate && activeBaselineDate < fullSimStartDate) {
    snapshotMap.set(fullSimStartDate, snapshotMap.get(activeBaselineDate)!);
    effectiveAnchorDate = fullSimStartDate;
  }

  const allSimDates = getDatesInRange(fullSimStartDate, fullSimEndDate);

  // Filter schedules that apply to this component
  const schedulesToUse =
    options?.simulatedDeliveries ||
    activeDeliverySchedules.filter(
      (s) => s.componentCode === comp.componentCode && s.deliveryStatus !== 'CANCELLED'
    );

  let rollingStock = 0;
  let hasStockTakenEffect = false;

  // Simulate every day from the start of the month through the end of the month
  const fullDaySimulations: BOMGanttDaySimulation[] = allSimDates.map((dateStr, idx) => {
    const { label, weekday } = formatGanttDate(dateStr);
    const isWorking = !nonWorking.includes(weekday);

    // Find which week this date belongs to
    const matchingWeek = allMonthWeeks.find((w) => dateStr >= w.startDate && dateStr <= w.endDate) || week;
    const rateForDay = weekDailyRates.get(matchingWeek.id) || {
      dailyFgTarget,
      dailyCompReq,
      startDate: week.startDate,
      endDate: week.endDate
    };

    const dayFgPlan = isWorking ? rateForDay.dailyFgTarget : 0;
    const dayReq = isWorking ? rateForDay.dailyCompReq : 0;

    // Check if an explicit MB52 stock snapshot takes effect on this date
    // Prior to effectiveAnchorDate, ignore older superseded snapshots; from effectiveAnchorDate onward, reset on any snapshot
    const snapshotToday =
      effectiveAnchorDate && dateStr >= effectiveAnchorDate
        ? snapshotMap.get(dateStr)
        : undefined;

    // Inward arrivals on this specific date
    const arrivingDeliveries = schedulesToUse.filter((s) => s.expectedDeliveryDate === dateStr);
    const dayDeliveries: BOMGanttDayDelivery[] = arrivingDeliveries.map((s) => ({
      scheduleId: s.id,
      poNumber: s.poNumber || 'PO-PENDING',
      vendorName: s.vendorName,
      vendorCode: s.vendorCode,
      buyerName: s.buyerName,
      qty: s.promisedQty,
      deliveryStatus: s.deliveryStatus,
      notes: s.notes
    }));

    const totalInwardToday = dayDeliveries.reduce((sum, d) => sum + d.qty, 0);

    let startingStock = 0;
    let stockAfterInward = 0;
    let endingStock = 0;
    let isFrozen = false;
    let isEffectiveDate = false;
    let status: BOMGanttDayStatus = 'SAFE';
    let isStockout = false;
    let deficitToday = 0;
    let productionCapacityPct = 100;
    let supportedFgUnitsToday = dayFgPlan;

    if (!effectiveAnchorDate || dateStr < effectiveAnchorDate) {
      // Strictly prior to the active MB52 opening stock upload date: Frozen
      isFrozen = true;
    } else if (snapshotToday !== undefined) {
      // An opening stock record exists on this exact date:
      // Reset opening stock to this uploaded snapshot and roll forward from here!
      startingStock = snapshotToday;
      hasStockTakenEffect = true;
      isEffectiveDate = dateStr === activeBaselineDate || snapshotMap.has(dateStr);
    } else if (hasStockTakenEffect) {
      // Carry forward previous day's closing stock seamlessly across days and weeks!
      startingStock = rollingStock;
      isEffectiveDate = false;
    } else {
      isFrozen = true;
    }

    if (isFrozen) {
      startingStock = 0;
      stockAfterInward = totalInwardToday;
      endingStock = 0;
      status = 'FROZEN';
      isStockout = false;
      deficitToday = 0;
      productionCapacityPct = 0;
      supportedFgUnitsToday = 0;
    } else {
      stockAfterInward = startingStock + totalInwardToday;
      endingStock = stockAfterInward - dayReq;
      rollingStock = endingStock;

      deficitToday = endingStock < 0 ? Math.abs(endingStock) : 0;
      isStockout = endingStock < 0;

      if (isStockout) {
        status = 'CRITICAL_STOPPAGE'; // RED
      } else if (endingStock < safetyStock && safetyStock > 0) {
        status = 'WARNING'; // AMBER
      } else {
        status = 'SAFE'; // GREEN
      }

      if (dayReq > 0) {
        if (stockAfterInward <= 0) {
          productionCapacityPct = 0;
          supportedFgUnitsToday = 0;
        } else if (stockAfterInward < dayReq) {
          supportedFgUnitsToday = Math.floor(stockAfterInward / (bomQty || 1));
          productionCapacityPct = Math.round((stockAfterInward / dayReq) * 100);
        }
      }
    }

    return {
      date: dateStr,
      dayLabel: label,
      dayOfWeek: weekday,
      dayIndex: idx,
      isWorkingDay: isWorking,
      dailyFgPlan: dayFgPlan,
      dailyReq: dayReq,
      openingStock: startingStock,
      startingStock,
      inwardDeliveries: dayDeliveries,
      totalInwardToday,
      stockAfterInward,
      endingStock,
      deficitToday,
      isStockout,
      status,
      productionCapacityPct,
      supportedFgUnitsToday,
      isFrozen,
      isEffectiveStockDate: isEffectiveDate
    };
  });

  // Extract the slice of days for the target week / horizon
  const daySimulations = fullDaySimulations
    .filter((d) => d.date >= targetStartDate && d.date <= targetEndDate)
    .map((d, idx) => ({
      ...d,
      dayIndex: idx
    }));

  // Evaluate metrics for the target week window
  const activeDays = daySimulations.filter((d) => !d.isFrozen);
  const weekOpeningStock = activeDays.length > 0 ? activeDays[0].openingStock : initialStock;
  const totalPeriodRequirement = activeDays.reduce((sum, d) => sum + d.dailyReq, 0);
  const totalInwardScheduled = activeDays.reduce((sum, d) => sum + d.totalInwardToday, 0);
  const stockoutDays = activeDays.filter((d) => d.isStockout);
  const stockoutDaysCount = stockoutDays.length;
  const firstStockoutDate = stockoutDays[0]?.date;
  const isFeasible = stockoutDaysCount === 0;

  // Arrival evaluation analysis for this week
  const weekDeliveries = schedulesToUse.filter(
    (s) => s.expectedDeliveryDate >= targetStartDate && s.expectedDeliveryDate <= targetEndDate
  );
  const primaryDelivery = weekDeliveries[0] || schedulesToUse[0];
  let arrivalStatus: 'ON_TIME_SAFE' | 'ARRIVES_AFTER_STOCKOUT' | 'INSUFFICIENT_QTY' | 'NO_SCHEDULE' = 'ON_TIME_SAFE';
  let message = '';
  let daysDelayed: number | undefined = undefined;

  if (weekDeliveries.length === 0) {
    if (weekOpeningStock >= totalPeriodRequirement) {
      arrivalStatus = 'ON_TIME_SAFE';
      message = `Opening stock (${weekOpeningStock.toLocaleString()} ${comp.uom}) is sufficient for all active days. No delivery required.`;
    } else {
      arrivalStatus = 'NO_SCHEDULE';
      message = `🚨 CRITICAL: No vendor PO schedule exists! Stock runs out on ${formatGanttDate(firstStockoutDate || targetStartDate).full}. Line halts for ${stockoutDaysCount} days.`;
    }
  } else {
    const totalPromised = weekDeliveries.reduce((sum, s) => sum + s.promisedQty, 0);
    const netDeficit = totalPeriodRequirement - weekOpeningStock;

    if (isFeasible) {
      arrivalStatus = 'ON_TIME_SAFE';
      const dates = weekDeliveries.map((s) => formatGanttDate(s.expectedDeliveryDate).label).join(', ');
      message = `✅ ON TRACK & FEASIBLE: Expected arrival on [${dates}] (+${totalPromised.toLocaleString()} ${comp.uom}) arrives in time before stockout. Daily production of ${dailyFgTarget.toLocaleString()} FGs/day is fully protected.`;
    } else {
      if (primaryDelivery && firstStockoutDate) {
        const stockoutD = new Date(firstStockoutDate + 'T00:00:00');
        const arrivalD = new Date(primaryDelivery.expectedDeliveryDate + 'T00:00:00');
        const diffDays = Math.round((arrivalD.getTime() - stockoutD.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays > 0) {
          daysDelayed = diffDays;
          arrivalStatus = 'ARRIVES_AFTER_STOCKOUT';
          message = `❌ CRITICAL ARRIVAL DELAY: Stock runs out on ${formatGanttDate(firstStockoutDate).full}, but vendor delivery is scheduled on ${formatGanttDate(primaryDelivery.expectedDeliveryDate).full} (${diffDays} days LATE). Line will halt between ${formatGanttDate(firstStockoutDate).label} and ${formatGanttDate(primaryDelivery.expectedDeliveryDate).label}!`;
        } else if (totalPromised < netDeficit) {
          arrivalStatus = 'INSUFFICIENT_QTY';
          message = `❌ CRITICAL INSUFFICIENT BATCH: Vendor promised ${totalPromised.toLocaleString()} ${comp.uom}, but line requires ${netDeficit.toLocaleString()} ${comp.uom}. Deficit of ${(netDeficit - totalPromised).toLocaleString()} ${comp.uom} causes line stoppage on ${formatGanttDate(firstStockoutDate).full}.`;
        } else {
          arrivalStatus = 'ARRIVES_AFTER_STOCKOUT';
          message = `❌ CRITICAL TIMING GAP: Delivery on ${formatGanttDate(primaryDelivery.expectedDeliveryDate).full} cannot prevent stockout on ${formatGanttDate(firstStockoutDate).full}. Need expedited arrival by ${formatGanttDate(firstStockoutDate).label}.`;
        }
      } else {
        arrivalStatus = 'INSUFFICIENT_QTY';
        message = `❌ CRITICAL: Inward deliveries do not meet daily production requirements. Stockout occurs on ${formatGanttDate(firstStockoutDate || targetStartDate).full}.`;
      }
    }
  }

  // Critical Path Analysis (evaluated across active non-frozen days)
  const minEndingStock = activeDays.length > 0 ? Math.min(...activeDays.map((d) => d.endingStock)) : weekOpeningStock;
  const criticalStockoutDates = activeDays.filter((d) => d.isStockout).map((d) => d.date);
  const gatingDeliveryDates = activeDays.filter((d) => d.totalInwardToday > 0).map((d) => d.date);

  let slackDays = 0;
  let isCriticalPath = false;
  let delayInFgDays = 0;
  let impactOnFinalDelivery = '';
  let criticalChainSummary = '';

  if (stockoutDaysCount > 0) {
    isCriticalPath = true;
    slackDays = -stockoutDaysCount;
    delayInFgDays = stockoutDaysCount;
    impactOnFinalDelivery = `Directly halts assembly on ${formatGanttDate(firstStockoutDate || targetStartDate).label}, delaying FG delivery by ${stockoutDaysCount} day(s).`;
    criticalChainSummary = `Vendor Delivery ${primaryDelivery?.expectedDeliveryDate ? formatGanttDate(primaryDelivery.expectedDeliveryDate).label : 'Pending'} ➔ Stockout on ${formatGanttDate(firstStockoutDate || targetStartDate).label} ➔ FG Delivery delayed by ${stockoutDaysCount}d`;
  } else {
    slackDays = dailyCompReq > 0 ? Math.floor(Math.max(0, minEndingStock) / dailyCompReq) : 5;
    if (slackDays <= 1) {
      isCriticalPath = true;
      delayInFgDays = 0;
      impactOnFinalDelivery = `Zero/low float (${slackDays} day buffer). Any vendor delay will immediately delay final FG dispatch.`;
      criticalChainSummary = `Tight buffer (${slackDays}d) ➔ Critical Path Watch`;
    } else {
      isCriticalPath = false;
      delayInFgDays = 0;
      impactOnFinalDelivery = `Non-critical float: +${slackDays} day(s) buffer available before FG delivery is impacted.`;
      criticalChainSummary = `Safe float (+${slackDays}d buffer)`;
    }
  }

  return {
    componentCode: comp.componentCode,
    componentDescription: comp.componentDescription,
    fgCode,
    fgDescription,
    uom: comp.uom,
    bomQty,
    initialStock: weekOpeningStock,
    safetyStock,
    totalPeriodRequirement,
    totalInwardScheduled,
    days: daySimulations,
    isFeasible,
    firstStockoutDate,
    stockoutDaysCount,
    criticalPath: {
      isCriticalPath,
      slackDays,
      criticalDays: criticalStockoutDates,
      gatingDeliveryDates,
      impactOnFinalDelivery,
      delayInFgDays,
      recommendedExpediteDate: firstStockoutDate,
      criticalChainSummary
    },
    arrivalEvaluation: {
      primaryArrivalDate: primaryDelivery?.expectedDeliveryDate,
      primaryArrivalQty: primaryDelivery?.promisedQty,
      arrivalStatus,
      message,
      stockoutDate: firstStockoutDate,
      daysDelayed
    }
  };
}
