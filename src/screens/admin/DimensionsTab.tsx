/* Admin → Dimensions tab.

   Source-of-truth UI for sku_dimensions: rich list view with expandable
   rows, click-to-copy keys, filter pills, quick stats, sticky header,
   and a modal-based full edit. Treats this screen as the master record
   so admins never need to touch xlsx after the initial seed.

   Layout:
     [QuickStats]   ← total · multi-key · with FNSKU · ø L×B×H · ø Gewicht
     [Action bar]   ← + Neu · Import · Export
     [Import banner] (if any)
     [Filter bar]   ← search · pills (Alle / Manuell / Import / Multi-Key)
                    + selection count + bulk delete
     [Table]
       ┌ ☐ Identity   Title   Maße   Gewicht  Letzte Änderung    ·  ▾
       └ (click row → expanded panel with all keys, audit, computed volume)
     [Pagination]
   */

import { useEffect, useMemo, useState, type ReactNode, type CSSProperties, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminListSkuDimensions,
  adminImportSkuDimensions,
  adminExportSkuDimensions,
  adminCreateSkuDimension,
  adminUpdateSkuDimension,
  adminDeleteSkuDimension,
} from '@/marathonApi.js';
import { Card, T } from '@/components/ui.jsx';
import { useConfirm } from '@/components/ConfirmDialog';
import type {
  SkuDimensionRead,
  SkuDimensionUpsert,
  SkuDimensionImportResult,
} from '@/types/api';

type DimRow = SkuDimensionRead;

interface ImportBannerSuccess extends SkuDimensionImportResult {
  kind: 'success';
}
interface ImportBannerError {
  kind: 'error';
  message: string;
}
type ImportBannerState = ImportBannerSuccess | ImportBannerError;

interface DimStats {
  withFnsku: number;
  multiKey: number;
  manual: number;
  xlsx: number;
  incomplete: number;
  avgWeight: number;
  avgVolume: number;
}

const PAGE_SIZE = 50;

