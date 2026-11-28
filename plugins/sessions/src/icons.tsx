/** The Session rows' and the Workspace picker's glyphs, drawn after deepseek-harness's
 * ui-primitives artwork (MIT): outline icons on a 16px grid with a one-pixel stroke, coloured by
 * `currentColor`. */
export function EllipsisIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="3" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="13" cy="8" r="1" fill="currentColor" />
  </svg>;
}

/** A filled pushpin, the trailing marker of a pinned row. */
export function PinIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z" fill="currentColor" stroke="currentColor" strokeLinejoin="round" />
    <path d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z" fill="currentColor" />
  </svg>;
}

export function FolderCloseIcon({ size = 16, className }: { size?: number; className?: string | undefined }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path vectorEffect="non-scaling-stroke" d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" stroke="currentColor" />
    <path vectorEffect="non-scaling-stroke" d="M3.63501 7.66614H12.3647" stroke="currentColor" />
  </svg>;
}

export function CheckIcon({ size = 14, className }: { size?: number; className?: string | undefined }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path vectorEffect="non-scaling-stroke" d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" />
  </svg>;
}

export function PlusIcon({ size = 14, className }: { size?: number; className?: string | undefined }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path vectorEffect="non-scaling-stroke" d="M8 2V14" stroke="currentColor" /><path vectorEffect="non-scaling-stroke" d="M2 8H14" stroke="currentColor" />
  </svg>;
}
