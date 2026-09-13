import {
  BarChart3,
  Columns2,
  Droplet,
  File,
  GripVertical,
  Hash,
  Heading1,
  Image,
  Info,
  Layers,
  LayoutTemplate,
  Link,
  Link2,
  List,
  ListChecks,
  Minus,
  QrCode,
  Scissors,
  Square,
  Table,
  Tag,
  Text,
  type LucideIcon,
} from "lucide-react";

/** Catalog `icon` names → lucide components (palette + outline rows). */
const ICONS: Record<string, LucideIcon> = {
  "heading-1": Heading1,
  text: Text,
  list: List,
  link: Link,
  "list-checks": ListChecks,
  minus: Minus,
  "layout-template": LayoutTemplate,
  layers: Layers,
  "columns-2": Columns2,
  "link-2": Link2,
  scissors: Scissors,
  table: Table,
  "bar-chart-3": BarChart3,
  image: Image,
  "qr-code": QrCode,
  tag: Tag,
  info: Info,
  square: Square,
  hash: Hash,
  droplet: Droplet,
};

export function catalogIcon(name: string): LucideIcon {
  return ICONS[name] ?? File;
}

export { GripVertical };