export default function DimensionsTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState('updated');
  const [sortDir, setSortDir] = useState('desc');
  const [filter, setFilter] = useState('all');     // all | manual | xlsx | multi | incomplete
  const [importBanner, setImportBanner] = useState<ImportBannerState | null>(null);
  const [editing, setEditing] = useState<DimRow | 'new' | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const listQ = useQuery({
    queryKey: ['admin', 'sku-dimensions', search, page],
    queryFn: () => adminListSkuDimensions({
      q: search,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    placeholderData: (prev) => prev,
  });

  const items = listQ.data?.items ?? [];

  // ─── Mutations ────────────────────────────────────────────────────
  const importMut = useMutation({
    mutationFn: adminImportSkuDimensions,
    onSuccess: (res) => {
      setImportBanner({ kind: 'success', ...res });
      qc.invalidateQueries({ queryKey: ['admin', 'sku-dimensions'] });
    },
    onError: (err) => setImportBanner({ kind: 'error', message: err?.message || 'Upload-Fehler' }),
  });

  const exportMut = useMutation({
    mutationFn: adminExportSkuDimensions,
    onError: (err) => alert(err?.message || 'Export fehlgeschlagen'),
  });

  const deleteMut = useMutation({
    mutationFn: adminDeleteSkuDimension,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'sku-dimensions'] }),
  });

  const createMut = useMutation({
    mutationFn: adminCreateSkuDimension,
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['admin', 'sku-dimensions'] });
    },
    onError: (err) => alert(err?.message || 'Anlegen fehlgeschlagen'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<SkuDimensionUpsert> }) => adminUpdateSkuDimension(id, payload),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['admin', 'sku-dimensions'] });
    },
    onError: (err) => alert(err?.message || 'Speichern fehlgeschlagen'),
  });

  // ─── Filter + sort (client-side over the page) ─────────────────────
  const filteredItems = useMemo(() => {
    return items.filter((r) => {
      if (filter === 'all') return true;
      if (filter === 'manual') return r.source === 'manual';
      if (filter === 'xlsx')   return r.source === 'xlsx_import';
      if (filter === 'multi')  return (r.fnskus.length + r.skus.length + r.eans.length) > 1;
      if (filter === 'incomplete') return !r.title || r.fnskus.length === 0;
      return true;
    });
  }, [items, filter]);

  const sortedItems = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const get = {
      identity: (r) => primaryKey(r),
      title:    (r) => (r.title || '').toLowerCase(),
      lengthCm: (r) => r.lengthCm,
      widthCm:  (r) => r.widthCm,
      heightCm: (r) => r.heightCm,
      weightKg: (r) => r.weightKg,
      palletLoadMax: (r) => r.palletLoadMax ?? -1,
      updated:  (r) => r.updatedAt,
    }[sortBy] || ((r) => r.id);
    return [...filteredItems].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [filteredItems, sortBy, sortDir]);

  const onSort = (key) => {
    if (sortBy === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(key); setSortDir(key === 'updated' ? 'desc' : 'asc'); }
  };

  // ─── Selection ────────────────────────────────────────────────────
  const visibleIds = sortedItems.map((r) => r.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ─── Actions ──────────────────────────────────────────────────────
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportBanner(null);
    importMut.mutate(file);
    e.target.value = '';
  };
  const onDelete = async (row) => {
    const ok = await confirm({
      message: 'Eintrag wirklich löschen?',
      detail: `${primaryKey(row)} wird dauerhaft aus den SKU-Dimensionen entfernt.`,
      confirmLabel: 'Löschen',
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(row.id);
  };
  const onBulkDelete = async () => {
    if (selected.size === 0) return;
    const ok = await confirm({
      message: `${selected.size} Einträge wirklich löschen?`,
      detail: 'Diese SKU-Dimensionen werden dauerhaft entfernt. Aktion lässt sich nicht rückgängig machen.',
      confirmLabel: 'Alle löschen',
      danger: true,
    });
    if (!ok) return;
    [...selected].forEach((id) => deleteMut.mutate(id as number));
    setSelected(new Set());
  };
  const toggleExpand = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ─── Stats over the current page ──────────────────────────────────
  const stats = useMemo(() => computeStats(items), [items]);
  const total = listQ.data?.total ?? 0;

  return (
    <div>
      <QuickStats stats={stats} total={total} loading={listQ.isLoading} />

      <ActionBar
        importPending={importMut.isPending}
        exportPending={exportMut.isPending}
        canExport={total > 0}
        onAddNew={() => setEditing('new')}
        onFile={onFile}
        onExport={() => exportMut.mutate()}
      />

      {importBanner && <ImportBanner banner={importBanner} />}

      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(0); }}
        filter={filter}
        onFilter={setFilter}
        counts={stats}
        selectedCount={selected.size}
        onBulkDelete={onBulkDelete}
        loading={listQ.isLoading}
        total={total}
        filtered={sortedItems.length}
      />

      {sortedItems.length === 0 ? (
        <EmptyState
          isLoading={listQ.isLoading}
          isEmpty={total === 0}
          isFiltered={total > 0 && sortedItems.length === 0}
          onAddNew={() => setEditing('new')}
        />
      ) : (
        <DimensionsTable
          items={sortedItems}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={onSort}
          allSelected={allSelected}
          toggleAll={toggleAll}
          selected={selected}
          toggleOne={toggleOne}
          expanded={expanded}
          toggleExpand={toggleExpand}
          onEdit={setEditing}
          onDelete={onDelete}
        />
      )}

      <Pagination
        page={page}
        total={total}
        limit={PAGE_SIZE}
        onPage={setPage}
      />

      {editing && (
        <DimensionEditModal
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(payload) => {
            if (editing === 'new') createMut.mutate(payload);
            else updateMut.mutate({ id: editing.id, payload });
          }}
          saving={createMut.isPending || updateMut.isPending}
        />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Quick stats card
   ════════════════════════════════════════════════════════════════════════ */
function QuickStats({ stats, total, loading }: { stats: DimStats; total: number; loading: boolean }) {
  const items = [
    { label: 'Einträge gesamt',  value: loading ? '…' : total, mono: true },
    { label: 'Mit FNSKU',         value: loading ? '…' : stats.withFnsku, mono: true },
    { label: 'Mit mehreren Codes',value: loading ? '…' : stats.multiKey, mono: true,
      hint: 'Eine physische Verpackung mit ≥2 FNSKU/SKU/EAN' },
    { label: 'Manuell gepflegt',  value: loading ? '…' : stats.manual, mono: true },
    { label: 'Ø Gewicht',         value: loading || !stats.avgWeight ? '—' : `${stats.avgWeight.toFixed(2)} kg`, mono: true },
    { label: 'Ø Volumen',         value: loading || !stats.avgVolume ? '—' : `${stats.avgVolume.toFixed(2)} L`, mono: true },
  ];
  return (
    <Card style={{ padding: '14px 18px', marginBottom: 12 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${items.length}, 1fr)`,
        gap: 8,
      }}>
        {items.map((it) => (
          <div key={it.label} title={it.hint}>
            <div style={{
              fontSize: 10.5,
              fontWeight: 500,
              color: T.text.subtle,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: 4,
            }}>{it.label}</div>
            <div style={{
              fontSize: 18,
              fontWeight: 600,
              color: T.text.primary,
              fontFamily: it.mono ? T.font.mono : T.font.ui,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.1,
            }}>{it.value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Action bar (Add / Import / Export)
   ════════════════════════════════════════════════════════════════════════ */
interface ActionBarProps {
  importPending: boolean;
  exportPending: boolean;
  canExport: boolean;
  onAddNew: () => void;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
  onExport: () => void;
}

function ActionBar({ importPending, exportPending, canExport, onAddNew, onFile, onExport }: ActionBarProps) {
  return (
    <div style={{
      display: 'flex',
      gap: 8,
      marginBottom: 12,
      flexWrap: 'wrap',
      alignItems: 'center',
    }}>
      <button onClick={onAddNew} style={btnPrimary}>+ Neuer Eintrag</button>
      <label style={{ ...btnGhost, cursor: importPending ? 'wait' : 'pointer', opacity: importPending ? 0.6 : 1 }}>
        {importPending ? 'Lade hoch…' : '📂 Import xlsx'}
        <input type="file" accept=".xlsx,.xls" onChange={onFile} disabled={importPending}
               style={{ display: 'none' }} />
      </label>
      <button onClick={onExport} disabled={exportPending || !canExport}
              style={{ ...btnGhost, opacity: (exportPending || !canExport) ? 0.5 : 1,
                       cursor: exportPending ? 'wait' : 'pointer' }}>
        {exportPending ? 'Exportiere…' : '📥 Export xlsx'}
      </button>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11.5, color: T.text.subtle }}>
        Diese Tabelle ist die einzige Quelle. xlsx ist optional.
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Import banner
   ════════════════════════════════════════════════════════════════════════ */
function ImportBanner({ banner }: { banner: ImportBannerState }) {
  const ok = banner.kind === 'success';
  return (
    <div style={{
      marginBottom: 12,
      padding: '12px 14px',
      background: ok ? T.status.success.bg : T.status.danger.bg,
      border: `1px solid ${ok ? T.status.success.border : T.status.danger.border}`,
      borderRadius: T.radius.sm,
      fontSize: 13,
      color: ok ? T.status.success.text : T.status.danger.text,
    }}>
      {ok
        ? `✓ Import: ${banner.imported} neu · ${banner.updated} aktualisiert · ${banner.skipped} übersprungen`
        : `✗ ${banner.message}`}
      {ok && banner.warnings?.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12 }}>
            {banner.warnings.length} Warnung(en)
          </summary>
          <ul style={{ margin: '6px 0 0 18px', fontSize: 12, color: T.text.subtle }}>
            {banner.warnings.slice(0, 30).map((w, i) => <li key={i}>{w}</li>)}
            {banner.warnings.length > 30 && (
              <li>… und {banner.warnings.length - 30} weitere</li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Filter bar (search + pills + selection counter)
   ════════════════════════════════════════════════════════════════════════ */
function FilterBar({
  search, onSearch, filter, onFilter, counts,
  selectedCount, onBulkDelete, loading, total, filtered,
}) {
  const pills = [
    { key: 'all',        label: 'Alle',        count: total },
    { key: 'manual',     label: 'Manuell',     count: counts.manual },
    { key: 'xlsx',       label: 'Aus xlsx',    count: counts.xlsx },
    { key: 'multi',      label: 'Multi-Code',  count: counts.multiKey },
    { key: 'incomplete', label: 'Unvollständig', count: counts.incomplete,
      hint: 'Ohne Titel oder ohne FNSKU' },
  ];
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 12px',
      background: T.bg.surface2,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
      marginBottom: 12,
      flexWrap: 'wrap',
    }}>
      {/* Search */}
      <div style={{ position: 'relative', minWidth: 240, flex: '0 1 320px' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="🔍  Suche FNSKU / SKU / EAN / Titel"
          style={{
            width: '100%',
            padding: '7px 12px',
            fontSize: 13,
            background: T.bg.surface,
            border: `1px solid ${T.border.strong}`,
            borderRadius: T.radius.sm,
            color: T.text.primary,
            outline: 'none',
            fontFamily: T.font.ui,
          }}
        />
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {pills.map((p) => {
          const active = filter === p.key;
          return (
            <button
              key={p.key}
              onClick={() => onFilter(p.key)}
              title={p.hint}
              style={{
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 500,
                background: active ? T.accent.main : T.bg.surface,
                color: active ? T.accent.text : T.text.secondary,
                border: `1px solid ${active ? T.accent.main : T.border.primary}`,
                borderRadius: T.radius.full,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                transition: 'all 120ms',
              }}
            >
              {p.label}
              <span style={{
                fontSize: 10.5,
                fontVariantNumeric: 'tabular-nums',
                opacity: 0.7,
              }}>{p.count}</span>
            </button>
          );
        })}
      </div>

      <span style={{ flex: 1 }} />

      {/* Bulk action */}
      {selectedCount > 0 && (
        <button
          onClick={onBulkDelete}
          style={{
            padding: '6px 14px',
            background: T.status.danger.main,
            color: '#fff',
            border: 'none',
            borderRadius: T.radius.sm,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          ✕ {selectedCount} löschen
        </button>
      )}

      {/* Result counter */}
      <span style={{ fontSize: 11.5, color: T.text.subtle, fontVariantNumeric: 'tabular-nums' }}>
        {loading ? '…' : (
          filter === 'all'
            ? `${filtered} sichtbar / ${total}`
            : `${filtered} treffend / ${total}`
        )}
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Empty state
   ════════════════════════════════════════════════════════════════════════ */
function EmptyState({ isLoading, isEmpty, isFiltered, onAddNew }: { isLoading: boolean; isEmpty: boolean; isFiltered: boolean; onAddNew: () => void }) {
  if (isLoading) return (
    <div style={{ padding: 24 }}>
      {[0,1,2,3].map((i) => (
        <div key={i} style={{
          height: 36,
          marginBottom: 6,
          background: `linear-gradient(90deg, ${T.bg.surface2}, ${T.bg.surface3}, ${T.bg.surface2})`,
          backgroundSize: '200% 100%',
          animation: 'mr-skeleton 1.4s linear infinite',
          borderRadius: T.radius.sm,
        }} />
      ))}
      <style>{`@keyframes mr-skeleton { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }`}</style>
    </div>
  );
  if (isEmpty) return (
    <Card style={{ padding: 56, textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
      <h3 style={{ margin: 0, fontSize: 16, color: T.text.primary, fontWeight: 600 }}>
        Noch keine Dimensions-Daten
      </h3>
      <p style={{ marginTop: 8, marginBottom: 18, fontSize: 13, color: T.text.subtle }}>
        Lade eine Dimensional-Liste (.xlsx) hoch oder erfasse den ersten Eintrag manuell.
      </p>
      <button onClick={onAddNew} style={btnPrimary}>+ Ersten Eintrag erfassen</button>
    </Card>
  );
  if (isFiltered) return (
    <Card style={{ padding: 36, textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: T.text.subtle }}>
        Keine Treffer mit den aktuellen Filtern.
      </div>
    </Card>
  );
  return null;
}

/* ════════════════════════════════════════════════════════════════════════
   Main table — sticky header, expandable rows
   ════════════════════════════════════════════════════════════════════════ */
function DimensionsTable({
  items, sortBy, sortDir, onSort,
  allSelected, toggleAll, selected, toggleOne,
  expanded, toggleExpand,
  onEdit, onDelete,
}) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 380px)' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'separate',
          borderSpacing: 0,
          fontFamily: T.font.ui,
        }}>
          <thead>
            <tr style={{
              position: 'sticky',
              top: 0,
              background: T.bg.surface2,
              zIndex: 5,
            }}>
              <Th w={36} center>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  style={{ cursor: 'pointer' }}
                />
              </Th>
              <Th sortKey="identity" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
                  hint="Erste FNSKU / SKU / EAN — siehe Detail für alle Codes">
                Identity
              </Th>
              <Th sortKey="title" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Titel</Th>
              <Th sortKey="lengthCm" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
                  align="right" mono w={130}
                  hint="Länge × Breite × Höhe in cm">L × B × H</Th>
              <Th sortKey="weightKg" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
                  align="right" mono w={70}>kg</Th>
              <Th sortKey="palletLoadMax" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
                  align="right" mono w={80}
                  hint="Max. Anzahl Kartons dieses Formats auf einer EUR-Palette">
                Max/Pal.
              </Th>
              <Th w={100}>Quelle</Th>
              <Th sortKey="updated" sortBy={sortBy} sortDir={sortDir} onSort={onSort} w={140}>
                Letzte Änderung
              </Th>
              <Th w={86}>Aktionen</Th>
              <Th w={28} />
            </tr>
          </thead>
          <tbody>
            {items.map((r, i) => {
              const isExpanded = expanded.has(r.id);
              const isSelected = selected.has(r.id);
              return (
                <DimRow
                  key={r.id}
                  row={r}
                  index={i}
                  isLast={i === items.length - 1}
                  isExpanded={isExpanded}
                  isSelected={isSelected}
                  onToggleSelect={() => toggleOne(r.id)}
                  onToggleExpand={() => toggleExpand(r.id)}
                  onEdit={() => onEdit(r)}
                  onDelete={() => onDelete(r)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

interface ThProps {
  children?: ReactNode;
  sortKey?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc' | string;
  onSort?: (key: string) => void;
  w?: number | string;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  center?: boolean;
  hint?: string;
}

function Th({ children, sortKey, sortBy, sortDir, onSort, w, align = 'left', mono, center, hint }: ThProps) {
  const sortable = !!sortKey && !!onSort;
  const isSorted = sortable && sortBy === sortKey;
  return (
    <th
      onClick={sortable ? () => onSort(sortKey) : undefined}
      title={hint}
      style={{
        textAlign: center ? 'center' : align,
        fontSize: 11,
        fontWeight: 600,
        color: isSorted ? T.text.primary : T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '10px 12px',
        borderBottom: `1px solid ${T.border.primary}`,
        background: T.bg.surface2,
        width: w,
        whiteSpace: 'nowrap',
        cursor: sortable ? 'pointer' : 'default',
        userSelect: 'none',
        fontFamily: mono ? T.font.mono : T.font.ui,
      }}
    >
      {children}
      {isSorted && (
        <span style={{ marginLeft: 4, color: T.accent.main }}>
          {sortDir === 'desc' ? '↓' : '↑'}
        </span>
      )}
    </th>
  );
}

interface DimRowProps {
  row: DimRow;
  index: number;
  isLast: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function DimRow({ row, isLast, isExpanded, isSelected, onToggleSelect, onToggleExpand, onEdit, onDelete }: DimRowProps) {
  const totalKeys = row.fnskus.length + row.skus.length + row.eans.length;
  const updated = formatRelative(row.updatedAt);
  return (
    <>
      <tr
        onClick={onToggleExpand}
        style={{
          cursor: 'pointer',
          background: isExpanded ? T.bg.surface2 : isSelected ? T.accent.bg : T.bg.surface,
          transition: 'background 100ms',
        }}
        onMouseEnter={(e) => { if (!isExpanded && !isSelected) e.currentTarget.style.background = T.bg.surface2; }}
        onMouseLeave={(e) => { if (!isExpanded && !isSelected) e.currentTarget.style.background = T.bg.surface; }}
      >
        <Td center w={36}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            style={{ cursor: 'pointer' }}
          />
        </Td>
        <Td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 13,
              color: T.text.primary,
              fontWeight: 500,
            }}>
              {primaryKey(row)}
            </span>
            {totalKeys > 1 && (
              <span style={{
                fontSize: 10.5,
                fontWeight: 600,
                padding: '1px 6px',
                background: T.accent.bg,
                color: T.accent.text,
                borderRadius: T.radius.full,
              }}>
                +{totalKeys - 1}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: T.text.subtle, marginTop: 1 }}>
            {keyTypeSummary(row)}
          </div>
        </Td>
        <Td>
          <div style={{
            fontSize: 13,
            color: T.text.primary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 320,
          }} title={row.title || ''}>
            {row.title || <span style={{ color: T.text.faint }}>— ohne Titel</span>}
          </div>
        </Td>
        <Td align="right" mono>
          {row.lengthCm.toFixed(1)} × {row.widthCm.toFixed(1)} × {row.heightCm.toFixed(1)}
        </Td>
        <Td align="right" mono>{row.weightKg.toFixed(2)}</Td>
        <Td align="right" mono>
          {row.palletLoadMax != null ? row.palletLoadMax : (
            <span style={{ color: T.text.faint }}>—</span>
          )}
        </Td>
        <Td><SourceBadge source={row.source} /></Td>
        <Td>
          <div style={{ fontSize: 12, color: T.text.secondary }}>{updated.short}</div>
          {row.updatedBy && (
            <div style={{ fontSize: 10.5, color: T.text.faint, marginTop: 1 }}>
              {row.updatedBy}
            </div>
          )}
        </Td>
        <Td>
          <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
            <button onClick={onEdit} style={smallBtn} title="Bearbeiten">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M11 2l3 3-9 9H2v-3l9-9z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button onClick={onDelete}
                    style={{ ...smallBtn, color: T.status.danger.text }}
                    title="Löschen">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M3 4h10M6 4V2.5h4V4M5 4l1 9h4l1-9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </Td>
        <Td center>
          <span style={{
            display: 'inline-block',
            transition: 'transform 200ms',
            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)',
            color: T.text.faint,
          }}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </Td>
      </tr>
      {isExpanded && (
        <tr style={{ background: T.bg.surface2 }}>
          <td colSpan={10} style={{
            padding: 0,
            borderBottom: !isLast ? `1px solid ${T.border.subtle}` : 'none',
          }}>
            <DimRowExpansion row={row} updated={updated} />
          </td>
        </tr>
      )}
    </>
  );
}

function Td({ children, center, align = 'left', mono, w }: { children?: ReactNode; center?: boolean; align?: 'left' | 'right' | 'center'; mono?: boolean; w?: number | string }) {
  return (
    <td style={{
      padding: '10px 12px',
      borderBottom: `1px solid ${T.border.subtle}`,
      textAlign: center ? 'center' : align,
      fontSize: 13,
      fontFamily: mono ? T.font.mono : T.font.ui,
      fontVariantNumeric: mono ? 'tabular-nums' : 'normal',
      color: T.text.primary,
      verticalAlign: 'middle',
      width: w,
    }}>
      {children}
    </td>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Expanded row — full keys, audit, computed numbers
   ════════════════════════════════════════════════════════════════════════ */
function DimRowExpansion({ row, updated }: { row: DimRow; updated: { short: string; full: string } }) {
  const volumeCm3 = row.lengthCm * row.widthCm * row.heightCm;
  const volumeL = volumeCm3 / 1000;
  const density = volumeCm3 > 0 ? row.weightKg / (volumeCm3 / 1e6) : 0;  // kg/m³

  return (
    <div style={{ padding: '20px 28px 22px 60px' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)',
        gap: 32,
      }}>
        {/* Left — keys */}
        <div>
          <SectionLabel>Codes</SectionLabel>
          <KeyGroup label="FNSKU" items={row.fnskus} accent={T.accent} />
          <KeyGroup label="SKU"   items={row.skus}   accent={T.accent} />
          <KeyGroup label="EAN"   items={row.eans}   accent={T.accent} />
          {row.title && (
            <>
              <SectionLabel style={{ marginTop: 16 }}>Titel</SectionLabel>
              <div style={{
                fontSize: 13.5,
                color: T.text.primary,
                lineHeight: 1.5,
                background: T.bg.surface,
                padding: '8px 12px',
                borderRadius: T.radius.sm,
                border: `1px solid ${T.border.subtle}`,
              }}>{row.title}</div>
            </>
          )}
        </div>

        {/* Right — derived data + audit */}
        <div>
          <SectionLabel>Physik</SectionLabel>
          <DimMetric label="Länge × Breite × Höhe"
                     value={`${row.lengthCm.toFixed(1)} × ${row.widthCm.toFixed(1)} × ${row.heightCm.toFixed(1)} cm`} />
          <DimMetric label="Gewicht je Einheit" value={`${row.weightKg.toFixed(2)} kg`} />
          <DimMetric label="Volumen je Einheit"
                     value={`${volumeL.toFixed(2)} L`}
                     hint="L × B × H, ohne Pack-Coeff" />
          <DimMetric label="Dichte" value={density > 0 ? `${density.toFixed(0)} kg/m³` : '—'}
                     hint="Gewicht / Volumen — Plausibilitätscheck. Wasser ≈ 1000 kg/m³" />
          <DimMetric label="Max. Kartons / Palette"
                     value={row.palletLoadMax != null ? row.palletLoadMax : '—'}
                     hint="Empirische Obergrenze: wieviele Kartons dieses Formats physisch auf eine EUR-Palette passen (Stapelhöhe + Bodenrand-Verluste)" />
          {row.palletLoadMax != null && (
            <DimMetric label="↑ Beitrag pro Karton"
                       value={`${(100 / row.palletLoadMax).toFixed(2)} %`}
                       hint="Welchen Anteil der Pallet-Kapazität ein einzelner Karton dieses Formats belegt" />
          )}

          <SectionLabel style={{ marginTop: 16 }}>Audit</SectionLabel>
          <DimMetric label="Quelle" value={<SourceBadge source={row.source} />} />
          <DimMetric label="Letzte Änderung" value={updated.full} />
          {row.updatedBy && <DimMetric label="Zuletzt von" value={row.updatedBy} mono />}
          <DimMetric label="DB-ID" value={`#${row.id}`} mono />
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 10.5,
      fontWeight: 600,
      color: T.text.subtle,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      marginBottom: 8,
      ...style,
    }}>{children}</div>
  );
}

function KeyGroup({ label, items }: { label: string; items: string[]; accent?: typeof T.accent }) {
  const arr = items || [];
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 500,
        color: T.text.subtle,
        marginBottom: 4,
      }}>
        {label} <span style={{ color: T.text.faint }}>·</span>{' '}
        <span style={{ fontVariantNumeric: 'tabular-nums', color: T.text.primary, fontWeight: 600 }}>
          {arr.length}
        </span>
      </div>
      {arr.length === 0 ? (
        <span style={{ fontSize: 12, color: T.text.faint, fontStyle: 'italic' }}>keine</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {arr.map((k) => <KeyChip key={k} value={k} />)}
        </div>
      )}
    </div>
  );
}

