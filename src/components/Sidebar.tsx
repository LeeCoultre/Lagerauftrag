/* Sidebar — Marathon navigation rail.

   Design ethos: subdued accent. The orange accent is reserved for
   STATUS (pulse dot) and ACTION (CTA buttons, accent rail). Active
   nav items are intentionally neutral — a single 2px accent rail
   slides between them like a Linear/Vercel cursor, the rest of the
   item is a soft surface3 fill with normal-weight text. This keeps
   the eye on the workspace, not the navigation.

   Composition:
     • WorkspaceHeader  — hairline status ring + operator badge + shift timer
     • QuickSearchRail  — compact ⌘K affordance under the header
     • NavBlock         — measured active rail that animates between groups
     • CurrentProgress  — slot for the active workflow (only when current)
     • SidebarFooter    — UserSwitcher + Today pulse + sparkline + ⌘K iconlet
*/

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '@/state.jsx';
import { useMe } from '@/hooks/useMe.js';
import { useApiHealth } from '@/hooks/useApiHealth.js';
import { Mark } from './Logo.jsx';
import { T } from './ui.jsx';
import { UserSwitcher } from './UserSwitcher.jsx';
import { useBetaDesign } from '@/hooks/useBetaDesign';

const SIZES = { expanded: 248, collapsed: 60 };
// eslint-disable-next-line react-refresh/only-export-components -- shared layout constant
export const SIDEBAR_WIDTH = SIZES.expanded;

const COLLAPSED_KEY = 'marathon.sidebar.collapsed.v1';

function useCollapsedSidebar(): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
    document.documentElement.style.setProperty(
      '--sidebar-width', `${collapsed ? SIZES.collapsed : SIZES.expanded}px`,
    );
  }, [collapsed]);
  return [collapsed, setCollapsed];
}

/* ─── Groups ────────────────────────────────────────────────────────
   Sub-text was removed — Linear-style nav lives by the label alone.
   The hover-peek tooltip in collapsed mode shows the long form. */
function buildGroups({ current, queue, history, me, beta }) {
  return [
    /* Beta-only entry — sits above all groups, no section label, custom
       brand icon. Hidden entirely when beta is off so classic mode stays
       byte-identical. */
    beta && {
      id: 'lynne',
      label: '',
      items: [
        { id: 'lynne-table', label: 'LYNNE Table',
          peek: 'Beta · neu',
          icon: <IconLynneTable /> },
      ],
    },
    {
      id: 'work',
      label: 'Work',
      items: [
        { id: 'workspace',     label: current ? 'Workflow' : 'Upload',
          peek: current ? 'Aktiver Auftrag' : 'Datei laden',
          icon: <IconWorkflow /> },
        { id: 'warteschlange', label: 'Warteschlange',
          peek: queue.length > 0 ? `${queue.length} bereit` : 'Reihenfolge',
          counter: queue.length > 0 ? queue.length : null,
          icon: <IconQueue /> },
        { id: 'suche',         label: 'Suche',
          peek: 'FNSKU · SKU · EAN · SN',
          icon: <IconSearch /> },
      ],
    },
    {
      id: 'insight',
      label: 'Insight',
      items: [
        { id: 'historie', label: 'Historie',
          peek: 'Abgeschlossene Aufträge',
          counter: history.length > 0 ? history.length : null,
          icon: <IconHistory /> },
        { id: 'live',     label: 'Live',
          peek: 'Aktivität · Schichtfeed',
          icon: <IconLive /> },
        { id: 'berichte', label: 'Berichte',
          peek: 'xlsx-Export',
          icon: <IconReport /> },
      ],
    },
    {
      id: 'system',
      label: 'System',
      items: [
        { id: 'einstellungen', label: 'Einstellungen',
          peek: 'Akzent · Experimente',
          icon: <IconSettings /> },
        me?.role === 'admin' && {
          id: 'admin', label: 'Admin',
          peek: 'Übersicht & Benutzer',
          icon: <IconAdmin /> },
      ].filter(Boolean),
    },
  ].filter(Boolean);
}

