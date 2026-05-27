/* Upload v2 — «Drop Studio».

   Magazine-spread design (matches Pruefen / Focus / Live / Historie /
   Warteschlange / Suche / Einstellungen):
     • Hero drop-zone with morphing states (idle / over / busy /
       success / batch-summary / countdown / duplicate / error)
     • Live parse-preview during busy — per-file rows reveal FBA-Code +
       pallets + articles as soon as the in-browser parse completes,
       BEFORE the backend save finishes (fade-in 80ms each)
     • Multi-file batch timeline — dropping N files no longer hides
       N-1 results: every parsed file gets its own row with bulk
       actions (Alle in Queue · Ersten starten)
     • Duplicate detection — same FBA / fileName already in queue or
       recent → inline confirm card (Trotzdem laden / Abbrechen)
     • Validation pre-flight — surfaces the first warning details so
       the operator can decide before queueing
     • KPI strip v2 — 5 magazine numbers (Heute geladen / In Queue /
       Heute fertig / Ø Dauer / Ø Paletten/Auftrag)
     • Recent v2 — rich cards with status-Badge (Queue · Aktiv · Fertig)
       and smart navigation (each opens the right screen)
     • Educational footer — first-run only, 3 mini-cards explaining
       Prüfen → Focus → Abschluss
     • Keyboard cockpit — `o` open picker, `Esc` cancel countdown / clear
       error, `⌘V` paste (existing usePasteFile hook), `g w` / `g h`
       sequence to jump to Warteschlange / Historie

   Backend unchanged — all preview, dedup and validation work happens
   in the browser before/after the existing `addFiles()` mutation.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LegacyAuftrag } from '@/types/state';
import type { FnskuValidationReport } from '@/utils/fnskuValidator';
import { useAppState } from '@/state.jsx';
import { useApiHealth } from '@/hooks/useApiHealth.js';
import { useRecentUploads } from '@/hooks/useRecentUploads.js';
import { useGlobalDragOverlay } from '@/hooks/useGlobalDragOverlay.js';
import { usePasteFile } from '@/hooks/usePasteFile.js';
import {
  Page, Topbar, StepperBar, Badge, CornerMarks, T,
} from '@/components/ui.jsx';
import { useBetaDesign } from '@/hooks/useBetaDesign';

const COUNTDOWN_SEC = 3;

/* ════════════════════════════════════════════════════════════════════════ */
export default function UploadScreen({ onRoute }) {
  const { beta } = useBetaDesign();
  const { queue, history, current, addFiles, startEntry } = useAppState();
  const { items: recent, add: addRecent, remove: removeRecent } = useRecentUploads();
  const apiHealth = useApiHealth();
  const isOffline = apiHealth?.data?.status === 'offline';

  const [busy, setBusy]         = useState(false);
  const [over, setOver]         = useState(false);
  type BatchItem = {
    name: string;
    stage: 'queued' | 'parsing' | 'ready' | 'done' | 'error';
    fba?: string | null;
    palletCount?: number;
    articleCount?: number;
    units?: number;
    validation?: unknown;
    entry?: LegacyAuftrag | null;
    error?: string | null;
  };
  const [batch, setBatch]       = useState<BatchItem[]>([]);
  const [batchDone, setBatchDone] = useState<BatchItem[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [countdown, setCountdown]   = useState<{ auftragId: string; remaining: number } | null>(null);
  const [duplicateConfirm, setDuplicateConfirm] = useState<{ files: File[]; dupes: unknown[] } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const globalOver = useGlobalDragOverlay();
  const goSeqRef = useRef({ ts: 0 }); /* `g w` / `g h` sequence buffer */

  /* ── duplicate detector ───────────────────────────────────────── */
  const dupIndex = useMemo(() => buildDupIndex(queue, recent), [queue, recent]);
  const detectDupes = useCallback(
    (files) => files.map((f) => ({
      file: f,
      hit: dupIndex.byFile.get(f.name.toLowerCase()) || null,
    })).filter((x) => x.hit),
    [dupIndex],
  );

  /* ── core file pipeline ───────────────────────────────────────── */
  const runUpload = useCallback(async (files) => {
    if (isOffline) {
      setParseError('Server offline — Backend nicht erreichbar. Backend starten und erneut versuchen.');
      return;
    }
    setParseError(null);
    setBatchDone([]);
    setBusy(true);

    const initial = files.map((f) => ({
      name: f.name,
      stage: 'pending',
      fba: null,
      palletCount: 0,
      articleCount: 0,
      units: 0,
      validation: null,
      entry: null,
      error: null,
    }));
    setBatch(initial);

    /* Per-file serialised pipeline so the operator sees each row resolve
       in turn. addFiles parses + saves; we interpret the returned entry
       (or empty array on error). */
    const built: LegacyAuftrag[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setBatch((prev) => prev.map((b, idx) => idx === i ? { ...b, stage: 'parsing' } : b));
      let result: LegacyAuftrag | null = null;
      try {
        const created = await addFiles([f]);
        result = created[0] || null;
      } catch {
        result = null;
      }
      if (!result) {
        setBatch((prev) => prev.map((b, idx) => idx === i
          ? { ...b, stage: 'error', error: 'Server hat nicht geantwortet oder Datei ist ungültig.' }
          : b));
        continue;
      }
      const meta: Record<string, unknown> = result.parsed?.meta || {};
      const palletCount  = result.parsed?.pallets?.length || 0;
      const articleCount = (result.parsed?.pallets || []).reduce((s, p) => s + (p.items?.length || 0), 0);
      const units        = Number(meta.totalUnits) || 0;
      const fba          = (meta.sendungsnummer as string | undefined) || (meta.fbaCode as string | undefined) || null;
      const isReady      = result.status === 'ready';
      setBatch((prev) => prev.map((b, idx) => idx === i ? {
        ...b,
        stage: isReady ? 'done' : 'error',
        fba,
        palletCount,
        articleCount,
        units,
        validation: result.validation || null,
        entry: result,
        error: isReady ? null : (result.error || 'Datei konnte nicht geparst werden.'),
      } : b));

      if (isReady) {
        built.push(result);
        addRecent({
          id: result.id,
          fileName: result.fileName,
          fbaCode: fba,
          palletCount,
          articleCount,
        });
      }
    }

    /* Capture final snapshot before clearing busy → SuccessContent /
       BatchSummary read it after the spinner releases. */
    setBatch((prev) => {
      setBatchDone(prev);
      return prev;
    });
    setBusy(false);

    /* Auto-start with 3-second countdown when exactly one ready entry
       was uploaded AND I don't already have an active Auftrag. The
       countdown gives the worker a window to override: Sofort starten
       (skip) or Abbrechen (drop into queue). Whether the queue already
       has other items doesn't matter — the worker JUST dropped this
       file, so the intent is "start this one next". */
    const successes = built.filter((b) => b.status === 'ready');
    if (successes.length === 1 && !current) {
      startCountdown(successes[0].id);
    }

    if (files.length > 0 && successes.length === 0) {
      setParseError(built[0]?.error || 'Keine Datei konnte verarbeitet werden.');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addFiles, addRecent, current, isOffline]);

  const acceptFiles = useCallback((fl: FileList | File[] | null) => {
    const arr = Array.from(fl || []).filter((f: File) => /\.docx$/i.test(f.name));
    if (!arr.length) return;
    const dupes = detectDupes(arr);
    if (dupes.length > 0) {
      setDuplicateConfirm({ files: arr, dupes });
      return;
    }
    runUpload(arr);
  }, [detectDupes, runUpload]);

  const confirmDuplicates = () => {
    const files = duplicateConfirm?.files || [];
    setDuplicateConfirm(null);
    if (files.length) runUpload(files);
  };
  const cancelDuplicates = () => setDuplicateConfirm(null);

  /* ── countdown logic ───────────────────────────────────────────────
     Two independent timers, one responsibility each:
       • fireTimer (setTimeout) — single shot at exactly 3000 ms,
         triggers the actual /start mutation. Precise — no drift.
       • displayTimer (setInterval) — 200 ms cadence, updates the
         visible second counter using wall-clock math
         (Date.now() - startedAt). Drift-free.
     Both auto-fire and the "Sofort starten" button go through the
     same fireNow() function so behaviour is identical. */
  const fireTimer    = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const displayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Hold the latest startEntry in a ref so the setTimeout closure
  // always sees the current callback, not the one captured at scheduling.
  const startEntryRef = useRef(startEntry);
  useEffect(() => { startEntryRef.current = startEntry; }, [startEntry]);

  const cancelCountdown = useCallback(() => {
    if (fireTimer.current)    { clearTimeout(fireTimer.current);     fireTimer.current    = null; }
    if (displayTimer.current) { clearInterval(displayTimer.current); displayTimer.current = null; }
    setCountdown(null);
  }, []);

  const fireNow = useCallback((auftragId: string) => {
    cancelCountdown();
    startEntryRef.current(auftragId);
  }, [cancelCountdown]);

  const startCountdown = useCallback((auftragId: string) => {
    cancelCountdown();
    /* Pre-fetch the Pruefen chunk NOW so it arrives by the time the
       countdown ends. Without this, the dynamic import only kicks off
       inside startEntry (when the countdown fires), so the worker
       sees a 100-500 ms Suspense fallback "Lädt…" between t=3 s and
       the actual Pruefen mount on first-of-session uploads. The
       fire-and-forget import is idempotent — already-cached chunks
       resolve instantly. */
    void import('./Pruefen.jsx');
    const startedAt = Date.now();
    const totalMs   = COUNTDOWN_SEC * 1000;
    setCountdown({ auftragId, remaining: COUNTDOWN_SEC });

    displayTimer.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(1, Math.ceil((totalMs - elapsed) / 1000));
      setCountdown((cur) =>
        cur && cur.auftragId === auftragId && cur.remaining !== remaining
          ? { ...cur, remaining }
          : cur,
      );
    }, 200);

    fireTimer.current = setTimeout(() => fireNow(auftragId), totalMs);
  }, [cancelCountdown, fireNow]);

  useEffect(() => () => cancelCountdown(), [cancelCountdown]);

  /* ── paste support ────────────────────────────────────────────── */
  usePasteFile(acceptFiles);

  /* ── keyboard cockpit ─────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
      if (inField) return;

      if (e.key === 'Escape') {
        if (countdown)        { cancelCountdown(); return; }
        if (parseError)       { setParseError(null); return; }
        if (duplicateConfirm) { cancelDuplicates(); return; }
      }
      if (e.key === 'o' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!busy && !duplicateConfirm) inputRef.current?.click();
        return;
      }
      /* `g` then `w` / `h` jump shortcut. */
      if (e.key === 'g') {
        goSeqRef.current = { ts: Date.now() };
        return;
      }
      const seqAlive = (Date.now() - (goSeqRef.current?.ts || 0)) < 1500;
      if (seqAlive && (e.key === 'w' || e.key === 'h')) {
        e.preventDefault();
        if (onRoute) onRoute(e.key === 'w' ? 'warteschlange' : 'historie');
        goSeqRef.current = { ts: 0 };
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, countdown, parseError, duplicateConfirm, cancelCountdown, onRoute]);

  /* ── derived: which batch slice to render ─────────────────────── */
  const liveBatch  = busy ? batch : batchDone;
  const lastSuccess = useMemo(
    () => liveBatch.filter((b) => b.stage === 'done' && b.entry).map((b) => b.entry).slice(-1)[0] || null,
    [liveBatch],
  );
  const showBatchSummary = !busy && !countdown && liveBatch.length > 1
    && liveBatch.some((b) => b.stage === 'done');
  const singleSuccessRow = !busy && !countdown && liveBatch.length === 1
    && liveBatch[0].stage === 'done' ? liveBatch[0] : null;

  const showEducation = !current && queue.length === 0 && recent.length === 0
    && !busy && !lastSuccess && !parseError && !countdown && !duplicateConfirm;

  if (beta) {
    return (
      <BetaUploadView
        queue={queue}
        isOffline={isOffline}
        over={over}
        globalOver={globalOver}
        busy={busy}
        batch={liveBatch}
        singleSuccess={singleSuccessRow}
        showBatchSummary={showBatchSummary}
        parseError={parseError}
        countdown={countdown}
        duplicateConfirm={duplicateConfirm}
        lastSuccess={lastSuccess}
        inputRef={inputRef}
        acceptFiles={acceptFiles}
        onPick={() => inputRef.current?.click()}
        onDragOverChange={setOver}
        onCancelCountdown={cancelCountdown}
        onStartNow={() => {
          const idToStart = countdown?.auftragId || lastSuccess?.id;
          if (idToStart) fireNow(idToStart);
        }}
        onAttachInstead={() => {
          cancelCountdown();
          if (onRoute) onRoute('warteschlange');
        }}
        onClearError={() => { setParseError(null); setBatchDone([]); }}
        onConfirmDupes={confirmDuplicates}
        onCancelDupes={cancelDuplicates}
        onStartFromBatch={(id) => { startEntry(id); }}
        onAllToQueue={() => {
          setBatchDone([]);
          if (onRoute) onRoute('warteschlange');
        }}
        onCloseBatchSummary={() => setBatchDone([])}
        onOpenQueue={() => onRoute && onRoute('warteschlange')}
      />
    );
  }

  return (
    <Page>
      <Topbar
        crumbs={[{ label: 'Upload' }]}
        right={
          isOffline ? (
            <OfflineDot />
          ) : queue.length > 0 ? (
            <StatusStrip
              count={queue.length}
              onOpen={() => onRoute && onRoute('warteschlange')}
            />
          ) : null
        }
      />

      <StepperBar active="upload" />

      <main style={{
        maxWidth: 1120,
        margin: '0 auto',
        padding: '72px 40px 96px',
        display: 'flex',
        flexDirection: 'column',
        gap: 64,
      }}>
        {/* HERO */}
        <section style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 22,
        }}>
          <h1 style={{
            margin: 0,
            fontSize: 'clamp(36px, 2.8vw, 52px)',
            fontWeight: 500,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            color: T.text.primary,
            textAlign: 'center',
          }}>
            Auftrag laden
          </h1>
          <p style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 400,
            lineHeight: 1.5,
            color: T.text.subtle,
            textAlign: 'center',
            maxWidth: 520,
          }}>
            <code style={inlineCodeStyle}>.docx</code>-Datei ablegen — Marathon
            erkennt das Format, parst lokal und übergibt es validiert an
            die Warteschlange.
          </p>

          <div style={{
            position: 'relative',
            width: '100%',
            maxWidth: 920,
            marginTop: 26,
          }}>
            {/* Mono eyebrow above the drop surface — labels it as a studio */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
              padding: '0 4px',
            }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 10.5,
                fontFamily: T.font.mono,
                fontWeight: 600,
                color: T.text.subtle,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.accent.main }} />
                Drop Studio · .docx-Empfang
              </span>
              <span style={{
                fontSize: 10.5,
                fontFamily: T.font.mono,
                fontWeight: 500,
                color: T.text.faint,
                letterSpacing: '0.10em',
              }}>
                {isOffline ? 'OFFLINE' : 'BEREIT'}
              </span>
            </div>

            {/* Corner accents — Linear/Raycast-style hairline frame marks */}
            <CornerMarks />

            <HeroDropZone
              over={over || globalOver}
              busy={busy}
              batch={liveBatch}
              singleSuccess={singleSuccessRow}
              showBatchSummary={showBatchSummary}
              parseError={parseError}
              countdown={countdown}
              duplicateConfirm={duplicateConfirm}
              isOffline={isOffline}
              onPick={() => inputRef.current?.click()}
              onAccept={acceptFiles}
              onDragOverChange={setOver}
              onCancelCountdown={cancelCountdown}
              onStartNow={() => {
                const idToStart = countdown?.auftragId || lastSuccess?.id;
                if (idToStart) fireNow(idToStart);
              }}
              onAttachInstead={() => {
                cancelCountdown();
                if (onRoute) onRoute('warteschlange');
              }}
              onClearError={() => { setParseError(null); setBatchDone([]); }}
              onConfirmDupes={confirmDuplicates}
              onCancelDupes={cancelDuplicates}
              onStartFromBatch={(id) => { startEntry(id); }}
              onAllToQueue={() => {
                /* No-op — they're already in queue once addFiles resolved.
                   We just visually retire the summary by clearing it. */
                setBatchDone([]);
                if (onRoute) onRoute('warteschlange');
              }}
              onCloseBatchSummary={() => setBatchDone([])}
            />
            <input
              ref={inputRef}
              type="file"
              accept=".docx"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { acceptFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
        </section>

        {/* KPI STRIP — magazine-style 5 numbers from local history + queue */}
        {(history.length > 0 || queue.length > 0) && (
          <KpiStripV2 history={history} queue={queue} current={current} />
        )}

        {/* RECENT — rich card list */}
        {recent.length > 0 && (
          <RecentV2
            items={recent}
            queue={queue}
            current={current}
            history={history}
            onOpen={(entry, status) => {
              if (status === 'aktiv')   return onRoute?.('workspace');
              if (status === 'queue')   return onRoute?.('warteschlange');
              if (status === 'fertig')  return onRoute?.('historie');
              return onRoute?.('warteschlange');
            }}
            onRemove={removeRecent}
          />
        )}

        {/* EDUCATIONAL FOOTER — first-run scaffolding */}
        {showEducation && <EducationalFooter />}

        {/* KEYBOARD HINTS */}
        <KbdHints />
      </main>

      {/* Page-wide drag overlay */}
      <GlobalDragOverlay
        visible={globalOver && !busy}
        onDrop={(e) => { e.preventDefault(); acceptFiles(e.dataTransfer.files); }}
      />
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   HERO DROP-ZONE — single block, multiple morphing states
   ════════════════════════════════════════════════════════════════════════ */
function HeroDropZone({
  over, busy, batch, singleSuccess, showBatchSummary, parseError, countdown,
  duplicateConfirm, isOffline,
  onPick, onAccept, onDragOverChange,
  onCancelCountdown, onStartNow, onAttachInstead, onClearError,
  onConfirmDupes, onCancelDupes,
  onStartFromBatch, onAllToQueue, onCloseBatchSummary,
}) {
  const showCountdown = !!countdown;
  const showDup       = !!duplicateConfirm && !showCountdown;
  const showError     = !!parseError && !showCountdown && !showDup;
  const showBusy      = busy && !showCountdown && !showError && !showDup;
  const showSingle    = !!singleSuccess && !showCountdown && !showDup && !showError && !showBusy;
  const showSummary   = !!showBatchSummary && !showCountdown && !showDup && !showError && !showBusy && !showSingle;
  const showOver      = over && !busy && !showCountdown && !showError && !showDup && !showSingle && !showSummary;
  const showIdle      = !showCountdown && !showError && !showDup && !showBusy && !showOver && !showSingle && !showSummary;

  const palette = (() => {
    if (isOffline)    return { border: T.status.danger.border, bg: T.status.danger.bg, dashed: false };
    if (showError)    return { border: T.status.danger.border, bg: T.status.danger.bg, dashed: false };
    if (showDup)      return { border: T.status.warn.border,   bg: T.status.warn.bg,   dashed: false };
    if (showSingle)   return { border: T.status.success.border, bg: T.status.success.bg, dashed: false };
    if (showSummary)  return { border: T.accent.border, bg: T.accent.bg, dashed: false };
    if (showCountdown) return { border: T.accent.border, bg: T.accent.bg, dashed: false };
    if (showBusy)     return { border: T.accent.border, bg: T.accent.bg, dashed: false };
    if (showOver)     return { border: T.accent.main,   bg: T.accent.bg, dashed: true };
    return { border: T.border.strong, bg: T.bg.surface, dashed: true };
  })();

  return (
    <div
      onClick={() => { if (showIdle) onPick(); }}
      onDragOver={(e) => { e.preventDefault(); onDragOverChange(true); }}
      onDragLeave={() => onDragOverChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragOverChange(false);
        onAccept(e.dataTransfer.files);
      }}
      style={{
        position: 'relative',
        minHeight: 300,
        padding: '52px 56px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        background: palette.bg,
        border: `1px ${palette.dashed ? 'dashed' : 'solid'} ${palette.border}`,
        borderRadius: 18,
        cursor: showIdle ? 'pointer' : 'default',
        boxShadow: showOver
          ? `0 0 0 1px ${T.accent.border}, 0 24px 60px -22px ${T.accent.main}55, 0 6px 18px rgba(17,24,39,0.06)`
          : showIdle
          ? '0 1px 3px rgba(17,24,39,0.03), 0 18px 44px -22px rgba(17,24,39,0.18), 0 4px 10px -4px rgba(17,24,39,0.04)'
          : '0 1px 3px rgba(17,24,39,0.04), 0 12px 32px -16px rgba(17,24,39,0.14)',
        transition: 'background 240ms cubic-bezier(0.16, 1, 0.3, 1), border-color 240ms cubic-bezier(0.16, 1, 0.3, 1), transform 240ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 240ms cubic-bezier(0.16, 1, 0.3, 1)',
        transform: showOver ? 'scale(1.008)' : 'scale(1)',
        backgroundImage: showIdle
          ? `radial-gradient(circle at 50% 50%, ${T.bg.surface} 0%, ${T.bg.surface} 60%, ${T.bg.surface2} 100%)`
          : 'none',
      }}
    >
      {showIdle      && <IdleContent isOffline={isOffline} onPick={onPick} />}
      {showOver      && <OverContent />}
      {showBusy      && <BatchTimeline batch={batch} />}
      {showSingle    && <SuccessContent
                          row={singleSuccess}
                          onStart={onStartNow}
                          onAttach={onAttachInstead}
                        />}
      {showSummary   && <BatchSummary
                          batch={batch}
                          onStartFromBatch={onStartFromBatch}
                          onAllToQueue={onAllToQueue}
                          onClose={onCloseBatchSummary}
                        />}
      {showError     && <ErrorContent message={parseError} onPick={onPick} onClear={onClearError} />}
      {showCountdown && <CountdownContent
                          countdown={countdown}
                          onCancel={onCancelCountdown}
                          onStartNow={onStartNow}
                        />}
      {showDup       && <DuplicateContent
                          dupes={duplicateConfirm.dupes}
                          onConfirm={onConfirmDupes}
                          onCancel={onCancelDupes}
                        />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   IDLE / OVER / OFFLINE
   ════════════════════════════════════════════════════════════════════════ */
function IdleContent({ isOffline, onPick }) {
  if (isOffline) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <span style={{
          width: 46, height: 46,
          borderRadius: 12,
          background: '#fff',
          border: `1px solid ${T.status.danger.border}`,
          color: T.status.danger.main,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M3 12a9 9 0 0 1 18 0M5 16a7 7 0 0 1 14 0M12 20h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 500, color: T.status.danger.text, letterSpacing: '-0.012em' }}>
            Server offline
          </div>
          <div style={{ marginTop: 4, fontSize: 13, color: T.status.danger.text, opacity: 0.85 }}>
            Marathon prüft alle 20 Sek. die Verbindung. Sobald sie wieder
            steht, kannst du laden.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
      <DropIcon size={36} />
      <div style={{ flex: 1, lineHeight: 1.5 }}>
        <div style={{
          fontSize: 20,
          fontWeight: 500,
          color: T.text.primary,
          letterSpacing: '-0.018em',
        }}>
          Datei hier ablegen
        </div>
        <div style={{
          marginTop: 6,
          fontSize: 13.5,
          color: T.text.subtle,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}>
          <span>.docx · Drag &amp; Drop, klicken,</span>
          <Kbd>O</Kbd>
          <span>öffnen oder</span>
          <Kbd>⌘V</Kbd>
          <span>einfügen</span>
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onPick(); }}
        style={{
          padding: '10px 18px',
          fontSize: 13,
          fontWeight: 500,
          color: T.text.secondary,
          background: T.bg.surface,
          border: `1px solid ${T.border.strong}`,
          borderRadius: 8,
          cursor: 'pointer',
          fontFamily: T.font.ui,
          transition: 'all 160ms',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = T.accent.main;
          e.currentTarget.style.color = T.accent.main;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = T.border.strong;
          e.currentTarget.style.color = T.text.secondary;
        }}
      >
        Datei wählen
      </button>
    </div>
  );
}

function OverContent() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
      <DropIcon accent />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 18, fontWeight: 500, color: T.accent.text, letterSpacing: '-0.012em' }}>
          Jetzt loslassen
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: T.accent.text, opacity: 0.8 }}>
          Marathon erkennt das Format automatisch — auch mehrere Dateien gleichzeitig.
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   BATCH TIMELINE — live progress, one row per file
   ════════════════════════════════════════════════════════════════════════ */