function KeyChip({ value }: { value: string }) {
  const [flash, setFlash] = useState(false);
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setFlash(true);
      setTimeout(() => setFlash(false), 800);
    } catch {
      /* clipboard may be blocked in some contexts — silently ignore */
    }
  };
  return (
    <button
      onClick={onCopy}
      title={`${value} — klick zum Kopieren`}
      style={{
        fontFamily: T.font.mono,
        fontSize: 12,
        padding: '3px 8px',
        background: flash ? T.status.success.bg : T.bg.surface,
        border: `1px solid ${flash ? T.status.success.border : T.border.primary}`,
        borderRadius: T.radius.sm,
        color: flash ? T.status.success.text : T.text.primary,
        cursor: 'pointer',
        transition: 'all 120ms',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      {value}
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ opacity: flash ? 1 : 0.4 }}>
        {flash ? (
          <path d="M3 8l3.5 3.5L13 4" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round"/>
        ) : (
          <>
            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M3 11V3a1 1 0 011-1h7" stroke="currentColor" strokeWidth="1.3"
                  strokeLinecap="round"/>
          </>
        )}
      </svg>
    </button>
  );
}

function DimMetric({ label, value, hint, mono }: { label: string; value: ReactNode; hint?: string; mono?: boolean }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 12,
      padding: '5px 0',
      borderBottom: `1px solid ${T.border.subtle}`,
      alignItems: 'baseline',
    }}>
      <span style={{ fontSize: 12, color: T.text.subtle }} title={hint}>{label}</span>
      <span style={{
        fontSize: 13,
        fontWeight: 500,
        color: T.text.primary,
        fontFamily: mono ? T.font.mono : T.font.ui,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
      }}>{value}</span>
    </div>
  );
}