export function Sidebar({ route, onRoute, onOpenCommand }) {
  const { queue, history, current } = useAppState();
  const me = useMe().data;
  const [collapsed, setCollapsed] = useCollapsedSidebar();
  const { beta } = useBetaDesign();
  const groups = buildGroups({ current, queue, history, me, beta });

  const width = collapsed ? SIZES.collapsed : SIZES.expanded;

  return (
    <aside style={beta ? {
      /* Beta island sidebar — shares the visual language of FlowHero /
         BetaIslandBar: paper-grey #F4F5F7 fill, 2px white rim, soft
         halo shadow. The `--sidebar-width` CSS var (set by the
         collapsed hook) covers only the body width — AppShell adds
         extra left padding for the floating gap so content doesn't
         slide under the island. */
      position: 'fixed',
      top: 12,
      left: 12,
      bottom: 12,
      width,
      background: '#F4F5F7',
      border: '2px solid #FFFFFF',
      borderRadius: 32,
      boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 20,
      fontFamily: T.font.ui,
      transition: 'width 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      overflow: 'hidden',
    } : {
      width,
      height: '100vh',
      position: 'sticky',
      top: 0,
      background: T.bg.surface,
      borderRight: `1px solid ${T.border.primary}`,
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      zIndex: 20,
      fontFamily: T.font.ui,
      transition: 'width 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      overflow: 'hidden',
    }}>
      <SidebarStyles />

      <WorkspaceHeader
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />

      {!collapsed && onOpenCommand && (
        <QuickSearchRail onOpen={onOpenCommand} />
      )}

      <NavBlock
        route={route}
        onRoute={onRoute}
        groups={groups}
        collapsed={collapsed}
      />

      <div style={{ flex: 1, minHeight: 0 }} />

      {/* CurrentProgress hidden in beta-design: workflow status now
          lives entirely on the workspace surface (BetaIslandBar, hero
          chips). Classic-mode keeps the sidebar card unchanged. */}
      {current && !beta && (
        <CurrentProgress
          current={current}
          collapsed={collapsed}
          onClick={() => onRoute('workspace')}
        />
      )}

      <SidebarFooter
        collapsed={collapsed}
        history={history}
      />
    </aside>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   GLOBAL STYLES — scoped via class names. Hairline scrollbar,
   keyframes, rail transitions.
   ════════════════════════════════════════════════════════════════════════ */
function SidebarStyles() {
  return (
    <style>{`
      .mp-sidebar-scroll::-webkit-scrollbar {
        width: 4px;
      }
      .mp-sidebar-scroll::-webkit-scrollbar-thumb {
        background: ${T.border.primary};
        border-radius: 4px;
      }
      .mp-sidebar-scroll::-webkit-scrollbar-thumb:hover {
        background: ${T.border.strong};
      }
      .mp-sidebar-scroll {
        scrollbar-width: thin;
        scrollbar-color: ${T.border.primary} transparent;
      }
      @keyframes mp-counter-pop {
        0%   { transform: scale(1); }
        45%  { transform: scale(1.18); }
        100% { transform: scale(1); }
      }
      @keyframes mp-status-ring {
        0%   { box-shadow: 0 0 0 0 var(--accent-main); opacity: 0.6; }
        70%  { box-shadow: 0 0 0 5px transparent; opacity: 0; }
        100% { box-shadow: 0 0 0 0 transparent; opacity: 0; }
      }
    `}</style>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   WORKSPACE HEADER — hairline status ring around the logo, compact
   operator badge under it. Status pulse: 1px ring colour change,
   no thick double-rings.
   ════════════════════════════════════════════════════════════════════════ */
const STATUS_TONE = {
  ok:       { dot: '#10B981', ring: '#A7F3D0', label: 'Online' },
  degraded: { dot: '#F59E0B', ring: '#FDE68A', label: 'DB-Fehler' },
  offline:  { dot: '#9CA3AF', ring: '#E5E7EB', label: 'Offline' },
};

function WorkspaceHeader({ collapsed, onToggle }) {
  const healthQ = useApiHealth();
  const status = healthQ.data?.status || 'offline';
  const tone = STATUS_TONE[status] || STATUS_TONE.offline;
  const elapsedMs = healthQ.data?.elapsedMs;
  const statusTitle = status === 'ok'
    ? `Online${elapsedMs != null ? ` · ${elapsedMs} ms` : ''}`
    : status === 'degraded' ? 'API ok, DB nicht erreichbar'
    : 'Backend nicht erreichbar';

  return (
    <div style={{
      padding: collapsed ? '18px 0 10px' : '18px 16px 14px',
      borderBottom: `1px solid ${T.border.subtle}`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: collapsed ? 'center' : 'stretch',
      gap: collapsed ? 10 : 12,
      position: 'relative',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: 10,
      }}>
        <span
          title={statusTitle}
          style={{
            position: 'relative',
            display: 'inline-flex',
            padding: 2,
            borderRadius: 9,
            border: `1px solid ${tone.ring}`,
            transition: 'border-color 240ms',
          }}
        >
          <Mark size={collapsed ? 28 : 24} />
          <span style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tone.dot,
            border: `2px solid ${T.bg.surface}`,
          }} />
        </span>

        {!collapsed && (
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0, flex: 1 }}>
            <span style={{
              fontSize: 13.5,
              fontWeight: 500,
              color: T.text.primary,
              letterSpacing: '-0.012em',
            }}>
              Marathon
            </span>
            <span style={{
              fontSize: 10,
              color: T.text.faint,
              fontWeight: 500,
              fontFamily: T.font.mono,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginTop: 1,
            }}>
              {tone.label}
            </span>
          </div>
        )}
      </div>

      <CollapseToggle collapsed={collapsed} onClick={onToggle} />
    </div>
  );
}