function BatchTimeline({ batch }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 4,
      }}>
        <Spinner size={16} color={T.accent.main} />
        <span style={{
          fontSize: 14,
          fontWeight: 500,
          color: T.accent.text,
          letterSpacing: '-0.005em',
        }}>
          {batch.length === 1 ? 'Wird verarbeitet…' : `${batch.length} Dateien — wird verarbeitet…`}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          color: T.accent.text,
          opacity: 0.7,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {batch.filter((b) => b.stage === 'done').length}/{batch.length} ✓
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {batch.map((b, i) => <BatchTimelineRow key={i} row={b} />)}
      </div>
    </div>
  );
}

function BatchTimelineRow({ row }) {
  const isPending = row.stage === 'pending';
  const isParsing = row.stage === 'parsing';
  const isDone    = row.stage === 'done';
  const isError   = row.stage === 'error';

  const fnskuReport: FnskuValidationReport | null =
    (row.validation && typeof row.validation === 'object' && (row.validation as { fnsku?: FnskuValidationReport }).fnsku) || null;
  const [showFnskuDetail, setShowFnskuDetail] = useState(false);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      padding: '8px 0',
      borderTop: `1px solid ${T.accent.border}`,
      animation: 'mp-up-fade 200ms ease-out',
    }}>
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    }}>
      <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center' }}>
        {isPending && <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.text.faint }} />}
        {isParsing && <Spinner size={12} color={T.accent.main} />}
        {isDone    && (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: T.status.success.main }}>
            <path d="M3 7l3 3 5-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {isError && (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: T.status.danger.main }}>
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 12.5,
        color: T.text.primary,
        flex: '0 0 auto',
        maxWidth: 240,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }} title={row.name}>
        {row.name}
      </span>
      {/* Live preview — appears as parse completes */}
      {isDone && row.fba && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontFamily: T.font.mono,
          color: T.text.secondary,
          flex: 1,
          minWidth: 0,
          animation: 'mp-up-fade 220ms ease-out',
        }}>
          <span style={{ color: T.accent.text, fontWeight: 600 }}>{row.fba}</span>
          <span style={{ color: T.border.strong }}>·</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.palletCount} Pal</span>
          <span style={{ color: T.border.strong }}>·</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.articleCount} Art</span>
          {row.units > 0 && (
            <>
              <span style={{ color: T.border.strong }}>·</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.units.toLocaleString('de-DE')} EH</span>
            </>
          )}
          <ValidationPill validation={row.validation} />
          <FnskuScanPill report={fnskuReport} expanded={showFnskuDetail} onToggle={() => setShowFnskuDetail((s) => !s)} />
        </span>
      )}
      {isError && (
        <span style={{
          fontSize: 11.5,
          color: T.status.danger.text,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={row.error || ''}>
          {row.error || 'Fehler'}
        </span>
      )}
      </div>
      {isDone && fnskuReport && showFnskuDetail && (
        <FnskuScanDetail report={fnskuReport} />
      )}
    </div>
  );
}

