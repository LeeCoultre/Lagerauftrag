/* Einstellungen v2 — «Studio».

   Magazine-spread design (matches Upload / Pruefen / Focus / Live /
   Historie / Warteschlange):
     • Eyebrow `Studio · Marathon v2.x` + clamp(36–52) H1 + Lead
     • Identity-Hero — 56px avatar, name, email, role, today's shift,
       quick UserButton menu (Clerk-backed)
     • Settings-Search (`/`) — fuzzy filter, hides non-matching cards
     • Theme-Studio — 6 curated presets with mini-card previews,
       custom hex picker, live-preview pane (mock UI repaints in real
       time as you hover/click)
     • Experimente — opt-in feature flags
     • Verbindung & Diagnose — backend URL + status + latency, JWT
       valid, cache-clear button
     • Tastenkürzel — full keyboard cheatsheet across screens
     • Daten & Speicher — counts + Backup-/Restore-JSON
     • Werte & Geometrie — read-only reference values
     • Build & System — version, mode, design system, link to admin

   Backend unchanged. Reuses /api/me, /api/activity/shift, /api/health.
*/

import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { UserButton, useUser } from '@clerk/clerk-react';
import { useAppState } from '@/state.jsx';
import { useConfirm } from '@/components/ConfirmDialog';
import { useMe } from '@/hooks/useMe.js';
import { useMyShift } from '@/hooks/useMyShift.js';
import { useApiHealth } from '@/hooks/useApiHealth.js';
import {
  applyAccent, getStoredAccent, setStoredAccent, resetAccent, DEFAULT_ACCENT,
} from '@/utils/accent.js';
import { THEME_PRESETS, findPreset } from '@/utils/themePresets.js';
import {
  applyTheme as applyThemeMode,
  getStoredTheme,
  setStoredTheme,
  type ThemeMode,
} from '@/utils/theme';
import {
  EXPERIMENT_META, EXPERIMENT_DEFAULTS, useExperiment,
} from '@/utils/experiments.js';
import {
  Page, Topbar, Card, Eyebrow, Lead, Button, Badge, T,
} from '@/components/ui.jsx';

const BUILD_VERSION = '2.x';
const BUILD_MODE = (typeof import.meta !== 'undefined' && import.meta.env?.PROD)
  ? 'production' : 'development';
const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL)
  || 'same-origin';

/* Section catalog drives the search index. Each entry's `keywords`
   field gets matched against the user's query — keep them lowercase
   and German-only so the matcher stays simple. */
const SECTIONS = [
  { id: 'identity',   label: 'Identität',          keywords: 'identität rolle name email user clerk session profil avatar' },
  { id: 'appearance', label: 'Erscheinungsbild',   keywords: 'erscheinungsbild appearance dark mode hell dunkel light theme nacht tag schwarz weiss' },
  { id: 'theme',      label: 'Theme-Studio',       keywords: 'theme akzent farbe palette branding marathon orange indigo forest preset preview vorschau hex' },
  { id: 'experiments',label: 'Experimente',        keywords: 'experimente experiment feature flag dynamic island opt-in' },
  { id: 'diagnostic', label: 'Verbindung',         keywords: 'verbindung diagnose backend api health latency status connection cache' },
  { id: 'shortcuts',  label: 'Tastenkürzel',       keywords: 'tastenkürzel shortcut keyboard kbd hotkey' },
  { id: 'data',       label: 'Daten & Speicher',   keywords: 'daten speicher localstorage backup export import restore queue historie' },
  { id: 'values',     label: 'Werte & Geometrie',  keywords: 'werte geometrie palette euro zeit schätzung dauer minuten artikel' },
  { id: 'build',      label: 'Build & System',     keywords: 'build version system designsystem schriften inter mono postgres fastapi admin' },
];

