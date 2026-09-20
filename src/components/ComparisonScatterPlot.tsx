import { useEffect, useMemo, useRef, useState } from "react";
import {
  aggregateComparisonMetric,
  comparisonMetric,
  comparisonMetricDomain,
  paretoFrontier,
  type ComparisonChartPoint,
  type ComparisonMetricId
} from "../domain/comparisonChart";
import type { ComparisonRow } from "./BenchmarkComparison";

type PlotPoint = ComparisonChartPoint & {
  x: number;
  y: number;
};

const providerColors = ["#1f7a68", "#b94626", "#2f67b1", "#8a6b12", "#8b4d7d", "#52742f", "#7a5543"];

function providerColor(provider: string) {
  let hash = 0;
  for (const character of provider) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return providerColors[Math.abs(hash) % providerColors.length];
}

function scale(domainMinimum: number, domainMaximum: number, rangeMinimum: number, rangeMaximum: number) {
  return (value: number) => rangeMinimum
    + ((value - domainMinimum) / (domainMaximum - domainMinimum || 1)) * (rangeMaximum - rangeMinimum);
}

function ticks(minimum: number, maximum: number) {
  return Array.from({ length: 5 }, (_, index) => minimum + ((maximum - minimum) * index) / 4);
}

function trimLabel(value: string, maximumLength = 42) {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

export function ComparisonScatterPlot({
  rows,
  xMetricId,
  yMetricId,
  ignoreIncompletePasses,
  onlyBestModelResult
}: {
  rows: ComparisonRow[];
  xMetricId: ComparisonMetricId;
  yMetricId: ComparisonMetricId;
  ignoreIncompletePasses: boolean;
  onlyBestModelResult: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [width, setWidth] = useState(1_100);
  const [hoveredPoint, setHoveredPoint] = useState<PlotPoint | null>(null);
  const height = width < 620 ? 430 : 560;
  const xMetric = comparisonMetric(xMetricId);
  const yMetric = comparisonMetric(yMetricId);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = () => setWidth(Math.max(320, Math.round(container.getBoundingClientRect().width)));
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => () => {
    if (hideTooltipTimerRef.current) clearTimeout(hideTooltipTimerRef.current);
  }, []);

  function cancelTooltipHide() {
    if (!hideTooltipTimerRef.current) return;
    clearTimeout(hideTooltipTimerRef.current);
    hideTooltipTimerRef.current = null;
  }

  function showTooltip(point: PlotPoint) {
    cancelTooltipHide();
    setHoveredPoint(point);
  }

  function scheduleTooltipHide() {
    cancelTooltipHide();
    hideTooltipTimerRef.current = setTimeout(() => {
      setHoveredPoint(null);
      hideTooltipTimerRef.current = null;
    }, 100);
  }

  const chart = useMemo(() => {
    const margin = width < 620
      ? { top: 28, right: 20, bottom: 68, left: 90 }
      : { top: 34, right: 34, bottom: 70, left: 82 };
    const points = rows.flatMap((row) => {
      const sources = [...row.cells.values()];
      const xValue = aggregateComparisonMetric(sources, xMetricId, ignoreIncompletePasses);
      const yValue = aggregateComparisonMetric(sources, yMetricId, ignoreIncompletePasses);
      if (xValue === null || yValue === null || !Number.isFinite(xValue) || !Number.isFinite(yValue)) return [];
      return [{
        id: row.key,
        label: row.model,
        provider: row.providers.join(", "),
        xValue,
        yValue
      }];
    });
    if (!points.length) return { points: [] as PlotPoint[], frontierPath: "", xTicks: [], yTicks: [], margin };

    const [xMinimum, xMaximum] = comparisonMetricDomain(points.map((point) => point.xValue), xMetricId);
    const [yMinimum, yMaximum] = comparisonMetricDomain(points.map((point) => point.yValue), yMetricId);
    const xScale = scale(xMinimum, xMaximum, margin.left, width - margin.right);
    const yScale = scale(yMinimum, yMaximum, height - margin.bottom, margin.top);
    const plotPoints = points.map((point) => ({ ...point, x: xScale(point.xValue), y: yScale(point.yValue) }));
    const plotPointsById = new Map(plotPoints.map((point) => [point.id, point]));
    const frontierPoints = paretoFrontier(points, xMetric.higherIsBetter, yMetric.higherIsBetter)
      .map((point) => plotPointsById.get(point.id))
      .filter((point): point is PlotPoint => Boolean(point))
      .sort((left, right) => left.x - right.x);
    return {
      points: plotPoints,
      frontierPath: frontierPoints.map((point, index) => (
        `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
      )).join(" "),
      xTicks: ticks(xMinimum, xMaximum).map((value) => ({ value, position: xScale(value) })),
      yTicks: ticks(yMinimum, yMaximum).map((value) => ({ value, position: yScale(value) })),
      margin
    };
  }, [height, ignoreIncompletePasses, rows, width, xMetric.higherIsBetter, xMetricId, yMetric.higherIsBetter, yMetricId]);

  const tooltipWidth = Math.min(300, width - 28);
  const tooltipGap = 14;
  const tooltipHeight = 102;
  const tooltipFitsRight = hoveredPoint
    ? hoveredPoint.x + tooltipGap + tooltipWidth <= width - tooltipGap
    : false;
  const tooltipFitsLeft = hoveredPoint
    ? hoveredPoint.x - tooltipGap - tooltipWidth >= tooltipGap
    : false;
  const tooltipX = hoveredPoint
    ? tooltipFitsRight
      ? hoveredPoint.x + tooltipGap
      : tooltipFitsLeft
        ? hoveredPoint.x - tooltipGap - tooltipWidth
        : Math.min(Math.max(hoveredPoint.x - tooltipWidth / 2, tooltipGap), width - tooltipWidth - tooltipGap)
    : 0;
  const tooltipY = hoveredPoint
    ? tooltipFitsRight || tooltipFitsLeft
      ? Math.min(Math.max(hoveredPoint.y - 74, tooltipGap), height - tooltipHeight - tooltipGap)
      : hoveredPoint.y - tooltipGap - tooltipHeight >= tooltipGap
        ? hoveredPoint.y - tooltipGap - tooltipHeight
        : Math.min(hoveredPoint.y + tooltipGap, height - tooltipHeight - tooltipGap)
    : 0;

  return (
    <div className="comparison-chart" ref={containerRef}>
      <svg aria-label={`${yMetric.label} by ${xMetric.label} Pareto chart`} role="img" viewBox={`0 0 ${width} ${height}`}>
        <rect className="comparison-chart-background" height={height} width={width} />
        {chart.xTicks.map((tick) => (
          <g key={`x-${tick.value}`}>
            <line className="comparison-chart-grid" x1={tick.position} x2={tick.position} y1={chart.margin.top} y2={height - chart.margin.bottom} />
            <text className="comparison-chart-tick" textAnchor="middle" x={tick.position} y={height - chart.margin.bottom + 25}>
              {xMetric.format(tick.value)}
            </text>
          </g>
        ))}
        {chart.yTicks.map((tick) => (
          <g key={`y-${tick.value}`}>
            <line className="comparison-chart-grid" x1={chart.margin.left} x2={width - chart.margin.right} y1={tick.position} y2={tick.position} />
            <text className="comparison-chart-tick" textAnchor="end" x={chart.margin.left - 12} y={tick.position + 4}>
              {yMetric.format(tick.value)}
            </text>
          </g>
        ))}
        <text className="comparison-chart-axis" textAnchor="middle" x={(width + chart.margin.left - chart.margin.right) / 2} y={height - 17}>
          {xMetric.label} · {xMetric.higherIsBetter ? "higher is better" : "lower is better"}
        </text>
        <text
          className="comparison-chart-axis"
          textAnchor="middle"
          transform={`translate(18 ${(height - chart.margin.bottom + chart.margin.top) / 2}) rotate(-90)`}
        >
          {yMetric.label} · {yMetric.higherIsBetter ? "higher is better" : "lower is better"}
        </text>
        {chart.frontierPath ? <path className="comparison-frontier" d={chart.frontierPath} /> : null}
        {chart.points.map((point) => (
          <g
            aria-label={`${point.label}, ${xMetric.format(point.xValue)} ${xMetric.shortLabel}, ${yMetric.format(point.yValue)} ${yMetric.shortLabel}`}
            className="comparison-chart-point"
            key={point.id}
            role="button"
            tabIndex={0}
            onBlur={() => setHoveredPoint(null)}
            onFocus={() => showTooltip(point)}
            onMouseEnter={() => showTooltip(point)}
            onMouseLeave={scheduleTooltipHide}
          >
            <circle cx={point.x} cy={point.y} fill={providerColor(point.provider)} r="7" />
            <circle className="comparison-chart-hit" cx={point.x} cy={point.y} r="16" />
          </g>
        ))}
        {hoveredPoint ? (
          <g
            className="comparison-chart-tooltip"
            role="tooltip"
            transform={`translate(${tooltipX} ${tooltipY})`}
            onMouseEnter={cancelTooltipHide}
            onMouseLeave={scheduleTooltipHide}
          >
            <rect height={tooltipHeight} width={tooltipWidth} />
            <text className="comparison-chart-tooltip-title" x="12" y="23">{trimLabel(hoveredPoint.label)}</text>
            <text x="12" y="44">{trimLabel(hoveredPoint.provider)}</text>
            <text x="12" y="68">{xMetric.shortLabel}: {xMetric.format(hoveredPoint.xValue)}</text>
            <text x="12" y="89">{yMetric.shortLabel}: {yMetric.format(hoveredPoint.yValue)}</text>
          </g>
        ) : null}
      </svg>
      {!chart.points.length ? <p className="comparison-empty-state">No runs contain both selected metrics.</p> : null}
      <div className="comparison-chart-legend">
        <span><i className="comparison-frontier-key" />Pareto frontier</span>
        <span>
          {chart.points.length} {onlyBestModelResult ? "model" : "model configuration"}{chart.points.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}