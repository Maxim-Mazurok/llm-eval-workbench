import { ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type MultiSelectOption = {
  value: string;
  label: string;
};

export function MultiSelectFilter({
  label,
  options,
  hiddenValues,
  setHiddenValues
}: {
  label: string;
  options: MultiSelectOption[];
  hiddenValues: Set<string>;
  setHiddenValues: (values: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
  const visibleCount = options.length - hiddenValues.size;

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("click", closeWhenOutside);
    return () => document.removeEventListener("click", closeWhenOutside);
  }, [open]);

  return (
    <div className="multi-select-filter" ref={containerRef}>
      <button
        aria-expanded={open}
        className="multi-select-filter-trigger"
        type="button"
        onClick={() => setOpen((previous) => !previous)}
      >
        {label} <span>{visibleCount}/{options.length}</span><ChevronDown size={14} />
      </button>
      {open ? <div className="multi-select-filter-menu">
        <label className="multi-select-filter-search">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label={`Filter ${label.toLocaleLowerCase()}`}
            placeholder="Filter"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="multi-select-filter-option multi-select-filter-all">
          <input
            checked={hiddenValues.size === 0}
            type="checkbox"
            onChange={() => setHiddenValues(hiddenValues.size ? new Set() : new Set(options.map((option) => option.value)))}
          />
          All
        </label>
        <div className="multi-select-filter-options">
          {filteredOptions.map((option) => (
            <label className="multi-select-filter-option" key={option.value}>
              <input
                checked={!hiddenValues.has(option.value)}
                type="checkbox"
                onChange={() => {
                  const nextHiddenValues = new Set(hiddenValues);
                  if (nextHiddenValues.has(option.value)) nextHiddenValues.delete(option.value);
                  else nextHiddenValues.add(option.value);
                  setHiddenValues(nextHiddenValues);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div> : null}
    </div>
  );
}