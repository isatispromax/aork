/** The Workspace browser's glyphs, drawn after deepseek-harness's ui-primitives artwork (MIT):
 * outline icons on a 16px grid with a one-pixel stroke, coloured by `currentColor`. */

interface IconProps { size?: number; className?: string | undefined }

const stroke = { vectorEffect: 'non-scaling-stroke' } as const;

export function FolderCloseIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path {...stroke} d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" stroke="currentColor" />
    <path {...stroke} d="M3.63501 7.66614H12.3647" stroke="currentColor" />
  </svg>;
}

export function FolderOpenIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z" fill="currentColor" opacity="0.16" />
    <path d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z" fill="currentColor" />
    <path d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z" fill="currentColor" />
  </svg>;
}

/** The disclosure triangle: pointing right while closed, rotated to point down while open. */
export function TriangleRightIcon({ size = 14, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z" fill="currentColor" />
  </svg>;
}

/** A speech bubble with a plus: start a Session here. */
export function NewChatIcon({ size = 14, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path {...stroke} d="M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337" stroke="currentColor" />
    <path {...stroke} d="M8 5V11" stroke="currentColor" /><path {...stroke} d="M5 8H11" stroke="currentColor" />
  </svg>;
}

export function SearchIcon({ size = 14, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path {...stroke} d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor" />
    <path {...stroke} d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" />
  </svg>;
}

/** Two sliders: the view-options menu. */
export function SlidersIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path {...stroke} d="M1.5 5H8.5M11.5 5H14.5M1.5 11H4.5M7.5 11H14.5" stroke="currentColor" />
    <circle {...stroke} cx="10" cy="5" r="1.5" stroke="currentColor" /><circle {...stroke} cx="6" cy="11" r="1.5" stroke="currentColor" />
  </svg>;
}

/** A folder with a plus: add a Workspace. */
export function ProjectAddIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path d="M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z" fill="currentColor" />
    <path {...stroke} d="M9.75977 4.50208H14.5509" stroke="currentColor" /><path {...stroke} d="M12.1492 6.89758L12.1492 2.10642" stroke="currentColor" />
  </svg>;
}

export function FlatListIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={1} aria-hidden="true">
    <path d="M6 3.5h7.5M6 8h7.5M6 12.5h7.5" /><path d="M2.6 3.5h.01M2.6 8h.01M2.6 12.5h.01" />
  </svg>;
}

export function WorkspaceTreeIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} aria-hidden="true">
    <path d="M14 12.05c0 .8-.65 1.45-1.46 1.45H3.46C2.65 13.5 2 12.85 2 12.05v-8.1c0-.8.65-1.45 1.46-1.45h2.4c.49 0 .94.24 1.21.65l.5.73c.27.4.73.65 1.21.65h3.76c.8 0 1.46.65 1.46 1.45v6.02Z" />
    <path d="M8.7 8.1v3M11.2 8.1v3" />
  </svg>;
}

export function ChevronsUpDownIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} aria-hidden="true">
    <path d="m5.1 6 2.9-2.9L10.9 6" /><path d="m5.1 10 2.9 2.9 2.9-2.9" />
  </svg>;
}

export function ClockIcon({ size = 16, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <circle {...stroke} cx="8" cy="8" r="6.5" stroke="currentColor" /><path {...stroke} d="M8 4V8.5L11 10" stroke="currentColor" />
  </svg>;
}

export function QueueIcon({ size = 24, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path {...stroke} d="M5 6.75H11" stroke="currentColor" /><path {...stroke} d="M5 9H8" stroke="currentColor" />
    <path {...stroke} d="M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334" stroke="currentColor" />
  </svg>;
}

export function EllipsisIcon({ size = 14, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="3" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="13" cy="8" r="1" fill="currentColor" />
  </svg>;
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <path {...stroke} d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" />
  </svg>;
}

export function CloseIcon({ size = 14, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.8 3.8L12.2 12.2M12.2 3.8L3.8 12.2" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
  </svg>;
}

export function CopyIcon({ size = 14, className }: IconProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">
    <rect {...stroke} x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" />
    <path {...stroke} d="M10.5 3.5V3.5C10.5 2.67 9.83 2 9 2H4C3.17 2 2.5 2.67 2.5 3.5V8.5C2.5 9.33 3.17 10 4 10" stroke="currentColor" />
  </svg>;
}
