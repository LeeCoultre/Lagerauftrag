// @ts-nocheck — pragmatic typing; reuses Lynne types loosely via plan shape
/* BestellungPanel — slide-in panel that visualises the auto-generated
   FBA order plan from composeBestellung(). MVP rendering: stats header
   + flat list of palette cards. Each palette card shows id, type pill
   (SINGLE / MIXED), fill %, overload flags, and the SKU breakdown.
   Closes on backdrop click, Esc, or × button. */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import './BestellungPanel.css';
import type { BestellungPalette, BestellungPlan } from '@/utils/bestellungGenerator';

const fmtNum = new Intl.NumberFormat('de-DE');
const fmt1   = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

interface Props {
  open: boolean;
  plan: BestellungPlan | null;
  onClose: () => void;
}

export default function BestellungPanel({ open, plan, onClose }: Props) {
  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`bp-backdrop${open ? ' bp-open' : ''}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`bp-panel${open ? ' bp-open' : ''}`}
        role="dialog"
        aria-label="Bestellung-Vorschlag"
        aria-hidden={!open}
      >
        <header className="bp-header">
          <div className="bp-header-row">
            <div>
              <div className="bp-title">Bestellung-Vorschlag</div>
              <div className="bp-subtitle">Auto-generiert · MVP</div>
            </div>
            <button
              type="button"
              className="bp-close"
              onClick={onClose}
              aria-label="Schließen"
            >
              <X size={16} strokeWidth={2.2} />
            </button>
          </div>

          {plan && plan.stats.totalPalettes > 0 && (
            <>
              <div className="bp-stats">
                <Stat
                  label="Paletten"
                  value={fmtNum.format(plan.stats.totalPalettes)}
                  sub={`${plan.stats.singlePalettes} S · ${plan.stats.mixedPalettes} M`}
                />
                <Stat
                  label="Einheiten"
                  value={fmtNum.format(plan.stats.totalUnits)}
                  sub="Stk insg."
                />
                <Stat
                  label="Gewicht"
                  value={`${fmt1.format(plan.stats.totalWeightKg)}`}
                  sub="kg"
                />
                <Stat
                  label="Volumen"
                  value={`${fmt1.format(plan.stats.totalVolM3)}`}
                  sub="m³"
                />
              </div>

              <div className="bp-warnings">
                {plan.stats.urgentSkus > 0 && (
                  <span className="bp-warning">
                    {plan.stats.urgentSkus} URGENT
                  </span>
                )}
                {plan.stats.overloadPalettes > 0 && (
                  <span className="bp-warning">
                    {plan.stats.overloadPalettes} OVERLOAD
                  </span>
                )}
                {plan.stats.unassignedItems > 0 && (
                  <span className="bp-warning">
                    {plan.stats.unassignedItems} unplaziert
                  </span>
                )}
              </div>
            </>
          )}
        </header>

        <div className="bp-body">
          {(!plan || plan.stats.totalPalettes === 0) && (
            <div className="bp-empty">
              <div className="bp-empty-title">Keine Bestellung erforderlich</div>
              <div className="bp-empty-sub">
                Aktuell hat keine SKU den URGENT- oder READY-Status.<br />
                Wenn sich Bestand reduziert, erscheinen hier Paletten-Vorschläge.
              </div>
            </div>
          )}
          {plan?.palettes.map((p) => (
            <PaletteCard key={p.id} pal={p} />
          ))}
        </div>
      </aside>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bp-stat">
      <span className="bp-stat-label">{label}</span>
      <span className="bp-stat-value">{value}</span>
      {sub && <span className="bp-stat-sub">{sub}</span>}
    </div>
  );
}

function PaletteCard({ pal }: { pal: BestellungPalette }) {
  const fillPct = Math.max(pal.fillPctVol, pal.fillPctWeight);
  const isOverload = pal.overloadFlags.size > 0;
  return (
    <article className={`bp-card${pal.hasUrgent ? ' bp-card-urgent' : ''}`}>
      <header className="bp-card-head">
        <span className="bp-card-id">{pal.id}</span>
        <span className={`bp-type-pill bp-type-pill-${pal.type}`}>
          {pal.type === 'single' ? 'Single SKU' : 'Mixed'}
        </span>
        {pal.overloadFlags.has('OVERLOAD-W') && (
          <span className="bp-flag">OVL-W</span>
        )}
        {pal.overloadFlags.has('OVERLOAD-V') && (
          <span className="bp-flag">OVL-V</span>
        )}
        <span className="bp-card-spacer" />
        <span className="bp-card-fill">
          <span className="bp-fill-pct">{Math.round(fillPct * 100)} %</span>
          <span className="bp-fill-bar" aria-hidden>
            <span
              className={`bp-fill-bar-fg${isOverload ? ' bp-fill-overload' : ''}`}
              style={{ width: `${Math.min(100, fillPct * 100)}%` }}
            />
          </span>
        </span>
      </header>

      <div className="bp-items">
        {pal.items.map((it, idx) => (
          <div key={`${it.row.sku}-${idx}`} className="bp-item">
            <div>
              {it.isUrgent && <span className="bp-item-urgent-dot" aria-hidden />}
            </div>
            <div className="bp-item-title">
              <span className="bp-item-title-main" title={it.row.description}>
                {it.row.description || it.row.sku}
              </span>
              <span className="bp-item-title-sub">
                {it.row.sku}{it.row.ean ? ` · ${it.row.ean}` : ''}
              </span>
            </div>
            <span className="bp-item-units">{fmtNum.format(it.units)}</span>
            <span className="bp-item-meta">
              {fmt1.format(it.weightKg)} kg
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}
