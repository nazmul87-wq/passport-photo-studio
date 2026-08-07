import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, Wand2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Finding, Severity } from '@/core/validate'
import { overallSeverity } from '@/core/validate'
import { cn } from '@/lib/utils'

interface CompliancePanelProps {
  findings: Finding[]
  onApplyFix: (finding: Finding) => void
  /** True while the background is still being sampled after a change. */
  pending?: boolean
}

const ICONS: Record<Severity, typeof Check> = {
  pass: Check,
  warn: AlertTriangle,
  fail: X,
}

/**
 * Severity stays carried by three independent channels — icon shape, wording,
 * and hue — so it survives both colour blindness and a greyscale print. The
 * text colours are the measured, text-safe tokens; the washes and edges are
 * separate tokens precisely so the tint can be soft without dragging the
 * label's contrast down with it.
 */
const TONE: Record<Severity, string> = {
  pass: 'text-pass',
  warn: 'text-warn',
  fail: 'text-fail',
}

const CHIP: Record<Severity, string> = {
  pass: 'border-pass-edge bg-pass-wash text-pass',
  warn: 'border-warn-edge bg-warn-wash text-warn',
  fail: 'border-fail-edge bg-fail-wash text-fail',
}

const SUMMARY: Record<Severity, string> = {
  pass: 'Meets every check',
  warn: 'Usable, with cautions',
  fail: 'Needs attention',
}

export function CompliancePanel({ findings, onApplyFix, pending }: CompliancePanelProps) {
  const overall = overallSeverity(findings)
  const failures = findings.filter((f) => f.severity === 'fail').length
  const warnings = findings.filter((f) => f.severity === 'warn').length
  const Verdict = ICONS[overall]

  const counts =
    failures > 0 || warnings > 0
      ? [
          failures > 0 && `${failures} to fix`,
          warnings > 0 && `${warnings} caution${warnings > 1 ? 's' : ''}`,
        ]
          .filter(Boolean)
          .join(', ')
      : null

  return (
    <section aria-labelledby="compliance-heading" className="space-y-2.5">
      <ComplianceAnnouncer summary={SUMMARY[overall]} counts={counts} pending={pending} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="compliance-heading" className="eyebrow">
          Compliance
        </h2>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
            CHIP[overall],
          )}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Verdict className="size-3.5" aria-hidden />
          )}
          {SUMMARY[overall]}
          {counts && <span className="font-normal opacity-80">· {counts}</span>}
        </span>
      </div>

      <ul className="space-y-1.5">
        {findings.map((finding) => {
          const Icon = ICONS[finding.severity]
          const isPass = finding.severity === 'pass'
          return (
            <li
              key={finding.id}
              className={cn(
                'rounded-xl px-3 py-2.5',
                isPass && 'px-3 py-1.5',
                finding.severity === 'fail' && 'glass-card border-fail-edge bg-fail-wash',
                finding.severity === 'warn' && 'glass-card border-warn-edge bg-warn-wash',
              )}
            >
              <div className="flex items-start gap-2.5">
                <Icon
                  className={cn('mt-px size-3.5 shrink-0', TONE[finding.severity])}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-xs leading-snug font-semibold',
                      isPass && 'font-normal text-muted-foreground',
                    )}
                  >
                    <span className="sr-only">
                      {finding.severity === 'pass'
                        ? 'Passed: '
                        : finding.severity === 'warn'
                          ? 'Caution: '
                          : 'Problem: '}
                    </span>
                    {finding.title}
                  </p>
                  {/* Passing checks stay one quiet line. Spelling out why
                      everything is fine would bury the one row that isn't. */}
                  {!isPass && (
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {finding.detail}
                    </p>
                  )}
                </div>
              </div>

              {finding.fix && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2.5 h-8 w-full text-xs"
                  onClick={() => onApplyFix(finding)}
                >
                  <Wand2 className="size-3.5" aria-hidden />
                  {finding.fix.label}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Announces the verdict, not the list.
 *
 * Compliance is recomputed on every pointer move of a drag, so announcing it
 * live and unfiltered would turn a screen reader into a stream of noise. The
 * settled verdict is what a user needs to hear, so this waits for the numbers
 * to stop moving and for the background sampler to finish, then says one
 * sentence. Identical sentences are never re-announced, because React leaves
 * unchanged text nodes alone.
 */
function ComplianceAnnouncer({
  summary,
  counts,
  pending,
}: {
  summary: string
  counts: string | null
  pending?: boolean
}) {
  const [settled, setSettled] = useState('')
  const message = counts ? `Compliance: ${summary} — ${counts}.` : `Compliance: ${summary}.`

  useEffect(() => {
    if (pending) return
    const timer = window.setTimeout(() => setSettled(message), 700)
    return () => window.clearTimeout(timer)
  }, [message, pending])

  return (
    <p role="status" aria-live="polite" className="sr-only">
      {settled}
    </p>
  )
}