function SourceBadge({ source }: { source: string | null }) {
  const map: Record<string, { label: string; color: string; bg: string; border: string }> = {
    manual:      { label: 'Manuell',  color: T.accent.text, bg: T.accent.bg, border: T.accent.border },
    xlsx_import: { label: 'xlsx',     color: T.text.muted, bg: T.bg.surface3, border: T.border.primary },
  };
  const m = (source && map[source]) || { label: source || '—', color: T.text.muted, bg: T.bg.surface3, border: T.border.primary };
  return (
    <span style={{
      fontSize: 10.5,
      fontWeight: 600,
      padding: '2px 8px',
      background: m.bg,
      color: m.color,
      border: `1px solid ${m.border}`,
      borderRadius: T.radius.full,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>{m.label}</span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Pagination
   ════════════════════════════════════════════════════════════════════════ */
function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (next: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / limit));
  if (total <= limit) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      gap: 8, padding: '14px 4px 4px',
    }}>
      <span style={{ fontSize: 12, color: T.text.subtle, fontFamily: T.font.ui }}>
        Seite <strong style={{ color: T.text.primary, fontVariantNumeric: 'tabular-nums' }}>
          {page + 1}
        </strong> / {pageCount} ({total} insgesamt)
      </span>
      <button onClick={() => onPage(page - 1)} disabled={page === 0} style={pageBtn}>‹</button>
      <button onClick={() => onPage(page + 1)} disabled={page >= pageCount - 1} style={pageBtn}>›</button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Edit modal — full create/update form
   ════════════════════════════════════════════════════════════════════════ */
interface DimensionEditModalProps {
  row: DimRow | null;
  onClose: () => void;
  onSave: (payload: SkuDimensionUpsert) => void;
  saving: boolean;
}

function DimensionEditModal({ row, onClose, onSave, saving }: DimensionEditModalProps) {
  const isNew = !row;
  const [form, setForm] = useState({
    fnskus: (row?.fnskus || []).join(', '),
    skus: (row?.skus || []).join(', '),
    eans: (row?.eans || []).join(', '),
    title: row?.title || '',
    lengthCm: row?.lengthCm ?? '',
    widthCm: row?.widthCm ?? '',
    heightCm: row?.heightCm ?? '',
    weightKg: row?.weightKg ?? '',
    palletLoadMax: row?.palletLoadMax ?? '',
  });

  // Esc closes the modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fnskus = parseKeyList(form.fnskus);
    const skus = parseKeyList(form.skus);
    const eans = parseKeyList(form.eans);
    if (!(fnskus.length || skus.length || eans.length)) {
      alert('Mindestens ein FNSKU/SKU/EAN ist erforderlich.');
      return;
    }
    for (const k of ['lengthCm', 'widthCm', 'heightCm', 'weightKg']) {
      const n = parseFloat(form[k]);
      if (!isFinite(n) || n <= 0) {
        alert(`${k} muss eine positive Zahl sein.`);
        return;
      }
    }
    // Pallet load is OPTIONAL — empty stays null. Reject only on
     // non-empty non-positive integer.
    let palletLoadMax: number | null = null;
    const rawPL = String(form.palletLoadMax || '').trim();
    if (rawPL) {
      const n = parseInt(rawPL, 10);
      if (!isFinite(n) || n < 1) {
        alert('Max. Kartons / Palette muss eine positive ganze Zahl sein (oder leer lassen).');
        return;
      }
      palletLoadMax = n;
    }
    onSave({
      fnskus, skus, eans,
      title: form.title || null,
      lengthCm: parseFloat(String(form.lengthCm)),
      widthCm: parseFloat(String(form.widthCm)),
      heightCm: parseFloat(String(form.heightCm)),
      weightKg: parseFloat(String(form.weightKg)),
      palletLoadMax,
    });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: T.radius.lg,
          padding: 24,
          width: 560,
          maxWidth: '92vw',
          boxShadow: T.shadow.modal,
        }}
      >
        <h3 style={{ margin: 0, marginBottom: 4, fontSize: 16, fontWeight: 600 }}>
          {isNew ? 'Neuer Dimensions-Eintrag' : 'Eintrag bearbeiten'}
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: T.text.subtle }}>
          Mehrere Codes pro Feld kommagetrennt eingeben — derselbe physische Karton
          kann unter mehreren FNSKUs / SKUs ausgeliefert werden.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FieldInput label="FNSKU(s)" value={form.fnskus} onChange={(v) => setForm({ ...form, fnskus: v })} placeholder="X001ABC, X001DEF" />
          <FieldInput label="SKU(s)"   value={form.skus}   onChange={(v) => setForm({ ...form, skus: v })}   placeholder="9V-XX, LK-YY" />
          <FieldInput label="EAN(s)"   value={form.eans}   onChange={(v) => setForm({ ...form, eans: v })}   placeholder="9120107187389" />
          <FieldInput label="Titel"    value={form.title}  onChange={(v) => setForm({ ...form, title: v })}  placeholder="z. B. Thermorollen 57×40" />
          <FieldInput label="L (cm)" type="number" step="0.1" value={form.lengthCm} onChange={(v) => setForm({ ...form, lengthCm: v })} />
          <FieldInput label="B (cm)" type="number" step="0.1" value={form.widthCm}  onChange={(v) => setForm({ ...form, widthCm: v })} />
          <FieldInput label="H (cm)" type="number" step="0.1" value={form.heightCm} onChange={(v) => setForm({ ...form, heightCm: v })} />
          <FieldInput label="Gewicht (kg)" type="number" step="0.01" value={form.weightKg} onChange={(v) => setForm({ ...form, weightKg: v })} />
          <FieldInput label="Max. Kartons / Palette"
                      type="number" step="1"
                      value={form.palletLoadMax}
                      onChange={(v) => setForm({ ...form, palletLoadMax: v })}
                      placeholder="z. B. 79 (leer lassen wenn unbekannt)" />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={smallBtn}>Abbrechen</button>
          <button type="submit" disabled={saving} style={btnPrimary}>
            {saving ? 'Speichern…' : (isNew ? 'Anlegen' : 'Speichern')}
          </button>
        </div>
      </form>
    </div>
  );
}

