import { cn } from '../lib/utils';

export const NavItem = ({ icon: Icon, label, active, onClick, collapsed }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "w-full flex items-center gap-4 px-5 py-4 transition-all duration-300 rounded-2xl relative group",
      active
        ? "bg-blue-600 text-white shadow-xl shadow-blue-900/40"
        : "text-slate-500 hover:bg-white/5 hover:text-white",
      collapsed && "justify-center px-0"
    )}
  >
    <Icon size={22} className={cn("transition-transform duration-300", active && "scale-110")} />
    {!collapsed && <span className="font-bold tracking-tight">{label}</span>}
    {collapsed && (
      <div className="absolute left-full ml-4 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 whitespace-nowrap">
        {label}
      </div>
    )}
  </button>
);
