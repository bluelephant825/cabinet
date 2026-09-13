import type { ReactNode } from "react";

import { View } from "@/vendor/pdfcn/registry/bases/takumi/lib/pdf-primitives";
import type { Style } from "@/vendor/pdfcn/registry/types/pdf-components";

export interface KeepTogetherProps {
  children?: ReactNode;
  minPresenceAhead?: number;
  style?: Style;
}

export const KeepTogether = ({ children, style }: KeepTogetherProps) => (
  <View style={[{ breakInside: "avoid" }, style].filter(Boolean) as never}>
    {children}
  </View>
);