function FieldInput({ label, value, onChange, type = 'text', step, placeholder }: { label: string; value: string | number; onChange: (v: string) => void; type?: string; step?: string; placeholder?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontSize: 11, fontWeight: 500, color: T.text.subtle,
        textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>{label}</span>
      <input
        type={type}
        step={step}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '7px 10px',
          border: `1px solid ${T.border.strong}`,
          borderRadius: T.radius.sm,
          fontSize: 13,
          fontFamily: T.font.ui,
          background: T.bg.surface,
          color: T.text.primary,
          outline: 'none',
        }}
      />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════════════ */

function primaryKey(r) {
  return r.fnskus[0] || r.skus[0] || r.eans[0] || '—';
}

function keyTypeSummary(r) {
  const parts: string[] = [];
  if (r.fnskus.length) parts.push(`${r.fnskus.length} FNSKU`);
  if (r.skus.length)   parts.push(`${r.skus.length} SKU`);
  if (r.eans.length)   parts.push(`${r.eans.length} EAN`);
  return parts.join(' · ');
}

function computeStats(items) {
  const out = {
    withFnsku: 0, multiKey: 0, manual: 0, xlsx: 0, incomplete: 0,
    avgWeight: 0, avgVolume: 0,
  };
  if (!items.length) return out;
  let wSum = 0, vSum = 0;
  for (const r of items) {
    const totalKeys = r.fnskus.length + r.skus.length + r.eans.length;
    if (r.fnskus.length) out.withFnsku += 1;
    if (totalKeys > 1)   out.multiKey += 1;
    if (r.source === 'manual')      out.manual += 1;
    if (r.source === 'xlsx_import') out.xlsx   += 1;
    if (!r.title || r.fnskus.length === 0) out.incomplete += 1;
    wSum += r.weightKg;
    vSum += r.lengthCm * r.widthCm * r.heightCm / 1000;
  }
  out.avgWeight = wSum / items.length;
  out.avgVolume = vSum / items.length;
  return out;
}

