import React from 'react';
import { UserRole, USER_ROLES } from '../types';
import {
  Menu,
  ShieldCheck,
  Layers,
  AlertTriangle,
  RotateCcw,
  Calendar,
  Factory
} from 'lucide-react';

interface HeaderProps {
  currentRole: UserRole;
  setCurrentRole: (role: UserRole) => void;
  selectedMonth: string;
  setSelectedMonth: (month: string) => void;
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onResetData: () => void;
  criticalShortageCount: number;
  activeViewTitle?: string;
  globalSearchTerm: string;
  setGlobalSearchTerm: (term: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentRole,
  setCurrentRole,
  selectedMonth,
  setSelectedMonth,
  isSidebarCollapsed,
  onToggleSidebar,
  onResetData,
  criticalShortageCount,
  activeViewTitle = 'Weekly MRP & Supply Operations',
  globalSearchTerm,
  setGlobalSearchTerm
}) => {
  const currentRoleDef = USER_ROLES.find((r) => r.id === currentRole) || USER_ROLES[0];

  return (
    <header className="bg-slate-950 text-slate-100 border-b border-slate-800 sticky top-0 z-20 shadow-sm">
      <div className="px-5 py-3 flex items-center justify-between gap-4">
        {/* Left: Sidebar Toggle + Active View Title */}
        <div className="flex items-center gap-3.5 min-w-0">
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition cursor-pointer shrink-0"
            title="Toggle Sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-lg border border-blue-500/30 bg-blue-950/40 text-blue-200 text-sm font-bold truncate">
            <Layers className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="truncate">{activeViewTitle}</span>
          </div>
        </div>

        {/* Middle: Global Search */}
        <div className="flex-1 max-w-lg mx-4">
          <input
            type="text"
            placeholder="Search parts, descriptions, or vendors across all views..."
            value={globalSearchTerm}
            onChange={(e) => setGlobalSearchTerm(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 text-slate-100 text-sm px-4 py-2 rounded-lg focus:outline-none focus:border-blue-500 placeholder-slate-400"
          />
        </div>

        {/* Right: Quick Indicators & Controls */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Critical Shortages Badges */}
          {criticalShortageCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-red-950/70 border border-red-800 text-red-300 rounded-lg text-xs sm:text-sm font-mono font-bold">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
              {criticalShortageCount} Deficits
            </div>
          )}

          {/* Month Selector */}
          <div className="flex items-center gap-2 bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-lg text-sm">
            <Calendar className="w-4 h-4 text-slate-400" />
            <span className="text-slate-400 hidden sm:inline text-xs font-medium">Month:</span>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="bg-transparent border-none text-white text-sm font-mono font-bold focus:outline-none cursor-pointer"
            />
          </div>

          {/* Role selector */}
          <div className="hidden sm:flex items-center gap-2 bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-lg text-sm">
            <ShieldCheck className="w-4 h-4 text-blue-400" />
            <select
              value={currentRole}
              onChange={(e) => setCurrentRole(e.target.value as UserRole)}
              className="bg-transparent border-none text-white text-sm font-semibold focus:outline-none cursor-pointer"
            >
              {USER_ROLES.map((role) => (
                <option key={role.id} value={role.id} className="bg-slate-900 text-white">
                  {role.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </header>
  );
};
