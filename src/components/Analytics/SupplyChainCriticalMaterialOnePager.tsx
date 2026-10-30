import React, { useState, useMemo } from 'react';
import {
  MonthlyPlanItem,
  WeekDefinition,
  BOMItem,
  VendorBuyerItem,
  MB51TransactionItem,
  StockReportItem,
  VendorDeliverySchedule,
  FGPlanFreezeItem
} from '../../types';
import { isDateInWeek } from '../../utils/weeklyMrpEngine';
import {
  Printer,
  Download,
  Search,
  Clock,
  CheckCircle2,
  CalendarRange,
  Calendar
} from 'lucide-react';

interface SupplyChainCriticalMaterialOnePagerProps {
  selectedMonth: string;
  setSelectedMonth?: (month: string) => void;
  weeks: WeekDefinition[];
  monthlyPlans: MonthlyPlanItem[];
  boms: BOMItem[];
  vendorBuyers: VendorBuyerItem[];
  mb51List: MB51TransactionItem[];
  stockList: StockReportItem[];
  vendorDeliverySchedules: VendorDeliverySchedule[];
  onUpdateVendorDeliverySchedules?: (schedules: VendorDeliverySchedule[]) => void;
  planFreezeList: FGPlanFreezeItem[];
  openingStockDate?: string;
  onNavigateToCockpit?: (weekId?: string, fgCode?: string) => void;
  onNavigateToVendorSchedule?: (compCode?: string) => void;
}

interface ShortageTableRow {
  componentCode: string;
  componentDescription: string;
  category: string;
  uom: string;
  storageLocation: string;
  availableFreeStock: number;
  requirementQty: number;
  scheduledDeliveriesQty: number;
  shortageQty: number;
  stoppageDay: string;
  stockoutWeekLabel?: string;
  impactedFGs: {
    fgCode: string;
    fgDescription: string;
    customerName: string;
    line: string;
  }[];
  vendorName: string;
  vendorCode: string;
  vendorCity: string;
  buyerName: string;
  buyerEmail: string;
}

