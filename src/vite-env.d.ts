/// <reference types="vite/client" />

declare module 'lucide-react' {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from 'react';

  export interface LucideProps extends SVGProps<SVGSVGElement> {
    size?: string | number;
    absoluteStrokeWidth?: boolean;
  }

  export type LucideIcon = ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;

  export const AlertTriangle: LucideIcon;
  export const CheckCircle2: LucideIcon;
  export const ClipboardCopy: LucideIcon;
  export const Columns2: LucideIcon;
  export const Copy: LucideIcon;
  export const Download: LucideIcon;
  export const EyeOff: LucideIcon;
  export const FileDown: LucideIcon;
  export const FileText: LucideIcon;
  export const FolderOpen: LucideIcon;
  export const Gauge: LucideIcon;
  export const Image: LucideIcon;
  export const Loader2: LucideIcon;
  export const MonitorDown: LucideIcon;
  export const Pencil: LucideIcon;
  export const Play: LucideIcon;
  export const RotateCcw: LucideIcon;
  export const Save: LucideIcon;
  export const Scissors: LucideIcon;
  export const Settings2: LucideIcon;
  export const ShieldCheck: LucideIcon;
  export const Terminal: LucideIcon;
  export const Trash2: LucideIcon;
  export const UploadCloud: LucideIcon;
  export const Video: LucideIcon;
  export const Wand2: LucideIcon;
  export const X: LucideIcon;
}