function ValidationPill({ validation }) {
  if (!validation) return null;
  const errs  = validation.errorCount || 0;
  const warns = validation.warningCount || 0;
  if (errs === 0 && warns === 0) {
    return <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: T.status.success.text, fontFamily: T.font.mono }}>VALIDIERT</span>;
  }
  if (errs > 0) {
    return <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: T.status.danger.text, fontFamily: T.font.mono }}>{errs} FEHLER</span>;
  }
  return <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: T.status.warn.text, fontFamily: T.font.mono }}>{warns} WARN</span>;
}

/* Independent FNSKU-scan cross-check pill. Result comes from
   validateFnskuAgainstParser() run in parseDocxFile() and is stored
   under validation.fnsku. Green pill = scanner and columnar parser
   agree; warn pill = at least one delta — click to expand. */
function FnskuScanPill({ report, expanded, onToggle }: {
  report: FnskuValidationReport | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!report) return null;
  if (report.status === 'ok') {
    return (
      <span style={{
        fontSize: 10.5, fontWeight: 700, color: T.status.success.text,
        fontFamily: T.font.mono,
      }}
      title={`FNSKU-Scan stimmt mit Parser überein (${report.summary.scanCount})`}
      >FNSKU ✓</span>
    );
  }
  const total = report.missingFromParser.length
    + report.extraInParser.length
    + report.countMismatches.length
    + report.positionMismatches.length
    + report.palletCountMismatches.length
    + report.fieldConsistencyMismatches.length
    + report.useItemMismatches.length;
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        fontSize: 10.5, fontWeight: 700, color: T.status.warn.text,
        fontFamily: T.font.mono,
        background: 'transparent',
        border: `1px solid ${T.status.warn.border}`,
        borderRadius: 4,
        padding: '2px 6px',
        cursor: 'pointer',
      }}
      title="FNSKU-Vergleich Parser vs. Scanner — klicken für Details"
    >
      {total} FNSKU-DIFF {expanded ? '▾' : '▸'}
    </button>
  );
}

