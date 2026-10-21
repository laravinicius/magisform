import { useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatUnit } from '../utils/format';

interface UnitCycleProps {
  value: string;
  onChange: (unit: string) => void;
  options: string[];
  disabled?: boolean;
}

export const INGREDIENT_UNITS = ['g', 'mcg', 'mg', 'ml', 'ui', '%'];
export const BUDGET_UNITS = ['caps', 'caps s.l.', 'doses', 'g', 'ml', 'sachê', '%'];

export function UnitCycle({ value, onChange, options, disabled }: UnitCycleProps) {
  const cycle = useCallback((dir: number) => {
    const idx = options.indexOf(value);
    const base = idx === -1 ? 0 : idx;
    const next = (base + dir + options.length) % options.length;
    onChange(options[next]);
  }, [options, value, onChange]);

  return (
    <div className="relative"
      onWheel={e => {
        if (disabled) return;
        e.preventDefault();
        cycle(e.deltaY > 0 ? 1 : -1);
      }}>
      <select
        aria-label="Unidade"
        className="ui-field w-full px-3 py-2 pr-8 rounded-lg border border-control-line focus:ring-2 focus:ring-brand outline-none bg-surface text-sm appearance-none disabled:opacity-60 disabled:cursor-not-allowed"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (disabled) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); cycle(1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); cycle(-1); }
        }}>
        {options.map(u => <option key={u} value={u}>{formatUnit(u)}</option>)}
      </select>
      <ChevronDown size={16} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
    </div>
  );
}