function parseKeyList(text) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(text || '').split(/[,;\n]/)) {
    const s = part.trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function formatRelative(iso) {
  const d = new Date(iso);
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  let short;
  if (diffSec < 60)         short = `vor ${diffSec}s`;
  else if (diffSec < 3600)  short = `vor ${Math.round(diffSec / 60)} min`;
  else if (diffSec < 86400) short = `vor ${Math.round(diffSec / 3600)} h`;
  else if (diffSec < 86400 * 7) short = `vor ${Math.round(diffSec / 86400)} Tg`;
  else                      short = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const full = d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  return { short, full };
}

/* ─── Inline button styles ─────────────────────────────────────────── */
const btnPrimary = {
  padding: '8px 16px',
  background: T.accent.main,
  color: T.accent.text,
  border: 'none',
  borderRadius: T.radius.sm,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const btnGhost = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 14px',
  background: T.bg.surface,
  color: T.text.primary,
  border: `1px solid ${T.border.strong}`,
  borderRadius: T.radius.sm,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const smallBtn = {
  padding: '5px 10px',
  background: T.bg.surface,
  border: `1px solid ${T.border.strong}`,
  borderRadius: T.radius.sm,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: T.font.ui,
  color: T.text.primary,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const pageBtn = {
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: T.bg.surface,
  border: `1px solid ${T.border.strong}`,
  borderRadius: T.radius.sm,
  cursor: 'pointer',
  fontSize: 14,
  color: T.text.primary,
};