function FnskuScanDetail({ report }: { report: FnskuValidationReport }) {
  const rowStyle: React.CSSProperties = {
    fontFamily: T.font.mono,
    fontSize: 11,
    color: T.text.secondary,
    paddingLeft: 26,
    marginTop: 4,
  };
  const labelStyle: React.CSSProperties = {
    color: T.status.warn.text, fontWeight: 700, marginRight: 6,
  };
  return (
    <div style={{
      marginTop: 6,
      padding: '8px 10px 8px 26px',
      background: T.bg.surface3,
      borderRadius: 4,
      borderLeft: `2px solid ${T.status.warn.main}`,
      animation: 'mp-up-fade 200ms ease-out',
    }}>
      <div style={rowStyle}>
        <span style={labelStyle}>Scan</span>{report.summary.scanCount}
        <span style={{ margin: '0 6px', color: T.border.strong }}>·</span>
        <span style={labelStyle}>Parser</span>{report.summary.parserCount}
        {report.summary.headerCandidates.length > 0 && (
          <>
            <span style={{ margin: '0 6px', color: T.border.strong }}>·</span>
            <span style={{ color: T.text.faint }}>
              Header-Kandidaten ignoriert: {report.summary.headerCandidates.join(', ')}
            </span>
          </>
        )}
      </div>
      {report.missingFromParser.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>Im Text, nicht im Parser</span>
          {report.missingFromParser.join(', ')}
        </div>
      )}
      {report.extraInParser.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>Im Parser, nicht im Text</span>
          {report.extraInParser.join(', ')}
        </div>
      )}
      {report.countMismatches.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>Anzahl-Mismatch</span>
          {report.countMismatches.map((m) => `${m.fnsku} (Text ${m.scan} / Parser ${m.parser})`).join(', ')}
        </div>
      )}
      {report.positionMismatches.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>Reihenfolge</span>
          {report.positionMismatches.map((m) => `${m.fnsku} (Text #${m.scanIndex + 1} ↔ Parser #${m.parserIndex + 1})`).join(', ')}
        </div>
      )}
      {report.palletCountMismatches.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>Auf Palette</span>
          {report.palletCountMismatches.map((m) =>
            `${m.palletId}: ${m.fnsku} (Text ${m.scan} / Parser ${m.parser})`,
          ).join(' · ')}
        </div>
      )}
      {report.fieldConsistencyMismatches.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>Feld-Konsistenz</span>
          {report.fieldConsistencyMismatches.map((m) =>
            `${m.fnsku}.${m.field}: [${m.values.join(' ≠ ')}]`,
          ).join(' · ')}
        </div>
      )}
      {report.useItemMismatches.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>useItem</span>
          {report.useItemMismatches.map((m) => {
            const expected = m.expectedField === 'fnsku' ? m.fnsku : (m.itemEan ?? '∅');
            return `${m.fnsku}: useItem→${m.useItemExtractedCode} ≠ ${m.expectedField}=${expected}`;
          }).join(' · ')}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   SUCCESS — single-file path
   ════════════════════════════════════════════════════════════════════════ */
function SuccessContent({ row, onStart, onAttach }) {
  const [showWarnings, setShowWarnings] = useState(false);
  const v = row.validation || {};
  const hasWarnings = (v.warningCount || 0) > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <span style={{
          width: 36, height: 36,
          borderRadius: '50%',
          background: T.status.success.main,
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 9l3 3 7-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: T.font.mono,
            fontSize: 15,
            fontWeight: 500,
            color: T.text.primary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {row.fba || row.name}
          </div>
          <div style={{
            marginTop: 4,
            display: 'flex',
            gap: 14,
            fontSize: 12,
            color: T.text.subtle,
            fontVariantNumeric: 'tabular-nums',
            flexWrap: 'wrap',
          }}>
            <span>{row.palletCount} Pal · {row.articleCount} Art</span>
            {row.units > 0 && <span>{row.units.toLocaleString('de-DE')} EH</span>}
            {(v.errorCount || 0) > 0
              ? <span style={{ color: T.status.danger.text }}>{v.errorCount} Fehler</span>
              : hasWarnings
              ? <span style={{ color: T.status.warn.text }}>{v.warningCount} Warnungen</span>
              : <span style={{ color: T.status.success.text }}>Validiert</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onAttach}
            style={ghostButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.text.subtle; e.currentTarget.style.color = T.text.primary; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border.strong; e.currentTarget.style.color = T.text.secondary; }}
          >
            In Warteschlange
          </button>
          <button
            onClick={onStart}
            style={primaryButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = T.accent.hover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = T.accent.main; }}
          >
            Jetzt starten
            <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2.5 1.5v9l8-4.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Validation drawer — collapsible */}
      {hasWarnings && (
        <div style={{
          background: T.bg.surface,
          border: `1px solid ${T.status.warn.border}`,
          borderRadius: T.radius.md,
          padding: '10px 14px',
        }}>
          <button
            onClick={() => setShowWarnings((s) => !s)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: 0,
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
              fontFamily: T.font.ui,
              fontSize: 12.5,
              fontWeight: 500,
              color: T.status.warn.text,
              textAlign: 'left',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{
              transform: showWarnings ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 180ms',
            }}>
              <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{v.warningCount} {v.warningCount === 1 ? 'Warnung' : 'Warnungen'} · {showWarnings ? 'einklappen' : 'anzeigen'}</span>
          </button>
          {showWarnings && (
            <ul style={{
              margin: '10px 0 0',
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}>
              {(v.issues || []).slice(0, 8).map((iss, i) => (
                <li key={i} style={{
                  fontSize: 12,
                  fontFamily: T.font.mono,
                  color: T.text.secondary,
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                }}>
                  <span style={{ color: T.status.warn.main }}>▸</span>
                  <span>{iss.message || iss.code || JSON.stringify(iss)}</span>
                </li>
              ))}
              {(v.issues || []).length > 8 && (
                <li style={{ fontSize: 11.5, color: T.text.faint, marginTop: 4 }}>
                  +{v.issues.length - 8} weitere — sichtbar nach dem Laden im Prüfen-Schritt.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   BATCH SUMMARY — multi-file post-upload card
   ════════════════════════════════════════════════════════════════════════ */
function BatchSummary({ batch, onStartFromBatch, onAllToQueue, onClose }) {
  const successes = batch.filter((b) => b.stage === 'done');
  const errors    = batch.filter((b) => b.stage === 'error');
  const totalPal  = successes.reduce((s, b) => s + (b.palletCount || 0), 0);
  const totalArt  = successes.reduce((s, b) => s + (b.articleCount || 0), 0);
  const warnings  = successes.filter((b) => (b.validation?.warningCount || 0) > 0).length;

  const firstReadyId = successes.find((b) => b.entry?.id)?.entry?.id || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Aggregate */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <span style={{
          width: 36, height: 36,
          borderRadius: '50%',
          background: T.accent.main,
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontFamily: T.font.mono,
          fontSize: 14,
          fontWeight: 700,
        }}>
          {batch.length}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 15,
            fontWeight: 500,
            color: T.accent.text,
            letterSpacing: '-0.005em',
          }}>
            {batch.length} Dateien geladen
          </div>
          <div style={{
            marginTop: 4,
            display: 'flex',
            gap: 14,
            fontSize: 12,
            color: T.text.subtle,
            fontVariantNumeric: 'tabular-nums',
            flexWrap: 'wrap',
          }}>
            <span style={{ color: T.status.success.text }}>{successes.length} ✓</span>
            {errors.length > 0   && <span style={{ color: T.status.danger.text }}>{errors.length} ✗</span>}
            {warnings > 0        && <span style={{ color: T.status.warn.text }}>{warnings} mit Warnungen</span>}
            <span>{totalPal} Pal · {totalArt} Art</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onClose} style={ghostButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.text.subtle; e.currentTarget.style.color = T.text.primary; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border.strong; e.currentTarget.style.color = T.text.secondary; }}
          >
            Schließen
          </button>
          {firstReadyId && (
            <button
              onClick={() => onStartFromBatch(firstReadyId)}
              style={primaryButtonStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = T.accent.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = T.accent.main; }}
            >
              Ersten starten
              <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.5 1.5v9l8-4.5z" />
              </svg>
            </button>
          )}
          <button
            onClick={onAllToQueue}
            style={ghostButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent.main; e.currentTarget.style.color = T.accent.main; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border.strong; e.currentTarget.style.color = T.text.secondary; }}
          >
            Alle in Queue →
          </button>
        </div>
      </div>

      {/* Per-file rows */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        background: T.bg.surface,
        border: `1px solid ${T.accent.border}`,
        borderRadius: T.radius.md,
        overflow: 'hidden',
      }}>
        {batch.map((row, i) => (
          <BatchSummaryRow
            key={i}
            row={row}
            isLast={i === batch.length - 1}
            onStart={row.entry?.id ? () => onStartFromBatch(row.entry.id) : null}
          />
        ))}
      </div>
    </div>
  );
}

function BatchSummaryRow({ row, isLast, onStart }) {
  const v = row.validation || {};
  const isErr = row.stage === 'error';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '12px 14px',
      borderBottom: !isLast ? `1px solid ${T.border.subtle}` : 'none',
    }}>
      <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
        {isErr ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: T.status.danger.main }}>
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: T.status.success.main }}>
            <path d="M3 7l3 3 5-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: T.font.mono,
          fontSize: 13,
          fontWeight: 500,
          color: T.text.primary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {row.fba || row.name}
        </div>
        <div style={{
          marginTop: 2,
          fontSize: 11.5,
          color: T.text.subtle,
          fontFamily: T.font.mono,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={row.name}>
          {isErr ? (row.error || 'Fehler') : `${row.name}`}
        </div>
      </div>
      {!isErr && (
        <span style={{
          fontSize: 11.5,
          fontFamily: T.font.mono,
          color: T.text.secondary,
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
        }}>
          {row.palletCount}/{row.articleCount}
        </span>
      )}
      {!isErr && (
        (v.errorCount || 0) > 0 ? <Badge tone="danger">{v.errorCount} Fehler</Badge>
        : (v.warningCount || 0) > 0 ? <Badge tone="warn">{v.warningCount} Warn</Badge>
        : <Badge tone="success">Validiert</Badge>
      )}
      {onStart && (
        <button
          onClick={onStart}
          style={{
            padding: '5px 10px',
            fontSize: 11.5,
            fontWeight: 500,
            color: T.text.secondary,
            background: 'transparent',
            border: `1px solid ${T.border.primary}`,
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: T.font.ui,
            transition: 'all 150ms',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent.main; e.currentTarget.style.color = T.accent.main; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border.primary; e.currentTarget.style.color = T.text.secondary; }}
        >
          Starten
        </button>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   COUNTDOWN
   ════════════════════════════════════════════════════════════════════════ */
function CountdownContent({ countdown, onCancel, onStartNow }) {
  const ratio = (COUNTDOWN_SEC - countdown.remaining + 1) / COUNTDOWN_SEC;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <span style={{ position: 'relative', width: 44, height: 44, flexShrink: 0 }}>
        <svg width="44" height="44" viewBox="0 0 44 44">
          <circle cx="22" cy="22" r="18" stroke={T.accent.border} strokeWidth="2" fill="none" />
          <circle
            cx="22" cy="22" r="18"
            stroke={T.accent.main}
            strokeWidth="2"
            fill="none"
            strokeDasharray={`${2 * Math.PI * 18}`}
            strokeDashoffset={`${2 * Math.PI * 18 * (1 - ratio)}`}
            strokeLinecap="round"
            transform="rotate(-90 22 22)"
            style={{ transition: 'stroke-dashoffset 1000ms linear' }}
          />
        </svg>
        <span style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: T.font.mono,
          fontSize: 16,
          fontWeight: 600,
          color: T.accent.text,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {countdown.remaining}
        </span>
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: T.accent.text, letterSpacing: '-0.005em' }}>
          Startet automatisch in {countdown.remaining}s
        </div>
        <div style={{ fontSize: 12, color: T.accent.text, opacity: 0.85, marginTop: 2 }}>
          <Kbd>Esc</Kbd> oder „Stop" hält den Auto-Start an.
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onCancel} style={ghostButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.status.danger.main; e.currentTarget.style.color = T.status.danger.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border.strong; e.currentTarget.style.color = T.text.secondary; }}
        >
          Stop
        </button>
        <button onClick={onStartNow} style={primaryButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = T.accent.hover; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = T.accent.main; }}
        >
          Sofort starten
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ERROR
   ════════════════════════════════════════════════════════════════════════ */
