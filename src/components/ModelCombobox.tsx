import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BENCHMARK_OPTIONS, type BenchmarkId } from "../domain/benchmark";

type ComboboxOption = {
  value: string;
  label: string;
  tag?: string;
};

function SearchableCombobox({
  value,
  options,
  ariaLabel,
  placeholder,
  allowCustomValue,
  emptyMessage,
  onChange,
  onOpen
}: {
  value: string;
  options: ComboboxOption[];
  ariaLabel: string;
  placeholder?: string;
  allowCustomValue: boolean;
  emptyMessage: string;
  onChange: (nextValue: string) => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);
  const inputValue = open ? query : selectedOption?.label ?? value;

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery || options.some((option) => (
      option.label.toLocaleLowerCase() === normalizedQuery
      || option.value.toLocaleLowerCase() === normalizedQuery
    ))) return options;
    const terms = normalizedQuery.split(/\s+/);
    return options.filter((option) => {
      const candidate = `${option.label} ${option.value}`.toLocaleLowerCase();
      return terms.every((term) => candidate.includes(term));
    });
  }, [options, query]);

  useEffect(() => {
    setHighlightIndex((previous) => Math.min(previous, Math.max(filteredOptions.length - 1, 0)));
  }, [filteredOptions.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openList() {
    if (open) return;
    onOpen?.();
    setQuery(selectedOption?.label ?? value);
    setOpen(true);
    setHighlightIndex(0);
  }

  function select(option: ComboboxOption) {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const optionCount = Math.max(filteredOptions.length, 1);
      setHighlightIndex((previous) => (previous + direction + optionCount) % optionCount);
      return;
    }
    if (event.key === "Enter" && open && filteredOptions[highlightIndex] !== undefined) {
      event.preventDefault();
      select(filteredOptions[highlightIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="searchable-combobox" ref={containerRef}>
      <input
        aria-autocomplete="list"
        aria-expanded={open}
        aria-label={ariaLabel}
        placeholder={placeholder}
        role="combobox"
        value={inputValue}
        onChange={(event) => {
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          if (allowCustomValue || !nextQuery) onChange(nextQuery);
          if (!open) openList();
        }}
        onClick={openList}
        onFocus={openList}
        onKeyDown={onKeyDown}
      />
      <button
        aria-label={open ? `Hide ${ariaLabel.toLocaleLowerCase()} suggestions` : `Show ${ariaLabel.toLocaleLowerCase()} suggestions`}
        className="searchable-combobox-toggle"
        tabIndex={-1}
        type="button"
        onPointerDown={(event) => {
          event.preventDefault();
          if (open) setOpen(false);
          else openList();
        }}
      >
        <ChevronDown size={14} />
      </button>
      {open ? (
        <ul className="searchable-combobox-list" role="listbox">
          {filteredOptions.length ? filteredOptions.map((option, index) => (
            <li
              aria-selected={option.value === value}
              className={index === highlightIndex ? "highlighted" : undefined}
              key={option.value}
              role="option"
              onMouseEnter={() => setHighlightIndex(index)}
              onPointerDown={(event) => {
                event.preventDefault();
                select(option);
              }}
            >
              <span>{option.label}</span>
              {option.tag ? <em className="searchable-combobox-tag">{option.tag}</em> : null}
            </li>
          )) : <li className="searchable-combobox-empty">{emptyMessage}</li>}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A real combobox for the model id: opens its option list on focus/click,
 * filters as you type (space-separated terms all must match, case-insensitive,
 * so "qwen 9b" finds Qwen3.5-9B-OptiQ-4bit), supports arrow-key navigation,
 * and still accepts free text for endpoints that are offline. Replaces a
 * native <datalist>, whose dropdown quirks made it look broken.
 */
export function ModelCombobox({
  value,
  models,
  tags,
  ariaLabel = "Model",
  placeholder,
  onChange,
  onOpen
}: {
  value: string;
  models: string[];
  /** Optional right-aligned tag per model id (e.g. "vision" for VLMs). */
  tags?: Record<string, string | undefined>;
  ariaLabel?: string;
  placeholder?: string;
  onChange: (nextValue: string) => void;
  /** Called when the dropdown opens — used to refresh the model list. */
  onOpen?: () => void;
}) {
  return (
    <SearchableCombobox
      allowCustomValue
      ariaLabel={ariaLabel}
      emptyMessage={models.length
        ? "No models match — free text is fine."
        : "No models listed (endpoint unreachable?) — type the id."}
      options={models.map((model) => ({ value: model, label: model, tag: tags?.[model] }))}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      onOpen={onOpen}
    />
  );
}

export function BenchmarkCombobox({
  value,
  ariaLabel = "Benchmark",
  placeholder,
  onChange
}: {
  value: BenchmarkId | "";
  ariaLabel?: string;
  placeholder?: string;
  onChange: (nextValue: BenchmarkId | "") => void;
}) {
  return (
    <SearchableCombobox
      allowCustomValue={false}
      ariaLabel={ariaLabel}
      emptyMessage="No benchmarks match."
      options={BENCHMARK_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
      placeholder={placeholder}
      value={value}
      onChange={(nextValue) => onChange(nextValue as BenchmarkId | "")}
    />
  );
}