export const SupplyChainCriticalMaterialOnePager: React.FC<SupplyChainCriticalMaterialOnePagerProps> = ({
  selectedMonth,
  weeks,
  monthlyPlans,
  boms,
  vendorBuyers,
  mb51List,
  stockList,
  vendorDeliverySchedules
}) => {
  // Horizon option: 'CURRENT_WEEK' or 'EXTEND_MONTH_END'
  const [horizon, setHorizon] = useState<'CURRENT_WEEK' | 'EXTEND_MONTH_END'>('CURRENT_WEEK');
  const [searchTerm, setSearchTerm] = useState('');

  // 1. Calendar weeks for the selected month
  const monthWeeks = useMemo(() => {
    return weeks
      .filter((w) => w.month === selectedMonth)
      .sort((a, b) => a.weekNo - b.weekNo);
  }, [weeks, selectedMonth]);

  // Current active execution week (Week 2)
  const currentWeek = useMemo(() => {
    return (
      monthWeeks.find((w) => w.weekNo === 2) ||
      monthWeeks[0] || {
        id: 'w-default',
        month: selectedMonth,
        weekNo: 2,
        weekLabel: 'Week 2 (08 - 14 Aug)',
        startDate: `${selectedMonth}-08`,
        endDate: `${selectedMonth}-14`,
        daysCount: 7,
        workingDays: 6
      }
    );
  }, [monthWeeks, selectedMonth]);

  // Prior weeks & remaining weeks through month end
  const priorWeeks = useMemo(() => {
    return monthWeeks.filter((w) => w.weekNo < currentWeek.weekNo);
  }, [monthWeeks, currentWeek]);

  const remainingWeeks = useMemo(() => {
    return monthWeeks.filter((w) => w.weekNo >= currentWeek.weekNo);
  }, [monthWeeks, currentWeek]);

  const lastWeekInMonth = useMemo(() => {
    return monthWeeks[monthWeeks.length - 1] || currentWeek;
  }, [monthWeeks, currentWeek]);

  // 2. Precompute FG Gross Targets (Plan + Prior Backlog)
  const fgGrossTargets = useMemo(() => {
    const monthPlans = monthlyPlans.filter((p) => p.month === selectedMonth);
    const map = new Map<
      string,
      {
        plan: MonthlyPlanItem;
        priorBacklog: number;
        currentWeekGrossTarget: number;
        perWeekGrossTarget: Record<string, number>;
        remainingMonthGrossTarget: number;
      }
    >();

    monthPlans.forEach((plan) => {
      // Prior backlog up to current week
      const priorBacklog = priorWeeks.reduce((sum, pw) => {
        const pTarget = plan.weeklyBreakdown[pw.id] || 0;
        const actual101 = mb51List
          .filter((tx) => {
            const isMvt101 = tx.movementType === '101';
            const isThisFG = tx.partNumber === plan.fgCode;
            const matchesWeek = tx.weekId === pw.id || isDateInWeek(tx.postingDate, pw);
            return isMvt101 && isThisFG && matchesWeek;
          })
          .reduce((s, tx) => s + tx.quantity, 0);
        return sum + Math.max(0, pTarget - actual101);
      }, 0);

      const perWeekGrossTarget: Record<string, number> = {};
      let remainingMonthGrossTarget = 0;

      remainingWeeks.forEach((w) => {
        const wPlan = plan.weeklyBreakdown[w.id] || 0;
        // Backlog is injected into the current week (Week 2)
        const wGross = w.id === currentWeek.id ? wPlan + priorBacklog : wPlan;
        perWeekGrossTarget[w.id] = wGross;
        remainingMonthGrossTarget += wGross;
      });

      map.set(plan.fgCode, {
        plan,
        priorBacklog,
        currentWeekGrossTarget: perWeekGrossTarget[currentWeek.id] || 0,
        perWeekGrossTarget,
        remainingMonthGrossTarget
      });
    });

    return map;
  }, [monthlyPlans, selectedMonth, priorWeeks, remainingWeeks, currentWeek, mb51List]);

  // 3. Compute Shortages for Current Week or Extended Till Month End
  const computedShortages = useMemo(() => {
    const uniqueCompCodes: string[] = Array.from(new Set(boms.map((b) => b.componentCode)));
    const rows: ShortageTableRow[] = [];

    uniqueCompCodes.forEach((compCode) => {
      const relevantBoms = boms.filter((b) => b.componentCode === compCode);
      if (relevantBoms.length === 0) return;

      const firstBom = relevantBoms[0];
      const category = firstBom.category || 'RM';
      const uom = firstBom.uom || 'PC';

      // Current Physical Stock (MB52)
      const stockItem = stockList.find((s) => s.partNumber === compCode);
      const availableFreeStock = stockItem ? stockItem.unrestrictedStock : 0;
      const storageLocation = stockItem?.storageLocation || 'RM01 (Central Stores)';

      // Vendor & Buyer Lookup
      const vb = vendorBuyers.find((v) => v.suppliedComponents.includes(compCode));
      const vendorCode = vb?.vendorCode || 'V-1001';
      const vendorName = vb?.vendorName || 'Primary Supplier';
      const vendorCity = vb?.city || 'Pune';
      const buyerName = vb?.buyerName || 'Category Buyer';
      const buyerEmail = vb?.buyerEmail || 'buyer@autoparts.com';

      // Consuming FGs
      const impactedFGs: ShortageTableRow['impactedFGs'] = [];
      relevantBoms.forEach((bom) => {
        const fgInfo = fgGrossTargets.get(bom.fgCode);
        if (!fgInfo) return;
        impactedFGs.push({
          fgCode: fgInfo.plan.fgCode,
          fgDescription: fgInfo.plan.fgDescription,
          customerName: fgInfo.plan.customerName || 'OEM Client',
          line: bom.line || 'Line-1'
        });
      });

      if (horizon === 'CURRENT_WEEK') {
        // --- HORIZON: CURRENT WEEK ONLY ---
        let currentWeekGrossReq = 0;
        relevantBoms.forEach((bom) => {
          const fgInfo = fgGrossTargets.get(bom.fgCode);
          if (fgInfo) {
            currentWeekGrossReq += Math.round(fgInfo.currentWeekGrossTarget * bom.qty);
          }
        });

        if (currentWeekGrossReq === 0) return;

        // Current week scheduled deliveries
        const currentWeekSchedules = vendorDeliverySchedules.filter((s) => {
          const matchComp = s.componentCode === compCode;
          const matchWeek =
            s.weekId === currentWeek.id ||
            (s.expectedDeliveryDate >= currentWeek.startDate && s.expectedDeliveryDate <= currentWeek.endDate);
          return matchComp && matchWeek;
        });

        const scheduledInward = currentWeekSchedules.reduce((sum, s) => sum + s.promisedQty, 0);
        const totalSupply = availableFreeStock + scheduledInward;
        const deficitQty = Math.max(0, currentWeekGrossReq - totalSupply);

        // Only include if there is a shortage or free stock cannot cover requirement
        const isShortage = deficitQty > 0 || (availableFreeStock < currentWeekGrossReq && scheduledInward === 0);
        if (!isShortage) return;

        // Day of stoppage calculation
        const workingDays = currentWeek.workingDays || 6;
        const dailyBurn = currentWeekGrossReq / workingDays;
        let stoppageDay = 'Stockout Day 1';
        if (dailyBurn > 0) {
          const daysCovered = Math.floor(availableFreeStock / dailyBurn);
          const stopDayNum = Math.max(1, Math.min(workingDays, daysCovered + 1));
          const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          const dayName = dayNames[stopDayNum - 1] || 'Mid-Week';
          stoppageDay = `Day ${stopDayNum} (${dayName}) - Shift 1`;
        }

        rows.push({
          componentCode: compCode,
          componentDescription: firstBom.componentDescription,
          category,
          uom,
          storageLocation,
          availableFreeStock,
          requirementQty: currentWeekGrossReq,
          scheduledDeliveriesQty: scheduledInward,
          shortageQty: deficitQty,
          stoppageDay,
          stockoutWeekLabel: 'Week 2',
          impactedFGs,
          vendorName,
          vendorCode,
          vendorCity,
          buyerName,
          buyerEmail
        });
      } else {
        // --- HORIZON: EXTEND TILL MONTH END (WEEKS 2 TO 4) ---
        let totalMonthEndGrossReq = 0;
        const perWeekCompReq: Record<string, number> = {};

        remainingWeeks.forEach((w) => {
          let wReq = 0;
          relevantBoms.forEach((bom) => {
            const fgInfo = fgGrossTargets.get(bom.fgCode);
            if (fgInfo) {
              const fgWTarget = fgInfo.perWeekGrossTarget[w.id] || 0;
              wReq += Math.round(fgWTarget * bom.qty);
            }
          });
          perWeekCompReq[w.id] = wReq;
          totalMonthEndGrossReq += wReq;
        });

        if (totalMonthEndGrossReq === 0) return;

        // Scheduled deliveries till month end
        const monthEndSchedules = vendorDeliverySchedules.filter((s) => {
          const matchComp = s.componentCode === compCode;
          const matchDateRange =
            s.expectedDeliveryDate >= currentWeek.startDate &&
            s.expectedDeliveryDate <= lastWeekInMonth.endDate;
          const matchWeekId = remainingWeeks.some((w) => w.id === s.weekId);
          return matchComp && (matchDateRange || matchWeekId);
        });

        const totalMonthEndInward = monthEndSchedules.reduce((sum, s) => sum + s.promisedQty, 0);
        const totalMonthEndSupply = availableFreeStock + totalMonthEndInward;
        const monthEndDeficitQty = Math.max(0, totalMonthEndGrossReq - totalMonthEndSupply);

        // Simulate rolling stock week-by-week to identify earliest stockout week & day
        let rolling = availableFreeStock;
        let stockoutWeek = '';
        let earliestStoppage = '';

        remainingWeeks.forEach((w) => {
          const wReq = perWeekCompReq[w.id] || 0;
          const wInward = monthEndSchedules
            .filter((s) => s.weekId === w.id || (s.expectedDeliveryDate >= w.startDate && s.expectedDeliveryDate <= w.endDate))
            .reduce((sum, s) => sum + s.promisedQty, 0);

          if (rolling + wInward < wReq && !stockoutWeek) {
            stockoutWeek = w.weekLabel;
            if (w.weekNo === currentWeek.weekNo) {
              const dailyBurn = wReq / (w.workingDays || 6);
              const daysCovered = dailyBurn > 0 ? Math.floor(rolling / dailyBurn) : 0;
              const stopDayNum = Math.max(1, Math.min(w.workingDays || 6, daysCovered + 1));
              const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
              const dayName = dayNames[stopDayNum - 1] || 'Mid-Week';
              earliestStoppage = `Week 2: Day ${stopDayNum} (${dayName})`;
            } else {
              earliestStoppage = `${w.weekLabel} (${w.startDate}) - Shift 1`;
            }
          }

          rolling = rolling + wInward - wReq;
        });

        // If there is any deficit at month end or stock runs out in any week, include in report
        const isShortage = monthEndDeficitQty > 0 || stockoutWeek !== '' || rolling < 0;
        if (!isShortage) return;

        rows.push({
          componentCode: compCode,
          componentDescription: firstBom.componentDescription,
          category,
          uom,
          storageLocation,
          availableFreeStock,
          requirementQty: totalMonthEndGrossReq,
          scheduledDeliveriesQty: totalMonthEndInward,
          shortageQty: monthEndDeficitQty > 0 ? monthEndDeficitQty : Math.abs(rolling),
          stoppageDay: earliestStoppage || `Month-End Deficit (${lastWeekInMonth.weekLabel})`,
          stockoutWeekLabel: stockoutWeek || lastWeekInMonth.weekLabel,
          impactedFGs,
          vendorName,
          vendorCode,
          vendorCity,
          buyerName,
          buyerEmail
        });
      }
    });

    // Sort by largest shortage quantity descending
    return rows.sort((a, b) => b.shortageQty - a.shortageQty);
  }, [
    boms,
    stockList,
    vendorBuyers,
    fgGrossTargets,
    horizon,
    currentWeek,
    remainingWeeks,
    vendorDeliverySchedules,
    lastWeekInMonth
  ]);

  // Search Filter
  const displayedRows = useMemo(() => {
    if (!searchTerm.trim()) return computedShortages;
    const term = searchTerm.toLowerCase();
    return computedShortages.filter((row) => {
      const matchCode = row.componentCode.toLowerCase().includes(term);
      const matchDesc = row.componentDescription.toLowerCase().includes(term);
      const matchVendor = row.vendorName.toLowerCase().includes(term);
      const matchBuyer = row.buyerName.toLowerCase().includes(term);
      const matchFG = row.impactedFGs.some(
        (fg) => fg.fgCode.toLowerCase().includes(term) || fg.fgDescription.toLowerCase().includes(term)
      );
      return matchCode || matchDesc || matchVendor || matchBuyer || matchFG;
    });
  }, [computedShortages, searchTerm]);

  // CSV Export
  const handleExportCSV = () => {
    const scopeLabel = horizon === 'CURRENT_WEEK' ? 'Current_Week_2' : 'Extended_Till_Month_End';
    const headers = [
      '#',
      'Part Number',
      'Description',
      'Category',
      'UOM',
      'Free Stock (MB52)',
      horizon === 'CURRENT_WEEK' ? 'Week Requirement' : 'Month-End Requirement (W2-W4)',
      horizon === 'CURRENT_WEEK' ? 'Scheduled Deliveries' : 'Month-End Deliveries (W2-W4)',
      'Shortage Qty',
      'Estimated Stoppage',
      'Stockout Horizon',
      'Impacted FG & Lines',
      'Vendor / Supplier',
      'Vendor Code',
      'Category Buyer'
    ];

    const rows = displayedRows.map((item, idx) => {
      const fgs = item.impactedFGs.map((fg) => `${fg.fgCode} [${fg.line}]`).join('; ');
      return [
        idx + 1,
        `"${item.componentCode}"`,
        `"${item.componentDescription}"`,
        `"${item.category}"`,
        item.uom,
        item.availableFreeStock,
        item.requirementQty,
        item.scheduledDeliveriesQty,
        -item.shortageQty,
        `"${item.stoppageDay}"`,
        `"${item.stockoutWeekLabel || ''}"`,
        `"${fgs}"`,
        `"${item.vendorName}"`,
        `"${item.vendorCode}"`,
        `"${item.buyerName}"`
      ];
    });

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Critical_Material_Shortages_${scopeLabel}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="w-full space-y-4 pb-12 font-sans text-slate-800">
      {/* Print Styles */}
      <style>{`
        @media print {
          body {
            background-color: #ffffff !important;
            color: #000000 !important;
          }
          nav, aside, header, .no-print {
            display: none !important;
          }
          .print-card {
            box-shadow: none !important;
            border: 1px solid #cbd5e1 !important;
          }
          table {
            font-size: 11px !important;
          }
          th, td {
            padding: 5px 8px !important;
            border: 1px solid #94a3b8 !important;
          }
        }
      `}</style>

      {/* Top Header & Plain Controls */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3 print-card">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold text-slate-900">
              Critical Material Shortages Report
            </h1>
            {horizon === 'CURRENT_WEEK' ? (
              <span className="px-2 py-0.5 rounded text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-200">
                Current Week ({currentWeek.weekLabel})
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded text-xs font-semibold bg-purple-100 text-purple-800 border border-purple-200">
                Extended: Current Week through Month End (08 – 31 Aug)
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {horizon === 'CURRENT_WEEK'
              ? 'Showing raw materials and components with stock deficits in the active current week.'
              : 'Showing raw materials with shortages projected across the balance of the month (Weeks 2, 3, and 4).'}
          </p>
        </div>

        {/* Horizon Toggle & Action Controls */}
        <div className="flex flex-wrap items-center gap-2 no-print">
          {/* Horizon Selection Toggle */}
          <div className="inline-flex rounded-lg border border-slate-300 p-0.5 bg-slate-100 text-xs font-semibold">
            <button
              onClick={() => setHorizon('CURRENT_WEEK')}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                horizon === 'CURRENT_WEEK'
                  ? 'bg-white text-slate-900 shadow-xs font-bold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>Current Week ({currentWeek.weekLabel.split(' ')[0]})</span>
            </button>
            <button
              onClick={() => setHorizon('EXTEND_MONTH_END')}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                horizon === 'EXTEND_MONTH_END'
                  ? 'bg-rose-600 text-white shadow-xs font-bold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <CalendarRange className="w-3.5 h-3.5" />
              <span>Extend till Month End</span>
            </button>
          </div>

          {/* Search Input */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search material, vendor, buyer..."
              className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-rose-500 w-44 sm:w-56"
            />
          </div>

          {/* Print Button */}
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold border border-slate-300 transition-colors"
            title="Print table"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print</span>
          </button>

          {/* Export CSV Button */}
          <button
            onClick={handleExportCSV}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold border border-slate-300 transition-colors"
            title="Export to CSV"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* The Single Plain Tabular Table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-xs overflow-hidden print-card">
        {/* Scope Bar */}
        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Critical Materials ({displayedRows.length} Items with Shortages)
          </span>
          <span className="text-xs text-slate-500 font-mono">
            {horizon === 'CURRENT_WEEK'
              ? `Horizon: ${currentWeek.startDate} to ${currentWeek.endDate} (${currentWeek.weekLabel})`
              : `Horizon: ${currentWeek.startDate} to ${lastWeekInMonth.endDate} (Weeks 2 through ${lastWeekInMonth.weekNo} - Month End)`}
          </span>
        </div>

        {displayedRows.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-700">No Critical Shortages Found</p>
            <p className="text-xs mt-1">
              {horizon === 'CURRENT_WEEK'
                ? 'All materials have sufficient stock or scheduled deliveries for the current week.'
                : 'All materials have sufficient coverage through month end.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 text-slate-700 font-bold border-b border-slate-300 text-[11px] uppercase tracking-wide">
                  <th className="py-2.5 px-3 w-10 text-center">#</th>
                  <th className="py-2.5 px-3 min-w-[110px]">Part Number</th>
                  <th className="py-2.5 px-3 min-w-[200px]">Description</th>
                  <th className="py-2.5 px-3 min-w-[60px]">UOM</th>
                  <th className="py-2.5 px-3 text-right min-w-[90px]">Free Stock</th>
                  <th className="py-2.5 px-3 text-right min-w-[110px]">
                    {horizon === 'CURRENT_WEEK' ? 'Week 2 Req' : 'Month-End Req'}
                  </th>
                  <th className="py-2.5 px-3 text-right min-w-[110px]">
                    {horizon === 'CURRENT_WEEK' ? 'Inward Sched' : 'Total Inward'}
                  </th>
                  <th className="py-2.5 px-3 text-right min-w-[110px] bg-rose-50 text-rose-900 font-bold">
                    {horizon === 'CURRENT_WEEK' ? 'Shortage Qty' : 'Month-End Shortage'}
                  </th>
                  <th className="py-2.5 px-3 min-w-[150px]">
                    {horizon === 'CURRENT_WEEK' ? 'Stoppage Day' : 'Earliest Stoppage'}
                  </th>
                  <th className="py-2.5 px-3 min-w-[180px]">Impacted FG & Line</th>
                  <th className="py-2.5 px-3 min-w-[160px]">Vendor / Supplier</th>
                  <th className="py-2.5 px-3 min-w-[140px]">Category Buyer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {displayedRows.map((item, index) => {
                  return (
                    <tr
                      key={item.componentCode}
                      className="hover:bg-slate-50/80 transition-colors"
                    >
                      {/* 1. Sr. No. */}
                      <td className="py-3 px-3 text-center text-slate-400 font-mono text-[11px]">
                        {index + 1}
                      </td>

                      {/* 2. Part Number */}
                      <td className="py-3 px-3 font-mono font-bold text-slate-900">
                        {item.componentCode}
                      </td>

                      {/* 3. Description */}
                      <td className="py-3 px-3 text-slate-800 font-medium">
                        {item.componentDescription}
                        <span className="block text-[10px] text-slate-400 font-normal mt-0.5">
                          {item.category} • {item.storageLocation}
                        </span>
                      </td>

                      {/* 4. UOM */}
                      <td className="py-3 px-3 text-slate-600 font-mono">
                        {item.uom}
                      </td>

                      {/* 5. Free Stock */}
                      <td className="py-3 px-3 text-right font-mono text-slate-700">
                        {item.availableFreeStock.toLocaleString()}
                      </td>

                      {/* 6. Requirement */}
                      <td className="py-3 px-3 text-right font-mono text-slate-700">
                        {item.requirementQty.toLocaleString()}
                      </td>

                      {/* 7. Inward Scheduled */}
                      <td className="py-3 px-3 text-right font-mono">
                        {item.scheduledDeliveriesQty > 0 ? (
                          <span className="text-emerald-700 font-semibold">
                            +{item.scheduledDeliveriesQty.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>

                      {/* 8. Shortage Qty */}
                      <td className="py-3 px-3 text-right font-mono font-bold text-rose-700 bg-rose-50/60 border-l border-r border-rose-100">
                        <div>-{item.shortageQty.toLocaleString()}</div>
                        {horizon === 'EXTEND_MONTH_END' && item.stockoutWeekLabel && (
                          <span className="text-[10px] font-semibold text-rose-600 block mt-0.5">
                            Hits {item.stockoutWeekLabel}
                          </span>
                        )}
                      </td>

                      {/* 9. Stoppage Day / Earliest Stoppage */}
                      <td className="py-3 px-3 text-slate-700">
                        <div className="flex items-center gap-1 font-medium text-rose-800">
                          <Clock className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                          <span>{item.stoppageDay}</span>
                        </div>
                      </td>

                      {/* 10. Impacted FG & Line */}
                      <td className="py-3 px-3">
                        <div className="space-y-0.5">
                          {item.impactedFGs.map((fg) => (
                            <div key={fg.fgCode} className="text-[11px] text-slate-800">
                              <span className="font-semibold">{fg.customerName || fg.fgCode}:</span>{' '}
                              <span className="text-slate-600">{fg.line}</span>
                            </div>
                          ))}
                        </div>
                      </td>

                      {/* 11. Vendor / Supplier */}
                      <td className="py-3 px-3 text-slate-800">
                        <div className="font-medium text-xs">{item.vendorName}</div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {item.vendorCode} • {item.vendorCity}
                        </div>
                      </td>

                      {/* 12. Category Buyer */}
                      <td className="py-3 px-3 text-slate-800">
                        <div className="font-medium text-xs">{item.buyerName}</div>
                        <div className="text-[10px] text-slate-400">
                          {item.buyerEmail}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Table Summary Footer */}
        <div className="p-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between text-xs text-slate-600 gap-2">
          <div>
            Showing <strong className="text-slate-900">{displayedRows.length}</strong> critical shortage material(s){' '}
            {horizon === 'CURRENT_WEEK' ? 'for Current Week (Week 2)' : 'projected through Month End (Weeks 2–4)'}.
          </div>
          <div className="text-slate-500 font-mono text-[11px]">
            {horizon === 'CURRENT_WEEK'
              ? 'Shortage = Free Stock + Scheduled Week 2 Inwards - Week 2 Requirement'
              : 'Shortage = Free Stock + Total Month-End Inwards - Cumulative Month-End Requirement'}
          </div>
        </div>
      </div>
    </div>
  );
};