function ErrorContent({ message, onPick, onClear }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <span style={{
        width: 36, height: 36,
        borderRadius: '50%',
        background: T.status.danger.main,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M9 4v6m0 2.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: T.status.danger.text }}>
          Datei konnte nicht verarbeitet werden
        </div>
        <div style={{
          marginTop: 4,
          fontSize: 12,
          color: T.status.danger.text,
          opacity: 0.85,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 480,
        }} title={message}>
          {message}
        </div>
      </div>
      <button
        onClick={() => { onClear(); onPick(); }}
        style={primaryButtonStyle}
        onMouseEnter={(e) => { e.currentTarget.style.background = T.accent.hover; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = T.accent.main; }}
      >
        Andere Datei wählen
      </button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   DUPLICATE — confirm card
   ════════════════════════════════════════════════════════════════════════ */
function DuplicateContent({ dupes, onConfirm, onCancel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
      <span style={{
        width: 36, height: 36,
        borderRadius: '50%',
        background: T.status.warn.main,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M9 4v6m0 2.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: T.status.warn.text }}>
          {dupes.length === 1 ? 'Diese Datei kennst du schon' : `${dupes.length} dieser Dateien kennst du schon`}
        </div>
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {dupes.slice(0, 4).map((d, i) => (
            <div key={i} style={{
              fontSize: 12,
              fontFamily: T.font.mono,
              color: T.text.secondary,
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
            }}>
              <span style={{ color: T.status.warn.main }}>▸</span>
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 320,
              }}>{d.file.name}</span>
              <span style={{ color: T.text.faint }}>{d.hit.where} · {d.hit.relative}</span>
            </div>
          ))}
          {dupes.length > 4 && (
            <div style={{ fontSize: 11.5, color: T.text.faint }}>
              +{dupes.length - 4} weitere
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button onClick={onCancel} style={ghostButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.text.subtle; e.currentTarget.style.color = T.text.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border.strong; e.currentTarget.style.color = T.text.secondary; }}
        >
          Abbrechen
        </button>
        <button onClick={onConfirm} style={primaryButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = T.accent.hover; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = T.accent.main; }}
        >
          Trotzdem laden
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   GLOBAL DRAG OVERLAY
   ════════════════════════════════════════════════════════════════════════ */
function GlobalDragOverlay({ visible, onDrop }) {
  if (!visible) return null;
  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999,
        background: 'rgba(17, 24, 39, 0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
      }}
    >
      <div style={{
        width: 'min(80vw, 560px)',
        padding: '64px 48px',
        background: T.bg.surface,
        border: `2px dashed ${T.accent.main}`,
        borderRadius: 16,
        textAlign: 'center',
        boxShadow: T.shadow.modal,
      }}>
        <DropIcon accent size={36} />
        <div style={{
          marginTop: 18,
          fontSize: 22,
          fontWeight: 500,
          color: T.accent.text,
          letterSpacing: '-0.018em',
        }}>
          Datei hier ablegen
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: T.text.subtle }}>
          .docx-Datei wird automatisch erkannt und in die Warteschlange gelegt.
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   STATUS STRIP (top-right)
   ════════════════════════════════════════════════════════════════════════ */
function StatusStrip({ count, onOpen }) {
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 11px',
        background: T.accent.bg,
        border: `1px solid ${T.accent.border}`,
        borderRadius: 999,
        cursor: 'pointer',
        fontFamily: T.font.ui,
        transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent.main; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.accent.border; e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.accent.main }} />
      <span style={{ fontSize: 11.5, fontWeight: 500, color: T.accent.text, letterSpacing: '-0.005em', whiteSpace: 'nowrap' }}>
        {count} in Warteschlange
      </span>
      <span style={{ fontSize: 11, color: T.accent.text, opacity: 0.7 }}>→</span>
    </button>
  );
}

function OfflineDot() {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      background: T.status.danger.bg,
      border: `1px solid ${T.status.danger.border}`,
      borderRadius: 999,
      fontFamily: T.font.mono,
      fontSize: 11,
      color: T.status.danger.text,
      letterSpacing: '0.04em',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.status.danger.main }} />
      OFFLINE
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   KPI STRIP V2 — magazine-style 5 numbers
   ════════════════════════════════════════════════════════════════════════ */
function KpiStripV2({ history, queue, current }) {
  const stats = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = +todayStart;
    let loadedToday = 0;
    let finishedToday = 0;
    let totalSec = 0;
    let totalPal = 0;
    let n = 0;
    for (const h of history) {
      n += 1;
      totalSec += h.durationSec || 0;
      totalPal += h.palletCount || 0;
      if (h.finishedAt && h.finishedAt >= todayMs) finishedToday += 1;
    }
    /* Loaded-today is best-effort: queue + current + finished today are
       lifetime-of-shift entities. We approximate with finishedToday +
       (queue.length already includes parsed-today) + (1 if current). */
    loadedToday = finishedToday + queue.length + (current ? 1 : 0);
    return {
      loadedToday,
      inQueue: queue.length,
      finishedToday,
      avgSec: n > 0 ? Math.round(totalSec / n) : 0,
      avgPal: n > 0 ? totalPal / n : 0,
      n,
    };
  }, [history, queue, current]);

  return (
    <section style={{
      padding: '24px 28px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      display: 'grid',
      gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 8,
    }}>
      <KpiBox label="Heute geladen" value={stats.loadedToday} />
      <KpiBox label="In Queue"      value={stats.inQueue}      accent={stats.inQueue > 0} />
      <KpiBox label="Heute fertig"  value={stats.finishedToday} success={stats.finishedToday > 0} />
      <KpiBox label="Ø Dauer"       value={stats.avgSec ? formatMin(stats.avgSec) : '—'} />
      <KpiBox label="Ø Paletten"    value={stats.n > 0 ? stats.avgPal.toFixed(1) : '—'} />
    </section>
  );
}

function KpiBox({ label, value, accent, success }: { label?: React.ReactNode; value?: React.ReactNode; accent?: boolean; success?: boolean }) {
  const color = accent ? T.accent.text : success ? T.status.success.text : T.text.primary;
  return (
    <div>
      <div style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: T.font.ui,
        fontSize: 26,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        color,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
      }}>
        {value}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   RECENT V2 — rich cards with status-aware navigation
   ════════════════════════════════════════════════════════════════════════ */
function RecentV2({ items, queue, current, history, onOpen, onRemove }) {
  /* Derive status of each recent entry from live data. */
  const annotated = useMemo(() => items.map((it) => {
    const statusInfo = deriveRecentStatus(it, queue, current, history);
    return { ...it, ...statusInfo };
  }), [items, queue, current, history]);

  return (
    <section>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        marginBottom: 14,
      }}>
        <span style={{
          fontSize: 10.5,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.10em',
        }}>
          Zuletzt geladen
        </span>
        <span style={{ fontSize: 11, color: T.text.faint, fontFamily: T.font.mono }}>
          {items.length}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {annotated.map((entry) => (
          <RecentCard
            key={entry.id}
            entry={entry}
            onOpen={() => onOpen(entry, entry.statusKey)}
            onRemove={() => onRemove(entry.id)}
          />
        ))}
      </div>
    </section>
  );
}

function deriveRecentStatus(entry, queue, current, history) {
  if (current && current.id === entry.id) {
    return { statusKey: 'aktiv',  statusLabel: 'Aktiv',     statusTone: 'warn'    };
  }
  if (queue.some((q) => q.id === entry.id)) {
    return { statusKey: 'queue',  statusLabel: 'In Queue',  statusTone: 'accent'  };
  }
  if (history.some((h) => h.id === entry.id)) {
    return { statusKey: 'fertig', statusLabel: 'Fertig',    statusTone: 'success' };
  }
  return   { statusKey: 'gone',   statusLabel: 'Entfernt',  statusTone: 'neutral' };
}

