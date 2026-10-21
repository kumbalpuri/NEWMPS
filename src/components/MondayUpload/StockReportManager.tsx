import React, { useState, useRef, useEffect } from 'react';
import {
  Package,
  Upload,
  Plus,
  Download,
  Search,
  Filter,
  AlertTriangle,
  CheckCircle2,
  Boxes,
  ShieldCheck,
  Edit2,
  Trash2,
  Layers,
  Calendar,
  CheckSquare,
  Square,
  X,
  Lock
} from 'lucide-react';
import { StockReportItem } from '../../types';
import {
  isStockRecordReadOnly,
  isDateBeforeMB52Upload,
  getLineItemMB52UploadDate,
  normalizeToISODate
} from '../../utils/mb52LockEngine';

interface StockReportManagerProps {
  stockList: StockReportItem[];
  onUpdateStock: (items: StockReportItem[]) => void;
  openingStockDate?: string;
  onUpdateOpeningStockDate?: (date: string) => void;
}

export const StockReportManager: React.FC<StockReportManagerProps> = ({
  stockList,
  onUpdateStock,
  openingStockDate = new Date().toISOString().slice(0, 10),
  onUpdateOpeningStockDate
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'FG' | 'RM' | 'PM'>('ALL');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<StockReportItem | null>(null);

  // Checkbox selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  // Upload date defaulting to today's date
  const [uploadStockDate, setUploadStockDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [uploadMode, setUploadMode] = useState<'REPLACE' | 'APPEND'>('REPLACE');

  const [formData, setFormData] = useState<Partial<StockReportItem>>({
    partNumber: '',
    materialDescription: '',
    materialType: 'RM',
    unrestrictedStock: 1000,
    inQualityInsp: 0,
    blocked: 0,
    storageLocation: 'SL01',
    uom: 'PC',
    safetyStock: 500,
    plant: '1001',
    stockDate: openingStockDate || new Date().toISOString().slice(0, 10)
  });

  const [csvInput, setCsvInput] = useState('');

  // Auto derive material type based on user requirement: startsWith('7') -> FG, else RM/PM
  const deriveMaterialType = (part: string, category?: string): 'FG' | 'RM' | 'PM' => {
    if (part.startsWith('7')) return 'FG';
    if (category === 'PM' || part.startsWith('8')) return 'PM';
    return 'RM';
  };

  const filteredStocks = stockList.filter((item) => {
    const term = searchTerm.trim().toLowerCase();
    const matchesSearch =
      !term ||
      item.partNumber.toLowerCase().includes(term) ||
      item.materialDescription.toLowerCase().includes(term) ||
      item.storageLocation.toLowerCase().includes(term) ||
      (item.stockDate && item.stockDate.toLowerCase().includes(term));

    const matchesType = typeFilter === 'ALL' || item.materialType === typeFilter;

    return matchesSearch && matchesType;
  });

  const isItemReadOnly = (item: StockReportItem) => {
    return isStockRecordReadOnly(item, stockList, openingStockDate);
  };

  // Checkbox selection logic - only selectable (non-read-only) items
  const selectableFiltered = filteredStocks.filter((item) => !isItemReadOnly(item));
  const isAllSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((item) => selectedIds.has(item.id));
  const isSomeSelected =
    selectableFiltered.some((item) => selectedIds.has(item.id)) && !isAllSelected;

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = isSomeSelected;
    }
  }, [isSomeSelected]);

  const handleToggleSelectAll = () => {
    if (isAllSelected) {
      // Deselect all selectable filtered items
      const next = new Set(selectedIds);
      selectableFiltered.forEach((item) => next.delete(item.id));
      setSelectedIds(next);
    } else {
      // Select all selectable filtered items
      const next = new Set(selectedIds);
      selectableFiltered.forEach((item) => next.add(item.id));
      setSelectedIds(next);
    }
  };

  const handleToggleSelect = (id: string) => {
    const item = stockList.find((s) => s.id === id);
    if (item && isItemReadOnly(item)) return; // Block selecting read-only records
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (
      window.confirm(
        `Are you sure you want to delete ${count} selected stock record${
          count > 1 ? 's' : ''
        }?`
      )
    ) {
      // Only delete non-readonly records
      const remaining = stockList.filter(
        (item) => !selectedIds.has(item.id) || isItemReadOnly(item)
      );
      onUpdateStock(remaining);
      setSelectedIds(new Set());
    }
  };

  // KPI calculations
  const totalFGStock = stockList
    .filter((s) => s.materialType === 'FG' && !s.isPreviousUpload)
    .reduce((sum, s) => sum + s.unrestrictedStock, 0);

  const totalRMStock = stockList
    .filter((s) => s.materialType === 'RM' && !s.isPreviousUpload)
    .reduce((sum, s) => sum + s.unrestrictedStock, 0);

  const totalPMStock = stockList
    .filter((s) => s.materialType === 'PM' && !s.isPreviousUpload)
    .reduce((sum, s) => sum + s.unrestrictedStock, 0);

  const lowStockCount = stockList.filter(
    (s) => !isItemReadOnly(s) && s.unrestrictedStock < s.safetyStock
  ).length;

  const handleOpenAddModal = (existing?: StockReportItem) => {
    if (existing && isItemReadOnly(existing)) {
      alert(`This stock record is read-only because it was uploaded before the MB52 upload baseline date (${existing.stockDate || openingStockDate}). All prior data is locked.`);
      return;
    }
    if (existing) {
      setEditingItem(existing);
      setFormData(existing);
    } else {
      setEditingItem(null);
      setFormData({
        partNumber: '',
        materialDescription: '',
        materialType: 'RM',
        unrestrictedStock: 1000,
        inQualityInsp: 0,
        blocked: 0,
        storageLocation: 'SL01-Raw Materials',
        uom: 'PC',
        safetyStock: 500,
        plant: '1001',
        stockDate: openingStockDate || new Date().toISOString().slice(0, 10)
      });
    }
    setIsAddModalOpen(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.partNumber || formData.unrestrictedStock === undefined) {
      alert('Please fill part number and unrestricted stock quantity.');
      return;
    }

    const type = deriveMaterialType(
      formData.partNumber,
      formData.materialType
    );

    const recordDate =
      normalizeToISODate(formData.stockDate || openingStockDate) || new Date().toISOString().slice(0, 10);

    // Call opening stock date updater so global baseline is synchronized
    onUpdateOpeningStockDate?.(recordDate);

    const targetPart = formData.partNumber.trim();

    if (editingItem) {
      const updated = stockList.map((s) => {
        if (s.id === editingItem.id) {
          return {
            ...s,
            ...formData,
            partNumber: targetPart,
            materialType: type,
            unrestrictedStock: Number(formData.unrestrictedStock) || 0,
            stockDate: recordDate,
            uploadDate: recordDate,
            lastUpdated: recordDate,
            isReadOnly: false,
            isPreviousUpload: false
          } as StockReportItem;
        }
        // If there's another record for the exact same part, date, and storage location, supersede it
        if (s.partNumber === targetPart && s.id !== editingItem.id) {
          const sDate = normalizeToISODate(s.uploadDate || s.stockDate);
          if (sDate === recordDate && s.storageLocation === formData.storageLocation) {
            return {
              ...s,
              isPreviousUpload: true
            };
          }
        }
        return s;
      });
      onUpdateStock(updated);
    } else {
      const newItem: StockReportItem = {
        id: `stk-${Date.now()}`,
        partNumber: targetPart,
        materialDescription: formData.materialDescription?.trim() || 'Material',
        materialType: type,
        unrestrictedStock: Number(formData.unrestrictedStock) || 0,
        inQualityInsp: Number(formData.inQualityInsp) || 0,
        blocked: Number(formData.blocked) || 0,
        storageLocation: formData.storageLocation || 'SL01',
        uom: formData.uom || 'PC',
        safetyStock: Number(formData.safetyStock) || 500,
        plant: formData.plant || '1001',
        stockDate: recordDate,
        uploadDate: recordDate,
        lastUpdated: recordDate,
        isReadOnly: false,
        isPreviousUpload: false
      };

      // Supersede only records matching the exact same date and storage location
      const updatedExisting = stockList.map((s) => {
        if (s.partNumber === targetPart) {
          const sDate = normalizeToISODate(s.uploadDate || s.stockDate);
          if (sDate === recordDate && s.storageLocation === newItem.storageLocation) {
            return {
              ...s,
              isPreviousUpload: true
            };
          }
        }
        return s;
      });

      onUpdateStock([newItem, ...updatedExisting]);
    }
    setIsAddModalOpen(false);
  };

  const handleDelete = (id: string) => {
    const item = stockList.find((s) => s.id === id);
    if (item && isItemReadOnly(item)) {
      alert('Cannot delete this stock record: data prior to MB52 upload baseline date is read-only.');
      return;
    }
    if (window.confirm('Delete this stock record?')) {
      onUpdateStock(stockList.filter((s) => s.id !== id));
      if (selectedIds.has(id)) {
        const next = new Set(selectedIds);
        next.delete(id);
        setSelectedIds(next);
      }
    }
  };

  const handleCSVUpload = (e: React.FormEvent) => {
    e.preventDefault();
    if (!csvInput.trim()) {
      alert('Please paste CSV or tab-separated stock data.');
      return;
    }

    const dateToApply = uploadStockDate || new Date().toISOString().slice(0, 10);

    const lines = csvInput.trim().split('\n');
    const parsed: StockReportItem[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (
        i === 0 &&
        (line.toLowerCase().includes('part') ||
          line.toLowerCase().includes('stock') ||
          line.toLowerCase().includes('material'))
      ) {
        continue;
      }

      const delimiter = line.includes('\t') ? '\t' : ',';
      const parts = line.split(delimiter).map((s) => s.replace(/^"|"$/g, '').trim());

      // Format: Part Number, Description, Unrestricted Stock, Safety Stock, UOM, SLOC
      if (parts.length >= 2) {
        const partNo = parts[0];
        const desc = parts.length >= 3 ? parts[1] : `Material ${partNo}`;
        const stockStr = parts.length >= 3 ? parts[2] : parts[1];
        const stock = parseFloat(stockStr.replace(/,/g, '')) || 0;
        const safetyStr = parts.length >= 4 ? parts[3] : '500';
        const safety = parseFloat(safetyStr.replace(/,/g, '')) || 500;
        const uom = parts.length >= 5 ? parts[4] : 'PC';
        const sloc = parts.length >= 6 ? parts[5] : 'SL01';

        if (partNo) {
          const type = deriveMaterialType(partNo);
          parsed.push({
            id: `stk-${Date.now()}-${i}`,
            partNumber: partNo,
            materialDescription: desc,
            materialType: type,
            unrestrictedStock: stock,
            inQualityInsp: 0,
            blocked: 0,
            safetyStock: safety,
            storageLocation: sloc,
            uom,
            plant: '1001',
            stockDate: dateToApply,
            uploadDate: dateToApply,
            lastUpdated: dateToApply,
            isReadOnly: false,
            isPreviousUpload: false
          });
        }
      }
    }

    if (parsed.length === 0) {
      alert('No valid stock records found.');
      return;
    }

    // Set opening stock baseline date across app
    onUpdateOpeningStockDate?.(dateToApply);

    // Rule: Whenever updating MB52 with date of upload:
    // 1. All previous uploads become zero
    // 2. From date of upload, all prior data becomes read-only for that line item for which upload was made
    const previousZeroed: StockReportItem[] = stockList
      .filter((prev) => {
        // Avoid duplicate entry if same item and date is present in newly parsed upload
        return !parsed.some(
          (p) => p.partNumber === prev.partNumber && p.stockDate === (prev.uploadDate || prev.stockDate)
        );
      })
      .map((prev) => ({
        ...prev,
        id: prev.isPreviousUpload ? prev.id : `prev-zeroed-${prev.id}`,
        unrestrictedStock: 0,
        inQualityInsp: 0,
        blocked: 0,
        isReadOnly: true,
        isPreviousUpload: true
      }));

    onUpdateStock([...parsed, ...previousZeroed]);

    setSelectedIds(new Set());
    setIsUploadModalOpen(false);
    setCsvInput('');
  };

  const handleExportCSV = () => {
    const headers = [
      'Part Number',
      'Material Description',
      'Type',
      'Unrestricted Stock',
      'In Quality Insp',
      'Blocked Stock',
      'Safety Stock',
      'UOM',
      'Storage Location',
      'Plant',
      'Opening Stock Date'
    ];

    const rows = filteredStocks.map((s) => [
      `"${s.partNumber}"`,
      `"${s.materialDescription}"`,
      `"${s.materialType}"`,
      s.unrestrictedStock,
      s.inQualityInsp,
      s.blocked,
      s.safetyStock,
      `"${s.uom}"`,
      `"${s.storageLocation}"`,
      `"${s.plant}"`,
      `"${s.stockDate || s.lastUpdated || openingStockDate}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Stock_Report_MB52_${openingStockDate || new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-600">
            <Boxes className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-slate-900">Monday Upload: Stock Report (SAP MB52)</h1>
              {/* Baseline Opening Stock Date Badge */}
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-teal-50 text-teal-800 border border-teal-200 rounded-lg text-xs font-semibold">
                <Calendar className="w-3.5 h-3.5 text-teal-600" />
                <span>Opening Stock As Of:</span>
                <input
                  type="date"
                  value={openingStockDate}
                  onChange={(e) => onUpdateOpeningStockDate?.(e.target.value)}
                  className="bg-white border border-teal-300 rounded px-1.5 py-0.5 text-xs font-mono font-bold text-teal-900 focus:outline-none focus:ring-1 focus:ring-teal-500 cursor-pointer"
                  title="Click to change baseline opening stock date for all calculations"
                />
              </div>
            </div>
            <p className="text-sm text-slate-500 mt-0.5">
              Current on-hand unrestricted inventory balances. Calculations across Weekly MRP, Monday Review & Shortages roll forward from this baseline date.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              setUploadStockDate(new Date().toISOString().slice(0, 10));
              setIsUploadModalOpen(true);
            }}
            className="flex items-center gap-2 px-3.5 py-2 text-sm font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors shadow-sm"
          >
            <Upload className="w-4 h-4 text-teal-600" />
            Upload MB52 Stock Data
          </button>
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <Download className="w-4 h-4 text-slate-500" />
            Export CSV
          </button>
          <button
            onClick={() => handleOpenAddModal()}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Stock Item
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium">Finished Goods (FG) Stock</div>
          <div className="text-2xl font-bold text-slate-900 mt-1 font-mono">
            {totalFGStock.toLocaleString()} <span className="text-xs text-slate-500 font-normal">Units</span>
          </div>
          <div className="text-xs text-blue-600 font-semibold mt-1">Part prefix starting with '7'</div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium">Raw Materials (RM) Stock</div>
          <div className="text-2xl font-bold text-slate-900 mt-1 font-mono">
            {totalRMStock.toLocaleString()} <span className="text-xs text-slate-500 font-normal">Units</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">On-hand usable stock</div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium">Packaging Materials (PM)</div>
          <div className="text-2xl font-bold text-slate-900 mt-1 font-mono">
            {totalPMStock.toLocaleString()} <span className="text-xs text-slate-500 font-normal">Units</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Liner bags, cartons & boxes</div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium">Below Safety Stock</div>
          <div className="text-2xl font-bold text-amber-600 mt-1 font-mono">
            {lowStockCount} Materials
          </div>
          <div className="text-xs text-slate-500 mt-1">Requires buyer replenishment</div>
        </div>
      </div>

      {/* Bulk Delete / Selection Bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-teal-50 border border-teal-300 p-3.5 rounded-xl text-sm shadow-sm animate-in fade-in">
          <div className="flex items-center gap-2.5 text-teal-900 font-semibold">
            <CheckCircle2 className="w-5 h-5 text-teal-600" />
            <span>
              {selectedIds.size} stock record{selectedIds.size > 1 ? 's' : ''} selected
            </span>
            <span className="text-xs text-teal-700 font-normal">
              (out of {filteredStocks.length} visible)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors font-medium"
            >
              Deselect All
            </button>
            <button
              type="button"
              onClick={handleDeleteSelected}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Delete Selected ({selectedIds.size})
            </button>
          </div>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
          <button
            onClick={() => setTypeFilter('ALL')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              typeFilter === 'ALL'
                ? 'bg-white text-teal-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All Inventory ({stockList.length})
          </button>
          <button
            onClick={() => setTypeFilter('FG')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              typeFilter === 'FG'
                ? 'bg-white text-blue-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Finished Goods (FG)
          </button>
          <button
            onClick={() => setTypeFilter('RM')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              typeFilter === 'RM'
                ? 'bg-white text-emerald-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Raw Materials (RM)
          </button>
          <button
            onClick={() => setTypeFilter('PM')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              typeFilter === 'PM'
                ? 'bg-white text-purple-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Packaging (PM)
          </button>
        </div>

        {/* Real-time Text-Based Search Input */}
        <div className="flex items-center gap-2 w-full md:w-auto">
          <div className="relative min-w-[280px] w-full md:w-80">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by material code or description..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchTerm('');
              }}
              className="w-full pl-9 pr-8 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:bg-white transition-all shadow-inner"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-0.5 rounded transition-colors"
                title="Clear search (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {searchTerm.trim() && (
            <span className="hidden sm:inline-flex shrink-0 items-center px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg">
              {filteredStocks.length} matching
            </span>
          )}
        </div>
      </div>

      {/* Stock Table with Checkboxes */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs uppercase tracking-wider font-semibold">
                {/* Select All Checkbox */}
                <th className="py-3.5 px-4 w-12 text-center">
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      ref={selectAllCheckboxRef}
                      checked={isAllSelected}
                      onChange={handleToggleSelectAll}
                      className="w-4 h-4 text-teal-600 rounded border-slate-300 focus:ring-teal-500 cursor-pointer"
                      title={isAllSelected ? 'Deselect all visible records' : 'Select all visible records'}
                    />
                  </div>
                </th>
                <th className="py-3.5 px-4">Part Number</th>
                <th className="py-3.5 px-4">Material Description</th>
                <th className="py-3.5 px-4 text-center">Type</th>
                <th className="py-3.5 px-4 text-right">Unrestricted Stock</th>
                <th className="py-3.5 px-4 text-right">In Quality</th>
                <th className="py-3.5 px-4 text-right">Safety Stock</th>
                <th className="py-3.5 px-4 text-center">UOM</th>
                <th className="py-3.5 px-4">Storage Location</th>
                <th className="py-3.5 px-4 text-center">Opening Date</th>
                <th className="py-3.5 px-4 text-center">Stock Health</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filteredStocks.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-slate-500">
                    <div className="flex flex-col items-center justify-center max-w-sm mx-auto">
                      <Search className="w-8 h-8 text-slate-300 mb-2" />
                      <p className="text-sm font-semibold text-slate-700">
                        {searchTerm.trim()
                          ? `No stock items match "${searchTerm.trim()}"`
                          : 'No stock records match your filter.'}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        {searchTerm.trim()
                          ? 'Try searching with a different material code or keyword.'
                          : 'Change the type filter or add new stock items.'}
                      </p>
                      {searchTerm.trim() && (
                        <button
                          type="button"
                          onClick={() => setSearchTerm('')}
                          className="mt-3 px-3 py-1.5 text-xs font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors"
                        >
                          Clear search filter
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredStocks.map((stock) => {
                  const isReadOnly = isItemReadOnly(stock);
                  const isLow = !isReadOnly && stock.unrestrictedStock < stock.safetyStock;
                  const isSelected = selectedIds.has(stock.id);

                  return (
                    <tr
                      key={stock.id}
                      className={`transition-colors ${
                        isReadOnly
                          ? 'bg-slate-50/70 text-slate-500'
                          : isSelected
                          ? 'bg-teal-50/70 hover:bg-teal-50'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      {/* Row Checkbox */}
                      <td className="py-3 px-4 w-12 text-center">
                        <div className="flex items-center justify-center">
                          {isReadOnly ? (
                            <div title="Read-Only: Historical data before MB52 upload baseline is locked">
                              <Lock className="w-3.5 h-3.5 text-slate-400" />
                            </div>
                          ) : (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleSelect(stock.id)}
                              className="w-4 h-4 text-teal-600 rounded border-slate-300 focus:ring-teal-500 cursor-pointer"
                              aria-label={`Select ${stock.partNumber}`}
                            />
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-slate-900 text-xs">
                        <span
                          className={`px-1.5 py-0.5 rounded border ${
                            isReadOnly
                              ? 'bg-slate-100 text-slate-600 border-slate-300'
                              : stock.materialType === 'FG'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-slate-50 text-slate-800 border-slate-200'
                          }`}
                        >
                          {stock.partNumber}
                        </span>
                      </td>
                      <td className={`py-3 px-4 font-medium text-xs ${isReadOnly ? 'text-slate-500 italic' : 'text-slate-800'}`}>
                        {stock.materialDescription}
                        {stock.isPreviousUpload && (
                          <span className="ml-2 text-[10px] text-slate-400 font-normal">
                            (Zeroed Previous Upload)
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-semibold ${
                            isReadOnly
                              ? 'bg-slate-200 text-slate-600'
                              : stock.materialType === 'FG'
                              ? 'bg-blue-100 text-blue-800'
                              : stock.materialType === 'PM'
                              ? 'bg-purple-100 text-purple-800'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {stock.materialType}
                        </span>
                      </td>
                      <td className={`py-3 px-4 text-right font-mono font-bold ${isReadOnly ? 'text-slate-400' : 'text-slate-900'}`}>
                        {stock.unrestrictedStock.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-500 text-xs">
                        {stock.inQualityInsp.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-600 text-xs">
                        {stock.safetyStock.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-center text-xs font-medium text-slate-500">
                        {stock.uom}
                      </td>
                      <td className="py-3 px-4 text-xs font-mono text-slate-600">
                        {stock.storageLocation}
                      </td>
                      <td className="py-3 px-4 text-center font-mono text-xs text-slate-600">
                        <span className="inline-flex items-center gap-1">
                          {isReadOnly && <Lock className="w-2.5 h-2.5 text-slate-400" />}
                          {stock.stockDate || stock.lastUpdated?.slice(0, 10) || openingStockDate}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        {isReadOnly ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs font-semibold border border-slate-300">
                            <Lock className="w-3 h-3 text-slate-500" />
                            {stock.isPreviousUpload ? 'Zeroed Past' : 'Read-Only'}
                          </span>
                        ) : isLow ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-xs font-semibold border border-amber-200">
                            <AlertTriangle className="w-3 h-3 text-amber-600" />
                            Low Stock
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded text-xs font-semibold border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                            Active Baseline
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {isReadOnly ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-1 bg-slate-100 border border-slate-200 rounded text-[11px] text-slate-400 font-medium"
                              title={`Read-Only: Upload date (${stock.stockDate || openingStockDate}) is prior to active baseline. Data before upload is locked.`}
                            >
                              <Lock className="w-3 h-3 text-slate-400" />
                              Locked
                            </span>
                          ) : (
                            <>
                              <button
                                onClick={() => handleOpenAddModal(stock)}
                                className="p-1.5 text-slate-400 hover:text-teal-600 rounded transition-colors"
                                title="Edit Stock"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDelete(stock.id)}
                                className="p-1.5 text-slate-400 hover:text-red-600 rounded transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
            <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
              <Boxes className="w-5 h-5 text-teal-600" />
              {editingItem ? 'Edit Stock Balance' : 'Add On-Hand Stock Record'}
            </h2>

            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Part Number *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.partNumber || ''}
                    onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
                    placeholder="e.g. 7.06496.03.0 or 100201"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 font-mono"
                  />
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    Prefix '7' = FG, other = RM/PM
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Material Description *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.materialDescription || ''}
                    onChange={(e) => setFormData({ ...formData, materialDescription: e.target.value })}
                    placeholder="e.g. Vacuum Pump Panther 2.0L"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Opening Stock Date *
                  </label>
                  <input
                    type="date"
                    required
                    value={formData.stockDate || openingStockDate}
                    onChange={(e) => setFormData({ ...formData, stockDate: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Storage Location (SLOC)
                  </label>
                  <input
                    type="text"
                    value={formData.storageLocation || 'SL01'}
                    onChange={(e) => setFormData({ ...formData, storageLocation: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Unrestricted Stock *
                  </label>
                  <input
                    type="number"
                    required
                    value={formData.unrestrictedStock ?? 1000}
                    onChange={(e) =>
                      setFormData({ ...formData, unrestrictedStock: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    In Quality Insp
                  </label>
                  <input
                    type="number"
                    value={formData.inQualityInsp ?? 0}
                    onChange={(e) =>
                      setFormData({ ...formData, inQualityInsp: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Safety Stock
                  </label>
                  <input
                    type="number"
                    value={formData.safetyStock ?? 500}
                    onChange={(e) =>
                      setFormData({ ...formData, safetyStock: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    UOM
                  </label>
                  <input
                    type="text"
                    value={formData.uom || 'PC'}
                    onChange={(e) => setFormData({ ...formData, uom: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Plant
                  </label>
                  <input
                    type="text"
                    value={formData.plant || '1001'}
                    onChange={(e) => setFormData({ ...formData, plant: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm transition-colors"
                >
                  Save Stock Record
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload CSV Modal with Opening Stock Date */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-xl w-full p-6 border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
            <h2 className="text-lg font-bold text-slate-900 mb-2 flex items-center gap-2">
              <Upload className="w-5 h-5 text-teal-600" />
              Upload Stock Report (SAP MB52)
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Enter the opening stock snapshot date and paste your SAP inventory export below.
            </p>

            <form onSubmit={handleCSVUpload} className="space-y-4">
              {/* Date Input for Opening Stock */}
              <div className="bg-teal-50/70 border border-teal-200 rounded-xl p-3.5 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <label className="block text-xs font-bold text-teal-900 flex items-center gap-1.5">
                    <Calendar className="w-4 h-4 text-teal-700" />
                    Opening Stock Date (Baseline Date) *
                  </label>
                  <input
                    type="date"
                    required
                    value={uploadStockDate}
                    onChange={(e) => setUploadStockDate(e.target.value)}
                    className="px-3 py-1.5 text-xs border border-teal-300 rounded-lg bg-white font-mono font-bold text-teal-950 focus:outline-none focus:ring-2 focus:ring-teal-500 shadow-sm"
                  />
                </div>
                <p className="text-[11px] text-teal-800 leading-relaxed">
                  The system will treat this date as the <strong>Opening Stock baseline</strong>.
                </p>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[11px] text-amber-900 flex items-start gap-2">
                  <Lock className="w-4 h-4 text-amber-700 mt-0.5 flex-shrink-0" />
                  <div>
                    <strong>MB52 Upload Policy:</strong> All previous uploads will automatically become <strong>zero</strong>. From this upload date, all prior data will become <strong>read-only & locked</strong> for the line items uploaded. Buyers can only add delivery schedules for future dates on or after this date.
                  </div>
                </div>
              </div>

              {/* Upload Mode Choice */}
              <div className="flex items-center gap-4 text-xs font-medium text-slate-700">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="uploadMode"
                    checked={uploadMode === 'REPLACE'}
                    onChange={() => setUploadMode('REPLACE')}
                    className="text-teal-600 focus:ring-teal-500"
                  />
                  <span>Upload & set prior records to zero</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="uploadMode"
                    checked={uploadMode === 'APPEND'}
                    onChange={() => setUploadMode('APPEND')}
                    className="text-teal-600 focus:ring-teal-500"
                  />
                  <span>Append to existing records</span>
                </label>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Stock Data (CSV / TSV)
                </label>
                <textarea
                  rows={7}
                  required
                  value={csvInput}
                  onChange={(e) => setCsvInput(e.target.value)}
                  placeholder={`PartNumber,Description,UnrestrictedStock,SafetyStock,UOM,SLOC\n7.06496.03.0,Vacuum Pump Panther 2.0L,1200,500,PC,FG01\n100201,Die-Cast Aluminum Housing,2200,1000,PC,SL01\n100202,Precision Rotor Assembly,3100,1500,PC,SL01`}
                  className="w-full p-3 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-teal-500 font-mono"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Expected columns: Part Number, Description, Unrestricted Stock, Safety Stock, UOM, SLOC
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsUploadModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-sm transition-colors"
                >
                  Import Stock as of {uploadStockDate}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