/* ════════════════════════════════════════════════════════════════════════ */
export default function EinstellungenScreen({ onRoute }: { onRoute?: (route: string) => void }) {
  const { queue, history, clearQueue, clearHistory } = useAppState();
  const confirm = useConfirm();
  const meQ = useMe();
  const me = meQ.data;
  const { user: clerkUser } = useUser();
  const shiftQ = useMyShift();
  const healthQ = useApiHealth();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [accent, setAccent] = useState(getStoredAccent);
  const [previewAccent, setPreviewAccent] = useState<string | null>(null);
  const [storageBytes, setStorageBytes] = useState(() => measureStorage());
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);

  const searchRef = useRef<HTMLInputElement | null>(null);

  /* When the user hovers a preset, repaint live without committing.
     Click commits via apply(). On unmount restore the last committed
     accent so a hover-with-no-click leaves no trace. */
  useEffect(() => {
    if (previewAccent) applyAccent(previewAccent);
    else applyAccent(accent);
  }, [previewAccent, accent]);

  /* Recompute storage usage when localStorage changes elsewhere. */
  useEffect(() => {
    const tick = () => setStorageBytes(measureStorage());
    window.addEventListener('storage', tick);
    return () => window.removeEventListener('storage', tick);
  }, []);

  /* `/` to focus search · `Esc` to clear */
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        searchRef.current?.blur();
        if (search) setSearch('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [search]);

  const visibleSections = useMemo(() => filterSections(SECTIONS, search), [search]);
  const isVisible = (id) => visibleSections.some((s) => s.id === id);

  const applyTheme = (hex) => {
    setAccent(hex);
    setStoredAccent(hex);
    setPreviewAccent(null);
    applyAccent(hex);
  };

  const setMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    setStoredTheme(mode);
    applyThemeMode(mode);
  };
  const onResetTheme = () => {
    const next = resetAccent();
    setAccent(next);
    setPreviewAccent(null);
  };
  const onClearCache = () => {
    qc.invalidateQueries();
  };

  return (
    <Page>
      <Topbar
        crumbs={[{ label: 'Einstellungen' }]}
        right={
          <span style={{
            fontSize: 12.5,
            color: T.text.subtle,
            fontFamily: T.font.mono,
            letterSpacing: '0.02em',
          }}>
            Studio · v{BUILD_VERSION}
          </span>
        }
      />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '72px 40px 96px' }}>
        {/* HEADER */}
        <header style={{ marginBottom: 40 }}>
          <Eyebrow>Studio · Marathon v{BUILD_VERSION}</Eyebrow>
          <h1 style={{
            fontFamily: T.font.ui,
            fontSize: 'clamp(36px, 2.8vw, 52px)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
            color: T.text.primary,
            margin: 0,
          }}>
            Einstellungen
          </h1>
          <Lead style={{ marginTop: 16, maxWidth: 720, fontSize: 16 }}>
            Personalisiere deine Marathon-Oberfläche — Theme, Experimente,
            Tastenkürzel. Diagnose, Daten und Versionsinfo auf einen
            Blick. Tippe <Kbd inline>/</Kbd> zum Suchen.
          </Lead>
        </header>

        {/* IDENTITY HERO */}
        {isVisible('identity') && (
          <IdentityHero
            me={me}
            clerkUser={clerkUser}
            shiftQ={shiftQ}
          />
        )}

        {/* SETTINGS SEARCH */}
        <SearchBar
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
          visibleCount={visibleSections.length}
          totalCount={SECTIONS.length}
        />

        {/* APPEARANCE — Light / Dark mode */}
        {isVisible('appearance') && (
          <SettingsCard
            id="appearance"
            title="Erscheinungsbild"
            subtitle="Hell oder Dunkel. Wechselt sofort und merkt sich die Wahl im Browser dieses Geräts."
          >
            <AppearanceToggle mode={themeMode} onChange={setMode} />
          </SettingsCard>
        )}

        {/* THEME STUDIO */}
        {isVisible('theme') && (
          <SettingsCard
            id="theme"
            title="Theme-Studio"
            subtitle="Akzentfarbe für Buttons, Badges und Live-Indikatoren. Hover über einen Preset für Live-Preview, Klick zum Anwenden."
          >
            <ThemeStudio
              accent={accent}
              previewAccent={previewAccent}
              onApply={applyTheme}
              onPreview={setPreviewAccent}
              onReset={onResetTheme}
            />
          </SettingsCard>
        )}

        {/* EXPERIMENTS */}
        {isVisible('experiments') && (
          <SettingsCard
            id="experiments"
            title="Experimente"
            subtitle="Funktionen in Erprobung. Standardmäßig deaktiviert — schalte sie selbst frei. Deaktivieren ist jederzeit möglich, kein Datenverlust."
          >
            {Object.keys(EXPERIMENT_DEFAULTS).map((flag, i, arr) => (
              <ExperimentRow key={flag} flag={flag} isLast={i === arr.length - 1} />
            ))}
          </SettingsCard>
        )}

        {/* CONNECTION & DIAGNOSTICS */}
        {isVisible('diagnostic') && (
          <SettingsCard
            id="diagnostic"
            title="Verbindung & Diagnose"
            subtitle="Live-Status der API-Verbindung und der Authentifizierung."
          >
            <DiagnosticGrid
              healthQ={healthQ}
              clerkUser={clerkUser}
              onClearCache={onClearCache}
            />
          </SettingsCard>
        )}

        {/* KEYBOARD SHORTCUTS */}
        {isVisible('shortcuts') && (
          <SettingsCard
            id="shortcuts"
            title="Tastenkürzel"
            subtitle="Alle verfügbaren Hotkeys auf einen Blick."
          >
            <ShortcutsCheatsheet />
          </SettingsCard>
        )}

        {/* DATA & STORAGE */}
        {isVisible('data') && (
          <SettingsCard
            id="data"
            title="Daten & Speicher"
            subtitle="Aufträge und Historie liegen in PostgreSQL. UI-Voreinstellungen (Theme, Experimente) liegen lokal im Browser — exportierbar als JSON."
          >
            <DataRow
              label="Aufträge in Warteschlange"
              value={queue.length}
              action={queue.length > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    const ok = await confirm({
                      message: 'Warteschlange wirklich leeren?',
                      detail: `${queue.length} Auftr${queue.length === 1 ? 'ag wird' : 'äge werden'} entfernt. Diese Aktion lässt sich nicht rückgängig machen.`,
                      confirmLabel: 'Leeren',
                      danger: true,
                    });
                    if (ok) clearQueue();
                  }}
                >
                  Leeren
                </Button>
              )}
            />
            <DataRow
              label="Abgeschlossene Aufträge"
              value={history.length}
              action={history.length > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    const ok = await confirm({
                      message: 'Historie wirklich löschen?',
                      detail: `${history.length} abgeschlossene Auftr${history.length === 1 ? 'ag wird' : 'äge werden'} dauerhaft gelöscht.`,
                      confirmLabel: 'Löschen',
                      danger: true,
                    });
                    if (ok) clearHistory();
                  }}
                >
                  Löschen
                </Button>
              )}
            />
            <DataRow
              label="Lokale Voreinstellungen"
              value={`${(storageBytes / 1024).toFixed(1)} KB`}
            />
            <BackupRow
              onExport={() => exportLocalSettings()}
              onImport={(file: File) => { importLocalSettings(file).then(() => {
                /* Re-read accent from localStorage after import. */
                const next = getStoredAccent();
                setAccent(next);
                applyAccent(next);
                setStorageBytes(measureStorage());
                alert('Einstellungen importiert.');
              }).catch((err: Error) => alert('Import fehlgeschlagen: ' + (err?.message || 'unbekannter Fehler'))); }}
              isLast
            />
          </SettingsCard>
        )}

        {/* VALUES & GEOMETRY */}
        {isVisible('values') && (
          <SettingsCard
            id="values"
            title="Werte & Geometrie"
            subtitle="Read-only Referenzwerte für Auslastungs- und Zeitberechnung."
          >
            <ValuesGrid />
          </SettingsCard>
        )}

        {/* BUILD & SYSTEM */}
        {isVisible('build') && (
          <SettingsCard
            id="build"
            title="Build & System"
            subtitle="Versionsinformationen und Plattform-Details."
            isLast
          >
            <DataRow label="Version"        value={`Marathon v${BUILD_VERSION}`} mono />
            <DataRow label="Modus"          value={BUILD_MODE} mono />
            <DataRow label="API-Endpoint"   value={API_BASE} mono />
            <DataRow label="Storage-Engine" value="PostgreSQL · FastAPI" />
            <DataRow label="Schriften"      value="Inter · JetBrains Mono" />
            <DataRow
              label="Design-System"
              value="Marathon · v3"
              mono
              action={me?.role === 'admin' && (
                <Button variant="ghost" size="sm" onClick={() => onRoute && onRoute('admin')}>
                  Admin-Panel
                </Button>
              )}
              isLast
            />
          </SettingsCard>
        )}

        {visibleSections.length === 0 && (
          <Card style={{ padding: '40px 32px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: T.text.subtle, marginBottom: 16 }}>
              Keine Einstellung passt zu „{search}".
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSearch('')}>
              Suche zurücksetzen
            </Button>
          </Card>
        )}
      </main>

      <style>{`
        @keyframes mp-set-glow {
          0%, 100% { box-shadow: 0 1px 3px rgba(17,24,39,0.04), 0 12px 32px -16px rgba(99,102,241,0.18); }
          50%      { box-shadow: 0 1px 3px rgba(17,24,39,0.04), 0 16px 40px -14px rgba(99,102,241,0.30); }
        }
      `}</style>
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Section search: substring + token AND across keywords
   ════════════════════════════════════════════════════════════════════════ */
function filterSections(sections, q) {
  const query = q.trim().toLowerCase();
  if (!query) return sections;
  const tokens = query.split(/\s+/).filter(Boolean);
  return sections.filter((s) => {
    const hay = (s.label + ' ' + s.keywords).toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

/* ════════════════════════════════════════════════════════════════════════
   Identity hero
   ════════════════════════════════════════════════════════════════════════ */
interface MeShape { id?: string; name?: string; email?: string; role?: string }
interface ShiftQ { data?: { durationSec?: number; completedToday?: number } }
interface ClerkUserShape { createdAt?: number | string | Date | null }

function IdentityHero({ me, clerkUser, shiftQ }: { me: MeShape | null | undefined; clerkUser: ClerkUserShape | null | undefined; shiftQ: ShiftQ }) {
  const initial = (me?.name || me?.email || '·').trim().charAt(0).toUpperCase();
  const isAdmin = me?.role === 'admin';
  const joinedAt = clerkUser?.createdAt;
  const joinedLabel = joinedAt
    ? new Date(joinedAt).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
    : null;

  const shiftSec = shiftQ.data?.durationSec || 0;
  const completedToday = shiftQ.data?.completedToday || 0;
  const shiftLabel = shiftSec > 0 ? fmtHm(shiftSec) : null;

  return (
    <div style={{
      marginBottom: 28,
      padding: '24px 28px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      display: 'grid',
      gridTemplateColumns: 'auto 1fr auto',
      alignItems: 'center',
      gap: 24,
    }}>
      {/* Avatar */}
      <span style={{
        width: 56, height: 56,
        borderRadius: '50%',
        background: isAdmin ? T.accent.main : T.text.primary,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 22,
        fontWeight: 600,
        fontFamily: T.font.ui,
        letterSpacing: '-0.01em',
      }}>
        {initial}
      </span>

      {/* Name / email / meta */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 4,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: T.font.ui,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.015em',
            color: T.text.primary,
          }}>
            {me?.name || 'Anonymous'}
          </span>
          <Badge tone={isAdmin ? 'accent' : 'neutral'}>
            {isAdmin ? 'Admin' : 'Operator'}
          </Badge>
        </div>
        <div style={{
          fontSize: 13,
          color: T.text.subtle,
          fontFamily: T.font.mono,
          marginBottom: 8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {me?.email || '—'}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontSize: 12,
          color: T.text.faint,
          flexWrap: 'wrap',
          fontFamily: T.font.mono,
        }}>
          {joinedLabel && (
            <span>Mitglied seit {joinedLabel}</span>
          )}
          {shiftLabel && (
            <>
              <span style={{ color: T.border.strong }}>·</span>
              <span>Heute: {shiftLabel} aktiv</span>
            </>
          )}
          {completedToday > 0 && (
            <>
              <span style={{ color: T.border.strong }}>·</span>
              <span style={{ color: T.status.success.text, fontWeight: 600 }}>
                {completedToday} {completedToday === 1 ? 'Auftrag' : 'Aufträge'} fertig
              </span>
            </>
          )}
        </div>
      </div>

      {/* Clerk's UserButton — manage profile + sign out. We render it
         small but let it own its own dropdown menu. */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <UserButton
          afterSignOutUrl="/"
          appearance={{
            elements: {
              userButtonAvatarBox: { width: 36, height: 36 },
            },
          }}
        />
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Search bar
   ════════════════════════════════════════════════════════════════════════ */
function SearchBar({ search, onSearch, searchRef, visibleCount, totalCount }: { search: string; onSearch: (v: string) => void; searchRef: React.RefObject<HTMLInputElement | null>; visibleCount: number; totalCount: number }) {
  return (
    <div style={{
      position: 'sticky',
      top: 60,
      zIndex: 5,
      marginBottom: 24,
      padding: '12px 16px',
      background: 'var(--bg-glass-medium)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.full,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: T.text.faint, flexShrink: 0 }}>
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
        <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        ref={searchRef}
        type="text"
        placeholder="Suchen — Akzent, Experiment, Build, Backup… ( / )"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        style={{
          flex: 1,
          height: 24,
          padding: 0,
          fontSize: 14,
          fontFamily: T.font.ui,
          color: T.text.primary,
          background: 'transparent',
          border: 'none',
          outline: 'none',
        }}
      />
      <span style={{
        fontSize: 11.5,
        fontFamily: T.font.mono,
        color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}>
        {visibleCount}/{totalCount}
      </span>
      {search && (
        <button
          type="button"
          onClick={() => onSearch('')}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: T.text.faint,
            display: 'inline-flex',
            alignItems: 'center',
          }}
          title="Suche leeren (Esc)"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Settings card wrapper
   ════════════════════════════════════════════════════════════════════════ */
function SettingsCard({ id, title, subtitle, children, isLast }: { id?: string; title: ReactNode; subtitle?: ReactNode; children?: ReactNode; isLast?: boolean }) {
  return (
    <section id={id} style={{ marginBottom: isLast ? 0 : 20 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontSize: 10.5,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.10em',
          marginBottom: 4,
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 13,
            color: T.text.subtle,
            lineHeight: 1.5,
            maxWidth: 720,
          }}>
            {subtitle}
          </div>
        )}
      </div>
      <Card style={{ padding: '4px 22px' }}>
        {children}
      </Card>
    </section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Theme studio — preset gallery + custom picker + live preview pane
   ════════════════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════════════
   Appearance — light / dark segmented control
   ════════════════════════════════════════════════════════════════════════ */
function AppearanceToggle({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '4px 0' }}>
      <div style={{
        display: 'inline-flex',
        padding: 4,
        background: T.bg.surface3,
        border: `1px solid ${T.border.primary}`,
        borderRadius: T.radius.md,
        gap: 2,
      }}>
        <ModeChip
          active={mode === 'light'}
          onClick={() => onChange('light')}
          icon={<SunIcon />}
          label="Hell"
        />
        <ModeChip
          active={mode === 'dark'}
          onClick={() => onChange('dark')}
          icon={<MoonIcon />}
          label="Dunkel"
        />
      </div>
      <span style={{ fontSize: 12.5, color: T.text.subtle, lineHeight: 1.55 }}>
        {mode === 'dark'
          ? 'Dunkles Theme aktiv. Wechselt sofort, ohne neuladen.'
          : 'Helles Theme (Standard).'}
      </span>
    </div>
  );
}

function ModeChip({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        background: active ? T.bg.surface : 'transparent',
        color: active ? T.text.primary : T.text.subtle,
        border: 0,
        borderRadius: T.radius.sm,
        boxShadow: active ? T.shadow.card : 'none',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        transition: 'background 160ms ease, color 160ms ease',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

interface ThemeStudioProps {
  accent: string;
  previewAccent: string | null;
  onApply: (hex: string) => void;
  onPreview: (hex: string | null) => void;
  onReset: () => void;
}

function ThemeStudio({ accent, previewAccent, onApply, onPreview, onReset }: ThemeStudioProps) {
  const [hex, setHex] = useState(accent);

  /* Keep input in sync if accent changes from outside (preset click). */
  useEffect(() => { setHex(accent); }, [accent]);

  const onHexChange = (raw: string) => {
    const next = raw.startsWith('#') ? raw : `#${raw}`;
    setHex(next.toUpperCase());
    if (/^#[0-9a-fA-F]{6}$/.test(next)) onApply(next.toUpperCase());
  };

  const activePreset = findPreset(accent);

  return (
    <div style={{
      padding: '14px 0 18px',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
      gap: 28,
    }}>
      {/* Left: presets + picker */}
      <div>
        <div style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 10,
        }}>
          Presets
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
          marginBottom: 20,
        }}>
          {THEME_PRESETS.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              active={activePreset?.id === p.id}
              onApply={() => onApply(p.hex)}
              onHover={() => onPreview(p.hex)}
              onLeave={() => onPreview(null)}
            />
          ))}
        </div>

        <div style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 10,
        }}>
          Custom
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input
            type="color"
            value={hex}
            onChange={(e) => onHexChange(e.target.value.toUpperCase())}
            style={{
              width: 40, height: 40,
              padding: 0,
              border: `1px solid ${T.border.strong}`,
              borderRadius: T.radius.md,
              cursor: 'pointer',
              background: 'transparent',
            }}
            title="Farbe wählen"
          />
          <input
            type="text"
            value={hex}
            onChange={(e) => onHexChange(e.target.value)}
            spellCheck={false}
            style={{
              width: 120,
              padding: '8px 12px',
              border: `1px solid ${T.border.strong}`,
              borderRadius: T.radius.md,
              fontFamily: T.font.mono,
              fontSize: 13,
              color: T.text.primary,
              background: T.bg.surface,
              outline: 'none',
              textTransform: 'uppercase',
            }}
          />
          {hex.toUpperCase() !== DEFAULT_ACCENT.toUpperCase() && (
            <Button variant="ghost" size="sm" onClick={onReset}>
              Zurücksetzen
            </Button>
          )}
        </div>
      </div>

      {/* Right: live preview pane */}
      <ThemePreviewPane
        accentLabel={(previewAccent ? findPreset(previewAccent)?.label : activePreset?.label) ?? ''}
        isPreviewing={!!previewAccent}
      />
    </div>
  );
}

interface ThemePreset { id: string; label: string; hex: string; emoji?: string }

function PresetCard({ preset, active, onApply, onHover, onLeave }: { preset: ThemePreset; active: boolean; onApply: (hex: string) => void; onHover: (hex: string) => void; onLeave: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onApply(preset.hex)}
      onMouseEnter={() => { setHover(true); onHover(preset.hex); }}
      onMouseLeave={() => { setHover(false); onLeave(); }}
      style={{
        position: 'relative',
        padding: '12px 14px',
        background: T.bg.surface,
        border: `1px solid ${active ? T.text.primary : (hover ? T.border.strong : T.border.primary)}`,
        borderRadius: T.radius.md,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 160ms',
        boxShadow: active ? '0 0 0 2px ' + T.bg.page + ', 0 0 0 3px ' + preset.hex : 'none',
      }}
    >
      {/* Color blob */}
      <div style={{
        width: '100%',
        height: 40,
        borderRadius: T.radius.sm,
        marginBottom: 10,
        background: `linear-gradient(135deg, ${preset.hex} 0%, ${preset.hex}cc 100%)`,
        position: 'relative',
        overflow: 'hidden',
      }}>
        <span style={{
          position: 'absolute',
          right: 8, bottom: 6,
          fontSize: 16,
          opacity: 0.85,
        }}>
          {preset.emoji}
        </span>
      </div>
      <div style={{
        fontSize: 12.5,
        fontWeight: 500,
        color: T.text.primary,
        letterSpacing: '-0.005em',
      }}>
        {preset.label}
      </div>
      <div style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        color: T.text.faint,
        marginTop: 2,
      }}>
        {preset.hex}
      </div>
      {active && (
        <span style={{
          position: 'absolute',
          top: 8, right: 8,
          width: 16, height: 16,
          borderRadius: '50%',
          background: preset.hex,
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </button>
  );
}

function ThemePreviewPane({ accentLabel, isPreviewing }: { accentLabel: string; isPreviewing: boolean }) {
  /* Mini-mock UI built entirely from var(--accent) so it repaints
     instantly when applyAccent() runs. Mirrors the real Marathon UI
     vocabulary so users see exactly how their accent will land. */
  return (
    <div style={{
      padding: '16px',
      background: T.bg.surface2,
      border: `1px dashed ${T.border.strong}`,
      borderRadius: T.radius.lg,
      position: 'relative',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}>
          Live-Preview {isPreviewing && <span style={{ color: T.accent.text }}>· hover</span>}
        </div>
        {accentLabel && (
          <span style={{
            fontSize: 11,
            color: T.text.faint,
            fontFamily: T.font.ui,
          }}>
            {accentLabel}
          </span>
        )}
      </div>

      <div style={{
        padding: '14px',
        background: T.bg.surface,
        border: `1px solid ${T.border.primary}`,
        borderRadius: T.radius.md,
      }}>
        {/* Eyebrow */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.10em',
          marginBottom: 4,
        }}>
          <span style={{
            width: 5, height: 5,
            borderRadius: '50%',
            background: 'var(--accent)',
          }} />
          Workflow · Focus
        </div>
        {/* Title */}
        <div style={{
          fontFamily: T.font.ui,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: T.text.primary,
          marginBottom: 10,
        }}>
          Beispiel-Auftrag
        </div>
        {/* Pills */}
        <div style={{ display: 'inline-flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          <Badge tone="accent">Nächster</Badge>
          <Badge tone="success">Validiert</Badge>
          <Badge tone="neutral">12 Mixed</Badge>
        </div>
        {/* Progress bar */}
        <div style={{
          height: 4,
          background: T.bg.surface3,
          borderRadius: 2,
          overflow: 'hidden',
          marginBottom: 12,
        }}>
          <div style={{
            width: '64%',
            height: '100%',
            background: 'var(--accent)',
            transition: 'background 200ms',
          }} />
        </div>
        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{
            padding: '6px 12px',
            background: 'var(--accent)',
            color: '#fff',
            border: '1px solid var(--accent)',
            borderRadius: T.radius.sm,
            fontSize: 12,
            fontWeight: 500,
            cursor: 'default',
            fontFamily: T.font.ui,
          }}>
            Starten
          </button>
          <button style={{
            padding: '6px 12px',
            background: 'var(--accent-bg)',
            color: 'var(--accent-text)',
            border: '1px solid var(--accent-border)',
            borderRadius: T.radius.sm,
            fontSize: 12,
            fontWeight: 500,
            cursor: 'default',
            fontFamily: T.font.ui,
          }}>
            Vorschau
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Experiments
   ════════════════════════════════════════════════════════════════════════ */
function ExperimentRow({ flag, isLast }: { flag: string; isLast?: boolean }) {
  const [enabled, setEnabled] = useExperiment(flag);
  const meta = EXPERIMENT_META[flag] || { label: flag, description: '' };
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      padding: '16px 0',
      borderBottom: !isLast ? `1px solid ${T.border.subtle}` : 'none',
      gap: 16,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: T.text.primary }}>
            {meta.label}
          </span>
          {enabled
            ? <Badge tone="success">Aktiv</Badge>
            : <Badge tone="neutral">{meta.badge || 'Pausiert'}</Badge>}
        </div>
        {meta.description && (
          <p style={{
            margin: 0,
            fontSize: 12.5,
            color: T.text.subtle,
            lineHeight: 1.55,
            maxWidth: 640,
          }}>
            {meta.description}
          </p>
        )}
      </div>
      <Toggle checked={enabled} onChange={setEnabled} ariaLabel={meta.label} />
    </div>
  );
}

function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (next: boolean) => void; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      style={{
        flexShrink: 0,
        width: 40,
        height: 24,
        borderRadius: 999,
        background: checked ? `var(--accent, ${T.accent.main})` : T.bg.surface3,
        border: `1px solid ${checked ? `var(--accent, ${T.accent.main})` : T.border.primary}`,
        cursor: 'pointer',
        padding: 0,
        position: 'relative',
        transition: 'background 200ms, border-color 200ms',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 3px rgba(15, 23, 42, 0.18)',
        transition: 'left 200ms cubic-bezier(0.34, 1.56, 0.64, 1)',
      }} />
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Diagnostics
   ════════════════════════════════════════════════════════════════════════ */
interface HealthQ {
  data?: { status?: string; elapsedMs?: number | null };
  isError?: boolean;
  dataUpdatedAt?: number;
}

function DiagnosticGrid({ healthQ, clerkUser, onClearCache }: { healthQ: HealthQ; clerkUser: { lastSignInAt?: number | string | Date | null } | null | undefined; onClearCache: () => void }) {
  const status: string = healthQ.data?.status || (healthQ.isError ? 'offline' : 'unknown');
  const elapsed = healthQ.data?.elapsedMs;

  const statusMetaMap: Record<string, { label: string; tone: { text: string }; dot: string }> = {
    ok:        { label: 'Online',    tone: T.status.success, dot: T.status.success.main },
    degraded:  { label: 'Degraded',  tone: T.status.warn,    dot: T.status.warn.main },
    offline:   { label: 'Offline',   tone: T.status.danger,  dot: T.status.danger.main },
    unknown:   { label: 'Unbekannt', tone: { text: T.text.faint }, dot: T.text.faint },
  };
  const statusMeta = statusMetaMap[status] || statusMetaMap.unknown;

  const lastFetched = healthQ.dataUpdatedAt
    ? new Date(healthQ.dataUpdatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  return (
    <div>
      <DataRow
        label="Backend"
        value={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 7, height: 7,
              borderRadius: '50%',
              background: statusMeta.dot,
            }} />
            <span style={{ color: statusMeta.tone.text, fontWeight: 500 }}>
              {statusMeta.label}
            </span>
            {elapsed != null && (
              <span style={{ color: T.text.faint, fontFamily: T.font.mono }}>
                {elapsed} ms
              </span>
            )}
          </span>
        }
      />
      <DataRow label="API-URL"          value={API_BASE} mono />
      <DataRow label="Letzte Prüfung"   value={lastFetched} mono />
      <DataRow
        label="Authentifizierung"
        value={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 7, height: 7,
              borderRadius: '50%',
              background: clerkUser ? T.status.success.main : T.text.faint,
            }} />
            <span style={{ color: clerkUser ? T.status.success.text : T.text.faint, fontWeight: 500 }}>
              {clerkUser ? 'Clerk-Session aktiv' : 'Anonym'}
            </span>
          </span>
        }
      />
      <DataRow
        label="Query-Cache"
        value="Aufträge · Historie · Live · SKU-Dimensionen"
        action={
          <Button variant="ghost" size="sm" onClick={onClearCache}>
            Cache leeren
          </Button>
        }
        isLast
      />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Keyboard cheatsheet
   ════════════════════════════════════════════════════════════════════════ */
const SHORTCUT_GROUPS = [
  {
    label: 'Global',
    items: [
      { keys: ['⌘ K'],     desc: 'Command Palette öffnen' },
      { keys: ['⌘ V'],     desc: 'Datei aus Zwischenablage einfügen (Upload)' },
      { keys: ['/'],        desc: 'Suche fokussieren (Listen-Screens)' },
      { keys: ['Esc'],      desc: 'Suche leeren oder Modal schließen' },
    ],
  },
  {
    label: 'Listen — Warteschlange · Historie · Live',
    items: [
      { keys: ['j', 'k'],   desc: 'Eintrag nach unten / oben' },
      { keys: ['↑', '↓'],   desc: 'Eintrag nach unten / oben (Alternative)' },
      { keys: ['⏎'],         desc: 'Eintrag öffnen / Auftrag starten' },
      { keys: ['x'],         desc: 'Eintrag entfernen' },
      { keys: ['e'],         desc: 'xlsx-Export (Historie)' },
      { keys: ['⌘ ↑', '⌘ ↓'], desc: 'Eintrag in der Warteschlange verschieben' },
    ],
  },
  {
    label: 'Focus-Modus',
    items: [
      { keys: ['Space', '⏎'], desc: 'Artikel abschließen' },
      { keys: ['←', '→'],     desc: 'Voriger / nächster Artikel' },
      { keys: ['↑', '↓'],     desc: 'Vorige / nächste Palette (alle Codes kopiert)' },
      { keys: ['C'],           desc: 'Artikel-Code kopieren' },
      { keys: ['U'],           desc: 'Use-Item kopieren' },
    ],
  },
];

function ShortcutsCheatsheet() {
  return (
    <div style={{ padding: '12px 0' }}>
      {SHORTCUT_GROUPS.map((group, gi) => (
        <div
          key={group.label}
          style={{
            marginBottom: gi === SHORTCUT_GROUPS.length - 1 ? 0 : 22,
          }}
        >
          <div style={{
            fontSize: 11,
            fontFamily: T.font.mono,
            fontWeight: 600,
            color: T.text.subtle,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 10,
          }}>
            {group.label}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '8px 24px',
          }}>
            {group.items.map((item, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 13,
                color: T.text.secondary,
              }}>
                <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
                  {item.keys.map((k, ki) => (
                    <span key={ki} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Kbd>{k}</Kbd>
                      {ki < item.keys.length - 1 && (
                        <span style={{ color: T.text.faint, fontSize: 10.5 }}>·</span>
                      )}
                    </span>
                  ))}
                </span>
                <span style={{ flex: 1, color: T.text.muted }}>
                  {item.desc}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Values & geometry
   ════════════════════════════════════════════════════════════════════════ */
function ValuesGrid() {
  return (
    <div style={{ padding: '14px 0 18px' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 28,
      }}>
        <div>
          <div style={{
            fontSize: 11,
            fontFamily: T.font.mono,
            fontWeight: 600,
            color: T.text.subtle,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 10,
          }}>
            Zeitschätzungen
          </div>
          <ValueLine label="Pro Palette · Basis"     value="6 min" />
          <ValueLine label="Pro Artikel"             value="11 s" />
          <ValueLine label="Pro Tacho-Artikel"       value="21 s" />
          <ValueLine label="Pause zwischen Paletten" value="9 min" isLast />
        </div>
        <div>
          <div style={{
            fontSize: 11,
            fontFamily: T.font.mono,
            fontWeight: 600,
            color: T.text.subtle,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 10,
          }}>
            Euro-Palette
          </div>
          <ValueLine label="Bodenfläche"     value="1.200 × 800 mm" />
          <ValueLine label="Maximalhöhe"     value="1.650 mm" />
          <ValueLine label="Maximalvolumen"  value="1,584 m³" />
          <ValueLine label="Soft-Limit Gewicht" value="700 kg" isLast />
        </div>
      </div>
    </div>
  );
}

function ValueLine({ label, value, isLast }: { label: ReactNode; value: ReactNode; isLast?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 16,
      padding: '6px 0',
      borderBottom: !isLast ? `1px solid ${T.border.subtle}` : 'none',
    }}>
      <span style={{ fontSize: 13, color: T.text.secondary }}>{label}</span>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 13,
        color: T.text.primary,
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Data row + backup
   ════════════════════════════════════════════════════════════════════════ */
function DataRow({ label, value, mono, action, isLast }: { label: ReactNode; value: ReactNode; mono?: boolean; action?: ReactNode; isLast?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '14px 0',
      borderBottom: !isLast ? `1px solid ${T.border.subtle}` : 'none',
      gap: 16,
    }}>
      <span style={{ fontSize: 13.5, color: T.text.secondary }}>
        {label}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{
        fontFamily: mono ? T.font.mono : 'inherit',
        fontSize: 13.5,
        fontWeight: 500,
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
      {action}
    </div>
  );
}

function BackupRow({ onExport, onImport, isLast }: { onExport: () => void; onImport: (file: File) => void; isLast?: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '14px 0',
      borderBottom: !isLast ? `1px solid ${T.border.subtle}` : 'none',
      gap: 12,
      flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 13.5, color: T.text.secondary }}>
        Backup
      </span>
      <span style={{ fontSize: 12, color: T.text.faint }}>
        Theme · Experimente · Akzentfarbe als JSON
      </span>
      <span style={{ flex: 1 }} />
      <Button variant="ghost" size="sm" onClick={onExport}>
        📤 Exportieren
      </Button>
      <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
        📥 Importieren
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Local storage helpers
   ════════════════════════════════════════════════════════════════════════ */
function measureStorage() {
  if (typeof window === 'undefined') return 0;
  let bytes = 0;
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k || !k.startsWith('marathon.')) continue;
    const v = window.localStorage.getItem(k) || '';
    bytes += k.length + v.length;
  }
  return bytes * 2; /* UTF-16 */
}

function exportLocalSettings() {
  const out = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k || !k.startsWith('marathon.')) continue;
    out[k] = window.localStorage.getItem(k);
  }
  const blob = new Blob([JSON.stringify({
    schema:  'marathon-settings-v1',
    exportedAt: new Date().toISOString(),
    data:    out,
  }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `marathon-einstellungen-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importLocalSettings(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (parsed?.schema !== 'marathon-settings-v1' || !parsed?.data) {
    throw new Error('Datei hat falsches Format.');
  }
  /* Wipe the marathon.* namespace first so removed keys don't linger. */
  const toRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith('marathon.')) toRemove.push(k);
  }
  toRemove.forEach((k) => window.localStorage.removeItem(k));
  for (const [k, v] of Object.entries(parsed.data)) {
    if (typeof k === 'string' && typeof v === 'string' && k.startsWith('marathon.')) {
      window.localStorage.setItem(k, v);
    }
  }
  /* Notify the experiments hook so any open Settings tab updates. */
  window.dispatchEvent(new Event('marathon-experiments-change'));
}

/* ════════════════════════════════════════════════════════════════════════
   Tiny helpers
   ════════════════════════════════════════════════════════════════════════ */
function fmtHm(sec) {
  if (!sec) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function Kbd({ children, inline }: { children?: ReactNode; inline?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: inline ? 18 : 24,
      height: inline ? 16 : 22,
      padding: inline ? '0 5px' : '0 7px',
      fontSize: inline ? 10 : 11,
      fontFamily: T.font.mono,
      color: T.text.secondary,
      background: T.bg.surface3,
      border: `1px solid ${T.border.primary}`,
      borderRadius: 3,
      lineHeight: 1,
      verticalAlign: 'middle',
    }}>
      {children}
    </span>
  );
}