function RecentCard({ entry, onOpen, onRemove }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto auto',
        alignItems: 'center',
        gap: 16,
        padding: '14px 18px',
        background: T.bg.surface,
        border: `1px solid ${hover ? T.text.primary : T.border.primary}`,
        borderRadius: T.radius.md,
        cursor: 'pointer',
        transition: 'border-color 150ms',
      }}
    >
      <span style={{
        width: 36, height: 36,
        borderRadius: T.radius.sm,
        background: T.bg.surface3,
        border: `1px solid ${T.border.primary}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: T.text.subtle,
        flexShrink: 0,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 3,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 14,
            fontWeight: 500,
            color: T.text.primary,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 320,
          }}>
            {entry.fbaCode || entry.fileName}
          </span>
          <Badge tone={entry.statusTone}>{entry.statusLabel}</Badge>
        </div>
        <div style={{
          fontSize: 11.5,
          color: T.text.faint,
          fontFamily: T.font.mono,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={entry.fileName}>
          {entry.fileName}
        </div>
      </div>
      <span style={{
        fontSize: 12,
        color: T.text.subtle,
        fontFamily: T.font.mono,
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}>
        {entry.palletCount} · {entry.articleCount}
      </span>
      <span style={{
        fontSize: 11,
        color: T.text.faint,
        fontFamily: T.font.mono,
        fontVariantNumeric: 'tabular-nums',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        flex: '0 0 80px',
        textAlign: 'right',
      }}>
        {formatRelative(entry.ts)}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="Aus Verlauf entfernen"
        style={{
          width: 22, height: 22,
          background: 'transparent',
          border: 0,
          color: hover ? T.text.faint : 'transparent',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          transition: 'color 120ms',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = T.status.danger.main; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = T.text.faint; }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   EDUCATIONAL FOOTER — 3 mini-cards (Prüfen → Focus → Abschluss)
   ════════════════════════════════════════════════════════════════════════ */
function EducationalFooter() {
  return (
    <section>
      <div style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginBottom: 14,
      }}>
        Was passiert als nächstes
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
      }}>
        <EducationCard
          step="01"
          title="Prüfen & Validieren"
          body="Marathon erkennt das Format, prüft Konsistenz, verteilt ESKU-Items mit dem Distributor und zeigt Auslastung pro Palette."
        />
        <EducationCard
          step="02"
          title="Focus-Modus"
          body="Code-für-Code-Loading mit Live-Timing. Keyboard-driven, ohne Maus. Pallet-Übergänge als Szenenwechsel."
        />
        <EducationCard
          step="03"
          title="Abschluss"
          body="Archivieren mit Dauer + Pallet-Zeiten + Artikel-Liste. Alles geht in Historie & Live-Aktivität."
        />
      </div>
    </section>
  );
}

function EducationCard({ step, title, body }) {
  return (
    <div style={{
      padding: '18px 20px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
    }}>
      <div style={{
        fontSize: 10,
        fontFamily: T.font.mono,
        fontWeight: 700,
        color: T.accent.text,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        marginBottom: 8,
      }}>
        {step}
      </div>
      <div style={{
        fontSize: 14,
        fontWeight: 500,
        color: T.text.primary,
        letterSpacing: '-0.01em',
        marginBottom: 6,
      }}>
        {title}
      </div>
      <div style={{
        fontSize: 12.5,
        color: T.text.subtle,
        lineHeight: 1.55,
      }}>
        {body}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   KEYBOARD HINTS
   ════════════════════════════════════════════════════════════════════════ */
function KbdHints() {
  const items = [
    { k: 'O',     v: 'Datei wählen' },
    { k: '⌘V',    v: 'Datei einfügen' },
    { k: 'Esc',   v: 'Stop / leeren' },
    { k: 'g w',   v: 'Warteschlange' },
    { k: 'g h',   v: 'Historie' },
  ];
  return (
    <div style={{
      paddingTop: 20,
      borderTop: `1px solid ${T.border.subtle}`,
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
      fontSize: 11.5,
      color: T.text.faint,
      fontFamily: T.font.mono,
      letterSpacing: '0.04em',
    }}>
      {items.map((it) => (
        <span key={it.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Kbd>{it.k}</Kbd>
          <span>{it.v}</span>
        </span>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ATOMS + helpers
   ════════════════════════════════════════════════════════════════════════ */

function Kbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 22, height: 18,
      padding: '0 6px',
      fontSize: 10.5,
      fontFamily: T.font.mono,
      color: T.text.secondary,
      background: T.bg.surface3,
      border: `1px solid ${T.border.primary}`,
      borderRadius: 3,
      lineHeight: 1,
    }}>
      {children}
    </span>
  );
}

function DropIcon({ accent, size = 28 }: { accent?: boolean; size?: number }) {
  const color = accent ? T.accent.main : T.text.subtle;
  return (
    <span style={{
      width: size + 18,
      height: size + 18,
      borderRadius: 12,
      background: accent ? '#fff' : T.bg.surface3,
      border: `1px solid ${accent ? T.accent.border : T.border.primary}`,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color,
      flexShrink: 0,
      transition: 'all 240ms',
    }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 8l-5-5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 3v12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Spinner({ size = 14, color }) {
  return (
    <span style={{
      width: size, height: size,
      border: `${Math.max(1, Math.round(size / 8))}px solid ${T.border.primary}`,
      borderTopColor: color || T.accent.main,
      borderRadius: '50%',
      display: 'inline-block',
      animation: 'mp-up-spin 600ms linear infinite',
      flexShrink: 0,
    }}>
      <style>{`
        @keyframes mp-up-spin { to { transform: rotate(360deg); } }
        @keyframes mp-up-fade { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </span>
  );
}

const primaryButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 14px',
  fontSize: 12.5,
  fontWeight: 500,
  color: '#fff',
  background: T.accent.main,
  border: 0,
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: T.font.ui,
  transition: 'background 160ms',
};

const ghostButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 14px',
  fontSize: 12.5,
  fontWeight: 500,
  color: T.text.secondary,
  background: T.bg.surface,
  border: `1px solid ${T.border.strong}`,
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: T.font.ui,
  transition: 'all 160ms',
};

const inlineCodeStyle = {
  fontFamily: T.font.mono,
  fontSize: 13.5,
  padding: '1px 6px',
  background: T.bg.surface3,
  border: `1px solid ${T.border.primary}`,
  borderRadius: 4,
  color: T.text.secondary,
};

/* ─── Duplicate detection ───────────────────────────────────────── */
function buildDupIndex(queue, recent) {
  const byFile = new Map();
  for (const q of queue) {
    if (q.fileName) byFile.set(q.fileName.toLowerCase(), { where: 'in Warteschlange', relative: '' });
  }
  for (const r of recent) {
    if (r.fileName) {
      const existing = byFile.get(r.fileName.toLowerCase());
      if (!existing) {
        byFile.set(r.fileName.toLowerCase(), {
          where: 'zuletzt geladen',
          relative: r.ts ? formatRelative(r.ts) : '',
        });
      }
    }
  }
  return { byFile };
}

/* ─── Date helpers ──────────────────────────────────────────────── */
function formatRelative(ts) {
  if (!ts) return '—';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60)   return 'jetzt';
  const min = Math.floor(diffSec / 60);
  if (min < 60)       return `vor ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24)         return `vor ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7)          return `vor ${d} T`;
  return new Date(ts).toLocaleDateString('de-DE');
}