function CollapseToggle({ collapsed, onClick }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? 'Sidebar ausklappen' : 'Sidebar einklappen'}
      style={{
        /* Expanded: anchored to the bottom-right corner of the header
           via absolute positioning. Collapsed: a centred flex-child so
           the natural gap between header and nav appears below it. */
        position: collapsed ? 'static' : 'absolute',
        right: collapsed ? 'auto' : 6,
        bottom: collapsed ? 'auto' : 6,
        width: 18,
        height: 18,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#FFFFFF',
        border: '1px solid transparent',
        borderRadius: '50%',
        color: T.text.faint,
        cursor: 'pointer',
        padding: 0,
        transition: 'all 160ms',
        zIndex: 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = T.text.secondary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = T.text.faint;
      }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" style={{
        transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
        transition: 'transform 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        <path d="M3 1.5l2.5 2.5-2.5 2.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   QUICK-SEARCH RAIL — Cursor-style. A single non-input row, click
   opens the CommandPalette. Cheaper than a real input + we don't
   accidentally shadow the global ⌘K listener.
   ════════════════════════════════════════════════════════════════════════ */
function QuickSearchRail({ onOpen }) {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
  return (
    <button
      onClick={onOpen}
      style={{
        margin: '12px 12px 4px',
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: '#FFFFFF',
        border: '1px solid transparent',
        borderRadius: 12,
        cursor: 'pointer',
        fontFamily: T.font.ui,
        transition: 'background 160ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = T.bg.surface2;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#FFFFFF';
      }}
    >
      <span style={{ color: T.text.faint, display: 'inline-flex' }}>
        <IconSearch />
      </span>
      <span style={{ flex: 1, textAlign: 'left', fontSize: 12, color: T.text.faint, fontWeight: 400 }}>
        Suchen oder springen…
      </span>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 22,
        height: 16,
        padding: '0 4px',
        fontSize: 9.5,
        fontWeight: 600,
        color: T.text.faint,
        background: T.bg.surface,
        border: `1px solid ${T.border.primary}`,
        borderRadius: 3,
        fontFamily: T.font.mono,
        letterSpacing: '0.04em',
      }}>
        {isMac ? '⌘K' : 'Ctrl K'}
      </span>
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   NAV BLOCK — measures the active item and renders a single accent
   rail at its position. The rail moves between groups, not just
   inside one. Layout-effect ensures we measure AFTER children paint.
   ════════════════════════════════════════════════════════════════════════ */
function NavBlock({ route, onRoute, groups, collapsed }) {
  return (
    <nav
      className="mp-sidebar-scroll"
      style={{
        position: 'relative',
        padding: collapsed ? '8px 8px 4px' : '12px 10px 4px',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        overflowY: 'auto',
        flexShrink: 0,
        maxHeight: '60vh',
      }}
    >
      {groups.map((group, gIdx) => (
        <NavGroup
          key={group.id}
          label={group.label}
          collapsed={collapsed}
          isFirst={gIdx === 0}
        >
          {group.items.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              active={route === item.id}
              onClick={() => onRoute(item.id)}
              collapsed={collapsed}
            />
          ))}
        </NavGroup>
      ))}
    </nav>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   NAV GROUP — mono-caps section labels with generous whitespace.
   ════════════════════════════════════════════════════════════════════════ */
function NavGroup({ label, isFirst, collapsed, children }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
      paddingTop: isFirst ? 0 : 14,
    }}>
      {!collapsed && label && (
        <div style={{
          padding: '2px 14px 6px',
          fontSize: 10.5,
          fontWeight: 500,
          color: T.text.faint,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontFamily: T.font.mono,
        }}>
          {label}
        </div>
      )}
      {collapsed && !isFirst && (
        <div style={{
          height: 1,
          margin: '8px 16px 8px',
          background: T.border.primary,
          opacity: 0.6,
        }} />
      )}
      {children}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   NAV ITEM — neutral active state, single-line label, optional
   counter. Sub-text gone. In collapsed mode, hover surfaces a peek
   tooltip with label + peek string.
   ════════════════════════════════════════════════════════════════════════ */
