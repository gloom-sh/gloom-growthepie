import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  scalarPoint,
  staticSeries,
  unavailableText,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  usePaneTabs,
  useQueryBarSearch,
  type ChartTableChart,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "gloomberb/components";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  useShortcut,
  useUpdatedAgo,
} from "gloomberb/react";
import { colors, priceColor } from "gloomberb/theme";
import type { PaneProps } from "gloomberb/types/plugin";
import { Box, TextAttributes } from "gloomberb/ui";
import { isPlainArrowUp, isPlainKey, stopSearchFocusNavigation } from "gloomberb/utils";
import { formatMetricAxis } from "./axis";
import { getCachedHistory, getCachedOverview, loadHistory, loadOverview } from "./cache";
import { describeError } from "./client";
import {
  DEFAULT_METRIC,
  DEFAULT_RANGE,
  METRICS,
  RANGES,
  formatChange,
  formatMetricValue,
  formatShortDate,
  isMetricId,
  isRangeId,
  metricDef,
  rangeDef,
  rangeNeedsHistory,
} from "./metrics";
import { buildColumns, defaultSort, nextSort, resolveChainId, sortRows, type GtpColumn } from "./model";
import { buildRows, filterRows, seriesToPoints, sliceSeries } from "./normalize";
import {
  GROWTHEPIE_SOURCE_LABEL,
  GROWTHEPIE_URL,
  type ChainRow,
  type DailySeries,
  type HistoryData,
  type SortColumnId,
  type SortPreference,
} from "./types";

/** How long the selection rests on a chain before its full history is requested. */
const HISTORY_SETTLE_MS = 450;

interface HistoryState {
  data: HistoryData | null;
  loading: boolean;
  error: string | null;
}

const TAB_ITEMS = METRICS.map((metric) => ({ value: metric.id, label: metric.tab }));
const RANGE_OPTIONS = RANGES.map((range) => ({ value: range.id, label: range.label }));

function renderCell(
  row: ChainRow,
  column: GtpColumn,
  selectedMetric: string,
  selected: boolean,
): DataTableCell {
  const selectedText = selected ? colors.selectedText : undefined;
  if (column.id === "chain") {
    return { text: row.chain.shortName, color: selectedText ?? colors.textBright, attributes: TextAttributes.BOLD };
  }
  if (column.id === "change") {
    const stat = row.stats[selectedMetric as keyof typeof row.stats];
    const change = stat.change30d;
    return {
      text: formatChange(change),
      value: change === null ? null : change * 100,
      color: selectedText ?? (change === null ? colors.textDim : priceColor(change)),
    };
  }
  const stat = row.stats[column.id];
  const emphasised = column.id === selectedMetric;
  return {
    text: formatMetricValue(column.id, stat.value),
    value: stat.value,
    color: selectedText ?? (stat.value === null ? colors.textDim : stat.stale ? colors.textMuted : emphasised ? colors.textBright : colors.text),
    attributes: emphasised && stat.value !== null ? TextAttributes.BOLD : undefined,
  };
}