function formatMin(sec) {
  if (sec === 0) return '0m';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

/* ════════════════════════════════════════════════════════════════════════
   BETA UPLOAD VIEW — minimalist centered drop-zone card with state-machine
   inner body, plus optional floating queue pill. Matches the FlowHero /
   BetaIslandBar / BetaInterlude / BetaFinale / BetaAbschluss vocabulary:
   paper #F4F5F7 outer card + 2px white rim + halo + nested white panel
   + accent action pill.
   ════════════════════════════════════════════════════════════════════════ */
function BetaUploadView({
  queue, isOffline, over, globalOver, busy, batch,
  singleSuccess, showBatchSummary, parseError, countdown, duplicateConfirm,
  lastSuccess, inputRef, acceptFiles,
  onPick, onDragOverChange,
  onCancelCountdown, onStartNow, onAttachInstead, onClearError,
  onConfirmDupes, onCancelDupes,
  onStartFromBatch, onAllToQueue, onCloseBatchSummary,
  onOpenQueue,
}) {
  /* State-machine resolver — single in-place body per render. Ordering
     mirrors HeroDropZone's classic precedence. */
  const state: 'countdown' | 'duplicate' | 'error' | 'parsing' | 'success-multi' | 'drag-over' | 'idle' = (() => {
    if (countdown)         return 'countdown';
    if (duplicateConfirm)  return 'duplicate';
    if (parseError)        return 'error';
    if (busy)              return 'parsing';
    if (showBatchSummary)  return 'success-multi';
    if (over || globalOver) return 'drag-over';
    return 'idle';
  })();

  /* Inner panel inset-ring colour per state — replaces the classic
     border palette while keeping the white panel surface clean. */
  const ringColor = (() => {
    if (state === 'error' || isOffline) return T.status.danger.main;
    if (state === 'duplicate')          return T.status.warn.main;
    if (state === 'drag-over')          return 'var(--accent)';
    return null;
  })();

  const isClickable = state === 'idle' || state === 'drag-over';

  return (
    <Page>
      <main style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: '32px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        minHeight: '100vh',
        justifyContent: 'center',
        alignItems: 'stretch',
        fontFamily: T.font.ui,
      }}>
        <div
          onClick={() => { if (isClickable) onPick(); }}
          onDragOver={(e) => { e.preventDefault(); onDragOverChange(true); }}
          onDragLeave={() => onDragOverChange(false)}
          onDrop={(e) => {
            e.preventDefault();
            onDragOverChange(false);
            acceptFiles(e.dataTransfer.files);
          }}
          style={{
            padding: 8,
            background: '#F4F5F7',
            border: '2px solid #FFFFFF',
            borderRadius: 32,
            boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            cursor: isClickable ? 'pointer' : 'default',
            transition: 'transform 240ms cubic-bezier(0.16, 1, 0.3, 1)',
            transform: state === 'drag-over' ? 'scale(1.005)' : 'scale(1)',
          }}
        >
          <div style={{
            position: 'relative',
            background: state === 'drag-over' ? T.accent.bg : '#FFFFFF',
            borderRadius: 24,
            padding: '96px 64px',
            boxShadow: ringColor
              ? `inset 0 0 0 2px ${ringColor}`
              : state === 'idle'
                ? 'inset 0 0 0 1px rgba(15, 23, 42, 0.04), 0 1px 2px rgba(15, 23, 42, 0.02)'
                : 'none',
            backgroundImage: state === 'idle'
              ? 'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(99, 102, 241, 0.04), transparent 70%)'
              : 'none',
            transition: 'background 240ms ease, box-shadow 240ms ease',
            minHeight: 460,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            overflow: 'hidden',
          }}>
            <BetaUploadBody
              state={state}
              isOffline={isOffline}
              batch={batch}
              singleSuccess={singleSuccess}
              parseError={parseError}
              countdown={countdown}
              duplicateConfirm={duplicateConfirm}
              lastSuccess={lastSuccess}
              onPick={onPick}
              onCancelCountdown={onCancelCountdown}
              onStartNow={onStartNow}
              onAttachInstead={onAttachInstead}
              onClearError={onClearError}
              onConfirmDupes={onConfirmDupes}
              onCancelDupes={onCancelDupes}
              onStartFromBatch={onStartFromBatch}
              onAllToQueue={onAllToQueue}
              onCloseBatchSummary={onCloseBatchSummary}
            />
          </div>
        </div>
      </main>

      {queue.length > 0 && (
        <BetaQueuePill count={queue.length} onOpen={onOpenQueue} />
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".docx"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { acceptFiles(e.target.files); e.target.value = ''; }}
      />
    </Page>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Body switcher — picks the right inner content per state.
   ────────────────────────────────────────────────────────────────────── */
function BetaUploadBody({
  state, isOffline, batch, singleSuccess, parseError, countdown,
  duplicateConfirm, lastSuccess,
  onPick, onCancelCountdown, onStartNow, onAttachInstead, onClearError,
  onConfirmDupes, onCancelDupes,
  onStartFromBatch, onAllToQueue, onCloseBatchSummary,
}) {
  if (state === 'countdown') {
    return (
      <BetaCountdownBody
        countdown={countdown}
        lastSuccess={lastSuccess}
        onCancel={onCancelCountdown}
        onStartNow={onStartNow}
      />
    );
  }
  if (state === 'duplicate') {
    return (
      <BetaDuplicateBody
        dupes={duplicateConfirm?.dupes || []}
        onConfirm={onConfirmDupes}
        onCancel={onCancelDupes}
      />
    );
  }
  if (state === 'error') {
    return (
      <BetaErrorBody
        message={parseError}
        onRetry={() => { onClearError(); onPick(); }}
      />
    );
  }
  if (state === 'parsing') {
    return <BetaParsingBody batch={batch} />;
  }
  if (state === 'success-multi') {
    return (
      <BetaSuccessMultiBody
        batch={batch}
        onStartFromBatch={onStartFromBatch}
        onAllToQueue={onAllToQueue}
        onClose={onCloseBatchSummary}
      />
    );
  }
  if (state === 'drag-over') {
    return <BetaIdleBody dragging onPick={onPick} isOffline={isOffline} />;
  }
  return <BetaIdleBody onPick={onPick} isOffline={isOffline} />;
}

/* ── IDLE / DRAG-OVER body ──────────────────────────────────────────── */
function BetaIdleBody({ onPick, isOffline, dragging = false }: { onPick: () => void; isOffline: boolean; dragging?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 14,
      textAlign: 'center',
    }}>
      {/* File-type chip — gives the form a clear identity */}
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 11px 5px 9px',
        background: '#F4F5F7',
        border: '1px solid rgba(15, 23, 42, 0.06)',
        borderRadius: 999,
        fontFamily: T.font.mono,
        fontSize: 10.5,
        fontWeight: 600,
        color: T.text.subtle,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
      }}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M3 1.5h4l2 2V10a.5.5 0 01-.5.5h-5.5A.5.5 0 012.5 10V2a.5.5 0 01.5-.5z"
                stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M7 1.5V4h2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        Lagerauftrag · .docx
      </span>

      <h1 style={{
        margin: 0,
        fontSize: 'clamp(26px, 3vw, 34px)',
        fontWeight: 600,
        letterSpacing: '-0.022em',
        lineHeight: 1.1,
        color: T.text.primary,
      }}>
        {dragging ? 'Loslassen, um zu laden' : 'Lagerauftrag ablegen'}
      </h1>
      <p style={{
        margin: 0,
        fontSize: 13.5,
        color: T.text.subtle,
        maxWidth: 420,
        lineHeight: 1.5,
      }}>
        {isOffline
          ? 'Server offline — Backend nicht erreichbar.'
          : 'Datei hierher ziehen oder über die Schaltfläche auswählen.'}
      </p>
      {!isOffline && (
        <div style={{
          marginTop: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPick(); }}
            style={betaAiryPickStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'none';
            }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path d="M7 9.5V2.5M7 2.5L4.25 5.25M7 2.5l2.75 2.75"
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 9.5v1.25c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9.5"
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Datei wählen
          </button>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 10.5,
            fontWeight: 600,
            color: T.text.faint,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}>
            oder Strg + V einfügen
          </span>
        </div>
      )}
    </div>
  );
}

const betaAiryPickStyle: React.CSSProperties = {
  all: 'unset',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 22px',
  background: '#FFFFFF',
  color: T.text.primary,
  border: '1px solid rgba(15, 23, 42, 0.08)',
  borderRadius: 999,
  fontFamily: T.font.ui,
  fontSize: 13.5,
  fontWeight: 600,
  letterSpacing: '-0.005em',
  cursor: 'pointer',
  transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
};

/* ── PARSING body ───────────────────────────────────────────────────── */
function BetaParsingBody({ batch }) {
  const total = batch.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <BetaEyebrow icon={<BetaSpinnerIcon />}>
        Parst {total} {total === 1 ? 'Datei' : 'Dateien'}
      </BetaEyebrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {batch.map((row, i) => <BetaBatchRow key={i} row={row} />)}
      </div>
    </div>
  );
}

/* ── SUCCESS-SINGLE body ────────────────────────────────────────────── */
function BetaSuccessSingleBody({ row, onStart, onAttach }) {
  const entry = row?.entry;
  const meta: Record<string, unknown> = entry?.parsed?.meta || {};
  const fba = (meta.sendungsnummer as string | undefined)
    || (meta.fbaCode as string | undefined)
    || row?.fba
    || entry?.fileName
    || '—';
  const destination = (meta.destination as string | undefined) || '';
  const format = (meta.format as string | undefined) || (entry?.parsed?.format as string | undefined) || '';
  const palletCount = row?.palletCount ?? 0;
  const articleCount = row?.articleCount ?? 0;
  const validation = (row?.validation as { warnings?: unknown[]; errors?: unknown[] } | null) || null;
  const warnings = (validation?.warnings as unknown[] | undefined) || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <BetaEyebrow color={T.status.success.text} icon={<BetaCheckIcon />}>
        Geladen
      </BetaEyebrow>

      <BetaBigCopy value={fba} rawValue={String(fba)} ariaLabel="FBA-Code" />

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        fontFamily: T.font.mono,
        fontSize: 11.5,
        fontWeight: 600,
        color: T.text.subtle,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
      }}>
        {destination && (
          <>
            <span style={{ color: T.text.faint }}>Ziel</span>
            <span style={{ color: T.text.primary }}>{destination}</span>
            <BetaMetaDot />
          </>
        )}
        {format && (
          <>
            <span>{format}</span>
            <BetaMetaDot />
          </>
        )}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {palletCount} Pal · {articleCount} Art
        </span>
      </div>

      {warnings.length > 0 && (
        <details style={{
          background: T.bg.surface2,
          borderRadius: 12,
          padding: '10px 14px',
        }}>
          <summary style={{
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            color: T.status.warn.text,
            fontFamily: T.font.mono,
            letterSpacing: '0.05em',
          }}>
            {warnings.length} Warnung{warnings.length === 1 ? '' : 'en'}
          </summary>
          <ul style={{
            margin: '10px 0 0',
            paddingLeft: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: 12.5,
            color: T.text.subtle,
          }}>
            {(warnings as Array<{ message?: string }>).slice(0, 8).map((w, i) => (
              <li key={i}>{w?.message || String(w)}</li>
            ))}
          </ul>
        </details>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        marginTop: 4,
      }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onStart(); }}
          style={betaAccentPillStyle}
          onMouseEnter={betaAccentPillHover}
          onMouseLeave={betaAccentPillLeave}
        >
          Jetzt starten
          <BetaKbd>Space</BetaKbd>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAttach(); }}
          style={betaGhostLinkStyle}
        >
          In Warteschlange
        </button>
      </div>
    </div>
  );
}

/* ── SUCCESS-MULTI body ─────────────────────────────────────────────── */
function BetaSuccessMultiBody({ batch, onStartFromBatch, onAllToQueue, onClose }) {
  const successes = batch.filter((b) => b.stage === 'done');
  const errors    = batch.filter((b) => b.stage === 'error');
  const firstReadyId = successes[0]?.entry?.id;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <BetaEyebrow color={T.status.success.text} icon={<BetaCheckIcon />}>
          {successes.length} Geladen{errors.length > 0 ? ` · ${errors.length} Fehler` : ''}
        </BetaEyebrow>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Schließen"
          style={betaSmallCloseStyle}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
               stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {batch.map((row, i) => <BetaBatchRow key={i} row={row} />)}
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        marginTop: 4,
      }}>
        {firstReadyId && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStartFromBatch(firstReadyId); }}
            style={betaAccentPillStyle}
            onMouseEnter={betaAccentPillHover}
            onMouseLeave={betaAccentPillLeave}
          >
            Ersten starten
            <BetaKbd>Space</BetaKbd>
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAllToQueue(); }}
          style={betaGhostLinkStyle}
        >
          Alle in Warteschlange
        </button>
      </div>
    </div>
  );
}

/* ── ERROR body ─────────────────────────────────────────────────────── */
function BetaErrorBody({ message, onRetry }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 14,
      textAlign: 'center',
    }}>
      <span aria-hidden style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 56, height: 56,
        borderRadius: '50%',
        background: T.status.danger.bg,
        color: T.status.danger.main,
      }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 7v6M12 17h.01" />
          <circle cx="12" cy="12" r="9.5" />
        </svg>
      </span>
      <BetaEyebrow color={T.status.danger.text}>Fehler</BetaEyebrow>
      <p style={{
        margin: 0,
        fontSize: 14,
        color: T.text.primary,
        maxWidth: 440,
      }}>
        {message || 'Etwas ist schiefgelaufen.'}
      </p>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRetry(); }}
        style={betaAccentPillStyle}
        onMouseEnter={betaAccentPillHover}
        onMouseLeave={betaAccentPillLeave}
      >
        Andere Datei wählen
      </button>
    </div>
  );
}