function NavItem({ item, active, onClick, collapsed }) {
  const btnRef = useRef(null);
  const [hover, setHover] = useState(false);

  const setBoth = (el) => {
    btnRef.current = el;
  };

  const button = (
    <button
      ref={setBoth}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: 11,
        width: '100%',
        padding: collapsed ? '11px 0' : '9px 12px 9px 16px',
        background: active
          ? '#FFFFFF'
          : (hover ? 'rgba(255, 255, 255, 0.55)' : 'transparent'),
        border: 0,
        borderRadius: 12,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 140ms cubic-bezier(0.16, 1, 0.3, 1)',
        fontFamily: T.font.ui,
        position: 'relative',
      }}
    >
      <span style={{
        display: 'inline-flex',
        width: 18,
        height: 18,
        flexShrink: 0,
        color: active ? T.text.primary : T.text.subtle,
        transition: 'color 140ms',
      }}>
        {item.icon}
      </span>

      {!collapsed && (
        <span style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13.5,
          fontWeight: active ? 500 : 400,
          color: active ? T.text.primary : T.text.secondary,
          letterSpacing: '-0.005em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {item.label}
        </span>
      )}

      {item.counter != null && !collapsed && (
        <Counter value={item.counter} active={active} />
      )}

      {item.counter != null && collapsed && (
        <span style={{
          position: 'absolute',
          top: 6,
          right: 8,
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: T.accent.main,
          border: `1.5px solid ${T.bg.surface}`,
        }} />
      )}
    </button>
  );

  if (!collapsed || !hover) return button;

  return (
    <>
      {button}
      <HoverPeek anchor={btnRef.current} label={item.label} sub={item.peek} counter={item.counter} />
    </>
  );
}