export function GrowthepiePane({ focused, width, height }: PaneProps) {
  const [metricSetting, setMetricSetting] = usePaneSettingValue<string>("metric", DEFAULT_METRIC);
  const [rangeSetting, setRangeSetting] = usePaneSettingValue<string>("range", DEFAULT_RANGE);
  const [chainSetting, setChainSetting] = usePaneSettingValue<string>("chain", "");
  const metric = isMetricId(metricSetting) ? metricSetting : DEFAULT_METRIC;
  const range = isRangeId(rangeSetting) ? rangeSetting : DEFAULT_RANGE;
  const def = metricDef(metric);

  const [sortOverride, setSortOverride] = useState<SortPreference | null>(null);
  const [query, setQuery] = useState("");
  const search = useQueryBarSearch();

  // Everything in the table, and the 30-day changes, come from one cached
  // payload; opening the pane with a warm cache makes no request.
  const loader = useCallback((force: boolean) => loadOverview(force), []);
  const resource = useAsyncResource(loader, { initialData: getCachedOverview });
  const overview = resource.data;
  const data = overview?.data ?? null;
  const refreshError = resource.error ?? overview?.refreshError ?? null;
  const stale = !!overview && (overview.stale || resource.error !== null);

  // The cache decides whether a tick becomes a request; a stale payload retries one interval after the last attempt.
  useAutoRefresh(overview && !stale ? resource.updatedAt : null, () => void resource.load());

  const rows = useMemo(() => (data ? buildRows(data.master, data.fundamentals) : []), [data]);
  const sort = sortOverride ?? defaultSort(metric);
  const visible = useMemo(() => sortRows(filterRows(rows, query), sort, metric), [rows, query, sort, metric]);
  const columns = useMemo(() => buildColumns(width, metric), [width, metric]);

  // Before the user picks a chain the pane follows the top row, then keeps that
  // chain when another metric reorders the table, so switching tabs compares one chain.
  const [firstChainId, setFirstChainId] = useState<string | null>(null);
  useEffect(() => {
    if (!firstChainId && visible[0]) setFirstChainId(visible[0].id);
  }, [firstChainId, visible]);
  const selectedId = useMemo(() => {
    const wanted = resolveChainId(rows, chainSetting) ?? firstChainId;
    return visible.find((row) => row.id === wanted)?.id ?? visible[0]?.id ?? null;
  }, [rows, visible, chainSetting, firstChainId]);
  const selectedRow = useMemo(() => visible.find((row) => row.id === selectedId) ?? null, [visible, selectedId]);
  const chainId = selectedRow?.id ?? null;
  const fundamentalsSeries: DailySeries | undefined = chainId && data ? data.fundamentals.series[metric]?.[chainId] : undefined;

  // ---- History beyond the table's 90 days: one request per chain and metric, after the selection rests.
  const wantsHistory = rangeNeedsHistory(range) && !!chainId && !!fundamentalsSeries;
  const historyKey = wantsHistory && chainId ? `${chainId}:${metric}` : null;
  const [histories, setHistories] = useState<Record<string, HistoryState>>({});
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const forceNextRef = useRef(false);

  const cachedHistory = useMemo(
    () => (historyKey && chainId ? getCachedHistory(chainId, def) : null),
    // The cache fills when a request lands, which also updates `histories`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyKey, histories[historyKey ?? ""]],
  );

  // A new metric or range on the same chain asks at once; moving to another
  // chain waits for the selection to rest, so scrolling the table is not a request per row.
  const lastHistoryChainRef = useRef<string | null>(null);
  useEffect(() => {
    if (!historyKey) {
      setSettledKey(null);
      return;
    }
    const nextChain = historyKey.slice(0, historyKey.indexOf(":"));
    const sameChain = lastHistoryChainRef.current === null || lastHistoryChainRef.current === nextChain;
    lastHistoryChainRef.current = nextChain;
    if (sameChain || (cachedHistory && !cachedHistory.stale)) {
      setSettledKey(historyKey);
      return;
    }
    const timer = setTimeout(() => setSettledKey(historyKey), HISTORY_SETTLE_MS);
    return () => clearTimeout(timer);
    // `cachedHistory` is read at the moment the selection changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyKey]);

  useEffect(() => {
    if (!settledKey) return;
    const separator = settledKey.indexOf(":");
    const requestChain = settledKey.slice(0, separator);
    const requestMetric = metricDef(settledKey.slice(separator + 1) as typeof metric);
    const force = forceNextRef.current;
    forceNextRef.current = false;
    let active = true;
    setHistories((current) => ({
      ...current,
      [settledKey]: { data: current[settledKey]?.data ?? null, loading: true, error: null },
    }));
    loadHistory(requestChain, requestMetric, force)
      .then((result) => {
        if (!active) return;
        setHistories((current) => ({
          ...current,
          [settledKey]: { data: result.data, loading: false, error: result.refreshError },
        }));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHistories((current) => ({
          ...current,
          [settledKey]: { data: current[settledKey]?.data ?? null, loading: false, error: describeError(error) },
        }));
      });
    return () => {
      active = false;
    };
  }, [settledKey, refreshNonce]);

  const historyState: HistoryState | null = historyKey
    ? histories[historyKey] ?? (cachedHistory ? { data: cachedHistory.data, loading: false, error: null } : null)
    : null;
  const historyData = historyState?.data ?? null;
  const historyFailed = !!historyKey && !historyData && !!historyState?.error && !historyState.loading;
  const historyLoading = !!historyKey && !historyData && !historyFailed;

  const chartSeries: DailySeries | undefined = useMemo(() => {
    if (!fundamentalsSeries) return undefined;
    const days = rangeDef(range).days;
    if (!rangeNeedsHistory(range)) return sliceSeries(fundamentalsSeries, days);
    if (historyData) return sliceSeries(historyData.series, days);
    return historyFailed ? fundamentalsSeries : undefined;
  }, [fundamentalsSeries, historyData, historyFailed, range]);

  const refresh = useCallback(() => {
    forceNextRef.current = true;
    setRefreshNonce((nonce) => nonce + 1);
    void resource.reload();
  }, [resource]);

  const chart = useMemo<ChartTableChart | null>(() => {
    if (!selectedRow) return null;
    const points = chartSeries ? seriesToPoints(chartSeries).map((point) => scalarPoint(point.date, point.value)) : [];
    return {
      series: points.length > 1
        ? [staticSeries(points, {
          id: `${selectedRow.id}:${metric}`,
          label: `${selectedRow.chain.shortName} ${def.title}`,
          color: colors.textBright,
          calendarSpaced: true,
        })]
        : [],
      formatValue: (value) => formatMetricValue(metric, value),
      formatAxisValue: (value, domain) => formatMetricAxis(metric, value, domain),
      loading: historyLoading,
      empty: `No ${def.title.toLowerCase()} for ${selectedRow.chain.shortName}.`,
      remoteKind: "growthepie-history",
    };
  }, [chartSeries, def.title, historyLoading, metric, selectedRow]);

  // ---- Footer: the source line, what Gloom computed, and changing status.
  const updatedAgo = useUpdatedAgo(overview?.fetchedAt ?? null);
  const footerInfo = useMemo(() => {
    const ok = !refreshError;
    return [
      { id: "source", parts: [{ text: "Source:", tone: "label" as const }, { text: GROWTHEPIE_SOURCE_LABEL, tone: "value" as const }] },
      ...(data && ok ? [{ id: "computed", parts: [{ text: "30D change computed by Gloom", tone: "muted" as const }] }] : []),
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: `updated ${updatedAgo}`, tone: "muted" as const }] }] : []),
    ];
  }, [data, refreshError, updatedAgo]);

  usePaneStatusLinkFooter({
    registrationId: "growthepie",
    focused,
    url: GROWTHEPIE_URL,
    loading: resource.loading || historyLoading,
    error: refreshError,
    stale,
    info: footerInfo,
    showOpenHint: true,
  });

  usePaneNoticeFooter({
    registrationId: "growthepie:history",
    focused,
    notices: historyKey && historyState?.error
      ? [`Longer history is unavailable: ${historyState.error}${historyData ? " Showing the last copy." : " Showing the last 90 days."}`]
      : [],
  });

  // ---- Keys and tabs
  useShortcut((event) => {
    if (!focused || search.active || event.targetEditable || !isPlainKey(event, "r")) return;
    event.stopPropagation?.();
    event.preventDefault?.();
    refresh();
  }, { allowEditable: true, enabled: focused });

  const selectMetric = useCallback((value: string) => {
    if (!isMetricId(value)) return;
    setMetricSetting(value);
    setSortOverride(null);
  }, [setMetricSetting]);

  const tabs = usePaneTabs({
    tabs: TAB_ITEMS,
    activeValue: metric,
    onSelect: selectMetric,
    focused: focused && !search.active,
    compact: true,
    variant: "bare",
  });

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      search.focus();
      return true;
    }
    return false;
  }, [search]);

  const renderTableCell = useCallback(
    (row: ChainRow, column: GtpColumn, _index: number, rowState: { selected: boolean }) => (
      renderCell(row, column, metric, rowState.selected)
    ),
    [metric],
  );

  const tableHeight = Math.max(1, height - tabs.rows);
  const asOf = data?.fundamentals.asOf ?? null;

  const queryBar = (
    <QueryBar
      width={width}
      search={{
        value: query,
        onChange: setQuery,
        placeholder: "chain",
        focused: focused && !search.active,
        ...search.searchProps,
        debounceMs: 80,
      }}
      view={{
        value: range,
        options: RANGE_OPTIONS,
        onChange: (value: string) => { if (isRangeId(value)) setRangeSetting(value); },
      }}
      meta={asOf ? `daily to ${formatShortDate(asOf)}` : undefined}
    />
  );

  if (!data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs.strip}
        {/* The reason is in the footer, so the body only says what is missing. */}
        <PaneStatusBody
          loading={resource.loading}
          error={resource.error ? unavailableText("Chain metrics") : null}
          subject={resource.error ? undefined : "chain metrics"}
          align="center"
          actions={<Button label="Try again" onPress={refresh} />}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs.strip}
      <DataTableView<ChainRow, GtpColumn>
        focused={focused && !search.active}
        rootWidth={width}
        rootHeight={tableHeight}
        rootBefore={(
          <ChartTableHeader
            width={width}
            height={tableHeight}
            tableRows={visible.length}
            tableColumns={columns}
            query={queryBar}
            chart={chart}
          />
        )}
        selection={{
          kind: "id",
          selectedId,
          getId: (row) => row.id,
          onChange: (id) => setChainSetting(id),
        }}
        onRootKeyDown={handleRootKeyDown}
        columns={columns}
        items={visible}
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(columnId) => setSortOverride((current) => nextSort(current ?? defaultSort(metric), columnId as SortColumnId))}
        getItemKey={(row) => row.id}
        renderCell={renderTableCell}
        emptyStateTitle={query.trim() ? "No matching chains." : "growthepie has no chains to show."}
        emptyStateHint={query.trim() ? "Clear search." : undefined}
      />
    </Box>
  );
}
