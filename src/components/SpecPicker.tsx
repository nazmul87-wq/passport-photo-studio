import { useState } from 'react'
import { Check, ChevronsUpDown, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SPEC_REGISTRY, specSearchText, specSizeLabel, type PhotoSpec } from '@/core/specs'
import { cn } from '@/lib/utils'

interface SpecPickerProps {
  value: PhotoSpec
  onChange: (id: string) => void
}

/**
 * Searchable country/document picker.
 *
 * A plain <select> stops working somewhere around a dozen entries; with thirty
 * countries the user needs to type "india" or "green card" and get there. The
 * search haystack deliberately includes document names and the physical size,
 * so someone who only knows they need "35x45" can find it too.
 */
export function SpecPicker({ value, onChange }: SpecPickerProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between px-3 font-normal"
        >
          <span className="min-w-0 truncate text-left">
            <span className="font-medium">{value.country}</span>
            <span className="ml-1.5 text-muted-foreground">{specSizeLabel(value)}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[min(28rem,calc(100vw-2rem))] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            const spec = SPEC_REGISTRY.find((s) => s.id === itemValue)
            if (!spec) return 0
            return specSearchText(spec).includes(search.toLowerCase()) ? 1 : 0
          }}
        >
          <CommandInput placeholder="Search country, document or size…" />
          <CommandList>
            <CommandEmpty>No matching document type.</CommandEmpty>
            <CommandGroup>
              {SPEC_REGISTRY.map((spec) => (
                <CommandItem
                  key={spec.id}
                  value={spec.id}
                  onSelect={(id) => {
                    onChange(id)
                    setOpen(false)
                  }}
                  className="items-start gap-2"
                >
                  <Check
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      spec.id === value.id ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{spec.country}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {specSizeLabel(spec)}
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {spec.documents.join(' · ')}
                    </p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Provenance line for the selected spec. Official requirements change, so the
 * app states where its numbers came from and when they were last checked
 * rather than implying certified compliance.
 */
export function SpecSource({ spec }: { spec: PhotoSpec }) {
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      Requirements from{' '}
      <a
        href={spec.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
      >
        the issuing authority
        <ExternalLink className="size-3" aria-hidden />
      </a>
      , checked {spec.lastVerified}. Rules change — confirm against the official page before
      you submit.
    </p>
  )
}