/* ── DUPLICATE body ─────────────────────────────────────────────────── */
function BetaDuplicateBody({ dupes, onConfirm, onCancel }) {
  const labels = (dupes || []).map((d: { hit?: { entry?: { fbaCode?: string; fileName?: string } }; file?: File }) => {
    return d.hit?.entry?.fbaCode || d.hit?.entry?.fileName || d.file?.name || '—';
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <BetaEyebrow color={T.status.warn.text}>Schon vorhanden</BetaEyebrow>
      <p style={{
        margin: 0,
        fontSize: 13,
        color: T.text.subtle,
        maxWidth: 480,
      }}>
        {dupes.length === 1
          ? '1 Datei ist bereits in der Warteschlange oder Historie:'
          : `${dupes.length} Dateien sind bereits in der Warteschlange oder Historie:`}
      </p>
      <ul style={{
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {labels.slice(0, 4).map((label, i) => (
          <li key={i} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: T.bg.surface2,
            borderRadius: 12,
            fontFamily: T.font.mono,
            fontSize: 12.5,
            color: T.text.primary,
            letterSpacing: '0.02em',
          }}>
            <span aria-hidden style={{
              width: 6, height: 6,
              borderRadius: '50%',
              background: T.status.warn.main,
            }} />
            {label}
          </li>
        ))}
        {labels.length > 4 && (
          <li style={{
            padding: '6px 12px',
            fontSize: 12,
            color: T.text.faint,
            fontFamily: T.font.mono,
            letterSpacing: '0.02em',
          }}>
            + {labels.length - 4} weitere
          </li>
        )}
      </ul>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        marginTop: 4,
      }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onConfirm(); }}
          style={betaAccentPillStyle}
          onMouseEnter={betaAccentPillHover}
          onMouseLeave={betaAccentPillLeave}
        >
          Trotzdem laden
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          style={betaGhostLinkStyle}
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}

/* ── COUNTDOWN body ─────────────────────────────────────────────────── */
function BetaCountdownBody({ countdown, lastSuccess, onCancel, onStartNow }) {
  const entry = lastSuccess;
  const meta: Record<string, unknown> = entry?.parsed?.meta || {};
  const fba = (meta.sendungsnummer as string | undefined)
    || (meta.fbaCode as string | undefined)
    || entry?.fileName
    || '—';
  const pct = ((COUNTDOWN_SEC - countdown.remaining) / COUNTDOWN_SEC) * 100;
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 16,
      textAlign: 'center',
    }}>
      <BetaEyebrow color={T.status.success.text} icon={<BetaCheckIcon />}>
        Geladen
      </BetaEyebrow>
      <BetaBigCopy value={fba} rawValue={String(fba)} ariaLabel="FBA-Code" />
      <p style={{
        margin: 0,
        fontSize: 13,
        color: T.text.subtle,
      }}>
        Auto-Start in {countdown.remaining}s · Esc zum Abbrechen
      </p>
      <div style={{
        width: '100%',
        maxWidth: 360,
        height: 4,
        background: T.border.subtle,
        borderRadius: 999,
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: 'var(--accent)',
          transition: 'width 1000ms linear',
        }} />
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        marginTop: 4,
      }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onStartNow(); }}
          style={betaAccentPillStyle}
          onMouseEnter={betaAccentPillHover}
          onMouseLeave={betaAccentPillLeave}
        >
          Sofort starten
          <BetaKbd>Space</BetaKbd>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          style={betaGhostLinkStyle}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

/* ── Floating queue pill (bottom-center) ────────────────────────────── */
function BetaQueuePill({ count, onOpen }) {
  return (
    <div style={{
      position: 'fixed',
      bottom: 18,
      left: '50%',
      transform: 'translateX(-50%)',
      marginLeft: 'calc(var(--sidebar-width) / 2)',
      zIndex: 50,
      background: '#F8F8F8',
      border: '2px solid #FFFFFF',
      borderRadius: 50,
      boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
      padding: '6px 6px 6px 22px',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 18,
      whiteSpace: 'nowrap',
    }}>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: T.font.mono,
        fontSize: 11.5,
        fontWeight: 600,
        color: T.text.subtle,
        letterSpacing: '0.04em',
      }}>
        <span aria-hidden style={{
          width: 6, height: 6,
          borderRadius: '50%',
          background: T.accent.main,
          boxShadow: `0 0 0 3px ${T.accent.main}22`,
        }} />
        <span>
          <span style={{
            color: T.text.primary,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {count}
          </span>{' '}
          in Warteschlange
        </span>
      </span>
      <button
        type="button"
        onClick={onOpen}
        style={betaAccentPillStyle}
        onMouseEnter={betaAccentPillHover}
        onMouseLeave={betaAccentPillLeave}
      >
        Öffnen
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Beta atoms — local to Upload.tsx, mirror the pattern established in
   Abschluss.tsx so the family vocabulary stays consistent.
   ────────────────────────────────────────────────────────────────────── */

function BetaEyebrow({ children, color, icon }: { children?: React.ReactNode; color?: string; icon?: React.ReactNode }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10.5,
      fontWeight: 700,
      fontFamily: T.font.mono,
      color: color || T.text.faint,
      textTransform: 'uppercase',
      letterSpacing: '0.18em',
    }}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

function BetaCheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2.5 6.5l2 2 5-5.5" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BetaSpinnerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
         style={{ animation: 'mr-spin 600ms linear infinite' }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" />
    </svg>
  );
}

function BetaMetaDot() {
  return (
    <span aria-hidden style={{
      width: 3, height: 3, borderRadius: '50%',
      background: 'rgba(15, 23, 42, 0.22)',
      flexShrink: 0,
    }} />
  );
}

function BetaDropIcon({ size = 56, color = T.text.faint }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none"
         stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="14" y="10" width="36" height="44" rx="4" />
      <path d="M22 22h20M22 30h20M22 38h12" />
      <path d="M32 50v8M28 54l4 4 4-4" stroke={color} />
    </svg>
  );
}

function BetaKbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 28, height: 20,
      padding: '0 7px',
      fontSize: 10.5,
      fontFamily: T.font.mono,
      fontWeight: 700,
      color: '#FFFFFF',
      background: 'rgba(255, 255, 255, 0.22)',
      borderRadius: 6,
      lineHeight: 1,
      letterSpacing: '0.04em',
    }}>{children}</span>
  );
}

/* Big mono FBA-code click-to-copy — mirrors the BetaBigCopy in
   Abschluss.tsx; duplicated locally to keep Upload.tsx self-contained. */
function BetaBigCopy({ value, rawValue, ariaLabel }: { value: React.ReactNode; rawValue: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = (e) => {
    e.stopPropagation();
    copyToClipboard(rawValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { onClick(e); e.currentTarget.blur(); }}
      title={copied ? 'Kopiert' : 'Klick zum Kopieren'}
      aria-label={ariaLabel}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 12px',
        marginLeft: -12,
        background: copied ? T.status.success.bg : 'transparent',
        borderRadius: 14,
        transition: 'background 220ms ease',
      }}
    >
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 'clamp(28px, 3.6vw, 40px)',
        fontWeight: 600,
        color: copied ? T.status.success.text : T.text.primary,
        letterSpacing: '-0.025em',
        lineHeight: 1.05,
        wordBreak: 'break-all',
        transition: 'color 220ms ease',
      }}>
        {value}
      </span>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 10,
        fontWeight: 600,
        color: copied ? T.status.success.text : T.text.faint,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
      }}>
        {copied ? '✓ Kopiert' : 'Klick zum Kopieren'}
      </span>
    </button>
  );
}

/* Per-file inline row used in PARSING + SUCCESS-MULTI states. */
function BetaBatchRow({ row }) {
  const stage = row?.stage || 'pending';
  const isDone   = stage === 'done';
  const isError  = stage === 'error';
  const isActive = stage === 'parsing';
  const iconColor = isError ? T.status.danger.main
                   : isDone  ? T.status.success.main
                             : T.accent.main;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '24px 1fr auto auto',
      alignItems: 'center',
      gap: 12,
      padding: '10px 14px',
      background: T.bg.surface2,
      borderRadius: 14,
    }}>
      <span aria-hidden style={{
        width: 24, height: 24,
        borderRadius: '50%',
        background: isDone ? T.status.success.bg : (isError ? T.status.danger.bg : T.accent.bg),
        color: iconColor,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        {isActive ? (
          <BetaSpinnerIcon />
        ) : isDone ? (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.5l2 2 5-5.5" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : isError ? (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
               stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        ) : (
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
        )}
      </span>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        gap: 2,
      }}>
        <span style={{
          fontSize: 13,
          fontWeight: 500,
          color: T.text.primary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          letterSpacing: '-0.005em',
        }}>
          {row.fba || row.name}
        </span>
        {isError && row.error && (
          <span style={{
            fontSize: 11.5,
            color: T.status.danger.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {row.error}
          </span>
        )}
        {!isError && row.fba && (
          <span style={{
            fontSize: 11.5,
            color: T.text.faint,
            fontFamily: T.font.mono,
            letterSpacing: '0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {row.name}
          </span>
        )}
      </div>
      {!isError && row.palletCount > 0 && (
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11.5,
          fontWeight: 600,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}>
          {row.palletCount} Pal
        </span>
      )}
      {!isError && row.articleCount > 0 && (
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11.5,
          fontWeight: 600,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}>
          {row.articleCount} Art
        </span>
      )}
    </div>
  );
}

/* ── shared style objects (avoid re-declaring per component) ────────── */
const betaAccentPillStyle: React.CSSProperties = {
  all: 'unset',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  padding: '11px 22px',
  background: 'var(--accent)',
  color: '#FFFFFF',
  borderRadius: 999,
  fontFamily: T.font.ui,
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: '-0.005em',
  cursor: 'pointer',
  transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1), filter 200ms ease',
};

function betaAccentPillHover(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.transform = 'translateY(-1px)';
  e.currentTarget.style.filter = 'brightness(1.05)';
}

function betaAccentPillLeave(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.transform = 'none';
  e.currentTarget.style.filter = 'none';
}

const betaGhostLinkStyle: React.CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontFamily: T.font.ui,
  fontSize: 13,
  fontWeight: 500,
  color: T.text.subtle,
  letterSpacing: '-0.005em',
  padding: '4px 8px',
};

const betaSmallCloseStyle: React.CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  width: 22, height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  color: T.text.faint,
  transition: 'background 200ms ease, color 200ms ease',
};

/* ── clipboard helper — copy-paste from Abschluss for self-containment */
function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackBetaCopy(text));
    return;
  }
  fallbackBetaCopy(text);
}
function fallbackBetaCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    /* ignore */
  }
}