/* Counter chip — micro-animation when value changes. */
function Counter({ value, active }) {
  const prev = useRef(value);
  const [animKey, setAnimKey] = useState(0);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setAnimKey((k) => k + 1);
    }
  }, [value]);

  return (
    <span
      key={animKey}
      style={{
        minWidth: 18,
        height: 17,
        padding: '0 5px',
        background: active ? T.text.primary : T.bg.surface3,
        color: active ? T.bg.surface : T.text.subtle,
        fontSize: 10,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        letterSpacing: '0.01em',
        animation: 'mp-counter-pop 320ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {value}
    </span>
  );
}

/* Hover peek — fixed-positioned floating tooltip for collapsed mode.
   Anchored to the button via getBoundingClientRect. Re-measures
   whenever the anchor changes (different item, scroll). */
function HoverPeek({ anchor, label, sub, counter }) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!anchor) return undefined;
    const update = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ top: r.top + r.height / 2, left: r.right + 8 });
    };
    update();
    window.addEventListener('scroll', update, true);
    return () => window.removeEventListener('scroll', update, true);
  }, [anchor]);

  if (!anchor) return null;
  return (
    <div style={{
      position: 'fixed',
      top: pos.top,
      left: pos.left,
      transform: 'translateY(-50%)',
      padding: '6px 10px',
      background: T.text.primary,
      color: T.bg.surface,
      borderRadius: 6,
      fontSize: 11.5,
      fontWeight: 500,
      fontFamily: T.font.ui,
      letterSpacing: '-0.005em',
      zIndex: 100,
      pointerEvents: 'none',
      boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
      whiteSpace: 'nowrap',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span>{label}</span>
      {sub && (
        <span style={{
          fontSize: 10,
          color: T.text.faint,
          fontWeight: 400,
          letterSpacing: '0.02em',
        }}>
          {sub}
        </span>
      )}
      {counter != null && (
        <span style={{
          padding: '0 5px',
          height: 14,
          fontSize: 9.5,
          fontWeight: 600,
          color: T.text.primary,
          background: T.bg.surface,
          borderRadius: 3,
          display: 'inline-flex',
          alignItems: 'center',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {counter}
        </span>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   CURRENT WORKFLOW MINI-PROGRESS — kept logic, refined visuals.
   No more orange-fill background; just a hairline accent border + dots.
   ════════════════════════════════════════════════════════════════════════ */
const STEPS = ['upload', 'pruefen', 'focus', 'abschluss'];
const STEP_LABEL = {
  upload: 'Upload', pruefen: 'Prüfen', focus: 'Focus', abschluss: 'Abschluss',
};

function CurrentProgress({ current, collapsed, onClick }) {
  const totals = useMemo(() => {
    const pallets = current?.parsed?.pallets || [];
    const totalArticles = pallets.reduce((s, p) => s + p.items.length, 0);
    let doneArticles = 0;
    for (let i = 0; i < (current.currentPalletIdx ?? 0); i++) {
      doneArticles += pallets[i]?.items?.length || 0;
    }
    doneArticles += current.currentItemIdx ?? 0;
    return {
      totalArticles, doneArticles,
      palletCount: pallets.length,
      currentPallet: (current.currentPalletIdx ?? 0) + 1,
    };
  }, [current]);

  const stepIdx = STEPS.indexOf(current.step || 'pruefen');
  const fba = current.fbaCode || current.fileName;
  const progress = totals.totalArticles > 0
    ? Math.min(1, totals.doneArticles / totals.totalArticles)
    : 0;

  if (collapsed) {
    return (
      <button
        onClick={onClick}
        title={`Aktiv: ${fba}`}
        style={{
          margin: '0 auto 8px',
          width: 32, height: 32,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: T.bg.surface2,
          border: `1px solid ${T.accent.border}`,
          borderRadius: '50%',
          cursor: 'pointer',
          padding: 0,
          color: T.accent.main,
          position: 'relative',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18">
          {/* Progress ring */}
          <circle cx="9" cy="9" r="6.5" stroke={T.border.primary} strokeWidth="1.5" fill="none" />
          <circle
            cx="9" cy="9" r="6.5"
            stroke={T.accent.main}
            strokeWidth="1.5"
            fill="none"
            strokeDasharray={`${2 * Math.PI * 6.5}`}
            strokeDashoffset={`${2 * Math.PI * 6.5 * (1 - progress)}`}
            strokeLinecap="round"
            transform="rotate(-90 9 9)"
            style={{ transition: 'stroke-dashoffset 320ms cubic-bezier(0.16,1,0.3,1)' }}
          />
        </svg>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      title="Zum aktiven Auftrag"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        margin: '0 12px 8px',
        background: '#FFFFFF',
        border: '1px solid transparent',
        borderRadius: 14,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: T.font.ui,
        transition: 'transform 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 6, height: 6,
          borderRadius: '50%',
          background: T.accent.main,
          boxShadow: `0 0 0 0 ${T.accent.main}`,
        }} />
        <span style={{
          fontSize: 9.5,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontFamily: T.font.mono,
        }}>
          Aktiv
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10,
          color: T.text.faint,
          maxWidth: 100,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {fba}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{
        position: 'relative',
        height: 3,
        background: T.bg.surface3,
        borderRadius: 2,
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: `${progress * 100}%`,
          background: T.accent.main,
          borderRadius: 2,
          transition: 'width 320ms cubic-bezier(0.16, 1, 0.3, 1)',
        }} />
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 6,
      }}>
        <span style={{
          fontSize: 11.5,
          fontWeight: 500,
          color: T.text.primary,
          letterSpacing: '-0.005em',
        }}>
          {STEP_LABEL[current.step] || 'Prüfen'}
        </span>
        <span style={{
          fontSize: 10.5,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: T.font.mono,
        }}>
          {totals.doneArticles}/{totals.totalArticles} · P {totals.currentPallet}/{totals.palletCount}
        </span>
      </div>

      {/* Step dots */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {STEPS.map((s, i) => {
          const isActive = i === stepIdx;
          const isDone = i < stepIdx;
          return (
            <span key={s} style={{
              width: isActive ? 6 : 4,
              height: isActive ? 6 : 4,
              borderRadius: '50%',
              background: (isActive || isDone) ? T.accent.main : T.bg.surface3,
              transition: 'all 200ms',
            }} />
          );
        })}
      </div>
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FOOTER — UserSwitcher row + Today pulse + ⌘K iconlet.
   ════════════════════════════════════════════════════════════════════════ */
function SidebarFooter({ collapsed, history }) {
  return (
    <div>
      {!collapsed && <TodayPulse history={history} />}
      <BetaTumblerRow collapsed={collapsed} />
      <UserSwitcher collapsed={collapsed} />
    </div>
  );
}

/* Beta-design toggle as iOS-style tumbler. Replaces the BetaToggle that
   used to live in Focus topbar/menu — now available app-wide from the
   sidebar so the worker can flip designs without entering Focus.

   Visually matches NavItem grammar: rounded white pill when "on",
   transparent with subtle hover otherwise. Tumbler on the right
   mirrors the iOS switch — knob slides + accent fill when on. */
function BetaTumblerRow({ collapsed }: { collapsed: boolean }) {
  const { beta, toggleBeta } = useBetaDesign();
  const [hover, setHover] = useState(false);

  if (collapsed) {
    return (
      <div style={{ padding: '8px 0', display: 'flex', justifyContent: 'center' }}>
        <BetaTumbler on={beta} onToggle={toggleBeta} compact />
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 8px 8px' }}>
      <button
        type="button"
        onClick={toggleBeta}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-pressed={beta}
        title={beta
          ? 'Beta an — klicken zum Wechseln auf klassisch'
          : 'Beta aus — klicken zum Aktivieren'}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          boxSizing: 'border-box',
          padding: '9px 12px 9px 16px',
          background: beta
            ? (hover ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.55)')
            : (hover ? T.bg.surface2 : 'transparent'),
          borderRadius: 12,
          fontFamily: T.font.ui,
          transition: 'background 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <span style={{
          display: 'inline-flex',
          width: 18,
          height: 18,
          alignItems: 'center',
          justifyContent: 'center',
          color: beta ? T.text.primary : T.text.subtle,
          transition: 'color 140ms',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1.5l1.6 3.3 3.7.5-2.7 2.5.7 3.6L7 9.7 3.7 11.4l.7-3.6L1.7 5.3l3.7-.5z"
                  stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        </span>
        <span style={{
          flex: 1,
          fontSize: 13.5,
          fontWeight: beta ? 500 : 400,
          color: beta ? T.text.primary : T.text.secondary,
          letterSpacing: '-0.005em',
        }}>
          Beta
        </span>
        <BetaTumbler on={beta} onToggle={toggleBeta} />
      </button>
    </div>
  );
}

function BetaTumbler({ on, onToggle, compact = false }: { on: boolean; onToggle: () => void; compact?: boolean }) {
  const width = compact ? 30 : 34;
  const height = compact ? 18 : 20;
  const knob = height - 4;
  return (
    <span
      role="switch"
      aria-checked={on}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width,
        height,
        borderRadius: 999,
        background: on ? 'var(--accent)' : 'rgba(15, 23, 42, 0.16)',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: on ? width - knob - 2 : 2,
        width: knob,
        height: knob,
        borderRadius: '50%',
        background: '#FFFFFF',
        boxShadow: '0 1px 2.5px rgba(0, 0, 0, 0.20)',
        transition: 'left 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      }} />
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   TODAY PULSE — replaces the verbose "Heute X fertig · Yh Zm" line.
   Single-line: dot + count + sparkline of the last 7 calendar days.
   The sparkline is built from local history (cheap, accurate enough
   for an at-a-glance footer; admin/stats has the canonical chart).
   ════════════════════════════════════════════════════════════════════════ */
function TodayPulse({ history }) {
  const days = useMemo(() => buildDailyCounts(history, 7), [history]);
  const todayCount = days[days.length - 1]?.count ?? 0;
  const max = Math.max(1, ...days.map((d) => d.count));

  return (
    <div style={{
      padding: '10px 14px 8px',
      borderTop: `1px solid ${T.border.subtle}`,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontFamily: T.font.ui,
    }}>
      <span style={{
        width: 5, height: 5,
        borderRadius: '50%',
        background: todayCount > 0 ? T.accent.main : T.text.faint,
        flexShrink: 0,
      }} />
      <span style={{
        fontSize: 10,
        fontWeight: 500,
        color: T.text.faint,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        fontFamily: T.font.mono,
      }}>
        Heute
      </span>
      <span style={{
        fontSize: 12,
        fontWeight: 500,
        color: todayCount > 0 ? T.text.primary : T.text.faint,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {todayCount}
      </span>
      <span style={{ flex: 1 }} />
      <Sparkline7 days={days} max={max} />
    </div>
  );
}

function Sparkline7({ days, max }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14 }}>
      {days.map((d, i) => {
        const ratio = d.count / max;
        const isToday = i === days.length - 1;
        return (
          <span
            key={i}
            title={`${d.label}: ${d.count} ${d.count === 1 ? 'Auftrag' : 'Aufträge'}`}
            style={{
              display: 'inline-block',
              width: 3,
              height: Math.max(2, Math.round(ratio * 14)),
              background: isToday ? T.accent.main : (d.count > 0 ? T.text.subtle : T.border.primary),
              borderRadius: 1,
              transition: 'background 200ms',
            }}
          />
        );
      })}
    </span>
  );
}

/* ─── helpers ──────────────────────────────────────────────────────── */
function buildDailyCounts(history, n) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets: { key: number; label: string; count: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    buckets.push({
      key: d.getTime(),
      label: d.toLocaleDateString('de-DE', { weekday: 'short' }),
      count: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const h of history) {
    if (!h.finishedAt) continue;
    const d = new Date(h.finishedAt);
    d.setHours(0, 0, 0, 0);
    const b = byKey.get(d.getTime());
    if (b) b.count += 1;
  }
  return buckets;
}

/* ════════════════════════════════════════════════════════════════════════
   ICONS — uniform set: viewBox 16, stroke 1.3, no fill, currentColor.
   Each glyph is reduced to its essential shape — abstract more than
   literal.
   ════════════════════════════════════════════════════════════════════════ */

function IconWorkflow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 12V4M3 4l2 2M3 4l-2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M8 12V8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M13 12V6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function IconQueue() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="1"/>
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.7"/>
      <path d="M3 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.4"/>
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M10.5 10.5L13 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function IconHistory() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IconLive() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 8h2.5L6 4l3 8 1.5-4H14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IconReport() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4 2h6l2.5 2.5V14H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
      <path d="M9.5 2v3H12.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
      <path d="M6.5 11v-2M8 11V8M9.5 11v-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function IconLynneTable() {
  /* Photographic brand icon — escapes the stroke-only icon grammar on
     purpose so the LYNNE Table entry reads as a distinct app-level
     destination, not a sibling of Workflow/Suche/etc. */
  return (
    <img
      src="/brand/lynne-table.png"
      alt=""
      width={18}
      height={18}
      style={{ display: 'block', borderRadius: 4 }}
    />
  );
}

function IconAdmin() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 2L3 4v3.5C3 10.5 5.2 13 8 14c2.8-1 5-3.5 5-6.5V4L8 2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
      <path d="M5.8 8.2l1.6 1.6L10.4 6.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

